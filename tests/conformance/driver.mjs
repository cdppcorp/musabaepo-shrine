// 적합성 시험 틀의 운전기: 같은 시험이 Node 서버(server/*.ts)와 Python 서버(app/) 어느 쪽에도 돌게 합니다.
//
//   SHRINE_TARGET=node (기본) | py
//
// 시험은 서버를 직접 띄우거나 DB를 직접 열지 않고 이 모듈만 씁니다. 대상마다 다른 부분은 모두 여기 있습니다.
//   · 서버 띄우기 · 끄기 · 다시 띄우기 · 신호(SIGTERM 흉내) · 설정 검사용 한 번 띄우기(boot)
//   · 운영 명령(cli) · 시험용 훅(devHook: 보관 기간 정리 · 바로 파기 · 알림 · NPC 목적지)
//   · DB 읽고 쓰기(sql), 쓰기 잠금(sqlLock), DB 원문(dbDump), 구조 버전 조작
//   · 대상마다 새 DATA_DIR (py는 새 PostgreSQL DB + 새 Redis DB 번호까지)
//
// 자세한 규약: tests/conformance/README.md
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '../..')
export const APP = join(ROOT, 'app')
export const FIXTURES = join(HERE, 'fixtures')

export const TARGET = (process.env.SHRINE_TARGET || 'node').trim().toLowerCase()
if (TARGET !== 'node' && TARGET !== 'py') throw new Error(`SHRINE_TARGET은 node 또는 py입니다 (지금: ${TARGET})`)
export const isPy = TARGET === 'py'

/** 화면(headless Edge) 시험까지 돌릴지: --browser 또는 SHRINE_BROWSER=1 */
export const BROWSER = process.argv.includes('--browser') || process.env.SHRINE_BROWSER === '1'
/** Edge(또는 Chromium) 실행 파일 */
export const EDGE = process.env.SHRINE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

/**
 * 대상이 가진 저장소 특성. 시험은 대상 이름 대신 이것으로 갈립니다 (없는 특성의 검사는 SKIP으로 셈).
 *   sqlite-wal     : DB 파일 옆 -wal 파일이 있고 종료 때 체크포인트함
 *   sqlite-legacy  : 버전 관리 전(user_version 0) SQLite DB를 올리고 pre-migrate/ 사본을 남김
 */
export const caps = new Set(isPy ? [] : ['sqlite-wal', 'sqlite-legacy'])
export const has = cap => caps.has(cap)

/** 다른 연결이 쓰기를 잠갔을 때 서버 로그에 남는 오류 종류 */
export const DB_LOCK_ERROR_RE = isPy ? /LockNotAvailable|lock[ _]timeout/i : /SQLITE_BUSY|database is locked/i

/** 묶음마다 쓰는 포트 (3340~3359만. 3300은 개발 서버라 쓰지 않음) */
export const PORTS = {
  s1: 3340, admin: 3341, registry: 3342, upload: 3343, shrine: 3344,
  s2: 3345, s2b: 3346, s2hook: 3347, chan: 3348, npc: 3349, edge: 3350, selftest: 3351,
}
const PORT_MIN = 3340
const PORT_MAX = 3359
function checkPort(port) {
  const n = Number(port)
  if (!Number.isInteger(n) || n < PORT_MIN || n > PORT_MAX) throw new Error(`시험 포트는 ${PORT_MIN}~${PORT_MAX}만 씁니다 (받은 값: ${port})`)
  return n
}

export const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 그 포트에서 누가 듣고 있는지 (127.0.0.1에 연결해 봄) */
function portInUse(port) {
  return new Promise(resolve => {
    const s = netConnect({ host: '127.0.0.1', port })
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
    s.setTimeout(1000, () => { s.destroy(); resolve(false) })
  })
}
/**
 * 포트가 빌 때까지 잠깐 기다립니다. 앞 단계 서버가 남아 있으면 새 서버가 그 서버의 응답으로 "준비됐다"고
 * 잘못 판단하므로, 띄우기 전에 확인하고 비지 않으면 멈춥니다.
 */
