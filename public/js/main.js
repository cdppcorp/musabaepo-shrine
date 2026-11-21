// 무사배포 기원소 화면.
// 입장(캐릭터 꾸미기 · 사람 확인) → 화면 가득 찬 맵(걷기 · 실시간) → 사당 앞에서 반투명 창(초 켜기 · 서비스 가보기).
// 사용자 입력이나 서버 데이터는 textContent / DOM API로만 넣습니다 (HTML 문자열 금지).
import { DEFAULT_LOOK, LOOK_SIZES, PARTS, drawAvatar, optionsOf, randomLook, validLook } from './avatar.js'
import { AI_BLESS, BUBBLES, BUBBLE_GROUPS, CATEGORIES, CHARMS, EMOTES, FORTUNES, PRAYERS, SIGHS, TOPIC_ETC } from './data.js'
import { bakeFloor, buildFront, drawBoard, drawGlow, drawEmptyPlot, drawFloor, drawFortune, drawProp, drawShrine, drawStrings, propBox, rect, shrink } from './pixels.js'
import { CENSER_BOX, TEMPLE_BOX, drawCenser, drawTemple } from './temple.js'
// 새 그림(AI 신당 · 게시판 · 등록소 · 흡연구역)은 이름표만 있어도 돌아가게 묶음으로 가져옵니다
import * as AiArt from './ai-art.js'
import * as AvatarMod from './avatar.js'
import { SIGN_Y, drawEmptyHD, drawShrineHD, makeScreen } from './shrine-art.js'
import { burst, drawDarkness, drawSky, glowLevel, glowTarget, toNextLevel, updateSky } from './light.js'
import { drawLens } from './lens.js'

/** 주소 앞부분 (독립 도메인이면 '') */
const BASE = document.querySelector('meta[name="shrine-base"]')?.content ?? ''
const SITE_KEY = document.querySelector('meta[name="turnstile-site-key"]')?.content || ''
/** 화면에 보이는 맵 크기(맵 픽셀). 창 크기에 맞춰 fit()이 다시 정합니다 */
let VW = 320
let VH = 180
const CELL = 8
const FONT = "'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', system-ui, sans-serif"
const MOVE = {
  arrowup: [0, -1], w: [0, -1], arrowdown: [0, 1], s: [0, 1],
  arrowleft: [-1, 0], a: [-1, 0], arrowright: [1, 0], d: [1, 0],
  // 휴대폰 화면 패드가 누르는 가상 방향키 (키보드로는 나올 수 없는 이름)
  'pad:up': [0, -1], 'pad:down': [0, 1], 'pad:left': [-1, 0], 'pad:right': [1, 0],
}
/** 직접 쓴 메시지를 서버가 돌려보낸 까닭 */
const CHAT_FAIL = {
  empty: '보낼 말을 써 주세요.',
  long: '메시지는 40자까지 쓸 수 있어요.',
  link: '링크나 메일 주소는 보낼 수 없어요.',
  contact: '연락처나 메신저 아이디는 보낼 수 없어요.',
  word: '쓸 수 없는 말이 들어 있어요.',
  slow: '조금 천천히 보내 주세요.',
  same: '같은 말은 잠시 뒤에 다시 보낼 수 있어요.',
  off: '지금은 직접 쓰는 말을 쉬고 있어요. 고르기 문구로 말해 주세요.',
}
/** 행동이 이어지는 시간(초). 캐릭터 그리기(avatar.js)가 남은 시간으로 동작을 그립니다 */
const EMOTE_DUR = { bow: 1.1, wave: 1.6, jump: 0.7, spin: 0.9, kiss: 1.2, smoke: 6 }
const AI_FAIL = { already: '오늘은 이 AI에 이미 기도했어요. 내일 또 와 주세요.', busy: '기도가 몰리고 있어요. 잠시 뒤 다시 해 주세요.', far: '신당 앞으로 조금 더 가 주세요.' }
const AI_LIT_KEY = 'shrine-ai-prayed'
/** 기도 뒤 AI 신당 구슬이 빛나는 시간(ms) */
const AI_GLOW_MS = 2600
/** 신당에서 기도하면 옥토캣 신상 위로 떠오르는 말 */
const BLESSINGS = [
  'PR이 바로 머지되리라', 'CI가 초록불이리라', '머지 충돌이 비켜 가리라', '스타가 쏟아지리라',
  '오늘 배포는 무사하리라', '테스트가 한 번에 통과하리라', '이슈가 술술 닫히리라', '리뷰어가 LGTM만 남기리라',
]
/** 기도 뒤 신상 · 향로가 밝게 빛나는 시간(ms) */
const PRAY_GLOW_MS = 3200
/** 같은 사당에 초를 다시 켤 수 있을 때까지 (서버가 wait를 안 보냈을 때만 씀. 서버 답이 기준) */
const LIT_COOLDOWN_MS = 30 * 60_000
const LIT_KEY = 'shrine-lit'
const LIGHT_FAIL = {
  already: min => `같은 사당에는 30분에 한 번 켤 수 있어요. ${min}분 뒤에 다시 켜 주세요.`,
  busy: '지금 초가 몰리고 있어요. 잠시 뒤 다시 눌러 주세요.',
  far: '사당에서 조금 멀어요. 앞으로 가서 다시 눌러 주세요.',
  closed: '점검중인 사당이라 지금은 초를 켤 수 없습니다.',
  prayer: '기원을 다시 골라 주세요.',
  channel: '이 채널에는 없는 사당이에요. 사당은 자기 채널에서만 보여요.',
  error: '잠시 문제가 생겼어요. 다시 해 주세요.',
}
/** 이용이 막힌 사람에게 (입장 · 연결 모두) */
const BLOCKED_TEXT = '이용이 제한된 상태예요. 문의는 화면 아래 연락처로 보내 주세요.'

const $ = sel => document.querySelector(sel)
function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)
const dotDate = d => d.replaceAll('-', '.')
const prayerLabel = k => PRAYERS.find(p => p.key === k)?.label ?? ''

const st = {
  // allShrines: 서버가 준 사당 전부 (채널 1~3). shrines · bySlug · byPlot: 지금 채널의 사당만 (showChannelShrines)
  world: null, allShrines: [], shrines: [], bySlug: new Map(), byPlot: new Map(), images: new Map(), minis: new Map(),
  candles: { week: {}, today: 0 },
  look: [...DEFAULT_LOOK], token: '', nick: '',
  me: null, myId: '', channel: 0, max: 30, others: new Map(),
  ws: null, hello: false, retries: 0, retryMax: 5, running: false,
  keys: new Set(), path: [], arrive: false, cam: { x: 0, y: 0 }, last: 0,
  // 네비게이터: 켜면 보이는 것마다 옆에 설명 (lens는 화면 단추 자리를 잰 것). 이름 glasses는 저장 값과 맞추려고 그대로 둡니다
  glasses: false, lens: null, lensAt: 0,
  // 화면 확대 단계 (마우스 휠 · +/- 키). 0이 기본, 한 단계마다 배율 k가 2씩 바뀝니다
  zoom: loadZoom(),
  sent: { x: 0, y: 0, d: 0, m: false, at: 0 },
  // lit: 사당 slug → 그 사당에 다시 초를 켤 수 있는 시각(ms)
  near: null, bubbles: new Map(), muted: new Set(), sparks: [], lit: new Map(), prayer: 'deploy',
  sheetKey: '', sheetSlug: '', nearKey: '', fortuneTimer: 0, fx: { fortune: null }, flyers: [], floaters: [],
  grid: null, ctx: null, k: 3, dpr: 1, floor: null, hearts: [],
  /** 기원소 밝기: glow는 화면에 보이는 값(목표로 천천히 다가감), flash는 초가 켜질 때 잠깐 번쩍 */
  glow: 0, flash: 0, sky: { lanterns: [], sparks: [], next: 0, burst: false },
  /** AI 신당: 오늘 기도 수 · 내가 오늘 기도한 AI · 기도 연출 시각 */
  ai: { counts: {}, lit: new Set(), fx: {} },
  /** 게시판 쪽지 색 (최근 글 주제), 흡연 연기 */
  recentTopics: [], puffs: [],
  chat: { free: true, max: 40 }, mini: null,
}

/* ══════════ 시작 ══════════ */

/** 같은 탭에서 게임에 들어와 있었는지 (새로고침해도 입장 화면을 건너뛰려고). 탭을 닫으면 사라집니다 */
const RESUME_KEY = 'shrine-in-game'
function loadResume() {
  try {
    const v = JSON.parse(sessionStorage.getItem(RESUME_KEY) || 'null')
    return v && Number.isInteger(v.ch) ? v : null
  } catch { return null }
}
function saveResume(ch) {
  try { sessionStorage.setItem(RESUME_KEY, JSON.stringify({ ch })) } catch { /* 무시 */ }
}
function clearResume() {
  try { sessionStorage.removeItem(RESUME_KEY) } catch { /* 무시 */ }
}
/** 다시 들어가는 중에는 입장 화면이 잠깐 비치지 않게 가려 둡니다 */
function endResume() {
  st.resuming = false
  document.documentElement.classList.remove('resume')
}
if (loadResume()) document.documentElement.classList.add('resume')

async function boot() {
  try {
    const res = await fetch(`${BASE}/api/world`, { cache: 'no-store' })
    const data = await res.json()
    st.world = data.world
    st.candles = data.candles
    if (data.chat) st.chat = data.chat
    st.recentTopics = data.recentTopics ?? []
    setShrines(data.shrines)
  } catch {
    endResume()
    $('#enterMsg').textContent = '기원소를 불러오지 못했습니다. 잠시 뒤 새로고침해 주세요.'
    return
  }
  showFootContact()
  if (JSON.stringify(st.world.lookSizes) !== JSON.stringify(LOOK_SIZES)) {
    endResume()
    $('#enterMsg').textContent = '화면과 서버 버전이 다릅니다. 새로고침해 주세요.'
    return
  }
  // 배포운 상자는 오른쪽 옆에 서서 뽑습니다 (앞에 서면 캐릭터가 상자를 가립니다)
  st.fortuneFront = { x: st.world.fortune.x + st.world.fortune.w + 9, y: st.world.fortune.y + st.world.fortune.h - 2 }
  st.templeFront = st.world.templeFront ?? null
  st.ais = st.world.ais ?? []
  loadAiLit()
  st.temple = st.world.props.find(p => p.k === 'temple') ?? null
  buildGrid()
  loadLit()
  loadLook()
  renderMaker()
  startPreview()
  loadHumanCheck()
  $('#enterBtn').addEventListener('click', enter)
  // 같은 탭에서 새로고침했으면 입장 화면을 건너뛰고 있던 채널로 바로 붙습니다.
  // 입장 표(쿠키, 3시간)가 만료됐거나 없으면 서버가 연결을 받지 않으니, 그때는 조용히 입장 화면으로 돌아갑니다
  const back = loadResume()
  if (back) {
    st.resuming = true
    if (back.ch >= 1 && back.ch <= (st.world.channels ?? 3)) st.wantCh = back.ch
    startGame()
  } else endResume()
}

/** 입장 화면 아래 문의 주소 (서버에 CONTACT_EMAIL이 있을 때만) */
function showFootContact() {
  const mail = st.chat.contact
  const box = $('#footContact')
  const link = $('#footContactLink')
  if (!box || !link || typeof mail !== 'string' || !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(mail)) return
  link.href = `mailto:${mail}`
  link.textContent = mail
  box.hidden = false
}

/**
 * 지금 채널에서 보이는 사당의 채널: 1~3번은 그대로, 그 밖(정원이 차서 생기는 넘침 채널)과 연결 전에는 1번 채널.
 * 서버 app/shrine/logic/world.py의 shrine_channel_of와 같은 규칙입니다.
 */
function shrineChannel(ch = st.channel) {
  const n = st.world?.channels ?? 3
  return Number.isInteger(ch) && ch >= 1 && ch <= n ? ch : 1
}

/** 그 채널(1~3)에 서 있는 사당 */
const shrinesIn = ch => st.allShrines.filter(s => (s.channel ?? 1) === ch)

function setShrines(list) {
  st.allShrines = list
  showChannelShrines()
}

/**
 * 사당은 자기 채널에서만 보입니다. 맵 · 목록 · 미니맵 · 창 · 초 켜기가 지금 채널의 사당만 쓰도록 거릅니다 (채널을 옮길 때마다 다시).
 * 이미지는 지금 채널 사당 것만 불러오고, 한 번 불러온 것은 채널을 오가도 그대로 둡니다.
 */
function showChannelShrines() {
  const list = shrinesIn(shrineChannel())
  st.shrines = list
  st.bySlug = new Map(list.map(s => [s.slug, s]))
  st.byPlot = new Map(list.map(s => [s.plot, s]))
  for (const s of list) {
    if (st.images.has(s.slug) || !s.screens[0]) continue
    const img = new Image()
    img.decoding = 'async'
    img.addEventListener('load', () => st.minis.set(s.slug, makeScreen(img)))
    img.src = `${BASE}/img/shrines/${s.screens[0]}`
    st.images.set(s.slug, img)
  }
  // 다른 채널 사당의 창, 이 채널에서는 사당이 서 있는 빈 자리 창은 닫습니다
  const plotSheet = /^p(\d+)$/.exec(st.sheetKey)
  if (plotSheet && (st.sheetSlug ? !st.bySlug.has(st.sheetSlug) : st.byPlot.has(Number(plotSheet[1])))) closeSheet()
  // 가까운 것(사당 ↔ 빈 자리)을 다음 화면에서 다시 봅니다
  st.nearKey = ''
  if (st.me && !$('#game').hidden) renderList()
}

/* ══════════ 입장 화면: 캐릭터 꾸미기 ══════════ */

const LOOK_KEY = 'shrine-look'
/** 돌려 보기 순서: 아래 → 오른쪽 → 위 → 왼쪽 */
const TURN = [0, 3, 1, 2]
const maker = { dir: 0, raf: 0, refresh: [] }

function loadLook() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOOK_KEY) || 'null')
    if (validLook(saved)) st.look = saved
  } catch { /* 저장이 막힌 브라우저면 기본 모습으로 */ }
}

function saveLook() {
  try { localStorage.setItem(LOOK_KEY, JSON.stringify(st.look)) } catch { /* 무시 */ }
}

function setPart(i, v) {
  st.look[i] = v
  saveLook()
  for (const f of maker.refresh) f()
}

function renderMaker() {
  const box = $('#parts')
  box.textContent = ''
  maker.refresh = []
  PARTS.forEach((part, i) => {
    const row = el('div', 'part')
    const name = el('span', 'part-label', part.label)
    name.id = `part-${part.key}`
    row.append(name)
    if (part.kind === 'cycle') {
      const n = part.options.length
      const ctl = el('div', 'cycle')
      const prev = el('button', 'cycle-btn', '◀')
      prev.type = 'button'
      prev.setAttribute('aria-label', `${part.label} 이전`)
      const value = el('span', 'cycle-name')
      value.setAttribute('aria-live', 'polite')
      const next = el('button', 'cycle-btn', '▶')
      next.type = 'button'
      next.setAttribute('aria-label', `${part.label} 다음`)
      prev.addEventListener('click', () => setPart(i, (st.look[i] - 1 + n) % n))
      next.addEventListener('click', () => setPart(i, (st.look[i] + 1) % n))
      ctl.append(prev, value, next)
      row.append(ctl)
      maker.refresh.push(() => { value.textContent = part.options[st.look[i]].name })
    } else {
      const group = el('div', 'swatches')
      group.setAttribute('role', 'radiogroup')
      group.setAttribute('aria-labelledby', name.id)
      const buttons = part.options.map((_o, j) => {
        const b = el('button', 'swatch')
        b.type = 'button'
        b.setAttribute('role', 'radio')
        b.addEventListener('click', () => setPart(i, j))
        group.append(b)
        return b
      })
      row.append(group)
      // 몸 색처럼 종족에 따라 바뀌는 선택지는 고를 때마다 색 · 이름을 다시 씁니다
      maker.refresh.push(() => {
        const opts = optionsOf(i, st.look)
        buttons.forEach((b, j) => {
          b.style.background = opts[j].color
          b.title = opts[j].name
          b.setAttribute('aria-label', opts[j].name)
          b.setAttribute('aria-checked', String(st.look[i] === j))
        })
      })
    }
    box.append(row)
  })
  for (const f of maker.refresh) f()

  $('#turnLeft').addEventListener('click', () => { maker.dir = TURN[(TURN.indexOf(maker.dir) + 3) % 4] })
  $('#turnRight').addEventListener('click', () => { maker.dir = TURN[(TURN.indexOf(maker.dir) + 1) % 4] })
  $('#randomLook').addEventListener('click', () => {
    st.look = randomLook()
    saveLook()
    for (const f of maker.refresh) f()
  })
  updateEnterButton()
}

function startPreview() {
  if (!maker.raf) maker.raf = requestAnimationFrame(previewLoop)
}

/** 미리보기: 제자리 걷기 */
function previewLoop(t) {
  if ($('#entry').hidden) {
    maker.raf = 0
    return
  }
  maker.raf = requestAnimationFrame(previewLoop)
  const cv = $('#preview')
  const c = cv.getContext('2d')
  c.setTransform(2, 0, 0, 2, 0, 0)
  c.imageSmoothingEnabled = false
  for (let y = 0; y < cv.height / 2; y += 8) {
    for (let x = 0; x < cv.width / 2; x += 8) {
      c.fillStyle = ((x + y) / 8) % 2 ? '#1b2a47' : '#1e2e4e'
      c.fillRect(x, y, 8, 8)
    }
  }
  drawAvatar(c, { x: 20, y: 38, d: maker.dir, moving: true, step: t / 125, bow: 0, wave: 0 }, st.look, t)
}

function loadHumanCheck() {
  if (!SITE_KEY) {
    $('#human').append(el('p', 'msg', '개발 모드: 사람 확인을 건너뜁니다.'))
    return
  }
  window.shrineHumanReady = () => {
    window.turnstile.render('#human', {
      sitekey: SITE_KEY,
      theme: 'dark',
      language: 'ko',
      callback: token => { st.token = token; updateEnterButton() },
      'expired-callback': () => { st.token = ''; updateEnterButton() },
      'error-callback': () => {
        st.token = ''
        updateEnterButton()
        $('#enterMsg').textContent = '사람 확인을 불러오지 못했습니다. 새로고침해 주세요.'
      },
    })
  }
  const script = document.createElement('script')
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=shrineHumanReady'
  script.async = true
  document.head.append(script)
}

function updateEnterButton() {
  $('#enterBtn').disabled = SITE_KEY ? !st.token : false
}

function resetHumanCheck() {
  if (SITE_KEY && window.turnstile) {
    st.token = ''
    window.turnstile.reset('#human')
  }
  updateEnterButton()
}

