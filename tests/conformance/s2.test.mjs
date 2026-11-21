// WP2 · WP3 시험: 헬스 체크 · 약관 주소 · 승인 전 이미지 비공개 · 메타데이터 지우기 · 업로드 시도 제한 · 동의 · PIN ·
// 글자 변경 검토 · 알림(웹훅) · 차단 · 보관 기간(파기 · 90일 만료) · 클릭 수 · 검색 파일.
// 자체 서버 3345(도메인 루트) · 3346(검색 공개 설정), 웹훅 받는 곳 3347. 끝나면 모두 끕니다.
//   SHRINE_TARGET=node|py node tests/conformance/s2.test.mjs
import { randomBytes, scryptSync } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { crc32, deflateSync } from 'node:zlib'
import * as D from './driver.mjs'
import { suite } from './lib/check.mjs'

const DATA = await D.freshDataDir('s2-main')
const DATA_B = await D.freshDataDir('s2-index')
const PORT = D.PORTS.s2
const PORT_B = D.PORTS.s2b
const HOOK_PORT = D.PORTS.s2hook
const B = `http://127.0.0.1:${PORT}`
const SECRET = 'test-ticket-secret-0123456789abcdef0123456789'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const T = suite('s2')
const ok = T.ok

/* ── 웹훅 받는 곳 ── */

const hooks = []
const hookServer = createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    hooks.push({ path: req.url, type: req.headers['content-type'], raw: body })
    res.writeHead(204)
    res.end()
  })
})
await new Promise(r => hookServer.listen(HOOK_PORT, '127.0.0.1', r))
const hookTexts = () => hooks.map(h => { try { return JSON.parse(h.raw).text } catch { return '' } })
async function waitHook(pred, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const h = hookTexts().find(pred)
    if (h) return h
    await sleep(50)
  }
  return null
}

/* ── 서버 ── */

const baseEnv = {
  ...process.env, HOST: '127.0.0.1', GITHUB_CHECK: 'off', BASE_PATH: '', TRUST_PROXY: 'true', TICKET_SECRET: SECRET,
  NOTIFY_WEBHOOK_URL: `http://127.0.0.1:${HOOK_PORT}/hook`, CONTACT_EMAIL: 'ops@example.com',
}
for (const k of ['ADMIN_PASSWORD', 'ADMIN_IPS', 'NODE_ENV', 'PUBLIC_ORIGIN', 'ALLOW_INDEXING', 'RETENTION_DAYS', 'PENDING_DAYS']) delete baseEnv[k]
const envA = { ...baseEnv, PORT: String(PORT), DATA_DIR: DATA }
let srv = null
let srvErr = ''
async function start(env = envA, port = PORT) {
  const s = await D.startServer({ ...env, PORT: String(port) }, { ready: '/healthz' })
  srvErr = s.err
  return s
}
async function stop(s) {
  if (!s) return
  await D.stopServer(s)
}
const cli = (...args) => D.cli(args, { env: envA })
/** 보관 기간 정리 한 번 (서버와 같은 DATA_DIR, 따로 띄운 프로세스 — driver 훅 retention) */
function retention(extra) {
  return D.runRetention({ ...envA, ...extra })
}

/* ── 요청 도구 ── */

async function enter(ip = '10.1.0.1') {
  const r = await fetch(`${B}/api/enter`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: B, 'X-Forwarded-For': ip }, body: JSON.stringify({ look: [0, 1, 0, 0, 1, 1, 1, 2, 0, 0, 0, 0] }) })
  return { status: r.status, ck: (r.headers.get('set-cookie') || '').split(';')[0], data: await r.json().catch(() => null) }
}
async function post(path, body, { ck = '', ip = '10.1.0.1', type = 'application/json' } = {}) {
  const headers = { 'Content-Type': type, Origin: B, 'X-Forwarded-For': ip }
  if (ck) headers.Cookie = ck
  const r = await fetch(`${B}${path}`, { method: 'POST', headers, body: type === 'application/json' ? JSON.stringify(body) : body })
  return { status: r.status, data: await r.json().catch(() => null) }
}
const img = (id, ck, ip = '10.9.9.9') => fetch(`${B}/img/shrines/up/${id}`, { headers: { ...(ck ? { Cookie: ck } : {}), 'X-Forwarded-For': ip } })
const world = async () => (await fetch(`${B}/api/world`)).json()

const kstDay = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)

