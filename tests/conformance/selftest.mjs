// 운전기(driver.mjs) 자체 시험: 시험 틀이 그 대상에서 제대로 도는지 봅니다
// (서버 띄우기 · 끄기 · 다시 띄우기 · DB 읽고 쓰기 · 쓰기 잠금 · 원문 · 구조 버전 · 설정 검사 · Redis 짝 · 정리).
// 기능 시험이 아니라서 py 서버가 P1(정적 · healthz · 설정 · 구조 버전)만 있어도 모두 통과해야 합니다.
//   SHRINE_TARGET=node|py node tests/conformance/selftest.mjs      (또는 run.mjs --selftest)
import { existsSync } from 'node:fs'
import * as D from './driver.mjs'
import { suite } from './lib/check.mjs'

const T = suite('driver')
const ok = T.ok
const PORT = D.PORTS.selftest
const H = `http://127.0.0.1:${PORT}`
const base = (dir, extra = {}) => {
  const env = { ...process.env }
  for (const k of Object.keys(env)) {
    if (/^(NODE_ENV|PUBLIC_ORIGIN|SHRINE_DOMAIN|ADMIN_|TURNSTILE_|CONTACT_EMAIL|NOTIFY_|BOARD_OPEN|FREE_CHAT|WS_MAX_PER_IP|BASE_PATH|TICKET_SECRET|RETENTION_|PENDING_)/.test(k)) delete env[k]
  }
  return { ...env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dir, TRUST_PROXY: 'true', GITHUB_CHECK: 'off', ...extra }
}
const alive = async () => {
  try { return (await fetch(`${H}/healthz`)).status === 200 } catch { return false }
}