async function enter() {
  const msg = $('#enterMsg')
  $('#enterBtn').disabled = true
  msg.textContent = '입장하는 중…'
  try {
    const res = await fetch(`${BASE}/api/enter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: st.token, look: st.look }),
      credentials: 'same-origin',
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) {
      msg.textContent = {
        human: '사람 확인을 다시 해 주세요.',
        busy: '입장 요청이 많습니다. 잠시 뒤 다시 눌러 주세요.',
        bad: '캐릭터를 다시 골라 주세요.',
        blocked: BLOCKED_TEXT,
      }[data.reason] ?? '입장하지 못했습니다. 잠시 뒤 다시 눌러 주세요.'
      resetHumanCheck()
      return
    }
    st.nick = data.nick
    msg.textContent = ''
    startGame()
  } catch {
    msg.textContent = '연결이 불안정합니다. 다시 눌러 주세요.'
    resetHumanCheck()
  }
}

function backToEntry(text) {
  st.ws?.close()
  st.ws = null
  // 옷장 · 끊김 · 강퇴 · 표 만료 모두 여기로 옵니다. 이 뒤 새로고침하면 입장 화면부터
  clearResume()
  endResume()
  padStop()
  closeSheet()
  closeChannels()
  document.body.classList.remove('playing')
  $('#game').hidden = true
  $('#entry').hidden = false
  $('#enterMsg').textContent = text
  resetHumanCheck()
  startPreview()
}

/* ══════════ 게임 시작 ══════════ */

function startGame() {
  $('#entry').hidden = true
  $('#game').hidden = false
  document.body.classList.add('playing')
  document.documentElement.classList.remove('resume')
  fit()
  st.camReady = false
  // 바닥(풀밭 · 길 · 불빛 웅덩이)은 처음 한 번만 구워 둡니다
  st.floor ??= bakeFloor(st.world)
  st.glow = glowTarget(weekTotal())
  const sp = st.world.spawn
  st.me = { x: sp.x, y: sp.y, d: 0, moving: false, step: 0, bow: 0, wave: 0, look: [...st.look], nick: st.nick }
  st.others.clear()
  st.path = []
  st.ctx = $('#view').getContext('2d')
  renderSays()
  closePops()
  renderList()
  updateHud()
  st.retries = 0
  st.retryMax = 5
  connect()
  $('#view').focus()
  if (!st.running) {
    st.running = true
    bindInput()
    bindTools()
    window.addEventListener('resize', () => {
      if ($('#game').hidden) return
      fit()
      measureSheet()
      placePad()
    })
    $('#leaveBtn').addEventListener('click', () => backToEntry(''))
    $('#glassesBtn').addEventListener('click', () => setGlasses(!st.glasses))
    // 확대 · 축소 단추 (누른 뒤에도 방향키가 바로 먹게 맵에 초점을 돌려 줌)
    $('#zoomIn').addEventListener('click', () => { zoomBy(1); $('#view').focus({ preventScroll: true }) })
    $('#zoomOut').addEventListener('click', () => { zoomBy(-1); $('#view').focus({ preventScroll: true }) })
    // 미니맵 켜기 · 끄기, 아래 줄(채팅 · 행동) 접기 · 펴기. 마우스로 눌렀으면 맵으로 초점을 돌리고, 키보드로 눌렀으면 단추에 둡니다
    // (단추가 없는 옛 index.html과 만나도 게임은 돌아가게 ?.로 붙입니다)
    $('#miniBtn')?.addEventListener('click', e => {
      setMini(!st.miniOn)
      if (e.detail) $('#view').focus({ preventScroll: true })
    })
    $('#barFold')?.addEventListener('click', e => {
      setBarFold(!st.barFolded)
      if (e.detail) $('#view').focus({ preventScroll: true })
    })
    setMini(loadFlag(MINI_KEY, true), false)
    setBarFold(loadFlag(BAR_KEY, false), false)
    bindPad()
    setGlasses(loadGlasses(), true)
    // 등록소 모달: 닫기 단추 · 바깥(딤) 누르면 닫힘
    $('#regClose').addEventListener('click', closeRegistry)
    $('#regModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeRegistry() })
    $('#regModal').addEventListener('close', () => $('#view').focus({ preventScroll: true }))
    $('#hudChannel').addEventListener('click', () => {
      const pop = $('#chanPop')
      if (!pop.hidden) return closeChannels()
      send({ t: 'chans' })
    })
    requestAnimationFrame(loop)
  }
}

/** 캔버스를 창에 꽉 채웁니다. 맵 1px = 기기 화소 k개(짝수)라 도트 크기가 고르고(캐릭터는 반 칸 도트), 가로로 맵 약 320~480px이 보입니다 */
/** 넓은 화면 기본: 맵이 가로 이만큼(맵 px) 보이는 배율 */
const VIEW_W = 640
/** 가장 크게 확대해도 맵이 가로 이만큼(맵 px)은 보이게 */
const VIEW_MAX_ZOOM_W = 220
const ZOOM_KEY = 'shrine-zoom2'

function loadZoom() {
  try {
    // st를 만들 때 불리므로 아래 상수 대신 글자를 그대로 씁니다
    const z = Number(localStorage.getItem('shrine-zoom2'))
    return Number.isInteger(z) && Math.abs(z) <= 8 ? z : 0
  } catch { return 0 }
}

/** 확대(+1) · 축소(-1). 끝에 닿으면 그대로 */
function zoomBy(step) {
  const [lo, hi] = st.zoomRange ?? [0, 0]
  const next = Math.max(lo, Math.min(hi, st.zoom + step))
  if (next === st.zoom) return
  st.zoom = next
  try { localStorage.setItem(ZOOM_KEY, String(next)) } catch { /* 무시 */ }
  fit()
  measureSheet()
}

function fit() {
  const cv = $('#view')
  const dpr = window.devicePixelRatio || 1
  const dw = Math.max(1, Math.round(cv.clientWidth * dpr))
  const dh = Math.max(1, Math.round(cv.clientHeight * dpr))
  const W = st.world
  // 배율 k: 맵 1px = 기기 화소 k개. 확대 · 축소는 한 단계(k ± 1)씩.
  // 넓은 화면 기본: 맵이 가로 약 VIEW_W px 보이게 (맵보다 넓게 보이면 맵을 가운데 두고 둘레는 어둡게).
  // 휴대폰 · 좁은 창 기본: 맵 높이를 꽉 채우게 (세로 화면에서 위아래가 비지 않게)
  const narrow = cv.clientWidth <= 720
  const base = narrow
    ? Math.max(2, Math.ceil(dw / W.w), Math.ceil(dh / W.h))
    : Math.max(2, Math.round(dw / VIEW_W))
  // 확대는 맵이 가로 VIEW_MAX_ZOOM_W px까지 좁게 보일 때까지, 축소는 배율 2까지
  const most = Math.max(base, Math.floor(dw / VIEW_MAX_ZOOM_W))
  const k = Math.max(2, Math.min(most, base + st.zoom))
  st.zoomRange = [2 - base, most - base]
  const zin = $('#zoomIn')
  const zout = $('#zoomOut')
  if (zin) zin.disabled = k >= most
  if (zout) zout.disabled = k <= 2
  if (cv.width !== dw) cv.width = dw
  if (cv.height !== dh) cv.height = dh
  st.k = k
  st.dpr = dpr
  VW = dw / k
  VH = dh / k
}

function renderSays() {
  const pick = $('#pickPane')
  pick.textContent = ''
  for (const g of BUBBLE_GROUPS) {
    const row = el('div', 'pick-group')
    const chips = el('div', 'pick-chips')
    for (const k of g.ks) {
      const b = el('button', 'chip', BUBBLES[k])
      b.type = 'button'
      b.addEventListener('click', () => {
        send({ t: 'say', k })
        closePops()
      })
      chips.append(b)
    }
    row.append(el('p', 'pick-label', g.label), chips)
    pick.append(row)
  }
  // 행동 버튼: 넓은 화면은 아래 줄에 바로, 휴대폰은 행동 창 안에
  for (const box of [$('#emoPane'), $('#emoPop')]) {
    box.textContent = ''
    for (const e of EMOTES) {
      const b = el('button', 'emote')
      b.type = 'button'
      b.textContent = e.label
      b.addEventListener('click', () => {
        send({ t: 'emo', k: e.key })
        closePops()
        $('#view').focus({ preventScroll: true })
      })
      box.append(b)
    }
  }
  setFreeChat(st.chat.free)
  $('#chatInput').maxLength = st.chat.max
}

/** 직접 쓰기 켜짐 · 꺼짐 (운영자가 바꾸면 서버가 알려 줌). 꺼지면 입력칸만 숨기고 고르기 · 행동은 그대로 */
function setFreeChat(on) {
  st.chat.free = on
  const form = $('#chatForm')
  form.hidden = !on
  if (!on && form.contains(document.activeElement)) $('#view').focus({ preventScroll: true })
}

/** 아래 줄 버튼 · 입력칸 (한 번만 연결) */
function bindTools() {
  $('#pickBtn').addEventListener('click', () => togglePop('pick'))
  $('#emoBtn').addEventListener('click', () => togglePop('emo'))
  const input = $('#chatInput')
  // 글을 쓰는 동안은 걷지 않습니다 (휴대폰은 자판이 올라오니 화면 패드도 숨김)
  input.addEventListener('focus', () => {
    st.keys.clear()
    padStop()
    document.body.classList.add('typing')
  })
  input.addEventListener('blur', () => document.body.classList.remove('typing'))
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault()
      input.blur()
      $('#view').focus({ preventScroll: true })
      return
    }
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return
    e.preventDefault()
    sendChat()
  })
  $('#chatForm').addEventListener('submit', e => {
    e.preventDefault()
    sendChat()
  })
  $('#minimap').addEventListener('pointerdown', onMinimap)
}

function sendChat() {
  const input = $('#chatInput')
  const text = input.value.replace(/\s+/g, ' ').trim()
  if (!text) return
  if ([...text].length > st.chat.max) {
    toast(CHAT_FAIL.long)
    return
  }
  send({ t: 'chat', s: text })
  input.value = ''
  // 보낸 뒤에는 맵으로 돌아와 바로 걸을 수 있게 합니다 (Enter를 다시 누르면 입력칸으로)
  input.blur()
  $('#view').focus({ preventScroll: true })
}

function togglePop(name) {
  if ($(`#${name}Pop`).hidden) openPop(name)
  else closePops()
}

function openPop(name) {
  for (const n of ['pick', 'emo']) {
    $(`#${n}Pop`).hidden = n !== name
    $(`#${n}Btn`).setAttribute('aria-expanded', String(n === name))
  }
  document.body.classList.add('pop-open')
  // 휴대폰에서는 사당 창과 같은 자리라 사당 창을 닫습니다
  if (window.innerWidth <= 720) closeSheet()
}

function closePops() {
  for (const n of ['pick', 'emo']) {
    $(`#${n}Pop`).hidden = true
    $(`#${n}Btn`).setAttribute('aria-expanded', 'false')
  }
  document.body.classList.remove('pop-open')
}

/** 말풍선: 고른 문구는 3초, 직접 쓴 말은 길이에 따라 조금 더 */
function showBubble(id, text) {
  // 내가 숨긴 사람의 말풍선은 띄우지 않습니다 (내 화면에서만)
  if (st.muted.has(id)) return
  st.bubbles.set(id, { text, until: performance.now() + Math.min(6500, 2600 + [...text].length * 90) })
}

function renderList() {
  const ul = $('#shrineList')
  ul.textContent = ''
  for (const s of st.shrines) {
    const li = el('li')
    const b = el('button', 'btn', `${s.name} · ${CATEGORIES[s.category] ?? ''}`)
    b.type = 'button'
    b.addEventListener('click', () => {
      const plot = st.world.plots[s.plot]
      st.path = findPath(st.me, plot.front)
      st.arrive = st.path.length > 0
      b.closest('details').open = false
      $('#view').focus()
    })
    li.append(b)
    ul.append(li)
  }
}

function updateHud() {
  // NPC도 인원에 셉니다 (서버가 정원을 넘지 않게 NPC를 비켜 줌)
  const people = Math.min(st.max, 1 + st.others.size)
  const hud = $('#hudChannel')
  hud.textContent = st.hello ? `채널 ${st.channel} · ${people}/${st.max}명 ▾` : '연결하는 중…'
  if (st.hello) hud.append(el('span', 'hud-nick', ` · ${st.nick}`))
  const week = weekTotal()
  const level = glowLevel(week)
  const left = toNextLevel(week)
  $('#hudToday').textContent = `이번 주 초 ${week.toLocaleString('ko-KR')}개 · 밝기 ${level}/5${left ? ` · 다음까지 ${left}개` : ''}`
}

/* ══════════ 실시간 연결 ══════════ */

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}${BASE}/ws${st.wantCh ? `?ch=${st.wantCh}` : ''}`)
  st.ws = ws
  st.hello = false
  ws.addEventListener('message', ev => {
    let m
    try { m = JSON.parse(ev.data) } catch { return }
    onServer(m)
  })
  ws.addEventListener('close', ev => {
    if (st.ws !== ws) return
    // 채널을 바꾸려고 닫은 것이면 바로 다시 붙습니다
    if (st.switching) {
      st.switching = false
      connect()
      return
    }
    if (ev.code === 4001) return backToEntry('다른 창에서 입장해서 이 창의 연결을 끊었습니다.')
    if (ev.code === 4002) return backToEntry('오래 자리를 비워서 연결을 정리했어요. 다시 입장해 주세요.')
    if (ev.code === 4004) return backToEntry('운영자가 연결을 끊었어요. 이용 규칙을 지켜 주세요.')
    if (ev.code === 4005) return backToEntry(BLOCKED_TEXT)
    // 처음 붙을 때부터 안 되면(입장 표 만료 · 꽉 참) 입장 화면으로. 다시 붙는 중에 실패한 것이면 계속 시도합니다
    // 새로고침으로 다시 들어오려다 안 된 것이면 안내 없이 입장 화면만 보여 줍니다 (표가 끝났을 뿐이라)
    if (!st.hello && !st.retries) return backToEntry(st.resuming ? '' : '입장 표가 만료됐거나 접속이 많습니다. 다시 입장해 주세요.')
    st.hello = false
    updateHud()
    if (ev.code === 1012) {
      // 서버 재시작: 몇 초 걸리니 조금 더 오래 기다려 봅니다
      st.retryMax = 8
      toast('서버를 다시 시작하는 중이에요. 잠시 뒤 다시 연결할게요.')
    }
    if (ev.code === 1008) toast('메시지를 너무 빨리 보내서 연결이 끊겼습니다.')
    if (st.retries >= st.retryMax) return backToEntry('연결이 끊겼습니다. 다시 입장해 주세요.')
    const wait = Math.min(8000, 500 * 2 ** st.retries++)
    setTimeout(() => { if (st.ws === ws) connect() }, wait)
  })
}

function send(msg) {
  if (st.ws?.readyState === WebSocket.OPEN) st.ws.send(JSON.stringify(msg))
}

function addOther(p) {
  st.others.set(p.id, { ...p, tx: p.x, ty: p.y, moving: p.m, step: 0, bow: 0, wave: 0 })
  setSeat(st.others.get(p.id), p.s ?? -1)
}

function personById(id) {
  return id === st.myId ? st.me : st.others.get(id)
}

function onServer(m) {
  switch (m.t) {
    case 'hello':
      if (st.retries) toast('다시 연결했어요.')
      st.hello = true
      st.retries = 0
      st.retryMax = 5
      if (typeof m.chat?.free === 'boolean') setFreeChat(m.chat.free)
      st.myId = m.id
      st.channel = m.channel
      // 이 탭에서 새로고침하면 이 채널로 다시 들어옵니다. 닉네임 · 모습은 입장 표에 담긴 것(새로고침으로 들어와도 같게)
      saveResume(m.channel)
      endResume()
      if (typeof m.me?.nick === 'string' && m.me.nick) st.nick = st.me.nick = m.me.nick
      if (validLook(m.me?.look)) st.me.look = [...m.me.look]
      // 채널을 옮겼거나 서버가 다른 채널에 넣었으면 그 채널의 사당만 보이게
      showChannelShrines()
      st.max = m.max
      st.me.x = m.me.x
      st.me.y = m.me.y
      setSeat(st.me, -1)
      st.sent = { x: m.me.x, y: m.me.y, d: 0, m: false, at: 0 }
      st.others.clear()
      for (const p of m.players) addOther(p)
      st.candles = m.candles
      updateHud()
      break
    case 'join':
      addOther(m.p)
      updateHud()
      break
    case 'leave':
      st.others.delete(m.id)
      st.bubbles.delete(m.id)
      st.muted.delete(m.id)
      updateHud()
      break
    case 'sit': {
      const p = personById(m.id)
      if (!p) break
      // 내가 이미 일어나 걷기 시작했으면 서버의 확인 메시지로 되돌리지 않습니다
      if (p === st.me && m.s === -1 && st.me.seat === -1) break
      setSeat(p, m.s)
      p.x = m.x
      p.y = m.y
      p.d = m.d
      p.moving = false
      if (p === st.me) {
        st.sent.x = m.x
        st.sent.y = m.y
      } else {
        p.tx = m.x
        p.ty = m.y
      }
      break
    }
    case 'sitNo':
      if (st.me.seat >= 0) standUp(false)
      toast(m.reason === 'taken' ? '누가 먼저 앉았어요.' : '의자에 조금 더 가까이 가 주세요.')
      break
    case 'st':
      for (const [id, x, y, d, mv] of m.ps) {
        const o = st.others.get(id)
        if (!o) continue
        o.tx = x
        o.ty = y
        o.d = d
        o.moving = mv === 1
      }
      break
    case 'fix':
      st.me.x = m.x
      st.me.y = m.y
      st.path = []
      st.sent.x = m.x
      st.sent.y = m.y
      break
    case 'say':
      if (BUBBLES[m.k]) showBubble(m.id, BUBBLES[m.k])
      break
    case 'chat':
      if (typeof m.s === 'string' && m.s) showBubble(m.id, m.s.slice(0, 60))
      break
    case 'chatNo':
      if (m.reason === 'off') setFreeChat(false)
      toast(CHAT_FAIL[m.reason] ?? CHAT_FAIL.slow)
      break
    case 'chatMode':
      setFreeChat(Boolean(m.free))
      break
    case 'aipray':
      onAiPrayed(m)
      break
    case 'aiOk':
      rememberAiLit(m.a)
      break
    case 'aiNo':
      if (m.reason === 'already') rememberAiLit(m.a)
      toast(AI_FAIL[m.reason] ?? AI_FAIL.busy)
      break
    case 'post':
      onPost(m.post)
      break
    case 'postOk':
      onPostOk()
      break
    case 'postNo':
      toast(POST_FAIL[m.reason] ?? POST_FAIL.slow)
      break
    case 'postHide':
      onPostHide(m.id)
      break
    case 'reported':
      onReported(m.id)
      break
    case 'reportNo':
      toast(m.reason === 'closed' ? POST_FAIL.closed : POST_FAIL.error)
      break
    case 'reportUserOk':
      toast(m.again ? '이미 신고했어요.' : REPORT_USER_OK)
      break
    case 'reportUserNo':
      toast(REPORT_USER_FAIL[m.reason] ?? REPORT_USER_FAIL.slow)
      break
    case 'emoNo':
      if (m.k === 'smoke') toast('흡연은 고뇌와 번뇌의 공간에서만 할 수 있어요.')
      break
    case 'chans':
      showChannels(m.list)
      break
    case 'emo': {
      const p = personById(m.id)
      if (p && EMOTE_DUR[m.k]) p[m.k] = EMOTE_DUR[m.k]
      if (p && m.k === 'kiss') blowKiss(p)
      // 한숨 번호(i)가 있을 때만 말풍선 (NPC는 말없이 피우기도 함)
      if (p && m.k === 'smoke' && Number.isInteger(m.i)) showBubble(m.id, SIGHS[m.i] ?? SIGHS[0])
      if (p && p !== st.me && m.k === 'bow' && st.templeFront && dist(p, st.templeFront) <= 40) glowTemple()
      break
    }
    case 'candle': {
      const before = glowLevel(weekTotal())
      st.candles.week[m.s] = m.n
      st.candles.today = m.today
      if (typeof m.weekTotal === 'number') st.candles.weekTotal = m.weekTotal
      st.flash = 1
      const after = glowLevel(weekTotal())
      if (after > before) toast(after >= 5 ? '기원소가 축제의 절정이에요! 불꽃놀이가 시작됐어요.' : `초가 모여 기원소가 한층 밝아졌어요. (밝기 ${after}/5)`)
      sparkAt(m.s)
      updateHud()
      if (st.sheetSlug === m.s) updateSheetCount()
      break
    }
    case 'lit':
      onLit(m)
      break
  }
}

/* ══════════ 길 찾기 (8px 칸, BFS) ══════════ */

function overlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function blocked(x, y) {
  const W = st.world
  if (x < 4 || y < 4 || x > W.w - 4 || y > W.h - 2) return true
  const feet = { x: x - 4, y: y - 3, w: 8, h: 4 }
  return W.solids.some(s => overlap(feet, s))
}

function buildGrid() {
  const w = st.world.w / CELL
  const h = st.world.h / CELL
  const g = new Uint8Array(w * h)
  // 칸 가운데뿐 아니라 2px 둘레까지 비어 있어야 지나갈 칸으로 봅니다 (기둥 같은 작은 소품에 걸려 멈추지 않게)
  const clear = (x, y) => !blocked(x, y) && !blocked(x - 2, y) && !blocked(x + 2, y) && !blocked(x, y - 2) && !blocked(x, y + 2)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = clear(x * CELL + 4, y * CELL + 4) ? 0 : 1
  st.grid = { w, h, g }
}

function findPath(from, to) {
  const { w, h, g } = st.grid
  const cell = p => [clamp(Math.floor(p.x / CELL), 0, w - 1), clamp(Math.floor(p.y / CELL), 0, h - 1)]
  const [sx, sy] = cell(from)
  const [tx, ty] = cell(to)
  let goal = ty * w + tx
  // 목표 칸이 막혀 있으면 (의자 앞처럼 소품에 붙은 곳) 가장 가까운 빈 칸으로
  if (g[goal]) {
    let best = -1
    for (let r = 1; r <= 2 && best < 0; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const nx = tx + dx
        const ny = ty + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || g[ny * w + nx]) continue
        if (best < 0) best = ny * w + nx
      }
    }
    if (best < 0) return []
    goal = best
  }
  const prev = new Int32Array(w * h).fill(-1)
  const start = sy * w + sx
  prev[start] = start
  const queue = [start]
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i]
    if (cur === goal) break
    const cx = cur % w
    const cy = (cur - cx) / w
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx
      const ny = cy + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const n = ny * w + nx
      if (prev[n] !== -1 || g[n]) continue
      prev[n] = cur
      queue.push(n)
    }
  }
  if (prev[goal] === -1) return []
  const cells = []
  for (let c = goal; c !== start; c = prev[c]) cells.push(c)
  cells.reverse()
  const points = cells.map(c => ({ x: (c % w) * CELL + 4, y: Math.floor(c / w) * CELL + 4 }))
  if (points.length && !blocked(to.x, to.y)) points[points.length - 1] = { x: to.x, y: to.y }
  return points
}

/* ══════════ 입력 ══════════ */

function bindInput() {
  window.addEventListener('keydown', e => {
    if ($('#game').hidden) return
    if (document.querySelector('dialog[open]')) return
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
    const k = e.key.toLowerCase()
    const onControl = e.target instanceof Element && e.target.closest('button, summary, a, input')
    // +/- 키로 확대 · 축소 (Ctrl과 함께면 브라우저 확대이므로 건드리지 않음)
    if (!e.ctrlKey && !e.metaKey && !e.altKey && ['Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract'].includes(e.code)) {
      e.preventDefault()
      zoomBy(e.code === 'Equal' || e.code === 'NumpadAdd' ? 1 : -1)
      return
    }
    if (e.code === 'KeyG' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      setGlasses(!st.glasses)
      return
    }
    if (MOVE[k]) {
      st.keys.add(k)
      st.path = []
      st.arrive = false
      e.preventDefault()
    } else if (k === 'enter' && !onControl) {
      e.preventDefault()
      // 아래 줄을 접어 두었으면 펴고 나서
      if (st.barFolded) setBarFold(false)
      if (st.chat.free) $('#chatInput').focus()
      else openPop('pick')
    } else if (k === ' ' && !onControl) {
      e.preventDefault()
      // 창이 열린 자리에서 한 번 더 누르면 초 켜기(이미 켰으면 닫기)
      if (st.sheetKey && st.sheetKey === st.nearKey) {
        const light = $('#lightBtn')
        if (light && !light.disabled) light.click()
        else closeSheet()
      } else act()
    } else if (k === 'escape') {
      if (!$('#chanPop').hidden) {
        closeChannels()
        $('#hudChannel').focus({ preventScroll: true })
      } else if (document.body.classList.contains('pop-open')) closePops()
      else if (st.sheetKey) closeSheet()
    }
  })
  window.addEventListener('keyup', e => st.keys.delete(e.key.toLowerCase()))
  window.addEventListener('blur', () => st.keys.clear())

  const view = $('#view')
  // 마우스 휠로 확대 · 축소 (한 번 굴릴 때 한 단계, 너무 빨리 넘어가지 않게 0.15초 간격)
  let wheelAt = 0
  view.addEventListener('wheel', e => {
    if (e.ctrlKey) return
    e.preventDefault()
    const now = performance.now()
    if (now - wheelAt < 150 || !e.deltaY) return
    wheelAt = now
    zoomBy(e.deltaY < 0 ? 1 : -1)
  }, { passive: false })
  view.addEventListener('pointerdown', e => {
    // 화면 패드로 걷는 중에 다른 손가락이 맵에 닿아도 누른 곳으로 걷기는 하지 않습니다
    if (pad.id !== null) return
    view.focus()
    closePops()
    closeChannels()
    const r = view.getBoundingClientRect()
    const wx = st.cam.x + ((e.clientX - r.left) / r.width) * VW
    const wy = st.cam.y + ((e.clientY - r.top) / r.height) * VH
    const W = st.world
    const plot = W.plots.find(p => wx >= p.x && wx < p.x + 48 && wy >= p.y && wy < p.y + 48)
    const inRect = b => wx >= b.x && wx < b.x + b.w && wy >= b.y && wy < b.y + b.h
    let target = { x: wx, y: wy }
    if (plot) target = plot.front
    else if (inRect({ ...W.fortune, y: W.fortune.y - 10, h: W.fortune.h + 10 })) target = st.fortuneFront
    const interactive = Boolean(plot || target === st.fortuneFront)
    st.path = findPath(st.me, target)
    st.arrive = interactive && st.path.length > 0
    if (interactive && !st.path.length && dist(st.me, target) <= W.near) {
      st.near = nearest()
      act()
    }
  })

  $('#actBtn').addEventListener('click', act)
  $('#litBtn').addEventListener('click', () => {
    const s = st.near?.kind === 'plot' ? st.near.shrine : null
    if (s) lightCandle(s)
  })
}

/* ══════════ 행동 ══════════ */

function nearest() {
  const me = st.me
  const R = st.world.near
  if (me.seat >= 0) {
    // 흡연구역 벤치에 앉아 있으면 앉은 채로 한 대 (일어날 때는 방향키)
    const z = st.world.smokeZone
    if (z && dist(me, z) <= z.r && !(me.smoke > 0)) return { kind: 'smoke' }
    return { kind: 'seated' }
  }
  // 물건의 정면 한 점이 아니라 보이는 상자(앞 · 뒤 · 옆)에서 가까운지 봅니다. 여럿이면 가장 가까운 것
  const W = st.world
  const B = W.boxes ?? {}
  const reach = W.reach ?? 18
  let best = null
  let bestD = Infinity
  const consider = (box, hit) => {
    if (!box) return
    const d = boxDist(me, box)
    if (d <= reach && d < bestD) {
      best = hit
      bestD = d
    }
  }
  for (const plot of W.plots) consider(plot.box ?? { x: plot.x, y: plot.y, w: 48, h: 48 }, { kind: 'plot', plot, shrine: st.byPlot.get(plot.id) })
  consider(B.fortune ?? W.fortune, { kind: 'fortune' })
  if (st.templeFront) consider(B.temple, { kind: 'temple' })
  for (const a of st.ais) consider(a.box, { kind: 'ai', ai: a })
  consider(B.trend, { kind: 'trend' })
  consider(B.registry, { kind: 'registry' })
  if (best) return best
  let seat = null
  for (const s of st.world.seats ?? []) {
    const d = dist(me, s)
    if (d <= 15 && (!seat || d < dist(me, seat)) && !seatTaken(s.id)) seat = s
  }
  if (seat) return { kind: 'seat', seat }
  // 흡연구역 안이면 어디서든 (의자보다 뒤에 확인해서 벤치에도 앉을 수 있게)
  if (W.smokeZone && dist(me, W.smokeZone) <= W.smokeZone.r - 6) return { kind: 'smoke' }
  return null
}

/** 점에서 사각형까지 거리 (안에 있으면 0) */
function boxDist(p, b) {
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w))
  const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h))
  return Math.hypot(dx, dy)
}

function actionLabel(n) {
  if (!n) return '가까이 가 보세요'
  if (n.kind === 'fortune') return '오늘의 배포운 뽑기'
  if (n.kind === 'temple') return '옥토캣님께 기도하기'
  if (n.kind === 'ai') return `${n.ai.name} 잘 돌아가게 기도하기`
  if (n.kind === 'trend') return 'AI 트렌드 게시판 (준비 중)'
  if (n.kind === 'registry') return '프로젝트 등록소'
  if (n.kind === 'smoke') return st.me.smoke > 0 ? '고뇌하는 중…' : '한 대 피우기 (온라인)'
  if (n.kind === 'seat') return '앉기'
  if (n.kind === 'seated') return '일어나기'
  if (!n.shrine) return '빈 자리 보기'
  return `${n.shrine.name} 사당 보기`
}

/** 사당 앞에서만 보이는 [초 켜기]: 창을 열지 않고 바로 켭니다 (기원은 사당 창에서 마지막으로 고른 것) */
function syncLitBtn() {
  const b = $('#litBtn')
  const s = st.near?.kind === 'plot' ? st.near.shrine : null
  b.hidden = !s
  if (!s) return
  const wait = litWait(s.slug)
  b.disabled = Boolean(wait)
  b.textContent = wait ? `${litMinutes(s.slug)}분 뒤 다시` : '초 켜기'
  b.title = wait ? litAgainText(s.slug) : `${s.name}에 ${prayerLabel(st.prayer)} 초 켜기 (기원은 사당 창에서 바꿀 수 있어요)`
}

function act() {
  const n = st.near
  if (!n) return toast('사당 · 신당 · 광장 상자 앞에 서면 할 수 있어요.')
  if (n.kind === 'seat') return sitDown(n.seat)
  if (n.kind === 'seated') return standUp(true)
  st.me.d = 1
  if (n.kind === 'plot') return n.shrine ? openShrine(n.shrine) : openEmpty(n.plot)
  if (n.kind === 'fortune') return startFortune()
  if (n.kind === 'temple') return pray()
  if (n.kind === 'ai') return aiPray(n.ai)
  // 게시판은 아직 준비 중: 열지 않고 안내만 (열 때는 openTrend()로 되돌리면 됩니다)
  if (n.kind === 'trend') return toast('AI 트렌드 게시판은 아직 준비 중입니다.')
  if (n.kind === 'registry') return openRegistry()
  if (n.kind === 'smoke') return smokeOne()
}

/** 신당에서 기도: 옥토캣 신상을 향해 절하면 향 연기가 피어오르고 신상이 빛나며 덕담이 떠오릅니다 */
function pray() {
  st.me.d = 1
  st.me.bow = EMOTE_DUR.bow
  send({ t: 'emo', k: 'bow' })
  glowTemple()
  const line = BLESSINGS[Math.floor(Math.random() * BLESSINGS.length)]
  if (st.temple) st.floaters.push({ x: st.temple.x, y: st.temple.y - 44, text: line, life: 2.6, color: "#ffe08a" })
}

function glowTemple() {
  st.fx.pray = performance.now()
}

/* ── 앉기 ── */

function setSeat(p, id) {
  const seat = id >= 0 ? st.world.seats?.[id] : null
  p.seat = seat ? id : -1
  p.seated = Boolean(seat)
  p.seatH = seat?.h ?? 0
}

function seatTaken(id) {
  for (const o of st.others.values()) if (o.seat === id) return true
  return false
}

function sitDown(seat) {
  const me = st.me
  setSeat(me, seat.id)
  me.x = seat.x
  me.y = seat.y
  me.d = seat.d
  me.moving = false
  st.path = []
  st.arrive = false
  st.sent = { x: me.x, y: me.y, d: me.d, m: false, at: performance.now() }
  send({ t: 'sit', s: seat.id })
}

/** 일어나기: 의자 앞(일어서는 자리)으로 옮깁니다. tell=false면 서버에 알리지 않음(서버가 이미 거절한 경우) */
function standUp(tell) {
  const me = st.me
  const seat = st.world.seats?.[me.seat]
  setSeat(me, -1)
  if (!seat) return
  me.x = seat.stand.x
  me.y = seat.stand.y
  st.sent = { x: me.x, y: me.y, d: me.d, m: false, at: performance.now() }
  if (tell) send({ t: 'sit', s: -1 })
}

/* ── AI 신당 기도 ── */

function loadAiLit() {
  try {
    const raw = JSON.parse(localStorage.getItem(AI_LIT_KEY) || 'null')
    if (raw?.date === kstToday() && Array.isArray(raw.keys)) st.ai.lit = new Set(raw.keys)
  } catch { /* 저장이 막힌 브라우저 */ }
}

function rememberAiLit(key) {
  st.ai.lit.add(key)
  try { localStorage.setItem(AI_LIT_KEY, JSON.stringify({ date: kstToday(), keys: [...st.ai.lit] })) } catch { /* 무시 */ }
  if (st.near?.kind === 'ai') $('#actBtn').textContent = actionLabel(st.near)
}

function aiPray(ai) {
  st.me.d = 1
  st.me.bow = EMOTE_DUR.bow
  send({ t: 'emo', k: 'bow' })
  send({ t: 'aipray', a: ai.key })
}

/** 누가 AI 신당에 기도하면: 구슬이 빛나고, 내 기도면 덕담이 떠오릅니다. 공물은 이번에 본 기도만큼 (서버에 남지 않음) */
function onAiPrayed(m) {
  st.ai.counts[m.a] = (st.ai.counts[m.a] ?? 0) + 1
  st.ai.fx[m.a] = performance.now()
  const ai = st.ais.find(a => a.key === m.a)
  if (ai && m.by === st.myId) {
    const line = AI_BLESS[Math.floor(Math.random() * AI_BLESS.length)].replace('{name}', ai.name)
    st.floaters.push({ x: ai.x, y: ai.y - 46, text: line, life: 2.6, color: ai.color })
  }
}

const aiGlow = (key, now) => {
  const at = st.ai.fx[key]
  if (!at) return 0
  const k = 1 - (now - at) / AI_GLOW_MS
  return k > 0 ? k : 0
}

/* ── 온라인 흡연 (고뇌와 번뇌의 공간) ── */

function smokeOne() {
  if (st.me.smoke > 0) return
  const i = Math.floor(Math.random() * SIGHS.length)
  send({ t: 'emo', k: 'smoke', i })
}

/** 피우는 사람의 담배 끝 (캐릭터 그림이 알려 주면 그 자리, 아니면 입가 근처) */
function smokeTipOf(p) {
  const tip = AvatarMod.smokeTip?.(p)
  if (tip) return tip
  const side = p.d === 2 ? -6 : p.d === 3 ? 6 : 4
  return { x: p.x + side, y: p.y - (p.seated ? 13 + p.seatH : 17) }
}

function updatePuffs(dt) {
  for (const p of [st.me, ...st.others.values()]) {
    if (!(p?.smoke > 0)) continue
    p.puffT = (p.puffT ?? 0) - dt
    if (p.puffT <= 0) {
      p.puffT = 0.32 + Math.random() * 0.2
      const tip = smokeTipOf(p)
      st.puffs.push({ x: tip.x, y: tip.y, life: 0, max: 2.2 + Math.random(), seed: Math.random() * 6 })
    }
  }
  for (const f of st.puffs) {
    f.life += dt
    f.y -= dt * 7
    f.x += Math.sin(f.life * 2 + f.seed) * dt * 3
  }
  st.puffs = st.puffs.filter(f => f.life < f.max)
}

function drawPuff(c, f) {
  const k = f.life / f.max
  const r = 1 + Math.floor(k * 3)
  c.globalAlpha = Math.max(0, 0.55 * (1 - k))
  c.fillStyle = '#d6d8e0'
  c.fillRect(Math.round(f.x - r / 2), Math.round(f.y - r / 2), r, r)
  if (r > 2) c.fillRect(Math.round(f.x - r / 2) + 1, Math.round(f.y - r / 2) - 1, r - 2, r + 2)
  c.globalAlpha = 1
}

/** 뽀뽀: 입가에서 작은 하트 셋이 차례로 떠올라 앞으로 날아갑니다 */
function blowKiss(p) {
  // 하트는 입가에서 날아오름 (입 위치는 캐릭터 그림이 알려 줌)
  const m = AvatarMod.mouthOffset?.(p.d ?? 0, p.seated, p.seatH) ?? { dx: p.d === 2 ? -7 : p.d === 3 ? 7 : 0, dy: -18 }
  const side = m.dx + (p.d === 2 ? -2 : p.d === 3 ? 2 : 0)
  for (let i = 0; i < 3; i++) {
    st.hearts.push({ x: p.x + side + (i - 1) * 3, y: p.y + m.dy, t: -0.35 - i * 0.22, life: 1.3, seed: Math.random() * 6 })
  }
}

const HEART = ['.X.X.', 'XXXXX', 'XXXXX', '.XXX.', '..X..']
function drawHeart(c, h) {
  if (h.t < 0) return
  c.globalAlpha = Math.max(0, Math.min(1, (h.life - h.t) / 0.4))
  HEART.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      if (row[i] !== 'X') continue
      rect(c, h.x - 2 + i, h.y + j, 1, 1, j === 1 && i === 1 ? '#ffd0dc' : j > 2 ? '#d8456a' : '#ff6b8a')
    }
  })
  c.globalAlpha = 1
}

/** 이번 주(월요일부터) 켜진 초 전체 */
function weekTotal() {
  if (typeof st.candles.weekTotal === 'number') return st.candles.weekTotal
  return Object.values(st.candles.week ?? {}).reduce((a, n) => a + n, 0)
}

/** 기도 뒤 빛 0~1 */
function templeGlow(now) {
  if (!st.fx.pray) return 0
  const k = 1 - (now - st.fx.pray) / PRAY_GLOW_MS
  return k > 0 ? k : 0
}

/** 이 사당에 다시 초를 켤 수 있을 때까지 남은 ms (0이면 지금 켤 수 있음) */
function litWait(slug) {
  const until = st.lit.get(slug)
  if (!until) return 0
  const left = until - Date.now()
  if (left > 0) return left
  st.lit.delete(slug)
  return 0
}

/** 남은 시간(분, 올림) */
function litMinutes(slug) {
  return Math.max(1, Math.ceil(litWait(slug) / 60_000))
}

function litAgainText(slug) {
  return `${litMinutes(slug)}분 뒤에 다시 켤 수 있어요`
}

function loadLit() {
  try {
    // { until: { slug: 다시 켤 수 있는 시각 } }. 지난 것 · 이상한 값(시계가 크게 틀린 경우 포함)은 버립니다
    const raw = JSON.parse(localStorage.getItem(LIT_KEY) || 'null')
    const now = Date.now()
    if (raw?.until && typeof raw.until === 'object') {
      for (const [slug, until] of Object.entries(raw.until)) {
        if (typeof until === 'number' && until > now && until - now <= 24 * 3600_000) st.lit.set(slug, until)
      }
    }
  } catch { /* 저장이 막힌 브라우저 */ }
  // 남은 시간이 줄어드는 대로 할 일 버튼 · 사당 창 글자를 고칩니다 (다 지나면 다시 '초 켜기')
  setInterval(refreshLit, 10_000)
}

/** 서버가 알려 준 남은 시간(초)만큼 이 사당은 다시 켜지 않습니다 */
function rememberLit(slug, waitSec) {
  const ms = Number.isFinite(waitSec) && waitSec > 0 ? waitSec * 1000 : LIT_COOLDOWN_MS
  st.lit.set(slug, Date.now() + ms)
  const until = {}
  for (const [s, t] of st.lit) if (litWait(s)) until[s] = t
  try { localStorage.setItem(LIT_KEY, JSON.stringify({ until })) } catch { /* 무시 */ }
}

function refreshLit() {
  if (st.near?.kind === 'plot' && st.near.shrine) $('#actBtn').textContent = actionLabel(st.near)
  syncLitBtn()
  if (st.sheetSlug) updateSheetCount()
}

const tierOf = slug => {
  const n = st.candles.week[slug] ?? 0
  return n >= 10 ? 2 : n >= 1 ? 1 : 0
}

function sparkAt(slug) {
  const s = st.bySlug.get(slug)
  const plot = s && st.world.plots[s.plot]
  if (!plot) return
  for (let i = 0; i < 10; i++) {
    st.sparks.push({ x: plot.x + 6 + Math.random() * 36, y: plot.y + 14 + Math.random() * 10, life: 0.8 + Math.random() * 0.6 })
  }
}

/* ══════════ 반투명 창 ══════════
   사당 · 빈 자리 · 배포운은 맵 위에 반투명 창으로 띄웁니다. 맵은 계속 보이고 움직일 수 있으며,
   그 자리를 벗어나면 창이 저절로 닫힙니다. 초 켜기 · 배포운 뽑기 연출은 맵 안에서 보여 줍니다. */

function openSheet(title, body, key) {
  const d = $('#sheet')
  d.textContent = ''
  const head = el('div', 'sheet-head')
  const h = el('h2', null, title)
  h.id = 'sheetTitle'
  const x = el('button', 'sheet-x', '✕')
  x.type = 'button'
  x.setAttribute('aria-label', '닫기')
  x.addEventListener('click', closeSheet)
  head.append(h, x)
  d.append(head, body)
  d.hidden = false
  st.sheetKey = key
  document.body.classList.add('sheet-open')
  if (window.innerWidth <= 720) closePops()
  measureSheet()
}

/** 좁은 화면에서 창 위쪽에 남는 높이(CSS px). 카메라가 캐릭터를 이 공간 가운데에 둡니다 */
function measureSheet() {
  const d = $('#sheet')
  st.sheetTop = !d.hidden && window.innerWidth <= 720 ? d.getBoundingClientRect().top : 0
}

function closeSheet() {
  clearTimeout(st.fortuneTimer)
  st.fx.fortune = null
  st.sheetKey = ''
  st.sheetSlug = ''
  st.sheetTop = 0
  const d = $('#sheet')
  document.body.classList.remove('sheet-open')
  if (d.hidden) return
  d.hidden = true
  d.textContent = ''
  if (!$('#game').hidden) $('#view').focus({ preventScroll: true })
}

/** Space · 버튼 안내: 창이 열린 자리에서는 초 켜기(또는 닫기) */
function hintLabel() {
  if (st.sheetKey && st.sheetKey === st.nearKey) {
    if ($('#sheet').hidden) return '뽑는 중…'
    const light = $('#lightBtn')
    return light && !light.disabled ? '초 켜기' : '닫기'
  }
  return actionLabel(st.near)
}

function openShrine(s) {
  const body = el('div', 'sheet-body')

  const front = el('div', 'front')
  front.append(buildFront(s, tierOf(s.slug)))
  const screen = document.createElement('canvas')
  screen.width = 48
  screen.height = 27
  screen.className = 'front-screen'
  const img = st.images.get(s.slug)
  const paint = () => {
    const small = shrink(img, 48, 27)
    const c = screen.getContext('2d')
    c.imageSmoothingEnabled = false
    c.drawImage(small, 0, 0)
  }
  if (s.status === 'live' && img) img.complete && img.naturalWidth ? paint() : img.addEventListener('load', paint, { once: true })
  front.append(screen, el('span', 'front-banner', prayerLabel(s.prayer)))
  body.append(front)
  // 등록한 서비스 화면은 한 줄 소개 바로 위에 펼쳐 둡니다 (화면이 없는 사당은 그대로)
  if (s.screens?.[0]) body.append(shrineShot(s))
  body.append(el('p', 'tagline', s.tagline))

  const badges = el('div', 'badges')
  badges.append(el('span', 'badge', CATEGORIES[s.category] ?? '기타'))
  if (s.repo || isRepoOnly(s)) badges.append(el('span', 'badge', 'GitHub'))
  badges.append(el('span', 'badge badge-chan', `채널 ${s.channel ?? 1}`))
  const meta = el('p', 'meta')
  meta.id = 'sheetMeta'
  body.append(badges, meta)
  if (s.email) {
    const mail = el('p', 'meta')
    const a = el('a')
    // 긴 주소는 @ 뒤 · 점 앞에서 먼저 줄을 바꿉니다 (<wbr>은 복사해도 글자에 끼지 않음). 그래도 길면 CSS가 아무 곳에서나
    for (const part of s.email.split(/(?=\.)|(?<=@)/)) {
      if (a.childNodes.length) a.append(document.createElement('wbr'))
      a.append(part)
    }
    a.href = `mailto:${s.email}`
    a.title = s.email
    mail.append('연락 ', a)
    body.append(mail)
  }

  if (s.status !== 'live') {
    body.append(el('p', 'warn', '점검중인 사당입니다. 확인이 끝날 때까지 초 켜기와 서비스 가보기를 잠시 막아 두었습니다.'))
  } else {
    const prayers = el('div', 'prayers')
    prayers.setAttribute('role', 'radiogroup')
    prayers.setAttribute('aria-label', '기원 고르기')
    const drawPrayers = () => {
      prayers.textContent = ''
      for (const p of PRAYERS) {
        const b = el('button', 'chip', p.label)
        b.type = 'button'
        b.setAttribute('role', 'radio')
        b.setAttribute('aria-checked', String(st.prayer === p.key))
        b.addEventListener('click', () => { st.prayer = p.key; drawPrayers() })
        prayers.append(b)
      }
    }
    drawPrayers()
    const actions = el('div', 'actions')
    const light = el('button', 'btn btn-main', '초 켜기')
    light.type = 'button'
    light.id = 'lightBtn'
    light.addEventListener('click', () => lightCandle(s))
    const link = (text, href) => {
      const a = el('a', 'btn', text)
      a.href = href
      a.target = '_blank'
      a.rel = 'noopener nofollow'
      return a
    }
    // GitHub만 있는 프로젝트는 GitHub 보기 하나, 서비스와 저장소가 다 있으면 둘 다
    if (isRepoOnly(s)) actions.append(light, link('GitHub 보기 ↗', `${BASE}/go/${s.slug}`))
    else {
      actions.append(light, link('서비스 가보기 ↗', `${BASE}/go/${s.slug}`))
      if (s.repo) actions.append(link('GitHub 보기 ↗', `${BASE}/go/${s.slug}/repo`))
    }
    body.append(prayers, actions)
  }

  // 안내는 접어 둡니다
  const more = el('details', 'more')
  more.append(el('summary', null, '안내'))
  more.append(el('p', 'note',
    (s.joinedAt ? `입점 ${dotDate(s.joinedAt)}. ` : '')
    + (s.screens?.[0] && s.capturedAt ? `실제 화면은 ${dotDate(s.capturedAt)}에 찍었습니다. ` : '')
    + '내 프로젝트는 광장 북쪽 등록소에서 고칠 수 있어요.'
    + (st.chat.contact ? ` 문제가 있는 사당은 ${st.chat.contact}으로 알려 주세요.` : '')))
  body.append(more)

  openSheet(s.name, body, `p${s.plot}`)
  st.sheetSlug = s.slug
  updateSheetCount()
}

/** 사당 창의 서비스 화면: 작은 브라우저 틀(도메인) 안에 첫 장. 불러오지 못하면 틀째 빼서 깨진 그림이 남지 않게 합니다 */
function shrineShot(s) {
  const shot = el('figure', 'shot')
  const bar = el('div', 'shot-bar')
  bar.setAttribute('aria-hidden', 'true')
  bar.append(el('i'), el('i'), el('i'), el('span', null, s.domain))
  const img = document.createElement('img')
  img.alt = `${s.name} 실제 화면`
  img.loading = 'lazy'
  img.decoding = 'async'
  img.addEventListener('error', () => shot.remove(), { once: true })
  // 정사각 · 세로 이미지(대표 이미지 · 휴대폰 화면)는 자르지 않고 통째로 보여 줍니다
  img.addEventListener('load', () => img.classList.toggle('whole', img.naturalWidth < img.naturalHeight * 1.3), { once: true })
  img.src = `${BASE}/img/shrines/${s.screens[0]}`
  shot.append(bar, img)
  return shot
}

function updateSheetCount() {
  const s = st.bySlug.get(st.sheetSlug)
  if (!s) return
  const meta = $('#sheetMeta')
  if (meta) meta.textContent = `운영 ${s.operator} · ${s.domain} · 이번 주 초 ${(st.candles.week[s.slug] ?? 0).toLocaleString('ko-KR')}개`
  const light = $('#lightBtn')
  if (light) {
    const cooling = litWait(s.slug) > 0
    light.disabled = cooling
    light.textContent = cooling ? litAgainText(s.slug) : '초 켜기'
  }
}

/** 초 켜기: 창을 닫고, 내 캐릭터가 절하는 동안 서버에 요청합니다. 결과는 맵 안 연출(onLit)로 보여 줍니다. */
function lightCandle(s) {
  if (litWait(s.slug)) return toast(LIGHT_FAIL.already(litMinutes(s.slug)))
  send({ t: 'light', s: s.slug, p: st.prayer })
  st.me.d = 1
  st.me.bow = 1.1
  send({ t: 'emo', k: 'bow' })
  closeSheet()
}

/** 성공하면 내 손에서 불씨가 날아가 사당 초에 붙고, 사당 위로 기원이 떠오릅니다 */
function onLit(m) {
  if (m.ok || m.reason === 'already') rememberLit(m.s, m.wait)
  const s = st.bySlug.get(m.s)
  if (m.ok) {
    const plot = s && st.world.plots[s.plot]
    if (plot) {
      st.flyers.push({
        x0: st.me.x, y0: st.me.y - 16, x1: plot.x + 24, y1: plot.y + 20, t: 0, dur: 0.75,
        slug: m.s, text: `+1 ${prayerLabel(m.p)}`,
      })
    }
    toast(`${s?.name ?? ''}에 ${prayerLabel(m.p)} 초를 켰습니다.`)
  } else {
    const why = LIGHT_FAIL[m.reason]
    toast(m.reason === 'already' ? why(litMinutes(m.s)) : why ?? '초를 켜지 못했습니다.')
  }
  if (st.near) $('#actBtn').textContent = actionLabel(st.near)
  syncLitBtn()
  updateSheetCount()
}

function openEmpty(plot) {
  const body = el('div', 'sheet-body')
  body.append(
    el('p', 'tagline', '아직 비어 있는 자리입니다.'),
    el('p', 'meta', '로그인하고 https로 열리는 자기 도메인 서비스를 등록하면, 도메인 확인 뒤 바로 이 자리에 사당이 생깁니다. 사당 만들기는 곧 열립니다.'),
  )
  openSheet('빈 자리', body, `p${plot.id}`)
}

/* ── 배포운 상자: 흔들기 → 쪽지가 튀어나옴 → 쪽지를 펼쳐 보여 줌 ── */

const FORTUNE_SHAKE = 0.9
const FORTUNE_POP = 0.35

/** 뽑을 때마다 새로 고릅니다. 바로 앞에 나온 쪽지는 한 번 피합니다 */
let lastFortune = -1
function pickFortune() {
  let i = Math.floor(Math.random() * FORTUNES.length)
  if (i === lastFortune && FORTUNES.length > 1) i = (i + 1 + Math.floor(Math.random() * (FORTUNES.length - 1))) % FORTUNES.length
  lastFortune = i
  return FORTUNES[i]
}
// 예전(하루 고정) 방식이 남긴 무작위 값은 이제 쓰지 않아 지웁니다
try { localStorage.removeItem('shrine-seed') } catch { /* 저장소를 못 써도 괜찮음 */ }

function startFortune() {
  if (st.sheetKey === 'fortune') return
  closeSheet()
  st.sheetKey = 'fortune'
  st.me.d = 2
  st.me.wave = FORTUNE_SHAKE
  st.fx.fortune = { at: performance.now() }
  st.fortuneTimer = setTimeout(showFortune, (FORTUNE_SHAKE + FORTUNE_POP + 0.15) * 1000)
}

function showFortune() {
  const [level, text] = pickFortune()
  const W = st.world
  st.floaters.push({ x: W.fortune.x + W.fortune.w / 2, y: W.fortune.y - 16, text: `${level}!`, life: 2.2, color: '#ffd36b' })
  const body = el('div', 'sheet-body')
  const slip = el('div', `slip slip-${['대길', '중길', '소길', '소흉'].indexOf(level)}`)
  slip.append(
    el('p', 'slip-head', '오늘의 배포운'),
    el('p', 'slip-level', level),
    el('p', 'slip-text', text),
    el('p', 'slip-date', `${dotDate(kstToday())} · 하루에 한 번 바뀝니다`),
  )
  body.append(slip)
  openSheet('배포운 상자', body, 'fortune')
}

/** 맵에 그릴 상자 상태: 흔들림(-1 · 0 · 1)과 쪽지가 올라온 정도(0~1) */
function fortuneFx(now) {
  const f = st.fx.fortune
  if (!f) return null
  const t = (now - f.at) / 1000
  if (t < FORTUNE_SHAKE) return { shake: Math.floor(t * 18) % 2 ? 1 : -1, slip: 0 }
  return { shake: 0, slip: Math.min(1, (t - FORTUNE_SHAKE) / FORTUNE_POP) }
}

let toastTimer = 0
function toast(text) {
  const t = $('#toast')
  t.textContent = text
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400)
}

/* ══════════ 움직임 ══════════ */

function move(p, dx, dy, dt, followingPath) {
  const len = Math.hypot(dx, dy)
  if (!len) {
    p.moving = false
    return
  }
  const speed = st.world.speed * dt
  const step = followingPath ? Math.min(speed, len) : speed
  const vx = (dx / len) * step
  const vy = (dy / len) * step
  let moved = false
  if (vx && !blocked(p.x + vx, p.y)) { p.x += vx; moved = true }
  if (vy && !blocked(p.x, p.y + vy)) { p.y += vy; moved = true }
  p.d = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 2 : 3) : (dy < 0 ? 1 : 0)
  p.moving = moved
  if (moved) p.step += dt * 8
  else if (followingPath) st.path = []
}

function update(dt, now) {
  const me = st.me
  // 화면 패드를 누른 채 패드가 가려지면(창 · 입력칸 · 등록소가 열림) 걷기를 멈춥니다
  if (pad.id !== null && padHidden()) padStop()
  let dx = 0
  let dy = 0
  for (const k of st.keys) {
    const v = MOVE[k]
    if (v) { dx += v[0]; dy += v[1] }
  }
  let following = false
  if (!dx && !dy && st.path.length) {
    const target = st.path[0]
    if (dist(me, target) < 1.5) {
      st.path.shift()
      if (!st.path.length && st.arrive) {
        st.arrive = false
        st.near = nearest()
        if (st.near) act()
      }
    } else {
      dx = target.x - me.x
      dy = target.y - me.y
      following = true
    }
  }
  if (me.seat >= 0) {
    if (dx || dy) standUp(true)
    else { dx = 0; dy = 0 }
  }
  if (me.bow > 0) { me.bow -= dt; dx = 0; dy = 0 }
  if (me.wave > 0) me.wave -= dt
  if (me.jump > 0) me.jump -= dt
  if (me.spin > 0) me.spin -= dt
  if (me.kiss > 0) me.kiss -= dt
  if (me.smoke > 0) me.smoke -= dt
  move(me, dx, dy, dt, following)

  for (const o of st.others.values()) {
    const k = Math.min(1, dt * 12)
    o.x += (o.tx - o.x) * k
    o.y += (o.ty - o.y) * k
    if (o.moving) o.step += dt * 8
    if (o.bow > 0) o.bow -= dt
    if (o.wave > 0) o.wave -= dt
    if (o.jump > 0) o.jump -= dt
    if (o.spin > 0) o.spin -= dt
    if (o.kiss > 0) o.kiss -= dt
    if (o.smoke > 0) o.smoke -= dt
  }

  // 앉아 있는 동안은 이동을 보내지 않습니다 (서버는 이동을 받으면 일으켜 세웁니다)
  if (me.seat < 0 && now - st.sent.at > 100) {
    const s = st.sent
    if (Math.abs(me.x - s.x) > 0.5 || Math.abs(me.y - s.y) > 0.5 || me.moving !== s.m || me.d !== s.d) {
      send({ t: 'mv', x: Math.round(me.x * 10) / 10, y: Math.round(me.y * 10) / 10, d: me.d, m: me.moving })
      st.sent = { x: me.x, y: me.y, d: me.d, m: me.moving, at: now }
    }
  }

  const n = nearest()
  const key = n ? (n.kind === 'plot' ? `p${n.plot.id}` : n.kind === 'seat' ? `s${n.seat.id}` : n.kind) : ''
  if (key !== st.nearKey) {
    st.nearKey = key
    st.near = n
    if (st.sheetKey && st.sheetKey !== key) closeSheet()
    const btn = $('#actBtn')
    btn.textContent = actionLabel(n)
    btn.disabled = !n
    syncLitBtn()
  }

  for (const f of st.flyers) {
    f.t += dt
    if (f.t >= f.dur) {
      f.done = true
      sparkAt(f.slug)
      st.floaters.push({ x: f.x1, y: f.y1 - 24, text: f.text, life: 1.8, color: '#ffd36b' })
    }
  }
  st.flyers = st.flyers.filter(f => !f.done)
  for (const f of st.floaters) {
    f.y -= dt * 9
    f.life -= dt
  }
  st.floaters = st.floaters.filter(f => f.life > 0)
  for (const h of st.hearts) {
    h.t += dt
    if (h.t > 0) {
      h.y -= dt * 16
      h.x += Math.sin(h.t * 5 + h.seed) * dt * 6
    }
  }
  st.hearts = st.hearts.filter(h => h.t < h.life)
  st.glow += (glowTarget(weekTotal()) - st.glow) * Math.min(1, dt * 1.2)
  if (st.flash > 0) st.flash = Math.max(0, st.flash - dt / 1.6)
  updateSky(st.sky, dt, Math.min(1, st.glow + st.flash * 0.12), st.world)
  if (st.sky.burst) {
    st.sky.burst = false
    burst(st.sky, st.cam.x, st.cam.y, VW)
  }
  updatePuffs(dt)
  st.sparks = st.sparks.filter(sp => (sp.life -= dt) > 0)
  for (const sp of st.sparks) sp.y -= dt * 12
  for (const [id, b] of st.bubbles) if (b.until < now) st.bubbles.delete(id)
}

/* ══════════ 그리기 ══════════ */

/** 글을 maxW 너비로 줄바꿈 (띄어쓰기에서 먼저 끊고, 안 되면 글자 단위) */
function wrapLines(c, text, maxW, maxLines) {
  const lines = []
  let line = ''
  for (const ch of [...text]) {
    const next = line + ch
    if (line && c.measureText(next).width > maxW) {
      const sp = line.lastIndexOf(' ')
      if (ch !== ' ' && sp > 0) {
        lines.push(line.slice(0, sp))
        line = line.slice(sp + 1) + ch
      } else {
        lines.push(line)
        line = ch === ' ' ? '' : ch
      }
    } else line = next
  }
  if (line) lines.push(line)
  if (lines.length > maxLines) {
    lines.length = maxLines
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, -1)}…`
  }
  return lines
}

