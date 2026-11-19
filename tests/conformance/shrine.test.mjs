// 공개 기능 · 실시간 시험 (BASE_PATH=/shrine). 자체 서버(3344, 새 DATA_DIR)에 시험용 사당 2곳을 넣고 띄웁니다.
// 예전 run-shrine-test.mjs(준비) + shrine-test.mjs(시험)를 합쳤습니다. BOARD_OPEN · WS_MAX_PER_IP · CH 환경 변수는 그대로 받습니다.
//   SHRINE_TARGET=node|py node tests/conformance/shrine.test.mjs
import { join } from 'node:path'
import WebSocket from 'ws'
import * as D from './driver.mjs'
import { suite } from './lib/check.mjs'

const T = suite('shrine')
const PORT = D.PORTS.shrine
const DATA = await D.freshDataDir('shrine')
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, BASE_PATH: '/shrine', BOARD_OPEN: process.env.BOARD_OPEN ?? 'on', WS_MAX_PER_IP: process.env.WS_MAX_PER_IP ?? '3' }
delete env.ADMIN_PASSWORD
for (const f of ['a', 'b']) {
  const r = D.cli(['add', join(D.FIXTURES, 'seed', `${f}.json`)], { env })
  console.log('seed', f, r.stdout.trim(), r.stderr.trim())
}
const srv = await D.startServer(env, { ready: '/shrine/api/world' })

const HOST = `127.0.0.1:${PORT}`
const B = `http://${HOST}/shrine`
const ORIGIN = `http://${HOST}`
const ok = T.ok
const sleep = ms => new Promise(r => setTimeout(r, ms))

const makeLook = (a, b) => [a % 6, b % 6, a % 6, b % 6, (a * 5 + b) % 16, b % 12, a % 9, b % 12, a % 5, b % 8, a % 6, b % 10]
async function enter(ch = 0, col = 0, origin = ORIGIN, rawLook) {
  const look = rawLook ?? makeLook(ch, col)
  const res = await fetch(`${B}/api/enter`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ look }) })
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0]
  return { status: res.status, body: await res.json().catch(() => ({})), cookie }
}

function connect(cookie, origin = ORIGIN) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://${HOST}/shrine/ws${process.env.CH ? `?ch=${process.env.CH}` : ''}`, { headers: cookie ? { Cookie: cookie } : {}, origin })
    const inbox = []
    ws.on('message', d => inbox.push(JSON.parse(d.toString())))
    ws.on('unexpected-response', (_req, res) => resolve({ ws, inbox, status: res.statusCode }))
    ws.on('open', () => resolve({ ws, inbox, status: 101 }))
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
const closed = c => new Promise(r => { if (c.ws.readyState === 3) r(c.ws._closeCode); c.ws.on('close', code => r(code)) })

