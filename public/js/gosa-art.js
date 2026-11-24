// 입점 첫 주 고사 상 (예전 돼지머리 자리). 사당 주인이 등록소에서 고르고, 운영자도 운영 화면에서 바꿀 수 있습니다.
// 키는 서버 gosa 값과 같습니다: cake(축하 케이크, 기본) · wreath(개업 화환) · siru(시루떡) · bugeo(북어 · 실타래).
// 모르는 값 · 빈 값은 cake로 그립니다 (data.js gosaKey).
//
// 좌표계 (세 곳 모두 같은 그림을 씁니다)
//   hd     shrine-art.js 부스 그림 px (캔버스 104×116). 계산대 앞면 y87–97 · 마루 y98–107 · 화면 아랫줄 y81.
//          다른 장식(오리 · 커피 …)처럼 부스에 바로 그리고 따로 외곽선을 두르지 않습니다 (부스 전체 외곽선만).
//          케이크 촛불 불꽃만 매 프레임 따로 그려 계산대 초처럼 흔들립니다 (gosaFlameHD).
//   front  pixels.js frontShapes(80×60 SVG). hd 그림을 1:1로 옮겨(x -12, y frontDy) 쓰고, 정면 고사상 r(22,54,36,2)에 올립니다.
//   map    pixels.js drawShrine(작은 맵 사당, 지금은 쓰지 않는 길)의 R (가운데 cx · 위 top 기준).
import { gosaKey } from './data.js'

const WOOD = '#8a5a34'
const WOOD_D = '#5e3a20'
const TABLE = '#7a3b1e'
const TABLE_LEG = '#5e2c15'
const PLATE = '#e9edf3'
const PLATE_D = '#b8c0cc'
const STEAM = '#c7ced9'
const PAT_L = '#b8644e'
const PAT = '#94483a'
const PAT_D = '#6e3028'
const RICE = '#f3ead6'
const RICE_D = '#d9cbb0'
const FLAME = '#f39a2b'
const FLAME_IN = '#fff1a8'

/** 글자 지도로 그리기: 한 글자 = 1칸, pal에 없는 글자는 비움 */
function grid(R, x0, y0, rows, pal) {
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const col = pal[row[x]]
      if (col) R(x0 + x, y0 + y, 1, 1, col)
    }
  })
}

/* ── 개업 화환: 세발 받침대 + 둥근 꽃판 + 리본 두 줄 (상 없이 바닥에 섬) ── */

function wreathHead(R, cx, cy, rad) {
  const x0 = Math.floor(cx - rad)
  const y0 = Math.floor(cy - rad)
  for (let y = y0; y <= y0 + rad * 2 + 1; y++) {
    for (let x = x0; x <= x0 + rad * 2 + 1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      if (d > rad) continue
      let col
      if (d <= rad * 0.42) col = y + 0.5 < cy - 0.5 ? '#fff1a0' : x + 0.5 > cx + 1 || y + 0.5 > cy + 1.5 ? '#d8a820' : '#f2c14b'
      else if (d > rad - 0.8 && (x * 3 + y) % 4 === 0) col = '#3f9a4f'
      else {
        const t = x + 0.5 - cx + (y + 0.5 - cy)
        col = t < -1.5 ? '#ffc8c4' : t > 3.5 ? '#e48c8c' : '#f3aaa8'
      }
      R(x, y, 1, 1, col)
    }
  }
  // 꽃송이 8개: 흰 · 빨강 번갈아
  for (let i = 0; i < 8; i++) {
    const a = (i + 0.5) * Math.PI / 4
    const bx = Math.round(cx + Math.cos(a) * rad * 0.7 - 1)
    const by = Math.round(cy + Math.sin(a) * rad * 0.7 - 1)
    R(bx, by, 2, 2, i % 2 ? '#f3ead6' : '#e04a4e')
    R(bx + 1, by + 1, 1, 1, i % 2 ? '#f2c14b' : '#b8202a')
  }
}

