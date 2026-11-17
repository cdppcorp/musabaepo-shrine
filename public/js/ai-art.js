// AI 신당과 AI 트렌드 게시판 그림. 좌표는 맵 픽셀(도트 1칸 = 1px).
// AI 신당: 돌 받침 위 작은 사당. 감실 안 금빛 받침에 AI 색 구슬이 떠 있고, 기도가 쌓일수록 부적 · 초가 늘어납니다.
//   각 회사 로고는 쓰지 않고 색과 구슬 모양(고리 · 보석 · 구슬 · 물방울 · 큐브)으로만 구분합니다.
// AI 트렌드 게시판: 지붕 달린 넓은 축제 게시판. 최근 글마다 그 AI 색 핀이 꽂힌 쪽지가 붙습니다.
import { drawGlow, rect, shadow } from './pixels.js'

/** 화면 밖 건너뛰기용: [반폭, 기준점 위 높이] */
export const AI_BOX = [18, 48]
export const TREND_BOX = [44, 56]

/* ── 색 ── */

function hex2rgb(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
}
function mix(a, b, t) {
  const A = hex2rgb(a)
  const B = hex2rgb(b)
  const c = A.map((v, i) => Math.round(v + (B[i] - v) * t))
  return `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

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

/** 늘 같은 값이 나오는 작은 난수 */
function hash(n) {
  let x = Math.imul(n | 0, 2654435761) ^ 0x5bd1e995
  x = Math.imul(x ^ (x >>> 15), 2246822507)
  return ((x ^ (x >>> 13)) >>> 0) / 4294967296
}

/* ── 구슬 모양 (10×10): o 테두리 · d 어두운 면 · m 바탕색 · l 밝은 면 · w 반짝임 ── */

const ORBS = {
  // 둥근 구슬
  orb: [
    '...oooo...',
    '.oommmmoo.',
    '.olwlmmmo.',
    'olllmmmmdo',
    'olllmmmmdo',
    'ommmmmmddo',
    'ommmmmmddo',
    '.ommmmddo.',
    '.oodddddo.',
    '...oooo...',
  ],
  // 가운데가 빈 고리
  ring: [
    '...oooo...',
    '.oolllmoo.',
    'olwllmmmdo',
    'ollo..omdo',
    'olo....odo',
    'omo....odo',
    'omdo..oddo',
    'ommdoodddo',
    '.ooddddoo.',
    '...oooo...',
  ],
  // 마름모 보석
  gem: [
    '....oo....',
    '...olwo...',
    '..ollwmo..',
    '.olllmmmo.',
    'olllmmmmdo',
    'ommmmmmddo',
    '.ommmmddo.',
    '..ommddo..',
    '...oddo...',
    '....oo....',
  ],
  // 물방울
  drop: [
    '....oo....',
    '...oolo...',
    '...olmo...',
    '..olwmmo..',
    '.olllmmmo.',
    'olllmmmmdo',
    'ommmmmmddo',
    'ommmmmmddo',
    '.ommmmddo.',
    '..oooooo..',
  ],
  // 큐브 (윗면 밝게, 왼쪽 면 바탕, 오른쪽 면 어둡게)
  cube: [
    '....oo....',
    '..oolloo..',
    'oollwllloo',
    'ommllllddo',
    'ommmlldddo',
    'ommmmddddo',
    'ommmmddddo',
    'ommmmddddo',
    '.oommddoo.',
    '...oooo...',
  ],
}
/** AI마다 구슬 모양 하나 (로고 대신) */
const ORB_OF = { gpt: 'ring', gemini: 'gem', claude: 'orb', deepseek: 'drop', grok: 'cube' }

function orbSprite(ai, level) {
  const shape = ORB_OF[ai.key] ?? 'orb'
  return sprite(`orb|${ai.key}|${ai.color}|${level}`, 10, 10, c => {
    const lift = level * 0.12
    const pal = {
      o: mix(ai.color, '#0b0a14', 0.62 - lift),
      d: mix(mix(ai.color, '#14102a', 0.35), '#ffffff', lift),
      m: mix(ai.color, '#ffffff', lift),
      l: mix(ai.color, '#ffffff', 0.38 + lift),
      w: '#ffffff',
    }
    ORBS[shape].forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const ch = row[x]
        if (ch !== '.') rect(c, x, y, 1, 1, pal[ch])
      }
    })
  })
}

/* ── AI 신당 ── */

/** 바뀌지 않는 부분 (받침 · 기둥 · 감실 · 지붕). 36×48, 기준점은 (18, 46) */
function shrineBody(ai) {
  return sprite(`aishrine|${ai.key}|${ai.color}`, 36, 48, c => {
    const x = 18
    const y = 46
    const cloth = ai.color
    const clothD = mix(ai.color, '#14102a', 0.4)
    const clothL = mix(ai.color, '#ffffff', 0.3)
    // 돌 받침 두 단
    rect(c, x - 16, y - 5, 32, 5, '#4a4a58')
    rect(c, x - 16, y - 5, 32, 1, '#62627a')
    rect(c, x - 16, y - 1, 32, 1, '#383844')
    rect(c, x - 7, y - 4, 1, 3, '#3a3a46')
    rect(c, x + 6, y - 4, 1, 3, '#3a3a46')
    rect(c, x - 13, y - 9, 26, 4, '#525264')
    rect(c, x - 13, y - 9, 26, 1, '#6c6c84')
    rect(c, x + 11, y - 8, 2, 3, '#42424f')
    // 감실 (어두운 안쪽과 뒷판 무늬)
    const back = mix(ai.color, '#1b1726', 0.84)
    rect(c, x - 11, y - 34, 22, 25, back)
    rect(c, x - 9, y - 30, 18, 1, mix(back, '#ffffff', 0.05))
    for (let i = -8; i <= 8; i += 4) rect(c, x + i, y - 29, 1, 17, mix(back, '#000000', 0.18))
    // 문틀 기둥 (붉은 칠)
    for (const px of [x - 12, x + 9]) {
      rect(c, px, y - 35, 3, 26, '#9c2a26')
      rect(c, px, y - 35, 1, 26, '#c0403a')
      rect(c, px + 2, y - 35, 1, 26, '#6e1c1a')
    }
    // 문지방
    rect(c, x - 12, y - 10, 24, 2, '#6b4022')
    rect(c, x - 12, y - 10, 24, 1, '#8a5a34')
    // 구슬 받침: 나무 대 위 금 잔
    rect(c, x - 5, y - 12, 10, 2, '#6b4022')
    rect(c, x - 5, y - 12, 10, 1, '#8a5a34')
    rect(c, x - 4, y - 15, 8, 1, '#ffe08a')
    rect(c, x - 4, y - 14, 8, 1, '#e8c04a')
    rect(c, x - 3, y - 13, 6, 1, '#a07a28')
    // AI 색 휘장 (금 막대에 걸린 물결 천)
    rect(c, x - 12, y - 35, 24, 1, '#e8c04a')
    rect(c, x - 11, y - 34, 22, 3, cloth)
    rect(c, x - 11, y - 34, 22, 1, clothL)
    for (let i = -11; i < 11; i += 4) {
      rect(c, x + i, y - 31, 3, 1, cloth)
      rect(c, x + i + 1, y - 30, 1, 1, clothD)
    }
    // 단청 띠
    for (let i = -12; i < 12; i++) rect(c, x + i, y - 36, 1, 1, (i & 1) ? '#2a6a5a' : '#e8c04a')
    // 지붕: 처마(아래) · 위 지붕 · 용마루, 들린 처마 끝, 금 꼭지
    rect(c, x - 14, y - 40, 28, 1, '#2e3446')
    rect(c, x - 16, y - 39, 32, 2, '#262b3a')
    rect(c, x - 15, y - 37, 30, 1, '#161a26')
    for (let i = x - 15; i <= x + 14; i += 2) rect(c, i, y - 39, 1, 2, '#1c2030')
    rect(c, x - 18, y - 41, 2, 1, '#3a4256')
    rect(c, x - 17, y - 40, 2, 2, '#262b3a')
    rect(c, x + 16, y - 41, 2, 1, '#3a4256')
    rect(c, x + 15, y - 40, 2, 2, '#262b3a')
    rect(c, x - 12, y - 43, 24, 3, '#262b3a')
    for (let i = x - 11; i <= x + 11; i += 2) rect(c, i, y - 43, 1, 2, '#1c2030')
    rect(c, x - 12, y - 41, 24, 1, '#1a1e2a')
    rect(c, x - 13, y - 44, 26, 1, '#3a4256')
    rect(c, x - 14, y - 45, 2, 1, '#3a4256')
    rect(c, x + 12, y - 45, 2, 1, '#3a4256')
    rect(c, x - 1, y - 46, 2, 2, '#e8c04a')
    rect(c, x - 1, y - 46, 1, 1, '#fff1a0')
    // 처마 끝 AI 색 술
    for (const px of [x - 16, x + 15]) {
      rect(c, px, y - 37, 1, 3, '#e8c04a')
      rect(c, px, y - 34, 1, 1, clothL)
      rect(c, px, y - 33, 1, 3, cloth)
      rect(c, px, y - 30, 1, 1, clothD)
    }
  })
}

/** 금줄에 매다는 노란 부적 자리 (바깥쪽부터 채움, 구슬은 가리지 않음) */
const SLIPS = [-10, 8, -8, 6, -6, 4]

/**
 * AI 신당.
 * @param ai { key, name, color }
 * @param glow 0~1 방금 기도함 (구슬이 밝아지고 빛살 · 반짝임)
 * @param count 오늘 이 AI에 올린 기도 수 (부적 · 초 · 구슬 빛이 늘어남)
 */
export function drawAiShrine(c, x, y, t, ai, glow = 0, count = 0) {
  x = Math.round(x)
  y = Math.round(y)
  const n = Math.min(8, Math.max(0, count | 0))
  const seed = (ai.key.charCodeAt(0) * 13 + ai.key.length * 7) % 100
  shadow(c, x, y + 1, 34, 3)
  c.drawImage(shrineBody(ai), x - 18, y - 46)

  // 구슬 빛: 기도가 많을수록 넓고 진하게
  const bob = Math.round(Math.sin(t / 650 + seed) * 1)
  const ox = x - 5
  const oy = y - 26 + bob
  const pulse = glow > 0 ? 0.5 + 0.5 * Math.sin(t / 90) : 0
  drawGlow(c, x, oy + 5, 9 + Math.min(6, n), ai.color, Math.min(1, 0.6 + n * 0.05 + glow * (0.4 + pulse * 0.2)))
  drawGlow(c, x, oy + 5, 6, mix(ai.color, '#ffffff', 0.4), 0.7)
  if (glow > 0.05) drawGlow(c, x, oy + 5, 14, '#ffffff', glow * 0.35)
  c.drawImage(orbSprite(ai, glow > 0.6 ? 2 : glow > 0.2 ? 1 : 0), ox, oy)
  // 반짝임: 가끔 구슬 오른쪽 위에 별빛
  if (Math.floor(t / 420 + seed) % 5 === 0) rect(c, ox + 7, oy + 1, 1, 1, '#ffffff')

  // 금줄과 부적 (기도 1~6)
  if (n > 0) {
    for (let i = -10; i <= 9; i++) rect(c, x + i, y - 30 + ((i + 10) % 4 === 0 ? 1 : 0), 1, 1, '#b6a476')
    for (let i = 0; i < Math.min(n, SLIPS.length); i++) {
      const sx = x + SLIPS[i]
      const sway = Math.sin(t / 800 + i * 1.7 + seed) > 0.6 ? 1 : 0
      rect(c, sx, y - 29, 2, 3, '#f2d24b')
      rect(c, sx + sway, y - 26, 2, 1, '#d8b43a')
      rect(c, sx, y - 28, 1, 1, '#c8282e')
      rect(c, sx + 1, y - 27, 1, 1, '#c8282e')
    }
  }
  // 받침 위 초 (기도 3 이상 둘, 6 이상 넷)
  const candles = n >= 6 ? [-15, 14, -12, 11] : n >= 3 ? [-15, 14] : []
  candles.forEach((cx2, i) => {
    const top = i < 2 ? y - 9 : y - 12
    const h = i < 2 ? 4 : 3
    rect(c, x + cx2, top, 1, h, '#f3ead6')
    const f = Math.floor(t / 150 + i * 3 + seed) % 2
    rect(c, x + cx2, top - 2 + f, 1, 2 - f, '#f39a2b')
    rect(c, x + cx2, top - 1, 1, 1, '#ffe08a')
    drawGlow(c, x + cx2, top - 1, 4, '#ffb347', 0.8)
  })
  // 기도가 아주 많으면 (8 이상) 받침 앞 꽃 공양
  if (n >= 8) {
    rect(c, x - 3, y - 6, 2, 1, '#e86a8a')
    rect(c, x + 1, y - 6, 2, 1, '#f3c84a')
    rect(c, x - 1, y - 7, 2, 1, '#ff9ab0')
    rect(c, x - 2, y - 5, 4, 1, '#3f7a4a')
  }

  // 방금 기도: 빛살과 도는 반짝임
  if (glow > 0.05) {
    const cx = x
    const cy = oy + 5
    const len = Math.round(2 + glow * 5)
    const col = mix(ai.color, '#ffffff', 0.55)
    c.globalAlpha = Math.min(1, glow * 1.2)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, -1], [0, 1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const start = dx && dy ? 6 : 7
      for (let i = 0; i < len; i++) {
        if ((i + Math.floor(t / 80)) % 3 === 2) continue
        rect(c, cx + dx * (start + i) - (dx < 0 ? 1 : 0), cy + dy * (start + i) - (dy < 0 ? 1 : 0), 1, 1, col)
      }
    }
    for (let i = 0; i < 3; i++) {
      const a = t / 260 + i * 2.09
      rect(c, cx + Math.cos(a) * 10, cy + Math.sin(a) * 7, 1, 1, '#ffffff')
    }
    c.globalAlpha = 1
  }
}

/* ── AI 트렌드 게시판 ── */

const PAPERS = ['#f3ead6', '#efe4c4', '#e6edf4', '#f4e2e2', '#e8f0e0']
/** 쪽지 자리 16칸 (8열 × 2줄). 몇 장 없어도 고루 퍼져 보이게 섞은 순서 */
const NOTE_ORDER = [9, 2, 14, 5, 11, 0, 7, 12, 3, 15, 1, 10, 6, 13, 4, 8]

function boardBody() {
  return sprite('trendboard', 86, 56, c => {
    const x = 43
    const y = 54
    // 돌 주춧돌과 기둥
    for (const px of [x - 36, x + 33]) {
      rect(c, px - 2, y - 3, 7, 3, '#4a4a58')
      rect(c, px - 2, y - 3, 7, 1, '#62627a')
      rect(c, px, y - 46, 3, 43, '#5a3a24')
      rect(c, px, y - 46, 1, 43, '#7a5434')
      rect(c, px + 2, y - 46, 1, 43, '#3e2a1c')
    }
    // 판: 테두리 나무와 코르크 (점 무늬)
    rect(c, x - 33, y - 38, 66, 29, '#6b4022')
    rect(c, x - 33, y - 38, 66, 1, '#8a5a34')
    rect(c, x - 31, y - 36, 62, 25, '#9a7048')
    for (let i = 0; i < 140; i++) {
      const px = x - 31 + Math.floor(hash(i * 3 + 1) * 62)
      const py = y - 36 + Math.floor(hash(i * 3 + 2) * 25)
      rect(c, px, py, 1, 1, hash(i * 3 + 3) < 0.5 ? '#8a6038' : '#a8805a')
    }
    rect(c, x - 31, y - 36, 62, 1, '#7e5a38')
    // 아래 선반 (빈 쪽지 묶음 · 연필: 누구나 쓸 수 있다는 표시)
    rect(c, x - 34, y - 10, 68, 2, '#5a3a24')
    rect(c, x - 34, y - 10, 68, 1, '#7a5434')
    rect(c, x + 18, y - 13, 6, 3, '#efe6cf')
    rect(c, x + 19, y - 14, 6, 1, '#f6efdc')
    rect(c, x + 18, y - 11, 6, 1, '#d6cab0')
    for (let i = 0; i < 7; i++) rect(c, x + 10 + i, y - 11 - (i >> 1), 1, 1, i < 1 ? '#3a2a1a' : i < 2 ? '#d8b88a' : i > 5 ? '#e88a9a' : '#e8c04a')
    // 머리판 (이름은 화면이 글자로 씁니다) + AI 색 점 다섯
    rect(c, x - 26, y - 45, 52, 7, '#6b4022')
    rect(c, x - 25, y - 44, 50, 5, '#8a5a34')
    rect(c, x - 25, y - 44, 50, 1, '#a8703f')
    rect(c, x - 26, y - 45, 52, 1, '#e8c04a')
    rect(c, x - 26, y - 39, 52, 1, '#4e301b')
    for (let i = 0; i < 10; i++) rect(c, x - 18 + i * 2 + (i > 4 ? 18 : 0), y - 42, 1, 1, '#efe6cf')
    ;['#19c37d', '#a07cf2', '#d97757', '#3d7bff', '#c8ccd6'].forEach((col, i) => rect(c, x - 5 + i * 2, y - 42, 1, 1, col))
    // 지붕: 기와 두 단, 들린 처마
    rect(c, x - 40, y - 50, 80, 4, '#262b3a')
    rect(c, x - 36, y - 53, 72, 3, '#262b3a')
    rect(c, x - 34, y - 54, 68, 1, '#323a4e')
    for (let i = x - 38; i <= x + 38; i += 4) rect(c, i, y - 52, 1, 5, '#1c2030')
    rect(c, x - 40, y - 50, 80, 1, '#323a4e')
    rect(c, x - 38, y - 46, 76, 1, '#161a26')
    rect(c, x - 42, y - 51, 2, 2, '#262b3a')
    rect(c, x + 40, y - 51, 2, 2, '#262b3a')
    rect(c, x - 43, y - 52, 1, 1, '#3a4256')
    rect(c, x + 42, y - 52, 1, 1, '#3a4256')
  })
}

function drawNote(c, nx, ny, color, i, t, newest) {
  const paper = PAPERS[i % PAPERS.length]
  const shade = mix(paper, '#6a5a44', 0.25)
  const tilt = (i * 7) % 3 - 1 // -1 · 0 · 1: 윗줄을 한 칸 밀어 기울어 보이게
  // 쪽지 6×8 (한쪽 모서리가 살짝 말림)
  rect(c, nx, ny + 1, 6, 7, paper)
  rect(c, nx + (tilt > 0 ? 1 : 0), ny, 5, 1, paper)
  rect(c, nx + 5, ny + 7, 1, 1, shade)
  if (tilt < 0) rect(c, nx + 5, ny + 1, 1, 1, shade)
  // 글 줄
  rect(c, nx + 1, ny + 3, 4, 1, '#9a9286')
  rect(c, nx + 1, ny + 5, 3 + (i % 2), 1, '#aaa296')
  // AI 색 핀
  rect(c, nx + 2, ny, 2, 2, color)
  rect(c, nx + 2, ny, 1, 1, mix(color, '#ffffff', 0.5))
  if (newest && Math.floor(t / 350) % 3 !== 0) rect(c, nx + 5, ny - 1, 1, 1, '#fff6c8')
}

/**
 * AI 트렌드 게시판.
 * @param notes 최근 글의 AI 색 (최신순, 최대 16)
 */
export function drawTrendBoard(c, x, y, t, notes = []) {
  x = Math.round(x)
  y = Math.round(y)
  shadow(c, x, y + 1, 80, 3)
  c.drawImage(boardBody(), x - 43, y - 54)
  // 처마 아래 작은 초롱 둘
  for (const [lx, s] of [[x - 30, 1], [x + 29, 2]]) {
    rect(c, lx, y - 46, 1, 2, '#2a2030')
    rect(c, lx - 1, y - 44, 3, 1, '#3858a8')
    rect(c, lx - 1, y - 43, 3, 3, '#c83838')
    rect(c, lx, y - 42, 1, 1, Math.floor(t / 240 + s) % 4 ? '#f08048' : '#ff9a5a')
    rect(c, lx - 1, y - 40, 3, 1, '#3858a8')
    rect(c, lx, y - 39, 1, 2, '#c83838')
    drawGlow(c, lx, y - 42, 6, '#ffb347', 0.8)
  }
  const list = notes.slice(0, 16)
  if (!list.length) {
    // 빈 게시판: 가운데 빈 카드와 '여기에 쓰세요' 느낌의 점선 · 연필
    const bx = x - 5
    const by = y - 31
    rect(c, bx, by, 11, 13, '#f3ead6')
    rect(c, bx, by + 12, 11, 1, '#d6cab0')
    for (let i = 1; i < 10; i += 2) rect(c, bx + i, by + 4, 1, 1, '#b8ae98')
    for (let i = 1; i < 10; i += 2) rect(c, bx + i, by + 7, 1, 1, '#b8ae98')
    rect(c, bx + 5, by - 1, 2, 2, '#e8c04a')
    rect(c, bx + 5, by - 1, 1, 1, '#fff1a0')
    // 카드에 기댄 연필
    for (let i = 0; i < 6; i++) rect(c, bx + 9 + i, by + 9 - i, 1, 1, i < 1 ? '#3a2a1a' : i < 2 ? '#d8b88a' : i > 4 ? '#e88a9a' : '#e8c04a')
    return
  }
  list.forEach((color, i) => {
    const slot = NOTE_ORDER[i]
    const col = slot % 8
    const row = slot >> 3
    const jx = Math.round(hash(slot * 5 + 1) * 2) - 1
    const jy = Math.round(hash(slot * 5 + 2) * 2)
    const nx = x - 30 + col * 7.5 + jx
    const ny = y - 35 + row * 11 + jy
    drawNote(c, Math.round(nx), ny, color, slot, t, i === 0)
  })
}

/* ── 내 프로젝트 등록소 · 흡연구역 ── */

export const REGISTRY_BOX = [28, 52]
export const ASHTRAY_BOX = [6, 18]
export const SMOKESIGN_BOX = [13, 32]

/** 잔디 심기 표 느낌의 초록 칸 색 (진하기 5단계) */
const GRASS_CELLS = ['#1b3a26', '#216e39', '#2da44e', '#40c463', '#9be9a8']

function registryBody() {
  return sprite('registry', 54, 52, c => {
    const x = 27
    const y = 50
    // 뒤 기둥과 뒷벽 (선반 · 바인더 · 작은 모니터)
    for (const px of [x - 23, x + 21]) {
      rect(c, px, y - 40, 2, 26, '#5a3a24')
      rect(c, px, y - 40, 1, 26, '#7a5434')
    }
    rect(c, x - 21, y - 36, 42, 20, '#2a2230')
    rect(c, x - 21, y - 27, 42, 1, '#5a3a24')
    rect(c, x - 21, y - 26, 42, 1, '#3e2a1c')
    ;['#2da44e', '#3858a8', '#c8a040', '#9c2a26', '#2da44e', '#6a7080'].forEach((col, i) => {
      const bx = x - 19 + i * 3
      rect(c, bx, y - 34, 2, 7, col)
      rect(c, bx, y - 34, 1, 7, mix(col, '#ffffff', 0.25))
      rect(c, bx, y - 32, 2, 1, mix(col, '#ffffff', 0.5))
    })
    // 모니터: 초록 글자 줄
    rect(c, x + 4, y - 35, 13, 8, '#14161c')
    rect(c, x + 5, y - 34, 11, 6, '#0b1a12')
    rect(c, x + 6, y - 33, 6, 1, '#40c463')
    rect(c, x + 6, y - 31, 8, 1, '#2da44e')
    rect(c, x + 9, y - 27, 3, 1, '#14161c')
    // 차양: 짙은 회색 · 흰 줄무늬 천 + 초록 단
    for (let i = 0; i < 50; i++) {
      const stripe = Math.floor(i / 5) % 2
      rect(c, x - 25 + i, y - 43, 1, 6, stripe ? '#aab0bc' : '#2b3038')
      rect(c, x - 25 + i, y - 43, 1, 1, stripe ? '#c8ccd6' : '#3a404a')
    }
    rect(c, x - 25, y - 37, 50, 1, '#2da44e')
    for (let i = 0; i < 10; i++) {
      const sx = x - 25 + i * 5
      rect(c, sx, y - 36, 5, 1, i % 2 ? '#aab0bc' : '#2b3038')
      rect(c, sx + 1, y - 35, 3, 1, i % 2 ? '#8a909c' : '#21252c')
    }
    // 간판: 짙은 판에 초록 칸 (등록 = 잔디 심기)
    rect(c, x - 15, y - 48, 30, 6, '#1c2026')
    rect(c, x - 15, y - 48, 30, 1, '#3a404a')
    rect(c, x - 15, y - 43, 30, 1, '#121418')
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j < 2; j++) {
        const v = Math.floor(hash(i * 3 + j * 11 + 4) * 5)
        rect(c, x - 13 + i * 2, y - 46 + j * 2, 1, 1, GRASS_CELLS[v])
      }
    }
    rect(c, x + 2, y - 46, 10, 1, '#e6e9f0')
    rect(c, x + 2, y - 44, 7, 1, '#8a909c')
    // 접수대: 윗판 (위에서 본 면) · 앞판 널 · 초록 칸 천
    rect(c, x - 23, y - 18, 46, 4, '#a07450')
    rect(c, x - 23, y - 18, 46, 1, '#b8885e')
    rect(c, x - 23, y - 15, 46, 1, '#7a5434')
    rect(c, x - 22, y - 14, 44, 13, '#6b4022')
    for (let i = -18; i <= 18; i += 6) rect(c, x + i, y - 14, 1, 13, '#5a3a24')
    rect(c, x - 22, y - 2, 44, 1, '#4e301b')
    rect(c, x - 10, y - 13, 20, 7, '#24292f')
    rect(c, x - 10, y - 13, 20, 1, '#3a404a')
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 2; j++) rect(c, x - 8 + i * 3, y - 11 + j * 2, 2, 1, GRASS_CELLS[1 + Math.floor(hash(i * 7 + j * 5 + 9) * 4)])
    }
    for (let i = -10; i < 10; i += 2) rect(c, x + i, y - 6, 1, 1, '#2da44e')
    // 서류 더미 · 도장과 인주 · 펜꽂이
    rect(c, x - 19, y - 21, 8, 4, '#efe6cf')
    rect(c, x - 18, y - 22, 8, 1, '#f6efdc')
    rect(c, x - 19, y - 19, 8, 1, '#d6cab0')
    rect(c, x - 17, y - 21, 4, 1, '#9a9286')
    rect(c, x - 7, y - 19, 4, 2, '#7a2222')
    rect(c, x - 6, y - 19, 2, 1, '#c8282e')
    rect(c, x - 2, y - 21, 2, 3, '#9c2a26')
    rect(c, x - 2, y - 22, 2, 1, '#c0403a')
    rect(c, x - 3, y - 18, 4, 1, '#3a2a1a')
    rect(c, x + 3, y - 20, 4, 3, '#3a404a')
    rect(c, x + 4, y - 23, 1, 3, '#e8c04a')
    rect(c, x + 5, y - 24, 1, 4, '#c8ccd6')
    rect(c, x + 4, y - 23, 1, 1, '#2a2030')
    rect(c, x + 9, y - 19, 7, 1, '#e6e9f0')
    rect(c, x + 9, y - 20, 6, 1, '#f6efdc')
  })
}

/**
 * 내 프로젝트 등록소: 차양 친 접수대, 잔디 칸 간판 · 깃발, 서류 · 도장 · 펜, 작은 등.
 * 사람은 (x, y+14)에 서서 위(접수대)를 봅니다.
 */
export function drawRegistry(c, x, y, t) {
  x = Math.round(x)
  y = Math.round(y)
  shadow(c, x, y + 1, 48, 3)
  c.drawImage(registryBody(), x - 27, y - 50)
  // 모니터 커서 깜빡임
  if (Math.floor(t / 500) % 2) rect(c, x + 13, y - 31, 1, 1, '#9be9a8')
  // 깃발: 짙은 천에 초록 칸, 바람에 살짝 펄럭
  rect(c, x + 23, y - 48, 1, 13, '#8a909c')
  rect(c, x + 23, y - 48, 1, 1, '#e8c04a')
  const wave = Math.floor(t / 300) % 2
  for (let i = 0; i < 3; i++) {
    const dy = i === 2 ? wave : 0
    rect(c, x + 24 + i, y - 47 + dy, 1, 4, '#24292f')
    rect(c, x + 24 + i, y - 46 + dy, 1, 1, GRASS_CELLS[2 + (i % 2)])
  }
  // 작은 등: 차양 왼쪽 끝에 매단 초롱
  const lx = x - 20
  rect(c, lx, y - 35, 1, 2, '#2a2030')
  rect(c, lx - 1, y - 33, 3, 1, '#3858a8')
  rect(c, lx - 1, y - 32, 3, 3, '#c83838')
  rect(c, lx, y - 31, 1, 1, Math.floor(t / 230) % 4 ? '#f08048' : '#ff9a5a')
  rect(c, lx - 1, y - 29, 3, 1, '#3858a8')
  rect(c, lx, y - 28, 1, 2, '#c83838')
  drawGlow(c, lx, y - 31, 7, '#ffb347', 0.85)
  // 모니터 불빛
  drawGlow(c, x + 10, y - 31, 6, '#40c463', 0.35)
}

/** 흡연구역 스탠드 재떨이: 원통 기둥 위 모래 접시, 꽂힌 꽁초 셋, 아주 옅은 연기 한 가닥 */
export function drawAshtray(c, x, y, t) {
  x = Math.round(x)
  y = Math.round(y)
  shadow(c, x, y + 1, 9)
  // 받침
  rect(c, x - 4, y - 2, 8, 2, '#4a4f5a')
  rect(c, x - 4, y - 2, 8, 1, '#6a707c')
  // 원통 기둥
  rect(c, x - 2, y - 11, 4, 9, '#6a707c')
  rect(c, x - 2, y - 11, 1, 9, '#8e94a0')
  rect(c, x + 1, y - 11, 1, 9, '#4a4f5a')
  // 접시: 테 · 모래 · 옆면
  rect(c, x - 5, y - 14, 10, 1, '#9aa0ac')
  rect(c, x - 4, y - 13, 8, 1, '#c8b890')
  rect(c, x - 5, y - 13, 1, 1, '#9aa0ac')
  rect(c, x + 4, y - 13, 1, 1, '#7a808c')
  rect(c, x - 5, y - 12, 10, 1, '#5a606c')
  // 꽁초 셋 (필터가 위)
  rect(c, x - 3, y - 15, 1, 2, '#e8e4d8')
  rect(c, x - 3, y - 16, 1, 1, '#d89a5a')
  rect(c, x, y - 15, 1, 2, '#e8e4d8')
  rect(c, x, y - 15, 1, 1, '#d89a5a')
  rect(c, x + 2, y - 14, 2, 1, '#e8e4d8')
  rect(c, x + 3, y - 14, 1, 1, '#9a9a9a')
  // 연기 한 가닥 (아주 옅게, 꽁초 위로 흔들리며 사라짐)
  for (let i = 0; i < 6; i++) {
    const p = (t / 1400 + i / 6) % 1
    c.globalAlpha = 0.22 * (1 - p)
    rect(c, x + 3 + Math.round(Math.sin(p * 6 + t / 900) * 1.2), y - 15 - Math.round(p * 7), 1, 1, '#c8ccd6')
  }
  c.globalAlpha = 1
}

/** '고뇌와 번뇌의 공간' 팻말: 나무 기둥에 살짝 기울어 매달린 낡은 판, 담배와 구름 그림 */
export function drawSmokeSign(c, x, y, t) {
  x = Math.round(x)
  y = Math.round(y)
  shadow(c, x, y + 1, 6)
  // 기둥
  rect(c, x - 1, y - 30, 2, 30, '#5a3a24')
  rect(c, x - 1, y - 30, 1, 30, '#7a5434')
  rect(c, x - 1, y - 30, 2, 1, '#8a6a44')
  // 기울어진 판: 오른쪽이 2칸 높습니다 (열마다 윗변을 계단처럼)
  const sway = Math.sin(t / 1600) > 0.85 ? 1 : 0
  const left = x - 11
  for (let i = 0; i < 23; i++) {
    const top = y - 26 - Math.floor(i / 8) + (i < 4 ? sway : 0)
    rect(c, left + i, top, 1, 12, '#7a5a3a')
    rect(c, left + i, top, 1, 1, '#9a7650')
    rect(c, left + i, top + 11, 1, 1, '#4a3220')
    if (i === 0 || i === 22) rect(c, left + i, top, 1, 12, '#4a3220')
    if ((i * 7) % 5 === 1) rect(c, left + i, top + 4, 1, 1, '#6a4a2e')
    if ((i * 3) % 7 === 2) rect(c, left + i, top + 8, 1, 1, '#6a4a2e')
  }
  // 못 · 금 · 이끼 얼룩 (낡은 느낌)
  rect(c, x, y - 25, 1, 1, '#b8bcc6')
  rect(c, x + 6, y - 21, 1, 3, '#4a3220')
  rect(c, x - 9, y - 16, 2, 1, '#4a6a3a')
  // 그림: 담배 한 개비 (불씨 · 재 · 흰 몸통 · 필터) + 위로 피어오르는 구름
  rect(c, x - 8, y - 18, 1, 1, '#ff8a3c')
  rect(c, x - 7, y - 18, 1, 1, '#9a9a9a')
  rect(c, x - 6, y - 18, 6, 1, '#e8e4d8')
  rect(c, x, y - 18, 2, 1, '#d89a5a')
  rect(c, x - 6, y - 17, 8, 1, '#5a4028')
  const puff = Math.floor(t / 900) % 2
  rect(c, x - 7, y - 21 - puff, 2, 1, '#c8ccd6')
  rect(c, x - 5, y - 23 - puff, 4, 2, '#c8ccd6')
  rect(c, x - 4, y - 24 - puff, 2, 1, '#dde0e6')
  rect(c, x - 1, y - 23 - puff, 3, 2, '#b8bcc6')
  rect(c, x + 3, y - 24, 4, 3, '#aeb2bc')
  rect(c, x + 4, y - 25, 2, 1, '#c8ccd6')
  rect(c, x + 7, y - 23, 2, 2, '#9a9ea8')
}
