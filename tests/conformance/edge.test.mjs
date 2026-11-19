// 화면 시험 (headless Edge): 채널마다 그 채널 사당만 보이는지, 채널을 옮기면 바뀌는지, 등록소 채널 고르기, 375px, 운영자 화면.
// 자체 서버 127.0.0.1:3350 (새 DATA_DIR), Edge 원격 디버깅 9521. 끝나면 모두 끕니다. run.mjs는 --browser일 때만 이 묶음을 돌립니다.
//   SHRINE_TARGET=node|py node tests/conformance/edge.test.mjs --browser   (Edge 경로: SHRINE_EDGE)
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import * as D from './driver.mjs'
import { suite } from './lib/check.mjs'

const DATA = await D.freshDataDir('edge')
const SHOTS = join(D.RUN_DIR, 'edge-shots')
const EDGE = D.EDGE
const CDP_PORT = 9521
const PORT = D.PORTS.edge
const B = `http://127.0.0.1:${PORT}`
const PW = 'edge-test-admin-pw-0123456789abc'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const T = suite('edge')
const ok = T.ok

function png(w, h, rgb) {
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
  return { ...e, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, TRUST_PROXY: 'false', GITHUB_CHECK: 'off', TICKET_SECRET: randomBytes(32).toString('hex'), ADMIN_PASSWORD: PW }
})()
const cli = (args, input) => D.cli(args, { env, input })

/* ── 준비: 채널 1 사당 둘(19 · 18번), 채널 2 사당 둘(19 · 4번), 채널 3은 비움 ── */
mkdirSync(SHOTS, { recursive: true })
const upload = rgb => {
  const r = cli(['upload', '-'], png(320, 180, rgb))
  const m = /up\/([A-Za-z0-9_-]{16}\.(?:png|jpg|webp))/.exec(r.stdout)
  if (!m) throw new Error(`upload: ${r.stdout}${r.stderr}`)
  return `up/${m[1]}`
}
const shrine = (slug, name, sign, channel, plot, rgb) => ({
  slug, name, tagline: `${name} 시험 사당`, category: 'devtools', domain: `${slug}.example.com`, url: `https://${slug}.example.com`,
  operator: '시험', keeper: false, paid: false, verifiedDomain: '2026-11-18', verifiedBusiness: null, joinedAt: '2026-11-18',
  status: 'live', prayer: 'deploy', charm: null, deco: [], screens: [upload(rgb)], capturedAt: '2026-11-18', sign, channel, plot,
})
for (const s of [
  shrine('one-gong', '일번 공시', '채널1 사당', 1, 19, [200, 60, 60]),
  shrine('one-steady', '일번 스레드', '채널1 둘째', 1, 18, [60, 200, 60]),
  shrine('two-shrine', '이번 사당', '채널2 사당', 2, 19, [60, 60, 200]),
  shrine('two-bot', '이번 봇', '채널2 봇', 2, 4, [200, 200, 60]),
]) {
  const r = cli(['add', '-'], JSON.stringify(s))
  if (r.status !== 0) throw new Error(`seed ${s.slug}: ${r.stderr}`)
}
const CH1 = ['일번 공시', '일번 스레드']
const CH2 = ['이번 사당', '이번 봇']

const srv = await D.startServer(env)
const worldData = await (await fetch(`${B}/api/world`)).json()
const WW = { w: worldData.world.w, h: worldData.world.h }
const plot19 = worldData.world.plots[19].front
const regFront = worldData.world.registryFront

