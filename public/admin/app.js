// 운영자 화면 (로그인한 세션에만 내려갑니다). 서버가 준 값은 모두 textContent · 속성으로만 넣고 innerHTML은 쓰지 않습니다.
// 화면: 대시보드 · 접속자 · 접수 · 사당 · 게시판 · 설정 · 기록. 주소 뒤 #으로 화면을 고릅니다 (#projects?f=pending&id=3).
import { CATEGORIES, PRAYERS } from '../js/data.js'
import { bakeFloor } from '../js/pixels.js'

const BASE = document.querySelector('meta[name="shrine-base"]')?.content ?? ''
const API = `${BASE}/api/admin`
const main = document.getElementById('main')
const IMG_MAX = 5 * 1024 * 1024
const UPLOAD_RE = /^[A-Za-z0-9_-]{16}\.(?:png|jpg|webp)$/

const STATUS = { pending: '검토 대기', approved: '승인', rejected: '반려', withdrawn: '내림' }
const SHRINE_STATUS = { live: '운영 중', check: '닫힘 · 점검 중' }
const FILTERS = [
  ['review', '검토할 것'], ['pending', '새 접수'], ['changes', '링크 · 이미지 변경'],
  ['approved', '승인'], ['rejected', '반려'], ['withdrawn', '내림'], ['all', '전체'],
]
const ACTIONS = {
  login: '로그인', 'login-fail': '로그인 실패', logout: '로그아웃', upload: '이미지 올림',
  'project-approve': '접수 승인', 'project-reject': '접수 반려',
  'shrine-add': '사당 추가', 'shrine-update': '사당 고침', 'shrine-move': '사당 옮김', 'shrine-remove': '사당 내림',
  'post-hide': '글 숨김', 'post-show': '글 다시 보임', 'post-delete': '글 지움',
  'player-kick': '강퇴', 'player-block': '차단', 'ip-block': 'IP 차단', 'block-remove': '차단 풀기',
  'report-dismiss': '신고 넘김', 'chat-free': '직접 채팅 켜기 · 끄기',
  'project-view': '접수 열람 (이메일)', 'shrines-view': '사당 목록 열람 (이메일)', 'project-erase': '개인정보 파기',
}
const REASONS = {
  bad: '입력 형식이 올바르지 않습니다', origin: '이 화면에서 보낸 요청만 받습니다', session: '로그인이 끝났습니다',
  none: '찾을 수 없습니다', type: 'PNG · JPEG · WebP 이미지만 올릴 수 있습니다', size: '이미지는 5MB까지입니다',
  slow: '이미지를 너무 자주 올렸습니다. 잠시 뒤에 해 주세요', many: '오늘 올릴 수 있는 이미지 수를 넘었습니다',
  full: '이미지 저장 공간이 꽉 찼습니다', net: '서버에 닿지 않습니다',
  gone: '그 사람은 이미 나갔습니다. 신고 목록에 있으면 거기서 차단할 수 있습니다',
}
const FIELD_LABEL = {
  name: '이름', tagline: '한 줄 소개', sign: '지붕 소개', category: '분류', operator: '운영 표시명',
  status: '상태', domain: '도메인', url: '대표 링크', repo: 'GitHub', screens: '이미지',
}

/* ── 작은 도구 ── */

/** 안전한 링크만: 같은 사이트 경로 · # · blob: · https */
function safeUrl(u) {
  const s = String(u)
  if (s.startsWith('#') || s.startsWith('blob:')) return s
  if (s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\')) return s
  try {
    const x = new URL(s)
    if (x.protocol === 'https:') return x.href
  } catch { /* 아래로 */ }
  return '#'
}

/** 요소 만들기. 글자는 텍스트 노드로만 들어갑니다 */
function h(tag, props, ...kids) {
  const el = document.createElement(tag)
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'dataset') Object.assign(el.dataset, v)
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
      else if (['value', 'checked', 'disabled', 'hidden', 'required', 'selected'].includes(k)) el[k] = v
      else if (k === 'href' || k === 'src') el.setAttribute(k, safeUrl(v))
      else el.setAttribute(k, v === true ? '' : String(v))
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false || kid === '') continue
    el.append(kid instanceof Node ? kid : String(kid))
  }
  return el
}

const frag = (...kids) => {
  const f = document.createDocumentFragment()
  for (const k of kids.flat()) if (k) f.append(k)
  return f
}

const TIME = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const fmtTime = ms => (Number.isFinite(ms) ? TIME.format(new Date(ms)) : '-')
const fmtN = n => Number(n ?? 0).toLocaleString('ko-KR')
const plotArea = id => (id < 10 ? '위쪽 골목' : id < 15 ? '서쪽 마당' : '서쪽 비탈 골목')
const plotName = id => `${id}번 · ${plotArea(id)}`
/** 채널 번호들 (1~3). 채널마다 사당 자리 20칸이 따로 있고, 사당은 자기 채널에서만 보입니다 */
const channelIds = W => Array.from({ length: W?.world?.channels ?? 3 }, (_, i) => i + 1)
/** 채널 → 빈 자리 번호들 */
const freeIn = (free, ch) => free?.[ch] ?? []
const freeTotal = free => Object.values(free ?? {}).reduce((a, list) => a + list.length, 0)

let toastTimer = 0
function toast(text) {
  const t = document.getElementById('toast')
  t.textContent = text
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600)
}

const why = d => d?.message || REASONS[d?.reason] || '처리하지 못했습니다'

/** 서버 호출. body가 있으면 POST + JSON */
async function api(path, body) {
  const init = body === undefined
    ? { method: 'GET', cache: 'no-store' }
    : { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  let res
  try {
    res = await fetch(`${API}/${path}`, init)
  } catch {
    return { ok: false, reason: 'net' }
  }
  if (res.status === 401) {
    toast('로그인이 끝났습니다. 다시 로그인해 주세요')
    setTimeout(() => location.reload(), 1200)
    return { ok: false, reason: 'session' }
  }
  return (await res.json().catch(() => null)) ?? { ok: false, reason: 'bad' }
}

/* ── 공통 조각 ── */

function head(title, sub, ...tools) {
  return h('div', { class: 'adm-head' },
    h('div', { class: 'adm-title' }, h('h1', null, title), sub && h('p', { class: 'adm-sub' }, sub)),
    tools.length ? h('div', { class: 'adm-head-tools' }, tools) : null)
}

const panel = (title, ...kids) => h('section', { class: 'panel' }, title && h('h2', null, title), kids)
const errorBox = d => h('p', { class: 'warn' }, why(d))
const empty = text => h('p', { class: 'empty-box' }, text)

function pill(kind, text) {
  return h('span', { class: 'pill', dataset: { k: kind } }, text)
}

function table(cols, rows, { numeric = [], onRow, selected, narrowHide = [] } = {}) {
  const cls = i => [numeric.includes(i) ? 'num' : '', narrowHide.includes(i) ? 'opt' : ''].join(' ').trim() || null
  return h('div', { class: 'tbl-wrap' },
    h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, cols.map((c, i) => h('th', { class: cls(i) }, c)))),
      h('tbody', null, rows.map((r, ri) => {
        const tr = h('tr', { class: [onRow ? 'click' : '', selected === ri ? 'sel' : ''].join(' ').trim() || null },
          r.cells.map((c, i) => h('td', { class: cls(i) }, c)))
        if (onRow) {
          tr.tabIndex = 0
          tr.addEventListener('click', () => onRow(r))
          tr.addEventListener('keydown', e => { if (e.key === 'Enter') onRow(r) })
        }
        return tr
      }))))
}

