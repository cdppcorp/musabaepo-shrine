// 내 프로젝트 등록소 서버 시험. 자체 서버(3342, 새 DATA_DIR, BASE_PATH=/shrine)를 띄워서 돌립니다.
//   SHRINE_TARGET=node|py node tests/conformance/registry.test.mjs
import { join } from 'node:path'
import * as D from './driver.mjs'
import { suite } from './lib/check.mjs'

const DATA = await D.freshDataDir('registry')
const PORT = D.PORTS.registry
const B = `http://127.0.0.1:${PORT}/shrine`
const ORIGIN = `http://127.0.0.1:${PORT}`
const sleep = ms => new Promise(r => setTimeout(r, ms))
const T = suite('registry')
const ok = T.ok

for (const f of ['a', 'b']) { const r = D.cli(['add', join(D.FIXTURES, 'seed', `${f}.json`)], { env: { ...process.env, DATA_DIR: DATA } }); console.log('seed', f, r.stdout.trim(), r.stderr.trim()) }
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, BASE_PATH: '/shrine' }
let server = null
async function start() {
  server = await D.startServer(env, { ready: '/shrine/' })
  server.proc.stderr.on('data', d => { const t = d.toString(); if (!/개발 모드/.test(t)) process.stderr.write(`[server] ${t}`) })
}
async function stop() {
  if (!server) return
  await D.stopServer(server)
  server = null
}
const cli = (...args) => D.cli(args, { env })