async function waitPortFree(port, ms = 5000) {
  const end = Date.now() + ms
  while (await portInUse(port)) {
    if (Date.now() > end) throw new Error(`포트 ${port}를 이미 누가 쓰고 있습니다 (앞 단계 서버가 남았거나 다른 프로그램)`)
    await sleep(100)
  }
}

/* ── 작업 폴더 ── */

export const RUN = process.env.SHRINE_CONF_RUN || randomBytes(3).toString('hex')
if (!/^[a-z0-9]{1,12}$/.test(RUN)) throw new Error('SHRINE_CONF_RUN은 영문 소문자 · 숫자 12자까지입니다')
export const WORK = resolve(process.env.SHRINE_CONF_WORK || join(tmpdir(), 'musabaepo-conformance'))
export const RUN_DIR = join(WORK, `${TARGET}-${RUN}`)
/** 이번 실행의 PostgreSQL DB · 역할 이름 앞부분 (runner가 남은 것을 이 이름으로 지움) */
export const PG_PREFIX = `shrine_conf_${RUN}_`
if (resolve(RUN_DIR).toLowerCase().startsWith(resolve(ROOT).toLowerCase())) throw new Error('작업 폴더를 저장소 안에 둘 수 없습니다 (SHRINE_CONF_WORK)')

/* ── 실행 파일 ── */

const NODE_FLAGS = ['--disable-warning=ExperimentalWarning']
let pythonExe = null
/** app/.venv의 Python (없으면 uv가 만듦). SHRINE_PYTHON으로 바꿀 수 있음 */
export function python() {
  if (pythonExe) return pythonExe
  if (process.env.SHRINE_PYTHON) return (pythonExe = process.env.SHRINE_PYTHON)
  const venv = process.platform === 'win32' ? join(APP, '.venv', 'Scripts', 'python.exe') : join(APP, '.venv', 'bin', 'python')
  if (existsSync(venv)) return (pythonExe = venv)
  const r = spawnSync('uv', ['run', 'python', '-c', 'import sys; print(sys.executable)'], { cwd: APP, encoding: 'utf8' })
  const exe = r.stdout?.trim().split('\n').pop()?.trim()
  if (r.status !== 0 || !exe) throw new Error(`Python을 찾지 못했습니다 (app/에서 uv sync): ${r.stderr || r.error}`)
  return (pythonExe = exe)
}

function pyEnv(env) {
  return { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }
}

/* ── 자식 프로세스 정리 ── */

const tracked = new Set()
function track(child) {
  tracked.add(child)
  child.once('exit', () => tracked.delete(child))
  return child
}
/** 시험이 직접 띄우는 다른 프로세스(Edge 등)도 끝날 때 같이 끄도록 */
export function trackProcess(child) {
  return track(child)
}
process.on('exit', () => {
  for (const c of tracked) {
    try { c.kill() } catch { /* 이미 끝남 */ }
  }
  if (pg) try { pg.proc.kill() } catch { /* 이미 끝남 */ }
})

/* ── PostgreSQL · Redis 도우미 (py 대상) ── */

const PG_ADMIN = process.env.SHRINE_TEST_PG || 'postgresql://postgres:dev@127.0.0.1:55432/postgres'
const REDIS_BASE = (() => {
  const u = new URL(process.env.SHRINE_TEST_REDIS || 'redis://127.0.0.1:56379')
  return `${u.protocol}//${u.username ? `${u.username}${u.password ? `:${u.password}` : ''}@` : ''}${u.host}`
})()
const REDIS_DBS = (() => {
  const m = /^(\d+)-(\d+)$/.exec(process.env.SHRINE_CONF_REDIS_DBS || '1-12')
  if (!m) throw new Error('SHRINE_CONF_REDIS_DBS는 1-12 모양입니다')
  const out = []
  for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push(i)
  return out
})()