/** 정의 목록 [이름, 값, 덧붙임] */
function dl(items) {
  return h('dl', { class: 'dl' }, items.filter(Boolean).map(([k, v, extra]) =>
    h('div', null, h('dt', null, k), h('dd', null, v ?? '-', extra ? h('small', null, ` ${extra}`) : null))))
}

const extLink = url => (url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url) : '-')

function thumb(id, label) {
  if (!id || !UPLOAD_RE.test(id)) return null
  const src = `${BASE}/img/shrines/up/${id}`
  return h('figure', { class: 'thumb' }, h('a', { href: src, target: '_blank', rel: 'noopener' }, h('img', { src, alt: label, loading: 'lazy' })), h('figcaption', null, label))
}

/** 입력 칸 묶음 (style.css의 등록소 칸 모양) */
function field(label, control, { help, optional, full } = {}) {
  return h('label', { class: `rf${full ? ' full' : ''}` },
    h('span', { class: 'rf-label' }, label, optional ? h('em', null, '선택') : null), control,
    help ? h('span', { class: 'rf-help' }, help) : null)
}

function input(name, { value = '', max, placeholder, type = 'text' } = {}) {
  return h('input', { name, type, value, maxlength: max, placeholder, autocomplete: 'off', spellcheck: 'false' })
}

function select(name, options, value) {
  const s = h('select', { name }, options.map(([k, label]) => h('option', { value: k }, label)))
  s.value = value ?? options[0]?.[0] ?? ''
  return s
}

function toggle(name, label, checked) {
  return h('label', { class: 'rf-switch' }, h('input', { type: 'checkbox', name, checked: !!checked }), h('span', { class: 'track' }), h('span', null, label))
}

const categoryOptions = () => Object.entries(CATEGORIES)
const prayerOptions = () => PRAYERS.map(p => [p.key, p.label])

/** 버튼을 누르는 동안 다시 못 누르게 */
async function busy(btn, fn) {
  if (btn.disabled) return
  btn.disabled = true
  try {
    await fn()
  } finally {
    btn.disabled = false
  }
}

/* ── 맵 정보 (자리 고르기 그림) ── */

let worldCache = null
async function getWorld() {
  if (worldCache) return worldCache
  try {
    const res = await fetch(`${BASE}/api/world`, { cache: 'no-store' })
    const data = await res.json()
    worldCache = { world: data.world, floor: bakeFloor(data.world), ais: data.world.ais ?? [] }
  } catch {
    worldCache = { world: null, floor: null, ais: [] }
  }
  return worldCache
}

/**
 * 자리 고르기: 채널을 고르고, 작은 지도 위 빈 자리를 누릅니다. 채널마다 자리 20칸이 따로 있고 사당은 자기 채널에서만 보입니다.
 * free = 채널 → 빈 자리 번호들, names = '채널:자리' → 사당 이름, channel = 처음 고른 채널,
 * current · want = 지금 자리 · 작성자가 원한 자리 { channel, plot }.
 * auto면 자리를 '자동'(null)으로 둘 수 있습니다 (autoLabel(채널)이 목록 첫 줄). 고른 값은 picker.channel · picker.value (null = 자동)
 */
function plotPicker(W, { free, names = new Map(), channel = 1, current = null, want = null, auto = false, autoLabel = () => '자동' }) {
  const wrap = h('div', { class: 'rplot' })
  wrap.value = null
  wrap.channel = channel
  const status = h('p', { class: 'rplot-status' })
  const buttons = new Map()
  const chanSel = select('channel', channelIds(W).map(ch => [String(ch), `채널 ${ch} · 빈 자리 ${freeIn(free, ch).length}칸`]), String(channel))
  chanSel.classList.add('plot-select')
  chanSel.setAttribute('aria-label', '채널')
  const list = h('select', { name: 'plot', class: 'plot-select', 'aria-label': '자리' })
  // 목록: 지도를 못 그릴 때(맵 정보를 못 받음)도 고를 수 있게, 고른 채널의 빈 자리만
  const fillList = () => {
    list.textContent = ''
    const opts = [auto ? ['', autoLabel(wrap.channel)] : ['', '자리를 고르세요'], ...freeIn(free, wrap.channel).map(id => [String(id), plotName(id)])]
    for (const [k, label] of opts) list.append(h('option', { value: k }, label))
  }
  const paint = () => {
    const ch = wrap.channel
    const freeSet = new Set(freeIn(free, ch))
    for (const [id, b] of buttons) {
      const isFree = freeSet.has(id)
      const isCurrent = current?.channel === ch && current.plot === id
      const isWant = want?.channel === ch && want.plot === id
      b.className = [isFree ? '' : 'taken', isCurrent ? 'here' : '', isWant ? 'want' : '', id === wrap.value ? 'on' : ''].filter(Boolean).join(' ')
      const label = isCurrent ? `채널 ${ch} · ${plotName(id)} (지금 자리)`
        : isFree ? `채널 ${ch} · ${plotName(id)}${isWant ? ' (작성자가 원한 자리)' : ''}`
          : `채널 ${ch} · ${plotName(id)} · ${names.get(`${ch}:${id}`) ?? '사당 있음'}`
      b.setAttribute('aria-label', label)
      b.title = label
      b.disabled = !isFree
    }
  }
  const update = () => {
    paint()
    list.value = wrap.value == null ? '' : String(wrap.value)
    status.textContent = wrap.value == null
      ? `채널 ${wrap.channel} · ${auto ? '지도나 목록에서 고르지 않으면 자동' : '지도에서 빈 자리를 누르세요'}`
      : `고른 자리: 채널 ${wrap.channel} · ${plotName(wrap.value)}`
    wrap.dispatchEvent(new Event('change'))
  }
  wrap.append(h('div', { class: 'rplot-row rplot-chan' }, h('span', { class: 'rf-label' }, '채널'), chanSel))
  if (W?.world) {
    const world = W.world
    const mapH = world.fenceY ?? world.h
    const map = h('div', { class: 'rplot-map' })
    map.style.aspectRatio = `${world.w} / ${mapH}`
    const cv = h('canvas', { 'aria-hidden': 'true' })
    const scale = 0.5
    cv.width = Math.round(world.w * scale)
    cv.height = Math.round(mapH * scale)
    const c = cv.getContext('2d')
    if (W.floor) c.drawImage(W.floor, 0, 0, world.w, mapH, 0, 0, cv.width, cv.height)
    const mark = (x, y, w, hh, color) => { c.fillStyle = color; c.fillRect(x * scale, y * scale, w * scale, hh * scale) }
    for (const q of world.props ?? []) {
      if (q.k === 'temple') mark(q.x - 44, q.y - 40, 88, 40, 'rgba(232,192,74,.85)')
      else if (q.k === 'trend') mark(q.x - 34, q.y - 30, 68, 30, 'rgba(232,216,168,.9)')
      else if (q.k === 'registry') mark(q.x - 20, q.y - 26, 40, 26, 'rgba(70,224,122,.9)')
    }
    map.append(cv)
    for (const plot of world.plots ?? []) {
      const b = h('button', { type: 'button' })
      b.style.left = `${(plot.x + 4) / world.w * 100}%`
      b.style.top = `${plot.y / mapH * 100}%`
      b.style.width = `${40 / world.w * 100}%`
      b.style.height = `${40 / mapH * 100}%`
      b.append(h('span', null, String(plot.id)))
      b.addEventListener('click', () => { wrap.value = auto && wrap.value === plot.id ? null : plot.id; update() })
      buttons.set(plot.id, b)
      map.append(b)
    }
    wrap.append(map)
  }
  chanSel.addEventListener('change', e => {
    e.stopPropagation()
    wrap.channel = Number(chanSel.value)
    // 다른 채널에서 같은 번호 자리가 비어 있으면 그대로 둡니다
    if (wrap.value != null && !freeIn(free, wrap.channel).includes(wrap.value)) wrap.value = null
    fillList()
    update()
  })
  list.addEventListener('change', e => {
    e.stopPropagation()
    wrap.value = list.value === '' ? null : Number(list.value)
    update()
  })
  wrap.append(h('div', { class: 'rplot-row' }, status, list))
  fillList()
  update()
  return wrap
}