/** 머리 위 말풍선. bottom은 꼬리 끝 바로 위 (CSS 픽셀) */
function drawBubble(c, text, x, bottom) {
  c.font = `700 13px ${FONT}`
  const lines = wrapLines(c, text, 184, 4)
  const lh = 17
  const w = Math.ceil(Math.max(...lines.map(l => c.measureText(l).width))) + 16
  const h = lines.length * lh + 8
  const left = Math.round(x - w / 2)
  const top = Math.round(bottom - h)
  const cx = Math.round(x)
  c.fillStyle = 'rgba(255,248,232,.96)'
  c.fillRect(left + 2, top, w - 4, h)
  c.fillRect(left, top + 2, w, h - 4)
  c.fillRect(left + 1, top + 1, w - 2, h - 2)
  c.fillRect(cx - 4, top + h, 8, 2)
  c.fillRect(cx - 2, top + h + 2, 4, 2)
  c.fillStyle = '#3b2a14'
  lines.forEach((l, i) => c.fillText(l, x, top + 5 + i * lh))
}

/** 사당 소개(공백 포함 8글자): 진한 나무 현판에 밝은 금색 굵은 글씨, 테두리로 또렷하게 (가운데가 y). 자리는 shrine-art.js의 SIGN_Y */
function signLabel(c, text, x, y, small) {
  const size = small ? 12 : 15
  c.font = `900 ${size}px ${FONT}`
  const w = Math.ceil(c.measureText(text).width) + (small ? 12 : 20)
  const h = small ? 20 : 25
  const left = Math.round(x - w / 2)
  const top = Math.round(y - h / 2)
  // 바깥 그림자 · 테두리 · 판 · 윗면 빛 · 금색 안쪽 테
  c.fillStyle = 'rgba(0,0,0,.45)'
  c.fillRect(left + 1, top + 3, w + 2, h + 1)
  c.fillStyle = '#1a0f0a'
  c.fillRect(left - 2, top - 2, w + 4, h + 4)
  c.fillStyle = '#4a2a16'
  c.fillRect(left, top, w, h)
  c.fillStyle = '#6b4022'
  c.fillRect(left, top, w, 3)
  c.strokeStyle = 'rgba(232,192,74,.75)'
  c.lineWidth = 1
  c.strokeRect(left + 2.5, top + 2.5, w - 5, h - 5)
  // 글씨: 어두운 외곽선 위에 밝은 금색
  const ty = top + Math.round((h - size) / 2) - 1
  c.lineJoin = 'round'
  c.lineWidth = 3
  c.strokeStyle = '#1a0f0a'
  c.strokeText(text, x, ty)
  c.fillStyle = '#ffe6a3'
  c.fillText(text, x, ty)
  return [left - 2, top - 2, w + 4, h + 4]
}

