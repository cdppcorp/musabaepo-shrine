// S1 시험: 실시간 안정성 · 정상 종료 · 차단/강퇴/신고 · 설정 검사 · DB 마이그레이션.
// 자체 서버를 127.0.0.1:3340에 새 DATA_DIR로 띄웁니다. 끝나면 모두 끕니다.
//   SHRINE_TARGET=node|py node tests/conformance/s1.test.mjs
import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import * as D from './driver.mjs'
import { suite } from './lib/check.mjs'

const PORT = D.PORTS.s1
const HP = `127.0.0.1:${PORT}`
const B = `http://${HP}`
const ORIGIN = B
const SECRET = randomBytes(32).toString('hex')
const PW = 'Zq7-moder-pw-9xK2vLp-Hf3'
const LOOK = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
const sleep = ms => new Promise(r => setTimeout(r, ms))

const T = suite('s1')
const ok = T.ok

/* ── 서버 ── */

let srv = null

function baseEnv(extra = {}) {
  const env = { ...process.env }
  for (const k of Object.keys(env)) {
    if (/^(NODE_ENV|PUBLIC_ORIGIN|SHRINE_DOMAIN|ADMIN_|TURNSTILE_|CONTACT_EMAIL|NOTIFY_|BOARD_OPEN|FREE_CHAT|WS_MAX_PER_IP|BASE_PATH|TICKET_SECRET)/.test(k)) delete env[k]
  }
  return { ...env, PORT: String(PORT), HOST: '127.0.0.1', TRUST_PROXY: 'true', GITHUB_CHECK: 'off', TICKET_SECRET: SECRET, ...extra }
}

// wrapper: 표준 입력으로 신호 · 예외를 흉내 내는 시험용 모드 (D.signal)
async function start(data, extra = {}, { wrapper = false } = {}) {
  srv = await D.startServer(baseEnv({ DATA_DIR: data, ...extra }), { hooks: wrapper })
  return srv
}

async function stop() {
  if (!srv) return
  await D.stopServer(srv)
  srv = null
}

async function alive() {
  try {
    return (await fetch(`${B}/api/world`)).ok
  } catch {
    return false
  }
}

/* ── 손님 ── */

async function enter(ip) {
  const res = await fetch(`${B}/api/enter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'X-Forwarded-For': ip },
    body: JSON.stringify({ look: LOOK }),
  })
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0]
  return { status: res.status, body: await res.json().catch(() => ({})), cookie, ip }
}

function connect(t, ip = t.ip) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://${HP}/ws`, { headers: { Cookie: t.cookie, 'X-Forwarded-For': ip }, origin: ORIGIN })
    const c = { ws, inbox: [], status: 0, code: null }
    c.closed = new Promise(r => ws.on('close', code => { c.code = code; r(code) }))
    ws.on('message', d => c.inbox.push(JSON.parse(d.toString())))
    ws.on('unexpected-response', (_q, res) => { c.status = res.statusCode; resolve(c) })
    ws.on('open', () => { c.status = 101; resolve(c) })
    ws.on('error', () => {})
  })
}

async function waitFor(c, pred, ms = 2000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const i = c.inbox.findIndex(pred)
    if (i >= 0) return c.inbox.splice(i, 1)[0]
    await sleep(20)
  }
  return null
}

const closedWithin = (c, ms = 3000) => Promise.race([c.closed, sleep(ms).then(() => 'timeout')])
const send = (c, m) => c.ws.send(typeof m === 'string' ? m : JSON.stringify(m))

/* ── 운영자 ── */

