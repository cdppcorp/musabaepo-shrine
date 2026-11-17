// 신당과 향로. 맵 맨 위 가운데에 놓여, 앞에 서서 기도할 수 있습니다. 좌표는 맵 픽셀(도트 1칸 = 1px).
// 신당 안에는 연꽃 대좌 위에 앉은 옥토캣 신상과 광배가 있고, 앞마당에 향로가 놓입니다.
import { drawGlow, rect, shadow } from './pixels.js'

/** 화면 밖 건너뛰기용: [반폭, 기준점 위 높이] */
export const TEMPLE_BOX = [52, 98]
export const CENSER_BOX = [10, 44]

const cache = new Map()
function sprite(key, w, h, paint) {
  let cv = cache.get(key)
  if (!cv) {
    cv = document.createElement('canvas')
    cv.width = w
    cv.height = h
    paint(cv.getContext('2d'))
    cache.set(key, cv)
  }
  return cv
}

/* ── 신상: 옥토캣. 왼쪽 절반(가운데 열 포함 13칸)을 그리고 좌우로 뒤집어 25칸으로 만듭니다 ──
   o 테두리 · K 짙은 회색 몸(명암은 위치로) · F 살구색 얼굴 · Y 큰 타원 눈 · n 코 · v 수염
   L P q 연꽃잎 · B 대좌. 다리(촉수) 다섯 개가 연꽃 위로 퍼지며 끝이 말려 올라갑니다. */
const IDOL_HALF = [
  '...o.........', // 0 귀 끝
  '...oo........',
  '..oKKo.......',
  '..oKKKo......',
  '..oKKKKoooooo', // 4 머리 윗선
  '.oKKKKKKKKKKK',
  '.oKKKKKKKKKKK',
  '.oKKFFFFFFFFF', // 7 얼굴 시작
  'oKKFFFFFFFFFF',
  'oKKFFFYYYFFFF', // 9 눈
  'oKKFFYYYYYFFF',
  'vvvFFYYYYYFFF',
  'oKvvFYYYYYFFn', // 12 코
  'oKKFFFYYYFFFF',
  '.oKKFFFFFFFFF',
  '..oKKFFFFFFFF',
  '...ooKKKKKKKK', // 16 턱 아래
  '.....oKKKKKKK', // 17 몸
  '.....oKKKKKKK',
  '....oKKKKKKKK',
  '...oKKKKKKKKK', // 20 촉수가 갈라집니다
  '..oKKoKKKoKKK',
  '.oKKo.oKKooKK',
  'oKKo..oKKooKK',
  'oKo..oKKo.oKK',
  '.o..oKo...oKK', // 25 끝이 말려 올라감
  '.PLLPLLLPLLLP', // 26 연꽃
  '.LLLLLLLLLLLL',
  '..qqqqqqqqqqq',
  '...BBBBBBBBBB', // 29 대좌
]
const IDOL = IDOL_HALF.map(r => r + [...r.slice(0, 12)].reverse().join(''))
const IW = 25

const INK = { o: '#0c0a10', hi: '#625c6e', l: '#504958', base: '#3a3542', sh: '#26222c' }
/** 광배를 등진 신상 가장자리에 도는 금빛 테 (어두운 몸이 안쪽 벽에 묻히지 않게) */
const RIM = { bright: '#c89a58', dim: '#7e6444' }
const SKIN = { hi: '#ffe6d2', l: '#f8d2b6', base: '#efbfa0', sh: '#d29e80' }

function bodyAt(col, row) {
  const nx = (col - 12) / 12
  if (row < 2 && nx < 0) return INK.hi
  return nx < -0.45 ? INK.l : nx < 0.3 ? INK.base : INK.sh
}

function skinAt(col, row) {
  const nx = (col - 12) / 12
  if (row <= 9 && nx < -0.3) return SKIN.hi
  return nx < -0.12 ? SKIN.l : nx < 0.5 ? SKIN.base : SKIN.sh
}