/** 장소 이름표: 맵 위에 늘 보이게, 배경을 진하게 */
function placeLabel(c, text, x, y, color, strong, small) {
  c.font = `700 ${small ? 11 : 12}px ${FONT}`
  const w = c.measureText(text).width + (small ? 10 : 14)
  const h = small ? 17 : 19
  const left = Math.round(x - w / 2)
  const top = Math.round(y - 3)
  c.fillStyle = 'rgba(6,12,24,.9)'
  c.fillRect(left, top, Math.round(w), h)
  c.fillStyle = 'rgba(255,255,255,.14)'
  c.fillRect(left, top, Math.round(w), 1)
  c.fillStyle = color
  c.fillText(text, x, y + 1)
  return [left, top, Math.round(w), h]
}

function label(c, text, x, y, color, strong, small) {
  c.font = `${strong ? 700 : 600} ${strong ? 14 : small ? 11 : 12}px ${FONT}`
  const w = c.measureText(text).width + (small ? 8 : 12)
  c.fillStyle = strong ? 'rgba(255,248,232,.95)' : 'rgba(10,21,38,.78)'
  const h = strong ? 21 : small ? 16 : 18
  c.fillRect(Math.round(x - w / 2), Math.round(y - 3), Math.round(w), h)
  c.fillStyle = color
  c.fillText(text, x, y)
  return [x - w / 2, y - 3, w, h]
}

