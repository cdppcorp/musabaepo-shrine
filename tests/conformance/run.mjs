// 적합성 시험 실행기: 묶음을 하나씩(포트가 고정이라 동시에는 안 됨) 돌리고 묶음마다 PASS/FAIL을 셉니다.
//
//   node tests/conformance/run.mjs [--target node|py] [--browser] [--only s1,admin] [--verbose] [--clean]
//   npm run test:conformance -- --target py
//
//   --target   시험 대상 (기본: SHRINE_TARGET 또는 node)
//   --browser  화면 시험(headless Edge)까지: admin 화면 사진 10개 + edge 묶음 43개
//   --only     이 묶음만 (쉼표로)
//   --verbose  PASS 줄까지 모두 보여 줌 (기본: FAIL · SKIP · 예외만, 전체는 작업 폴더의 <묶음>.log)
//   --selftest 운전기 자체 시험(driver 묶음, 24개)을 먼저 돌림 — 시험 틀이 그 대상에서 제대로 도는지
//   --clean    시작 전에 예전 실행이 남긴 시험 DB · 역할(shrine_conf_*)을 모두 지움 (py)
//
// "기준"은 Node 서버(커밋 247a161)에서 모두 통과한 검사 수입니다. 묶음이 중간에 끝나면 못 간 검사 수를 따로 셉니다.
// 대상이 갖지 않은 저장소 특성(driver.caps) 때문에 셀 수 없는 검사는 SKIP으로 셉니다 (py: SQLite WAL · 옛 SQLite DB).
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const opt = name => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const target = (opt('--target') || process.env.SHRINE_TARGET || 'node').toLowerCase()
if (target !== 'node' && target !== 'py') {
  console.error('--target은 node 또는 py입니다')
  process.exit(2)
}
const browser = flag('--browser')
const verbose = flag('--verbose')
const selftest = flag('--selftest')
const only = opt('--only')?.split(',').map(s => s.trim()).filter(Boolean)
const run = randomBytes(3).toString('hex')
process.env.SHRINE_TARGET = target
process.env.SHRINE_CONF_RUN = run
const D = await import('./driver.mjs')

const P = D.PORTS
const SUITES = [
  { name: 'driver', file: 'selftest.mjs', expect: 24, ports: [P.selftest], selftestOnly: true },
  { name: 's1', file: 's1.test.mjs', expect: 107, ports: [P.s1] },
  { name: 'admin', file: 'admin.test.mjs', expect: 130, expectBrowser: 140, ports: [P.admin] },
  { name: 'registry', file: 'registry.test.mjs', expect: 65, ports: [P.registry] },
  { name: 'upload', file: 'upload.test.mjs', expect: 29, ports: [P.upload] },
  { name: 'shrine', file: 'shrine.test.mjs', expect: 90, ports: [P.shrine] },
  { name: 's2', file: 's2.test.mjs', expect: 94, ports: [P.s2, P.s2b, P.s2hook] },
  { name: 'chan', file: 'chan.test.mjs', expect: 53, ports: [P.chan] },
  { name: 'npc', file: 'npc.test.mjs', expect: 5, ports: [P.npc] },
  { name: 'edge', file: 'edge.test.mjs', expect: 43, ports: [P.edge], browserOnly: true },
]
const SUITE_TIMEOUT_MS = Number(process.env.SHRINE_SUITE_TIMEOUT_MS || 20 * 60_000)

/* ── 포트 ── */

/** 그 포트에서 듣고 있는 프로세스 번호들 (Windows: netstat, 그 밖: lsof) */
function listeners(port) {
  if (process.platform === 'win32') {
    const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
    const pids = new Set()
    for (const line of (r.stdout || '').split('\n')) {
      const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line)
      if (m && Number(m[1]) === port && m[2] !== '0') pids.add(Number(m[2]))
    }
    return [...pids]
  }
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
  return (r.stdout || '').split('\n').map(Number).filter(Boolean)
}
function killPid(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
  else try { process.kill(pid, 'SIGKILL') } catch { /* 이미 끝남 */ }
}

/* ── 묶음 하나 ── */

function runSuite(s, logDir) {
  return new Promise(resolve => {
    const args = ['--disable-warning=ExperimentalWarning', join(HERE, s.file), ...(browser ? ['--browser'] : [])]
    const child = spawn(process.execPath, args, { cwd: D.ROOT, env: { ...process.env, SHRINE_TARGET: target, SHRINE_CONF_RUN: run }, stdio: ['ignore', 'pipe', 'pipe'] })
    const log = createWriteStream(join(logDir, `${s.name}.log`))
    let summary = null
    let buf = ''
    let errTail = []
    const t0 = Date.now()
    const onLine = (line, isErr) => {
      log.write(`${line}\n`)
      const m = /^##conformance (\{.*\})$/.exec(line)
      if (m) { try { summary = JSON.parse(m[1]) } catch { /* 무시 */ } return }
      if (isErr) { errTail.push(line); errTail = errTail.slice(-25) }
      if (verbose || /^(FAIL|SKIP)  /.test(line)) console.log(`  ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`)
    }
    const split = isErr => d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i).replace(/\r$/, ''), isErr)
        buf = buf.slice(i + 1)
      }
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', split(false))
    child.stderr.on('data', split(true))
    const timer = setTimeout(() => { errTail.push(`[run] ${SUITE_TIMEOUT_MS}ms가 지나 끕니다`); child.kill() }, SUITE_TIMEOUT_MS)
    child.on('exit', code => {
      clearTimeout(timer)
      if (buf) onLine(buf, false)
      log.end()
      resolve({ code, summary, errTail, ms: Date.now() - t0 })
    })
  })
}

