// 채널별 사당 시험: 자체 서버(127.0.0.1:3348, 새 DATA_DIR)를 띄워 API · 운영 화면 API · 실시간 초 켜기를 봅니다. 끝나면 끕니다.
//   SHRINE_TARGET=node|py node tests/conformance/chan.test.mjs
import { randomBytes } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import WebSocket from 'ws'
import * as D from './driver.mjs'
import { suite } from './lib/check.mjs'

const DATA = await D.freshDataDir('chan')
const PORT = D.PORTS.chan
const HP = `127.0.0.1:${PORT}`
const B = `http://${HP}`
const PW = 'chan-test-admin-password-0123456789'
const SECRET = randomBytes(32).toString('hex')
const LOOK = [0, 1, 0, 0, 1, 1, 1, 2, 0, 0, 0, 0]
const sleep = ms => new Promise(r => setTimeout(r, ms))
const T = suite('chan')
const ok = T.ok

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

const env = (() => {
  const e = { ...process.env }
  for (const k of Object.keys(e)) if (/^(NODE_ENV|PUBLIC_ORIGIN|SHRINE_DOMAIN|ADMIN_|TURNSTILE_|CONTACT_EMAIL|NOTIFY_|BOARD_OPEN|FREE_CHAT|WS_MAX_PER_IP|BASE_PATH|TICKET_SECRET|CANDLE_)/.test(k)) delete e[k]
  return { ...e, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, TRUST_PROXY: 'true', GITHUB_CHECK: 'off', TICKET_SECRET: SECRET, ADMIN_PASSWORD: PW }
})()
const cli = (args, input) => D.cli(args, { env, input })

const shrine = (slug, channel, plot, extra = {}) => ({
  slug, name: slug, tagline: `${slug} 시험 사당`, category: 'devtools', domain: `${slug}.example.com`, url: `https://${slug}.example.com`,
  operator: '시험', keeper: false, paid: false, verifiedDomain: '2026-11-18', verifiedBusiness: null, joinedAt: '2026-11-18',
  status: 'live', prayer: 'deploy', charm: null, deco: [], screens: ['a.png'], capturedAt: '2026-11-18', sign: '', plot,
  ...(channel ? { channel } : {}), ...extra,
})

/* ── 준비: 같은 자리 번호(19)를 채널 1 · 2에 ── */

for (const s of [shrine('one-a', null, 19), shrine('one-b', 1, 18), shrine('two-a', 2, 19), shrine('two-b', 2, 4)]) {
  const r = cli(['add', '-'], JSON.stringify(s))
  if (r.status !== 0) throw new Error(`seed ${s.slug}: ${r.stderr}`)
}

const srv = await D.startServer(env)