/* ── 이미지 만들기 ── */

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
  return Buffer.concat([len, td, crc])
}
function png(w, h, extra = []) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), ...extra, pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}
const seg = (marker, data) => { const h = Buffer.from([0xff, marker, 0, 0]); h.writeUInt16BE(data.length + 2, 2); return Buffer.concat([h, data]) }
/** 최소 JPEG 뼈대: APP0 + APP1(EXIF, 위치 글자) + COM + SOF0(크기) + SOS + 데이터 + EOI */
function jpegWithExif(w, h) {
  const sof = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0]); sof.writeUInt16BE(h, 1); sof.writeUInt16BE(w, 3)
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    seg(0xe1, Buffer.from('Exif\0\0GPS-LAT-37.5665-SECRET', 'latin1')),
    seg(0xfe, Buffer.from('COMMENT-SECRET', 'latin1')),
    seg(0xc0, sof),
    seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0x34, 0x56]),
    Buffer.from([0xff, 0xd9]),
  ])
}
/** VP8X WebP + EXIF 조각 (EXIF 표시 비트 켬) */
function webpWithExif(w, h) {
  const vp8x = Buffer.alloc(10); vp8x[0] = 0x08; vp8x.writeUIntLE(w - 1, 4, 3); vp8x.writeUIntLE(h - 1, 7, 3)
  const ch = (cc, d) => { const head = Buffer.alloc(8); head.write(cc, 0, 'latin1'); head.writeUInt32LE(d.length, 4); return Buffer.concat([head, d, d.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]) }
  const body = Buffer.concat([ch('VP8X', vp8x), ch('VP8L', Buffer.from([0x2f, 0, 0, 0, 0])), ch('EXIF', Buffer.from('GPS-WEBP-SECRET'))])
  const head = Buffer.alloc(12); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(4 + body.length, 4); head.write('WEBP', 8, 'latin1')
  return Buffer.concat([head, body])
}