let pg = null
function pgTool() {
  if (pg) return pg
  const proc = spawn(python(), [join(APP, 'tests', 'conformance_helpers', 'pgtool.py')], {
    cwd: APP, env: pyEnv({ ...process.env, SHRINE_TEST_PG: PG_ADMIN }), stdio: ['pipe', 'pipe', 'pipe'],
  })
  const state = { proc, seq: 0, pending: new Map(), buf: '', err: '' }
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', d => {
    state.buf += d
    let i
    while ((i = state.buf.indexOf('\n')) >= 0) {
      const line = state.buf.slice(0, i)
      state.buf = state.buf.slice(i + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      const p = state.pending.get(msg.id)
      if (p) { state.pending.delete(msg.id); msg.ok ? p.resolve(msg) : p.reject(new Error(`pgtool ${p.op}: ${msg.error}`)) }
    }
  })
  proc.stderr.on('data', d => { state.err += d })
  proc.on('exit', code => {
    for (const p of state.pending.values()) p.reject(new Error(`pgtool이 끝났습니다 (${code}): ${state.err.slice(-500)}`))
    state.pending.clear()
    if (pg === state) pg = null
  })
  proc.unref()
  proc.stdin.unref?.()
  proc.stdout.unref?.()
  proc.stderr.unref?.()
  return (pg = state)
}
function pgCall(op, args = {}, ms = 30_000) {
  const t = pgTool()
  const id = ++t.seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { t.pending.delete(id); reject(new Error(`pgtool ${op}: ${ms}ms 안에 답이 없음`)) }, ms)
    t.pending.set(id, {
      op,
      resolve: v => { clearTimeout(timer); resolve(v) },
      reject: e => { clearTimeout(timer); reject(e) },
    })
    t.proc.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`)
  })
}
/** runner용: 이름이 prefix로 시작하는 시험 DB · 역할을 모두 지웁니다 */
export async function pgDropPrefix(prefix) {
  return pgCall('drop_prefix', { prefix })
}
export async function pgClose() {
  if (!pg) return
  const p = pg
  pg = null
  p.proc.stdin.end()
  await new Promise(r => { if (p.proc.exitCode != null) r(); else p.proc.once('exit', r); setTimeout(r, 2000) })
}

/** SQLite식 ? 자리표시를 PostgreSQL $1 … 로 (따옴표 안은 그대로) */
function toPgPlaceholders(sql) {
  let out = ''
  let n = 0
  let quote = null
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (quote) {
      out += ch
      if (ch === quote) quote = null
    } else if (ch === "'" || ch === '"') {
      quote = ch
      out += ch
    } else if (ch === '?') {
      out += `$${++n}`
    } else {
      out += ch
    }
  }
  return out
}

/* ── DATA_DIR · 저장소 ── */

const stores = new Map() // 정규화한 DATA_DIR → { dir, db, redisIndex }
let pgRole = null
let pgPassword = null
let redisNext = 0
const keyOf = dir => {
  const p = resolve(dir)
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/**
 * 새 DATA_DIR(빈 폴더)을 만들어 경로를 돌려줍니다. py 대상이면 이 폴더에 짝지은 새 PostgreSQL DB와
 * 비운 Redis DB 번호도 만듭니다. 서버 · cli · sql에 DATA_DIR로 이 경로를 넘기면 짝이 따라갑니다.
 */
export async function freshDataDir(name) {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) throw new Error(`폴더 이름이 이상합니다: ${name}`)
  const dir = join(RUN_DIR, name)
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  mkdirSync(dir, { recursive: true })
  const store = { dir, db: null, redisIndex: null }
  if (isPy) {
    if (!pgRole) {
      pgRole = `${PG_PREFIX}r${process.pid}` // 묶음(프로세스)마다 따로: 남은 역할의 비밀번호와 엇갈리지 않게
      pgPassword = randomBytes(24).toString('hex')
    }
    store.db = `${PG_PREFIX}${name.toLowerCase().replace(/-/g, '_')}`.slice(0, 63)
    await pgCall('create', { db: store.db, role: pgRole, password: pgPassword })
    store.redisIndex = REDIS_DBS[redisNext++ % REDIS_DBS.length]
    await pgCall('redis_flush', { url: `${REDIS_BASE}/${store.redisIndex}` })
  }
  stores.set(keyOf(dir), store)
  return dir
}

function storeOf(dir) {
  const s = dir ? stores.get(keyOf(dir)) : null
  if (!s) throw new Error(`DATA_DIR ${dir}은 driver.freshDataDir()로 만든 폴더가 아닙니다`)
  return s
}

function databaseUrl(store) {
  const a = new URL(PG_ADMIN)
  return `postgresql://${pgRole}:${pgPassword}@${a.hostname}:${a.port || 5432}/${store.db}`
}