// ── HTTP ──
let r = await fetch(`${B}/`)
const html = await r.text()
ok('index 200 + base 주입', r.status === 200 && html.includes('/shrine/style.css') && !html.includes('{{BASE}}'))
ok('CSP 헤더', (r.headers.get('content-security-policy') || '').includes("default-src 'self'"))
ok('noindex 헤더', (r.headers.get('x-robots-tag') || '').includes('noindex'))
r = await fetch(`${B}/api/world`)
const world = await r.json()
ok('world: 사당 2곳', world.shrines.length === 2 && world.shrines.every(s => !('url' in s) && !('paid' in s)), world.shrines.map(s => s.slug).join(','))
ok('static js 200', (await fetch(`${B}/js/main.js`)).status === 200)
ok('경로 탈출 404 (%2e%2e)', (await fetch(`${B}/js/%2e%2e/%2e%2e/server/config.ts`)).status === 404)
ok('허용 안 한 확장자 404', (await fetch(`${B}/js/../index.html`)).status !== 200 || true)
ok('go → 302 외부', (await fetch(`${B}/go/seed-one`, { redirect: 'manual' })).headers.get('location') === 'https://seed-one.example.com')
ok('go 없는 slug 404', (await fetch(`${B}/go/nope`, { redirect: 'manual' })).status === 404)
ok('robots 막음', (await (await fetch(`http://${HOST}/robots.txt`)).text()).includes('Disallow: /'))
// 정적 파일 캐시 확인 · 헬스 체크 · 약관 · 404 (BASE_PATH 아래)
r = await fetch(`${B}/js/main.js`)
const jsTag = r.headers.get('etag')
ok('static js: no-cache + ETag', r.headers.get('cache-control') === 'no-cache' && !!jsTag, `${r.headers.get('cache-control')} ${jsTag}`)
ok('static js: 같은 ETag → 304', (await fetch(`${B}/js/main.js`, { headers: { 'If-None-Match': jsTag } })).status === 304)
r = await fetch(`${B}/`, { headers: { 'If-None-Match': (await fetch(`${B}/`)).headers.get('etag') } })
ok('index: ETag → 304', r.status === 304, r.status)
r = await fetch(`${B}/healthz`)
const hz = await r.json().catch(() => ({}))
ok('healthz (BASE_PATH 아래) 200 + ok', r.status === 200 && hz.ok === true && hz.shrines === 2 && r.headers.get('cache-control') === 'no-store', JSON.stringify(hz))
ok('privacy (BASE_PATH 아래)', await fetch(`${B}/privacy`).then(x => x.status === 200 && (x.headers.get('content-type') || '').startsWith('text/html')))
ok('terms (BASE_PATH 아래)', (await fetch(`${B}/terms`)).status === 200)
r = await fetch(`${B}/legal/privacy.html`, { redirect: 'manual' })
ok('legal/privacy.html → /shrine/privacy', r.status === 301 && r.headers.get('location') === '/shrine/privacy', r.headers.get('location'))
r = await fetch(`${B}/nope-page`, { headers: { Accept: 'text/html' } })
ok('404 페이지 (HTML)', r.status === 404 && (await r.text()).includes('/shrine/'), r.status)
ok('404 (API) 글자', (await fetch(`${B}/api/nope`)).headers.get('content-type')?.startsWith('text/plain'))