try {
  srv = await start()

  /* ═══ 1. 헬스 체크 ═══ */
  let r = await fetch(`${B}/healthz`)
  let j = await r.json()
  ok('healthz 200 · ok · no-store', r.status === 200 && j.ok === true && j.db === 'ok' && r.headers.get('cache-control') === 'no-store', JSON.stringify(j))
  ok('healthz: 싼 수치만 (가동 시간 · 사당 수 · 업로드 %)', typeof j.uptime === 'number' && j.shrines === 0 && typeof j.uploads?.usedPct === 'number')
  ok('healthz HEAD 200', (await fetch(`${B}/healthz`, { method: 'HEAD' })).status === 200)
  const codes = await Promise.all(Array.from({ length: 260 }, () => fetch(`${B}/healthz`, { headers: { 'X-Forwarded-For': '10.200.0.1' } }).then(x => x.status)))
  ok('healthz는 요청 제한(분당 240)에 걸리지 않음', codes.every(c => c === 200), [...new Set(codes)].join(','))

  /* ═══ 2. 약관 · 처리방침 ═══ */
  r = await fetch(`${B}/privacy`)
  const privacyBody = await r.text()
  ok('/privacy 200 text/html no-cache + 보안 헤더', r.status === 200 && r.headers.get('content-type') === 'text/html; charset=utf-8' && r.headers.get('cache-control') === 'no-cache' && (r.headers.get('content-security-policy') || '').includes("default-src 'self'") && privacyBody.includes('<html'))
  ok('/privacy ETag → 304', (await fetch(`${B}/privacy`, { headers: { 'If-None-Match': r.headers.get('etag') } })).status === 304)
  ok('/terms 200', (await fetch(`${B}/terms`)).status === 200)
  ok('/privacy HEAD 200 (본문 없음)', (await fetch(`${B}/privacy`, { method: 'HEAD' })).status === 200)
  ok('/privacy/ (끝 빗금) → 404', (await fetch(`${B}/privacy/`)).status === 404)
  r = await fetch(`${B}/legal/terms.html`, { redirect: 'manual' })
  ok('/legal/terms.html → 301 /terms', r.status === 301 && r.headers.get('location') === '/terms', r.headers.get('location'))
  ok('POST /privacy → 404', (await fetch(`${B}/privacy`, { method: 'POST' })).status === 404)
  r = await fetch(`${B}/no-such-page`, { headers: { Accept: 'text/html' } })
  ok('없는 페이지 → 404 HTML', r.status === 404 && (r.headers.get('content-type') || '').startsWith('text/html') && (await r.text()).includes('href="/"'))

  /* ═══ 3. 접수: 동의 · PIN ═══ */
  const A = await enter('10.1.0.1')
  ok('입장', A.status === 200 && A.ck.startsWith('shrine_ticket='))
  const base = { name: '동의 시험', tagline: '동의를 받아야 하는 접수', category: 'devtools', url: 'https://consent-demo.dev', email: 'Owner.Secret@example.com', emailPublic: false, pin: '246810', consent: true }
  r = await post('/api/submit', { ...base, consent: undefined }, { ck: A.ck })
  ok('동의 없음 → 400 consent', r.status === 400 && r.data?.reason === 'consent', JSON.stringify(r.data))
  r = await post('/api/submit', { ...base, consent: 'true' }, { ck: A.ck })
  ok('동의가 문자열 → consent', r.data?.reason === 'consent')
  r = await post('/api/submit', { ...base, consent: 1 }, { ck: A.ck })
  ok('동의가 숫자 → consent', r.data?.reason === 'consent')
  r = await post('/api/submit', { ...base, pin: '123' }, { ck: A.ck })
  ok('새 접수 3자리 PIN → pin (4자리 이상)', r.data?.reason === 'pin')
  hooks.length = 0
  r = await post('/api/submit', base, { ck: A.ck })
  ok('동의 + 6자리 PIN → 201', r.status === 201 && r.data?.ok, JSON.stringify(r.data))
  const p1 = r.data.id
  let row = await D.sqlGet(DATA, 'SELECT consent_at, review_at, at FROM projects WHERE id = ?', [p1])
  ok('consent_at · review_at 저장', row.consent_at > 0 && row.review_at === row.at, JSON.stringify(row))

  /* ═══ 4. 알림 (웹훅) ═══ */
  let t = await waitHook(x => x.includes('새 접수'))
  ok('알림: 새 접수 (번호 · 이름 · 링크)', !!t && t.includes(`접수: ${p1}`) && t.includes('동의 시험') && t.includes('https://consent-demo.dev'), t)
  const allRaw = hooks.map(h => h.raw).join('\n')
  ok('알림: 이메일 · PIN 없음', !/owner\.secret|Owner\.Secret|246810/i.test(allRaw))
  ok('알림: 슬랙(text) · 디스코드(content) 둘 다 · JSON', hooks.length > 0 && hooks.every(h => { const b = JSON.parse(h.raw); return b.text === b.content && h.type === 'application/json' && h.path === '/hook' }))
  // notify() 단독: 개인정보 칸 빼기 · 메일 모양 가리기 · 멘션 무력화
  hooks.length = 0
  D.notify(envA, '시험 @everyone', { email: 'x@y.com', pin: '999999', ipKey: 'abc', 메모: '연락 a.b@c.org <!channel> @here', 수: 3 })
  t = await waitHook(x => x.includes('시험'))
  ok('notify: email · pin · ipKey 칸 뺌', !!t && !t.includes('x@y.com') && !t.includes('999999') && !t.includes('abc'), t)
  ok('notify: 값 속 메일 가림 · 멘션 무력화', !!t && !t.includes('a.b@c.org') && t.includes('[메일 가림]') && !t.includes('<!channel>') && !t.includes('@everyone') && !t.includes('@here'), t)
  r = D.notify({ ...envA, NOTIFY_WEBHOOK_URL: '' }, '꺼짐', { a: 1 })
  ok('notify: 주소가 없으면 아무것도 안 함', r.status === 0 && r.stdout.includes('done'))
  r = D.notify({ ...envA, NOTIFY_WEBHOOK_URL: 'http://127.0.0.1:1/x' }, '닿지 않음', { a: 1 })
  ok('notify: 받는 곳이 없어도 throw 없이 끝남', r.status === 0 && r.stdout.includes('done'), r.stderr.slice(0, 120))

  /* ═══ 5. 이미지: 승인 전 비공개 · 메타데이터 지우기 ═══ */
  const U = await enter('10.1.0.2')
  r = await post('/api/upload', jpegWithExif(64, 48), { ck: U.ck, ip: '10.1.0.2', type: 'image/jpeg' })
  ok('JPEG(EXIF) 올리기', r.status === 201 && /\.jpg$/.test(r.data?.id ?? ''), JSON.stringify(r.data))
  const jpgId = r.data?.id
  let res = await img(jpgId, U.ck)
  let bytes = Buffer.from(await res.arrayBuffer())
  ok('올린 사람: 200 · private, no-store · CORP', res.status === 200 && res.headers.get('cache-control') === 'private, no-store' && res.headers.get('cross-origin-resource-policy') === 'same-origin')
  ok('JPEG: EXIF(APP1) · 주석 지움, 크기 정보는 남음', !bytes.includes('GPS-LAT') && !bytes.includes('COMMENT-SECRET') && bytes.includes('JFIF') && bytes[0] === 0xff && bytes[1] === 0xd8, bytes.length)
  ok('승인 전: 아무나 → 404', (await img(jpgId)).status === 404)
  ok('승인 전: HEAD도 404', (await fetch(`${B}/img/shrines/up/${jpgId}`, { method: 'HEAD' })).status === 404)
  r = await post('/api/upload', png(40, 30, [pngChunk('tEXt', Buffer.from('Comment\0PNG-TEXT-SECRET', 'latin1')), pngChunk('eXIf', Buffer.from('MM\0*PNG-EXIF-SECRET', 'latin1'))]), { ck: U.ck, ip: '10.1.0.2', type: 'image/png' })
  const pngId = r.data?.id
  bytes = Buffer.from(await (await img(pngId, U.ck)).arrayBuffer())
  ok('PNG: tEXt · eXIf 지움', r.status === 201 && !bytes.includes('PNG-TEXT-SECRET') && !bytes.includes('PNG-EXIF-SECRET') && bytes.includes('IHDR') && bytes.includes('IEND'))
  r = await post('/api/upload', webpWithExif(50, 40), { ck: U.ck, ip: '10.1.0.2', type: 'image/webp' })
  const webpId = r.data?.id
  bytes = Buffer.from(await (await img(webpId, U.ck)).arrayBuffer())
  ok('WebP: EXIF 조각 지움 · VP8X 표시 끔 · RIFF 크기 맞음', r.status === 201 && !bytes.includes('GPS-WEBP-SECRET') && (bytes[20] & 0x08) === 0 && bytes.readUInt32LE(4) === bytes.length - 8, JSON.stringify(r.data))

  // 업로드 시도 제한: 형식이 틀린 것도 셉니다 (IP당 10분 20번)
  const V = await enter('10.1.0.3')
  const tries = []
  for (let i = 0; i < 20; i++) tries.push((await post('/api/upload', Buffer.from('not an image'), { ck: V.ck, ip: '10.1.0.3', type: 'image/png' })).data?.reason)
  r = await post('/api/upload', png(32, 32), { ck: V.ck, ip: '10.1.0.3', type: 'image/png' })
  ok('형식 틀린 시도 20번 뒤엔 본문 보기 전에 429 slow', tries.every(x => x === 'type') && r.status === 429 && r.data?.reason === 'slow', `${tries[0]} → ${r.status} ${r.data?.reason}`)

  /* ═══ 6. 승인 · 공개 · 글자 변경 검토 ═══ */
  const S = await enter('10.1.0.4')
  r = await post('/api/upload', png(64, 36), { ck: S.ck, ip: '10.1.0.4', type: 'image/png' })
  const shotId = r.data.id
  r = await post('/api/submit', { ...base, name: '검토 시험', url: 'https://review-demo.dev', email: 'review@example.com', pin: '135790', screen: shotId }, { ck: S.ck, ip: '10.1.0.4' })
  const p2 = r.data?.id
  ok('이미지 붙여 접수', r.status === 201, JSON.stringify(r.data))
  let out = cli('approve', String(p2))
  ok('승인', /승인했습니다/.test(out.stdout), out.stdout + out.stderr)
  await stop(srv); srv = await start()
  let w = await world()
  const slug2 = w.shrines.find(s => s.name === '검토 시험')?.slug
  res = await img(shotId)
  ok('승인 뒤: 아무나 200 · public 캐시 · ETag', res.status === 200 && res.headers.get('cache-control') === 'public, max-age=86400' && !!res.headers.get('etag'))

  const S2 = await enter('10.1.0.5')
  hooks.length = 0
  r = await post('/api/manage/save', { id: p2, pin: '135790', name: '바뀐 이름', tagline: '바뀐 한 줄 소개입니다', sign: '바뀐지붕', category: 'content' }, { ck: S2.ck, ip: '10.1.0.5' })
  ok('승인된 사당 글자 변경 → 검토 대기 (linkReview)', r.status === 200 && r.data.linkReview === true, JSON.stringify(r.data).slice(0, 200))
  ok('작성자 화면: 고친 값 + pending* 칸', r.data?.project?.name === '바뀐 이름' && r.data.project.pendingName === '바뀐 이름' && r.data.project.pendingTagline === '바뀐 한 줄 소개입니다' && r.data.project.pendingSign === '바뀐지붕')
  w = await world()
  let sh = w.shrines.find(s => s.slug === slug2)
  ok('맵은 옛 글자 그대로, 분류는 바로 반영', sh?.name === '검토 시험' && sh.tagline === base.tagline && sh.category === 'content', JSON.stringify(sh).slice(0, 160))
  t = await waitHook(x => x.includes('사당 변경 검토 요청'))
  ok('알림: 변경 검토 요청 (글자)', !!t && t.includes(`접수: ${p2}`) && t.includes('글자'), t)
  r = await post('/api/manage/save', { id: p2, pin: '135790', name: '바뀐 이름', tagline: '바뀐 한 줄 소개입니다', sign: '바뀐지붕', emailPublic: true }, { ck: S2.ck, ip: '10.1.0.5' })
  ok('같은 값으로 다시 저장해도 검토 요청 유지', r.data?.linkReview === true && r.data.project.pendingName === '바뀐 이름')
  out = cli('projects')
  ok('cli projects: 글자 변경도 검토 목록에', out.stdout.includes(`#${p2}`), out.stdout.slice(0, 200))
  out = cli('reject', String(p2), '사칭', '의심')
  ok('글자 변경 반려 → 사당 그대로', /변경을 반려/.test(out.stdout), out.stdout + out.stderr)
  r = await post('/api/manage/get', { id: p2, pin: '135790' }, { ck: S2.ck, ip: '10.1.0.5' })
  ok('반려 뒤 pending 비움 · 메모', r.data?.project?.pendingName === null && r.data.project.name === '검토 시험' && /link-rejected/.test(r.data.project.note))
  r = await post('/api/manage/save', { id: p2, pin: '135790', name: '새 이름' }, { ck: S2.ck, ip: '10.1.0.5' })
  out = cli('approve', String(p2))
  ok('글자 변경 승인', /글자 변경을 승인/.test(out.stdout), out.stdout + out.stderr)
  await stop(srv); srv = await start()
  w = await world()
  sh = w.shrines.find(s => s.slug === slug2)
  ok('승인 뒤 맵에 새 이름', sh?.name === '새 이름', sh?.name)
  r = await post('/api/manage/save', { id: p2, pin: '135790', name: '새 이름' }, { ck: S2.ck, ip: '10.1.0.5' })
  ok('지금 이름과 같으면 검토할 것 없음', r.data?.linkReview === false && r.data.project.pendingName === null)

  /* ═══ 7. /go 클릭 수: 입장한 사람만 ═══ */
  const clicks = async () => Number((await D.sqlGet(DATA, 'SELECT COALESCE(SUM(n), 0) AS n FROM clicks WHERE slug = ?', [slug2])).n)
  const c0 = await clicks()
  r = await fetch(`${B}/go/${slug2}`, { redirect: 'manual' })
  ok('/go 입장 표 없이: 이동은 되지만 안 셈', r.status === 302 && (await clicks()) === c0)
  await fetch(`${B}/go/${slug2}`, { redirect: 'manual', headers: { Cookie: S2.ck } })
  ok('/go 입장 표 있으면 셈', (await clicks()) === c0 + 1)

  /* ═══ 8. PIN: 예전 4자리 · 하루 20번 잠금(DB) ═══ */
  const legacySalt = randomBytes(16)
  const legacyHash = `${legacySalt.toString('base64url')}:${scryptSync('4321', legacySalt, 32).toString('base64url')}`
  const legacyId = Number((await D.sqlGet(DATA, `INSERT INTO projects (code, at, name, tagline, category, url, email, pin_hash, nick) VALUES (?, ?, '예전 접수', '4자리 PIN 시절 접수', 'etc', 'https://legacy-demo.dev', 'legacy@example.com', ?, '옛 닉네임') RETURNING id`,
    [randomBytes(12).toString('base64url'), Date.now(), legacyHash])).id)
  const L = await enter('10.1.0.6')
  r = await post('/api/manage/get', { id: legacyId, pin: '4321' }, { ck: L.ck, ip: '10.1.0.6' })
  ok('예전 4자리 PIN으로도 관리 열림', r.data?.ok === true, JSON.stringify(r.data))
  r = await post('/api/manage/save', { id: legacyId, pin: '4321', newPin: '987' }, { ck: L.ck, ip: '10.1.0.6' })
  ok('새 PIN은 4자리 이상만', r.data?.reason === 'pin')
  // 보안 점검: py는 접수 전체 하루 한도가 200번 ((접수, IP)마다 20번은 Redis에서 그날 그 IP만 잠금). Node는 20번 그대로
  const dayFails = D.isPy ? 199 : 19
  await D.sql(DATA, 'INSERT INTO pin_locks (project_id, day, fails, until) VALUES (?, ?, ?, 0)', [legacyId, kstDay(), dayFails])
  hooks.length = 0
  r = await post('/api/manage/get', { id: legacyId, pin: '0000' }, { ck: L.ck, ip: '10.1.0.7' })
  ok(`그날 ${dayFails + 1}번째로 틀리면 locked`, r.data?.reason === 'locked', JSON.stringify(r.data))
  t = await waitHook(x => x.includes('관리 비밀번호 잠금'))
  ok('알림: PIN 잠금 (번호만)', !!t && t.includes(`접수: ${legacyId}`) && !t.includes('legacy@'), t)
  await stop(srv); srv = await start()
  r = await post('/api/manage/get', { id: legacyId, pin: '4321' }, { ck: (await enter('10.1.0.8')).ck, ip: '10.1.0.8' })
  ok('다시 띄워도 잠금 유지 (맞는 PIN도 locked)', r.data?.reason === 'locked', JSON.stringify(r.data))

  /* ═══ 9. 차단 (moderation.ts) ═══ */
  out = cli('block-ip', '10.66.0.1', '30m', '시험')
  ok('cli block-ip', out.status === 0, out.stdout + out.stderr)
  let blocked = null
  for (let i = 0; i < 30 && blocked !== 403; i++) {
    blocked = (await fetch(`${B}/api/enter`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: B, 'X-Forwarded-For': '10.66.0.1' }, body: JSON.stringify({ look: [0, 1, 0, 0, 1, 1, 1, 2, 0, 0, 0, 0] }) })).status
    if (blocked !== 403) await sleep(500)
  }
  ok('차단된 IP: 입장 403', blocked === 403)
  r = await post('/api/upload', png(32, 32), { ck: A.ck, ip: '10.66.0.1', type: 'image/png' })
  ok('차단된 IP: 업로드 403 blocked', r.status === 403 && r.data?.reason === 'blocked', JSON.stringify(r.data))
  r = await post('/api/submit', { ...base, url: 'https://blocked-demo.dev' }, { ck: A.ck, ip: '10.66.0.1' })
  ok('차단된 IP: 접수 403 blocked', r.status === 403 && r.data?.reason === 'blocked')

  /* ═══ 10. 보관 기간: 30일 파기 · 90일 만료 ═══ */
  // 반려할 접수(이미지 포함) · 내릴 접수 · 오래 기다린 접수 · 오래된 변경 요청
  const R = await enter('10.2.0.1')
  r = await post('/api/upload', png(48, 32), { ck: R.ck, ip: '10.2.0.1', type: 'image/png' })
  const rejImg = r.data.id
  r = await post('/api/submit', { ...base, name: '반려될 접수', url: 'https://reject-demo.dev', email: 'reject.me@example.com', pin: '112233', screen: rejImg, github: 'https://github.com/someone/private-name' }, { ck: R.ck, ip: '10.2.0.1' })
  const pRej = r.data.id
  const rejCode = r.data.code
  out = cli('reject', String(pRej), '시험')
  ok('반려 → closed_at', /반려했습니다/.test(out.stdout) && (await D.sqlGet(DATA, 'SELECT closed_at FROM projects WHERE id = ?', [pRej]))?.closed_at > 0)
  const W = await enter('10.2.0.2')
  r = await post('/api/submit', { ...base, name: '내릴 접수', url: 'https://withdraw-demo.dev', email: 'withdraw.me@example.com', pin: '445566' }, { ck: W.ck, ip: '10.2.0.2' })
  const pWd = r.data.id
  cli('approve', String(pWd))
  r = await post('/api/manage/withdraw', { id: pWd, pin: '445566' }, { ck: W.ck, ip: '10.2.0.2' })
  ok('작성자가 내림 → closed_at', r.data?.ok === true && (await D.sqlGet(DATA, 'SELECT closed_at FROM projects WHERE id = ?', [pWd]))?.closed_at > 0)
  t = await waitHook(x => x.includes('작성자가 프로젝트를 내림'))
  ok('알림: 내림', !!t && t.includes(`접수: ${pWd}`), t)
  const O = await enter('10.2.0.3')
  r = await post('/api/submit', { ...base, name: '오래 기다림', url: 'https://old-pending.dev', email: 'old.pending@example.com', pin: '778899' }, { ck: O.ck, ip: '10.2.0.3' })
  const pOld = r.data.id
  r = await post('/api/manage/save', { id: p2, pin: '135790', url: 'https://review-demo-changed.dev' }, { ck: S2.ck, ip: '10.1.0.5' })
  ok('오래될 변경 요청 (링크)', r.data?.linkReview === true)
  // 게시판: 8일 지난 글 + 그 신고, 글이 없는 신고
  const oldPost = Number((await D.sqlGet(DATA, `INSERT INTO posts (at, topic, text, nick) VALUES (?, 'claude', '오래된 글', '닉') RETURNING id`, [Date.now() - 8 * 24 * 3600_000])).id)
  const newPost = Number((await D.sqlGet(DATA, `INSERT INTO posts (at, topic, text, nick) VALUES (?, 'claude', '새 글', '닉') RETURNING id`, [Date.now()])).id)
  await D.sql(DATA, 'INSERT INTO post_reports (post_id, reporter) VALUES (?, ?), (?, ?), (?, ?)', [oldPost, 'x1', newPost, 'x2', 999999, 'x3'])
  // 보관 기간이 기본(30일 · 90일)이면 아직 아무것도 안 지움
  await D.sql(DATA, 'UPDATE projects SET review_at = ? WHERE id = ?', [Date.now() - 89 * 24 * 3600_000, pOld])
  let rr = retention({})
  ok('기본값(30 · 90일): 접수는 그대로, 7일 지난 글 · 고아 신고만 지움', rr.purged === 0 && rr.expired === 0 && rr.expiredChanges === 0 && rr.posts === 1 && rr.reports === 2, JSON.stringify(rr))
  ok('새 글의 신고는 남음', (await D.sqlGet(DATA, 'SELECT COUNT(*) AS n FROM post_reports')).n === 1)
  await D.sql(DATA, 'UPDATE projects SET review_at = ? WHERE id = ?', [Date.now() - 91 * 24 * 3600_000, pOld])
  hooks.length = 0
  rr = retention({})
  ok('90일 지난 접수 → 반려(expired), 변경 요청은 아직', rr.expired === 1 && rr.expiredChanges === 0 && rr.purged === 0, JSON.stringify(rr))
  row = await D.sqlGet(DATA, 'SELECT status, note, closed_at, email FROM projects WHERE id = ?', [pOld])
  ok('만료된 접수: rejected · note expired · 파기 시계 시작 · 이메일은 아직', row.status === 'rejected' && row.note === 'expired' && row.closed_at > 0 && row.email === 'old.pending@example.com', JSON.stringify(row))
  t = await waitHook(x => x.includes('검토 기한'), 5000)
  ok('알림: 검토 기한 지남 (개수만)', !!t && t.includes('접수: 1'), t)
  // 맵에 있는 사당의 변경 요청: 90일 지나면 바꾸려던 것만 버림
  await D.sql(DATA, 'UPDATE projects SET review_at = ? WHERE id = ?', [Date.now() - 91 * 24 * 3600_000, p2])
  rr = retention({})
  ok('90일 지난 변경 요청 → 버림 (접수 만료는 없음)', rr.expiredChanges === 1 && rr.expired === 0, JSON.stringify(rr))
  r = await post('/api/manage/get', { id: p2, pin: '135790' }, { ck: S2.ck, ip: '10.1.0.5' })
  w = await world()
  ok('버린 변경: pending 비움 · note link-expired · 사당 그대로', r.data?.project?.pendingUrl === null && r.data.project.note === 'link-expired' && r.data.project.status === 'approved' && w.shrines.some(s => s.slug === slug2), JSON.stringify(r.data?.project).slice(0, 160))
  // PENDING_DAYS로 줄이기 (0.5일 = 12시간): 13시간 기다린 접수만 만료, 방금 들어온 예전 접수(legacy)는 그대로
  await D.sql(DATA, 'UPDATE projects SET review_at = ? WHERE id = ?', [Date.now() - 13 * 3600_000, p1])
  rr = retention({ PENDING_DAYS: '0.5' })
  const st1 = await D.sqlGet(DATA, 'SELECT status, note FROM projects WHERE id = ?', [p1])
  const stL = await D.sqlGet(DATA, 'SELECT status FROM projects WHERE id = ?', [legacyId])
  ok('PENDING_DAYS=0.5: 13시간 된 접수만 expired', rr.expired === 1 && st1.status === 'rejected' && st1.note === 'expired' && stL.status === 'pending', JSON.stringify({ rr, st1, stL }))
  ok('반려된 이미지: 파기 전엔 파일이 남아 있음', existsSync(D.uploadFile(DATA, rejImg)))
  rr = retention({ RETENTION_DAYS: '0' })
  ok('RETENTION_DAYS=0: 반려 · 내림 · 만료 접수 4건 파기, 이미지 1개 지움', rr.purged === 4 && rr.images === 1, JSON.stringify(rr))
  const purged = await D.sqlGet(DATA, 'SELECT * FROM projects WHERE id = ?', [pRej])
  const wd = await D.sqlGet(DATA, 'SELECT * FROM projects WHERE id = ?', [pWd])
  const survivors = (await D.sqlGet(DATA, `SELECT COUNT(*) AS n FROM projects WHERE purged_at IS NOT NULL AND id NOT IN (?, ?, ?, ?)`, [pRej, pWd, pOld, p1])).n
  const alive = (await D.sqlGet(DATA, 'SELECT email FROM projects WHERE id = ?', [p2])).email
  ok('파기: 이메일 · PIN 해시 · 링크 · 이미지 · 이름 비움', purged.email === '' && purged.pin_hash === '' && purged.github === '' && purged.url === '' && purged.screen === '' && purged.pending_screen === null && purged.name === '(파기됨)' && purged.purged_at > 0, JSON.stringify(purged).slice(0, 200))
  ok('파기: 개인정보 아닌 기록은 남김 (번호 · 시각 · 분류 · 상태 · 메모)', purged.id === pRej && purged.at > 0 && purged.category === 'devtools' && purged.status === 'rejected' && purged.note === '시험')
  ok('내린 접수도 파기 (slug도 비움)', wd.email === '' && wd.pin_hash === '' && wd.slug === '' && wd.status === 'withdrawn')
  ok('맵에 있는 접수 · 대기 중인 접수는 그대로', alive === 'review@example.com')
  ok('다른 접수는 건드리지 않음', survivors === 0)
  ok('파기한 이미지 파일 지움 · 주소 404 (올린 사람도)', !existsSync(D.uploadFile(DATA, rejImg)) && (await img(rejImg, R.ck)).status === 404)
  r = await post('/api/manage/get', { id: pRej, pin: '112233' }, { ck: R.ck, ip: '10.2.0.1' })
  ok('파기한 접수는 관리 → none', r.data?.reason === 'none', JSON.stringify(r.data))
  r = await post('/api/manage/find', { email: 'reject.me@example.com', pin: '112233' }, { ck: R.ck, ip: '10.2.0.1' })
  ok('파기한 이메일로 찾기 → pin (없음과 같음)', r.data?.reason === 'pin')
  j = await (await fetch(`${B}/api/submit/${rejCode}`)).json()
  ok('접수 코드 조회는 상태만', j.ok && j.status === 'rejected' && j.name === '(파기됨)', JSON.stringify(j))
  rr = retention({ RETENTION_DAYS: '0' })
  ok('두 번 돌려도 다시 파기하지 않음', rr.purged === 0, JSON.stringify(rr))
  ok('파기된 데이터에 이메일이 남지 않음', (await D.sqlGet(DATA, `SELECT COUNT(*) AS n FROM projects WHERE email IN ('reject.me@example.com', 'withdraw.me@example.com', 'old.pending@example.com')`)).n === 0)

  // 작성자 요청으로 바로 파기 (맵에 있는 사당)
  r = D.eraseNow(envA, p2)
  const d = r.result
  ok('destroyProjectNow: 맵에 있던 접수 바로 파기 · 이미지 지움', d?.ok === true && d.images === 1, r.stdout + r.stderr)
  await stop(srv); srv = await start()
  w = await world()
  row = await D.sqlGet(DATA, 'SELECT status, note, email, purged_at FROM projects WHERE id = ?', [p2])
  ok('바로 파기: 사당 빠짐 · withdrawn(erased) · 이메일 없음', !w.shrines.some(s => s.slug === slug2) && row.status === 'withdrawn' && row.note === 'erased' && row.email === '' && row.purged_at > 0, JSON.stringify(row))
  ok('바로 파기: 공개였던 이미지도 404', (await img(shotId)).status === 404)
  r = D.eraseNow(envA, 987654)
  ok('destroyProjectNow: 없는 접수 → ok false', r.result?.ok === false, r.stdout + r.stderr)
  r = D.devHook('retention', [], { env: { ...envA, RETENTION_DAYS: '-1' } })
  ok('RETENTION_DAYS 음수 → 시작 거부', r.status !== 0 && /RETENTION_DAYS/.test(r.stderr))

  /* ═══ 11. 검색 공개 설정 (3348): robots · sitemap · security.txt · {{ORIGIN}} ═══ */
  await stop(srv)
  srv = await start({ ...baseEnv, PORT: String(PORT_B), DATA_DIR: DATA_B, ALLOW_INDEXING: 'true', PUBLIC_ORIGIN: 'https://shrine.example.org' }, PORT_B)
  const BB = `http://127.0.0.1:${PORT_B}`
  let txt = await (await fetch(`${BB}/robots.txt`)).text()
  ok('robots: /go/ · /api/ 막고 sitemap 알림', txt.includes('Disallow: /go/') && txt.includes('Disallow: /api/') && txt.includes('Sitemap: https://shrine.example.org/sitemap.xml') && !txt.includes('admin'), txt.replace(/\n/g, ' | '))
  r = await fetch(`${BB}/sitemap.xml`)
  txt = await r.text()
  ok('sitemap.xml: 첫 화면 · 약관 · 처리방침', r.status === 200 && txt.includes('<loc>https://shrine.example.org/privacy</loc>') && txt.includes('<loc>https://shrine.example.org/</loc>'))
  r = await fetch(`${BB}/.well-known/security.txt`)
  txt = await r.text()
  ok('security.txt: 연락처 · 만료일', r.status === 200 && txt.includes('Contact: mailto:ops@example.com') && /Expires: \d{4}-/.test(txt))
  txt = await (await fetch(`${BB}/`)).text()
  ok('첫 화면에 {{…}} 자리표시가 남지 않음', !/\{\{[A-Z_]+\}\}/.test(txt))
  ok('검색 공개: X-Robots-Tag 없음', !(await fetch(`${BB}/`)).headers.get('x-robots-tag'))
} catch (e) {
  ok('예외', false, `${e?.stack ?? e} ${(srv?.err ?? srvErr).slice(0, 400)}`)
} finally {
  await stop(srv)
  await new Promise(r => hookServer.close(r))
}

await T.done()