let adminCookie = ''
async function adminLogin() {
  const res = await fetch(`${B}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'X-Forwarded-For': '192.0.2.250' }, body: JSON.stringify({ password: PW }),
  })
  adminCookie = (res.headers.get('set-cookie') || '').split(';')[0]
  return res.status
}
async function aget(path) {
  const res = await fetch(`${B}/api/admin/${path}`, { headers: { Cookie: adminCookie, 'X-Forwarded-For': '192.0.2.250' } })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}
async function apost(path, body) {
  const res = await fetch(`${B}/api/admin/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: adminCookie, 'X-Forwarded-For': '192.0.2.250' }, body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

const cli = (data, ...args) => D.cli(args, { env: baseEnv({ DATA_DIR: data }) })

/** 구간 하나 (원래는 전체가 try 하나): 예외가 나도 다음 구간은 돌게 하고 서버는 끄고 넘어갑니다. 검사 내용은 그대로 */
async function section(fn) {
  try {
    await fn()
  } catch (e) {
    ok('예외', false, e?.stack ?? e)
  } finally {
    await stop()
  }
}
let x = null // 운영 명령 결과 (8 · 14)
let D3 = null // 11 · 12의 DATA_DIR

await section(async () => {
  /* ═══ 1. 잘못된 메시지 · 게시판 닫힘 · 차단 · 강퇴 · 신고 ═══ */
  const D1 = await D.freshDataDir('s1-main')
  await start(D1, { ADMIN_PASSWORD: PW })
  console.log('── 1. 잘못된 메시지')
  const A = await enter('198.51.100.20')
  const Bt = await enter('198.51.100.21')
  const C = await enter('198.51.100.20')
  ok('입장 표 3장', A.status === 200 && Bt.status === 200 && C.status === 200, `${A.status} ${Bt.status} ${C.status}`)
  const a = await connect(A)
  const b = await connect(Bt)
  const c = await connect(C)
  const helloA = await waitFor(a, m => m.t === 'hello')
  const helloB = await waitFor(b, m => m.t === 'hello')
  const helloC = await waitFor(c, m => m.t === 'hello')
  ok('세 명 접속 (같은 IP 두 연결 포함)', !!helloA && !!helloB && !!helloC)
  ok('hello에 chat.free', helloA?.chat?.free === true)
  for (const m of ['not json', '[]', 'null', '42', '"str"', '{"t":{}}', '{"t":"mv","x":"a","y":{}}', '{"t":"light","s":{"x":1},"p":[]}',
    '{"t":"reportUser","id":{}}', '{"t":"sit","s":"x"}', '{"t":"chat","s":{"toString":1}}', '{"t":"emo","k":["smoke"]}', '{"t":"say","k":1e309}',
    '{"t":"post","a":"etc","s":"x"}', '{"t":"chans","x":"__proto__"}', '{"__proto__":{"t":"mv"}}']) send(a, m)
  const chans = await waitFor(a, m => m.t === 'chans')
  ok('잘못된 메시지 16종 뒤에도 연결 · 응답 그대로', !!chans && a.ws.readyState === 1)
  ok('서버 살아 있음', await alive())

  console.log('── 2. 게시판 (BOARD_OPEN 기본 꺼짐)')
  send(b, { t: 'post', a: 'etc', s: '안녕하세요' })
  ok('글쓰기 → postNo closed', (await waitFor(b, m => m.t === 'postNo'))?.reason === 'closed')
  send(b, { t: 'report', id: 1 })
  ok('글 신고 → reportNo closed', (await waitFor(b, m => m.t === 'reportNo'))?.reason === 'closed')

  console.log('── 3. 사람 신고')
  // 1번의 잘못된 reportUser가 남긴 답(none)은 버립니다
  a.inbox.length = 0
  send(b, { t: 'chat', s: '첫 번째 말' })
  await waitFor(a, m => m.t === 'chat' && m.id === helloB.id)
  await sleep(1600)
  send(b, { t: 'chat', s: '두 번째 말' })
  await waitFor(a, m => m.t === 'chat' && m.id === helloB.id)
  send(a, { t: 'reportUser', id: helloA.id, r: 'abuse' })
  ok('자기 신고 → self', (await waitFor(a, m => m.t === 'reportUserNo'))?.reason === 'self')
  send(a, { t: 'reportUser', id: 'npc-nobody', r: 'abuse' })
  ok('없는 사람 → none', (await waitFor(a, m => m.t === 'reportUserNo'))?.reason === 'none')
  send(a, { t: 'reportUser', id: helloB.id, r: 'abuse' })
  ok('신고 → reportUserOk', (await waitFor(a, m => m.t === 'reportUserOk'))?.id === helloB.id)
  send(a, { t: 'reportUser', id: helloB.id, r: 'spam' })
  ok('바로 또 신고 → slow', (await waitFor(a, m => m.t === 'reportUserNo'))?.reason === 'slow')
  send(c, { t: 'reportUser', id: helloB.id, r: 'spam' })
  ok('같은 IP 다른 사람 신고 → again(같은 IP는 한 명으로 셈)', (await waitFor(c, m => m.t === 'reportUserOk'))?.again === true)

  console.log('── 4. 운영자: 접속자 · 신고 · 강퇴')
  ok('운영자 로그인', (await adminLogin()) === 200)
  let r = await aget('players')
  const people = (r.data.channels ?? []).flatMap(ch => ch.players)
  ok('접속자 목록 3명', people.length === 3, JSON.stringify(r.data.channels?.map(ch => ch.players.length)))
  ok('같은 IP 수 표시 (A=2, B=1)', people.find(x => x.id === helloA.id)?.sameIp === 2 && people.find(x => x.id === helloB.id)?.sameIp === 1)
  ok('신고 수 표시 (B=1)', people.find(x => x.id === helloB.id)?.reports === 1)
  ok('접속자 목록에 IP · sid 없음', !/198\.51\.100|"sid"|ipKey|banKey/.test(JSON.stringify(r.data)))
  r = await aget('reports')
  const rep = r.data.reports?.[0]
  ok('신고 목록: 대상 · 사유 · 최근 말풍선', rep?.nick === helloB.me.nick && rep.lines.length === 2 && rep.lines[1].s === '두 번째 말' && rep.count === 1 && rep.online === true && rep.reasons[0]?.key === 'abuse', JSON.stringify(rep))
  ok('신고 목록에 sid · IP 키 없음', !/"sid"|ipKey|k:/.test(JSON.stringify(r.data)))
  r = await aget('dashboard')
  ok('대시보드 moderation 요약', r.data.moderation?.reports === 1 && r.data.moderation?.freeChat === true, JSON.stringify(r.data.moderation))

  r = await apost('report/kick', { id: rep.id })
  ok('신고에서 강퇴', r.status === 200 && r.data.ok, JSON.stringify(r.data))
  ok('B 연결 4004 (강퇴)', (await closedWithin(b)) === 4004)
  const leave = await waitFor(a, m => m.t === 'leave' && m.id === helloB.id)
  ok('다른 사람에게 leave', !!leave)
  const b2 = await connect(Bt)
  ok('같은 입장 표로 다시 접속 → 4005 (표 무효)', b2.status === 101 && (await closedWithin(b2)) === 4005)
  const Bt2 = await enter('198.51.100.21')
  ok('강퇴는 IP를 막지 않음: 새 입장 표 OK', Bt2.status === 200)
  const b3 = await connect(Bt2)
  ok('새 표로 접속 OK', !!(await waitFor(b3, m => m.t === 'hello')))
  r = await aget('reports')
  ok('신고 상태 → kicked', r.data.reports?.[0]?.state === 'kicked')

  console.log('── 5. 차단 (IP)')
  r = await apost('player/block', { id: helloA.id, minutes: 60, ip: true, reason: '도배' })
  ok('A를 IP까지 1시간 차단', r.status === 200 && r.data.block?.byIp === true && r.data.block?.bySid === true, JSON.stringify(r.data))
  ok('A 연결 4005', (await closedWithin(a)) === 4005)
  ok('같은 IP의 C도 4005', (await closedWithin(c)) === 4005)
  ok('다른 IP의 B는 그대로', b3.ws.readyState === 1)
  const A2 = await enter('198.51.100.20')
  ok('막힌 IP에서 입장 → 403 blocked', A2.status === 403 && A2.body.reason === 'blocked', `${A2.status} ${JSON.stringify(A2.body)}`)
  const a3 = await connect(Bt2, '198.51.100.20')
  ok('다른 IP 표를 막힌 IP에서 써도 → 4005', a3.status === 101 && (await closedWithin(a3)) === 4005)
  r = await apost('player/block', { id: 'nobody', minutes: 60 })
  ok('나간 사람 차단 → 404 gone', r.status === 404 && r.data.reason === 'gone')
  r = await apost('player/block', { id: helloB.id, minutes: 0 })
  ok('기간 0 → 400', r.status === 400)
  r = await apost('player/block', { id: helloB.id, minutes: 200000 })
  ok('기간 90일 넘음 → 400', r.status === 400)

  r = await aget('blocks')
  const blocks = r.data.blocks ?? []
  ok('차단 목록: 강퇴 1 + 차단 1', blocks.filter(x => x.kind === 'kick').length === 1 && blocks.filter(x => x.kind === 'block').length === 1, JSON.stringify(blocks.map(x => x.kind)))
  ok('차단 목록에 IP 원문 · 키 없음', !/198\.51|k:[A-Za-z0-9_-]{32}/.test(JSON.stringify(r.data)))
  const ipBlock = blocks.find(x => x.kind === 'block')
  r = await apost('block/remove', { id: ipBlock.id })
  ok('차단 풀기', r.status === 200)
  const A3 = await enter('198.51.100.20')
  ok('푼 뒤 입장 OK', A3.status === 200)
  const a4 = await connect(A3)
  ok('푼 뒤 접속 OK', !!(await waitFor(a4, m => m.t === 'hello')))

  console.log('── 6. IP로 막기 (IPv6 /64)')
  r = await apost('block/ip', { ip: '2001:db8:1:2::5', minutes: 30, reason: '로그에서 본 IP' })
  ok('IPv6 차단', r.status === 200 && r.data.block?.byIp)
  ok('같은 /64 입장 → 403', (await enter('2001:db8:1:2:ffff::9')).status === 403)
  ok('다른 /64 입장 → 200', (await enter('2001:db8:1:3::1')).status === 200)
  r = await apost('block/ip', { ip: 'not-an-ip', minutes: 30 })
  ok('IP 아닌 값 → 400 rule', r.status === 400 && r.data.reason === 'rule', JSON.stringify(r.data))
  ok('IPv4-mapped 표기도 같은 IP', (await apost('block/ip', { ip: '::ffff:203.0.113.77', minutes: 30 })).status === 200 && (await enter('203.0.113.77')).status === 403)

  console.log('── 7. 직접 채팅 켜고 끄기')
  r = await apost('chat/free', { on: false })
  ok('채팅 끄기', r.status === 200 && r.data.freeChat === false)
  ok('접속자에게 chatMode free:false', (await waitFor(b3, m => m.t === 'chatMode'))?.free === false)
  send(b3, { t: 'chat', s: '들리나요' })
  ok('끈 뒤 chat → chatNo off', (await waitFor(b3, m => m.t === 'chatNo'))?.reason === 'off')
  const world = await (await fetch(`${B}/api/world`)).json()
  ok('/api/world chat.free도 false', world.chat?.free === false)
  await apost('chat/free', { on: true })
  ok('다시 켜기', (await waitFor(b3, m => m.t === 'chatMode'))?.free === true)

  console.log('── 8. 운영 도구 (다른 프로세스)')
  const t30 = await enter('198.51.100.30')
  const p30 = await connect(t30)
  await waitFor(p30, m => m.t === 'hello')
  x = cli(D1, 'block-ip', '198.51.100.30', '30m', '운영', '도구')
  ok('CLI block-ip', x.status === 0 && /막았습니다/.test(x.stdout), x.stdout + x.stderr)
  const code30 = await closedWithin(p30, 16000)
  ok('CLI 차단이 서버에 반영돼 접속자 4005 (10초 안팎)', code30 === 4005, String(code30))
  x = cli(D1, 'blocks')
  ok('CLI blocks', x.status === 0 && /차단/.test(x.stdout) && !/198\.51/.test(x.stdout), x.stdout)
  const cliId = /#(\d+)/.exec(x.stdout)?.[1]
  x = cli(D1, 'unblock', cliId)
  ok('CLI unblock', x.status === 0 && /풀었습니다/.test(x.stdout), x.stdout + x.stderr)
  await sleep(12000)
  ok('CLI로 푼 뒤 입장 OK', (await enter('198.51.100.30')).status === 200)
  x = cli(D1, 'block-ip', '198.51.100.31', '5x')
  ok('CLI 기간 형식 틀림 → 실패', x.status === 1)
  x = cli(D1, 'schema')
  ok('CLI schema', /v5/.test(x.stdout), x.stdout) // gosa 필드 추가: Alembic 0002 = v5

  console.log('── 9. 기록 · 개인정보')
  r = await aget('log?limit=50')
  const acts = new Set((r.data.log ?? []).map(l => l.action))
  ok('admin_log에 강퇴 · 차단 · 풀기 · IP 차단 · 채팅', ['player-kick', 'player-block', 'block-remove', 'ip-block', 'chat-free'].every(k => acts.has(k)), [...acts].join(','))
  await stop()
  const files = await D.dbDump(D1)
  ok('DB 파일에 IP 원문 없음', !/198\.51\.100\.|2001:db8|203\.0\.113/.test(files))
  ok('DB 파일에 말풍선(신고 내용) 없음', !files.includes(Buffer.from('두 번째 말').toString('latin1')))
})

await section(async () => {
  /* ═══ 2. DB 쓰기 실패 ═══ */
  console.log('── 10. DB 쓰기 실패 (다른 연결이 쓰기 잠금)')
  const D2 = await D.freshDataDir('s1-lock')
  await start(D2, { BOARD_OPEN: 'on' })
  const lockDb = await D.sqlLock(D2)
  const postId = Number((await D.sqlGet(D2, "INSERT INTO posts (at, topic, text, nick) VALUES (?, 'etc', '시험 글', '시험') RETURNING id", [Date.now()])).id)
  const L = await enter('198.51.100.40')
  const l = await connect(L)
  await waitFor(l, m => m.t === 'hello')
  await lockDb.begin()
  await lockDb.run("INSERT INTO clicks (day, slug, n) VALUES ('2000-01-01', 'lock', 1)")
  send(l, { t: 'report', id: postId })
  await sleep(3600)
  ok('쓰기 실패해도 서버 살아 있음', await alive())
  ok('오류 로그 남김 (본문 없이 종류만)', /실시간 메시지 처리\(report\) 실패/.test(srv.out) && D.DB_LOCK_ERROR_RE.test(srv.out), srv.out.split('\n').filter(s => /실패/.test(s)).slice(0, 2).join(' | '))
  send(l, { t: 'chans' })
  ok('그 연결도 계속 씀', !!(await waitFor(l, m => m.t === 'chans', 4000)))
  for (let i = 0; i < 4; i++) {
    send(l, { t: 'report', id: postId })
    await sleep(3200)
  }
  ok('1분에 5번 오류 → 그 연결만 1011', (await closedWithin(l, 4000)) === 1011, String(l.code))
  await lockDb.rollback()
  ok('잠금 풀린 뒤 신고 정상', await (async () => {
    const L2 = await enter('198.51.100.41')
    const l2 = await connect(L2)
    await waitFor(l2, m => m.t === 'hello')
    send(l2, { t: 'report', id: postId })
    const got = await waitFor(l2, m => m.t === 'reported')
    l2.ws.close()
    return got?.id === postId
  })())
  await lockDb.close()
  await stop()
})

await section(async () => {
  /* ═══ 3. 정상 종료 (SIGTERM) ═══ */
  console.log('── 11. SIGTERM 정상 종료')
  // 신호 흉내: node는 lib/node-wrap.mjs, py는 SHRINE_TEST_STDIN=1 (driver.signal)
  D3 = await D.freshDataDir('s1-term')
  await start(D3, {}, { wrapper: true })
  const T1 = await enter('198.51.100.50')
  const T2 = await enter('198.51.100.51')
  const t1 = await connect(T1)
  const t2 = await connect(T2)
  await waitFor(t1, m => m.t === 'hello')
  await waitFor(t2, m => m.t === 'hello')
  // 쓰기를 남겨 WAL이 차게
  await D.sql(D3, "INSERT INTO clicks (day, slug, n) VALUES ('2000-01-02', 'wal', 1)")
  await T.okIf('sqlite-wal', '종료 전 -wal 파일에 내용 있음', () => D.walSize(D3) > 0)
  D.signal(srv, 'reject')
  await sleep(300)
  ok('unhandledRejection → 로그만 남기고 계속', await alive() && /처리되지 않은 Promise 거부/.test(srv.out))
  const t0 = Date.now()
  D.signal(srv, 'SIGTERM')
  const [c1, c2] = await Promise.all([closedWithin(t1, 6000), closedWithin(t2, 6000)])
  ok('모든 접속자 1012 (서버 재시작)', c1 === 1012 && c2 === 1012, `${c1} ${c2}`)
  const ex = await Promise.race([srv.exited, sleep(9000).then(() => null)])
  ok('8초 안에 종료 코드 0', ex?.code === 0 && ex.at - t0 < 8000, JSON.stringify(ex && { code: ex.code, ms: ex.at - t0 }))
  ok('종료 로그', /끝내는 중 \(SIGTERM\)/.test(srv.out) && /끝났습니다 \(SIGTERM\)/.test(srv.out))
  await T.okIf('sqlite-wal', 'WAL 체크포인트 (-wal 비었거나 없음)', () => !D.walExists(D3) || D.walSize(D3) === 0)
  ok('종료 뒤 DB 정상 · 쓰기 남아 있음', (await D.dbIntegrityOk(D3)) && (await D.sqlGet(D3, "SELECT n FROM clicks WHERE slug = 'wal'"))?.n === 1)
  ok('종료 뒤 포트 닫힘', !(await alive()))
  // (원래 srv = null) 스스로 끝나지 않은 대상이면 여기서 꺼서 다음 구간이 새 서버로 시작하게
  await stop()
})

await section(async () => {
  /* ═══ 4. 잡히지 않은 예외 → 정리 후 1 ═══ */
  console.log('── 12. uncaughtException')
  await start(D3, {}, { wrapper: true })
  const U = await enter('198.51.100.52')
  const u = await connect(U)
  await waitFor(u, m => m.t === 'hello')
  D.signal(srv, 'crash')
  ok('접속자 1012', (await closedWithin(u, 6000)) === 1012)
  const ex2 = await Promise.race([srv.exited, sleep(9000).then(() => null)])
  ok('종료 코드 1 (Docker가 다시 띄움)', ex2?.code === 1, JSON.stringify(ex2))
  ok('예외 로그', /잡히지 않은 예외/.test(srv.out) && /시험용 예외/.test(srv.out))
  await stop()
})

await section(async () => {
  /* ═══ 5. 설정 검사 ═══ */
  console.log('── 13. 설정 검사')
  const D5 = await D.freshDataDir('s1-cfg')
  const good = {
    NODE_ENV: 'production', DATA_DIR: D5, TICKET_SECRET: randomBytes(32).toString('hex'),
    TURNSTILE_SITE_KEY: '0x4AAAAAAAB1cDeFgHiJkLmN', TURNSTILE_SECRET: '0x4AAAAAAAB1cDeFgHiJkLmNoPqRsTuVwXyZ01',
    PUBLIC_ORIGIN: 'https://shrine.musabaepo.kr', SHRINE_DOMAIN: 'shrine.musabaepo.kr', CONTACT_EMAIL: 'ops@musabaepo.kr',
  }
  const boot = (env, ms = 2500) => D.boot(baseEnv(env), ms)
  const refuse = (name, env, re) => {
    const r = boot(env)
    ok(name, r.code === 1 && re.test(r.text), r.text.split('\n').filter(s => s.includes('-')).slice(0, 3).join(' | ').slice(0, 300))
  }
  refuse('운영: 다 빠짐 → 거부 (한 번에 모두 알림)', { NODE_ENV: 'production', DATA_DIR: D5, TICKET_SECRET: '' }, /^(?=[\s\S]*TICKET_SECRET이 비어)(?=[\s\S]*TURNSTILE_SITE_KEY가 비어)(?=[\s\S]*TURNSTILE_SECRET이 비어)(?=[\s\S]*PUBLIC_ORIGIN이 비어)(?=[\s\S]*CONTACT_EMAIL이 비어)/)
  refuse('운영: CONTACT_EMAIL 빠짐', { ...good, CONTACT_EMAIL: '' }, /CONTACT_EMAIL이 비어/)
  refuse('운영: TICKET_SECRET 짧음', { ...good, TICKET_SECRET: 'abc123' }, /32자 이상/)
  refuse('운영: TICKET_SECRET 예시 글자', { ...good, TICKET_SECRET: 'please-change-me-to-a-random-value-0001' }, /TICKET_SECRET이 약합니다: 예시 글자/)
  refuse('운영: TICKET_SECRET 되풀이', { ...good, TICKET_SECRET: 'ab12'.repeat(10) }, /TICKET_SECRET이 약합니다/)
  refuse('운영: TICKET_SECRET 한 글자', { ...good, TICKET_SECRET: 'a'.repeat(40) }, /TICKET_SECRET이 약합니다/)
  refuse('운영: Turnstile 시험 사이트 키', { ...good, TURNSTILE_SITE_KEY: '1x00000000000000000000AA' }, /TURNSTILE_SITE_KEY가 Cloudflare 시험용/)
  refuse('운영: Turnstile 시험 비밀 키', { ...good, TURNSTILE_SECRET: '1x0000000000000000000000000000000AA' }, /TURNSTILE_SECRET이 Cloudflare 시험용/)
  refuse('운영: PUBLIC_ORIGIN 예시 주소', { ...good, PUBLIC_ORIGIN: 'https://shrine.example.com', SHRINE_DOMAIN: '' }, /예시 · 로컬 주소/)
  refuse('운영: PUBLIC_ORIGIN http', { ...good, PUBLIC_ORIGIN: 'http://shrine.musabaepo.kr' }, /https:\/\/로 시작/)
  refuse('운영: PUBLIC_ORIGIN 경로 포함', { ...good, PUBLIC_ORIGIN: 'https://shrine.musabaepo.kr/app' }, /경로 없이/)
  refuse('운영: SHRINE_DOMAIN과 다름', { ...good, SHRINE_DOMAIN: 'other.musabaepo.kr' }, /SHRINE_DOMAIN\(other/)
  refuse('운영: ADMIN_PASSWORD 약함', { ...good, ADMIN_PASSWORD: 'test-admin-password-0123456789' }, /ADMIN_PASSWORD가 약합니다/)
  refuse('운영: ADMIN_PASSWORD 짧음', { ...good, ADMIN_PASSWORD: 'short-pw' }, /16~256자/)
  refuse('운영: ADMIN_IPS 틀림', { ...good, ADMIN_PASSWORD: 'Zq7-moder-pw-9xK2vLp-Hf3', ADMIN_IPS: '10.0.0.1,nope' }, /ADMIN_IPS/)
  refuse('운영: NOTIFY_WEBHOOK_URL http', { ...good, NOTIFY_WEBHOOK_URL: 'http://hooks.musabaepo.kr/x' }, /NOTIFY_WEBHOOK_URL은 운영에서 https/)
  refuse('운영: CONTACT_EMAIL 예시', { ...good, CONTACT_EMAIL: 'me@example.com' }, /CONTACT_EMAIL이 예시/)
  refuse('개발도: PORT 글자', { DATA_DIR: D5, PORT: 'abc' }, /PORT는 1~65535/)
  refuse('개발도: TRUST_PROXY yes', { DATA_DIR: D5, TRUST_PROXY: 'yes' }, /TRUST_PROXY는 true 또는 false/)
  refuse('개발도: FREE_CHAT maybe', { DATA_DIR: D5, FREE_CHAT: 'maybe' }, /FREE_CHAT는 on 또는 off/)
  refuse('개발도: BOARD_OPEN 1', { DATA_DIR: D5, BOARD_OPEN: '1' }, /BOARD_OPEN는 on 또는 off/)
  refuse('개발도: NODE_ENV 오타', { DATA_DIR: D5, NODE_ENV: 'prod' }, /NODE_ENV는 production/)
  refuse('개발도: RETENTION_DAYS 글자', { DATA_DIR: D5, RETENTION_DAYS: 'thirty' }, /RETENTION_DAYS/)
  const dev = boot({ DATA_DIR: D5, ADMIN_PASSWORD: 'short-pw' })
  ok('개발: 짧은 ADMIN_PASSWORD는 경고 + 운영자 화면만 끔 (시작은 함)', dev.code !== 1 && /설정 경고: ADMIN_PASSWORD/.test(dev.text), dev.text.slice(0, 200))
  const prod = boot(good, 3000)
  ok('운영: 올바른 설정이면 시작', prod.code !== 1 && /운영\)/.test(prod.text), prod.text.slice(0, 300))
})

await section(async () => {
  /* ═══ 6. DB 마이그레이션 ═══ */
  console.log('── 14. DB 마이그레이션')
  const D6 = await D.freshDataDir('s1-mig')
  // 버전 관리 전 모양 (node: 일부 칸 없음 · user_version 0 · 옛 데이터, py: 빈 DB — driver.seedLegacySchema)
  await D.seedLegacySchema(D6)
  x = cli(D6, 'schema')
  ok('옛 DB → v5로 올림', x.status === 0 && /버전 v5/.test(x.stdout), x.stdout + x.stderr) // gosa 필드 추가: Alembic 0002 = v5
  const snaps = D.preMigrateSnapshots(D6)
  await T.okIf('sqlite-legacy', '바꾸기 전 사본', () => snaps.length === 1 && /^shrine-v0-to-v4-/.test(snaps[0]), () => snaps.join(','))
  const cols = await D.tableColumns(D6, 'shrines')
  // 옛 데이터(clicks old=7)는 옛 SQLite DB가 있는 대상만 (sqlite-legacy)
  ok('빠진 칸 채움 · 새 표 · 옛 데이터 그대로', cols.includes('repo') && cols.includes('sign')
    && (await D.hasTable(D6, 'blocks'))
    && (!D.has('sqlite-legacy') || (await D.sqlGet(D6, "SELECT n FROM clicks WHERE slug = 'old'"))?.n === 7), cols.join(','))
  x = cli(D6, 'schema')
  ok('두 번째 실행은 그대로 (사본 더 안 뜸)', /버전 v5/.test(x.stdout) && (!D.has('sqlite-legacy') || D.preMigrateSnapshots(D6).length === 1), x.stdout + x.stderr) // gosa 필드 추가
  await D.setFutureSchemaVersion(D6)
  x = cli(D6, 'schema')
  ok('더 새 DB면 시작 거부', x.status !== 0 && /더 새 서버가 만든 DB/.test(x.stderr), x.stderr.slice(0, 200))
})

await T.done()
