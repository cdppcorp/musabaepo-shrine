// 운영자 화면(/admin) 시험. 자체 서버(3341, 새 DATA_DIR)를 띄워서 돌립니다. 끝나면 서버 · Edge를 끕니다.
//   SHRINE_TARGET=node|py node tests/conformance/admin.test.mjs            → API 시험만
//   SHRINE_TARGET=node|py node tests/conformance/admin.test.mjs --browser  → API 시험 + 화면 사진 (headless Edge, 작업 폴더/admin-shots)
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import * as D from './driver.mjs'
import { suite } from './lib/check.mjs'

const DATA = await D.freshDataDir('admin')
const SHOTS = join(D.RUN_DIR, 'admin-shots')
const EDGE = D.EDGE
const CDP_PORT = 9441
const PORT = D.PORTS.admin
const B = `http://127.0.0.1:${PORT}`
const ORIGIN = B
const PW = 'test-admin-password-0123456789'
const ADMIN_IP = '198.51.100.10'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const T = suite('admin')
const ok = T.ok

/* ── 서버 ── */

let server = null
let serverErr = ''
function baseEnv(extra) {
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, GITHUB_CHECK: 'off', BASE_PATH: '', TRUST_PROXY: 'true', ...extra }
  for (const k of ['ADMIN_PASSWORD', 'ADMIN_IPS', 'NODE_ENV', 'PUBLIC_ORIGIN']) if (!(k in extra)) delete env[k]
  return env
}
async function start(extra = {}) {
  const prefix = extra.BASE_PATH ?? ''
  server = await D.startServer(baseEnv(extra), { ready: `${prefix}/api/world` })
  serverErr = server.err
}
async function stop() {
  if (!server) return
  const s = server
  server = null
  await D.stopServer(s)
}

/* ── 요청 도구 ── */

async function req(method, path, { body, cookie, origin = ORIGIN, ip = ADMIN_IP, type = 'application/json', headers = {}, prefix = '' } = {}) {
  const h = { ...headers }
  if (origin) h.Origin = origin
  if (cookie) h.Cookie = cookie
  if (ip) h['X-Forwarded-For'] = ip
  if (body !== undefined) h['Content-Type'] = type
  const payload = body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  const r = await fetch(`${B}${prefix}${path}`, { method, headers: h, body: payload, redirect: 'manual' })
  const text = await r.text()
  let data = null
  try { data = JSON.parse(text) } catch {}
  return { status: r.status, data, text, headers: r.headers }
}
const get = (path, opt) => req('GET', path, opt)
const post = (path, body, opt) => req('POST', path, { ...opt, body })
const cookieOf = r => (r.headers.get('set-cookie') || '').split(';')[0]