function draw(t) {
  const c = st.ctx
  const W = st.world
  const me = st.me
  const k = st.k
  const dpr = st.dpr
  const u = k / dpr
  // 카메라는 캐릭터를 부드럽게 따라갑니다. 좁은 화면에서 창이 열려 있으면 창 위 공간의 가운데에 둡니다
  const focusH = st.sheetTop ? st.sheetTop / u : VH
  // 화면이 맵보다 넓거나 높으면 맵을 가운데에 둡니다
  const tx = VW >= W.w ? (W.w - VW) / 2 : clamp(me.x - VW / 2, 0, W.w - VW)
  // 창이 열려 있으면 맵 아래쪽 바깥까지 내려가도 됩니다 (그래야 아래 줄 사당도 창 위로 올라옵니다)
  const ty = VH >= W.h ? (W.h - VH) / 2 : clamp(me.y - focusH / 2 - 8, 0, Math.max(W.h - VH, W.h - focusH))
  const follow = st.camReady ? 0.18 : 1
  st.camReady = true
  st.cam.x += (tx - st.cam.x) * follow
  st.cam.y += (ty - st.cam.y) * follow
  if (Math.abs(tx - st.cam.x) < 0.05) st.cam.x = tx
  if (Math.abs(ty - st.cam.y) < 0.05) st.cam.y = ty
  const cx = Math.round(st.cam.x)
  const cy = Math.round(st.cam.y)
  // 도트는 맵 좌표(1px = 기기 화소 k개), 글자는 CSS 픽셀 좌표로 씁니다
  const worldLayer = () => {
    c.setTransform(k, 0, 0, k, -cx * k, -cy * k)
    c.imageSmoothingEnabled = false
  }
  const textLayer = () => {
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    c.textAlign = 'center'
    c.textBaseline = 'top'
  }
  const sx = x => (x - cx) * u
  const sy = y => (y - cy) * u

  c.setTransform(1, 0, 0, 1, 0, 0)
  c.fillStyle = '#0a1222'
  c.fillRect(0, 0, c.canvas.width, c.canvas.height)
  worldLayer()
  drawFloor(c, st.floor, W, cx, cy, VW, VH, t)

  // 서 있는 것(사당 · 소품 · 사람)은 발 위치(y) 순서로 그려 앞뒤가 맞게 합니다.
  // 사당 · 상자 이름표는 그 물건 바로 다음에 그려, 앞에 선 사람이 이름표를 가립니다
  const small = u < 2
  // 이름표 자리 (맵 좌표). 어둠을 덮을 때 이 자리는 빼서 글자가 또렷하게 남습니다
  const holes = []
  const hole = r => holes.push([cx + r[0] / u, cy + r[1] / u, r[2] / u, r[3] / u])
  // 장소 이름표(사당 · 신당 · 등록소 · 게시판 …)는 모아 두었다가 맵 · 어둠 위에 그려 가려지지 않게 합니다
  const placeTags = []
  const tag = (kind, ...args) => placeTags.push([kind, args])
  const inView = b => b.x1 >= cx && b.x0 <= cx + VW && b.y1 >= cy && b.y0 <= cy + VH
  const items = []
  // 빈 자리 이름표는 가장 가까운 한 곳만, 가까이 갔을 때 띄웁니다 (맵이 이름표로 덮이지 않게)
  let nearEmpty = null
  for (const plot of W.plots) {
    if (st.byPlot.has(plot.id)) continue
    const d = dist(me, plot.front)
    if (d <= 72 && (!nearEmpty || d < dist(me, nearEmpty.front))) nearEmpty = plot
  }
  for (const plot of W.plots) {
    if (!inView({ x0: plot.x - 4, y0: plot.y - 26, x1: plot.x + 52, y1: plot.y + 64 })) continue
    items.push([plot.y + 40, () => {
      const s = st.byPlot.get(plot.id)
      if (s) drawShrineHD(c, plot, s, tierOf(s.slug), t, st.minis.get(s.slug))
      else drawEmptyHD(c, plot, t)
      if (!s && plot !== nearEmpty) return
      textLayer()
      // 지붕 위에 늘 떠 있는 소개 (공백 포함 8글자, 현판처럼)
      if (s?.sign) tag('sign', s.sign, sx(plot.x + 24), sy(plot.y + SIGN_Y), small)
      if (s) tag('label', small ? s.name : `${s.name} · 초 ${st.candles.week[s.slug] ?? 0}`, sx(plot.x + 24), sy(plot.y + 41), s.keeper ? '#f7c27a' : '#cfd6e4', false, small)
      else tag('label', small ? '빈 자리' : '빈 자리 · 입점 대기', sx(plot.x + 24), sy(plot.y + 41), '#8a94aa', false, small)
      worldLayer()
    }])
  }
  const glow = templeGlow(t)
  for (const p of W.props) {
    if (p.k === 'mat') continue
    if (p.k === 'temple' || p.k === 'censer') {
      const [hw, hh] = p.k === 'temple' ? TEMPLE_BOX : CENSER_BOX
      if (!inView({ x0: p.x - hw, y0: p.y - hh, x1: p.x + hw, y1: p.y + 4 })) continue
      items.push([p.y, () => {
        ;(p.k === 'temple' ? drawTemple : drawCenser)(c, p.x, p.y, t, glow)
        if (p.k !== 'temple') return
        textLayer()
        tag('label', 'GitHub 신당', sx(p.x), sy(p.y + 3), '#cfd6e4', false, small)
        worldLayer()
      }])
      continue
    }
    const art = ART[p.k]
    if (art) {
      const fn = AiArt[art.fn]
      const [hw, hh] = AiArt[art.box] ?? [24, 48]
      if (!fn || !inView({ x0: p.x - hw, y0: p.y - hh, x1: p.x + hw, y1: p.y + 4 })) continue
      items.push([p.y, () => {
        const ai = p.k === 'ai' ? st.ais.find(a => a.key === p.a) : null
        if (p.k === 'ai' && !ai) return
        if (ai) fn(c, p.x, p.y, t, ai, aiGlow(ai.key, t), st.ai.counts[ai.key] ?? 0)
        else if (p.k === 'trend') fn(c, p.x, p.y, t, st.recentTopics.map(topicColor))
        else fn(c, p.x, p.y, t)
        const name = ai ? ai.name : art.label
        if (!name) return
        textLayer()
        tag('label', name, sx(p.x), sy(p.y + 3), ai?.color ?? art.color, false, small)
        worldLayer()
      }])
      continue
    }
    if (!inView(propBox(p))) continue
    items.push([p.y, () => drawProp(c, p, t)])
  }
  items.push([W.fortune.y + W.fortune.h, () => {
    drawFortune(c, W.fortune, fortuneFx(t))
    textLayer()
    tag('label', '배포운 상자', sx(W.fortune.x + W.fortune.w / 2), sy(W.fortune.y + W.fortune.h + 2), '#a9b4c8', false, small)
    worldLayer()
  }])
  const people = [me, ...st.others.values()]
  for (const p of people) items.push([p.y, () => drawAvatar(c, p, p.look, t)])
  items.sort((a, b) => a[0] - b[0])
  for (const [, paint] of items) paint()
  for (const sp of st.sparks) rect(c, sp.x, sp.y, 1, 1, '#ffd36b')
  for (const h of st.hearts) drawHeart(c, h)
  for (const f of st.puffs) drawPuff(c, f)
  // 초롱 줄은 머리 위에 걸려 있습니다. 밝을수록 켜진 전구가 많습니다
  const b = Math.min(1, st.glow + st.flash * 0.12)
  drawStrings(c, W.strings, t, 0.25 + 0.75 * b)
  for (const f of st.flyers) drawFlyer(c, f, t)
  // 어둠과 불빛: 이번 주 켜진 초가 많을수록 어둠이 걷히고 불빛이 넓어집니다
  drawDarkness(c, cx, cy, VW, VH, lightsNow(t, glow, b, people), holes, b)
  drawSky(c, st.sky, rect, drawGlow)

  textLayer()
  // 글자 자리 (네비게이터 설명이 되도록 피해 갑니다)
  const soft = []
  for (const [kind, args] of placeTags) soft.push((kind === 'sign' ? signLabel : placeLabel)(c, ...args))
  for (const p of people) {
    const id = p === me ? st.myId : p.id
    const bubble = st.bubbles.get(id)
    // 서 있으면 머리 꼭대기가 발에서 약 28px 위, 앉으면 약 19px + 의자 높이
    // 머리 꼭대기 높이는 캐릭터 그림이 알려 줌 (앉으면 의자 높이 · 앉은 자세만큼 낮아짐)
    const top = sy(p.y - (AvatarMod.headTop?.(p) ?? (p.seated ? 21 + p.seatH : 29)))
    if (bubble) drawBubble(c, bubble.text, sx(p.x), top - 6)
    else soft.push(label(c, p === me ? '나' : p.nick, sx(p.x), top - (small ? 13 : 15), p === me ? '#ffffff' : '#a9b4c8', false, small))
  }
  for (const f of st.floaters) drawFloater(c, f, sx, sy)
  if (st.near) soft.push(label(c, `Space · ${hintLabel()}`, sx(me.x), sy(me.y + 4), '#f0a64a'))
  if (st.glasses) drawGlasses(c, t, sx, sy, cx, cy, small, soft)
}

/* ══════════ 네비게이터: 보이는 것마다 옆에 설명 ══════════ */

const GLASSES_KEY = 'shrine-glasses'

function loadGlasses() {
  try { return localStorage.getItem(GLASSES_KEY) === '1' } catch { return false }
}

function setGlasses(on, quiet = false) {
  st.glasses = on
  st.lens = null
  document.body.classList.toggle('glasses-on', on)
  const b = $('#glassesBtn')
  b.setAttribute('aria-pressed', String(on))
  b.title = on ? '네비게이터 끄기 (G)' : '네비게이터 켜기 (G): 보이는 것마다 옆에 설명이 붙어요'
  try { localStorage.setItem(GLASSES_KEY, on ? '1' : '0') } catch { /* 무시 */ }
  if (!quiet) toast(on ? '네비게이터를 켰어요. 보이는 것마다 설명이 붙어요 (G)' : '네비게이터를 껐어요')
}

/** 화면 단추 설명. 위에서부터 중요한 순서로 자리를 잡습니다.
 * wide: 넓은 화면에서만, narrow: 휴대폰에서만 (휴대폰은 화면이 좁아 꼭 필요한 것만 묶어서) */
const HUD_NOTES = [
  { sel: '#actBtn', side: 'above', title: '할 일 버튼', text: '사당 · 신당 · 의자 가까이 가면 할 수 있는 일이 떠요. Space 키로도 돼요', wide: true },
  { sel: '#actBtn', side: 'above', title: '할 일 버튼', text: '가까이 가면 할 수 있는 일이 떠요', narrow: true },
  { sel: '#hudChannel', side: 'below', title: '채널', text: '누르면 채널을 옮겨요. 함께 있는 사람 신고 · 말풍선 숨기기도 여기서' },
  { sel: '#pad', side: 'above', title: '화면 패드', text: '누른 채 밀면 그쪽으로 걸어요. 손을 떼면 멈춰요' },
  { sel: '#minimap', side: 'left', title: '미니맵', text: '누른 곳으로 걸어가요' },
  { sel: '#zoomBar', side: 'left', title: '확대 · 축소 · 미니맵', text: '맵을 크게 · 작게 봐요 (휠 · +/- 키). 미니맵 단추로 미니맵을 켜고 꺼요', wide: true },
  { sel: '#zoomBar', side: 'left', title: '확대 · 축소 · 미니맵', text: '맵 크기를 바꾸고, 미니맵을 켜고 꺼요', narrow: true },
  { sel: '#pickBtn', side: 'above', title: '말 고르기', text: '정해진 인사 · 응원 말을 골라 보내요', wide: true },
  { sel: '#chatInput', side: 'above', title: '직접 말하기', text: '쓰고 Enter. 저장되지 않고 잠깐 떠 있다 사라져요', wide: true },
  { sel: '.sec-chat', side: 'above', title: '채팅', text: '고르기는 정해진 말, 칸에 쓰면 직접 말해요', narrow: true },
  { sel: '.sec-acts', side: 'above', title: '행동', text: '절하기 · 손 흔들기 · 뽀뽀 같은 동작을 해요' },
  { sel: '#barFold', side: 'above', title: '접기 · 펴기', text: '채팅 · 행동 줄을 접어 맵을 넓게 봐요' },
  { sel: '#hudToday', side: 'below', title: '이번 주 초', text: '초가 모일수록 기원소가 밝아져요. 월요일마다 새로 시작해요' },
  { sel: '.hud-right .list summary', side: 'below', title: '사당 목록', text: '이름을 누르면 그 사당으로 걸어가요', wide: true },
  { sel: '#glassesBtn', side: 'below', title: '네비게이터', text: '다시 누르거나 G 키로 설명을 숨겨요', wide: true },
  { sel: '#leaveBtn', side: 'below', title: '옷장', text: '옷 · 머리 · 소품을 다시 골라요', wide: true },
]
const NARROW = 720
/** 설명 카드가 덮으면 안 되는 화면 단추 · 창 */
const HUD_BLOCKS = ['#hudChannel', '#chanPop', '#hudToday', '.hud-right .list', '#glassesBtn', '#leaveBtn', '#minimap', '#zoomBar', '.bar', '#sheet', '#pickPop', '#emoPop', '#pad']

/** 화면 단추 · 창 자리 (캔버스 CSS 좌표). 자주 바뀌지 않아 0.3초마다 잽니다 */
function measureHud(t) {
  if (st.lens && t - st.lensAt < 300) return st.lens
  const v = $('#view').getBoundingClientRect()
  const rectOf = node => {
    if (!node || node.hidden || node.closest('[hidden]')) return null
    const r = node.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return null
    return [r.left - v.left, r.top - v.top, r.width, r.height]
  }
  const blocks = HUD_BLOCKS.map(s => rectOf(document.querySelector(s))).filter(Boolean)
  const notes = []
  const narrow = v.width <= NARROW
  for (const n of HUD_NOTES) {
    if (narrow ? n.wide : n.narrow) continue
    const rect = rectOf(document.querySelector(n.sel))
    if (rect) notes.push({ ...n, rect, color: '#7ff0ff' })
  }
  st.lens = { blocks, notes }
  st.lensAt = t
  return st.lens
}

/** 맵 위 설명: 종류마다 화면 안에서 나와 가장 가까운 하나씩 (맵이 카드로 덮이지 않게) */
function glassesWorldNotes(cx, cy) {
  const W = st.world
  const me = st.me
  const notes = []
  const seen = (x, y) => x >= cx - 4 && x <= cx + VW + 4 && y >= cy - 4 && y <= cy + VH + 4
  const add = (x, y, pad, title, text, color, first = false) => {
    if (seen(x, y)) notes.push({ x, y, pad, title, text, color, d: first ? -1 : Math.hypot(x - me.x, y - me.y) })
  }
  const closest = list => {
    let best = null
    let bestD = Infinity
    for (const [x, y, v] of list) {
      if (!seen(x, y)) continue
      const d = Math.hypot(x - me.x, y - me.y)
      if (d < bestD) { best = [x, y, v]; bestD = d }
    }
    return best
  }
  const touch = window.matchMedia?.('(pointer: coarse)').matches
  add(me.x, me.y - 14, 12, '나', touch ? '화면 패드를 밀거나 가고 싶은 곳을 누르면 걸어가요' : '방향키 · WASD로 걸어요. 맵을 눌러도 그곳으로 가요. 휠 · +/- 키로 확대 · 축소', '#ffffff', true)

  const live = closest(W.plots.filter(p => st.byPlot.has(p.id)).map(p => [p.x + 24, p.y + 16, st.byPlot.get(p.id)]))
  if (live) add(live[0], live[1], 22, `${live[2].name} 사당`, '누군가 만든 프로젝트예요. 앞에서 Space로 둘러보고 초를 켜 주세요 (같은 사당은 30분에 한 번)', '#f7c27a')
  const empty = closest(W.plots.filter(p => !st.byPlot.has(p.id)).map(p => [p.x + 24, p.y + 20, p]))
  if (empty) add(empty[0], empty[1], 20, '빈 자리', '프로젝트 등록소에서 채널 · 자리를 골라 접수하면 여기에 내 사당이 생겨요', '#b8c2d6')

  const ai = closest(W.props.filter(p => p.k === 'ai').map(p => [p.x, p.y - 28, p]))
  if (ai) add(ai[0], ai[1], 16, 'AI 신당', `${st.ais.map(a => a.name).join(' · ')}이 잘 돌아가게 빌어요. 몇 번이든 괜찮아요`, '#7ff0ff')
  for (const p of W.props) {
    if (p.k === 'temple') add(p.x, p.y - 58, 40, 'GitHub 신당', '옥토캣님께 무사배포를 빌어요. 앞에서 Space', '#e8c04a')
    else if (p.k === 'trend') add(p.x, p.y - 30, 36, 'AI 트렌드 게시판', 'AI 소식 · 팁을 나누는 게시판이에요. 아직 준비 중입니다', '#f7c27a')
    else if (p.k === 'registry') add(p.x, p.y - 28, 24, '프로젝트 등록소', '내 프로젝트를 사당으로 올려요. 이메일 + 4자리 비밀번호로 접수 현황을 보고 고쳐요', '#8ef0a8')
    else if (p.k === 'fire') add(p.x, p.y - 8, 14, '광장 모닥불', '모여서 이야기 나누는 곳. 이번 주 초가 많을수록 불빛이 넓어져요', '#ff9a50')
  }
  const f = W.fortune
  add(f.x + f.w / 2, f.y + f.h / 2, 14, '배포운 상자', '오늘의 배포운을 뽑아 봐요. 앞에서 Space', '#d8c8ff')
  if (W.smokeZone) add(W.smokeZone.x, W.smokeZone.y - 8, 26, '고뇌와 번뇌의 공간', '흡연존이에요. 안에서 Space로 온라인 담배 한 대 · 한숨 한 번', '#c8ccd8')
  const seat = closest((W.seats ?? []).filter(s => !seatTaken(s.id)).map(s => [s.x, s.y - 4, s]))
  if (seat) add(seat[0], seat[1], 8, '의자', '앞에서 Space로 앉아요. 움직이면 일어나요', '#d9b48a')
  const other = closest([...st.others.values()].map(p => [p.x, p.y - 14, p]))
  if (other) add(other[0], other[1], 12, '함께 있는 사람', '말 고르기 · 행동으로 인사해 보세요', '#a9b4c8')
  return notes.sort((a, b) => a.d - b.d)
}