async function enter() {
  const r = await fetch(`${B}/api/enter`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ look: [0, 1, 0, 0, 1, 1, 1, 2, 0, 0, 0, 0] }) })
  return (r.headers.get('set-cookie') || '').split(';')[0]
}
async function post(path, body, cookie, origin = ORIGIN) {
  const headers = { 'Content-Type': 'application/json' }
  if (origin) headers.Origin = origin
  if (cookie) headers.Cookie = cookie
  const r = await fetch(`${B}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  let data = null
  try { data = await r.json() } catch {}
  return { status: r.status, data }
}
const world = async () => (await (await fetch(`${B}/api/world`)).json())

await start()

// GitHub에 닿는지 (안 닿으면 존재 확인 시험은 건너뜀)
let netOk = false
try { netOk = (await fetch('https://api.github.com/repos/nodejs/node', { headers: { 'User-Agent': 'cdpp-shrine' }, signal: AbortSignal.timeout(3000) })).ok } catch {}
console.log('github reachable:', netOk)

const w0 = await world()
ok('world: registry.open', w0.registry?.open === true)
ok('world: 기존 사당 2곳은 그대로 (repo · fromProject 칸)', w0.shrines.length === 2 && w0.shrines.every(s => s.repo === '' && s.fromProject === false && !('email' in s) && !('url' in s)))

const A = await enter()
const base = { name: '데모 프로젝트', tagline: '등록소 시험용 프로젝트', category: 'devtools', github: 'https://github.com/nodejs/node', email: 'Dev@Example.com', emailPublic: true, pin: '123456', consent: true }
ok('표 없이 접수 → 401 ticket', (await post('/api/submit', base, '')).data?.reason === 'ticket')
ok('다른 출처 → 403 origin', (await post('/api/submit', base, A, 'http://evil.example')).data?.reason === 'origin')
const bad = [
  ['name', { name: '' }], ['name', { name: 'seed-one.example.com 최고' }], ['word', { name: '시발 프로젝트' }],
  ['tagline', { tagline: '가'.repeat(41) }], ['contact', { tagline: '카톡 주세요' }], ['category', { category: 'x' }],
  ['link', { github: '', url: '' }], ['github', { github: 'https://gitlab.com/a/b' }], ['url', { github: '', url: 'http://plain.example' }],
  ['url', { github: '', url: 'https://127.0.0.1' }], ['email', { email: 'nope' }], ['pin', { pin: '12a4' }], ['pin', { pin: '123' }],
  ['consent', { consent: false }], ['consent', { consent: 'true' }], ['consent', { consent: undefined }],
]
for (const [reason, patch] of bad) {
  const r = await post('/api/submit', { ...base, ...patch }, A)
  ok(`잘못된 접수 → ${reason}`, r.status >= 400 && r.data?.reason === reason, `${r.status} ${JSON.stringify(patch).slice(0, 50)}`)
}
const sa = await post('/api/submit', base, A)
ok('접수 성공 (201 · 접수 코드)', sa.status === 201 && sa.data?.ok && typeof sa.data.code === 'string' && sa.data.code.length >= 16, JSON.stringify(sa.data))
const idA = sa.data?.id
const codeA = sa.data?.code
ok('같은 사람 바로 또 → slow', (await post('/api/submit', { ...base, github: '', url: 'https://other-demo.dev' }, A)).data?.reason === 'slow')

const Bt = await enter()
ok('같은 저장소 → dup', (await post('/api/submit', { ...base, github: 'github.com/NodeJS/node.git' }, Bt)).data?.reason === 'dup')
ok('기존 사당 도메인 → dup', (await post('/api/submit', { ...base, github: '', url: 'https://seed-one.example.com/about' }, Bt)).data?.reason === 'dup')
if (netOk) ok('없는 저장소 → github', (await post('/api/submit', { ...base, github: 'https://github.com/nodejs/this-repo-does-not-exist-zz9' }, Bt)).data?.reason === 'github')
const sb = await post('/api/submit', { ...base, name: '서비스만', github: '', url: 'example-demo-shrine.dev/', email: 'b@example.com', emailPublic: false, pin: '000000' }, Bt)
ok('서비스 주소만 접수 (https 붙임)', sb.status === 201, JSON.stringify(sb.data))
const idB = sb.data?.id
const Ct = await enter()
const sc = await post('/api/submit', { ...base, name: '세 번째', github: '', url: 'https://third-demo.dev', pin: '111111' }, Ct)
ok('IP당 하루 세 번째 접수까지 됨', sc.status === 201)
const idC = sc.data?.id
const Dt = await enter()
ok('IP당 하루 네 번째 → many', (await post('/api/submit', { ...base, name: '네 번째', github: '', url: 'https://fourth-demo.dev' }, Dt)).data?.reason === 'many')

const st = await (await fetch(`${B}/api/submit/${codeA}`)).json()
ok('접수 코드로 상태 보기', st.ok && st.status === 'pending' && st.id === idA && st.name === '데모 프로젝트', JSON.stringify(st))
ok('없는 접수 코드 → 404', (await fetch(`${B}/api/submit/${'x'.repeat(16)}`)).status === 404)

// PIN: B로 5번 틀리면 잠금
for (let i = 1; i <= 4; i++) {
  const r = await post('/api/manage/get', { id: idB, pin: '999999' }, Bt)
  ok(`PIN 틀림 ${i}번 → pin`, r.status === 403 && r.data?.reason === 'pin')
}
const fifth = await post('/api/manage/get', { id: idB, pin: '999999' }, Bt)
ok('PIN 5번째 틀림 → locked', fifth.data?.reason === 'locked', JSON.stringify(fifth.data))
ok('잠긴 동안 맞는 PIN도 → locked', (await post('/api/manage/get', { id: idB, pin: '000000' }, Bt)).data?.reason === 'locked')
ok('없는 접수 → none', (await post('/api/manage/get', { id: 99999, pin: '123456' }, A)).data?.reason === 'none')
ok('관리도 표 필요', (await post('/api/manage/get', { id: idA, pin: '123456' }, '')).status === 401)

const g = await post('/api/manage/get', { id: idA, pin: '123456' }, A)
ok('맞는 PIN → 내 접수 보기 (이메일 소문자)', g.data?.ok && g.data.project.email === 'dev@example.com' && g.data.project.emailPublic === true && g.data.project.github === 'https://github.com/nodejs/node' && !('pin_hash' in g.data.project) && !('code' in g.data.project), JSON.stringify(g.data?.project))
const sv = await post('/api/manage/save', { id: idA, pin: '123456', tagline: '  고친   한 줄 소개 ', newPin: '567890' }, A)
ok('고치기 (소개 · 새 PIN)', sv.data?.ok && sv.data.project.tagline === '고친 한 줄 소개' && sv.data.linkReview === false, JSON.stringify(sv.data))
ok('옛 PIN은 이제 안 됨', (await post('/api/manage/get', { id: idA, pin: '123456' }, A)).data?.reason === 'pin')
ok('새 PIN으로 보기', (await post('/api/manage/get', { id: idA, pin: '567890' }, A)).data?.ok === true)
ok('고치기에도 욕설 거름', (await post('/api/manage/save', { id: idA, pin: '567890', name: '시발' }, A)).data?.reason === 'word')
ok('검토 전 링크 바꾸기는 바로 반영', (await post('/api/manage/save', { id: idC, pin: '111111', url: 'https://third-demo-2.dev' }, Ct)).data?.project?.url === 'https://third-demo-2.dev')

// 승인 (운영 도구) → 서버 다시 띄우기 → 맵에 보임
const list = cli('projects')
ok('cli projects: 검토 대기 목록', list.status === 0 && list.stdout.includes(`#${idA}`) && list.stdout.includes('dev@example.com (공개)'), list.stderr)
const ap = cli('approve', String(idA))
ok('cli approve A (빈 자리 자동)', ap.status === 0 && /승인했습니다/.test(ap.stdout), (ap.stdout + ap.stderr).trim())
const apB = cli('approve', String(idB), '3')
ok('cli approve B (자리 3)', apB.status === 0 && /자리 3/.test(apB.stdout), (apB.stdout + apB.stderr).trim())
ok('cli approve 이미 쓴 자리 → 실패', cli('approve', String(idC), '3').status !== 0)
const rj = cli('reject', String(idC), '링크가', '열리지', '않아요')
ok('cli reject C (사유)', rj.status === 0 && /반려했습니다/.test(rj.stdout), (rj.stdout + rj.stderr).trim())
await stop()
await start()

const w1 = await world()
const sA = w1.shrines.find(s => s.name === '데모 프로젝트')
const sB = w1.shrines.find(s => s.name === '서비스만')
ok('맵에 A 사당 (repo · 공개 이메일 · fromProject)', !!sA && sA.repo === 'https://github.com/nodejs/node' && sA.email === 'dev@example.com' && sA.fromProject === true && sA.tagline === '고친 한 줄 소개' && !('url' in sA), JSON.stringify(sA))
ok('맵에 B 사당 (자리 3 · 비공개 이메일은 안 보냄)', !!sB && sB.plot === 3 && !('email' in sB) && sB.repo === '' && sB.domain === 'example-demo-shrine.dev', JSON.stringify(sB))
const goRepo = await fetch(`${B}/go/${sA?.slug}/repo`, { redirect: 'manual' })
ok('/go/<slug>/repo → GitHub', goRepo.status === 302 && goRepo.headers.get('location') === 'https://github.com/nodejs/node', `${goRepo.status} ${goRepo.headers.get('location')}`)
const goA = await fetch(`${B}/go/${sA?.slug}`, { redirect: 'manual' })
ok('/go/<slug> (저장소만) → GitHub', goA.status === 302 && goA.headers.get('location') === 'https://github.com/nodejs/node')
ok('저장소 없는 사당 /repo → 404', (await fetch(`${B}/go/${sB?.slug}/repo`, { redirect: 'manual' })).status === 404)
const goB = await fetch(`${B}/go/${sB?.slug}`, { redirect: 'manual' })
ok('/go/<slug> (서비스) → 서비스 주소', goB.status === 302 && goB.headers.get('location') === 'https://example-demo-shrine.dev')
ok('반려된 C 상태', (await (await fetch(`${B}/api/submit/${sc.data?.code}`)).json()).note === '링크가 열리지 않아요')

// 승인 뒤 링크 바꾸기 → 검토 대기, 사당은 옛 링크 그대로
const A2 = await enter()
const lr = await post('/api/manage/save', { id: idA, pin: '567890', url: 'https://node-demo-shrine.dev', emailPublic: false }, A2)
ok('승인 뒤 링크 바꾸기 → linkReview', lr.data?.ok && lr.data.linkReview === true && lr.data.project.pendingUrl === 'https://node-demo-shrine.dev' && lr.data.project.url === 'https://node-demo-shrine.dev', JSON.stringify(lr.data))
const w2 = await world()
const sA2 = w2.shrines.find(s => s.slug === sA?.slug)
ok('사당은 옛 링크 그대로 · 이메일 비공개는 바로 반영', (await fetch(`${B}/go/${sA?.slug}`, { redirect: 'manual' })).headers.get('location') === 'https://github.com/nodejs/node' && sA2 && !('email' in sA2), JSON.stringify(sA2))
ok('cli projects: 링크 변경 검토 표시', cli('projects').stdout.includes('링크 변경 검토'))
const ap2 = cli('approve', String(idA))
ok('cli approve: 링크 변경 승인', ap2.status === 0 && /링크 변경을 승인/.test(ap2.stdout), (ap2.stdout + ap2.stderr).trim())
await sleep(100)
await stop()
await start()
const goA3 = await fetch(`${B}/go/${sA?.slug}`, { redirect: 'manual' })
ok('링크 승인 뒤 서비스 주소로 · 저장소도 그대로', goA3.headers.get('location') === 'https://node-demo-shrine.dev' && (await fetch(`${B}/go/${sA?.slug}/repo`, { redirect: 'manual' })).status === 302)

// 내리기
const A3 = await enter()
const wd = await post('/api/manage/withdraw', { id: idA, pin: '567890' }, A3)
ok('내리기', wd.data?.ok === true)
const w3 = await world()
ok('내린 사당은 맵에서 바로 빠짐', !w3.shrines.some(s => s.slug === sA?.slug) && w3.shrines.some(s => s.slug === sB?.slug))
ok('내린 접수는 관리 → none', (await post('/api/manage/get', { id: idA, pin: '567890' }, A3)).data?.reason === 'none')
await stop()
await start()
ok('다시 띄워도 빠져 있음', !(await world()).shrines.some(s => s.slug === sA?.slug))
await stop()

await T.done()