/* ── 이미지 올리기 ── */

/** 가로 · 세로 1280px 안으로 줄여(WebP, 안 되면 JPEG) 메타데이터를 뺀 뒤 base64 JSON으로 올립니다 */
async function uploadImage(file) {
  let blob = file
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height))
    const cv = document.createElement('canvas')
    cv.width = Math.max(1, Math.round(bmp.width * scale))
    cv.height = Math.max(1, Math.round(bmp.height * scale))
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height)
    bmp.close?.()
    const as = (type, q) => new Promise(r => cv.toBlob(b => r(b), type, q))
    blob = (await as('image/webp', 0.86)) ?? blob
    if (blob.type !== 'image/webp') blob = (await as('image/jpeg', 0.86)) ?? file
  } catch { /* 줄이지 못하면 원본 그대로 (서버가 형식 · 크기를 다시 확인) */ }
  if (blob.size > IMG_MAX) return { ok: false, reason: 'size' }
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return api('upload', { data: btoa(bin) })
}

/** 이미지 칸: 고르면 미리 보기. 고른 파일은 box.file */
function imagePicker(currentId, { required } = {}) {
  const box = h('div', { class: 'rf-image' })
  box.file = null
  const preview = h('div', { class: 'rf-preview' })
  const showCurrent = () => {
    preview.replaceChildren(currentId && UPLOAD_RE.test(currentId)
      ? h('img', { src: `${BASE}/img/shrines/up/${currentId}`, alt: '지금 이미지' })
      : h('span', null, required ? '이미지 필요' : '이미지 없음'))
  }
  showCurrent()
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'rf-file' })
  let url = ''
  file.addEventListener('change', () => {
    const f = file.files?.[0]
    if (!f) return
    if (url) URL.revokeObjectURL(url)
    url = URL.createObjectURL(f)
    box.file = f
    preview.replaceChildren(h('img', { src: url, alt: '고른 이미지' }))
    clear.hidden = false
  })
  const pick = h('button', { type: 'button', class: 'btn', onclick: () => file.click() }, currentId ? '이미지 바꾸기' : '이미지 고르기')
  const clear = h('button', { type: 'button', class: 'btn', hidden: true, onclick: () => {
    box.file = null
    file.value = ''
    if (url) URL.revokeObjectURL(url)
    url = ''
    showCurrent()
    clear.hidden = true
  } }, '취소')
  box.append(preview, h('div', { class: 'rf-image-tools' }, pick, clear, file))
  return box
}

/* ── 화면: 대시보드 ── */

function card({ label, value, note, href, alert }) {
  const kids = [h('span', { class: 'card-label' }, label), h('span', { class: 'card-value' }, value), note ? h('span', { class: 'card-note' }, note) : null]
  return href ? h('a', { class: `card${alert ? ' alert' : ''}`, href }, kids) : h('div', { class: `card${alert ? ' alert' : ''}` }, kids)
}

async function viewDashboard() {
  const d = await api('dashboard')
  if (!d.ok) return errorBox(d)
  const ch = d.channels ?? []
  const people = ch.reduce((a, c) => a + c.n, 0)
  const npcs = ch.reduce((a, c) => a + c.npc, 0)
  return frag(
    head('대시보드', '지금 기원소 상태를 한눈에 봅니다', h('button', { class: 'btn btn-sm', type: 'button', onclick: () => route() }, '새로 고침')),
    h('div', { class: 'cards' },
      card({ label: '지금 접속', value: `${fmtN(people)}명`, note: `NPC ${fmtN(npcs)}명은 따로` }),
      card({ label: '오늘 켠 초', value: fmtN(d.candles.today), note: '한국 시간 0시부터' }),
      card({ label: '이번 주 초', value: fmtN(d.candles.week), note: '월요일 0시부터' }),
      card({ label: '사당', value: `${fmtN(d.shrines.total)}곳`, note: `운영 중 ${d.shrines.live} · 닫힘 ${d.shrines.check} · 빈 자리 ${d.shrines.free} (세 채널)`, href: '#shrines' }),
      card({ label: '새 접수', value: fmtN(d.projects.pending), note: '검토를 기다리는 등록', href: '#projects?f=pending', alert: d.projects.pending > 0 }),
      card({ label: '링크 · 이미지 변경', value: fmtN(d.projects.changes), note: '맵에 있는 사당이 바꾼 내용', href: '#projects?f=changes', alert: d.projects.changes > 0 }),
      card({ label: '신고된 글', value: fmtN(d.posts.reported), note: `숨긴 글 ${d.posts.hidden} · 보관 중 ${d.posts.total}`, href: '#posts', alert: d.posts.reported > 0 }),
      card({ label: '접속자 신고', value: fmtN(d.moderation?.reports), note: `차단 ${fmtN(d.moderation?.blocks)} · 강퇴 ${fmtN(d.moderation?.kicks)} · 직접 채팅 ${d.moderation?.freeChat ? '켜짐' : '꺼짐'}`, href: '#people', alert: d.moderation?.reports > 0 }),
    ),
    panel('채널별 인원',
      table(['채널', '사람', 'NPC', '합계', '빈 사당 자리'], ch.map(c => ({
        cells: [`${c.id}번 채널`, fmtN(c.n), fmtN(c.npc), fmtN(c.n + c.npc), d.shrines.freeByChannel?.[c.id] == null ? '-' : `${d.shrines.freeByChannel[c.id]}칸`],
      })), { numeric: [1, 2, 3, 4] }),
      h('p', { class: 'note' }, '사람은 채널당 20명까지 들어옵니다. NPC는 사람이 들어오면 자리를 비켜 줍니다. 사당은 채널마다 따로 서고 자기 채널에서만 보입니다.')),
  )
}

/* ── 화면: 접속자 (신고 · 강퇴 · 차단) ── */

const DURATIONS = [[60, '1시간'], [1440, '1일'], [10080, '7일'], [43200, '30일']]
const BLOCK_KIND = { block: '차단', kick: '강퇴' }
const REPORT_STATE = { open: '처리 전', dismissed: '넘김', kicked: '강퇴함', blocked: '차단함' }