function drawGlasses(c, t, sx, sy, cx, cy, small, soft) {
  const u = st.k / st.dpr
  const hud = measureHud(t)
  const world = glassesWorldNotes(cx, cy).map(n => ({ ...n, ax: sx(n.x), ay: sy(n.y), pad: n.pad * u }))
  const w = c.canvas.width / st.dpr
  const me = st.me
  const keep = [[sx(me.x) - 12 * u, sy(me.y) - 32 * u, 24 * u, 34 * u]]
  // 휴대폰은 카드를 작게, 맵 설명은 가까운 몇 개만
  const narrow = w <= NARROW
  drawLens(c, {
    hud: hud.notes, world, blocks: hud.blocks, keep, soft: soft.filter(Boolean),
    w, h: c.canvas.height / st.dpr, small: small || narrow, t, max: narrow ? 4 : small ? 5 : 9, font: FONT,
  })
}

/** GitHub 저장소만 있는 사당 (주소가 github.com/이름/저장소) */
function isRepoOnly(s) {
  return typeof s.domain === 'string' && s.domain.startsWith('github.com/')
}

/* ══════════ 채널 고르기 ══════════ */

function showChannels(list) {
  st.chanList = list ?? []
  const pop = $('#chanPop')
  pop.textContent = ''
  for (const ch of st.chanList) {
    const b = el('button')
    b.type = 'button'
    if (ch.id === st.channel) b.setAttribute('aria-current', 'true')
    b.append(el('span', null, `채널 ${ch.id}`), el('small', null, `${Math.min(st.max, (ch.n ?? 0) + (ch.npc ?? 0))}/${st.max}명`))
    b.addEventListener('click', () => switchChannel(ch.id))
    pop.append(b)
  }
  // 함께 있는 사람 (가까운 사람부터). 누르면 신고 · 말풍선 숨기기
  const people = [...st.others.values()].sort((a, b) => dist(a, st.me) - dist(b, st.me))
  pop.append(el('p', 'chan-head', people.length ? '함께 있는 사람 · 누르면 신고 · 숨기기' : '이 채널에 다른 사람이 아직 없어요'))
  for (const p of people) {
    const b = el('button', 'chan-person')
    b.type = 'button'
    b.dataset.id = p.id
    b.append(el('span', 'chan-nick', p.nick), el('small', null, st.muted.has(p.id) ? '숨김 ›' : '›'))
    b.addEventListener('click', () => showPerson(p.id))
    pop.append(b)
  }
  pop.hidden = false
  $('#hudChannel').setAttribute('aria-expanded', 'true')
}

function closeChannels() {
  $('#chanPop').hidden = true
  $('#hudChannel').setAttribute('aria-expanded', 'false')
}

/* ══════════ 함께 있는 사람: 신고 · 말풍선 숨기기 ══════════ */

const REPORT_REASONS = [['abuse', '욕설 · 괴롭힘'], ['spam', '도배'], ['lewd', '음란'], ['other', '기타']]
const REPORT_USER_OK = '신고했어요. 고마워요.'
const REPORT_USER_FAIL = { self: '나는 신고할 수 없어요.', slow: '잠시 뒤 다시 해 주세요.', none: '그 사람은 이미 나갔어요.' }

/** 한 사람 메뉴 (채널 창 안에서): 말풍선 숨기기(내 화면에서만, 저장 안 함) · 신고 까닭 고르기 */
function showPerson(id) {
  const p = st.others.get(id)
  if (!p) {
    toast(REPORT_USER_FAIL.none)
    return showChannels(st.chanList)
  }
  const pop = $('#chanPop')
  pop.textContent = ''
  const back = el('button', 'chan-back', '‹ 목록으로')
  back.type = 'button'
  back.addEventListener('click', () => {
    showChannels(st.chanList)
    pop.querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus()
  })
  const muted = st.muted.has(id)
  const mute = el('button', muted ? 'chan-mute on' : 'chan-mute', muted ? '말풍선 다시 보기' : '말풍선 숨기기')
  mute.type = 'button'
  mute.addEventListener('click', () => {
    if (st.muted.has(id)) st.muted.delete(id)
    else {
      st.muted.add(id)
      st.bubbles.delete(id)
    }
    toast(st.muted.has(id) ? `${p.nick}님 말풍선을 내 화면에서 숨겨요.` : `${p.nick}님 말풍선을 다시 보여 줘요.`)
    showPerson(id)
  })
  const reasons = el('div', 'chan-reasons')
  reasons.setAttribute('role', 'group')
  reasons.setAttribute('aria-label', '신고 까닭')
  for (const [r, label] of REPORT_REASONS) {
    const b = el('button', null, label)
    b.type = 'button'
    b.addEventListener('click', () => reportUser(id, r))
    reasons.append(b)
  }
  pop.append(back, el('p', 'chan-title', p.nick), mute, el('p', 'chan-head', '신고하기 · 까닭을 골라 주세요'), reasons)
  pop.hidden = false
  $('#hudChannel').setAttribute('aria-expanded', 'true')
  // 누른 줄이 사라졌으니 키보드 초점을 메뉴 안으로
  mute.focus({ preventScroll: true })
}

function reportUser(id, r) {
  const p = st.others.get(id)
  closeChannels()
  $('#view').focus({ preventScroll: true })
  if (!p) return toast(REPORT_USER_FAIL.none)
  // 방문 NPC는 정해진 말만 해서 서버 신고 대상이 아닙니다. 다른 방문객과 똑같이 보이게 답만 합니다
  if (p.npc) return toast(REPORT_USER_OK)
  if (st.ws?.readyState !== WebSocket.OPEN) return toast(REPORT_USER_FAIL.slow)
  send({ t: 'reportUser', id, r })
}

function switchChannel(id) {
  closeChannels()
  if (id === st.channel) return
  closeSheet()
  closePops()
  st.wantCh = id
  st.switching = true
  st.ws?.close()
  toast(`채널 ${id}(으)로 옮겨요.`)
}

/* ══════════ AI 트렌드 게시판 ══════════ */

const POST_FAIL = {
  far: '게시판 앞으로 가서 써 주세요.', topic: '주제를 골라 주세요.', slow: '30초 뒤에 다시 올릴 수 있어요.',
  many: '오늘은 더 올릴 수 없어요. 내일 다시 써 주세요.', empty: '쓸 말을 적어 주세요.', long: '80자까지 쓸 수 있어요.',
  link: '링크나 메일 주소는 올릴 수 없어요.', contact: '연락처나 메신저 아이디는 올릴 수 없어요.', word: '쓸 수 없는 말이 들어 있어요.',
  closed: 'AI 트렌드 게시판은 아직 준비 중입니다.', off: '지금은 글쓰기를 쉬고 있어요.', error: '잠시 문제가 생겼어요. 다시 해 주세요.',
}
const REPORTED_KEY = 'shrine-reported'
const trend = { filter: 'all', topic: '', posts: [] }

function topicList() {
  return [...st.ais.map(a => ({ key: a.key, name: a.name, color: a.color })), TOPIC_ETC]
}

async function openTrend() {
  const body = el('div', 'sheet-body')
  body.append(el('p', 'tagline', 'AI 소식 · 써 본 이야기를 짧게 남겨 주세요. 글은 7일 동안 보이고, 3명이 신고하면 숨겨져요.'))
  // 거르기
  const filters = el('div', 'topics')
  filters.setAttribute('role', 'radiogroup')
  filters.setAttribute('aria-label', '주제로 거르기')
  const drawFilters = () => {
    filters.textContent = ''
    for (const t of [{ key: 'all', name: '전체', color: '' }, ...topicList()]) {
      const b = el('button', 'chip', t.name)
      b.type = 'button'
      b.setAttribute('role', 'radio')
      b.setAttribute('aria-checked', String(trend.filter === t.key))
      if (trend.filter === t.key && t.color) b.style.background = t.color
      b.addEventListener('click', () => { trend.filter = t.key; drawFilters(); renderPosts() })
      filters.append(b)
    }
  }
  drawFilters()
  body.append(filters)
  // 쓰기
  if (st.chat.free) {
    const form = el('form', 'form')
    form.id = 'postForm'
    const pick = el('div', 'topics')
    pick.setAttribute('role', 'radiogroup')
    pick.setAttribute('aria-label', '글 주제')
    const drawPick = () => {
      pick.textContent = ''
      for (const t of topicList()) {
        const b = el('button', 'chip', t.name)
        b.type = 'button'
        b.setAttribute('role', 'radio')
        b.setAttribute('aria-checked', String(trend.topic === t.key))
        if (trend.topic === t.key) b.style.background = t.color
        b.addEventListener('click', () => { trend.topic = t.key; drawPick() })
        pick.append(b)
      }
    }
    drawPick()
    const text = document.createElement('textarea')
    text.id = 'postText'
    text.maxLength = st.chat.postMax ?? 80
    text.placeholder = '예) 새 모델로 리팩터링 맡겨 봤는데 테스트까지 짜 주네요'
    text.setAttribute('aria-label', '글 내용')
    const send1 = el('button', 'btn btn-main', '올리기')
    send1.type = 'submit'
    const count = el('span', 'empty', `0/${text.maxLength}`)
    text.addEventListener('input', () => { count.textContent = `${[...text.value].length}/${text.maxLength}` })
    const row = el('div', 'actions')
    row.append(send1, count)
    form.append(el('label', null, '주제'), pick, text, row)
    form.addEventListener('submit', e => {
      e.preventDefault()
      const v = text.value.replace(/\s+/g, ' ').trim()
      if (!trend.topic) return toast(POST_FAIL.topic)
      if (!v) return toast(POST_FAIL.empty)
      send({ t: 'post', a: trend.topic, s: v })
    })
    body.append(form)
  }
  const list = el('ul', 'posts')
  list.id = 'postList'
  list.append(el('li', 'empty', '불러오는 중…'))
  body.append(list)
  openSheet('AI 트렌드 게시판', body, 'trend')
  try {
    const res = await fetch(`${BASE}/api/posts`, { cache: 'no-store' })
    trend.posts = (await res.json()).posts ?? []
  } catch {
    trend.posts = []
  }
  renderPosts()
}

function reportedIds() {
  try { return new Set(JSON.parse(localStorage.getItem(REPORTED_KEY) || '[]')) } catch { return new Set() }
}

function renderPosts() {
  const list = $('#postList')
  if (!list) return
  list.textContent = ''
  const shown = trend.posts.filter(p => trend.filter === 'all' || p.topic === trend.filter)
  if (!shown.length) {
    list.append(el('li', 'empty', '아직 글이 없어요. 첫 소식을 남겨 주세요.'))
    return
  }
  const done = reportedIds()
  for (const p of shown) {
    const t = topicList().find(x => x.key === p.topic) ?? TOPIC_ETC
    const li = el('li', 'post')
    li.dataset.id = p.id
    const meta = el('div', 'post-meta')
    const tag = el('span', 'tag', t.name)
    tag.style.background = t.color
    const rep = el('button', null, done.has(p.id) ? '신고함' : '신고')
    rep.type = 'button'
    rep.disabled = done.has(p.id)
    rep.addEventListener('click', () => send({ t: 'report', id: p.id }))
    meta.append(tag, el('span', null, `${p.nick} · ${ago(p.at)}`), rep)
    li.append(el('p', null, p.text), meta)
    list.append(li)
  }
}