/* ── 실행 ── */

const logDir = D.RUN_DIR
mkdirSync(logDir, { recursive: true })
console.log(`적합성 시험: ${D.describe()}${browser ? ' · 화면 시험 포함' : ''}`)
if (target === 'py' && flag('--clean')) {
  const r = await D.pgDropPrefix('shrine_conf_')
  console.log(`예전 시험 DB ${r.dbs.length}개 · 역할 ${r.roles.length}개 지움`)
}

const rows = []
for (const s of SUITES) {
  if (only && !only.includes(s.name)) continue
  if (s.browserOnly && !browser) continue
  if (s.selftestOnly && !selftest) continue
  const expect = browser && s.expectBrowser ? s.expectBrowser : s.expect
  console.log(`\n▶ ${s.name} (기준 ${expect})`)
  const busy = s.ports.flatMap(p => listeners(p).map(pid => `${p}(pid ${pid})`))
  if (busy.length) {
    console.log(`  포트를 이미 누가 쓰고 있어 건너뜁니다: ${busy.join(', ')}`)
    rows.push({ name: s.name, expect, pass: 0, fail: 0, skip: 0, missing: expect, ms: 0, status: '포트 사용 중' })
    continue
  }
  const r = await runSuite(s, logDir)
  // 묶음이 남긴 서버가 있으면 끔 (시작 전에 비어 있던 포트라 이 묶음이 띄운 것)
  for (const p of s.ports) for (const pid of listeners(p)) { killPid(pid); console.log(`  남은 프로세스 끔: 포트 ${p} pid ${pid}`) }
  if (target === 'py') {
    try { await D.pgDropPrefix(D.PG_PREFIX) } catch (e) { console.log(`  DB 정리 실패: ${e.message}`) }
  }
  const sum = r.summary ?? { pass: 0, fail: 0, skip: 0, crashed: true }
  const counted = sum.pass + sum.fail + sum.skip
  const missing = Math.max(0, expect - counted)
  const crashed = sum.crashed || !r.summary
  if (crashed && r.errTail.length) console.log(r.errTail.map(l => `  │ ${l}`).join('\n'))
  const ok = !crashed && sum.fail === 0 && missing === 0 && counted === expect
  const status = ok ? (sum.skip ? 'OK (SKIP 있음)' : 'OK') : crashed ? '중간에 끝남' : counted !== expect && !missing ? `검사 수 다름 (${counted})` : 'FAIL'
  rows.push({ name: s.name, expect, pass: sum.pass, fail: sum.fail, skip: sum.skip, missing, ms: r.ms, status })
  console.log(`  → ${sum.pass} PASS / ${sum.fail} FAIL / ${sum.skip} SKIP${missing ? ` / 못 감 ${missing}` : ''} (${Math.round(r.ms / 1000)}초) ${status}`)
}
await D.pgClose()

/* ── 표 ── */

/** 화면 너비로 맞춤 (한글은 두 칸) */
const width = t => [...t].reduce((w, ch) => w + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60]/.test(ch) ? 2 : 1), 0)
const pad = (v, n, right = false) => {
  const t = String(v)
  const fill = ' '.repeat(Math.max(0, n - width(t)))
  return right ? fill + t : t + fill
}
const total = rows.reduce((a, r) => ({ expect: a.expect + r.expect, pass: a.pass + r.pass, fail: a.fail + r.fail, skip: a.skip + r.skip, missing: a.missing + r.missing, ms: a.ms + r.ms }), { expect: 0, pass: 0, fail: 0, skip: 0, missing: 0, ms: 0 })
console.log(`\n대상 ${target} · 로그 ${logDir}`)
console.log(`${pad('묶음', 10)}${pad('기준', 6, true)}${pad('PASS', 7, true)}${pad('FAIL', 7, true)}${pad('SKIP', 7, true)}${pad('못 감', 7, true)}${pad('시간', 7, true)}  결과`)
for (const r of rows) console.log(`${pad(r.name, 10)}${pad(r.expect, 6, true)}${pad(r.pass, 7, true)}${pad(r.fail, 7, true)}${pad(r.skip, 7, true)}${pad(r.missing, 7, true)}${pad(`${Math.round(r.ms / 1000)}s`, 7, true)}  ${r.status}`)
console.log(`${pad('합계', 10)}${pad(total.expect, 6, true)}${pad(total.pass, 7, true)}${pad(total.fail, 7, true)}${pad(total.skip, 7, true)}${pad(total.missing, 7, true)}${pad(`${Math.round(total.ms / 1000)}s`, 7, true)}`)
const allOk = rows.length > 0 && rows.every(r => r.status.startsWith('OK'))
console.log(allOk ? '\n모두 통과' : '\n통과하지 못한 묶음이 있습니다')
process.exit(allOk ? 0 : 1)