function fmtAgo(sec) {
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s}초`
  if (s < 3600) return `${Math.floor(s / 60)}분`
  return `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분`
}

/** 차단 입력: 기간 · IP까지 · 사유. 누르면 onSubmit({ minutes, ip, reason }) */
function blockControls(onSubmit, { sameIp = 1, label = '차단' } = {}) {
  const dur = select('minutes', DURATIONS.map(([k, l]) => [String(k), l]), '1440')
  dur.classList.add('plot-select')
  const ipBox = h('input', { type: 'checkbox', name: 'ip' })
  const reason = input('reason', { max: 80, placeholder: '사유 (기록에만 남습니다)' })
  const go = h('button', { class: 'btn btn-sm btn-danger', type: 'button' }, label)
  go.addEventListener('click', () => busy(go, async () => {
    if (ipBox.checked && !confirm('IP까지 막으면 같은 IP를 쓰는 다른 사람(통신사 · 회사 · 행사장 Wi-Fi)도 들어오지 못합니다. 막을까요?')) return
    await onSubmit({ minutes: Number(dur.value), ip: ipBox.checked, reason: reason.value })
  }))
  return h('div', { class: 'mod-form' },
    dur,
    h('label', { class: 'mod-check' }, ipBox, h('span', null, sameIp > 1 ? `IP까지 (지금 같은 IP ${sameIp}명)` : 'IP까지')),
    reason, go)
}

async function viewPeople() {
  const [p, r, b] = await Promise.all([api('players'), api('reports'), api('blocks')])
  if (!p.ok) return errorBox(p)
  const done = async (res, text) => {
    if (!res.ok) return toast(why(res))
    toast(text)
    await route()
  }

  // 직접 쓰는 채팅 켜고 끄기 (서버를 다시 띄우면 .env 값)
  const chatBtn = h('button', { class: `btn btn-sm${p.freeChat ? ' btn-danger' : ' btn-main'}`, type: 'button' }, p.freeChat ? '직접 채팅 끄기' : '직접 채팅 켜기')
  chatBtn.addEventListener('click', () => busy(chatBtn, async () => {
    if (p.freeChat && !confirm('직접 쓰는 채팅을 끌까요? 고르는 말풍선만 남습니다.\n서버를 다시 띄우면 .env 값(FREE_CHAT)으로 돌아갑니다.')) return
    await done(await api('chat/free', { on: !p.freeChat }), p.freeChat ? '직접 채팅을 껐습니다' : '직접 채팅을 켰습니다')
  }))

  // 접속자 신고
  const reports = r.ok ? r.reports : []
  const reportItems = reports.map(rep => {
    const open = rep.state === 'open'
    const foot = h('div', { class: 'post-foot' })
    if (open) {
      if (rep.online) {
        const kick = h('button', { class: 'btn btn-sm', type: 'button' }, '강퇴')
        kick.addEventListener('click', () => busy(kick, async () => {
          if (!confirm(`'${rep.nick}'을(를) 내보낼까요? 지금 입장 표가 무효가 되어 사람 확인부터 다시 해야 들어옵니다.`)) return
          await done(await api('report/kick', { id: rep.id }), `내보냈습니다: ${rep.nick}`)
        }))
        foot.append(kick)
      }
      const dismiss = h('button', { class: 'btn btn-sm', type: 'button' }, '넘기기')
      dismiss.addEventListener('click', () => busy(dismiss, async () => done(await api('report/dismiss', { id: rep.id }), '신고를 넘겼습니다')))
      foot.append(dismiss, h('span', { class: 'grow' }),
        blockControls(async v => done(await api('report/block', { id: rep.id, ...v }), `막았습니다: ${rep.nick}`)))
    }
    return h('li', { class: `post-item${open ? ' reported' : ' is-done'}` },
      h('div', { class: 'post-meta' },
        h('strong', null, rep.nick), h('span', null, `${rep.channel}번 채널`),
        pill(open ? 'reported' : 'none', `${REPORT_STATE[rep.state] ?? rep.state} · 신고 ${rep.count}명`),
        pill(rep.online ? 'live' : 'check', rep.online ? '접속 중' : '나감'),
        rep.reasons.map(x => h('span', { class: 'pill' }, `${x.label} ${x.n}`)),
        h('span', null, fmtTime(rep.last)), h('span', { class: 'mono' }, `#${rep.id}`)),
      rep.lines.length
        ? h('ul', { class: 'mod-lines' }, rep.lines.map(l => h('li', null, h('span', { class: 'mute mono' }, fmtTime(l.at)), ' ', l.s)))
        : h('p', { class: 'note' }, '최근 직접 쓴 말풍선이 없습니다 (고르는 말풍선 · 행동만 했을 수 있습니다).'),
      foot)
  })

  // 채널별 접속자
  const people = p.channels.flatMap(ch => ch.players.map(x => ({ ...x, ch: ch.id })))
  const rows = people.map(x => {
    const kick = h('button', { class: 'btn btn-sm', type: 'button' }, '강퇴')
    kick.addEventListener('click', () => busy(kick, async () => {
      if (!confirm(`'${x.nick}'을(를) 내보낼까요? 지금 입장 표가 무효가 되어 사람 확인부터 다시 해야 들어옵니다.`)) return
      await done(await api('player/kick', { id: x.id }), `내보냈습니다: ${x.nick}`)
    }))
    const form = blockControls(async v => done(await api('player/block', { id: x.id, ...v }), `막았습니다: ${x.nick}`), { sameIp: x.sameIp })
    form.hidden = true
    const more = h('button', { class: 'btn btn-sm', type: 'button', 'aria-expanded': 'false' }, '차단…')
    more.addEventListener('click', () => {
      form.hidden = !form.hidden
      more.setAttribute('aria-expanded', String(!form.hidden))
    })
    return {
      cells: [
        `${x.ch}번`,
        h('div', { class: 'cell-main' }, h('strong', null, x.nick), x.reports ? h('small', { class: 'bad-text' }, `신고 ${x.reports}명`) : null),
        h('span', { class: 'mute' }, fmtAgo((Date.now() - x.since) / 1000)),
        h('span', { class: x.idleSec > 600 ? 'mute' : null }, `${fmtAgo(x.idleSec)} 전`),
        x.sameIp > 1 ? `${x.sameIp}명` : '-',
        h('div', { class: 'mod-actions' }, h('div', { class: 'act-row' }, kick, more), form),
      ],
    }
  })

  // 차단 목록
  const blocks = b.ok ? b.blocks : []
  const blockRows = blocks.map(x => {
    const lift = h('button', { class: 'btn btn-sm', type: 'button' }, '풀기')
    lift.addEventListener('click', () => busy(lift, async () => {
      if (!confirm(`${BLOCK_KIND[x.kind] ?? x.kind} #${x.id}${x.nick ? ` (${x.nick})` : ''}를 풀까요?`)) return
      await done(await api('block/remove', { id: x.id }), '풀었습니다')
    }))
    return {
      cells: [
        pill(x.kind === 'block' ? 'rejected' : 'pending', BLOCK_KIND[x.kind] ?? x.kind),
        h('div', { class: 'cell-main' }, h('strong', null, x.nick || '(이름 없음)'), h('small', { class: 'mono' }, `${x.byIp ? 'IP · ' : ''}${x.bySid ? '입장 표 · ' : ''}${x.tag}`)),
        x.reason || '-',
        h('span', { class: 'mute' }, fmtTime(x.at)),
        fmtTime(x.until),
        lift,
      ],
    }
  })

  // IP로 바로 막기 (서버 로그 등에서 본 IP)
  const ipInput = input('ip', { max: 64, placeholder: '203.0.113.7 또는 2001:db8::1' })
  const ipForm = h('div', { class: 'act' },
    h('h3', null, 'IP로 막기'),
    h('p', { class: 'note' }, 'IP 원문은 저장하지 않고 서버 키로 만든 값만 차단 기간 동안 둡니다. IPv6는 /64 대역 전체를 막습니다.'),
    h('div', { class: 'act-row' }, ipInput),
    blockControls(async v => {
      if (!ipInput.value.trim()) return toast('IP를 넣어 주세요')
      await done(await api('block/ip', { ip: ipInput.value.trim(), minutes: v.minutes, reason: v.reason }), 'IP를 막았습니다')
    }, { label: 'IP 차단' }))
  ipForm.querySelector('.mod-check')?.remove()

  const total = people.length
  return frag(
    head('접속자', `지금 ${fmtN(total)}명. 신고 처리 · 강퇴 · 차단을 합니다. 강퇴는 지금 입장 표만 무효로 하고, 차단은 정한 기간 동안 다시 못 들어오게 합니다.`, chatBtn),
    panel(`접속자 신고 (${fmtN(reports.filter(x => x.state === 'open').length)}건 처리 전)`,
      reportItems.length ? h('ul', { class: 'post-list' }, reportItems) : empty('들어온 신고가 없습니다. 신고는 서버 메모리에만 24시간 둡니다.')),
    panel('채널별 접속자',
      rows.length
        ? table(['채널', '닉네임', '머문 시간', '마지막 입력', '같은 IP', '관리'], rows, { narrowHide: [2, 4] })
        : empty('지금 접속한 사람이 없습니다.'),
      h('p', { class: 'note' }, '같은 IP는 지금 같은 IP에서 들어온 연결 수입니다. 여러 명이면 IP 차단이 그 사람들도 막습니다.')),
    panel(`차단 · 강퇴 (${fmtN(blocks.length)})`,
      blockRows.length
        ? table(['종류', '대상', '사유', '걸린 때', '끝나는 때', ''], blockRows, { narrowHide: [2, 3] })
        : empty('걸려 있는 차단이 없습니다.'),
      ipForm),
  )
}