async function req(method, path, { body, cookie, ip = '10.9.0.1', origin = B } = {}) {
  const headers = { 'X-Forwarded-For': ip }
  if (origin) headers.Origin = origin
  if (cookie) headers.Cookie = cookie
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const r = await fetch(`${B}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  let data = null
  try { data = await r.json() } catch {}
  return { status: r.status, data, headers: r.headers }
}
const world = async () => (await fetch(`${B}/api/world`)).json()
async function enter(ip) {
  const r = await fetch(`${B}/api/enter`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: B, 'X-Forwarded-For': ip }, body: JSON.stringify({ look: LOOK }) })
  return (r.headers.get('set-cookie') || '').split(';')[0]
}
let seq = 0
const project = (extra = {}) => {
  seq += 1
  return { name: `채널 접수 ${seq}`, tagline: '채널 고르기 시험 접수', category: 'devtools', url: `https://chan-project-${seq}.example.dev`, email: `owner${seq}@example.com`, pin: '123456', consent: true, ...extra }
}
/** 새 사람(새 IP · 새 입장 표)으로 접수 */
async function submitAs(n, extra) {
  const ip = `10.1.0.${n}`
  const cookie = await enter(ip)
  const body = project(extra)
  const r = await req('POST', '/api/submit', { body, cookie, ip })
  return { ...r, cookie, ip }
}

try {
  /* ═══ 1. /api/world ═══ */
  console.log('── 1. /api/world')
  let w = await world()
  ok('world: channels 3', w.world.channels === 3, String(w.world.channels))
  ok('world: 사당마다 channel', w.shrines.length === 4 && w.shrines.every(s => [1, 2, 3].includes(s.channel)), w.shrines.map(s => `${s.slug}:${s.channel}/${s.plot}`).join(' '))
  const at = (list, slug) => list.find(s => s.slug === slug)
  ok('world: 같은 자리 19번이 채널 1 · 2에 함께', at(w.shrines, 'one-a')?.channel === 1 && at(w.shrines, 'one-a')?.plot === 19 && at(w.shrines, 'two-a')?.channel === 2 && at(w.shrines, 'two-a')?.plot === 19)

  /* ═══ 2. 등록소 접수 · 관리 ═══ */
  console.log('── 2. 등록소')
  let r = await submitAs(1, { channel: 2, plot: 19 })
  ok('접수: 채널 2 · 19번(찬 자리) → 409 plot', r.status === 409 && r.data?.reason === 'plot', `${r.status} ${JSON.stringify(r.data)}`)
  r = await req('POST', '/api/submit', { body: project({ channel: 5, plot: 3 }), cookie: r.cookie, ip: r.ip })
  ok('접수: 없는 채널 5 → 400 channel', r.status === 400 && r.data?.reason === 'channel', `${r.status} ${JSON.stringify(r.data)}`)
  r = await req('POST', '/api/submit', { body: project({ channel: true, plot: 3 }), cookie: (await enter('10.1.0.9')), ip: '10.1.0.9' })
  ok('접수: 채널 true → 400 channel', r.status === 400 && r.data?.reason === 'channel', `${r.status} ${JSON.stringify(r.data)}`)
  r = await submitAs(2, { plot: 19 })
  ok('접수: 채널 없이 19번 → 1번 채널로 봄 → 409 plot', r.status === 409 && r.data?.reason === 'plot', `${r.status} ${JSON.stringify(r.data)}`)
  const p1 = await submitAs(3, { channel: 3, plot: 19 })
  ok('접수: 채널 3 · 19번 → 201', p1.status === 201 && p1.data?.ok, `${p1.status} ${JSON.stringify(p1.data)}`)
  const p2 = await submitAs(4, { channel: 2 })
  ok('접수: 채널 2 · 자리 아무 데나 → 201', p2.status === 201, `${p2.status} ${JSON.stringify(p2.data)}`)
  const p3 = await submitAs(5, { channel: '1', plot: '4' })
  ok('접수: 글자로 온 채널 1 · 자리 4 → 201', p3.status === 201, `${p3.status} ${JSON.stringify(p3.data)}`)
  const p4 = await submitAs(6, { channel: 1, plot: 6 })
  const p5 = await submitAs(7, { channel: 3 })
  const p6 = await submitAs(8, {})
  ok('접수: 채널 · 자리 안 고름(아무 채널) → 201', p6.status === 201 && p4.status === 201 && p5.status === 201)

  const mg = (p, extra = {}) => req('POST', '/api/manage/get', { body: { id: p.data.id, pin: '123456', ...extra }, cookie: p.cookie, ip: p.ip })
  const ms = (p, extra) => req('POST', '/api/manage/save', { body: { id: p.data.id, pin: '123456', ...extra }, cookie: p.cookie, ip: p.ip })
  r = await mg(p1)
  ok('관리: 고른 채널 3 · 자리 19 보임', r.data?.project?.wantChannel === 3 && r.data.project.wantPlot === 19, JSON.stringify({ c: r.data?.project?.wantChannel, p: r.data?.project?.wantPlot }))
  r = await mg(p6)
  ok('관리: 아무 채널이면 wantChannel null', r.data?.project?.wantChannel === null && r.data.project.wantPlot === null)
  r = await ms(p1, { channel: 2, plot: 19 })
  ok('관리 저장: 채널 2 · 19번(찬 자리) → 409 plot', r.status === 409 && r.data?.reason === 'plot', `${r.status} ${JSON.stringify(r.data)}`)
  r = await ms(p1, { channel: 1, plot: 5 })
  ok('관리 저장: 채널 1 · 5번', r.status === 200 && r.data.project.wantChannel === 1 && r.data.project.wantPlot === 5, `${r.status} ${JSON.stringify(r.data?.project ?? r.data).slice(0, 160)}`)
  r = await ms(p1, { plot: 2 })
  ok('관리 저장: 자리만 보내면 채널은 그대로(1)', r.status === 200 && r.data.project.wantChannel === 1 && r.data.project.wantPlot === 2)
  r = await ms(p1, { channel: 3, plot: 19 })
  ok('관리 저장: 다시 채널 3 · 19번', r.status === 200 && r.data.project.wantChannel === 3 && r.data.project.wantPlot === 19)
  r = await ms(p1, { channel: 0 })
  ok('관리 저장: 채널 0 → 400 channel', r.status === 400 && r.data?.reason === 'channel')

  /* ═══ 3. 운영자 승인 · 옮기기 ═══ */
  console.log('── 3. 운영자')
  r = await req('POST', '/api/admin/login', { body: { password: PW } })
  const C = (r.headers.get('set-cookie') || '').split(';')[0]
  ok('운영자 로그인', r.status === 200 && C.startsWith('shrine_admin='))
  const aget = path => req('GET', `/api/admin/${path}`, { cookie: C, origin: null })
  const apost = (path, body) => req('POST', `/api/admin/${path}`, { body, cookie: C })
  r = await aget(`project?id=${p1.data.id}`)
  ok('운영: 접수 자세히 wantChannel 3 · 채널별 빈 자리', r.data?.project?.wantChannel === 3 && r.data.freePlots?.[1]?.length === 18 && r.data.freePlots[2].length === 18 && r.data.freePlots[3].length === 20 && r.data.channels === 3,
    JSON.stringify({ w: r.data?.project?.wantChannel, f: Object.fromEntries(Object.entries(r.data?.freePlots ?? {}).map(([k, v]) => [k, v.length])) }))
  r = await apost('project/approve', { id: p1.data.id })
  ok('승인: 고른 채널 3 · 19번에 (자동)', r.status === 200 && /채널 3 · 자리 19/.test(r.data.message), r.data?.message)
  const p1slug = r.data?.project?.slug
  w = await world()
  ok('world: 승인한 사당이 채널 3 · 19번', at(w.shrines, p1slug)?.channel === 3 && at(w.shrines, p1slug)?.plot === 19)
  ok('world: 같은 19번 사당 세 채널에 하나씩', w.shrines.filter(s => s.plot === 19).map(s => s.channel).sort().join(',') === '1,2,3')
  r = await apost('project/approve', { id: p2.data.id })
  ok('승인: 채널 2 · 자리 아무 데나 → 채널 2 첫 빈 자리 0', r.status === 200 && /채널 2 · 자리 0/.test(r.data.message), r.data?.message)
  r = await apost('project/approve', { id: p3.data.id, channel: 1 })
  ok('승인: 운영자가 채널 1 (작성자가 고른 채널) → 원한 자리 4', r.status === 200 && /채널 1 · 자리 4/.test(r.data.message), r.data?.message)
  let c = cli(['approve', String(p4.data.id), '-', '2'])
  ok('cli approve <id> - 2: 다른 채널을 정하면 그 채널 첫 빈 자리 1', c.status === 0 && /채널 2 · 자리 1/.test(c.stdout), (c.stdout + c.stderr).trim())
  r = await apost('project/approve', { id: p5.data.id, channel: 3, plot: 19 })
  ok('승인: 채널 3 · 19번(찬 자리) → 409', r.status === 409 && /이미 사당이 있는 자리/.test(r.data.message), r.data?.message)
  r = await apost('project/approve', { id: p5.data.id, channel: 4 })
  ok('승인: 채널 4 → 400', r.status === 400)
  // 채널 3을 꽉 채우고 (cli), 채널 3을 고른 접수를 자동 승인 → 1번 채널부터 빈 자리로
  for (let plot = 0; plot < 19; plot++) {
    const x = cli(['add', '-'], JSON.stringify(shrine(`fill-${plot}`, 3, plot)))
    if (x.status !== 0) throw new Error(`fill ${plot}: ${x.stderr}`)
  }
  r = await aget('dashboard')
  ok('대시보드: 채널 3 빈 자리 0 · 합계', r.data?.shrines?.freeByChannel?.[3] === 0 && r.data.shrines.plots === 60 && r.data.shrines.free === 60 - r.data.shrines.total, JSON.stringify(r.data?.shrines))
  r = await apost('project/approve', { id: p5.data.id, channel: 3 })
  ok('승인: 운영자가 꽉 찬 채널 3을 정하면 → 409 (다른 채널로 안 감)', r.status === 409 && /채널 3에는 빈 사당 자리가 없습니다/.test(r.data.message), r.data?.message)
  r = await apost('project/approve', { id: p5.data.id })
  ok('승인: 고른 채널 3이 꽉 찼고 운영자가 안 정함 → 채널 1 첫 빈 자리 0', r.status === 200 && /채널 1 · 자리 0/.test(r.data.message), r.data?.message)
  r = await apost('project/approve', { id: p6.data.id })
  ok('승인: 아무 채널 → 채널 1 첫 빈 자리 1', r.status === 200 && /채널 1 · 자리 1/.test(r.data.message), r.data?.message)

  r = await aget('shrines')
  ok('운영: 사당 목록에 channel · 채널별 빈 자리', r.data?.shrines?.every(s => [1, 2, 3].includes(s.channel)) && Array.isArray(r.data.freePlots?.[2]) && r.data.freePlots[3].length === 0 && r.data.plots === 20 && r.data.channels === 3)
  r = await apost('shrine/move', { slug: 'one-b', channel: 2, plot: 19 })
  ok('옮기기: 채널 2 · 19번(찬 자리) → 409', r.status === 409, r.data?.message)
  r = await apost('shrine/move', { slug: 'one-b', channel: 2, plot: 7 })
  ok('옮기기: 채널 1 · 18 → 채널 2 · 7', r.status === 200 && r.data.shrine.channel === 2 && r.data.shrine.plot === 7, JSON.stringify(r.data).slice(0, 120))
  w = await world()
  ok('world: 옮긴 사당이 채널 2 · 7번', at(w.shrines, 'one-b')?.channel === 2 && at(w.shrines, 'one-b')?.plot === 7)
  r = await apost('shrine/move', { slug: 'one-b', plot: 9 })
  ok('옮기기: 채널 빼면 지금 채널(2) 안에서', r.status === 200 && r.data.shrine.channel === 2 && r.data.shrine.plot === 9)
  r = await apost('shrine/move', { slug: 'one-b', channel: 1, plot: 18 })
  ok('옮기기: 다시 채널 1 · 18', r.status === 200 && r.data.shrine.channel === 1 && r.data.shrine.plot === 18)
  r = await apost('shrine/move', { slug: 'one-b', channel: 'x', plot: 3 })
  ok('옮기기: 채널 x → 400', r.status === 400, r.data?.message)
  r = await aget('log?limit=50')
  ok('기록: 채널을 옮기면 채널까지 남음', r.data?.log?.some(x => x.action === 'shrine-move' && x.target === 'one-b' && x.detail === '채널 1 · 18번 → 채널 2 · 7번') && r.data.log.some(x => x.action === 'shrine-move' && x.detail === '7 → 9'),
    JSON.stringify(r.data?.log?.filter(x => x.action === 'shrine-move').map(x => x.detail)))
  // 사당 추가 (이미지 필요)
  const up = await apost('upload', { data: png(64, 40).toString('base64') })
  const addBody = { name: '운영 채널 사당', tagline: '운영자가 채널을 정해 세운 사당', category: 'devtools', url: 'https://ops-chan.example.com', screen: up.data?.id }
  r = await apost('shrine/add', { ...addBody, channel: 2, plot: 19 })
  ok('추가: 채널 2 · 19번(찬 자리) → 409', r.status === 409, r.data?.message)
  r = await apost('shrine/add', { ...addBody, channel: 2 })
  ok('추가: 채널 2 · 자동 → 채널 2 첫 빈 자리 (2)', r.status === 201 && r.data.shrine.channel === 2 && r.data.shrine.plot === 2, JSON.stringify(r.data).slice(0, 140))
  r = await apost('shrine/add', { ...addBody, url: 'https://ops-chan-3.example.com', channel: 3 })
  ok('추가: 꽉 찬 채널 3 → 409', r.status === 409 && /채널 3에는 빈 사당 자리가 없습니다/.test(r.data?.message), r.data?.message)

  /* ═══ 4. 실시간: 내 채널 사당에만 초 ═══ */
  console.log('── 4. 실시간 초 켜기')
  w = await world()
  const plot19 = w.world.plots[19]
  function connect(cookie, ch) {
    return new Promise(resolve => {
      const ws = new WebSocket(`ws://${HP}/ws?ch=${ch}`, { headers: { Cookie: cookie }, origin: B })
      const inbox = []
      ws.on('message', d => inbox.push(JSON.parse(d.toString())))
      ws.on('open', () => resolve({ ws, inbox }))
      ws.on('unexpected-response', (_q, res) => resolve({ ws, inbox, status: res.statusCode }))
      ws.on('error', () => {})
    })
  }
  async function waitFor(cn, pred, ms = 2000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const i = cn.inbox.findIndex(pred)
      if (i >= 0) return cn.inbox.splice(i, 1)[0]
      await sleep(20)
    }
    return null
  }
  async function walkTo(cn, from, to) {
    let { x, y } = from
    while (Math.hypot(to.x - x, to.y - y) > 1) {
      await sleep(100)
      const dx = to.x - x, dy = to.y - y, len = Math.hypot(dx, dy), step = Math.min(6.5, len)
      x += dx / len * step; y += dy / len * step
      cn.ws.send(JSON.stringify({ t: 'mv', x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, d: 1, m: true }))
    }
    await sleep(150)
    return !cn.inbox.some(m => m.t === 'fix')
  }
  const light = async (cn, slug) => {
    cn.ws.send(JSON.stringify({ t: 'light', s: slug, p: 'deploy' }))
    return waitFor(cn, m => m.t === 'lit' && m.s === slug)
  }
  const x2 = await connect(await enter('10.2.0.2'), 2)
  const h2 = await waitFor(x2, m => m.t === 'hello')
  ok('채널 2 접속', h2?.channel === 2)
  ok('채널 2: 19번 앞까지 걸어감', await walkTo(x2, h2.me, plot19.front))
  let lit = await light(x2, 'one-a')
  ok('채널 2에서 채널 1 사당(같은 19번 자리) → channel', lit?.ok === false && lit.reason === 'channel', JSON.stringify(lit))
  lit = await light(x2, p1slug)
  ok('채널 2에서 채널 3 사당(같은 19번 자리) → channel', lit?.ok === false && lit.reason === 'channel', JSON.stringify(lit))
  lit = await light(x2, 'two-a')
  ok('채널 2에서 채널 2 사당 → 켜짐', lit?.ok === true, JSON.stringify(lit))
  const x1 = await connect(await enter('10.2.0.1'), 1)
  const h1 = await waitFor(x1, m => m.t === 'hello')
  ok('채널 1 접속', h1?.channel === 1)
  ok('채널 1: 19번 앞까지 걸어감', await walkTo(x1, h1.me, plot19.front))
  lit = await light(x1, 'two-a')
  ok('채널 1에서 채널 2 사당 → channel', lit?.ok === false && lit.reason === 'channel', JSON.stringify(lit))
  lit = await light(x1, 'one-a')
  ok('채널 1에서 채널 1 사당 → 켜짐', lit?.ok === true, JSON.stringify(lit))
  lit = await light(x1, 'one-b')
  ok('채널 1에서 멀리 있는 채널 1 사당(18번) → far', lit?.ok === false && lit.reason === 'far', JSON.stringify(lit))
  x1.ws.close()
  x2.ws.close()
} catch (e) {
  ok('예외', false, e?.stack ?? e)
} finally {
  await D.stopServer(srv)
}
if (/Error|오류/.test(srv.out) && /at /.test(srv.out)) console.log('서버 로그:\n' + srv.out.slice(-1500))
await T.done()