function paintIdol(c, ox, oy) {
  const px = (x, y, col) => rect(c, ox + x, oy + y, 1, 1, col)
  IDOL.forEach((row, y) => {
    for (let x = 0; x < IW; x++) {
      const ch = row[x]
      if (ch === '.') continue
      let col
      switch (ch) {
        case 'o': {
          const bg = (dx, dy) => (IDOL[y + dy]?.[x + dx] ?? '.') === '.'
          col = bg(0, -1) || bg(-1, 0) ? RIM.bright : bg(1, 0) || bg(0, 1) ? RIM.dim : INK.o
          if (y >= 26) col = INK.o
          break
        }
        case 'K': col = bodyAt(x, y); break
        case 'F': col = skinAt(x, y); break
        case 'Y': col = '#2a1a1c'; break
        case 'n': col = '#d8687a'; break
        case 'v': col = '#d8d0c8'; break
        case 'L': col = '#c8607a'; break
        case 'P': col = '#f0a0b8'; break
        case 'q': col = '#8a3a52'; break
        case 'B': col = x < 12 ? '#8a6428' : '#6a4a1e'; break
        default: col = INK.base
      }
      px(x, y, col)
    }
  })
  // 눈 반짝임 (두 눈 모두 왼쪽 위)과 눈동자 아래쪽 밝은 테
  for (const ex of [6, 16]) {
    px(ex, 10, '#ffffff')
    px(ex + 1, 10, '#ffffff')
    px(ex, 11, '#f4eef0')
    px(ex + 2, 13, '#5a3a3a')
  }
  // 입: 코 아래 작은 웃음
  px(11, 13, '#b8705e'); px(13, 13, '#b8705e'); px(12, 14, '#b8705e')
  // 볼 홍조
  px(5, 14, '#f0a8a0'); px(19, 14, '#f0a8a0')
  // 귀 안쪽 · 머리 윤곽 하이라이트
  px(4, 3, '#5a5464'); px(4, 4, '#5a5464')
  px(3, 6, INK.hi); px(2, 8, INK.hi)
  // 몸통 가운데 결, 촉수 사이 그늘
  px(12, 18, INK.sh); px(11, 19, INK.sh)
  for (const [x, y] of [[4, 21], [3, 22], [9, 21], [15, 21], [21, 21]]) px(x, y, INK.l)
  // 연꽃잎 사이 금 · 대좌 하이라이트
  for (let x = 2; x < 23; x += 3) px(x, 27, '#a84a64')
  px(3, 29, '#a8843a'); px(4, 29, '#a8843a')
}

/** 광배: 머리 뒤 둥근 두광과 몸 뒤 큰 신광 */
function paintHalo(c, cx, headY, bodyY) {
  for (let y = -26; y <= 22; y++) {
    for (let x = -16; x <= 16; x++) {
      const body = Math.hypot(x / 15, (y - (bodyY - headY)) / 19)
      const head = Math.hypot(x, y) / 9.5
      let col = null
      if (body < 1) col = body > 0.9 ? '#b8862a' : body > 0.82 ? '#3a2416' : (x + y) % 2 ? '#2a1a16' : '#30201a'
      if (body < 1 && body > 0.9 && y < bodyY - headY - 10 && Math.abs(x) % 3 === 0) col = '#e8c04a'
      if (head < 1) col = head > 0.88 ? '#e8c04a' : head > 0.76 ? '#4a3018' : head > 0.6 && (Math.round(Math.atan2(y, x) * 4) % 2) ? '#a8741f' : '#3e2818'
      if (col) rect(c, cx + x, headY + y, 1, 1, col)
    }
  }
}

/* ── 신당 그림 (움직이지 않는 부분). 기준점 = 계단 아래 가운데, 그림 안에서는 (AX, AY) ── */
const SW = 105
const SH = 99
const AX = 52
const AY = 96
/** 신상 맨 윗줄 dy, 머리 가운데 dy */
const STATUE_TOP = -58
const HEAD_DY = STATUE_TOP + 8