function ribbon(R, x, y, h, col, colD, ink) {
  R(x, y, 3, h - 1, col)
  R(x + 2, y, 1, h - 1, colD)
  for (let i = 3; i < h - 3; i += 2) R(x + 1, y + i, 1, 1, ink)
  R(x, y + h - 1, 1, 1, col)
  R(x + 2, y + h - 1, 1, 1, colD)
}

/* ── 시루떡 ── */

function siruSlice(R, x, y, w) {
  const rows = [PAT_L, PAT, RICE, RICE, PAT, PAT_D]
  rows.forEach((col, i) => {
    R(x, y + i, w, 1, col)
    R(x + w - 1, y + i, 1, 1, col === RICE ? RICE_D : col === PAT_L ? PAT : PAT_D)
  })
  for (let i = 0; i < w - 1; i++) {
    if ((x + i) % 2 === 0) R(x + i, y + 1, 1, 1, PAT_L)
    if ((x + i) % 3 === 1) R(x + i, y + 4, 1, 1, PAT_D)
  }
  R(x + 1, y - 1, 1, 1, PAT_L)
  R(x + w - 3, y - 1, 1, 1, PAT_L)
}

/* ── 북어 + 실타래 ── */

const FISH_PAL = { B: '#9a8058', b: '#d4b47c', l: '#ecdcb0', g: '#9a8058', e: '#1b1b1b', m: '#4e301b', t: '#b8965e', w: '#f6f8fb', W: '#b8c0cc' }
// 20×7, 머리가 왼쪽. 흰 실이 가운데를 감음
const FISH = [
  '.......w..w.........',
  '..BBBBBwwWwBBB....tt',
  '.BebbbgwWwwbbbbbbtt.',
  'mbbbbbgWwwwbbbbbbt..',
  '.llllllwwwWlllllltt.',
  '..lllllwwWwlll....tt',
  '.......w..w.........',
]
const FISH_MAP = [
  '....w.....',
  '.BBBWBB..t',
  'mebbwbbbtt',
  '.lllWlll.t',
  '....w.....',
]

/* ── 축하 케이크 ── */

const NEW_TEXT = [
  'N..N.EEE.W...W',
  'NN.N.E...W...W',
  'N.NN.EE..W.W.W',
  'N..N.E...W.W.W',
  'N..N.EEE..W.W.',
]
/** 케이크는 시안보다 2px 아래: 촛불 불꽃이 화면 아랫줄(y81) · 그 밑 어두운 줄에 닿지 않게 */
const CAKE_DY = 2

/**
 * table: 고사상 [x, y, w, h] (그림 px, 없으면 바닥에 바로) · frontDy: 정면 그림으로 옮길 때 y 차이
 * hd(R): 부스 그림 · map(R): 작은 맵 사당
 */