function png(w, h, rgb = [40, 120, 200]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([(rgb[0] + x) & 255, (rgb[1] + y) & 255, rgb[2]], y * (w * 3 + 1) + 1 + x * 3)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** 방문자 입장 표 (공개 API) */
async function enter(ip) {
  const r = await req('POST', '/api/enter', { body: { look: [0, 1, 0, 0, 1, 1, 1, 2, 0, 0, 0, 0] }, ip })
  return cookieOf(r)
}
const world = async () => (await (await fetch(`${B}/api/world`)).json())

rmSync(SHOTS, { recursive: true, force: true })
mkdirSync(SHOTS, { recursive: true })

/* ═══ 1. 꺼져 있을 때: 404 ═══ */

const offPaths = [['GET', '/admin'], ['GET', '/admin/login.js'], ['GET', '/admin/app.js'], ['GET', '/admin/admin.css'], ['POST', '/api/admin/login'], ['GET', '/api/admin/dashboard']]
async function allNotFound(label) {
  const res = []
  for (const [m, p] of offPaths) res.push((await req(m, p, m === 'POST' ? { body: { password: PW } } : {})).status)
  ok(`${label}: /admin · /api/admin/* 전부 404`, res.every(s => s === 404), res.join(','))
}
await start({})
await allNotFound('ADMIN_PASSWORD 없음')
ok('꺼져 있어도 공개 페이지는 그대로', (await get('/')).status === 200)
await stop()

await start({ ADMIN_PASSWORD: 'short-pass-123' })
await allNotFound('ADMIN_PASSWORD 16자 미만')
ok('짧은 비밀번호: 서버가 이유를 알림', /16~256자/.test(serverErr), serverErr.trim().split('\n')[0])
await stop()

await start({ ADMIN_PASSWORD: PW, ADMIN_IPS: '10.1.2.3,not-an-ip' })
await allNotFound('ADMIN_IPS에 IP 아닌 값')
await stop()

/* ═══ 2. 켜진 서버 (허용 IP: 관리자 · 공격자 시험용 · 브라우저 127.0.0.1) ═══ */

await start({ ADMIN_PASSWORD: PW, ADMIN_IPS: `${ADMIN_IP}, 203.0.113.7, 127.0.0.1, ::ffff:198.51.100.11` })

let r = await get('/admin', { ip: '192.0.2.99' })
ok('허용 IP 밖 → 404', r.status === 404)
r = await post('/api/admin/login', { password: PW }, { ip: '192.0.2.99' })
ok('허용 IP 밖 로그인 → 404', r.status === 404)
r = await get('/admin', { ip: '198.51.100.11' })
ok('허용 IP (::ffff: 꼴로 적어도) → 200', r.status === 200)

r = await get('/admin')
ok('/admin (로그인 전) → 로그인 화면', r.status === 200 && r.text.includes('id="loginForm"') && !r.text.includes('app.js'))
ok('/admin: Cache-Control no-store', r.headers.get('cache-control') === 'no-store')
ok('/admin: X-Robots-Tag noindex', /noindex/.test(r.headers.get('x-robots-tag') ?? ''))
ok('/admin: <meta robots noindex>', r.text.includes('<meta name="robots" content="noindex, nofollow">'))
ok('/admin: 좁은 CSP (default-src none, script self)', /default-src 'none'/.test(r.headers.get('content-security-policy') ?? '') && /script-src 'self'(;|$)/.test(r.headers.get('content-security-policy') ?? ''))
ok('/admin: frame-ancestors none + X-Frame-Options', /frame-ancestors 'none'/.test(r.headers.get('content-security-policy') ?? '') && r.headers.get('x-frame-options') === 'DENY')
ok('/admin: Referrer-Policy no-referrer', r.headers.get('referrer-policy') === 'no-referrer')
ok('/admin/ → /admin 로', (await get('/admin/')).headers.get('location') === '/admin')
ok('로그인 전 app.js → 404', (await get('/admin/app.js')).status === 404)
ok('login.js · admin.css는 받음', (await get('/admin/login.js')).status === 200 && (await get('/admin/admin.css')).status === 200)
ok('public/admin 다른 파일은 안 줌 (index.html 직접)', (await get('/admin/index.html')).status === 404)
ok('정적 경로로 admin 파일 못 받음', (await get('/js/admin.js')).status === 404 && (await get('/admin.css')).status === 404)

/* 로그인: 틀린 비밀번호 → 잠금 */
const ATT = '203.0.113.7'
const wrong = []
for (let i = 0; i < 5; i++) wrong.push((await post('/api/admin/login', { password: `wrong-password-${i}-xxxxxxxx` }, { ip: ATT })).status)
ok('틀린 비밀번호 5번 → 401', wrong.every(s => s === 401), wrong.join(','))
r = await post('/api/admin/login', { password: PW }, { ip: ATT })
ok('6번째는 맞는 비밀번호여도 429 (IP 잠금)', r.status === 429 && r.data?.reason === 'locked', JSON.stringify(r.data))
r = await post('/api/admin/login', { password: PW }, { origin: 'http://evil.example' })
ok('로그인: 다른 출처 → 403', r.status === 403)
r = await post('/api/admin/login', { password: PW }, { origin: null })
ok('로그인: Origin · Sec-Fetch-Site 없음 → 403', r.status === 403)
r = await post('/api/admin/login', `password=${PW}`, { type: 'application/x-www-form-urlencoded' })
ok('로그인: JSON 아닌 본문 → 400', r.status === 400)
r = await post('/api/admin/login', { password: 12345 })
ok('로그인: 비밀번호가 글자가 아님 → 401', r.status === 401)

r = await post('/api/admin/login', { password: PW })
const C = cookieOf(r)
const sc = r.headers.get('set-cookie') ?? ''
ok('로그인 성공', r.status === 200 && r.data?.ok && C.startsWith('shrine_admin='), sc.slice(0, 60))
ok('세션 쿠키: HttpOnly · SameSite=Strict · Path=/ · 8시간', /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc) && /Path=\/;/.test(sc) && /Max-Age=28800/.test(sc))
ok('세션 쿠키: localhost(127.0.0.1)에서는 Secure 없음', !/Secure/.test(sc))
// Host가 localhost가 아니면 Secure
const secureCookie = await new Promise(resolve => {
  const body = JSON.stringify({ password: PW })
  const rq = request({ host: '127.0.0.1', port: PORT, path: '/api/admin/login', method: 'POST', headers: { Host: 'shrine.example.com', Origin: 'http://shrine.example.com', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Forwarded-For': ADMIN_IP } }, res => {
    res.resume()
    resolve(String(res.headers['set-cookie'] ?? ''))
  })
  rq.end(body)
})
ok('세션 쿠키: localhost가 아니면 Secure', /; Secure/.test(secureCookie), secureCookie.slice(-60))

/* 세션 필요 */
ok('세션 없이 읽기 → 401', (await get('/api/admin/dashboard')).status === 401)
ok('세션 없이 쓰기 → 401', (await post('/api/admin/shrine/move', { slug: 'x', plot: 1 })).status === 401)
const tampered = C.slice(0, -3) + (C.endsWith('AAA') ? 'BBB' : 'AAA')
ok('서명이 틀린 쿠키 → 401', (await get('/api/admin/dashboard', { cookie: tampered })).status === 401)
const forged = `shrine_admin=${Buffer.from(JSON.stringify({ k: 'admin', sid: 'x'.repeat(24), iat: Date.now(), exp: Date.now() + 1e6 })).toString('base64url')}.abc`
ok('지어낸 쿠키 → 401', (await get('/api/admin/dashboard', { cookie: forged })).status === 401)
const ticket = await enter('192.0.2.50')
ok('입장 표 쿠키로는 운영자 아님', (await get('/api/admin/dashboard', { cookie: ticket.replace('shrine_ticket', 'shrine_admin') })).status === 401)

/* 다른 출처 · 형식 */
r = await post('/api/admin/shrine/move', { slug: 'x', plot: 1 }, { cookie: C, origin: 'http://evil.example' })
ok('다른 출처 쓰기 → 403', r.status === 403 && r.data?.reason === 'origin')
r = await post('/api/admin/shrine/move', { slug: 'x', plot: 1 }, { cookie: C, origin: null })
ok('Origin 없는 쓰기 → 403', r.status === 403)
r = await post('/api/admin/shrine/move', { slug: 'x', plot: 1 }, { cookie: C, origin: null, headers: { 'Sec-Fetch-Site': 'cross-site' } })
ok('Sec-Fetch-Site cross-site → 403', r.status === 403)
r = await post('/api/admin/shrine/move', { slug: 'x', plot: 1 }, { cookie: C, origin: null, headers: { 'Sec-Fetch-Site': 'same-origin' } })
ok('Origin 없어도 Sec-Fetch-Site same-origin이면 통과 (없는 사당 → 404)', r.status === 404, JSON.stringify(r.data))
r = await post('/api/admin/shrine/move', 'slug=x&plot=1', { cookie: C, type: 'text/plain' })
ok('JSON 아닌 쓰기 → 400', r.status === 400)
r = await post('/api/admin/shrine/move', { slug: 'x', pad: 'a'.repeat(9000) }, { cookie: C })
ok('8KB 넘는 본문 → 400', r.status === 400)
r = await req('PUT', '/api/admin/shrine/move', { cookie: C, body: { slug: 'x' } })
ok('POST 아닌 쓰기 → 404', r.status === 404)
ok('GET으로 쓰기 못 함', (await get('/api/admin/shrine/remove?slug=x', { cookie: C })).status === 404)

/* 로그인한 화면 */
r = await get('/admin', { cookie: C })
ok('/admin (로그인 뒤) → 운영 화면', r.status === 200 && r.text.includes('/admin/app.js') && r.text.includes('id="nav"'))
ok('로그인 뒤 app.js 받음', (await get('/admin/app.js', { cookie: C })).status === 200)

/* 대시보드 */
r = await get('/api/admin/dashboard', { cookie: C })
ok('대시보드', r.status === 200 && r.data?.channels?.length === 3 && 'npc' in r.data.channels[0] && 'n' in r.data.channels[0] && typeof r.data.candles?.today === 'number' && typeof r.data.candles?.week === 'number', JSON.stringify(r.data).slice(0, 200))
ok('대시보드: 빈 맵 (사당 0 · 빈 자리 채널마다 20 = 60)', r.data?.shrines?.total === 0 && r.data?.shrines?.free === 60 && r.data?.shrines?.plots === 60 && r.data?.shrines?.freeByChannel?.[1] === 20)

/* ═══ 3. 등록소 접수 승인 · 반려 ═══ */

const submit = async (n, extra = {}) => {
  const ck = await enter(`10.0.0.${n}`)
  const res = await req('POST', '/api/submit', { cookie: ck, ip: `10.0.0.${n}`, body: { name: `프로젝트 ${n}`, tagline: `시험 프로젝트 ${n}번`, category: 'devtools', github: `https://github.com/test-owner/repo-${n}`, email: `owner${n}@example.com`, emailPublic: false, pin: '123456', consent: true, ...extra } })
  return { id: res.data?.id, ck, res }
}
const p1 = await submit(1, { plot: 5 })
const p2 = await submit(2)
const p3 = await submit(3)
ok('공개 접수 3건', [p1, p2, p3].every(p => Number.isInteger(p.id)), JSON.stringify(p3.res.data))

r = await get('/api/admin/projects?filter=pending', { cookie: C })
ok('접수 목록 (새 접수 3건)', r.status === 200 && r.data.projects.length === 3, r.data?.projects?.length)
ok('목록에는 이메일 · PIN · 코드 없음', r.data.projects.every(p => !('email' in p) && !('pin_hash' in p) && !('code' in p) && !('pinHash' in p)))
ok('잘못된 거르기 → 400', (await get('/api/admin/projects?filter=bogus', { cookie: C })).status === 400)
r = await get(`/api/admin/project?id=${p1.id}`, { cookie: C })
ok('자세히: 비공개 이메일 보임 (운영자만)', r.status === 200 && r.data.project.email === 'owner1@example.com' && r.data.project.emailPublic === false && !JSON.stringify(r.data).includes('pin'), JSON.stringify(r.data.project).slice(0, 120))
ok('자세히: 원하는 자리 5', r.data.project.wantPlot === 5)
ok('없는 접수 → 404', (await get('/api/admin/project?id=99999', { cookie: C })).status === 404)

r = await post('/api/admin/project/approve', { id: p1.id }, { cookie: C })
ok('승인 (자리 안 고름 → 원하는 자리 5)', r.status === 200 && /자리 5/.test(r.data.message) && r.data.project.status === 'approved', JSON.stringify(r.data).slice(0, 160))
const slug1 = r.data.project.slug
r = await post('/api/admin/project/approve', { id: p2.id, plot: 7 }, { cookie: C })
ok('승인 (자리 7 고름)', r.status === 200 && /자리 7/.test(r.data.message), r.data?.message)
const slug2 = r.data.project.slug
r = await post('/api/admin/project/approve', { id: p3.id, plot: 7 }, { cookie: C })
ok('이미 찬 자리로 승인 → 409', r.status === 409 && /이미 사당이 있는 자리/.test(r.data.message), r.data?.message)
r = await post('/api/admin/project/reject', { id: p3.id, note: '링크가 열리지 않습니다' }, { cookie: C })
ok('반려 + 사유', r.status === 200 && r.data.project.status === 'rejected' && r.data.project.note === '링크가 열리지 않습니다', JSON.stringify(r.data).slice(0, 160))
r = await post('/api/admin/project/approve', { id: p3.id }, { cookie: C })
ok('반려된 접수 다시 승인 → 409', r.status === 409)
r = await post('/api/admin/project/reject', { id: p3.id, note: 'x'.repeat(81) }, { cookie: C })
ok('사유 80자 넘음 → 400', r.status === 400)
let w = await world()
ok('승인한 두 사당이 맵에 (5 · 7번)', w.shrines.some(s => s.slug === slug1 && s.plot === 5) && w.shrines.some(s => s.slug === slug2 && s.plot === 7))

// 링크 변경 검토: 승인 / 반려
r = await req('POST', '/api/manage/save', { cookie: p1.ck, ip: '10.0.0.1', body: { id: p1.id, pin: '123456', url: 'https://changed-one.example.com' } })
ok('작성자가 링크 변경 → 검토 대기', r.status === 200 && r.data.linkReview === true, JSON.stringify(r.data).slice(0, 120))
r = await get('/api/admin/projects?filter=changes', { cookie: C })
ok('변경 검토 목록에 1건', r.data.projects.length === 1 && r.data.projects[0].id === p1.id && r.data.projects[0].changes === true)
r = await post('/api/admin/project/approve', { id: p1.id }, { cookie: C })
ok('링크 변경 승인', r.status === 200 && /링크 변경을 승인/.test(r.data.message), r.data?.message)
w = await world()
ok('맵 사당에 새 주소 반영', w.shrines.find(s => s.slug === slug1)?.domain === 'changed-one.example.com')
r = await req('POST', '/api/manage/save', { cookie: p2.ck, ip: '10.0.0.2', body: { id: p2.id, pin: '123456', url: 'https://bad-two.example.com' } })
r = await post('/api/admin/project/reject', { id: p2.id, note: '주소 확인 안 됨' }, { cookie: C })
ok('링크 변경 반려 (사당은 그대로)', r.status === 200 && /변경을 반려/.test(r.data.message) && r.data.project.pendingUrl === null && r.data.project.status === 'approved', r.data?.message)
// 이미지 변경 검토
const upPub = await req('POST', '/api/upload', { cookie: p2.ck, ip: '10.0.0.2', type: 'image/png', body: png(64, 40) })
r = await req('POST', '/api/manage/save', { cookie: p2.ck, ip: '10.0.0.2', body: { id: p2.id, pin: '123456', screen: upPub.data?.id } })
ok('작성자가 이미지 변경 → 검토 대기', r.data?.linkReview === true, JSON.stringify(r.data).slice(0, 100))
r = await post('/api/admin/project/approve', { id: p2.id }, { cookie: C })
ok('이미지 변경 승인', r.status === 200 && /이미지 변경을 승인/.test(r.data.message), r.data?.message)
w = await world()
ok('맵 사당에 새 이미지', JSON.stringify(w.shrines.find(s => s.slug === slug2)?.screens) === JSON.stringify([`up/${upPub.data.id}`]))

/* ═══ 4. 사당 추가 · 고치기 · 옮기기 · 내리기 ═══ */

r = await post('/api/admin/upload', { data: png(320, 180).toString('base64') }, { cookie: C })
ok('운영자 이미지 올리기 (base64 JSON)', r.status === 201 && /^[A-Za-z0-9_-]{16}\.png$/.test(r.data.id), JSON.stringify(r.data))
const img1 = r.data.id
r = await post('/api/admin/upload', { data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64') }, { cookie: C })
ok('가짜 이미지 → type', r.status === 400 && r.data.reason === 'type')
r = await post('/api/admin/upload', { data: 'not base64!!' }, { cookie: C })
ok('base64 아님 → 400', r.status === 400)
r = await post('/api/admin/upload', { data: png(32, 32).toString('base64') }, { cookie: C, origin: 'http://evil.example' })
ok('다른 출처 이미지 올리기 → 403', r.status === 403)

const addBody = { name: '운영 사당', tagline: '운영자가 직접 세운 사당', category: 'productivity', url: 'https://ops-shrine.example.com', operator: '기원소', prayer: 'uptime', status: 'live', plot: 0, screen: img1 }
r = await post('/api/admin/shrine/add', { ...addBody, screen: '' }, { cookie: C })
ok('이미지 없이 추가 → 400', r.status === 400 && /이미지/.test(r.data.message), r.data?.message)
r = await post('/api/admin/shrine/add', { ...addBody, screen: upPub.data.id }, { cookie: C })
ok('남(방문자)이 올린 이미지로 추가 → 400', r.status === 400)
r = await post('/api/admin/shrine/add', { ...addBody, plot: 5 }, { cookie: C })
ok('찬 자리에 추가 → 409', r.status === 409, r.data?.message)
r = await post('/api/admin/shrine/add', { ...addBody, url: 'http://127.0.0.1' }, { cookie: C })
ok('IP 주소 링크 → 400', r.status === 400, r.data?.message)
r = await post('/api/admin/shrine/add', { ...addBody, name: '' }, { cookie: C })
ok('이름 없음 → 400', r.status === 400 && /이름/.test(r.data.message))
r = await post('/api/admin/shrine/add', { ...addBody, category: 'nope' }, { cookie: C })
ok('없는 분류 → 400', r.status === 400)
r = await post('/api/admin/shrine/add', { ...addBody, slug: 'Bad Slug!' }, { cookie: C })
ok('잘못된 slug → 400', r.status === 400)
r = await post('/api/admin/shrine/add', addBody, { cookie: C })
ok('사당 추가 (자리 0)', r.status === 201 && r.data.shrine.plot === 0 && r.data.shrine.slug && r.data.shrine.projectId === 0, JSON.stringify(r.data).slice(0, 200))
const slugA = r.data.shrine.slug
w = await world()
const sa = w.shrines.find(s => s.slug === slugA)
ok('추가한 사당이 바로 맵에', !!sa && sa.plot === 0 && sa.screens[0] === `up/${img1}` && sa.operator === '기원소')
ok('맵에 올린 이미지 받아짐', (await fetch(`${B}/img/shrines/up/${img1}`)).status === 200)
r = await post('/api/admin/shrine/add', { ...addBody, plot: 1, name: '같은 주소' }, { cookie: C })
ok('같은 도메인으로 또 추가 → 409', r.status === 409, r.data?.message)
r = await post('/api/admin/upload', { data: png(200, 120, [200, 60, 60]).toString('base64') }, { cookie: C })
const img2 = r.data.id
r = await post('/api/admin/shrine/add', { name: 'GitHub만', tagline: '저장소만 있는 사당', category: 'devtools', github: 'https://github.com/test-owner/only-repo', screen: img2 }, { cookie: C })
ok('GitHub만 있는 사당 추가 (자리 자동 → 첫 빈 자리 1)', r.status === 201 && r.data.shrine.plot === 1 && r.data.shrine.domain === 'github.com/test-owner/only-repo', JSON.stringify(r.data).slice(0, 160))
const slugB = r.data.shrine.slug

r = await post('/api/admin/shrine/update', { slug: slugA, name: '고친 사당', tagline: '이름과 소개를 고쳤습니다', sign: '고침', status: 'check' }, { cookie: C })
ok('고치기: 이름 · 소개 · 지붕 · 상태', r.status === 200 && r.data.changed.join(',') === 'name,tagline,sign,status', JSON.stringify(r.data.changed))
w = await world()
const sa2 = w.shrines.find(s => s.slug === slugA)
ok('고친 내용이 바로 맵에 (닫힘)', sa2?.name === '고친 사당' && sa2.status === 'check' && sa2.sign === '고침')
r = await post('/api/admin/shrine/update', { slug: slugA, url: 'https://moved-domain.example.com' }, { cookie: C })
ok('고치기: 링크 → 도메인 바뀜', r.status === 200 && r.data.shrine.domain === 'moved-domain.example.com' && r.data.changed.includes('domain'))
r = await post('/api/admin/shrine/update', { slug: slugA, url: 'https://changed-one.example.com' }, { cookie: C })
ok('고치기: 다른 사당 주소 → 409', r.status === 409, r.data?.message)
r = await post('/api/admin/shrine/update', { slug: slugA, tagline: '가'.repeat(41) }, { cookie: C })
ok('고치기: 소개 40자 넘음 → 400', r.status === 400)
r = await post('/api/admin/shrine/update', { slug: slugA, status: 'closed' }, { cookie: C })
ok('고치기: 없는 상태 → 400', r.status === 400)
r = await post('/api/admin/shrine/update', { slug: slugA, name: '고친 사당' }, { cookie: C })
ok('고치기: 바뀐 것 없음 → changed 빈 배열', r.status === 200 && r.data.changed.length === 0)
r = await post('/api/admin/shrine/update', { slug: slug1, name: '운영자가 고친 이름' }, { cookie: C })
const pAfter = await get(`/api/admin/project?id=${p1.id}`, { cookie: C })
ok('등록소 사당을 고치면 접수 기록도 같이', r.status === 200 && pAfter.data.project.name === '운영자가 고친 이름')
r = await post('/api/admin/upload', { data: png(160, 90, [10, 200, 90]).toString('base64') }, { cookie: C })
const img3 = r.data.id
r = await post('/api/admin/shrine/update', { slug: slugA, screen: img3 }, { cookie: C })
ok('고치기: 이미지 바꾸기', r.status === 200 && r.data.changed.includes('screens') && r.data.shrine.screens[0] === `up/${img3}`)

r = await post('/api/admin/shrine/move', { slug: slugA, plot: 12 }, { cookie: C })
ok('옮기기 0 → 12', r.status === 200 && r.data.shrine.plot === 12)
w = await world()
ok('옮긴 자리가 맵에', w.shrines.find(s => s.slug === slugA)?.plot === 12)
r = await post('/api/admin/shrine/move', { slug: slugA, plot: 7 }, { cookie: C })
ok('찬 자리로 옮기기 → 409', r.status === 409)
r = await post('/api/admin/shrine/move', { slug: slugA, plot: 99 }, { cookie: C })
ok('없는 자리로 옮기기 → 400', r.status === 400)

r = await get('/api/admin/shrines', { cookie: C })
ok('사당 목록 (4곳 · 채널 1 빈 자리 16 · 채널 2 · 3은 20)', r.status === 200 && r.data.shrines.length === 4 && r.data.freePlots[1].length === 16 && r.data.freePlots[2].length === 20 && r.data.freePlots[3].length === 20 && r.data.shrines.every(s => Array.isArray(s.errors) && s.channel === 1), `${r.data?.shrines?.length} / ${JSON.stringify(r.data?.freePlots)}`)

r = await post('/api/admin/shrine/remove', { slug: slugB, note: '시험 끝' }, { cookie: C })
ok('내리기 (직접 넣은 사당)', r.status === 200)
r = await post('/api/admin/shrine/remove', { slug: slug2, note: '규칙 위반' }, { cookie: C })
const p2After = await get(`/api/admin/project?id=${p2.id}`, { cookie: C })
ok('내리기 (등록소 사당 → 접수는 반려 · 사유 남음)', r.status === 200 && p2After.data.project.status === 'rejected' && p2After.data.project.note === 'removed: 규칙 위반', JSON.stringify(p2After.data.project).slice(0, 140))
w = await world()
ok('내린 사당은 맵에서 빠짐', !w.shrines.some(s => s.slug === slugB || s.slug === slug2))
ok('없는 사당 내리기 → 404', (await post('/api/admin/shrine/remove', { slug: slugB }, { cookie: C })).status === 404)

/* ═══ 5. 게시판 글 숨기기 · 보이기 · 지우기 ═══ */

const now = Date.now()
const ins = async (...v) => Number((await D.sqlGet(DATA, 'INSERT INTO posts (at, topic, text, nick) VALUES (?, ?, ?, ?) RETURNING id', v)).id)
const postA = await ins(now - 60_000, 'claude', '오늘 배포 무사히 끝났어요', '새벽의 러버덕 12')
const postB = await ins(now - 30_000, 'gpt', '신고받은 글입니다 <img src=x onerror=alert(1)>', '야근하는 고양이 33')
const postC = await ins(now, 'etc', '가장 새 글', '커밋하는 서버 50')
await D.sql(DATA, 'INSERT INTO post_reports (post_id, reporter) VALUES (?, ?)', [postB, 'r1'])
await D.sql(DATA, 'INSERT INTO post_reports (post_id, reporter) VALUES (?, ?)', [postB, 'r2'])
r = await get('/api/admin/posts', { cookie: C })
ok('글 목록: 신고된 글이 먼저', r.status === 200 && r.data.posts[0].id === postB && r.data.posts[0].reports === 2 && r.data.posts[1].id === postC, r.data?.posts?.map(p => `${p.id}:${p.reports}`).join(' '))
r = await post('/api/admin/post/hide', { id: postB }, { cookie: C })
let pub = await (await fetch(`${B}/api/posts`)).json()
ok('숨기기 → 공개 목록에서 빠짐', r.status === 200 && !pub.posts.some(p => p.id === postB))
r = await post('/api/admin/post/show', { id: postB }, { cookie: C })
pub = await (await fetch(`${B}/api/posts`)).json()
ok('다시 보이기 → 공개 목록에', r.status === 200 && pub.posts.some(p => p.id === postB))
r = await post('/api/admin/post/delete', { id: postA }, { cookie: C })
pub = await (await fetch(`${B}/api/posts`)).json()
ok('지우기 → 사라짐', r.status === 200 && !pub.posts.some(p => p.id === postA))
ok('없는 글 → 404', (await post('/api/admin/post/hide', { id: postA }, { cookie: C })).status === 404)
r = await get('/api/admin/dashboard', { cookie: C })
ok('대시보드: 신고된 글 1 · 사당 2', r.data.posts.reported === 1 && r.data.shrines.total === 2, JSON.stringify(r.data.posts))

/* ═══ 6. 설정 · 기록 ═══ */

r = await get('/api/admin/settings', { cookie: C })
ok('설정 요약', r.status === 200 && r.data.settings.some(s => s.key === 'BASE_PATH') && r.data.settings.some(s => s.key === 'ADMIN_IPS'))
ok('설정에 비밀 값 없음', !r.text.includes(PW) && r.data.settings.find(s => s.key === 'ADMIN_PASSWORD')?.value === '설정됨')

r = await get('/api/admin/log?limit=500', { cookie: C })
const actions = new Set(r.data.log.map(x => x.action))
const want = ['login', 'login-fail', 'upload', 'project-approve', 'project-reject', 'shrine-add', 'shrine-update', 'shrine-move', 'shrine-remove', 'post-hide', 'post-show', 'post-delete']
ok('기록: 모든 작업이 남음', want.every(a => actions.has(a)), want.filter(a => !actions.has(a)).join(','))
ok('기록: IP 해시 16자, 같은 IP는 같은 값', r.data.log.filter(x => x.action === 'shrine-add').every(x => /^[A-Za-z0-9_-]{16}$/.test(x.ip)) && new Set(r.data.log.filter(x => x.action !== 'login-fail').map(x => x.ip)).size <= 2)
const rawRows = JSON.stringify(await D.sql(DATA, 'SELECT * FROM admin_log'))
ok('기록: IP 원문 · 비밀번호는 DB에 없음', !rawRows.includes(ADMIN_IP) && !rawRows.includes(ATT) && !rawRows.includes(PW))
ok('기록: 실패 시도(검사 전 거절)는 안 늘어남', r.data.log.filter(x => x.action === 'login-fail').length === 6, r.data.log.filter(x => x.action === 'login-fail').length)
ok('기록: 대상 · 내용', r.data.log.some(x => x.action === 'shrine-move' && x.target === slugA && x.detail === '0 → 12'))

/* ═══ 7. 운영 도구(cli)도 같은 함수로 ═══ */

const cliEnv = baseEnv({})
const cli = (...args) => D.cli(args, { env: cliEnv })
let c = cli('move', slugA, '3')
ok('cli move', c.status === 0 && /12 → 3/.test(c.stdout), c.stdout + c.stderr)
c = cli('move', slugA, '5')
ok('cli move 찬 자리 → 실패', c.status === 1 && /이미 사당이 있는 자리/.test(c.stderr), c.stderr)
c = cli('status', slugA, 'live')
ok('cli status', c.status === 0, c.stderr)
c = cli('status', 'no-such-shrine', 'live')
ok('cli status 없는 사당 → 실패', c.status === 1 && /없는 사당/.test(c.stderr), c.stderr)
c = cli('list')
ok('cli list', c.status === 0 && c.stdout.includes(slugA), c.stdout)

/* 화면 사진을 위한 거리: 새 접수 1 · 변경 검토 1 · 사당 몇 곳 더 */
const p4 = await submit(4, { name: '배포 체크봇', tagline: 'PR마다 배포 체크리스트를 달아 주는 봇', plot: 16, url: 'https://deploy-check.example.dev', emailPublic: true })
const p5 = await submit(5, { name: '야근 타이머', tagline: '퇴근 시간을 알려 주는 메뉴바 앱' })
await post('/api/admin/project/approve', { id: p5.id, plot: 9 }, { cookie: C })
await req('POST', '/api/manage/save', { cookie: p5.ck, ip: '10.0.0.5', body: { id: p5.id, pin: '123456', url: 'https://overtime-timer.example.app' } })
for (const [i, nm, tg, plot] of [[6, '커밋 요정', '커밋 메시지를 다듬어 주는 CLI', 14], [7, '로그 뷰어', '서버 로그를 한눈에', 18]]) {
  const up = await post('/api/admin/upload', { data: png(320, 180, [i * 30, 90, 160]).toString('base64') }, { cookie: C })
  await post('/api/admin/shrine/add', { name: nm, tagline: tg, category: 'devtools', github: `https://github.com/test-owner/shot-${i}`, screen: up.data.id, plot }, { cookie: C })
}
const shotSlug = (await get('/api/admin/shrines', { cookie: C })).data.shrines.find(s => s.name === '커밋 요정')?.slug

/* ═══ 8. 화면 사진 (headless Edge) ═══ */

const consoleErrors = []
if (D.BROWSER) {
  const prof = join(D.RUN_DIR, `edge-prof-${Date.now()}`)
  const edge = D.trackProcess(spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,1100', 'about:blank'], { stdio: 'ignore' }))
  try {
    let targets = []
    for (let i = 0; i < 60; i++) {
      try { targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); if (targets.some(t => t.type === 'page')) break } catch {}
      await sleep(250)
    }
    const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl)
    await new Promise(res => ws.addEventListener('open', res))
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(`EXC ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`)
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(`ERR ${m.params.args.map(a => a.value ?? a.description).join(' ')}`)
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleErrors.push(`LOG ${m.params.entry.source}: ${m.params.entry.text} ${m.params.entry.url ?? ''}`)
    })
    const cmd = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    const evalJs = async expr => (await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
    const shot = async name => writeFileSync(`${SHOTS}/${name}.png`, Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'))
    const view = async (w, h, mobile = false) => cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile })
    const go = async (hash, wait = 900) => { await evalJs(`location.hash = ${JSON.stringify(hash)}; true`); await sleep(wait) }
    await cmd('Runtime.enable'); await cmd('Page.enable'); await cmd('Log.enable')
    await view(1280, 1000)
    await cmd('Page.navigate', { url: `${B}/admin` })
    await sleep(1200)
    await shot('a0-login')
    ok('화면: 로그인 화면이 뜸', await evalJs(`!!document.querySelector('#loginForm')`))
    await evalJs(`(() => { document.querySelector('#password').value = 'wrong-password-browser'; document.querySelector('#loginForm').requestSubmit(); return true })()`)
    await sleep(800)
    ok('화면: 틀린 비밀번호 안내', (await evalJs(`document.querySelector('#loginMsg').textContent`)) === '비밀번호가 맞지 않습니다.')
    await evalJs(`(() => { document.querySelector('#password').value = ${JSON.stringify(PW)}; document.querySelector('#loginForm').requestSubmit(); return true })()`)
    await sleep(2000)
    ok('화면: 로그인 뒤 대시보드', (await evalJs(`document.querySelector('.adm-head h1')?.textContent`)) === '대시보드')
    ok('화면: 쿠키는 스크립트에서 안 보임 (HttpOnly)', (await evalJs(`document.cookie.includes('shrine_admin')`)) === false)
    await shot('a1-dashboard')
    await view(1280, 1250)
    await go(`#projects?f=review&id=${p4.id}`, 1500)
    ok('화면: 접수 자세히 (비공개 이메일)', (await evalJs(`document.querySelector('.detail')?.textContent.includes('owner4@example.com')`)) === true)
    await shot('a2-projects')
    await go(`#projects?f=changes&id=${p5.id}`, 1200)
    await shot('a3-changes')
    await go(`#shrines?edit=${shotSlug}`, 1500)
    ok('화면: 사당 고치기 창', (await evalJs(`!!document.querySelector('.detail form.shrine-form')`)) === true)
    await shot('a4-shrines-edit')
    await go('#shrines?add=1', 1200)
    await shot('a5-shrines-add')
    // 화면에서 사당 하나 추가해 보기 (이미지 고르기 → 올리기 → 세우기)
    const added = await evalJs(`(async () => {
      const f = document.querySelector('form.shrine-form')
      const set = (n, v) => { f.querySelector('[name=' + n + ']').value = v }
      set('name', '화면 사당'); set('tagline', '운영 화면에서 세운 사당'); set('url', 'https://ui-made.example.com')
      const cv = document.createElement('canvas'); cv.width = 200; cv.height = 120
      const c = cv.getContext('2d'); c.fillStyle = '#3a7'; c.fillRect(0, 0, 200, 120)
      const blob = await new Promise(r => cv.toBlob(r, 'image/png'))
      const dt = new DataTransfer(); dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }))
      const input = f.querySelector('input[type=file]'); input.files = dt.files; input.dispatchEvent(new Event('change'))
      f.querySelector('.rplot-map button:not(:disabled)').click()
      f.requestSubmit()
      await new Promise(r => setTimeout(r, 2500))
      return location.hash
    })()`)
    ok('화면: 사당 추가 → 고치기 화면으로', /^#shrines\?edit=/.test(added ?? ''), added)
    await go('#posts', 1200)
    await shot('a6-posts')
    ok('화면: 글 내용은 글자로만 (img 태그 안 생김)', (await evalJs(`document.querySelectorAll('.post-list img').length === 0 && document.querySelector('.post-list').textContent.includes('<img src=x')`)) === true)
    await go('#settings', 900)
    await shot('a7-settings')
    await go('#log', 900)
    await shot('a8-log')
    await view(390, 844, true)
    await go('#dashboard', 1200)
    await shot('m1-dashboard')
    await go(`#shrines?edit=${shotSlug}`, 1500)
    await shot('m2-shrines')
    await view(1280, 1000)
    await evalJs(`document.querySelector('#logoutBtn').click(); true`)
    await sleep(1500)
    ok('화면: 로그아웃 → 로그인 화면', (await evalJs(`!!document.querySelector('#loginForm')`)) === true)
    ws.close()
  } finally {
    edge.kill()
    await sleep(500)
    rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
  ok('화면: 콘솔 오류 · CSP 위반 없음', consoleErrors.filter(e => !/status of 401/.test(e)).length === 0, consoleErrors.join(' | '))
}

/* ═══ 9. 로그아웃 ═══ */

r = await post('/api/admin/logout', {}, { cookie: C })
ok('로그아웃: 쿠키 지움', r.status === 200 && /Max-Age=0/.test(r.headers.get('set-cookie') ?? ''))
ok('로그아웃한 세션 쿠키 → 401', (await get('/api/admin/dashboard', { cookie: C })).status === 401)
await stop()

/* ═══ 10. 전체 실패 상한 (허용 IP 없이 · 여러 IP에서 50번) ═══ */

await start({ ADMIN_PASSWORD: PW })
for (let i = 0; i < 10; i++) for (let j = 0; j < 5; j++) await post('/api/admin/login', { password: 'nope-nope-nope-nope' }, { ip: `172.16.0.${i + 1}` })
r = await post('/api/admin/login', { password: PW }, { ip: '172.16.9.9' })
ok('전체 15분 50번 실패 → 새 IP도 잠김 (429)', r.status === 429 && r.data.reason === 'locked', `${r.status} ${JSON.stringify(r.data)}`)
await stop()

/* ═══ 11. BASE_PATH=/shrine ═══ */

await start({ ADMIN_PASSWORD: PW, BASE_PATH: '/shrine' })
r = await get('/shrine/admin')
ok('BASE_PATH: /shrine/admin 로그인 화면 (경로 앞부분 붙음)', r.status === 200 && r.text.includes('/shrine/admin/login.js') && r.text.includes('/shrine/admin/admin.css'))
ok('BASE_PATH: /admin(앞부분 없이) → 404', (await get('/admin')).status === 404)
r = await post('/shrine/api/admin/login', { password: PW })
const C2 = cookieOf(r)
ok('BASE_PATH: 쿠키 Path=/shrine/', r.status === 200 && /Path=\/shrine\/;/.test(r.headers.get('set-cookie') ?? ''))
r = await get('/shrine/api/admin/dashboard', { cookie: C2 })
ok('BASE_PATH: 대시보드', r.status === 200 && r.data.ok)
r = await get('/shrine/admin', { cookie: C2 })
ok('BASE_PATH: 운영 화면 + 앱 코드', r.text.includes('/shrine/admin/app.js') && (await get('/shrine/admin/app.js', { cookie: C2 })).status === 200)
ok('BASE_PATH: 앱이 가져다 쓰는 공개 파일', (await get('/shrine/js/data.js')).status === 200 && (await get('/shrine/js/pixels.js')).status === 200)
await stop()

await T.done()