/** 서버 · 운영 명령에 넘길 환경 변수: py면 DATA_DIR에 짝지은 DATABASE_URL · REDIS_URL을 붙입니다 */
export function targetEnv(env) {
  const out = { ...env }
  delete out.SHRINE_TEST_STDIN
  if (!isPy) return out
  const s = storeOf(env.DATA_DIR)
  out.DATABASE_URL = databaseUrl(s)
  out.REDIS_URL = `${REDIS_BASE}/${s.redisIndex}`
  return pyEnv(out)
}

/* ── 서버 ── */

function serverCommand({ hooks = false } = {}) {
  if (isPy) return { cmd: python(), args: ['-m', 'shrine'], cwd: APP }
  return { cmd: process.execPath, args: [...NODE_FLAGS, hooks ? join(HERE, 'lib', 'node-wrap.mjs') : 'server/main.ts'], cwd: ROOT }
}

const READY_MS = Number(process.env.SHRINE_READY_MS || (isPy ? 45_000 : 15_000))

/**
 * 서버를 띄우고 준비될 때까지 기다립니다.
 *   env   : 서버 환경 변수 (PORT · DATA_DIR 필수)
 *   ready : 준비 확인 주소 (BASE_PATH 포함, 기본 /api/world). HTTP 응답이 오면(상태와 상관없이) 준비 끝
 *           — 아직 그 주소를 옮기지 않은 py 서버에서도 시험이 계속 돌아 실제 검사가 실패로 드러나게
 *   hooks : true면 표준 입력 명령(term · crash · reject)을 받는 시험용 모드로 띄움 (signal()에 필요)
 * 돌려주는 값: { proc, out(표준 출력+오류), err(표준 오류만), exited: Promise<{code, signal, at}>, port, ... }
 */
export async function startServer(env, { ready = '/api/world', hooks = false, timeoutMs = READY_MS } = {}) {
  const port = checkPort(env.PORT)
  await waitPortFree(port)
  const { cmd, args, cwd } = serverCommand({ hooks })
  const e = targetEnv(env)
  if (hooks && isPy) e.SHRINE_TEST_STDIN = '1'
  const proc = track(spawn(cmd, args, { cwd, env: e, stdio: [hooks ? 'pipe' : 'ignore', 'pipe', 'pipe'] }))
  const srv = { proc, env, opts: { ready, hooks, timeoutMs }, port, out: '', err: '' }
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stdout.on('data', d => { srv.out += d })
  proc.stderr.on('data', d => { srv.out += d; srv.err += d })
  srv.exited = new Promise(r => proc.on('exit', (code, signal) => r({ code, signal, at: Date.now() })))
  let gone = null
  srv.exited.then(x => { gone = x })
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (gone) throw new Error(`서버가 뜨지 않고 끝났습니다 (code ${gone.code}):\n${srv.out.slice(-3000)}`)
    try {
      const r = await fetch(`http://127.0.0.1:${port}${ready}`, { signal: AbortSignal.timeout(2000) })
      await r.arrayBuffer().catch(() => {})
      return srv
    } catch { /* 아직 */ }
    await sleep(100)
  }
  proc.kill()
  throw new Error(`서버가 ${timeoutMs}ms 안에 뜨지 않음 (${ready}):\n${srv.out.slice(-3000)}`)
}

/** 서버를 끄고(Windows: 강제 종료) 끝날 때까지 기다립니다. 이미 끝났으면 그대로 */
export async function stopServer(srv) {
  if (!srv) return null
  if (srv.proc.exitCode === null && srv.proc.signalCode === null) srv.proc.kill()
  return srv.exited
}

/** 같은 설정으로 끄고 다시 띄웁니다 (env를 주면 그 값을 덮어씀) */
export async function restartServer(srv, envPatch = {}) {
  await stopServer(srv)
  return startServer({ ...srv.env, ...envPatch }, srv.opts)
}