function ago(at) {
  const m = Math.floor((Date.now() - at) / 60000)
  if (m < 1) return '방금'
  if (m < 60) return `${m}분 전`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}시간 전` : `${Math.floor(h / 24)}일 전`
}

function onPost(post) {
  if (!post) return
  st.recentTopics = [post.topic, ...st.recentTopics].slice(0, 16)
  trend.posts = [post, ...trend.posts.filter(p => p.id !== post.id)]
  if (st.sheetKey === 'trend') renderPosts()
}

function onPostOk() {
  const text = $('#postText')
  if (text) {
    text.value = ''
    text.dispatchEvent(new Event('input'))
  }
  toast('게시판에 올렸어요.')
}

function onPostHide(id) {
  trend.posts = trend.posts.filter(p => p.id !== id)
  if (st.sheetKey === 'trend') renderPosts()
}

function onReported(id) {
  const done = reportedIds()
  done.add(id)
  try { localStorage.setItem(REPORTED_KEY, JSON.stringify([...done].slice(-200))) } catch { /* 무시 */ }
  toast('신고했어요. 여러 명이 신고하면 숨겨져요.')
  if (st.sheetKey === 'trend') renderPosts()
}

/* ══════════ 프로젝트 등록소 (딤드 모달) ══════════ */

const REG_FAIL = {
  name: '프로젝트 이름을 1~20자로 적어 주세요. 링크는 넣을 수 없어요.',
  tagline: '한 줄 소개를 1~40자로 적어 주세요. 링크는 넣을 수 없어요.',
  sign: '사당 소개는 공백 포함 8자까지 적어 주세요.',
  category: '분류를 골라 주세요.',
  link: 'GitHub 저장소나 서비스 주소 중 하나는 꼭 적어 주세요.',
  github: '공개 저장소의 https://github.com/이름/저장소 주소인지 확인해 주세요.',
  url: 'https로 시작하는 실제 도메인이어야 해요.',
  email: '이메일 주소를 확인해 주세요.',
  pin: '숫자 4자리로 적어 주세요.',
  word: '쓸 수 없는 말이 들어 있어요.',
  contact: '이름 · 소개에는 연락처를 넣을 수 없어요.',
  dup: '이미 접수된 저장소나 주소예요.',
  many: '오늘은 더 접수할 수 없어요. 내일 다시 해 주세요.',
  slow: '2분 뒤에 다시 접수해 주세요.',
  locked: '비밀번호를 여러 번 틀려서 잠겼어요. 잠시 뒤(오늘 너무 많이 틀렸다면 내일) 다시 해 주세요.',
  none: '등록 번호를 찾지 못했어요.',
  ticket: '입장 표가 만료됐어요. 다시 입장해 주세요.',
  image: '이미지를 올리지 못했어요. PNG · JPG · WebP, 5MB까지예요.',
  plot: '그 채널의 그 자리에는 이미 사당이 있어요. 다른 자리나 채널을 골라 주세요.',
  channel: '채널을 다시 골라 주세요.',
  consent: '개인정보 수집 · 이용에 동의해야 접수할 수 있어요.',
  blocked: '이용이 제한된 상태라 접수할 수 없어요. 문의는 화면 아래 연락처로 보내 주세요.',
  busy: '지금 올리는 사람이 많아요. 잠시 뒤 다시 해 주세요.',
  full: '저장 공간이 부족해 지금은 받을 수 없어요. 잠시 뒤 다시 해 주세요.',
}
/** 이미지 올리기 실패 까닭 */
const IMG_FAIL = {
  size: '5MB 이하 이미지만 올릴 수 있어요.', type: 'PNG · JPG · WebP 이미지만 올릴 수 있어요.',
  slow: '이미지는 1시간에 10장까지 올릴 수 있어요.', many: '오늘은 이미지를 더 올릴 수 없어요.',
  full: '지금은 이미지를 받을 수 없어요. 나중에 다시 해 주세요.', bad: '이미지 파일을 읽지 못했어요.',
  timeout: '이미지를 올리는 데 너무 오래 걸렸어요. 연결을 확인하고 다시 해 주세요.',
}
const IMG_MAX = 5 * 1024 * 1024
/** 서버가 돌려준 까닭 → 오류를 띄울 칸 */
const REG_FIELD = { plot: 'plot', channel: 'plot', image: 'image', name: 'name', tagline: 'tagline', sign: 'sign', category: 'category', link: 'github', github: 'github', url: 'url', email: 'email', pin: 'pin', dup: 'github', consent: 'consent' }
const STATUS_LABEL = { pending: '검토 중', approved: '맵에 올라감', rejected: '반려', withdrawn: '내림' }
const MY_PROJECTS = 'shrine-my-projects'
const reg = { tab: 'new' }

function myProjects() {
  try { return JSON.parse(localStorage.getItem(MY_PROJECTS) || '[]') } catch { return [] }
}

async function regApi(path, body) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: body ? 'POST' : 'GET', cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    return { http: res.status, ...data }
  } catch {
    return { ok: false, reason: 'net' }
  }
}

/** 입력칸 하나: 이름표 · 칸 · 도움말 · 오류 자리 */
function regField(name, label, input, opts = {}) {
  const wrap = el('label', `rf${opts.full ? ' full' : ''}`)
  wrap.dataset.name = name
  const head = el('span', 'rf-label', label)
  if (opts.optional) head.append(el('em', null, '선택'))
  wrap.append(head, input)
  if (opts.help) wrap.append(el('small', 'rf-help', opts.help))
  wrap.append(el('small', 'rf-err'))
  input.addEventListener('input', () => wrap.classList.remove('bad'))
  return wrap
}

function regInput(name, opts = {}) {
  const i = document.createElement('input')
  i.name = name
  i.type = opts.type ?? 'text'
  if (opts.max) i.maxLength = opts.max
  if (opts.placeholder) i.placeholder = opts.placeholder
  if (opts.value != null) i.value = opts.value
  if (opts.inputmode) i.inputMode = opts.inputmode
  i.autocomplete = 'off'
  i.spellcheck = false
  return i
}

function regSelect(value) {
  const sel = document.createElement('select')
  sel.name = 'category'
  for (const [k, v] of Object.entries(CATEGORIES)) {
    const o = el('option', null, v)
    o.value = k
    if (k === value) o.selected = true
    sel.append(o)
  }
  return sel
}

function showFieldError(form, reason) {
  const name = REG_FIELD[reason]
  const box = name && form.querySelector(`.rf[data-name="${name}"]`)
  if (!box) return toast(REG_FAIL[reason] ?? '지금은 처리할 수 없어요. 잠시 뒤 다시 해 주세요.')
  box.classList.add('bad')
  box.querySelector('.rf-err').textContent = REG_FAIL[reason]
  box.querySelector('input, select')?.focus()
}

/** 등록 · 수정 공통 입력칸 (세 묶음) */
function projectFields(form, p = {}) {
  const group = (title, note, ...items) => {
    const g = el('fieldset', 'rg')
    const legend = el('legend', null, title)
    if (note) legend.append(el('small', null, note))
    const grid = el('div', 'rg-grid')
    grid.append(...items)
    g.append(legend, grid)
    return g
  }
  const pub = document.createElement('input')
  pub.type = 'checkbox'
  pub.name = 'emailPublic'
  pub.checked = Boolean(p.emailPublic)
  const toggle = el('label', 'rf-switch')
  toggle.append(pub, el('span', 'track'), el('span', null, '사당에 이메일 공개'))
  form.append(
    group('프로젝트', null,
      regField('name', '이름', regInput('name', { max: 20, value: p.name, placeholder: '무사배포 봇' })),
      regField('category', '분류', regSelect(p.category ?? 'devtools')),
      regField('sign', '사당 소개 (8자)', regInput('sign', { max: 8, value: p.sign, placeholder: '배포 지킴이 봇' }), { help: '공백 포함 8자. 사당 지붕 위에 늘 떠 있어요' }),
      regField('tagline', '한 줄 소개', regInput('tagline', { max: 40, value: p.tagline, placeholder: '배포 전에 체크리스트를 챙겨 주는 봇' }), { full: true }),
      imageField(form, p),
    ),
    ...(p.status === 'approved' ? [] : [group('채널 · 자리', '사당은 고른 채널에서만 보여요', plotPicker(form, p))]),
    group('링크', '둘 중 하나는 꼭',
      regField('github', 'GitHub 저장소', regInput('github', { value: p.github, placeholder: 'https://github.com/이름/저장소' }), { full: true, optional: true }),
      regField('url', '서비스 주소', regInput('url', { value: p.url, placeholder: 'https://my-service.com' }), { full: true, optional: true }),
    ),
    group('연락 · 관리', null,
      regField('email', '이메일', regInput('email', { type: 'email', max: 80, value: p.email, placeholder: 'me@example.com' }), { full: true, help: '운영자가 확인 연락을 드릴 때 써요' }),
      toggle,
    ),
  )
}

/** 자리 묶음 이름 */
function plotArea(id) {
  return id < 10 ? '위쪽 골목' : id < 15 ? '서쪽 마당' : '서쪽 비탈 골목'
}

/**
 * 원하는 채널 · 자리 고르기: 채널을 고르면 작은 지도에 그 채널의 자리가 보이고, 빈 자리를 누릅니다 (사당이 있는 자리는 못 고름).
 * 채널마다 자리 20칸이 따로 있고, 사당은 고른 채널에서만 보입니다. 고른 값은 form.wantChannel(1~3) · form.wantPlot(null = 그 채널 아무 데나)
 */
function plotPicker(form, p = {}) {
  const W = st.world
  const channels = Array.from({ length: W.channels ?? 3 }, (_, i) => i + 1)
  // 처음 채널: 고쳐 쓰는 접수면 고른 채널(자리만 고른 예전 접수는 1번), 새 접수면 지금 있는 채널 (넘침 채널이면 1번)
  const saved = p.wantChannel ?? (p.wantPlot != null ? 1 : null)
  form.wantChannel = channels.includes(saved) ? saved : shrineChannel()
  form.wantPlot = p.wantPlot ?? null
  const takenIn = ch => new Map(shrinesIn(ch).map(s => [s.plot, s]))
  const wrap = el('div', 'rplot full')
  wrap.dataset.name = 'plot'
  wrap.classList.add('rf')
  const chans = el('div', 'rplot-chans')
  chans.setAttribute('role', 'radiogroup')
  chans.setAttribute('aria-label', '채널 고르기')
  const chanButtons = new Map()
  for (const ch of channels) {
    const b = el('button', 'chip')
    b.type = 'button'
    b.setAttribute('role', 'radio')
    b.addEventListener('click', () => {
      if (form.wantChannel === ch) return
      form.wantChannel = ch
      // 같은 번호 자리가 그 채널에서도 비어 있으면 그대로 둡니다
      if (form.wantPlot != null && takenIn(ch).has(form.wantPlot)) form.wantPlot = null
      update()
    })
    chanButtons.set(ch, b)
    chans.append(b)
  }
  const map = el('div', 'rplot-map')
  map.style.aspectRatio = `${W.w} / ${W.fenceY ?? W.h}`
  const cv = document.createElement('canvas')
  const scale = 0.5
  cv.width = Math.round(W.w * scale)
  cv.height = Math.round((W.fenceY ?? W.h) * scale)
  const c = cv.getContext('2d')
  if (st.floor) c.drawImage(st.floor, 0, 0, W.w, W.fenceY ?? W.h, 0, 0, cv.width, cv.height)
  // 눈에 띄는 곳 표시 (광장 · 신당 · AI 신당 · 게시판 · 입구)
  const mark = (x, y, w, h, color) => { c.fillStyle = color; c.fillRect(x * scale, y * scale, w * scale, h * scale) }
  for (const q of W.props) {
    if (q.k === 'temple') mark(q.x - 44, q.y - 40, 88, 40, 'rgba(232,192,74,.85)')
    else if (q.k === 'fire') mark(q.x - 8, q.y - 8, 16, 12, 'rgba(255,138,60,.95)')
    else if (q.k === 'ai') mark(q.x - 12, q.y - 22, 24, 22, st.ais.find(a => a.key === q.a)?.color ?? '#aaa')
    else if (q.k === 'trend') mark(q.x - 34, q.y - 30, 68, 30, 'rgba(232,216,168,.9)')
    else if (q.k === 'registry') mark(q.x - 20, q.y - 26, 40, 26, 'rgba(70,224,122,.9)')
  }
  map.append(cv)
  const status = el('p', 'rplot-status')
  const buttons = new Map()
  const update = () => {
    const ch = form.wantChannel
    const taken = takenIn(ch)
    for (const [c, b] of chanButtons) {
      const free = W.plots.length - takenIn(c).size
      b.setAttribute('aria-checked', String(c === ch))
      b.textContent = `채널 ${c}`
      b.append(el('small', null, `빈 ${free}`))
      b.setAttribute('aria-label', `채널 ${c} · 빈 자리 ${free}칸`)
    }
    for (const [id, b] of buttons) {
      const s = taken.get(id)
      b.classList.toggle('taken', !!s)
      b.classList.toggle('on', id === form.wantPlot)
      b.disabled = !!s
      b.setAttribute('aria-label', `채널 ${ch} ${plotArea(id)} ${id}번${s ? ' (사당 있음)' : ''}`)
      b.title = s ? `${s.name} 자리` : `${plotArea(id)} ${id}번`
    }
    const left = W.plots.length - taken.size
    status.textContent = form.wantPlot != null
      ? `고른 자리: 채널 ${ch} · ${plotArea(form.wantPlot)} ${form.wantPlot}번`
      : left ? `채널 ${ch} · 빈 자리 아무 데나` : `채널 ${ch}: 자리가 다 찼어요. 다른 채널을 골라 주세요`
    wrap.classList.remove('bad')
  }
  for (const plot of W.plots) {
    const b = el('button')
    b.type = 'button'
    b.style.left = `${(plot.x + 4) / W.w * 100}%`
    b.style.top = `${plot.y / (W.fenceY ?? W.h) * 100}%`
    b.style.width = `${40 / W.w * 100}%`
    b.style.height = `${40 / (W.fenceY ?? W.h) * 100}%`
    b.addEventListener('click', () => { form.wantPlot = form.wantPlot === plot.id ? null : plot.id; update() })
    buttons.set(plot.id, b)
    map.append(b)
  }
  const any = el('button', 'btn', '아무 데나')
  any.type = 'button'
  any.addEventListener('click', () => { form.wantPlot = null; update() })
  const row = el('div', 'rplot-row')
  row.append(status, any)
  wrap.append(chans, map, row, el('small', 'rf-err'))
  update()
  return wrap
}

/** 이미지 칸: 고르면 미리 보기, 지우기. 고른 파일은 form.imageFile, 지우면 form.imageCleared */
function imageField(form, p = {}) {
  const input = document.createElement('input')
  input.type = 'file'
  input.name = 'image'
  input.accept = 'image/png,image/jpeg,image/webp'
  input.className = 'rf-file'
  const preview = el('div', 'rf-preview')
  const img = document.createElement('img')
  img.alt = ''
  const empty = el('span', null, '이미지 없음')
  preview.append(img, empty)
  const show = src => {
    img.hidden = !src
    empty.hidden = Boolean(src)
    if (src) img.src = src
  }
  show(p.pendingScreen ? `${BASE}/img/shrines/up/${p.pendingScreen}` : p.screen ? `${BASE}/img/shrines/up/${p.screen}` : '')
  const pick = el('button', 'btn', p.screen || p.pendingScreen ? '바꾸기' : '이미지 고르기')
  pick.type = 'button'
  pick.addEventListener('click', () => input.click())
  const clear = el('button', 'btn', '지우기')
  clear.type = 'button'
  clear.hidden = !(p.screen || p.pendingScreen)
  clear.addEventListener('click', () => {
    form.imageFile = null
    form.imageCleared = true
    input.value = ''
    show('')
    clear.hidden = true
    pick.textContent = '이미지 고르기'
  })
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    const box = input.closest('.rf')
    box?.classList.remove('bad')
    if (!file) return
    if (file.size > IMG_MAX) {
      input.value = ''
      if (box) {
        box.classList.add('bad')
        box.querySelector('.rf-err').textContent = IMG_FAIL.size
      }
      return
    }
    form.imageFile = file
    form.imageCleared = false
    show(URL.createObjectURL(file))
    clear.hidden = false
    pick.textContent = '바꾸기'
  })
  const row = el('div', 'rf-image')
  const tools = el('div', 'rf-image-tools')
  tools.append(pick, clear)
  row.append(preview, tools, input)
  const help = p.pendingScreen ? '새 이미지는 운영자가 확인한 뒤 사당에 떠요' : '사당 모니터에 떠요. 사이트 화면이나 대표 이미지 (5MB까지)'
  return regField('image', '이미지', row, { full: true, optional: true, help })
}

/** 고른 이미지를 가로 · 세로 1280px 안으로 줄여(WebP, 안 되면 JPEG) 올립니다. 위치 정보 같은 메타데이터도 빠집니다 */
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
  } catch { /* 줄이지 못하면 원본 그대로 (서버가 5MB · 형식을 다시 확인) */ }
  if (blob.size > IMG_MAX) return { ok: false, reason: 'size' }
  try {
    const res = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob })
    return await res.json().catch(() => ({ ok: false, reason: 'bad' }))
  } catch {
    return { ok: false, reason: 'bad' }
  }
}

/** 이미지 칸 오류 표시 */
function showImageError(form, reason) {
  const box = form.querySelector('.rf[data-name="image"]')
  if (!box) return toast(IMG_FAIL[reason] ?? REG_FAIL.image)
  box.classList.add('bad')
  box.querySelector('.rf-err').textContent = IMG_FAIL[reason] ?? REG_FAIL.image
}

function readProject(form) {
  const f = new FormData(form)
  const v = k => String(f.get(k) ?? '').trim()
  return {
    name: v('name'), tagline: v('tagline'), sign: v('sign'), category: v('category'), github: v('github'), url: v('url'),
    email: v('email'), emailPublic: f.get('emailPublic') === 'on',
  }
}

/** 모달 열기 (등록하기 · 내 접수 현황 · 관리하기) */
function openRegistry(tab) {
  if (tab) reg.tab = tab
  const dlg = $('#regModal')
  const tabs = $('#regTabs')
  tabs.textContent = ''
  for (const [k, name] of [['new', '등록하기'], ['mine', '내 접수 현황'], ['manage', '관리하기']]) {
    const b = el('button', null, name)
    b.type = 'button'
    b.setAttribute('role', 'tab')
    b.setAttribute('aria-selected', String(reg.tab === k))
    b.addEventListener('click', () => openRegistry(k))
    tabs.append(b)
  }
  const body = $('#regBody')
  body.textContent = ''
  if (reg.tab === 'new') regNew(body)
  else if (reg.tab === 'mine') regMine(body)
  else regManage(body)
  st.keys.clear()
  if (!dlg.open) dlg.showModal()
}

function closeRegistry() {
  const dlg = $('#regModal')
  if (dlg.open) dlg.close()
}

/**
 * 개인정보 수집 · 이용 동의 (새 접수만). 체크해야 접수할 수 있고, 서버에는 consent: true로 보냅니다.
 * 고지 항목은 개인정보처리방침의 등록소 항목 · 보유 기간과 같아야 합니다.
 */
function consentField() {
  const box = el('div', 'rf full rconsent')
  box.dataset.name = 'consent'
  const notice = el('div', 'rconsent-box')
  notice.id = 'regConsentNote'
  const list = el('dl', 'rconsent-list')
  for (const [k, v] of [
    ['항목', '이메일, 이메일 공개 여부, 관리 비밀번호(해시로만 저장), 프로젝트 이름 · 소개 · 링크 · 이미지'],
    ['목적', '접수 확인과 운영자 연락, 사당으로 맵에 올리기, 고치거나 내릴 때 본인 확인'],
    ['보유 기간', '검토 중이거나 사당이 맵에 있는 동안. 반려되거나 직접 내리면 30일 뒤 파기'],
  ]) list.append(el('dt', null, k), el('dd', null, v))
  const doc = (path, text) => {
    const a = el('a', null, text)
    a.href = `${BASE}/${path}`
    a.target = '_blank'
    a.rel = 'noopener'
    return a
  }
  const note = el('p', 'rconsent-note', '동의하지 않을 수 있지만, 그러면 접수할 수 없어요. 등록소는 만 14세 이상만 쓸 수 있어요. 자세한 내용: ')
  note.append(doc('privacy', '개인정보처리방침'), ' · ', doc('terms', '이용약관'))
  notice.append(el('p', 'rconsent-title', '개인정보 수집 · 이용 안내'), list, note)
  const check = document.createElement('input')
  check.type = 'checkbox'
  check.name = 'consent'
  check.setAttribute('aria-required', 'true')
  check.setAttribute('aria-describedby', notice.id)
  check.addEventListener('change', () => box.classList.remove('bad'))
  const label = el('label', 'rconsent-check')
  label.append(check, el('span', null, '개인정보 수집 · 이용에 동의합니다 (만\u00a014세\u00a0이상)'))
  box.append(notice, label, el('small', 'rf-err'))
  return box
}

function regNew(body) {
  const form = el('form', 'rform')
  form.noValidate = true
  projectFields(form)
  const pin = regInput('pin', { type: 'password', max: 4, inputmode: 'numeric', placeholder: '••••' })
  form.querySelector('.rg:last-of-type .rg-grid').append(regField('pin', '관리 비밀번호', pin, { help: '숫자 4자리. 고칠 때 써요 (다른 곳 비밀번호는 쓰지 마세요)' }))
  const foot = el('div', 'rform-foot')
  const submit = el('button', 'btn btn-main', '접수하기')
  submit.type = 'submit'
  foot.append(el('p', null, '운영자가 링크를 확인한 뒤 맵에 사당으로 올라가요.'), submit)
  form.append(consentField(), foot)
  form.addEventListener('submit', async e => {
    e.preventDefault()
    for (const b of form.querySelectorAll('.rf.bad')) b.classList.remove('bad')
    const data = readProject(form)
    const p = String(new FormData(form).get('pin') ?? '')
    if (!data.name) return showFieldError(form, 'name')
    if (!data.tagline) return showFieldError(form, 'tagline')
    if (!data.github && !data.url) return showFieldError(form, 'link')
    if (!data.email) return showFieldError(form, 'email')
    if (!/^\d{4}$/.test(p)) return showFieldError(form, 'pin')
    if (!form.elements.consent?.checked) return showFieldError(form, 'consent')
    submit.disabled = true
    if (form.imageFile) {
      submit.textContent = '이미지 올리는 중…'
      const up = await uploadImage(form.imageFile)
      if (!up.ok) {
        submit.disabled = false
        submit.textContent = '접수하기'
        return showImageError(form, up.reason)
      }
      data.screen = up.id
    }
    submit.textContent = '확인하는 중…'
    const r = await regApi('/api/submit', { ...data, pin: p, plot: form.wantPlot ?? null, channel: form.wantChannel ?? null, consent: true })
    submit.disabled = false
    submit.textContent = '접수하기'
    if (!r.ok) return showFieldError(form, r.reason)
    const list = myProjects()
    list.unshift({ id: r.id, code: r.code, name: data.name, at: Date.now() })
    try { localStorage.setItem(MY_PROJECTS, JSON.stringify(list.slice(0, 20))) } catch { /* 무시 */ }
    const done = el('div', 'rdone')
    done.append(
      el('div', 'rdone-mark', '✓'),
      el('h3', null, '접수됐어요'),
      el('p', 'rdone-id', `#${r.id}`),
      el('p', null, '등록 번호예요. 고칠 때 이 번호와 관리 비밀번호가 필요해요.'),
      el('p', 'rdone-sub', '링크를 확인하면 맵에 사당으로 올라가요. 진행 상황은 \'내 접수 현황\'에서 볼 수 있어요.'),
    )
    const ok = el('button', 'btn btn-main', '닫기')
    ok.type = 'button'
    ok.addEventListener('click', closeRegistry)
    done.append(ok)
    form.replaceWith(done)
  })
  body.append(form)
}

/** 이메일 + 관리 비밀번호 입력 폼 (내 접수 현황 · 관리하기 공통) */
function emailPinForm(onFound, button) {
  const form = el('form', 'rform rlogin')
  form.noValidate = true
  const emailIn = regInput('email', { type: 'email', max: 80, placeholder: 'me@example.com', value: reg.email })
  const pinIn = regInput('pin', { type: 'password', max: 4, inputmode: 'numeric', placeholder: '••••' })
  const go = el('button', 'btn btn-main', button)
  go.type = 'submit'
  const row = el('div', 'rg-grid')
  row.append(regField('email', '이메일', emailIn), regField('pin', '관리 비밀번호', pinIn))
  form.append(row, go)
  form.addEventListener('submit', async e => {
    e.preventDefault()
    for (const b of form.querySelectorAll('.rf.bad')) b.classList.remove('bad')
    const email = emailIn.value.trim()
    const pin = pinIn.value
    if (!email) return showFieldError(form, 'email')
    if (!/^\d{4}$/.test(pin)) return showFieldError(form, 'pin')
    go.disabled = true
    const r = await regApi('/api/manage/find', { email, pin })
    go.disabled = false
    if (!r.ok) {
      if (r.reason === 'pin') {
        const box = form.querySelector('.rf[data-name="pin"]')
        box.classList.add('bad')
        box.querySelector('.rf-err').textContent = '이메일이나 비밀번호가 맞지 않아요.'
        return
      }
      return r.reason === 'email' ? showFieldError(form, 'email') : toast(REG_FAIL[r.reason] ?? '찾지 못했어요. 잠시 뒤 다시 해 주세요.')
    }
    reg.email = email
    reg.pin = pin
    onFound(r.projects ?? [], pin)
  })
  return form
}

/** 접수 목록 한 줄 */
function projectRow(p, onManage) {
  const li = el('li')
  const pill = el('span', 'rpill', STATUS_LABEL[p.status] ?? p.status)
  pill.dataset.s = p.status
  if (p.status === 'rejected' && p.note) pill.title = p.note
  const info = el('div')
  const sub = [`#${p.id}`, p.at ? new Date(p.at).toLocaleDateString('ko-KR') : '', p.linkReview ? '바뀐 내용 확인 중' : ''].filter(Boolean).join(' · ')
  info.append(el('strong', null, p.name), el('small', null, sub))
  li.append(info, pill)
  if (onManage) {
    const go = el('button', 'btn', '관리')
    go.type = 'button'
    go.addEventListener('click', () => onManage(p))
    li.append(go)
  }
  return li
}

async function regMine(body) {
  body.append(el('p', 'rintro', '접수할 때 적은 이메일과 관리 비밀번호로 진행 상황을 볼 수 있어요.'))
  const result = el('div')
  body.append(emailPinForm((projects, pin) => {
    result.textContent = ''
    if (!projects.length) {
      result.append(el('p', 'rempty', '접수한 프로젝트가 없어요.'))
      return
    }
    const ul = el('ul', 'rmine')
    for (const p of projects) ul.append(projectRow(p, x => openManage(x.id, pin)))
    result.append(ul)
  }, '조회하기'), result)
}

function regManage(body) {
  const area = el('div')
  if (reg.manageId && reg.pin) {
    body.append(area)
    loadEditor(area, reg.manageId, reg.pin)
    return
  }
  body.append(el('p', 'rintro', '이메일과 관리 비밀번호로 불러와 고치거나 내릴 수 있어요. 링크 · 이미지를 바꾸면 다시 확인한 뒤 반영돼요.'))
  const form = emailPinForm((projects, pin) => {
    area.textContent = ''
    if (!projects.length) return area.append(el('p', 'rempty', '고칠 수 있는 프로젝트가 없어요.'))
    if (projects.length === 1) {
      form.remove()
      return loadEditor(area, projects[0].id, pin)
    }
    const ul = el('ul', 'rmine')
    for (const p of projects) ul.append(projectRow(p, x => { form.remove(); loadEditor(area, x.id, pin) }))
    area.append(el('p', 'rintro', '고칠 프로젝트를 골라 주세요.'), ul)
  }, '불러오기')
  body.append(form, area)
}

/** 목록에서 '관리'를 누르면 관리하기 탭으로 바로 */
function openManage(id, pin) {
  reg.manageId = id
  reg.pin = pin
  openRegistry('manage')
  reg.manageId = null
}

async function loadEditor(area, id, pin) {
  area.textContent = ''
  area.append(el('p', 'rempty', '불러오는 중…'))
  const r = await regApi('/api/manage/get', { id, pin })
  area.textContent = ''
  if (!r.ok) return area.append(el('p', 'rempty', REG_FAIL[r.reason] ?? '불러오지 못했어요.'))
  showEditor(area, id, pin, r.project)
}