/* ── 화면: 접수 ── */

async function viewProjects(q) {
  const filter = FILTERS.some(([k]) => k === q.get('f')) ? q.get('f') : 'review'
  const selected = Number(q.get('id')) || 0
  const d = await api(`projects?filter=${filter}`)
  if (!d.ok) return errorBox(d)
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': '접수 거르기' },
    FILTERS.map(([k, label]) => h('a', { class: 'chip', href: `#projects?f=${k}`, 'aria-current': k === filter ? 'true' : null }, label)))
  const list = d.projects
  const rows = list.map(p => ({
    id: p.id,
    cells: [
      h('span', { class: 'mono' }, `#${p.id}`),
      h('div', { class: 'cell-main' }, h('strong', null, p.name), h('small', null, p.tagline)),
      h('div', { class: 'cell-pills' }, pill(p.status, STATUS[p.status] ?? p.status), p.changes ? pill('changes', '변경 검토') : null),
      CATEGORIES[p.category] ?? p.category,
      h('span', { class: 'mute' }, fmtTime(p.at)),
    ],
  }))
  const side = h('div', { class: 'split-side' })
  if (selected) side.append(await projectDetail(selected, d.freePlots, filter))
  else side.append(panel(null, empty(list.length ? '목록에서 접수를 고르면 자세히 보고 승인 · 반려할 수 있습니다.' : '여기에 보일 접수가 없습니다.')))
  return frag(
    head('프로젝트 등록소 접수', '등록소로 들어온 프로젝트를 검토합니다. 이메일은 이 화면에서만 보입니다.'),
    chips,
    h('div', { class: 'split' },
      h('div', { class: 'split-main panel' },
        list.length
          ? table(['번호', '프로젝트', '상태', '분류', '접수'], rows, {
            onRow: r => { location.hash = `#projects?f=${filter}&id=${r.id}` },
            narrowHide: [3, 4],
            selected: rows.findIndex(r => r.id === selected),
          })
          : empty('여기에 보일 접수가 없습니다.')),
      side),
  )
}