const ART = {
  cake: {
    // 케이크를 내린 만큼 상은 낮게 (마루 앞끝 y107을 넘지 않게)
    table: [42, 106, 20, 2],
    frontDy: -50 - CAKE_DY,
    hd(R0) {
      const R = (x, y, w, h, col) => R0(x, y + CAKE_DY, w, h, col)
      R(42, 102, 20, 2, PLATE); R(42, 103, 20, 1, PLATE_D)
      R(44, 93, 16, 9, RICE)
      R(58, 93, 2, 9, RICE_D)
      R(44, 92, 16, 2, '#fffaf0')
      for (const x of [45, 49, 53, 57]) R(x, 94, 2, 1, '#fffaf0')
      R(44, 100, 16, 2, '#f3aaa8')
      for (let x = 45; x < 60; x += 2) R(x, 100, 1, 1, '#ffc8c4')
      grid(R, 45, 95, NEW_TEXT, { N: '#c8282e', E: '#c8282e', W: '#c8282e' })
      // 딸기
      R(45, 91, 2, 1, '#c8282e'); R(45, 90, 1, 1, '#3f9a4f')
      R(57, 91, 2, 1, '#c8282e'); R(58, 90, 1, 1, '#3f9a4f')
      // 줄무늬 초 한 자루와 심지 (불꽃은 매 프레임)
      R(51, 86, 2, 6, RICE); R(52, 86, 1, 6, RICE_D)
      R(51, 87, 1, 1, '#e04a4e'); R(52, 88, 1, 1, '#c8282e'); R(51, 89, 1, 1, '#e04a4e'); R(52, 90, 1, 1, '#c8282e')
      R(51, 85, 1, 1, '#3b2a1a')
    },
    map(R) {
      R(-4, 37, 8, 1, PLATE)
      R(-3, 33, 6, 4, RICE); R(-3, 33, 6, 1, '#fffaf0'); R(2, 34, 1, 2, RICE_D); R(-3, 36, 6, 1, '#f3aaa8')
      R(-2, 35, 1, 1, '#c8282e'); R(0, 35, 1, 1, '#c8282e')
      R(-3, 32, 1, 1, '#c8282e'); R(2, 32, 1, 1, '#c8282e')
      R(-1, 30, 2, 3, RICE); R(0, 31, 1, 1, '#e04a4e')
      R(-1, 29, 2, 1, FLAME); R(-1, 28, 1, 1, FLAME_IN)
    },
  },
  wreath: {
    table: null,
    frontDy: -48,
    hd(R) {
      R(51, 97, 2, 9, WOOD_D)
      R(47, 97, 1, 5, WOOD); R(46, 102, 1, 5, WOOD)
      R(56, 97, 1, 5, WOOD); R(57, 102, 1, 5, WOOD)
      ribbon(R, 43, 90, 16, '#c8282e', '#9c2a2a', '#f2c14b')
      ribbon(R, 58, 90, 16, '#f3ead6', '#d9cbb0', '#3b2a1a')
      wreathHead(R, 52, 90.5, 7)
    },
    map(R) {
      R(-2, 34, 1, 4, WOOD); R(1, 34, 1, 4, WOOD)
      R(-4, 31, 1, 6, '#c8282e'); R(3, 31, 1, 6, '#f3ead6')
      R(-4, 36, 1, 1, '#9c2a2a'); R(3, 36, 1, 1, '#d9cbb0')
      R(-2, 28, 4, 1, '#ffc8c4'); R(-3, 29, 6, 4, '#f3aaa8'); R(-2, 33, 4, 1, '#e48c8c')
      R(-3, 29, 1, 1, '#f3ead6'); R(2, 30, 1, 1, '#f3ead6'); R(-3, 31, 1, 1, '#e04a4e'); R(1, 32, 1, 1, '#e04a4e')
      R(-1, 30, 2, 2, '#f2c14b')
    },
  },
  siru: {
    table: [42, 104, 20, 3],
    frontDy: -50,
    hd(R) {
      R(43, 102, 18, 2, PLATE); R(43, 103, 18, 1, PLATE_D)
      siruSlice(R, 43, 96, 8)
      siruSlice(R, 52, 96, 8)
      siruSlice(R, 47, 90, 10)
      // 김 두 가닥
      R(49, 86, 1, 1, STEAM); R(50, 85, 1, 1, STEAM); R(49, 84, 1, 1, STEAM)
      R(54, 85, 1, 1, STEAM); R(55, 84, 1, 1, STEAM); R(54, 83, 1, 1, STEAM)
    },
    map(R) {
      R(-5, 37, 10, 1, PLATE)
      for (const sx of [-4, 0]) {
        R(sx, 32, 4, 1, PAT_L); R(sx, 33, 4, 1, RICE); R(sx, 34, 4, 1, PAT); R(sx, 35, 4, 1, RICE); R(sx, 36, 4, 1, PAT_D)
        R(sx + 3, 33, 1, 1, RICE_D); R(sx + 3, 35, 1, 1, RICE_D)
      }
      R(-2, 30, 1, 1, STEAM); R(1, 29, 1, 1, STEAM)
    },
  },
  bugeo: {
    table: [42, 104, 20, 3],
    frontDy: -50,
    hd(R) {
      R(43, 101, 18, 3, '#c88a4e'); R(43, 101, 18, 1, '#e0a868'); R(43, 103, 18, 1, WOOD)
      grid(R, 42, 94, FISH, FISH_PAL)
      // 실타래 끝이 쟁반 위로 늘어짐
      R(52, 101, 1, 1, '#f6f8fb'); R(53, 102, 2, 1, '#f6f8fb')
    },
    map(R) {
      R(-5, 37, 10, 1, '#c88a4e')
      grid(R, -5, 32, FISH_MAP, FISH_PAL)
    },
  },
}