let srv = null
try {
  /* ── 서버 · DATA_DIR ── */
  const A = await D.freshDataDir('self-a')
  ok('freshDataDir: 새 폴더', existsSync(A))
  srv = await D.startServer(base(A), { ready: '/healthz' })
  ok('startServer: 뜸 · /healthz 200', await alive())
  ok('startServer: 서버 출력을 모음', srv.out.length > 0 && typeof srv.err === 'string')

  /* ── DB ── */
  ok('hasTable: 서버가 시작하며 만든 표', (await D.hasTable(A, 'shrines')) && (await D.hasTable(A, 'blocks')) && !(await D.hasTable(A, 'no_such_table')))
  const cols = await D.tableColumns(A, 'shrines')
  ok('tableColumns', cols.includes('channel') && cols.includes('plot') && cols.includes('repo'), cols.join(','))
  const at = Date.now()
  const id = Number((await D.sqlGet(A, "INSERT INTO posts (at, topic, text, nick) VALUES (?, 'etc', ?, '물음표?') RETURNING id", [at, '셀프 시험 글 ?'])).id)
  ok('sql: 넣기 · RETURNING id', Number.isInteger(id) && id > 0, id)
  const row = await D.sqlGet(A, 'SELECT id, at, text, nick FROM posts WHERE id = ? AND at = ?', [id, at])
  ok('sql: 읽기 (큰 정수 ms · 한국어 · 따옴표 속 ?)', row?.at === at && row.text === '셀프 시험 글 ?' && row.nick === '물음표?', JSON.stringify(row))
  ok('sql: COUNT는 숫자로', (await D.sqlGet(A, 'SELECT COUNT(*) AS n FROM posts')).n === 1)
  ok('sql: 없는 행은 undefined', (await D.sqlGet(A, 'SELECT id FROM posts WHERE id = ?', [id + 999])) === undefined)
  const dump = await D.dbDump(A)
  ok('dbDump: 넣은 글이 원문에 (UTF-8 바이트를 latin1 글자로)', dump.includes(Buffer.from('셀프 시험 글').toString('latin1')))
  ok('dbIntegrityOk', await D.dbIntegrityOk(A))

  /* ── Redis 짝 (py: 이 DATA_DIR의 DB 번호에 서버가 키를 씀, node: Redis 없음) ── */
  await fetch(`${H}/`)
  const keys = await D.redisKeys(A)
  ok('Redis: 짝지은 DB 번호를 씀', D.isPy ? keys.some(k => k.startsWith('shrine:')) : keys.length === 0, keys.slice(0, 3).join(','))

  /* ── 쓰기 잠금 ── */
  const lock = await D.sqlLock(A)
  await lock.begin()
  await lock.run("INSERT INTO clicks (day, slug, n) VALUES ('2000-01-01', 'lock', 1)")
  ok('sqlLock: 잠근 동안 다른 연결의 읽기는 됨', (await D.sqlGet(A, 'SELECT COUNT(*) AS n FROM posts')).n === 1)
  // 다른 연결의 쓰기는 기다리다 실패 (node: busy_timeout 3초, py: 도우미 연결에 lock_timeout을 잠깐 걸어 봄)
  if (D.isPy) await D.sql(A, "SELECT set_config('lock_timeout', '1500', false) AS v")
  let err = ''
  try {
    await D.sql(A, "INSERT INTO clicks (day, slug, n) VALUES ('2000-01-02', 'blocked', 1)")
  } catch (e) {
    err = String(e.message)
  }
  if (D.isPy) await D.sql(A, "SELECT set_config('lock_timeout', '0', false) AS v")
  ok('sqlLock: 다른 연결의 쓰기는 막힘 · 오류 글자가 DB_LOCK_ERROR_RE', D.DB_LOCK_ERROR_RE.test(err), err.slice(0, 160))
  await lock.rollback()
  await lock.close()
  await D.sql(A, "INSERT INTO clicks (day, slug, n) VALUES ('2000-01-03', 'after', 1)")
  ok('sqlLock: 풀면 쓰기 됨 · 잠금 안에서 쓴 것은 되돌림', !(await D.sqlGet(A, "SELECT n FROM clicks WHERE slug = 'lock'")) && (await D.sqlGet(A, "SELECT n FROM clicks WHERE slug = 'after'"))?.n === 1)

  /* ── 다시 띄우기 · 끄기 · 신호 모드 ── */
  srv = await D.restartServer(srv)
  ok('restartServer: 다시 뜨고 데이터 남음', (await alive()) && (await D.sqlGet(A, 'SELECT id FROM posts WHERE id = ?', [id]))?.id === id)
  const ex = await D.stopServer(srv)
  srv = null
  ok('stopServer: 프로세스 끝 · 포트 닫힘', !!ex && !(await alive()))
  srv = await D.startServer(base(A), { ready: '/healthz', hooks: true })
  ok('hooks: 표준 입력이 열려 있음', !!srv.proc.stdin?.writable)
  D.signal(srv, 'reject')
  await D.sleep(300)
  ok('hooks: reject를 보내도 서버는 계속 응답', await alive())
  await D.stopServer(srv)
  srv = null

  /* ── 설정 검사 · 구조 버전 ── */
  const Bd = await D.freshDataDir('self-b')
  const bad = D.boot(base(Bd, { PORT: 'abc' }))
  ok('boot: 잘못된 설정 → 종료 코드 1 + 한국어 메시지', bad.code === 1 && /PORT는 1~65535/.test(bad.text), bad.text.slice(0, 200))
  srv = await D.startServer(base(Bd), { ready: '/healthz' })
  await D.stopServer(srv)
  srv = null
  await D.setFutureSchemaVersion(Bd)
  const fut = D.boot(base(Bd))
  ok('setFutureSchemaVersion: 서버가 시작을 거부', fut.code !== 0 && fut.code !== null && /더 새 서버가 만든 DB/.test(fut.text), `${fut.code} ${fut.text.slice(-200)}`)
  const c = D.cli(['schema'], { env: base(Bd) })
  ok('cli: { status, stdout, stderr } 모양', typeof c.status === 'number' && typeof c.stdout === 'string' && typeof c.stderr === 'string')
  let guarded = false
  try {
    await D.startServer(base(A, { PORT: '3300' }))
  } catch (e) {
    guarded = /3340~3359/.test(e.message)
  }
  ok('포트 3300(개발 서버)은 띄우기 전에 거부', guarded)

  /* ── 정리 ── */
  srv = await D.startServer(base(A), { ready: '/healthz' })
  srv = null
  await D.cleanup()
  const left = D.isPy ? await D.pgDropPrefix(D.PG_PREFIX) : { dbs: [], roles: [] }
  ok('cleanup: 띄운 서버를 끄고 시험 DB · 역할을 지움', !(await alive()) && left.dbs.length === 0 && left.roles.length === 0, JSON.stringify(left))
} catch (e) {
  ok('예외', false, e?.stack ?? e)
} finally {
  await D.stopServer(srv)
}
await T.done()