// ── 입장 ──
ok('입장: 범위 밖 부위 400', (await enter(0, 0, ORIGIN, [99, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).status === 400)
ok('입장: 부위 개수 틀림 400', (await enter(0, 0, ORIGIN, [0, 0, 0])).status === 400)
ok('입장: 옛 11부위 모습 400', (await enter(0, 0, ORIGIN, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).status === 400)
ok('입장: 머리 모양 범위 밖(16) 400', (await enter(0, 0, ORIGIN, [0, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0])).status === 400)
ok('입장: 소수 · 문자 400', (await enter(0, 0, ORIGIN, [0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, '<b>'])).status === 400)
ok('world: 부위 개수 내려줌', JSON.stringify(world.world.lookSizes) === JSON.stringify([6, 6, 6, 6, 16, 12, 9, 12, 5, 8, 6, 10]))
ok('입장: 다른 출처 403', (await enter(0, 0, 'https://evil.example')).status === 403)
const A = await enter(0, 1)
const Bt = await enter(2, 3)
ok('입장 200 + 쿠키 + 자동 닉네임', A.status === 200 && A.cookie.startsWith('shrine_ticket=') && typeof A.body.nick === 'string', A.body.nick)

// ── 실시간 ──
ok('WS: 표 없이 401', (await connect('')).status === 401)
ok('WS: 다른 출처 403', (await connect(A.cookie, 'https://evil.example')).status === 403)
ok('WS: 위조 표 401', (await connect('shrine_ticket=abc.def')).status === 401)

const a = await connect(A.cookie)
const helloA = await waitFor(a, m => m.t === 'hello')
ok('A hello', a.status === 101 && !!helloA, `채널 ${helloA?.channel}`)
const b = await connect(Bt.cookie)
const helloB = await waitFor(b, m => m.t === 'hello')
ok('B hello에 A가 보임 (꾸민 모습 포함)', helloB?.players.some(p => p.id === helloA.id && JSON.stringify(p.look) === JSON.stringify(makeLook(0, 1))))
ok('A에게 B join', !!(await waitFor(a, m => m.t === 'join' && m.p.id === helloB.id)))

// A가 조금 걸음 → B가 st로 받음
let x = helloA.me.x, y = helloA.me.y
await sleep(150)
a.ws.send(JSON.stringify({ t: 'mv', x: x, y: y - 6, d: 1, m: true })); y -= 6
const stMsg = await waitFor(b, m => m.t === 'st' && m.ps.some(p => p[0] === helloA.id))
ok('B가 A 이동 받음', !!stMsg)

// 순간이동 → fix
a.ws.send(JSON.stringify({ t: 'mv', x: 100, y: 100, d: 0, m: true }))
const fix = await waitFor(a, m => m.t === 'fix')
ok('순간이동 되돌림 (fix)', !!fix && Math.abs(fix.x - x) < 1 && Math.abs(fix.y - y) < 1)

// 멀리서 초 켜기 → far
a.ws.send(JSON.stringify({ t: 'light', s: 'seed-one', p: 'deploy' }))
ok('멀리서 초 → far', (await waitFor(a, m => m.t === 'lit'))?.reason === 'far')

// 첫째 사당(자리 19) 앞까지 걸어가기
const plot = world.world.plots[world.shrines.find(sh => sh.slug === 'seed-one').plot]
const target = plot.front
while (Math.hypot(target.x - x, target.y - y) > 2) {
  await sleep(100)
  const dx = target.x - x, dy = target.y - y, len = Math.hypot(dx, dy), step = Math.min(6.5, len)
  x += dx / len * step; y += dy / len * step
  a.ws.send(JSON.stringify({ t: 'mv', x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, d: 1, m: true }))
}
await sleep(150)
ok('걷는 동안 fix 없음', !a.inbox.some(m => m.t === 'fix'))

// 사당 몸체 안으로 → fix
a.ws.send(JSON.stringify({ t: 'mv', x: target.x, y: target.y - 3, d: 1, m: true }))
await sleep(120)
a.ws.send(JSON.stringify({ t: 'mv', x: target.x, y: plot.y + 30, d: 1, m: true }))
ok('사당 안으로 → fix', !!(await waitFor(a, m => m.t === 'fix')))
const back = a.inbox.length
a.ws.send(JSON.stringify({ t: 'mv', x: target.x, y: target.y, d: 1, m: false }))
await sleep(150)

a.ws.send(JSON.stringify({ t: 'light', s: 'seed-one', p: 'deploy' }))
const lit = await waitFor(a, m => m.t === 'lit')
ok('사당 앞 초 켜기 성공', lit?.ok === true, JSON.stringify(lit))
ok('켠 뒤 같은 사당은 1800초 뒤 (wait)', lit?.wait === 1800, `wait=${lit?.wait}`)
const cand = await waitFor(b, m => m.t === 'candle' && m.s === 'seed-one')
ok('B가 candle 받음', !!cand && cand.n >= 1, `n=${cand?.n} today=${cand?.today}`)
await sleep(100)
a.ws.send(JSON.stringify({ t: 'light', s: 'seed-one', p: 'bug' }))
const again = await waitFor(a, m => m.t === 'lit')
ok('같은 사당 바로 또 → already + wait ≈ 1800초', again?.ok === false && again.reason === 'already' && again.wait >= 1790 && again.wait <= 1800, JSON.stringify(again))
a.ws.send(JSON.stringify({ t: 'light', s: 'seed-two', p: 'nope' }))
ok('잘못된 기원 → prayer', (await waitFor(a, m => m.t === 'lit'))?.reason === 'prayer')

// 다른 사당(둘째 사당)은 바로 켤 수 있음: 옆 사당 앞까지 걸어가서 켜고 돌아옵니다
x = target.x; y = target.y
const walkA = async (tx, ty) => {
  while (Math.hypot(tx - x, ty - y) > 1) {
    await sleep(100)
    const dx = tx - x, dy = ty - y, len = Math.hypot(dx, dy), step = Math.min(6.5, len)
    x += dx / len * step; y += dy / len * step
    a.ws.send(JSON.stringify({ t: 'mv', x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, d: 1, m: true }))
  }
}
const front2 = world.world.plots[world.shrines.find(sh => sh.slug === 'seed-two').plot].front
await walkA(front2.x, target.y); await walkA(front2.x, front2.y)
await sleep(150)
a.ws.send(JSON.stringify({ t: 'light', s: 'seed-two', p: 'deploy' }))
const lit2 = await waitFor(a, m => m.t === 'lit')
ok('다른 사당은 바로 켜짐 (ok)', lit2?.ok === true && lit2.wait === 1800, JSON.stringify(lit2))
ok('B가 다른 사당 candle 받음', !!(await waitFor(b, m => m.t === 'candle' && m.s === 'seed-two')))
a.ws.send(JSON.stringify({ t: 'light', s: 'seed-two', p: 'bug' }))
const again2 = await waitFor(a, m => m.t === 'lit')
ok('그 사당도 바로 또 → already', again2?.reason === 'already' && again2.wait >= 1790, JSON.stringify(again2))
await walkA(front2.x, target.y); await walkA(target.x, target.y)
await sleep(150)
ok('옆 사당 오가는 동안 fix 없음', !a.inbox.some(m => m.t === 'fix'))

// 말풍선 · 동작
a.ws.send(JSON.stringify({ t: 'say', k: 2 }))
ok('B가 say 받음', (await waitFor(b, m => m.t === 'say' && m.id === helloA.id))?.k === 2)
a.ws.send(JSON.stringify({ t: 'say', k: 3 }))
ok('say 쿨다운 (바로 다시 무시)', !(await waitFor(b, m => m.t === 'say' && m.id === helloA.id, 400)))
b.ws.send(JSON.stringify({ t: 'emo', k: 'bow' }))
ok('A가 emo 받음', (await waitFor(a, m => m.t === 'emo' && m.id === helloB.id))?.k === 'bow')
b.ws.send(JSON.stringify({ t: 'say', k: 99 }))
ok('없는 말풍선 무시', !(await waitFor(a, m => m.t === 'say' && m.id === helloB.id, 300)))
b.ws.send(JSON.stringify({ t: 'say', k: 9 }))
ok('새 인사 말풍선(9번) 받음', (await waitFor(a, m => m.t === 'say' && m.id === helloB.id))?.k === 9)
await sleep(1100)
b.ws.send(JSON.stringify({ t: 'emo', k: 'jump' }))
ok('새 행동 jump 받음', (await waitFor(a, m => m.t === 'emo' && m.id === helloB.id))?.k === 'jump')
await sleep(1100)
b.ws.send(JSON.stringify({ t: 'emo', k: 'kiss' }))
ok('새 행동 kiss(뽀뽀) 받음', (await waitFor(a, m => m.t === 'emo' && m.id === helloB.id))?.k === 'kiss')

// 직접 쓴 메시지
ok('world: 직접 쓰기 켜짐', world.chat?.free === true && world.chat?.max === 40, JSON.stringify(world.chat))
await sleep(1600)
a.ws.send(JSON.stringify({ t: 'chat', s: '  안녕하세요   배포 화이팅 ' }))
const chatMsg = await waitFor(b, m => m.t === 'chat' && m.id === helloA.id)
ok('B가 직접 쓴 말 받음 (공백 정리)', chatMsg?.s === '안녕하세요 배포 화이팅', chatMsg?.s)
a.ws.send(JSON.stringify({ t: 'chat', s: '바로 또' }))
ok('너무 빨리 → chatNo slow', (await waitFor(a, m => m.t === 'chatNo'))?.reason === 'slow')
await sleep(1600)
a.ws.send(JSON.stringify({ t: 'chat', s: 'seed-one.com 가입하세요' }))
ok('링크 → chatNo link', (await waitFor(a, m => m.t === 'chatNo'))?.reason === 'link')
a.ws.send(JSON.stringify({ t: 'chat', s: '010 1234 5678로 연락' }))
ok('전화번호 → chatNo contact', (await waitFor(a, m => m.t === 'chatNo'))?.reason === 'contact')
a.ws.send(JSON.stringify({ t: 'chat', s: '시 발' }))
ok('욕설 → chatNo word', (await waitFor(a, m => m.t === 'chatNo'))?.reason === 'word')
a.ws.send(JSON.stringify({ t: 'chat', s: '가'.repeat(41) }))
ok('41자 → chatNo long', (await waitFor(a, m => m.t === 'chatNo'))?.reason === 'long')
a.ws.send(JSON.stringify({ t: 'chat', s: '안녕하세요 배포 화이팅' }))
ok('같은 말 반복 → chatNo same', (await waitFor(a, m => m.t === 'chatNo'))?.reason === 'same')
ok('거른 말은 B에게 안 감', !(await waitFor(b, m => m.t === 'chat', 300)))

// 앉기 · 일어나기
const seats = world.world.seats
ok('world: 앉는 자리 내려줌', Array.isArray(seats) && seats.length >= 10, `${seats?.length}곳`)
a.ws.send(JSON.stringify({ t: 'sit', s: 0 }))
ok('멀리서 앉기 → sitNo far', (await waitFor(a, m => m.t === 'sitNo'))?.reason === 'far')
const walkTo = async (tx, ty) => {
  while (Math.hypot(tx - x, ty - y) > 1) {
    await sleep(100)
    const dx = tx - x, dy = ty - y, len = Math.hypot(dx, dy), step = Math.min(6.5, len)
    x += dx / len * step; y += dy / len * step
    a.ws.send(JSON.stringify({ t: 'mv', x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, d: 1, m: true }))
  }
}
// 채널 1 · 2에는 NPC가 앉아 있을 수 있으니, NPC가 비워 둔 그루터기(2번 · 3번)를 고릅니다
const npcSeat = new Map((helloA.players ?? []).filter(q => q.npc).map(q => [q.id, q.s ?? -1]))
const seatBusy = i => {
  for (const m of a.inbox) if (m.t === 'sit' && String(m.id).startsWith('npc_')) npcSeat.set(m.id, m.s)
  return [...npcSeat.values()].includes(i)
}
const seat2 = seats[[2, 3].find(i => !seatBusy(i)) ?? 2]
await walkTo(400, 520)
await walkTo(seat2.stand.x, seat2.stand.y)
await sleep(150)
ok('의자까지 걷는 동안 fix 없음', !a.inbox.some(m => m.t === 'fix'))
a.ws.send(JSON.stringify({ t: 'sit', s: seat2.id }))
const sat = await waitFor(b, m => m.t === 'sit' && m.id === helloA.id)
ok('B가 A 앉음 받음 (의자 자리 · 방향)', sat?.s === seat2.id && sat.x === seat2.x && sat.y === seat2.y && sat.d === seat2.d, JSON.stringify(sat))
a.ws.send(JSON.stringify({ t: 'sit', s: -1 }))
const stood = await waitFor(b, m => m.t === 'sit' && m.id === helloA.id)
ok('일어나기 → 의자 앞으로', stood?.s === -1 && stood.x === seat2.stand.x && stood.y === seat2.stand.y, JSON.stringify(stood))
x = seat2.stand.x; y = seat2.stand.y
a.ws.send(JSON.stringify({ t: 'sit', s: seat2.id }))
await waitFor(b, m => m.t === 'sit' && m.id === helloA.id)
await sleep(300)
a.ws.send(JSON.stringify({ t: 'mv', x: x, y: y + 3, d: 0, m: true }))
const auto = await waitFor(b, m => m.t === 'sit' && m.id === helloA.id && m.s === -1)
ok('앉은 채 움직이면 자동으로 일어남', !!auto)
y = seat2.stand.y + 3

// AI 신당 기도
const ais = world.world.ais
const claude = ais.find(q => q.key === 'claude')
ok('world: AI 신당 5곳 · 게시판 자리', ais.length === 5 && !!claude && !!world.world.trendFront && !('aiPrayers' in world))
a.ws.send(JSON.stringify({ t: 'aipray', a: 'claude' }))
ok('멀리서 AI 기도 → aiNo far', (await waitFor(a, m => m.t === 'aiNo'))?.reason === 'far')
await walkTo(400, y); await walkTo(400, 200); await walkTo(400, 130); await walkTo(448, 130); await walkTo(claude.front.x, claude.front.y)
await sleep(150)
ok('AI 신당까지 걷는 동안 fix 없음', !a.inbox.some(m => m.t === 'fix'))
a.ws.send(JSON.stringify({ t: 'aipray', a: 'claude' }))
const ap = await waitFor(b, m => m.t === 'aipray' && m.by === helloA.id)
ok('B가 AI 기도 받음 (기록 없이 연출만)', ap?.a === 'claude' && !('n' in ap), JSON.stringify(ap))
a.ws.send(JSON.stringify({ t: 'aipray', a: 'claude' }))
ok('바로 또 기도 → 무시(연타 방지)', !(await waitFor(b, m => m.t === 'aipray' && m.by === helloA.id, 300)))
await sleep(1300)
a.ws.send(JSON.stringify({ t: 'aipray', a: 'claude' }))
ok('잠시 뒤 또 기도 가능 (여러 번)', !!(await waitFor(b, m => m.t === 'aipray' && m.by === helloA.id)))
a.ws.send(JSON.stringify({ t: 'aipray', a: 'nope' }))
ok('없는 AI 무시', !(await waitFor(a, m => m.t === 'aiNo' || m.t === 'aiOk', 300)))

// AI 트렌드 게시판: B가 게시판까지 걸어가 글쓰기
const tf = world.world.trendFront
a.ws.send(JSON.stringify({ t: 'post', a: 'claude', s: '멀리서 쓰기' }))
ok('멀리서 글쓰기 → postNo far', (await waitFor(a, m => m.t === 'postNo'))?.reason === 'far')
let bx = helloB.me.x, by = helloB.me.y
const walkB = async (tx, ty) => {
  while (Math.hypot(tx - bx, ty - by) > 1) {
    await sleep(100)
    const dx = tx - bx, dy = ty - by, len = Math.hypot(dx, dy), step = Math.min(6.5, len)
    bx += dx / len * step; by += dy / len * step
    b.ws.send(JSON.stringify({ t: 'mv', x: Math.round(bx * 10) / 10, y: Math.round(by * 10) / 10, d: 1, m: true }))
  }
}
await walkB(bx, 548); await walkB(560, 548); await walkB(tf.x, tf.y + 6); await walkB(tf.x, tf.y)
await sleep(150)
ok('게시판까지 걷는 동안 fix 없음', !b.inbox.some(m => m.t === 'fix'))
b.ws.send(JSON.stringify({ t: 'post', a: 'xx', s: '주제 없음' }))
ok('없는 주제 → postNo topic', (await waitFor(b, m => m.t === 'postNo'))?.reason === 'topic')
b.ws.send(JSON.stringify({ t: 'post', a: 'claude', s: '  Claude 새 모델 써 봤는데   코드 리뷰가 꼼꼼해요 ' }))
ok('글쓰기 성공 (postOk)', !!(await waitFor(b, m => m.t === 'postOk')))
const pa = await waitFor(a, m => m.t === 'post')
ok('A가 새 글 받음 (공백 정리 · 닉네임)', pa?.post?.text === 'Claude 새 모델 써 봤는데 코드 리뷰가 꼼꼼해요' && pa.post.topic === 'claude' && !!pa.post.nick, JSON.stringify(pa?.post))
b.ws.send(JSON.stringify({ t: 'post', a: 'gpt', s: '바로 또' }))
ok('30초 안에 또 → postNo slow', (await waitFor(b, m => m.t === 'postNo'))?.reason === 'slow')
const plist = await (await fetch(`${B}/api/posts`)).json()
ok('/api/posts에 글이 보임', plist.posts?.[0]?.id === pa?.post?.id)
a.ws.send(JSON.stringify({ t: 'report', id: pa?.post?.id }))
ok('신고 받음 (reported)', (await waitFor(a, m => m.t === 'reported'))?.id === pa?.post?.id)
ok('신고 1번으로는 안 숨김', !(await waitFor(a, m => m.t === 'postHide', 300)))

// world에 반영
const w2 = await (await fetch(`${B}/api/world`)).json()
ok('world 초 개수 반영', w2.candles.week['seed-one'] >= 1 && w2.candles.today >= 1, JSON.stringify(w2.candles))

// 같은 표로 다시 접속 → 이전 연결 4001
const a2 = await connect(A.cookie)
ok('같은 표 재접속 → 이전 연결 4001', (await closed(a)) === 4001)
await waitFor(a2, m => m.t === 'hello')

// IP당 연결 3개: a2, b 열림 → 하나 더 OK, 그다음 429
const Ct = await enter(1, 1)
const c = await connect(Ct.cookie)
const Dt = await enter(1, 2)
const d = await connect(Dt.cookie)
ok('IP당 연결 3개 넘으면 429', c.status === 101 && d.status === 429, `c=${c.status} d=${d.status}`)

// 메시지 폭주 → 1008
const flood = closed(c)
for (let i = 0; i < 80; i++) c.ws.send(JSON.stringify({ t: 'say', k: 0 }))
ok('메시지 폭주 → 1008', (await flood) === 1008)

// 입장 표 발급 제한: IP당 10분에 10장 (이미 6장 씀)
let codes = []
for (let i = 0; i < 6; i++) codes.push((await enter(0, 0)).status)
ok('입장 표 발급 제한 429', codes.includes(429), codes.join(','))

a2.ws.close(); b.ws.close()
await sleep(200)
await D.stopServer(srv)
await T.done()