const art = key => ART[gosaKey(key)]

/** 부스 그림(hd)에 고사 상 (고사상 + 놓인 것). R(x, y, w, h, color)는 그림 px */
export function paintGosaHD(R, key) {
  const a = art(key)
  if (a.table) R(...a.table, TABLE)
  a.hd(R)
}

/** 케이크 촛불 불꽃 가운데 (그림 px). 불꽃이 없는 고사 상이면 null */
export const gosaFlameAt = key => (gosaKey(key) === 'cake' ? [51.5, 84 + CAKE_DY] : null)

/**
 * 케이크 촛불 불꽃 (매 프레임). px(x, y, w, h, color)는 그림 px.
 * 두 장을 번갈아 그려 계산대 초처럼 흔들립니다 (불꽃 윗끝 y83: 화면 아랫줄 y81 · 어두운 줄 y82에 닿지 않음)
 */
export function gosaFlameHD(px, t) {
  const f = Math.floor(t / 310) % 2
  const y = 82 + CAKE_DY
  px(50, y + f, 3, 3 - f, FLAME)
  px(51, y + 1, 1, 2, FLAME_IN)
  px(51 + f, y - 1 + f, 1, 1, FLAME)
}

/**
 * 정면 그림(frontShapes)용. r(x, y, w, h, fill, class)
 * @param lit 불꽃을 켤지 (운영 중일 때). 불꽃은 정면 초와 같은 fla · flb 두 장으로 깜빡입니다
 */
export function gosaFront(r, key, lit) {
  const k = gosaKey(key)
  const a = ART[k]
  if (a.table) { r(22, 54, 36, 2, TABLE); r(24, 56, 2, 3, TABLE_LEG); r(54, 56, 2, 3, TABLE_LEG) }
  const R = (x, y, w, h, f, c) => r(x - 12, y + a.frontDy, w, h, f, c)
  a.hd(R)
  if (lit && k === 'cake') {
    for (const [f, c] of [[0, 'fla'], [1, 'flb']]) {
      const y = 82 + CAKE_DY
      R(50, y + f, 3, 3 - f, FLAME, c)
      R(51, y + 1, 1, 2, FLAME_IN, c)
      R(51 + f, y - 1 + f, 1, 1, FLAME, c)
    }
  }
}

/** 작은 맵 사당(drawShrine)용. R은 drawShrine 안의 R (가운데 기준) */
export function gosaMap(R, key) {
  art(key).map(R)
}

/** 등록소 고르기 칸 미리 보기: 고사 상만 마루 한 조각 위에 (그림 px 그대로, CSS가 키움) */
export const GOSA_PREVIEW = { x: 39, y: 80, w: 26, h: 29 }
export function paintGosaPreview(c, key) {
  const { x: ox, y: oy, w, h } = GOSA_PREVIEW
  const R = (x, y, ww, hh, col) => { c.fillStyle = col; c.fillRect(x - ox, y - oy, ww, hh) }
  c.clearRect(0, 0, w, h)
  // 부스에서 놓이는 자리: 화면 틀 아래 · 계산대(앞 천) · 마루
  R(39, 80, 26, 4, '#2b303c')
  R(39, 84, 26, 3, '#c88a4e'); R(39, 84, 26, 1, '#e0a868')
  R(39, 87, 26, 11, '#8a5a34')
  R(40, 88, 24, 7, '#c8282e'); R(40, 88, 24, 1, '#e04a4e')
  R(44, 90, 16, 1, '#f3ead6'); R(46, 92, 12, 1, '#f3ead6')
  R(39, 98, 26, 4, '#463b56'); R(39, 98, 26, 1, '#5a4d6c')
  R(39, 102, 26, 7, '#2e2639')
  paintGosaHD(R, key)
  if (gosaFlameAt(key)) gosaFlameHD(R, 0)
}