async function projectDetail(id, freePlots, filter) {
  const [d, W] = await Promise.all([api(`project?id=${id}`), getWorld()])
  if (!d.ok) return panel(null, errorBox(d))
  const p = d.project
  const free = d.freePlots ?? freePlots ?? {}
  // 작성자가 고른 채널 (자리만 골라 둔 예전 접수는 1번 채널, 둘 다 없으면 아무 채널)
  const wantCh = p.wantChannel ?? (p.wantPlot != null ? 1 : null)
  const wish = `${wantCh == null ? '아무 채널' : `채널 ${wantCh}`} · ${p.wantPlot == null ? '아무 자리' : plotName(p.wantPlot)}`
  const after = async r => {
    if (!r.ok) return toast(why(r))
    toast(r.message ?? '처리했습니다')
    await route()
  }
  const box = h('section', { class: 'panel detail' },
    h('div', { class: 'detail-head' },
      h('h2', null, `#${p.id} ${p.name}`),
      pill(p.status, STATUS[p.status] ?? p.status), p.changes ? pill('changes', '변경 검토') : null),
    dl([
      ['한 줄 소개', p.tagline],
      ['지붕 소개', p.sign || '-'],
      ['분류', CATEGORIES[p.category] ?? p.category],
      ['GitHub', extLink(p.github), p.github ? (p.repoOk ? `공개 저장소 확인 · 별 ${fmtN(p.stars)}` : '확인 못 함') : ''],
      ['서비스 주소', extLink(p.url)],
      ['이메일', p.email || '-', p.purgedAt ? '' : p.emailPublic ? '(사당에 공개)' : '(비공개)'],
      ['작성', p.nick, `· ${fmtTime(p.at)}`],
      p.consentAt ? ['수집 동의', fmtTime(p.consentAt)] : null,
      p.reviewAt ? ['검토 대기', `${fmtTime(p.reviewAt)}부터`, '90일이 지나면 저절로 끝납니다'] : null,
      p.closedAt ? ['닫힌 때', fmtTime(p.closedAt), p.purgedAt ? '' : '30일 뒤 개인정보 파기'] : null,
      p.purgedAt ? ['파기', fmtTime(p.purgedAt), '이메일 · 비밀번호 해시 · 링크 · 이미지를 지웠습니다'] : null,
      ['원하는 채널 · 자리', wish],
      p.slug ? ['사당', h('a', { href: `#shrines?edit=${encodeURIComponent(p.slug)}` }, p.slug)] : null,
      p.note ? ['메모', p.note] : null,
    ]),
  )
  const imgs = [thumb(p.screen, '지금 이미지'), p.pendingScreen != null ? (thumb(p.pendingScreen, '바꿀 이미지') ?? h('p', { class: 'note' }, '바꿀 이미지: (지움)')) : null].filter(Boolean)
  if (imgs.length) box.append(h('div', { class: 'thumbs' }, imgs))
  const linkChange = p.pendingGithub != null || p.pendingUrl != null
  const textChange = p.pendingName != null || p.pendingTagline != null || p.pendingSign != null
  if (linkChange || textChange) {
    box.append(h('div', { class: 'change-box' },
      h('strong', null, linkChange && textChange ? '바꾸려는 글자 · 링크' : textChange ? '바꾸려는 글자' : '바꾸려는 링크'),
      dl([
        p.pendingName != null ? ['이름', p.pendingName, `지금: ${p.name}`] : null,
        p.pendingTagline != null ? ['한 줄 소개', p.pendingTagline, `지금: ${p.tagline}`] : null,
        p.pendingSign != null ? ['지붕 소개', p.pendingSign || '(비움)', `지금: ${p.sign || '-'}`] : null,
        linkChange ? ['GitHub', extLink(p.pendingGithub)] : null,
        linkChange ? ['서비스 주소', extLink(p.pendingUrl)] : null,
      ])))
  }

  const note = input('note', { max: 80, placeholder: '사유 (작성자에게 보입니다, 80자까지)' })
  if (p.status === 'pending') {
    // 처음 채널: 작성자가 고른 채널에 빈 자리가 있으면 그 채널, 아니면 빈 자리가 있는 첫 채널
    const hasFree = ch => freeIn(free, ch).length > 0
    const startCh = wantCh != null && hasFree(wantCh) ? wantCh : channelIds(W).find(hasFree) ?? wantCh ?? 1
    const picker = plotPicker(W, {
      free, auto: true, channel: startCh, want: p.wantPlot != null ? { channel: wantCh, plot: p.wantPlot } : null,
      autoLabel: ch => ch === wantCh && p.wantPlot != null && freeIn(free, ch).includes(p.wantPlot)
        ? `자동: 원하는 자리 ${p.wantPlot}번`
        : hasFree(ch) ? `자동: 첫 빈 자리 (${freeIn(free, ch)[0]}번)` : '빈 자리가 없습니다',
    })
    const approve = h('button', { class: 'btn btn-main', type: 'button' }, '승인하고 사당 세우기')
    approve.addEventListener('click', () => busy(approve, async () => {
      if (!hasFree(picker.channel)) return toast(`채널 ${picker.channel}에는 빈 사당 자리가 없습니다`)
      after(await api('project/approve', { id: p.id, channel: picker.channel, ...(picker.value != null ? { plot: picker.value } : {}) }))
    }))
    const reject = h('button', { class: 'btn btn-danger', type: 'button' }, '반려')
    reject.addEventListener('click', () => busy(reject, async () => after(await api('project/reject', { id: p.id, note: note.value }))))
    box.append(
      h('div', { class: 'act' }, h('h3', null, '승인'),
        h('p', { class: 'note' }, '사당은 고른 채널에서만 보입니다. 자리를 고르지 않으면 작성자가 원한 자리(그 채널일 때), 찼으면 그 채널의 첫 빈 자리에 세웁니다.'),
        picker, h('div', { class: 'act-row' }, approve)),
      h('div', { class: 'act' }, h('h3', null, '반려'), h('div', { class: 'act-row' }, note, reject)),
    )
  } else if (p.changes) {
    const approve = h('button', { class: 'btn btn-main', type: 'button' }, '변경 승인')
    approve.addEventListener('click', () => busy(approve, async () => after(await api('project/approve', { id: p.id }))))
    const reject = h('button', { class: 'btn btn-danger', type: 'button' }, '변경 반려')
    reject.addEventListener('click', () => busy(reject, async () => after(await api('project/reject', { id: p.id, note: note.value }))))
    box.append(h('div', { class: 'act' },
      h('h3', null, '변경 검토'),
      h('p', { class: 'note' }, '승인하면 바꾼 글자 · 링크 · 이미지가 사당에 바로 반영됩니다. 반려하면 사당은 원래대로 둡니다.'),
      h('div', { class: 'act-row' }, approve),
      h('div', { class: 'act-row' }, note, reject)))
  }
  if (!p.purgedAt) {
    const erase = h('button', { class: 'btn btn-danger', type: 'button' }, '개인정보 바로 파기')
    erase.addEventListener('click', () => busy(erase, async () => {
      const live = p.status === 'approved' || p.status === 'pending'
      if (!confirm(`접수 #${p.id}의 이메일 · 비밀번호 해시 · 링크 · 이미지를 지금 지울까요? 되돌릴 수 없습니다.${live ? '\n접수는 내림으로 바뀌고, 맵에 있는 사당도 함께 내려갑니다.' : ''}`)) return
      after(await api('project/erase', { id: p.id }))
    }))
    box.append(h('div', { class: 'act' },
      h('h3', null, '개인정보 파기'),
      h('p', { class: 'note' }, '작성자가 삭제를 요청했을 때 씁니다. 그냥 두면 반려 · 내림 30일 뒤 저절로 파기됩니다.'),
      h('div', { class: 'act-row' }, erase)))
  }
  const back = h('a', { class: 'btn btn-sm', href: `#projects?f=${filter}` }, '닫기')
  box.querySelector('.detail-head').append(back)
  return box
}

/* ── 화면: 사당 ── */

async function viewShrines(q) {
  const [d, W] = await Promise.all([api('shrines'), getWorld()])
  if (!d.ok) return errorBox(d)
  const editing = q.get('edit')
  const adding = q.get('add') === '1'
  const shrines = d.shrines
  const free = d.freePlots ?? {}
  const names = new Map(shrines.map(s => [`${s.channel}:${s.plot}`, s.name]))
  const rows = shrines.map(s => ({
    slug: s.slug,
    cells: [
      h('span', { class: 'mono', title: `채널 ${s.channel} · ${plotName(s.plot)}` }, `${s.channel} · ${s.plot}`),
      h('div', { class: 'cell-main' }, h('strong', null, s.name), h('small', { class: 'mono' }, s.slug),
        s.errors.length ? h('small', { class: 'bad-text' }, `맵에서 숨김: ${s.errors.join(' / ')}`) : null),
      pill(s.status, SHRINE_STATUS[s.status] ?? s.status),
      h('span', { class: 'mono' }, s.domain),
      s.projectId ? h('a', { href: `#projects?f=all&id=${s.projectId}`, onclick: e => e.stopPropagation() }, `등록소 #${s.projectId}`) : '직접',
    ],
  }))
  const side = h('div', { class: 'split-side' })
  if (adding) side.append(addForm(W, free, names))
  else if (editing) {
    const s = shrines.find(x => x.slug === editing)
    side.append(s ? editForm(W, s, free, names) : panel(null, errorBox({ reason: 'none' })))
  } else {
    side.append(panel(null, empty(shrines.length
      ? '목록에서 사당을 고르면 고치기 · 옮기기 · 내리기를 할 수 있습니다.'
      : '아직 사당이 없습니다. "사당 추가"로 첫 사당을 세우거나, 등록소 접수를 승인하세요.')))
  }
  return frag(
    head('사당', `${shrines.length}곳 · 빈 자리 ${freeTotal(free)}/${d.plots * channelIds(W).length}칸 (${channelIds(W).map(ch => `채널 ${ch} ${freeIn(free, ch).length}`).join(' · ')})`,
      h('a', { class: 'btn btn-main btn-sm', href: '#shrines?add=1' }, '사당 추가')),
    h('div', { class: 'split' },
      h('div', { class: 'split-main panel' },
        shrines.length
          ? table(['채널 · 자리', '사당', '상태', '주소', '출처'], rows, {
            onRow: r => { location.hash = `#shrines?edit=${encodeURIComponent(r.slug)}` },
            narrowHide: [3, 4],
            selected: rows.findIndex(r => r.slug === editing),
          })
          : empty('아직 사당이 없습니다. 맵은 채널마다 빈 자리 20칸으로 시작합니다.')),
      side),
  )
}

/** 폼 칸 값 읽기 (이름 → 값) */
function formValues(form) {
  const out = {}
  for (const el of form.querySelectorAll('input[name], select[name]')) {
    if (el.type === 'file') continue
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value
  }
  return out
}

function formError(form, text) {
  const msg = form.querySelector('.form-msg')
  msg.textContent = text
  msg.classList.toggle('bad-text', !!text)
}