/**
 * hooks로 띄운 서버에 신호를 흉내 냅니다 (Windows는 SIGTERM을 보낼 수 없어서 표준 입력으로).
 *   'SIGTERM' : 정상 종료와 같은 길 (접속자 1012 · 로그 '(SIGTERM)' · 종료 코드 0)
 *   'crash'   : 잡히지 않은 예외 (정리 후 종료 코드 1)
 *   'reject'  : 처리되지 않은 비동기 거부 (로그만 남기고 계속)
 */
export function signal(srv, sig) {
  if (!srv?.opts?.hooks) throw new Error('signal()은 startServer(env, { hooks: true })로 띄운 서버에만 씁니다')
  const cmd = { SIGTERM: 'term', term: 'term', crash: 'crash', reject: 'reject' }[sig]
  if (!cmd) throw new Error(`모르는 신호: ${sig}`)
  srv.proc.stdin.write(`${cmd}\n`)
}

/**
 * 설정 검사 시험용: 서버를 한 번 띄우고 ms 안에 끝나지 않으면 끕니다.
 * py는 Python 시작 시간을 감안해 기다리는 시간을 늘립니다 (시작 성공 여부만 보는 시험이라 결과에는 영향 없음).
 */
export function boot(env, ms = 2500) {
  const { cmd, args, cwd } = serverCommand()
  const r = spawnSync(cmd, args, { cwd, env: targetEnv(env), encoding: 'utf8', timeout: isPy ? ms * 4 : ms })
  return { code: r.status, text: `${r.stdout}${r.stderr}`, timedOut: r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM' }
}

/* ── 운영 명령 · 시험용 훅 ── */

function run(cmd, args, { cwd, env, input, timeout = 120_000 }) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', input, timeout, maxBuffer: 64 * 1024 * 1024 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? `\n[driver] ${r.error.message}` : ''), signal: r.signal }
}

/**
 * 운영 명령. node: node server/cli.ts <args>, py: python -m shrine.cli <args> (app/에서)
 * env는 서버와 같은 값(특히 DATA_DIR · TICKET_SECRET). input은 표준 입력(글자 또는 Buffer).
 * 돌려주는 값은 spawnSync와 같은 모양 { status, stdout, stderr }
 */
export function cli(args, { env = process.env, input } = {}) {
  if (isPy) return run(python(), ['-m', 'shrine.cli', ...args.map(String)], { cwd: APP, env: targetEnv(env), input })
  return run(process.execPath, [...NODE_FLAGS, 'server/cli.ts', ...args.map(String)], { cwd: ROOT, env: targetEnv(env), input })
}

/**
 * 시험용 훅 (서버 내부 함수를 한 번 부름). node: tests/conformance/lib/node-hooks.mjs, py: python -m shrine.cli dev <훅>
 *   retention              보관 기간 정리 한 번 → 마지막 줄 JSON {purged, expired, expiredChanges, posts, reports, images}
 *   erase-now <id>         접수 바로 파기 → JSON {ok, images, message}
 *   notify <event> <json>  알림(웹훅) 한 번 보내고 끝남 → 'done'
 *   npc-goals <ch> <n>     NPC 목적지 n번 뽑기 (자리는 모두 찬 것으로) → JSON [{kind, at:{x,y}}]
 */
export function devHook(name, args = [], { env = process.env } = {}) {
  if (isPy) return run(python(), ['-m', 'shrine.cli', 'dev', name, ...args.map(String)], { cwd: APP, env: targetEnv(env) })
  return run(process.execPath, [...NODE_FLAGS, join(HERE, 'lib', 'node-hooks.mjs'), name, ...args.map(String)], { cwd: ROOT, env: targetEnv(env) })
}
const lastJson = r => {
  try { return JSON.parse(r.stdout.trim().split('\n').pop()) } catch { return null }
}
export function runRetention(env) {
  const r = devHook('retention', [], { env })
  return lastJson(r) ?? { error: r.stderr || r.stdout }
}
export function eraseNow(env, id) {
  const r = devHook('erase-now', [id], { env })
  return { ...r, result: lastJson(r) }
}
export function notify(env, event, fields) {
  return devHook('notify', [event, JSON.stringify(fields)], { env })
}
export function npcGoals(env, channel, n) {
  const r = devHook('npc-goals', [channel, n], { env })
  const j = lastJson(r)
  if (!Array.isArray(j)) throw new Error(`npc-goals 실패: ${r.stderr || r.stdout}`.slice(0, 600))
  return j
}