const ROOF = { tile: '#262b3a', line: '#1c2030', ridge: '#323a4e', hip: '#3e4860', under: '#161a26' }
const RED = { base: '#9c2a26', light: '#c0403a', dark: '#6e1c1a' }
const STONE = { top: '#5c5c6c', face: '#4a4a58', hi: '#62627a', grout: '#383844', dark: '#2e2e38' }

/** 뒤 층: 바닥 그림자 · 안쪽 벽 · 광배 (이 위에 광배 불빛을 얹고, 그 위에 신상과 건물을 그립니다) */
function paintBack(c) {
  const P = (dx, dy, w, h, col) => rect(c, AX + dx, AY + dy, w, h, col)

  // 바닥 그림자
  c.fillStyle = 'rgba(0,0,0,.32)'
  c.fillRect(AX - 48, AY - 4, 97, 5)

  // 안쪽 벽과 은은한 불빛
  P(-40, -64, 81, 42, '#140e1a')
  for (let y = -62; y < -22; y++) {
    for (let x = -18; x <= 18; x++) {
      const e = Math.hypot(x / 18, (y + 42) / 22)
      if (e < 1 && ((x + y) & 1 || e < 0.6)) P(x, y, 1, 1, e < 0.6 ? '#2a1a1c' : '#1e141c')
    }
  }
  paintHalo(c, AX, AY + HEAD_DY, AY + HEAD_DY + 12)
}