function addForm(W, free, names) {
  const image = imagePicker('', { required: true })
  const startCh = channelIds(W).find(ch => freeIn(free, ch).length) ?? 1
  const picker = plotPicker(W, {
    free, names, auto: true, channel: startCh,
    autoLabel: ch => (freeIn(free, ch).length ? `자동: 첫 빈 자리 (${freeIn(free, ch)[0]}번)` : '빈 자리가 없습니다'),
  })
  const submit = h('button', { class: 'btn btn-main', type: 'submit' }, '사당 세우기')
  const form = h('form', { class: 'panel shrine-form', novalidate: true },
    h('div', { class: 'detail-head' }, h('h2', null, '사당 추가'), h('a', { class: 'btn btn-sm', href: '#shrines' }, '닫기')),
    h('p', { class: 'note' }, '직접 넣는 사당은 운영자가 주소를 확인한 것으로 기록됩니다 (오늘 날짜). 이미지는 1장이 필요합니다.'),
    h('div', { class: 'rg-grid' },
      field('이름', input('name', { max: 20, placeholder: '무사배포 봇' })),
      field('분류', select('category', categoryOptions(), 'devtools')),
      field('한 줄 소개', input('tagline', { max: 40, placeholder: '배포 전에 체크리스트를 챙겨 주는 봇' }), { full: true }),
      field('지붕 소개', input('sign', { max: 8, placeholder: '비우면 소개 앞 8자' }), { optional: true }),
      field('운영 표시명', input('operator', { max: 20, placeholder: '비우면 익명' }), { optional: true }),
      field('서비스 주소', input('url', { placeholder: 'https://my-service.com' }), { full: true, help: 'GitHub 저장소와 둘 중 하나는 꼭' }),
      field('GitHub 저장소', input('github', { placeholder: 'https://github.com/이름/저장소' }), { full: true, optional: true }),
      field('현판 기원', select('prayer', prayerOptions(), 'deploy')),
      field('상태', select('status', [['live', '운영 중'], ['check', '닫힘 · 점검 중']], 'live')),
      field('이메일', input('email', { type: 'email', max: 80, placeholder: 'me@example.com' }), { optional: true }),
      field('주소 이름 (slug)', input('slug', { max: 40, placeholder: '비우면 자동' }), { optional: true }),
      h('div', { class: 'rf full switches' }, toggle('emailPublic', '사당에 이메일 공개', false), toggle('keeper', '관리인 사당 (금빛 장식)', false)),
      h('div', { class: 'rf full' }, h('span', { class: 'rf-label' }, '이미지'), image),
      h('div', { class: 'rf full' }, h('span', { class: 'rf-label' }, '채널 · 자리'), picker),
    ),
    h('div', { class: 'form-foot' }, h('p', { class: 'form-msg', role: 'status', 'aria-live': 'polite' }), submit),
  )
  form.addEventListener('submit', e => {
    e.preventDefault()
    busy(submit, async () => {
      formError(form, '')
      if (!image.file) return formError(form, '이미지를 골라 주세요')
      const v = formValues(form)
      delete v.plot
      delete v.channel
      formError(form, '이미지를 올리는 중…')
      const up = await uploadImage(image.file)
      if (!up.ok) return formError(form, why(up))
      const r = await api('shrine/add', { ...v, screen: up.id, channel: picker.channel, ...(picker.value != null ? { plot: picker.value } : {}) })
      if (!r.ok) return formError(form, why(r))
      toast(`사당을 세웠습니다: ${r.shrine.name} (채널 ${r.shrine.channel} · ${r.shrine.plot}번)`)
      location.hash = `#shrines?edit=${encodeURIComponent(r.shrine.slug)}`
    })
  })
  return form
}

function editForm(W, s, free, names) {
  const screen = (s.screens[0] ?? '').startsWith('up/') ? s.screens[0].slice(3) : ''
  const image = imagePicker(screen)
  const serviceUrl = s.domain.startsWith('github.com/') ? '' : s.url
  const initial = {
    name: s.name, tagline: s.tagline, sign: s.sign, category: s.category, operator: s.operator,
    url: serviceUrl, github: s.repo, status: s.status,
  }
  const save = h('button', { class: 'btn btn-main', type: 'submit' }, '고친 내용 저장')
  const form = h('form', { class: 'shrine-form', novalidate: true },
    h('div', { class: 'rg-grid' },
      field('이름', input('name', { max: 20, value: s.name })),
      field('분류', select('category', categoryOptions(), s.category)),
      field('한 줄 소개', input('tagline', { max: 40, value: s.tagline }), { full: true }),
      field('지붕 소개', input('sign', { max: 8, value: s.sign, placeholder: '비우면 소개 앞 8자' }), { optional: true }),
      field('운영 표시명', input('operator', { max: 20, value: s.operator })),
      field('서비스 주소', input('url', { value: serviceUrl, placeholder: 'https://my-service.com' }), { full: true, optional: true }),
      field('GitHub 저장소', input('github', { value: s.repo, placeholder: 'https://github.com/이름/저장소' }), { full: true, optional: true }),
      field('상태', select('status', [['live', '운영 중'], ['check', '닫힘 · 점검 중']], s.status), { help: '닫으면 맵에 점검 중으로 보이고 서비스 가보기가 막힙니다' }),
      h('div', { class: 'rf full' }, h('span', { class: 'rf-label' }, '이미지'), image),
    ),
    h('div', { class: 'form-foot' }, h('p', { class: 'form-msg', role: 'status', 'aria-live': 'polite' }), save),
  )
  form.addEventListener('submit', e => {
    e.preventDefault()
    busy(save, async () => {
      formError(form, '')
      const v = formValues(form)
      const patch = {}
      for (const [k, val] of Object.entries(v)) if (k in initial && val !== initial[k]) patch[k] = val
      if (image.file) {
        formError(form, '이미지를 올리는 중…')
        const up = await uploadImage(image.file)
        if (!up.ok) return formError(form, why(up))
        patch.screen = up.id
      }
      if (!Object.keys(patch).length) return formError(form, '바뀐 내용이 없습니다')
      const r = await api('shrine/update', { slug: s.slug, ...patch })
      if (!r.ok) return formError(form, why(r))
      toast(r.changed?.length ? `저장했습니다: ${r.changed.map(k => FIELD_LABEL[k] ?? k).join(', ')}` : '바뀐 내용이 없습니다')
      await route()
    })
  })

  // 옮기기 (다른 채널로 옮기면 그 채널에서만 보입니다)
  const picker = plotPicker(W, { free, names, channel: s.channel, current: { channel: s.channel, plot: s.plot } })
  const move = h('button', { class: 'btn', type: 'button' }, '이 자리로 옮기기')
  move.addEventListener('click', () => busy(move, async () => {
    if (picker.value == null) return toast('옮길 빈 자리를 고르세요')
    const r = await api('shrine/move', { slug: s.slug, channel: picker.channel, plot: picker.value })
    if (!r.ok) return toast(why(r))
    toast(`${s.name}: 채널 ${s.channel} · ${s.plot}번 → 채널 ${r.shrine.channel} · ${r.shrine.plot}번`)
    await route()
  }))

  // 내리기
  const note = input('note', { max: 80, placeholder: s.projectId ? '사유 (작성자에게 보입니다)' : '사유 (기록에 남습니다)' })
  const remove = h('button', { class: 'btn btn-danger', type: 'button' }, '맵에서 내리기')
  remove.addEventListener('click', () => busy(remove, async () => {
    const extra = s.projectId ? `\n등록소 접수 #${s.projectId}는 반려로 바뀌고, 작성자가 고쳐 다시 낼 수 있습니다.` : ''
    if (!confirm(`'${s.name}' 사당을 맵에서 내릴까요?${extra}`)) return
    const r = await api('shrine/remove', { slug: s.slug, note: note.value })
    if (!r.ok) return toast(why(r))
    toast(`내렸습니다: ${s.name}`)
    location.hash = '#shrines'
  }))

  return h('section', { class: 'panel detail' },
    h('div', { class: 'detail-head' },
      h('h2', null, s.name), pill(s.status, SHRINE_STATUS[s.status] ?? s.status),
      h('a', { class: 'btn btn-sm', href: '#shrines' }, '닫기')),
    dl([
      ['주소 이름', h('span', { class: 'mono' }, s.slug)],
      ['자리', `채널 ${s.channel} · ${plotName(s.plot)}`, '이 채널에서만 보입니다'],
      ['출처', s.projectId ? h('a', { href: `#projects?f=all&id=${s.projectId}` }, `등록소 접수 #${s.projectId}`) : '운영자가 직접 넣음'],
      ['들어온 날', s.joinedAt, s.verifiedDomain ? `· 주소 확인 ${s.verifiedDomain}` : ''],
      s.email ? ['이메일', s.email, s.emailPublic ? '(공개)' : '(비공개)'] : null,
      s.errors.length ? ['맵에서 숨김', h('span', { class: 'bad-text' }, s.errors.join(' / '))] : null,
    ]),
    h('div', { class: 'act' }, h('h3', null, '고치기'), form),
    h('div', { class: 'act' }, h('h3', null, '옮기기'), freeTotal(free) ? [picker, h('div', { class: 'act-row' }, move)] : h('p', { class: 'note' }, '빈 자리가 없습니다.')),
    h('div', { class: 'act' }, h('h3', null, '내리기'), h('div', { class: 'act-row' }, note, remove)),
  )
}