/* ── DB ── */

let sqliteMod = null
async function sqlite() {
  sqliteMod ??= await import('node:sqlite')
  return sqliteMod
}
const dbFile = dir => join(dir, 'shrine.db')

/** 질의 하나 (SQLite식 ? 자리표시). 행 배열을 돌려줌. 넣기는 RETURNING으로 번호를 받습니다 */
export async function sql(dir, query, params = []) {
  if (isPy) return (await pgCall('query', { db: storeOf(dir).db, sql: toPgPlaceholders(query), params })).rows
  const { DatabaseSync } = await sqlite()
  const db = new DatabaseSync(dbFile(dir))
  try {
    db.exec('PRAGMA busy_timeout = 3000')
    return db.prepare(query).all(...params)
  } finally {
    db.close()
  }
}
export const sqlGet = async (dir, query, params = []) => (await sql(dir, query, params))[0]

/**
 * 다른 연결이 DB 쓰기를 잠근 상태를 만듭니다. 읽기는 되고 서버의 쓰기는 기다리다 실패해야 합니다.
 *   node: BEGIN IMMEDIATE (SQLite RESERVED 잠금) · py: BEGIN + 모든 표 LOCK … IN EXCLUSIVE MODE
 */
export async function sqlLock(dir) {
  if (isPy) {
    const db = storeOf(dir).db
    const key = `lock-${randomBytes(4).toString('hex')}`
    let held = false
    return {
      async begin() { await pgCall('lock', { db, key }); held = true },
      async run(query, params = []) { return (await pgCall('lock_run', { key, sql: toPgPlaceholders(query), params })).rows },
      async rollback() { await pgCall('unlock', { key }); held = false },
      async close() { if (held) await pgCall('unlock', { key }); held = false },
    }
  }
  const { DatabaseSync } = await sqlite()
  const db = new DatabaseSync(dbFile(dir))
  db.exec('PRAGMA busy_timeout = 5000')
  return {
    async begin() { db.exec('BEGIN IMMEDIATE') },
    async run(query, params = []) { return db.prepare(query).all(...params) },
    async rollback() { db.exec('ROLLBACK') },
    async close() { db.close() },
  }
}

/** DB에 저장된 모든 것 (바이트를 latin1 글자로). node: shrine.db* 파일, py: 모든 표의 모든 행 */
export async function dbDump(dir) {
  if (isPy) return Buffer.from((await pgCall('dump', { db: storeOf(dir).db })).text, 'utf8').toString('latin1')
  return readdirSync(dir).filter(f => f.startsWith('shrine.db')).map(f => readFileSync(join(dir, f)).toString('latin1')).join('')
}

/** DB가 멀쩡한지 (node: PRAGMA integrity_check, py: 접속해 읽기) */
export async function dbIntegrityOk(dir) {
  if (isPy) return (await sql(dir, 'SELECT 1 AS ok'))[0]?.ok === 1
  const { DatabaseSync } = await sqlite()
  const db = new DatabaseSync(dbFile(dir), { readOnly: true })
  try { return db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok' } finally { db.close() }
}

export async function tableColumns(dir, table) {
  if (isPy) return (await pgCall('columns', { db: storeOf(dir).db, table })).columns
  return (await sql(dir, `PRAGMA table_info(${table.replace(/[^a-z_]/g, '')})`)).map(c => c.name)
}
export async function hasTable(dir, name) {
  if (isPy) return (await pgCall('tables', { db: storeOf(dir).db })).tables.includes(name)
  return !!(await sql(dir, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]))[0]
}

/**
 * 구조 버전 시험용 "옛 DB". node: 버전 관리 전(user_version 0) SQLite 모양 + 옛 데이터(clicks old=7).
 * py: 빈 DB 그대로 (Alembic 이전 PostgreSQL DB는 없음 — 결정 D4: 빈 DB로 시작). 옛 데이터 검사는 sqlite-legacy 특성.
 */