const prof = join(D.RUN_DIR, `edge-prof-${Date.now()}`)
const edge = D.trackProcess(spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' }))
const consoleErrors = []
try {
  let targets = []
  for (let i = 0; i < 80; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); if (targets.some(t => t.type === 'page')) break } catch {}
    await sleep(250)
  }
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl)
  await new Promise(res => ws.addEventListener('open', res))
  let id = 0
  const pending = new Map()
  let phase = 'game'
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(`[${phase}] EXC ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`)
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(`[${phase}] ERR ${m.params.args.map(a => a.value ?? a.description).join(' ')}`)
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleErrors.push(`[${phase}] LOG ${m.params.entry.source}: ${m.params.entry.text} ${m.params.entry.url ?? ''}`)
  })
  const cmd = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  const evalJs = async expr => {
    const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) throw new Error(`evalJs: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`)
    return r.result?.result?.value
  }
  const shot = async name => writeFileSync(`${SHOTS}/${name}.png`, Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'))
  const view = (w, h, mobile = false) => cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile })
  const until = async (expr, ms = 8000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await evalJs(expr)) return true
      await sleep(150)
    }
    return false
  }
  const key = async (k, code, vk) => {
    await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(k === ' ' ? { text: ' ' } : k === 'Enter' ? { text: String.fromCharCode(13) } : {}) })
    await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  }
  /** 미니맵에서 맵 좌표 (x, y)를 누릅니다 (그곳으로 걸어감) */
  const walkVia = async (x, y) => {
    const pt = await evalJs(`(() => {
      const cv = document.querySelector('#minimap'); const r = cv.getBoundingClientRect()
      const cw = cv.clientWidth, ch = cv.clientHeight, s = Math.min(cw / ${WW.w}, ch / ${WW.h})
      const ox = (cw - ${WW.w} * s) / 2, oy = (ch - ${WW.h} * s) / 2
      return [r.left + cv.clientLeft + ox + ${x} * s, r.top + cv.clientTop + oy + ${y} * s]
    })()`)
    await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt[0], y: pt[1], button: 'left', clickCount: 1 })
    await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt[0], y: pt[1], button: 'left', clickCount: 1 })
  }
  const listNames = () => evalJs(`[...document.querySelectorAll('#shrineList button')].map(b => b.textContent.split(' · ')[0])`)
  const actText = () => evalJs(`document.querySelector('#actBtn').textContent`)

  await cmd('Runtime.enable'); await cmd('Page.enable'); await cmd('Log.enable')
  await view(1280, 900)
  await cmd('Page.navigate', { url: `${B}/` })
  await until(`!!document.querySelector('#enterBtn') && !document.querySelector('#enterBtn').disabled`)
  await evalJs(`document.querySelector('#enterBtn').click(); true`)
  ok('입장 → 채널 1', await until(`/채널 1 ·/.test(document.querySelector('#hudChannel').textContent)`), await evalJs(`document.querySelector('#hudChannel').textContent`))

  /* ── 채널 1: 채널 1 사당만 ── */
  let names = await listNames()
  ok('채널 1: 사당 목록은 채널 1 사당만', CH1.every(n => names.includes(n)) && !CH2.some(n => names.includes(n)) && names.length === 2, names.join(', '))
  await walkVia(plot19.x, plot19.y)
  ok('채널 1: 19번 앞 → 채널 1 사당(일번 공시)이 가까이', await until(`document.querySelector('#actBtn').textContent.includes('일번 공시')`, 12000), await actText())
  await evalJs(`document.querySelector('#view').focus(); true`)
  await key(' ', 'Space', 32)
  ok('채널 1: Space → 일번 공시 사당 창 (채널 1 표시)', await until(`!document.querySelector('#sheet').hidden && document.querySelector('#sheetTitle')?.textContent === '일번 공시' && [...document.querySelectorAll('#sheet .badge')].some(b => b.textContent === '채널 1')`),
    await evalJs(`document.querySelector('#sheetTitle')?.textContent + ' / ' + [...document.querySelectorAll('#sheet .badge')].map(b => b.textContent).join(',')`))
  await sleep(400)
  await shot('c1-ch1-sheet')

  /* ── 채널 2로 옮기기 ── */
  phase = 'switch'
  await evalJs(`document.querySelector('#hudChannel').click(); true`)
  ok('채널 창 열림', await until(`!document.querySelector('#chanPop').hidden && [...document.querySelectorAll('#chanPop button span')].some(s => s.textContent === '채널 2')`))
  await evalJs(`[...document.querySelectorAll('#chanPop button')].find(b => b.querySelector('span')?.textContent === '채널 2').click(); true`)
  ok('채널 2로 옮김', await until(`/채널 2 ·/.test(document.querySelector('#hudChannel').textContent)`), await evalJs(`document.querySelector('#hudChannel').textContent`))
  ok('채널을 옮기면 채널 1 사당 창은 닫힘', await evalJs(`document.querySelector('#sheet').hidden`))
  names = await listNames()
  ok('채널 2: 사당 목록은 채널 2 사당만', CH2.every(n => names.includes(n)) && !CH1.some(n => names.includes(n)) && names.length === 2, names.join(', '))
  await walkVia(plot19.x, plot19.y)
  ok('채널 2: 같은 19번 앞 → 채널 2 사당(이번 사당)이 가까이', await until(`document.querySelector('#actBtn').textContent.includes('이번 사당')`, 12000), await actText())
  await evalJs(`document.querySelector('#actBtn').click(); true`)
  ok('채널 2: 이번 사당 창 (채널 2 표시)', await until(`!document.querySelector('#sheet').hidden && document.querySelector('#sheetTitle')?.textContent === '이번 사당' && [...document.querySelectorAll('#sheet .badge')].some(b => b.textContent === '채널 2')`),
    await evalJs(`document.querySelector('#sheetTitle')?.textContent`))
  await sleep(500)
  await shot('c2-ch2-sheet')
  // 초 켜기 (채널 2 사당) → 서버가 받아 줌
  await evalJs(`document.querySelector('#lightBtn').click(); true`)
  ok('채널 2: 이번 사당에 초 켜짐 (안내)', await until(`document.querySelector('#toast').textContent.includes('이번 사당에')`, 4000), await evalJs(`document.querySelector('#toast').textContent`))

  /* ── 채널 3: 사당 없음 ── */
  await evalJs(`document.querySelector('#hudChannel').click(); true`)
  await until(`!document.querySelector('#chanPop').hidden && [...document.querySelectorAll('#chanPop button span')].some(s => s.textContent === '채널 3')`)
  await evalJs(`[...document.querySelectorAll('#chanPop button')].find(b => b.querySelector('span')?.textContent === '채널 3').click(); true`)
  ok('채널 3으로 옮김', await until(`/채널 3 ·/.test(document.querySelector('#hudChannel').textContent)`))
  names = await listNames()
  ok('채널 3: 사당 목록 비어 있음', names.length === 0, names.join(', '))
  await walkVia(plot19.x, plot19.y)
  ok('채널 3: 19번 앞은 빈 자리', await until(`document.querySelector('#actBtn').textContent === '빈 자리 보기'`, 12000), await actText())
  await shot('c3-ch3-empty')

  /* ── 다시 채널 2, 등록소에서 채널 고르기 ── */
  phase = 'registry'
  await evalJs(`document.querySelector('#hudChannel').click(); true`)
  await until(`!document.querySelector('#chanPop').hidden && [...document.querySelectorAll('#chanPop button span')].some(s => s.textContent === '채널 2')`)
  await evalJs(`[...document.querySelectorAll('#chanPop button')].find(b => b.querySelector('span')?.textContent === '채널 2').click(); true`)
  await until(`/채널 2 ·/.test(document.querySelector('#hudChannel').textContent)`)
  await walkVia(regFront.x, regFront.y + 2)
  ok('등록소 앞', await until(`document.querySelector('#actBtn').textContent === '프로젝트 등록소'`, 14000), await actText())
  await evalJs(`document.querySelector('#actBtn').click(); true`)
  ok('등록소 창 열림', await until(`document.querySelector('#regModal').open && !!document.querySelector('.rplot-chans')`))
  const pick = () => evalJs(`(() => {
    const chips = [...document.querySelectorAll('.rplot-chans .chip')]
    const on = chips.find(c => c.getAttribute('aria-checked') === 'true')
    const btns = [...document.querySelectorAll('#regModal .rplot-map button')]
    return { chips: chips.length, on: on ? on.firstChild.textContent : '', taken: btns.map((b, i) => b.disabled ? i : -1).filter(i => i >= 0),
      sel: btns.map((b, i) => b.classList.contains('on') ? i : -1).filter(i => i >= 0), status: document.querySelector('#regModal .rplot-status').textContent,
      legend: [...document.querySelectorAll('#regModal legend')].map(l => l.textContent).join(' | ') }
  })()`)
  let p = await pick()
  ok('등록소: 채널 고르기 3개 · 처음은 지금 채널(2)', p.chips === 3 && p.on === '채널 2', JSON.stringify(p))
  ok('등록소: 채널 2 지도는 채널 2 사당 자리(4 · 19번)만 막힘', JSON.stringify(p.taken) === '[4,19]', JSON.stringify(p.taken))
  const clickChip = n => evalJs(`[...document.querySelectorAll('.rplot-chans .chip')].find(c => c.firstChild.textContent === '채널 ${n}').click(); true`)
  await clickChip(1)
  p = await pick()
  ok('등록소: 채널 1 → 18 · 19번 막힘', p.on === '채널 1' && JSON.stringify(p.taken) === '[18,19]', JSON.stringify(p))
  await clickChip(3)
  p = await pick()
  ok('등록소: 채널 3 → 막힌 자리 없음', p.on === '채널 3' && p.taken.length === 0, JSON.stringify(p))
  await evalJs(`document.querySelectorAll('#regModal .rplot-map button')[19].click(); true`)
  p = await pick()
  ok('등록소: 채널 3 · 19번 고름', JSON.stringify(p.sel) === '[19]' && /채널 3/.test(p.status) && /19번/.test(p.status), p.status)
  await clickChip(2)
  p = await pick()
  ok('등록소: 19번이 막힌 채널 2로 바꾸면 자리 고름이 풀림', p.sel.length === 0 && p.status === '채널 2 · 빈 자리 아무 데나', JSON.stringify(p))
  // 키보드: 채널 칩에 초점 → Enter
  await evalJs(`[...document.querySelectorAll('.rplot-chans .chip')].find(c => c.firstChild.textContent === '채널 3').focus(); true`)
  await key('Enter', 'Enter', 13)
  p = await pick()
  ok('등록소: 키보드(Enter)로 채널 3 고름', p.on === '채널 3', JSON.stringify(p))
  await evalJs(`document.querySelectorAll('#regModal .rplot-map button')[7].click(); true`)
  await shot('r1-registry-ch3')

  /* ── 375px ── */
  phase = 'mobile'
  await view(375, 812, true)
  await sleep(600)
  const m = await evalJs(`(() => {
    const body = document.querySelector('#regModal .modal-body'), modal = document.querySelector('#regModal')
    const mr = modal.getBoundingClientRect()
    const chips = [...document.querySelectorAll('.rplot-chans .chip')].map(c => c.getBoundingClientRect())
    const map = document.querySelector('#regModal .rplot-map').getBoundingClientRect()
    return { docW: document.documentElement.scrollWidth, inner: innerWidth, bodyOver: body.scrollWidth - body.clientWidth,
      modalL: mr.left, modalR: mr.right, chipsR: Math.max(...chips.map(r => r.right)), chipsRows: new Set(chips.map(r => Math.round(r.top))).size, mapW: map.width }
  })()`)
  ok('375px: 가로 넘침 없음 (문서 · 등록소 창)', m.docW <= 375 && m.bodyOver <= 0 && m.modalL >= 0 && m.modalR <= 375, JSON.stringify(m))
  ok('375px: 채널 칩 세 개가 창 안에 (한 줄)', m.chipsR <= m.modalR && m.chipsRows === 1, JSON.stringify(m))
  await evalJs(`document.querySelector('.rplot-chans').scrollIntoView({ block: 'center' }); true`)
  await sleep(200)
  await shot('r2-registry-375')

  /* ── 접수 (채널 3 · 7번) ── */
  await view(1280, 900)
  await sleep(300)
  await evalJs(`(() => {
    const f = document.querySelector('#regModal form.rform')
    const set = (n, v) => { const i = f.querySelector('[name=' + n + ']'); i.value = v; i.dispatchEvent(new Event('input')) }
    set('name', '채널 화면 접수'); set('tagline', '화면에서 채널 3을 고른 접수'); set('url', 'https://ui-channel.example.dev')
    set('email', 'ui@example.com'); set('pin', '1234')
    f.querySelector('[name=consent]').checked = true
    f.requestSubmit()
    return true
  })()`)
  ok('접수됨', await until(`!!document.querySelector('#regModal .rdone')`, 6000), await evalJs(`document.querySelector('#regModal .rf.bad .rf-err')?.textContent ?? ''`))
  /* ── 관리하기(수정): 고른 채널 · 자리 그대로, 바꿔 저장 ── */
  await evalJs(`[...document.querySelectorAll('#regTabs button')].find(b => b.textContent === '관리하기').click(); true`)
  await until(`!!document.querySelector('#regModal form.rlogin')`)
  await evalJs(`(() => {
    const f = document.querySelector('#regModal form.rlogin')
    f.querySelector('[name=email]').value = 'ui@example.com'; f.querySelector('[name=pin]').value = '1234'
    f.requestSubmit(); return true
  })()`)
  ok('관리하기: 수정 화면 열림', await until(`!!document.querySelector('#regModal .redit-head') && !!document.querySelector('#regModal .rplot-chans')`, 6000))
  p = await pick()
  ok('관리하기: 고른 채널 3 · 7번 그대로', p.on === '채널 3' && JSON.stringify(p.sel) === '[7]', JSON.stringify(p))
  await clickChip(1)
  await evalJs(`(() => { const f = [...document.querySelectorAll('#regModal form.rform')].pop(); f.requestSubmit(); return true })()`)
  await until(`document.querySelector('#toast').textContent.includes('저장했어요')`, 5000)
  p = await pick()
  ok('관리하기: 채널 1로 바꿔 저장 (7번은 채널 1에서도 비어 있어 그대로)', p.on === '채널 1' && JSON.stringify(p.sel) === '[7]', JSON.stringify(p))
  await clickChip(3)
  await evalJs(`(() => { const f = [...document.querySelectorAll('#regModal form.rform')].pop(); f.requestSubmit(); return true })()`)
  await sleep(800)
  p = await pick()
  ok('관리하기: 다시 채널 3으로', p.on === '채널 3' && JSON.stringify(p.sel) === '[7]', JSON.stringify(p))
  await evalJs(`document.querySelector('#regClose').click(); true`)

  /* ── 운영자 화면: 원하는 채널 · 자리, 채널 골라 승인, 옮기기 고르기 ── */
  phase = 'admin'
  await cmd('Page.navigate', { url: `${B}/admin` })
  await until(`!!document.querySelector('#loginForm')`)
  await evalJs(`(() => { document.querySelector('#password').value = ${JSON.stringify(PW)}; document.querySelector('#loginForm').requestSubmit(); return true })()`)
  ok('운영자 로그인', await until(`document.querySelector('.adm-head h1')?.textContent === '대시보드'`, 6000))
  ok('대시보드: 채널별 빈 사당 자리', await until(`[...document.querySelectorAll('.tbl td')].some(td => td.textContent === '18칸') && [...document.querySelectorAll('.tbl td')].some(td => td.textContent === '20칸')`))
  await evalJs(`location.hash = '#projects?f=pending&id=1'; true`)
  ok('접수 자세히: 원하는 채널 · 자리 = 채널 3 · 7번', await until(`(document.querySelector('.detail')?.textContent ?? '').includes('채널 3 · 7번 · 위쪽 골목')`), await evalJs(`[...document.querySelectorAll('.detail .dl div')].map(d => d.textContent).find(t => t.startsWith('원하는')) ?? ''`))
  const adminPick = () => evalJs(`(() => {
    const w = document.querySelector('.detail .rplot')
    const btns = [...w.querySelectorAll('.rplot-map button')]
    return { ch: w.querySelector('select[name=channel]').value, want: btns.map((b, i) => b.classList.contains('want') ? i : -1).filter(i => i >= 0),
      taken: btns.map((b, i) => b.disabled ? i : -1).filter(i => i >= 0), auto: w.querySelector('select[name=plot] option')?.textContent }
  })()`)
  let ap = await adminPick()
  ok('승인 고르기: 처음 채널 3 · 원한 자리 7 표시 · 자동은 원하는 자리', ap.ch === '3' && JSON.stringify(ap.want) === '[7]' && ap.taken.length === 0 && ap.auto === '자동: 원하는 자리 7번', JSON.stringify(ap))
  await evalJs(`(() => { const s = document.querySelector('.detail .rplot select[name=channel]'); s.value = '2'; s.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
  ap = await adminPick()
  ok('승인 고르기: 채널 2로 바꾸면 4 · 19번 막힘, 자동은 첫 빈 자리', ap.ch === '2' && JSON.stringify(ap.taken) === '[4,19]' && ap.want.length === 0 && ap.auto === '자동: 첫 빈 자리 (0번)', JSON.stringify(ap))
  await evalJs(`(() => { const s = document.querySelector('.detail .rplot select[name=channel]'); s.value = '3'; s.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
  await shot('a1-admin-project')
  await evalJs(`[...document.querySelectorAll('.detail button')].find(b => b.textContent === '승인하고 사당 세우기').click(); true`)
  ok('승인 → 채널 3 · 7번', await until(`document.querySelector('#toast')?.textContent.includes('채널 3 · 자리 7')`, 5000), await evalJs(`document.querySelector('#toast')?.textContent`))
  const w2 = await (await fetch(`${B}/api/world`)).json()
  const made = w2.shrines.find(s => s.name === '채널 화면 접수')
  ok('world: 화면에서 승인한 사당이 채널 3 · 7번', made?.channel === 3 && made?.plot === 7, JSON.stringify(made && { c: made.channel, p: made.plot }))
  await evalJs(`location.hash = '#shrines?edit=one-steady'; true`)
  ok('사당 목록: 채널 · 자리 칸', await until(`[...document.querySelectorAll('.tbl th')].some(th => th.textContent === '채널 · 자리') && [...document.querySelectorAll('.tbl td .mono')].some(s => s.textContent === '2 · 19')`))
  ok('사당 자세히: 자리 = 채널 1 · 18번', await until(`(document.querySelector('.detail')?.textContent ?? '').includes('채널 1 · 18번 · 서쪽 비탈 골목')`))
  const movePick = () => evalJs(`(() => {
    const w = [...document.querySelectorAll('.detail .act')].find(a => a.querySelector('h3')?.textContent === '옮기기').querySelector('.rplot')
    const btns = [...w.querySelectorAll('.rplot-map button')]
    return { ch: w.querySelector('select[name=channel]').value, here: btns.map((b, i) => b.classList.contains('here') ? i : -1).filter(i => i >= 0), taken: btns.map((b, i) => b.disabled ? i : -1).filter(i => i >= 0) }
  })()`)
  let mp = await movePick()
  ok('옮기기 고르기: 지금 채널 1 · 지금 자리 18', mp.ch === '1' && JSON.stringify(mp.here) === '[18]' && JSON.stringify(mp.taken) === '[18,19]', JSON.stringify(mp))
  await evalJs(`(() => { const w = [...document.querySelectorAll('.detail .act')].find(a => a.querySelector('h3')?.textContent === '옮기기'); const s = w.querySelector('select[name=channel]'); s.value = '3'; s.dispatchEvent(new Event('change', { bubbles: true })); w.querySelectorAll('.rplot-map button')[12].click(); w.querySelector('.act-row button').click(); return true })()`)
  ok('옮기기: 채널 3 · 12번으로', await until(`document.querySelector('#toast')?.textContent.includes('채널 3 · 12번')`, 5000), await evalJs(`document.querySelector('#toast')?.textContent`))
  await shot('a2-admin-shrine')
  await view(390, 844, true)
  await sleep(800)
  await shot('a3-admin-shrine-390')
  const adminOver = await evalJs(`document.documentElement.scrollWidth - innerWidth`)
  ok('운영자 화면 390px: 가로 넘침 없음', adminOver <= 0, String(adminOver))
  ws.close()
} catch (e) {
  ok('예외', false, e?.stack ?? e)
} finally {
  edge.kill()
  await D.stopServer(srv)
  await sleep(800)
  rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}
const errs = consoleErrors.filter(e => !/status of 401/.test(e))
ok('콘솔 오류 · CSP 위반 · 예외 없음', errs.length === 0, errs.join(' | '))
if (/\bat\b.*\.ts:|Traceback/.test(srv.out)) console.log('서버 로그:\n' + srv.out.slice(-1200))
await T.done()