/* ── 화면: 게시판 ── */

async function viewPosts() {
  const [d, W] = await Promise.all([api('posts'), getWorld()])
  if (!d.ok) return errorBox(d)
  const topic = k => W.ais.find(a => a.key === k) ?? { name: '기타', color: '#9aa4b8' }
  const items = d.posts.map(p => {
    const t = topic(p.topic)
    const tag = h('span', { class: 'tag' }, t.name)
    tag.style.background = /^#[0-9a-f]{3,8}$/i.test(t.color) ? t.color : '#9aa4b8'
    const hideBtn = h('button', { class: 'btn btn-sm', type: 'button' }, p.hidden ? '다시 보이기' : '숨기기')
    hideBtn.addEventListener('click', () => busy(hideBtn, async () => {
      const r = await api(p.hidden ? 'post/show' : 'post/hide', { id: p.id })
      if (!r.ok) return toast(why(r))
      toast(p.hidden ? '다시 보이게 했습니다' : '숨겼습니다')
      await route()
    }))
    const delBtn = h('button', { class: 'btn btn-sm btn-danger', type: 'button' }, '지우기')
    delBtn.addEventListener('click', () => busy(delBtn, async () => {
      if (!confirm('이 글을 지울까요? 되돌릴 수 없습니다.')) return
      const r = await api('post/delete', { id: p.id })
      if (!r.ok) return toast(why(r))
      toast('지웠습니다')
      await route()
    }))
    return h('li', { class: `post-item${p.reports ? ' reported' : ''}${p.hidden ? ' is-hidden' : ''}` },
      h('div', { class: 'post-meta' }, tag, h('span', null, p.nick), h('span', null, fmtTime(p.at)), h('span', { class: 'mono' }, `#${p.id}`)),
      h('p', { class: 'post-text' }, p.text),
      h('div', { class: 'post-foot' },
        p.reports ? pill('reported', `신고 ${p.reports}`) : pill('none', '신고 없음'),
        pill(p.hidden ? 'hidden' : 'shown', p.hidden ? '숨김' : '보임'),
        h('span', { class: 'grow' }), hideBtn, delBtn))
  })
  return frag(
    head('AI 트렌드 게시판', '신고된 글이 먼저 보입니다. 글은 7일 동안 보관되고, 서로 다른 3명이 신고하면 저절로 숨겨집니다.'),
    items.length ? h('ul', { class: 'post-list' }, items) : panel(null, empty('보관 중인 글이 없습니다.')),
  )
}

/* ── 화면: 설정 · 기록 ── */

async function viewSettings() {
  const d = await api('settings')
  if (!d.ok) return errorBox(d)
  return frag(
    head('설정', '지금 서버가 쓰는 설정입니다 (읽기 전용). 바꾸려면 .env를 고치고 서버를 다시 띄웁니다. 비밀 값은 들어 있는지만 보여 줍니다.'),
    panel(null, table(['항목', '값', '환경 변수'], d.settings.map(r => ({ cells: [r.label, h('span', { class: 'value' }, r.value), h('span', { class: 'mono mute' }, r.key)] })), { narrowHide: [2] })),
  )
}

async function viewLog() {
  const d = await api('log?limit=200')
  if (!d.ok) return errorBox(d)
  return frag(
    head('운영 기록', '운영자 화면에서 한 일을 최근 것부터 200개까지 보여 줍니다. IP는 해시로만 남습니다.'),
    panel(null, d.log.length
      ? table(['시각', '작업', '대상', 'IP 해시', '내용'], d.log.map(r => ({
        cells: [
          h('span', { class: 'mute' }, fmtTime(r.at)),
          h('span', { class: r.action === 'login-fail' ? 'bad-text' : null }, ACTIONS[r.action] ?? r.action),
          h('span', { class: 'mono' }, r.target || '-'),
          h('span', { class: 'mono mute' }, r.ip),
          r.action === 'shrine-update' ? r.detail.split(', ').map(k => FIELD_LABEL[k] ?? k).join(', ') : r.detail || '',
        ],
      })), { narrowHide: [3] })
      : empty('아직 기록이 없습니다.')),
  )
}

/* ── 길 찾기 ── */

const VIEWS = { dashboard: viewDashboard, people: viewPeople, projects: viewProjects, shrines: viewShrines, posts: viewPosts, settings: viewSettings, log: viewLog }
let seq = 0

async function refreshCounts() {
  const d = await api('dashboard')
  if (!d.ok) return
  const set = (id, n) => {
    const el = document.getElementById(id)
    el.textContent = n > 99 ? '99+' : String(n)
    el.hidden = !n
  }
  set('navProjects', d.projects.pending + d.projects.changes)
  set('navPosts', d.posts.reported)
  set('navPeople', d.moderation?.reports ?? 0)
}

async function route() {
  const raw = location.hash.slice(1)
  const [name = '', qs = ''] = raw.split('?')
  const view = VIEWS[name] ? name : 'dashboard'
  for (const a of document.querySelectorAll('#nav a')) {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  }
  const mine = ++seq
  const keepScroll = window.scrollY
  const node = await VIEWS[view](new URLSearchParams(qs))
  if (mine !== seq) return
  main.replaceChildren(node)
  window.scrollTo(0, view === lastView ? keepScroll : 0)
  lastView = view
  refreshCounts()
}
let lastView = ''

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api('logout', {})
  location.replace(`${BASE}/admin`)
})
window.addEventListener('hashchange', () => route())
route()