/** 앞 층: 신상 · 불단 · 문 · 기둥 · 지붕 · 기단 */
function paintTemple(c) {
  const P = (dx, dy, w, h, col) => rect(c, AX + dx, AY + dy, w, h, col)

  // 닫집(신상 위 지붕 장식)
  P(-17, -62, 35, 3, '#3a1a16')
  P(-17, -62, 35, 1, '#c8962e')
  for (let x = -16; x <= 16; x += 4) P(x, -59, 2, 2, '#a8741f')

  // 신상
  paintIdol(c, AX - 12, AY + STATUE_TOP)

  // 불단: 붉은 단에 금 테두리, 앞면 안상(코끼리 눈 모양 구멍)
  P(-16, -28, 33, 6, '#5a2418')
  P(-16, -28, 33, 1, '#c8962e')
  P(-16, -23, 33, 1, '#3a140e')
  for (const x of [-12, -3, 6]) {
    P(x, -26, 6, 2, '#2a0e0a')
    P(x + 1, -27, 4, 1, '#2a0e0a')
  }
  // 촛대 (불꽃은 따로 그립니다)
  for (const x of [-14, 13]) {
    P(x, -33, 2, 5, '#efe6d0')
    P(x + 1, -33, 1, 5, '#cfc4a8')
    P(x - 1, -29, 4, 1, '#a8741f')
  }

  // 양옆 칸: 꽃살문 (안쪽 불빛이 살짝 비칩니다)
  for (const sx of [-38, 21]) {
    P(sx, -60, 18, 38, RED.dark)
    P(sx + 1, -59, 16, 25, '#3a2018')
    for (let y = -58; y < -34; y++) {
      for (let x = 1; x < 17; x++) {
        const lattice = (x + y) % 4 === 0 || (x - y) % 4 === 0
        P(sx + x, y, 1, 1, lattice ? '#8a5a34' : (x * 7 + y * 3) % 11 === 0 ? '#6a3a1a' : '#2a160e')
      }
    }
    P(sx + 1, -33, 16, 1, RED.dark)
    P(sx + 1, -32, 16, 10, '#5a3422')
    P(sx + 3, -30, 12, 6, '#4a2a1a')
    P(sx + 3, -30, 12, 1, '#6a4428')
    P(sx + 8, -47, 2, 3, '#c8962e')
  }

  // 기둥 넷 (가운데 칸은 신상이 보이게 열려 있습니다)
  for (const px of [-42, -20, 17, 39]) {
    P(px, -64, 4, 42, RED.base)
    P(px, -64, 1, 42, RED.light)
    P(px + 3, -64, 1, 42, RED.dark)
    P(px - 1, -24, 6, 2, STONE.face)
    P(px - 1, -24, 6, 1, STONE.hi)
  }

  // 창방(가로 들보) · 단청 띠 · 서까래 끝
  P(-46, -64, 93, 2, RED.base)
  P(-46, -64, 93, 1, RED.light)
  P(-47, -68, 95, 4, '#2a6a5a')
  for (let x = -46; x < 47; x += 5) {
    P(x, -67, 2, 2, '#e8c04a')
    P(x + 3, -66, 1, 1, '#c8282e')
  }
  P(-47, -68, 95, 1, '#3a8a74')
  for (let x = -48; x < 49; x += 3) {
    P(x, -70, 2, 2, '#1c4a40')
    P(x, -70, 1, 1, '#e8c04a')
  }

  // 지붕: 기와 앞면, 위로 휘어 오른 처마, 용마루와 내림마루
  for (let dx = -52; dx <= 52; dx++) {
    const ax = Math.abs(dx)
    const top = Math.round(-92 + Math.max(0, ax - 30) * (17 / 22))
    const bottom = Math.round(-71 - Math.max(0, ax - 40) * 0.45)
    for (let dy = top; dy <= bottom; dy++) {
      // 수키와 줄(밝게) · 골(어둡게) · 기와 단, 달빛을 받는 왼쪽은 조금 밝게
      const lit = dx < -6 ? 3 : 0
      let col = (dx + 52) % 3 === 0 ? ROOF.line : (dx + 52) % 3 === 1 ? (lit ? '#323a4e' : '#2c3244') : (lit ? '#2a3042' : ROOF.tile)
      if ((dy + 92) % 4 === 0 && (dx + 52) % 3 !== 0) col = lit ? '#3a4258' : '#30374a'
      if (dy === bottom) col = ROOF.under
      if (dy === bottom - 1) col = (dx + 52) % 3 === 0 ? '#3a4256' : '#20242f'
      P(dx, dy, 1, 1, col)
    }
    // 내림마루 (용마루 끝에서 처마 끝으로)
    if (ax > 30) P(dx, top, 1, 2, ROOF.hip)
  }
  // 용마루와 끝 장식
  P(-31, -95, 63, 4, ROOF.ridge)
  P(-31, -95, 63, 1, ROOF.hip)
  P(-31, -91, 63, 1, ROOF.line)
  P(-29, -94, 59, 1, '#56627e')
  for (const s of [-1, 1]) {
    const x0 = s < 0 ? -34 : 31
    P(x0, -96, 4, 5, ROOF.ridge)
    P(s < 0 ? -35 : 34, -96, 1, 2, ROOF.hip)
    P(x0 + (s < 0 ? 0 : 3), -96, 1, 1, '#4a5670')
    // 처마 끝이 들려 올라간 곳
    P(s < 0 ? -52 : 50, -78, 3, 2, ROOF.hip)
  }

  // 현판
  P(-11, -72, 23, 9, '#c8962e')
  P(-10, -71, 21, 7, '#24140e')
  for (const x of [-8, -3, 2, 7]) {
    P(x, -69, 2, 1, '#e8c04a')
    P(x, -67, 1, 2, '#e8c04a')
    P(x + 1, -66, 1, 1, '#e8c04a')
  }

  // 기단: 윗면과 돌 쌓은 앞면
  P(-46, -22, 93, 4, STONE.top)
  P(-46, -22, 93, 1, STONE.hi)
  P(-46, -18, 93, 13, STONE.face)
  for (let y = -18; y < -5; y++) {
    const row = Math.floor((y + 18) / 4)
    for (let x = -46; x <= 46; x++) {
      const ox = x + 46 + (row % 2) * 6
      if ((y + 18) % 4 === 3 || ox % 12 === 0) P(x, y, 1, 1, STONE.grout)
      else if ((y + 18) % 4 === 0) P(x, y, 1, 1, '#545462')
    }
  }
  P(-46, -5, 93, 2, STONE.dark)

  // 가운데 계단 셋과 소맷돌
  const steps = [[-20, 13], [-14, 15], [-8, 17]]
  steps.forEach(([dy, half], i) => {
    P(-half, dy, half * 2 + 1, 2, '#6e6e7e')
    P(-half, dy + 2, half * 2 + 1, i === 2 ? 6 : 4, '#50505e')
    P(-half, dy + (i === 2 ? 7 : 5), half * 2 + 1, 1, STONE.dark)
  })
  for (const s of [-1, 1]) {
    for (let i = 0; i < 20; i++) {
      const x = s * (14 + Math.floor(i / 5))
      P(x - (s < 0 ? 1 : 0), -21 + i, 2, 1, i % 5 === 0 ? STONE.hi : STONE.face)
    }
  }
}