function showEditor(area, id, pin, p) {
  area.textContent = ''
  const head = el('div', 'redit-head')
  const pill = el('span', 'rpill', STATUS_LABEL[p.status] ?? p.status)
  pill.dataset.s = p.status
  head.append(el('strong', null, `#${p.id} ${p.name}`), pill)
  if (p.pendingGithub != null || p.pendingUrl != null) head.append(el('small', null, '바뀐 링크 확인 중'))
  const form = el('form', 'rform')
  form.noValidate = true
  projectFields(form, p)
  form.querySelector('.rg:last-of-type .rg-grid').append(
    regField('newPin', '새 비밀번호', regInput('newPin', { type: 'password', max: 4, inputmode: 'numeric', placeholder: '바꿀 때만' }), { optional: true }))
  const foot = el('div', 'rform-foot')
  const drop = el('button', 'btn btn-danger', '프로젝트 내리기')
  drop.type = 'button'
  const save = el('button', 'btn btn-main', '저장')
  save.type = 'submit'
  foot.append(drop, save)
  form.append(foot)
  form.addEventListener('submit', async e => {
    e.preventDefault()
    for (const b of form.querySelectorAll('.rf.bad')) b.classList.remove('bad')
    const data = readProject(form)
    const newPin = String(new FormData(form).get('newPin') ?? '')
    if (newPin && !/^\d{4}$/.test(newPin)) return showFieldError(form, 'pin')
    if (form.imageFile) {
      const up = await uploadImage(form.imageFile)
      if (!up.ok) return showImageError(form, up.reason)
      data.screen = up.id
    } else if (form.imageCleared) data.screen = ''
    const r = await regApi('/api/manage/save', { id, pin, ...data, ...(newPin ? { newPin } : {}), ...(p.status === 'approved' ? {} : { plot: form.wantPlot ?? null, channel: form.wantChannel ?? null }) })
    if (!r.ok) return showFieldError(form, r.reason)
    toast(r.linkReview ? '저장했어요. 바뀐 링크는 확인 뒤 반영돼요.' : '저장했어요.')
    showEditor(area, id, newPin || pin, r.project ?? p)
  })
  drop.addEventListener('click', async () => {
    if (drop.dataset.sure !== '1') {
      drop.dataset.sure = '1'
      drop.textContent = '정말 내릴까요? 한 번 더 누르기'
      return
    }
    const r = await regApi('/api/manage/withdraw', { id, pin })
    if (!r.ok) return toast(REG_FAIL[r.reason] ?? '내리지 못했어요.')
    area.textContent = ''
    const done = el('div', 'rdone')
    done.append(el('h3', null, '프로젝트를 내렸어요'), el('p', 'rdone-sub', '맵에서도 곧 사라져요.'))
    area.append(done)
  })
  area.append(head, form)
}

/** 새 소품 그림 (ai-art.js): 그리는 함수 이름 · 크기 상수 · 이름표 */
const ART = {
  ai: { fn: 'drawAiShrine', box: 'AI_BOX' },
  trend: { fn: 'drawTrendBoard', box: 'TREND_BOX', label: 'AI 트렌드 게시판 · 준비 중', color: '#f7c27a' },
  registry: { fn: 'drawRegistry', box: 'REGISTRY_BOX', label: '프로젝트 등록소', color: '#8ef0a8' },
  ashtray: { fn: 'drawAshtray', box: 'ASHTRAY_BOX' },
  sign: { fn: 'drawSmokeSign', box: 'SMOKESIGN_BOX', label: '고뇌와 번뇌의 공간', color: '#b8bccb' },
}

/** 게시판 주제 → 색 */
function topicColor(key) {
  return st.ais.find(a => a.key === key)?.color ?? TOPIC_ETC.color
}

/** 지금 켜져 있는 불빛 [x, y, 반지름, 세기] (맵 좌표) */
function lightsNow(t, templeGlowNow, b, people) {
  const W = st.world
  const L = []
  const arm = x => (x > W.w / 2 ? -1 : 1)
  for (const p of W.props) {
    if (p.k === 'pole') L.push([p.x + arm(p.x) * 5, p.y - 20, 36, 0.95])
    else if (p.k === 'fire') L.push([p.x, p.y - 4, 74 + Math.sin(t / 130) * 3, 1])
    else if (p.k === 'stone') L.push([p.x, p.y - 12, 28, 0.85])
    else if (p.k === 'censer') L.push([p.x, p.y - 4, 22 + templeGlowNow * 20, 0.75])
    else if (p.k === 'temple') L.push([p.x, p.y - 38, 46 + templeGlowNow * 40, 0.85])
    else if (p.k === 'table') L.push([p.x, p.y - 10, 20, 0.7])
    else if (p.k === 'gate') L.push([p.x - 26, p.y - 30, 28, 0.85], [p.x + 26, p.y - 30, 28, 0.85], [p.x, p.y - 22, 40, 0.5])
  }
  // 담에 걸린 초롱 (랙 사이)
  for (let x = 78; x < W.w - 24; x += 96) L.push([x, 12, 22, 0.7])
  // 전구 줄: 밝을수록 줄 아래가 환해집니다
  for (const [[x0, y0], [x1, y1]] of W.strings) L.push([(x0 + x1) / 2, (y0 + y1) / 2 + 12, 24 + 30 * b, 0.2 + 0.55 * b])
  // 사당 초: 그 사당에 초가 많이 켜질수록 넓게
  for (const plot of W.plots) {
    const s = st.byPlot.get(plot.id)
    if (s?.status === 'live') {
      const tier = tierOf(s.slug)
      L.push([plot.x + 24, plot.y + 22, 24 + tier * 12, 0.8 + tier * 0.1])
    }
  }
  for (const p of people) L.push([p.x, p.y - 12, 18, 0.35])
  for (const f of st.flyers) {
    const q = clamp(f.t / f.dur, 0, 1)
    const e = q * q * (3 - 2 * q)
    L.push([f.x0 + (f.x1 - f.x0) * e, f.y0 + (f.y1 - f.y0) * e - Math.sin(q * Math.PI) * 18, 16, 1])
  }
  for (const l of st.sky.lanterns) L.push([l.x, l.y, 12, 0.8])
  for (const p of W.props) {
    if (p.k === 'ai') {
      const n = Math.min(10, st.ai.counts[p.a] ?? 0)
      L.push([p.x, p.y - 26, 20 + n * 1.5 + aiGlow(p.a, t) * 22, 0.85])
    } else if (p.k === 'trend') L.push([p.x - 34, p.y - 44, 22, 0.7], [p.x + 34, p.y - 44, 22, 0.7], [p.x, p.y - 20, 30, 0.35])
    else if (p.k === 'registry') L.push([p.x - 20, p.y - 30, 24, 0.75], [p.x, p.y - 12, 26, 0.45])
    else if (p.k === 'ashtray') L.push([p.x, p.y - 14, 10, 0.45])
  }
  for (const f of st.puffs) if (f.life < 0.4) L.push([f.x, f.y, 6, 0.4])
  return L
}

/** 날아가는 불씨: 내 손 → 사당 초, 위로 휘는 곡선 */
function drawFlyer(c, f, t) {
  const at = q => {
    const p = clamp(q, 0, 1)
    const e = p * p * (3 - 2 * p)
    return [f.x0 + (f.x1 - f.x0) * e, f.y0 + (f.y1 - f.y0) * e - Math.sin(p * Math.PI) * 18]
  }
  const p = f.t / f.dur
  for (const back of [0.18, 0.09]) {
    const [tx, ty] = at(p - back)
    rect(c, tx, ty, 1, 1, back > 0.1 ? '#b8692a' : '#ffd36b')
  }
  const [x, y] = at(p)
  c.fillStyle = 'rgba(255,179,71,.3)'
  c.fillRect(Math.round(x) - 3, Math.round(y) - 4, 7, 8)
  const flick = Math.floor(t / 90) % 2
  rect(c, x - 1, y - 2, 2, 4, '#f39a2b')
  rect(c, x - 1 + flick, y - 3, 1, 1, '#f39a2b')
  rect(c, x - 1 + flick, y, 1, 1, '#fff1a8')
}

/** 위로 떠오르며 사라지는 글자 (+1 무사배포, 대길! 등) */
function drawFloater(c, f, sx, sy) {
  c.globalAlpha = clamp(f.life / 0.6, 0, 1)
  c.font = `800 15px ${FONT}`
  c.lineJoin = 'round'
  c.lineWidth = 4
  c.strokeStyle = 'rgba(10,21,38,.85)'
  c.strokeText(f.text, sx(f.x), sy(f.y))
  c.fillStyle = f.color ?? '#ffd36b'
  c.fillText(f.text, sx(f.x), sy(f.y))
  c.globalAlpha = 1
}

/* ══════════ 미니맵 (오른쪽 아래) ══════════ */

function drawMinimap() {
  const cv = $('#minimap')
  if (!cv.offsetWidth || !st.floor) return
  const W = st.world
  const dpr = st.dpr
  const cw = Math.round(cv.clientWidth * dpr)
  const ch = Math.round(cv.clientHeight * dpr)
  if (cv.width !== cw) cv.width = cw
  if (cv.height !== ch) cv.height = ch
  const s = Math.min(cw / W.w, ch / W.h)
  const ox = Math.round((cw - W.w * s) / 2)
  const oy = Math.round((ch - W.h * s) / 2)
  st.mini = { s, ox, oy, dpr }
  const c = cv.getContext('2d')
  c.setTransform(1, 0, 0, 1, 0, 0)
  c.clearRect(0, 0, cw, ch)
  c.imageSmoothingEnabled = true
  c.imageSmoothingQuality = 'high'
  c.drawImage(st.floor, ox, oy, W.w * s, W.h * s)
  const box = (x, y, w, h, color) => {
    c.fillStyle = color
    c.fillRect(Math.round(ox + x * s), Math.round(oy + y * s), Math.max(2, Math.round(w * s)), Math.max(2, Math.round(h * s)))
  }
  // 사당: 켜진 곳은 주황, 빈 자리는 흐리게
  for (const plot of W.plots) {
    const sh = st.byPlot.get(plot.id)
    box(plot.x + 6, plot.y + 10, 36, 28, sh ? '#f0a64a' : 'rgba(205,195,175,.4)')
  }
  // 눈에 띄는 곳: 신당 · 모닥불 · 배포운 상자 · 입구 문
  for (const p of W.props) {
    if (p.k === 'temple' || p.k === 'wish') box(p.x - 30, p.y - 34, 60, 34, '#e8c04a')
    else if (p.k === 'fire') box(p.x - 6, p.y - 6, 12, 10, '#ff8a3c')
    else if (p.k === 'gate') box(p.x - 46, p.y - 8, 92, 6, '#c0403a')
    else if (p.k === 'ai') box(p.x - 10, p.y - 18, 20, 18, st.ais.find(a => a.key === p.a)?.color ?? '#e8c04a')
    else if (p.k === 'trend') box(p.x - 30, p.y - 26, 60, 26, '#e8d8a8')
    else if (p.k === 'registry') box(p.x - 18, p.y - 24, 36, 24, '#46e07a')
    else if (p.k === 'ashtray') box(p.x - 22, p.y - 18, 44, 36, 'rgba(160,160,180,.45)')
  }
  box(W.fortune.x, W.fortune.y - 6, W.fortune.w, W.fortune.h + 6, '#c8282e')
  // 지금 보이는 곳
  c.strokeStyle = 'rgba(255,255,255,.6)'
  c.lineWidth = dpr
  c.strokeRect(Math.round(ox + st.cam.x * s) + 0.5, Math.round(oy + st.cam.y * s) + 0.5, Math.round(VW * s), Math.round(VH * s))
  const dot = (x, y, r, color) => {
    c.fillStyle = 'rgba(10,18,34,.9)'
    c.fillRect(Math.round(ox + x * s - r - dpr), Math.round(oy + y * s - r - dpr), Math.round(r * 2 + dpr * 2), Math.round(r * 2 + dpr * 2))
    c.fillStyle = color
    c.fillRect(Math.round(ox + x * s - r), Math.round(oy + y * s - r), Math.round(r * 2), Math.round(r * 2))
  }
  for (const o of st.others.values()) dot(o.x, o.y, 1.5 * dpr, '#7ad0ff')
  if (st.me) dot(st.me.x, st.me.y, 2 * dpr, '#ffffff')
}

/** 미니맵을 누르면 그곳으로 걸어갑니다 (막힌 곳이면 가장 가까운 빈 곳으로) */
function onMinimap(e) {
  e.preventDefault()
  if (!st.mini || !st.me || pad.id !== null) return
  closePops()
  // offsetX · offsetY는 테두리 안쪽 기준입니다
  const { s, ox, oy, dpr } = st.mini
  const x = (e.offsetX * dpr - ox) / s
  const y = (e.offsetY * dpr - oy) / s
  let target = null
  for (let rad = 0; rad <= 32 && !target; rad += 8) {
    for (let a = 0; a < 8 && !target; a++) {
      const tx = x + Math.cos((a / 8) * Math.PI * 2) * rad
      const ty = y + Math.sin((a / 8) * Math.PI * 2) * rad
      if (!blocked(tx, ty)) target = { x: tx, y: ty }
      if (!rad) break
    }
  }
  if (!target) return
  st.path = findPath(st.me, target)
  st.arrive = false
  $('#view').focus({ preventScroll: true })
}

/* ══════════ 화면 단추 접기 · 켜기 ══════════ */

const MINI_KEY = 'shrine-minimap'
const BAR_KEY = 'shrine-bar-folded'

function loadFlag(key, fallback) {
  try {
    const v = localStorage.getItem(key)
    return v === '1' ? true : v === '0' ? false : fallback
  } catch { return fallback }
}

function saveFlag(key, on) {
  try { localStorage.setItem(key, on ? '1' : '0') } catch { /* 무시 */ }
}

/** 미니맵 켜기 · 끄기 (끄면 확대 · 축소 단추가 그 자리로 내려옵니다) */
function setMini(on, save = true) {
  const b = $('#miniBtn')
  if (!b) return
  st.miniOn = on
  st.lens = null
  document.body.classList.toggle('mini-off', !on)
  b.setAttribute('aria-pressed', String(on))
  b.title = on ? '미니맵 끄기' : '미니맵 켜기'
  if (save) saveFlag(MINI_KEY, on)
}

/** 아래 줄 접기 · 펴기: 접으면 할 일 단추(사당 보기 · 초 켜기)만 남고 채팅 · 행동은 숨습니다 */
function setBarFold(folded, save = true) {
  const b = $('#barFold')
  if (!b) return
  st.barFolded = folded
  st.lens = null
  document.body.classList.toggle('bar-folded', folded)
  const label = folded ? '채팅 · 행동 펴기' : '채팅 · 행동 접기'
  b.setAttribute('aria-expanded', String(!folded))
  b.setAttribute('aria-label', label)
  b.title = label
  if (folded) {
    closePops()
    if ($('#barChat')?.contains(document.activeElement) || $('#barActs')?.contains(document.activeElement)) b.focus({ preventScroll: true })
  }
  if (save) saveFlag(BAR_KEY, folded)
  placePad()
}

/* ══════════ 화면 패드 (휴대폰 · 태블릿) ══════════ */

/** 패드를 민 방향 8가지 (오른쪽부터 시계 방향, 화면 y는 아래가 +) → 누르는 가상 방향키.
 * 키보드 방향키와 똑같이 st.keys에 넣으므로 걸음 속도 · 막힌 곳 · 앉았다 일어나기 · 서버로 보내는 이동(mv)이 모두 같습니다 */
const PAD_DIRS = [
  ['r', ['pad:right']], ['dr', ['pad:down', 'pad:right']], ['d', ['pad:down']], ['dl', ['pad:down', 'pad:left']],
  ['l', ['pad:left']], ['ul', ['pad:up', 'pad:left']], ['u', ['pad:up']], ['ur', ['pad:up', 'pad:right']],
]
const PAD_KEYS = ['pad:up', 'pad:down', 'pad:left', 'pad:right']
/** 손잡이가 움직이는 거리(px) · 이만큼 안쪽은 멈춤 */
const PAD_REACH = 32
const PAD_DEAD = 10
/** id: 패드를 누른 손가락(pointerId), dir: PAD_DIRS 번호(-1은 멈춤) */
const pad = { id: null, cx: 0, cy: 0, dir: -1 }

function setPadDir(dir) {
  if (dir === pad.dir) return
  pad.dir = dir
  for (const k of PAD_KEYS) st.keys.delete(k)
  if (dir >= 0) {
    for (const k of PAD_DIRS[dir][1]) st.keys.add(k)
    // 키보드처럼: 누른 곳으로 걷던 길은 버립니다
    st.path = []
    st.arrive = false
  }
  const el = $('#pad')
  if (el) el.dataset.dir = dir >= 0 ? PAD_DIRS[dir][0] : ''
}

function padStop() {
  const el = $('#pad')
  if (!el) return
  if (pad.id !== null) {
    try { el.releasePointerCapture(pad.id) } catch { /* 이미 놓음 */ }
  }
  pad.id = null
  setPadDir(-1)
  el.classList.remove('on')
  el.style.setProperty('--kx', '0px')
  el.style.setProperty('--ky', '0px')
}

/** 패드가 화면에서 가려졌는지 (CSS가 숨김: 마우스 기기 · 창 · 입력칸) */
function padHidden() {
  return $('#game').hidden || $('#regModal').open || !$('#pad') || $('#pad').offsetParent === null
}

function padTrack(e) {
  let dx = e.clientX - pad.cx
  let dy = e.clientY - pad.cy
  const len = Math.hypot(dx, dy)
  if (len > PAD_REACH) {
    dx = (dx / len) * PAD_REACH
    dy = (dy / len) * PAD_REACH
  }
  // 손잡이는 4px 도트 칸에 맞춰 움직입니다
  const el = $('#pad')
  el.style.setProperty('--kx', `${Math.round(dx / 4) * 4}px`)
  el.style.setProperty('--ky', `${Math.round(dy / 4) * 4}px`)
  setPadDir(len < PAD_DEAD ? -1 : (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8)
}

/** 화면 패드는 아래 줄 바로 위에 둡니다 (아래 줄을 접고 펴면 같이 오르내림) */
function placePad() {
  const el = $('#pad')
  const bar = document.querySelector('.bar')
  if (!el || !bar || $('#game').hidden) return
  const g = $('#game').getBoundingClientRect()
  const b = bar.getBoundingClientRect()
  if (b.height) el.style.bottom = `${Math.round(g.bottom - b.top + 10)}px`
}

function bindPad() {
  const el = $('#pad')
  if (!el) return
  el.addEventListener('pointerdown', e => {
    if (pad.id !== null || padHidden()) return
    e.preventDefault()
    pad.id = e.pointerId
    const r = el.getBoundingClientRect()
    pad.cx = r.left + r.width / 2
    pad.cy = r.top + r.height / 2
    try { el.setPointerCapture(e.pointerId) } catch { /* 없어도 됨 */ }
    el.classList.add('on')
    closePops()
    closeChannels()
    padTrack(e)
  })
  el.addEventListener('pointermove', e => { if (e.pointerId === pad.id) padTrack(e) })
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    el.addEventListener(type, e => { if (e.pointerId === pad.id) padStop() })
  }
  // 터치 이벤트로도 한 번 더 (멀티 터치 중 포인터 이벤트를 놓치는 브라우저 대비)
  el.addEventListener('touchend', e => { if (!e.targetTouches.length) padStop() })
  el.addEventListener('touchcancel', padStop)
  el.addEventListener('contextmenu', e => e.preventDefault())
  window.addEventListener('blur', padStop)
  document.addEventListener('visibilitychange', () => { if (document.hidden) padStop() })
  if (window.ResizeObserver) new ResizeObserver(placePad).observe(document.querySelector('.bar'))
  placePad()
}

function loop(t) {
  requestAnimationFrame(loop)
  if ($('#game').hidden || !st.me) {
    st.last = t
    return
  }
  const dt = Math.min(0.05, (t - (st.last || t)) / 1000)
  st.last = t
  update(dt, t)
  draw(t)
  drawMinimap()
}

boot()
