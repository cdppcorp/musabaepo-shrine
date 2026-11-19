// 등록소 이미지 올리기 시험 (자체 서버 3343, 도메인 루트 방식, GitHub 확인 끔)
//   SHRINE_TARGET=node|py node tests/conformance/upload.test.mjs
import { crc32, deflateSync } from 'node:zlib'
import * as D from './driver.mjs'
import { suite } from './lib/check.mjs'
const DATA = await D.freshDataDir('upload')
const PORT = D.PORTS.upload
const B = `http://127.0.0.1:${PORT}`
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, GITHUB_CHECK: 'off', BASE_PATH: '' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const T = suite('upload')
const ok = T.ok

let srv = await D.startServer(env)

function png(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
async function enter() {
  const r = await fetch(`${B}/api/enter`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: B }, body: JSON.stringify({ look: [0, 1, 0, 0, 1, 1, 1, 2, 0, 0, 0, 0] }) })
  return (r.headers.get('set-cookie') || '').split(';')[0]
}
const post = async (ck, path, body, type = 'application/json') => {
  const r = await fetch(`${B}${path}`, { method: 'POST', headers: { 'Content-Type': type, Origin: B, Cookie: ck }, body: type === 'application/json' ? JSON.stringify(body) : body })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
const cli = (...args) => D.cli(args, { env })

const A = await enter()
const C = await enter()
let r = await post(A, '/api/upload', png(64, 36), 'image/png')
ok('PNG 올리기', r.status === 201 && /^[A-Za-z0-9_-]{16}\.png$/.test(r.id ?? ''), JSON.stringify(r))
const imgA = r.id
r = await fetch(`${B}/img/shrines/up/${imgA}`, { headers: { Cookie: A } })
ok('올린 사람은 미리 보기 (캐시 금지)', r.status === 200 && r.headers.get('content-type') === 'image/png' && r.headers.get('cache-control') === 'private, no-store', r.headers.get('cache-control'))
r = await fetch(`${B}/img/shrines/up/${imgA}`)
ok('승인 전: 입장 표 없이 → 404', r.status === 404, r.status)
r = await post(A, '/api/upload', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/png')
ok('가짜 이미지(SVG) → type', r.status === 400 && r.reason === 'type', JSON.stringify(r))
r = await post(A, '/api/upload', Buffer.alloc(11 * 1024 * 1024, 1), 'image/png').catch(() => ({ status: 413, reason: 'size' }))
ok('10MB 넘는 파일 → size', r.status === 413, JSON.stringify(r))
r = await fetch(`${B}/api/upload`, { method: 'POST', headers: { 'Content-Type': 'image/png', Origin: B }, body: png(32, 32) })
ok('입장 표 없이 → 401', r.status === 401)
r = await post(C, '/api/upload', png(40, 40), 'image/png')
const imgC = r.id
r = await fetch(`${B}/img/shrines/up/${imgA}`, { headers: { Cookie: C } })
ok('승인 전: 다른 사람(입장 표) → 404', r.status === 404, r.status)

const base = { name: '이미지 봇', tagline: '이미지가 있는 프로젝트', category: 'devtools', github: 'https://github.com/nodejs/node', email: 'img@example.com', emailPublic: false, pin: '246810', consent: true }
r = await post(A, '/api/submit', { ...base, screen: imgC })
ok('남이 올린 이미지로 접수 → image', r.status === 400 && r.reason === 'image', JSON.stringify(r))
r = await post(A, '/api/submit', { ...base, screen: imgA })
ok('내 이미지로 접수', r.status === 201 && r.ok, JSON.stringify(r))
const pid = r.id
r = await post(A, '/api/manage/get', { id: pid, pin: '246810' })
ok('관리: 이미지 보임', r.project?.screen === imgA, JSON.stringify(r.project?.screen))
r = await post(A, '/api/manage/find', { email: 'IMG@example.com', pin: '246810' })
ok('이메일 + 비밀번호로 찾기 (대소문자 무시)', r.ok && r.projects?.length === 1 && r.projects[0].id === pid, JSON.stringify(r))
r = await post(A, '/api/manage/find', { email: 'img@example.com', pin: '111111' })
ok('비밀번호 틀리면 pin', r.status === 403 && r.reason === 'pin', JSON.stringify(r))
r = await post(A, '/api/manage/find', { email: 'nobody@example.com', pin: '246810' })
ok('없는 이메일도 똑같이 pin', r.status === 403 && r.reason === 'pin', JSON.stringify(r))

let out = cli('approve', String(pid))
ok('운영자 승인', /승인했습니다/.test(out.stdout), out.stdout.trim() || out.stderr.trim())
srv = await D.restartServer(srv)
let w = await (await fetch(`${B}/api/world`)).json()
let sh = w.shrines.find(s => s.fromProject)
ok('사당에 이미지가 실림', sh?.screens?.[0] === `up/${imgA}`, JSON.stringify(sh?.screens))
r = await fetch(`${B}/img/shrines/up/${imgA}`)
ok('승인 뒤: 누구나 받음 (공개 캐시)', r.status === 200 && /^public, max-age=\d+/.test(r.headers.get('cache-control') || ''), r.headers.get('cache-control'))
r = await fetch(`${B}/img/shrines/up/${imgA}`, { headers: { 'If-None-Match': r.headers.get('etag') } })
ok('승인 뒤: ETag → 304', r.status === 304, r.status)

const A2 = await enter()
r = await post(A2, '/api/upload', png(80, 45), 'image/png')
const imgNew = r.id
r = await post(A2, '/api/manage/save', { id: pid, pin: '246810', screen: imgNew })
ok('승인 뒤 새 이미지 → 확인 대기', r.ok && r.linkReview === true && r.project?.pendingScreen === imgNew, JSON.stringify(r))
w = await (await fetch(`${B}/api/world`)).json()
sh = w.shrines.find(s => s.fromProject)
ok('확인 전에는 사당 이미지 그대로', sh?.screens?.[0] === `up/${imgA}`)
ok('검토 대기 새 이미지: 남에게는 404', (await fetch(`${B}/img/shrines/up/${imgNew}`)).status === 404)
ok('검토 대기 새 이미지: 올린 사람은 200', (await fetch(`${B}/img/shrines/up/${imgNew}`, { headers: { Cookie: A2 } })).status === 200)
const A4 = await enter()
ok('검토 대기 새 이미지: 새 입장 표는 비밀번호로 열기 전엔 404', (await fetch(`${B}/img/shrines/up/${imgNew}`, { headers: { Cookie: A4 } })).status === 404)
r = await post(A4, '/api/manage/get', { id: pid, pin: '246810' })
ok('관리 화면: 검토 대기 이미지 이름', r.project?.pendingScreen === imgNew, JSON.stringify(r.project?.pendingScreen))
r = await fetch(`${B}/img/shrines/up/${imgNew}`, { headers: { Cookie: A4 } })
ok('검토 대기 새 이미지: 비밀번호로 연 뒤 200 (캐시 금지)', r.status === 200 && r.headers.get('cache-control') === 'private, no-store', r.status)
out = cli('approve', String(pid))
ok('이미지 변경 승인', /이미지 변경을 승인했습니다/.test(out.stdout), out.stdout.trim() || out.stderr.trim())
srv = await D.restartServer(srv)
w = await (await fetch(`${B}/api/world`)).json()
sh = w.shrines.find(s => s.fromProject)
ok('승인 뒤 새 이미지로 바뀜', sh?.screens?.[0] === `up/${imgNew}`, JSON.stringify(sh?.screens))
ok('승인 뒤 새 이미지는 공개', (await fetch(`${B}/img/shrines/up/${imgNew}`)).status === 200)
ok('바뀌기 전 이미지는 이제 공개 아님', (await fetch(`${B}/img/shrines/up/${imgA}`)).status === 404)
const A3 = await enter()
r = await post(A3, '/api/manage/save', { id: pid, pin: '246810', screen: '' })
w = await (await fetch(`${B}/api/world`)).json()
sh = w.shrines.find(s => s.fromProject)
ok('이미지 지우기는 바로', r.ok && sh && (sh.screens?.length ?? 0) === 0, JSON.stringify(sh?.screens))

await D.stopServer(srv)
await T.done()