/** 처마 끝 초롱 */
function eaveLantern(c, x, top, t, seed, glow) {
  rect(c, x, top, 1, 3, '#2a2030')
  rect(c, x - 2, top + 3, 5, 1, '#2a2030')
  rect(c, x - 2, top + 4, 5, 2, '#3858a8')
  rect(c, x - 2, top + 6, 5, 4, '#c83838')
  rect(c, x - 1, top + 7, 3, 2, Math.floor(t / 240 + seed) % 4 ? '#f08048' : '#ff9a5a')
  rect(c, x - 2, top + 10, 5, 1, '#3858a8')
  rect(c, x, top + 11, 1, 3, '#c83838')
  drawGlow(c, x, top + 8, 9, '#ffb347', 0.8 + Math.sin(t / 310 + seed) * 0.1 + glow * 0.1)
}

/**
 * 신당. (x, y) = 계단 아래 가운데(땅). glow 0~1 = 방금 올린 기도의 세기 (광배가 밝아지고 빛줄기가 퍼집니다).
 */
export function drawTemple(c, x, y, t, glow = 0) {
  x = Math.round(x)
  y = Math.round(y)
  const hy = y + HEAD_DY
  c.drawImage(sprite('templeBack', SW, SH, paintBack), x - AX, y - AY)
  // 광배가 천천히 숨 쉬듯 빛납니다 (신상 뒤에서)
  const breathe = 0.55 + Math.sin(t / 900) * 0.15
  drawGlow(c, x, hy, 12, '#ffd36b', Math.min(1, breathe + glow * 0.5))
  drawGlow(c, x, hy + 12, 18, '#ffb347', Math.min(1, 0.4 + glow * 0.6))
  c.drawImage(sprite('temple', SW, SH, paintTemple), x - AX, y - AY)
  if (glow > 0) {
    // 기도하면 신상이 환해지고 광배에서 빛줄기가 퍼집니다
    const g = Math.min(1, glow)
    drawGlow(c, x, hy + 6, 16, '#fff2b0', g * 0.7)
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + t / 3000
      const len = 16 + (i % 2) * 6 + g * 6
      for (let r = 13; r < len; r++) {
        c.globalAlpha = g * (1 - (r - 13) / (len - 13)) * 0.95
        rect(c, x + Math.cos(a) * r, hy + 4 + Math.sin(a) * r * 0.9, 1, 1, i % 2 ? '#ffe9a0' : '#fff8d8')
      }
    }
    c.globalAlpha = 1
  }
  // 불단 촛불
  for (const [cx, seed] of [[x - 13, 0], [x + 14, 2]]) {
    const f = Math.floor(t / 130 + seed) % 3
    drawGlow(c, cx, y - 35, 5, '#ffb347', 0.7)
    rect(c, cx, y - 36 - (f === 1 ? 1 : 0), 1, 2, '#ff9a3c')
    rect(c, cx, y - 35, 1, 1, '#fff4c4')
  }
  eaveLantern(c, x - 46, y - 72, t, 1, glow)
  eaveLantern(c, x + 46, y - 72, t, 3, glow)
}

/* ── 향로: 세 발 달린 청동 향로에 향 세 개 ── */
const BRONZE = { dark: '#3e2e1a', shade: '#5e4626', base: '#8a6a3a', light: '#b08a4a', hi: '#d8b868', patina: '#4a7a6a' }