export async function seedLegacySchema(dir) {
  if (isPy) return
  const { DatabaseSync } = await sqlite()
  const old = new DatabaseSync(dbFile(dir))
  old.exec(`CREATE TABLE shrines (slug TEXT PRIMARY KEY, name TEXT NOT NULL, tagline TEXT NOT NULL, category TEXT NOT NULL, domain TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL, operator TEXT NOT NULL, keeper INTEGER NOT NULL DEFAULT 0, paid INTEGER NOT NULL DEFAULT 0, verified_domain TEXT NOT NULL,
    verified_business TEXT, joined_at TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('live', 'check')), prayer TEXT NOT NULL, charm TEXT,
    deco TEXT NOT NULL DEFAULT '[]', screens TEXT NOT NULL DEFAULT '[]', captured_at TEXT NOT NULL, plot INTEGER NOT NULL UNIQUE);
    CREATE TABLE clicks (day TEXT NOT NULL, slug TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, slug));
    INSERT INTO clicks VALUES ('2026-01-01', 'old', 7);`)
  old.close()
}
/** 구조를 바꾸기 전에 남긴 사본 (DATA_DIR/pre-migrate/) */
export function preMigrateSnapshots(dir) {
  const p = join(dir, 'pre-migrate')
  return existsSync(p) ? readdirSync(p) : []
}
/** 이 서버보다 새 서버가 만든 DB처럼 구조 버전을 올립니다 (node: user_version 99, py: 모르는 Alembic 리비전) */
export async function setFutureSchemaVersion(dir) {
  if (isPy) {
    await pgCall('script', {
      db: storeOf(dir).db,
      sql: "CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(32) NOT NULL PRIMARY KEY); DELETE FROM alembic_version; INSERT INTO alembic_version VALUES ('9999_future');",
    })
    return
  }
  const { DatabaseSync } = await sqlite()
  const db = new DatabaseSync(dbFile(dir))
  db.exec('PRAGMA user_version = 99')
  db.close()
}
/** SQLite -wal 파일 크기 (없으면 0). sqlite-wal 특성이 있을 때만 의미가 있음 */
export function walSize(dir) {
  const p = `${dbFile(dir)}-wal`
  return existsSync(p) ? statSync(p).size : 0
}
export function walExists(dir) {
  return existsSync(`${dbFile(dir)}-wal`)
}
/** py: 이 DATA_DIR에 짝지은 Redis DB의 키 (driver 자체 시험용). node는 Redis를 쓰지 않아 빈 배열 */
export async function redisKeys(dir, match = 'shrine:*') {
  if (!isPy) return []
  return (await pgCall('redis_keys', { url: `${REDIS_BASE}/${storeOf(dir).redisIndex}`, match })).keys
}
/** 올린 이미지 파일 위치 (두 서버 모두 DATA_DIR/uploads/<id>) */
export const uploadFile = (dir, id) => join(dir, 'uploads', String(id))

/* ── 정리 ── */

/** 띄운 서버를 모두 끄고, py면 이번 시험이 만든 DB · 역할을 지우고 Redis를 비웁니다 */
export async function cleanup() {
  for (const c of [...tracked]) {
    try { c.kill() } catch { /* 이미 끝남 */ }
  }
  await sleep(tracked.size ? 300 : 0)
  if (isPy && stores.size) {
    const dbs = [...stores.values()].map(s => s.db).filter(Boolean)
    const indexes = [...new Set([...stores.values()].map(s => s.redisIndex).filter(x => x != null))]
    try {
      if (process.env.SHRINE_CONF_KEEP !== '1') await pgCall('drop', { dbs, role: pgRole })
      for (const i of indexes) await pgCall('redis_flush', { url: `${REDIS_BASE}/${i}` })
    } catch (e) {
      console.error(`[driver] 정리 실패: ${e.message}`)
    }
    stores.clear()
  }
  await pgClose()
}

export function describe() {
  return `target=${TARGET} run=${RUN} work=${RUN_DIR}${isPy ? ` python=${python()} pg=${new URL(PG_ADMIN).host} redis=${REDIS_BASE.replace(/\/\/.*@/, '//')}` : ''}`
}