function paintCenser(c) {
  // 그림 안 기준점 (8, 15)
  const P = (dx, dy, w, h, col) => rect(c, 8 + dx, 15 + dy, w, h, col)
  // 발
  P(-6, -3, 2, 3, BRONZE.shade)
  P(-6, -3, 1, 3, BRONZE.base)
  P(5, -3, 2, 3, BRONZE.dark)
  P(0, -3, 1, 2, BRONZE.dark)
  // 몸통: 아래로 좁아지는 둥근 솥
  const rows = [[-8, 7], [-7, 7], [-6, 7], [-5, 7], [-4, 6], [-3, 5]]
  for (const [dy, half] of rows) {
    for (let dx = -half; dx <= half; dx++) {
      const n = dx / half
      const col = n < -0.55 ? BRONZE.light : n < 0.1 ? BRONZE.base : n < 0.65 ? BRONZE.shade : BRONZE.dark
      P(dx, dy, 1, 1, col)
    }
  }
  P(-5, -8, 1, 1, BRONZE.hi)
  P(-6, -7, 1, 2, BRONZE.hi)
  // 띠 무늬 (푸른 녹)
  for (let dx = -6; dx <= 6; dx += 2) P(dx, -6, 1, 1, BRONZE.patina)
  // 입구 테두리와 재
  P(-7, -10, 15, 2, BRONZE.light)
  P(-7, -10, 15, 1, BRONZE.hi)
  P(-6, -9, 13, 1, '#2a2420')
  P(-5, -9, 11, 1, '#5a5450')
  P(-8, -9, 1, 1, BRONZE.shade)
  P(8, -9, 1, 1, BRONZE.dark)
  // 손잡이 두 개
  for (const s of [-1, 1]) {
    const hx = s < 0 ? -9 : 8
    P(hx, -12, 2, 1, s < 0 ? BRONZE.light : BRONZE.shade)
    P(hx + (s < 0 ? 0 : 1), -11, 1, 2, s < 0 ? BRONZE.light : BRONZE.shade)
  }
  // 향 세 개
  for (const [dx, h] of [[-2, 6], [0, 8], [2, 5]]) P(dx, -9 - h, 1, h, '#8a5a3a')
}

/**
 * 향로. (x, y) = 향로 아래 가운데(땅). glow 0~1 = 방금 올린 기도의 세기 (연기가 짙어지고 불씨가 밝아집니다).
 */
export function drawCenser(c, x, y, t, glow = 0) {
  x = Math.round(x)
  y = Math.round(y)
  shadow(c, x, y + 1, 16, 2)
  c.drawImage(sprite('censer', 17, 16, paintCenser), x - 8, y - 15)
  // 향 끝 불씨
  const tips = [[-2, -16], [0, -18], [2, -15]]
  tips.forEach(([dx, dy], i) => {
    const on = Math.floor(t / 300 + i) % 3 !== 0
    rect(c, x + dx, y + dy, 1, 1, on || glow > 0.2 ? '#ff7a2a' : '#c84a1a')
  })
  drawGlow(c, x, y - 16, 4, '#ff9a3c', 0.6 + glow * 0.4)
  // 연기: 향 끝에서 피어올라 좌우로 흔들리며 옅어집니다
  const n = 10 + Math.round(glow * 10)
  for (let i = 0; i < n; i++) {
    const [dx, dy] = tips[i % 3]
    const p = (t / (2600 - glow * 900) + i / n) % 1
    const sx = x + dx + Math.sin(p * 6 + i * 1.7) * (0.5 + p * 3.5)
    const sy = y + dy - 1 - p * (24 + glow * 6)
    c.globalAlpha = (1 - p) * (0.7 + glow * 0.3)
    rect(c, sx, sy, p > 0.4 ? 2 : 1, p > 0.7 ? 2 : 1, p > 0.6 ? '#a8aec2' : '#d8dce6')
  }
  c.globalAlpha = 1
}
