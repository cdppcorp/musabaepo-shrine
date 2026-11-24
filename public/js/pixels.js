// 도트 그리기. 좌표는 맵 픽셀(도트 1칸 = 1px). 정식 에셋(P0)이 나오면 이 파일을 바꿉니다.
import { gosaKey } from './data.js'
import { gosaFront, gosaMap } from './gosa-art.js'

export function rect(c, x, y, w, h, color) {
  c.fillStyle = color
  c.fillRect(Math.round(x), Math.round(y), w, h)
}

/* ── 공통: 늘 같은 무늬가 나오는 난수 · 잡음 ── */

function hash(x, y, seed = 0) {
  let n = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed + 1, 1442695041)) | 0
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

/** 부드러운 잡음 0~1 (칸 크기 s) */
function vnoise(x, y, s, seed = 0) {
  const gx = Math.floor(x / s)
  const gy = Math.floor(y / s)
  const fx = x / s - gx
  const fy = y / s - gy
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const a = hash(gx, gy, seed)
  const b = hash(gx + 1, gy, seed)
  const c = hash(gx, gy + 1, seed)
  const d = hash(gx + 1, gy + 1, seed)
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}

/** 4×4 바이어 점묘: 색 경계를 도트답게 섞습니다 */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16)
const bayer = (x, y) => BAYER[(y & 3) * 4 + (x & 3)]
const rgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const shift = (c, n) => c.map(v => Math.max(0, Math.min(255, v + n)))

/** 한 번 그려 두고 다시 쓰는 작은 그림 */
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

/** 둥근 불빛 (가운데가 진하고 계단처럼 옅어짐) */
function glow(r, color) {
  return sprite(`glow${r}${color}`, r * 2 + 1, r * 2 + 1, c => {
    const [R, G, B] = rgb(color)
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        const d = Math.hypot(x, y) / r
        if (d >= 1) continue
        const a = Math.floor(((1 - d) ** 1.6) * 4 + bayer(x + r, y + r) - 0.5) / 4
        if (a <= 0) continue
        c.fillStyle = `rgba(${R},${G},${B},${(a * 0.34).toFixed(3)})`
        c.fillRect(x + r, y + r, 1, 1)
      }
    }
  })
}

export function drawGlow(c, x, y, r, color, alpha = 1) {
  c.globalAlpha = alpha
  c.drawImage(glow(r, color), Math.round(x) - r, Math.round(y) - r)
  c.globalAlpha = 1
}

export function shadow(c, x, y, w, h = 2) {
  c.fillStyle = 'rgba(0,0,0,.28)'
  c.fillRect(Math.round(x - w / 2), Math.round(y - 1), w, h)
  c.fillRect(Math.round(x - w / 2 + 1), Math.round(y - 1 + h), w - 2, 1)
}

/* ── 바닥: 맵 전체를 처음 한 번 구워 둡니다 (풀밭 · 흙길 · 돌바닥 · 돗자리 · 담 · 울타리 · 불빛 웅덩이) ── */

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const l = dx * dx + dy * dy
  const s = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0
  return Math.hypot(px - ax - dx * s, py - ay - dy * s)
}

function groundShape(g) {
  if (g.k === 'line') {
    const xs = g.pts.map(p => p[0])
    const ys = g.pts.map(p => p[1])
    const m = g.r + 4
    return {
      t: g.t, x0: Math.min(...xs) - m, x1: Math.max(...xs) + m, y0: Math.min(...ys) - m, y1: Math.max(...ys) + m,
      d(x, y) {
        let best = Infinity
        for (let i = 0; i < g.pts.length - 1; i++) {
          const [ax, ay] = g.pts[i]
          const [bx, by] = g.pts[i + 1]
          best = Math.min(best, segDist(x, y, ax, ay, bx, by))
        }
        return best - g.r
      },
    }
  }
  const rx = g.k === 'circle' ? g.r : g.rx
  const ry = g.k === 'circle' ? g.r : g.ry
  return {
    t: g.t, x0: g.x - rx - 4, x1: g.x + rx + 4, y0: g.y - ry - 4, y1: g.y + ry + 4,
    d: (x, y) => (Math.hypot((x - g.x) / rx, (y - g.y) / ry) - 1) * Math.min(rx, ry),
  }
}

const GRASS = ['#16262f', '#192b35', '#1c303a'].map(rgb)
const GRASS_EDGE = rgb('#122029')
const DIRT = ['#382f3f', '#3d3445'].map(rgb)
const DIRT_RIM = rgb('#2b2431')
const PEBBLE = rgb('#4b4053')
const PEBBLE_SHADE = rgb('#2e2735')
const STONE = ['#3d3951', '#423e57', '#39354c', '#46415b'].map(rgb)
const STONE_HI = STONE.map(c => shift(c, 9))
const STONE_LO = STONE.map(c => shift(c, -5))
const GROUT = rgb('#2a2738')
const STONE_RIM = rgb('#24212f')

function stonePixel(x, y, d) {
  if (d > -1.6) return STONE_RIM
  const row = Math.floor(y / 6)
  const ox = x + (row % 2) * 5
  if (ox % 10 === 0 || y % 6 === 0) return GROUT
  const i = Math.floor(hash(Math.floor(ox / 10), row, 7) * STONE.length)
  if (y % 6 === 1) return STONE_HI[i]
  if (ox % 10 === 9 || y % 6 === 5) return STONE_LO[i]
  return STONE[i]
}

function dirtPixel(x, y, d) {
  if (d > -1.3) return DIRT_RIM
  const r = hash(x, y, 3)
  if (r < 0.016) return PEBBLE
  if (hash(x, y - 1, 3) < 0.016) return PEBBLE_SHADE
  return vnoise(x, y, 9, 2) + (bayer(x, y) - 0.5) * 0.3 > 0.52 ? DIRT[1] : DIRT[0]
}

function grassPixel(x, y, d) {
  if (d < 1.4) return GRASS_EDGE
  const n = vnoise(x, y, 26, 4) + (bayer(x, y) - 0.5) * 0.2
  return n < 0.4 ? GRASS[0] : n < 0.63 ? GRASS[1] : GRASS[2]
}

/** 랙(서버) · 벽 초롱 자리 */
const rackXs = w => Array.from({ length: Math.floor((w - 60) / 96) + 1 }, (_, i) => 30 + i * 96).filter(x => x < w - 30)
const wallLampXs = w => rackXs(w).map(x => x + 48).filter(x => x < w - 24)

function lightsOf(world) {
  const L = []
  const arm = x => (x > world.w / 2 ? -1 : 1)
  for (const p of world.props) {
    if (p.k === 'pole') L.push([p.x + arm(p.x) * 4, p.y, 34, 0.85])
    else if (p.k === 'fire') L.push([p.x, p.y, 70, 1.35])
    else if (p.k === 'stone') L.push([p.x, p.y, 24, 0.6])
    else if (p.k === 'censer') L.push([p.x, p.y, 22, 0.5])
    else if (p.k === 'temple') L.push([p.x, p.y + 2, 48, 0.55])
    else if (p.k === 'table') L.push([p.x, p.y, 18, 0.45])
    else if (p.k === 'gate') L.push([p.x - 26, p.y - 4, 26, 0.7], [p.x + 26, p.y - 4, 26, 0.7])
  }
  for (const x of wallLampXs(world.w)) L.push([x, world.wallTop + 2, 20, 0.5])
  return L
}

function drawMat(c, p) {
  const x = Math.round(p.x - p.w / 2)
  const y = Math.round(p.y - p.h / 2)
  rect(c, x, y, p.w, p.h, '#7c3a30')
  rect(c, x + 1, y + 1, p.w - 2, p.h - 2, p.v ? '#7f6a42' : '#8a7448')
  for (let i = y + 2; i < y + p.h - 1; i += 2) rect(c, x + 2, i, p.w - 4, 1, p.v ? '#725e39' : '#7b673f')
  rect(c, x + 1, y + 1, p.w - 2, 1, '#9a8458')
  for (let i = y + 1; i < y + p.h - 1; i += 2) {
    rect(c, x - 1, i, 1, 1, '#9a8458')
    rect(c, x + p.w, i, 1, 1, '#9a8458')
  }
}

function drawWalls(c, world) {
  const { w, h, wallTop: T, wallSide: S, fenceY: F } = world
  // 위쪽 담: 서버 랙이 박힌 담과 기와
  rect(c, 0, 0, w, T, '#14213d')
  rect(c, 0, 0, w, 3, '#1d2c4c')
  rect(c, 0, 3, w, 1, '#0e182e')
  rect(c, 0, T - 2, w, 2, '#0e182e')
  for (let x = 0; x < w; x += 6) rect(c, x, 1, 1, 1, '#14213d')
  for (const x of rackXs(w)) {
    rect(c, x, 5, 12, 17, '#1a2130')
    rect(c, x, 5, 12, 1, '#2a3448')
    for (let i = 0; i < 3; i++) rect(c, x + 2, 7 + i * 5, 8, 3, '#2a3448')
  }
  for (const x of wallLampXs(w)) {
    rect(c, x, 4, 1, 3, '#2a2030')
    rect(c, x - 2, 7, 5, 1, '#3858a8')
    rect(c, x - 2, 8, 5, 5, '#c83838')
    rect(c, x - 1, 9, 3, 3, '#f08048')
    rect(c, x - 2, 13, 5, 1, '#3858a8')
    rect(c, x, 14, 1, 2, '#c83838')
  }
  // 양옆 담
  for (const x of [0, w - S]) {
    rect(c, x, 0, S, h, '#14213d')
    rect(c, x === 0 ? S - 1 : x, T, 1, h - T, '#0e182e')
  }
  // 아래 울타리 (가운데 입구 문 자리는 비워 둡니다)
  // 울타리 바깥은 어둡게
  c.fillStyle = 'rgba(4,9,15,.55)'
  c.fillRect(S, F + 14, w - S * 2, h - F - 14)
  const gate = world.props.find(p => p.k === 'gate')
  const gap = gate ? [gate.x - 46, gate.x + 46] : [0, 0]
  for (let x = S; x < w - S; x++) {
    if (x >= gap[0] && x < gap[1]) continue
    rect(c, x, F + 3, 1, 1, '#5e4532')
    rect(c, x, F + 4, 1, 1, '#3e2c20')
    rect(c, x, F + 9, 1, 1, '#5e4532')
    rect(c, x, F + 10, 1, 1, '#3e2c20')
    if ((x - S) % 12 === 2) {
      rect(c, x, F, 3, 15, '#6e5038')
      rect(c, x + 2, F + 1, 1, 14, '#4a3626')
      rect(c, x, F, 3, 1, '#86643f')
    }
  }
}

export function bakeFloor(world) {
  const { w, h } = world
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const c = cv.getContext('2d')
  const img = c.createImageData(w, h)
  const px = img.data
  const shapes = world.ground.map(groundShape)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const jitter = (vnoise(x, y, 5, 1) - 0.5) * 3.2
      let ds = Infinity
      let dd = Infinity
      for (const s of shapes) {
        if (x < s.x0 || x > s.x1 || y < s.y0 || y > s.y1) continue
        const d = s.d(x, y)
        if (s.t === 'stone') { if (d < ds) ds = d } else if (d < dd) dd = d
      }
      ds += jitter * 0.4
      dd += jitter
      const col = ds < 0 ? stonePixel(x, y, ds) : dd < 0 ? dirtPixel(x, y, dd) : grassPixel(x, y, Math.min(ds, dd))
      const i = (y * w + x) * 4
      px[i] = col[0]
      px[i + 1] = col[1]
      px[i + 2] = col[2]
      px[i + 3] = 255
    }
  }
  c.putImageData(img, 0, 0)

  // 풀 포기 · 들꽃 (풀밭에만)
  const isGrass = (x, y) => {
    const i = (y * w + x) * 4
    return GRASS.some(g => g[0] === px[i] && g[1] === px[i + 1] && g[2] === px[i + 2])
  }
  for (let gy = 0; gy < h; gy += 7) {
    for (let gx = 0; gx < w; gx += 7) {
      if (hash(gx, gy, 11) > 0.42) continue
      const x = gx + Math.floor(hash(gx, gy, 12) * 7)
      const y = gy + Math.floor(hash(gx, gy, 13) * 7)
      if (x < 2 || y < 2 || x > w - 3 || y > h - 3 || !isGrass(x, y) || !isGrass(x, y - 1)) continue
      if (hash(gx, gy, 14) < 0.035) {
        const flower = ['#9c5a76', '#a8945a', '#7a90b4', '#a8acb8'][Math.floor(hash(gx, gy, 15) * 4)]
        rect(c, x, y, 1, 1, '#2a4a3e')
        rect(c, x, y - 1, 1, 1, flower)
      } else {
        rect(c, x - 1, y, 1, 1, '#21363d')
        rect(c, x + 1, y, 1, 1, '#21363d')
        rect(c, x, y - 1, 1, 1, '#29434a')
      }
    }
  }
  for (const p of world.props) if (p.k === 'mat') drawMat(c, p)
  drawWalls(c, world)

  // 초롱 · 모닥불 · 석등 아래 따뜻한 불빛 웅덩이
  const lit = new Float32Array(w * h)
  for (const [lx, ly, r, a] of lightsOf(world)) {
    const ry = r * 0.72
    for (let y = Math.max(0, Math.floor(ly - ry)); y < Math.min(h, Math.ceil(ly + ry)); y++) {
      for (let x = Math.max(0, Math.floor(lx - r)); x < Math.min(w, Math.ceil(lx + r)); x++) {
        const e = Math.hypot((x - lx) / r, (y - ly) / ry)
        if (e < 1) lit[y * w + x] += (1 - e) ** 1.7 * a
      }
    }
  }
  const out = c.getImageData(0, 0, w, h)
  const d = out.data
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = lit[y * w + x]
      if (v <= 0.02) continue
      const q = Math.floor(Math.min(1, v) * 5 + bayer(x, y) - 0.25) / 5
      if (q <= 0) continue
      const i = (y * w + x) * 4
      d[i] = Math.min(255, d[i] + 62 * q)
      d[i + 1] = Math.min(255, d[i + 1] + 38 * q)
      d[i + 2] = Math.min(255, d[i + 2] + 8 * q)
    }
  }
  c.putImageData(out, 0, 0)
  return cv
}

/** 구워 둔 바닥에서 보이는 부분만 옮기고, 움직이는 것(랙 불빛 · 벽 초롱 깜빡임)만 새로 그립니다 */
export function drawFloor(c, floor, world, cx, cy, vw, vh, t) {
  const x0 = Math.max(0, cx)
  const y0 = Math.max(0, cy)
  const w = Math.min(world.w - x0, Math.ceil(vw) + 1)
  const h = Math.min(world.h - y0, Math.ceil(vh) + 1)
  if (w > 0 && h > 0) c.drawImage(floor, x0, y0, w, h, x0, y0, w, h)
  if (cy > world.wallTop) return
  for (const x of rackXs(world.w)) {
    for (let i = 0; i < 3; i++) rect(c, x + 3, 8 + i * 5, 1, 1, (Math.floor(t / 400) + i + x) % 3 ? '#46e07a' : '#1f5a35')
  }
  for (const x of wallLampXs(world.w)) {
    const f = Math.floor(t / 260 + x) % 3
    rect(c, x - 1, 9, 3, 3, f ? '#f08048' : '#ff9a5a')
    drawGlow(c, x, 10, 7, '#ffb347', 0.8)
  }
}

/* ── 나무 · 덤불: 잎 덩어리를 겹쳐 그립니다 (왼쪽 위에서 빛) ── */

const LEAF = [
  { line: '#0b1c1b', dark: '#122e28', mid: '#1a4034', light: '#23543f', hi: '#31694b' },
  { line: '#0b1a21', dark: '#122a33', mid: '#193b45', light: '#214d55', hi: '#2e6266' },
]

function paintCanopy(c, w, h, blobs, pal, seed) {
  const owner = new Int16Array(w * h).fill(-1)
  const shade = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let i = blobs.length - 1; i >= 0; i--) {
        const [bx, by, r] = blobs[i]
        const nx = (x + 0.5 - bx) / r
        const ny = (y + 0.5 - by) / r
        const e = nx * nx + ny * ny
        if (e >= 1) continue
        owner[y * w + x] = i
        // 앞 덩어리의 가장자리(뒤 덩어리와 맞닿는 곳)는 어둡게
        const rim = e > (1 - 1.6 / r) ** 2 && blobs.some((b, j) => j < i && Math.hypot(x + 0.5 - b[0], y + 0.5 - b[1]) < b[2])
        shade[y * w + x] = rim ? -1 : -(nx * 0.55 + ny * 0.83) * 0.9 + (vnoise(x, y, 3, seed) - 0.5) * 0.7
        break
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (owner[i] < 0) continue
      const out = x === 0 || y === 0 || x === w - 1 || y === h - 1
        || owner[i - 1] < 0 || owner[i + 1] < 0 || owner[i - w] < 0 || owner[i + w] < 0
      const s = shade[i] + (bayer(x, y) - 0.5) * 0.35
      const col = out ? pal.line : s < -0.45 ? pal.dark : s < 0.15 ? pal.mid : s < 0.6 ? pal.light : pal.hi
      rect(c, x, y, 1, 1, col)
    }
  }
}

function trunk(c, cx, y0, y1, half, root) {
  for (let y = y0; y < y1; y++) {
    const flare = y > y1 - 3 ? root : 0
    const l = cx - half - flare
    const r = cx + half + flare
    rect(c, l, y, r - l, 1, '#3e2c22')
    rect(c, l, y, 1, 1, '#54402f')
    rect(c, r - 2, y, 2, 1, '#2a1e17')
  }
}

function treeSprite(v) {
  return sprite(`tree${v}`, 36, 46, c => {
    trunk(c, 18, 26, 46, 2, 1)
    rect(c, 17, 34, 1, 3, '#2a1e17')
    paintCanopy(c, 36, 34, [[10, 20, 9], [26, 20, 9], [18, 12, 12], [13, 25, 8], [23, 25, 8], [18, 22, 10]], LEAF[v ? 1 : 0], v + 20)
  })
}

function bushSprite() {
  return sprite('bush', 20, 13, c => paintCanopy(c, 20, 13, [[6, 8, 5], [14, 8, 5], [10, 6, 6]], LEAF[0], 31))
}

/** 소원나무: 크고 오래된 나무, 아래쪽 가지에 소원 띠가 달려 있습니다 */
const WISH_W = 104
const WISH_H = 92
function wishSprite() {
  return sprite('wish', WISH_W, WISH_H, c => {
    trunk(c, 52, 50, 88, 7, 4)
    // 굵은 껍질 무늬
    for (const [x, y, l] of [[48, 60, 6], [55, 66, 5], [50, 74, 6], [56, 80, 4]]) rect(c, x, y, 1, l, '#2a1e17')
    // 금줄: 새끼줄에 흰 종이가 매달려 있습니다
    for (let x = 44; x < 61; x++) rect(c, x, 76 + ((x >> 1) % 2), 1, 1, '#b6a476')
    for (const x of [46, 51, 56]) { rect(c, x, 78, 2, 2, '#e6e0d0'); rect(c, x + 1, 80, 1, 1, '#c8c2b2') }
    paintCanopy(c, WISH_W, 66, [
      [20, 40, 15], [84, 40, 15], [32, 22, 18], [72, 22, 18], [52, 16, 20],
      [14, 50, 10], [90, 50, 10], [52, 40, 22], [34, 46, 15], [70, 46, 15], [52, 54, 13],
    ], LEAF[0], 41)
  })
}
/** 소원 띠 자리 (소원나무 그림 기준) */
const RIBBONS = [[18, 52], [28, 57], [40, 60], [47, 63], [60, 63], [66, 60], [78, 57], [88, 52], [34, 50], [72, 50], [22, 44], [83, 45]]
const RIBBON_COLORS = ['#c8282e', '#e8c04a', '#ece4d0', '#4a78c8', '#c8282e', '#e8c04a']

/* ── 소품 ── */

const PROP_BOX = { wish: [56, 96], tree: [18, 46], bush: [10, 13], fire: [18, 44], stump: [6, 8], pole: [10, 36], stone: [8, 24], table: [11, 16], stool: [4, 7], bench: [15, 14], gate: [62, 58] }
/** 소품이 차지하는 그림 범위 (화면 밖이면 건너뜁니다) */
export function propBox(p) {
  const [hw, hh] = PROP_BOX[p.k] ?? [24, 48]
  return { x0: p.x - hw, y0: p.y - hh, x1: p.x + hw, y1: p.y + 4 }
}

const FLAMES = [
  ['....o....', '...ooo...', '..oyyo...', '..oyyoo..', '.ooywyo..', '.oyywyyo.', 'ooyywwyoo', 'oyywwwyyo', 'royywwyor', '.rooyyoor'],
  ['...o.....', '...oo..o.', '..ooyo.o.', '..oyyooo.', '.ooywyyo.', '.oyywwyo.', 'ooyywwyyo', 'oyywwwwyo', 'royywwyor', '.rrooyorr'],
  ['.....o...', '..o.oo...', '..ooyoo..', '.ooyyyo..', '.oyywyoo.', 'ooyywwyo.', 'oyyywwyoo', 'oyywwwwyo', 'royyywyor', '.rooyyoor'],
]
const FLAME_COLOR = { r: '#b83a1c', o: '#f0902a', y: '#ffcf5a', w: '#fff4c4' }

function drawFire(c, x, y, t) {
  drawGlow(c, x, y - 8, 22, '#ff9a3c', 0.75 + Math.sin(t / 140) * 0.1 + Math.sin(t / 53) * 0.05)
  // 돌 테두리
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2
    const sx = Math.round(x + Math.cos(a) * 9) - 1
    const sy = Math.round(y - 1 + Math.sin(a) * 3.5)
    rect(c, sx, sy, 3, 2, '#4a4a58')
    rect(c, sx, sy, 3, 1, '#62627a')
  }
  // 장작
  rect(c, x - 7, y - 3, 14, 2, '#5a3a24')
  rect(c, x - 7, y - 3, 2, 2, '#8a6040')
  rect(c, x + 5, y - 3, 2, 2, '#8a6040')
  for (let i = 0; i < 9; i++) rect(c, x - 4 + i, y - 6 + Math.floor(i / 2), 1, 2, '#4a301e')
  rect(c, x - 4, y - 4, 8, 2, '#c8401e')
  const f = FLAMES[Math.floor(t / 110) % FLAMES.length]
  f.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      const ch = row[i]
      if (ch !== '.') rect(c, x - 4 + i, y - 14 + j, 1, 1, FLAME_COLOR[ch])
    }
  })
  // 불티
  for (let i = 0; i < 5; i++) {
    const p = (t / 1100 + i * 0.23) % 1
    c.globalAlpha = 1 - p
    rect(c, x + Math.sin(p * 7 + i * 2) * 4, y - 15 - p * 22, 1, 1, i % 2 ? '#ffd36b' : '#ff9a3c')
  }
  c.globalAlpha = 1
}

function drawLantern(c, lx, top, t, seed) {
  rect(c, lx, top, 1, 2, '#2a2030')
  rect(c, lx - 2, top + 2, 5, 1, '#2a2030')
  rect(c, lx - 2, top + 3, 5, 2, '#3858a8')
  rect(c, lx - 2, top + 5, 5, 5, '#c83838')
  rect(c, lx - 1, top + 6, 3, 3, Math.floor(t / 230 + seed) % 4 ? '#f08048' : '#ff9a5a')
  rect(c, lx - 2, top + 10, 5, 1, '#3858a8')
  rect(c, lx - 1, top + 11, 3, 1, '#2a2030')
  rect(c, lx, top + 12, 1, 3, '#c83838')
  drawGlow(c, lx, top + 7, 9, '#ffb347', 0.85 + Math.sin(t / 300 + seed) * 0.1)
}

/** 소원나무 둘레를 떠다니는 반딧불 */
function fireflies(c, x, y, t) {
  for (let i = 0; i < 6; i++) {
    const a = t / (2400 + i * 300) + i * 1.9
    const fx = x + Math.sin(a) * (30 + i * 4)
    const fy = y - 40 + Math.cos(a * 1.3) * 18 - i * 3
    if (Math.sin(t / 380 + i * 2.1) < -0.2) continue
    rect(c, fx, fy, 1, 1, '#d8ff8a')
    c.globalAlpha = 0.35
    rect(c, fx - 1, fy, 3, 1, '#b8ff6a')
    rect(c, fx, fy - 1, 1, 3, '#b8ff6a')
    c.globalAlpha = 1
  }
}

function drawGate(c, x, y, t) {
  for (const px of [x - 44, x + 36]) {
    rect(c, px - 2, y - 4, 12, 4, '#4a4a58')
    rect(c, px - 2, y - 4, 12, 1, '#62627a')
    rect(c, px, y - 46, 8, 42, '#9c2a26')
    rect(c, px, y - 46, 2, 42, '#c0403a')
    rect(c, px + 6, y - 46, 2, 42, '#6e1c1a')
  }
  // 가로대와 단청 띠
  rect(c, x - 50, y - 42, 100, 4, '#9c2a26')
  rect(c, x - 50, y - 42, 100, 1, '#c0403a')
  rect(c, x - 50, y - 39, 100, 1, '#6e1c1a')
  rect(c, x - 50, y - 47, 100, 5, '#2a6a5a')
  for (let i = x - 48; i < x + 48; i += 6) {
    rect(c, i, y - 46, 2, 3, '#e8c04a')
    rect(c, i + 3, y - 45, 1, 1, '#c8282e')
  }
  // 지붕: 기와와 들린 처마
  rect(c, x - 56, y - 55, 112, 8, '#262b3a')
  for (let i = x - 54; i < x + 56; i += 4) rect(c, i, y - 54, 1, 7, '#1c2030')
  rect(c, x - 52, y - 57, 104, 2, '#323a4e')
  rect(c, x - 60, y - 58, 5, 3, '#262b3a')
  rect(c, x + 55, y - 58, 5, 3, '#262b3a')
  rect(c, x - 62, y - 60, 3, 2, '#323a4e')
  rect(c, x + 59, y - 60, 3, 2, '#323a4e')
  rect(c, x - 56, y - 48, 112, 1, '#161a26')
  // 현판
  rect(c, x - 13, y - 40, 26, 10, '#c89a4a')
  rect(c, x - 12, y - 39, 24, 8, '#2a1a14')
  for (const i of [-8, -3, 2, 7]) { rect(c, x + i, y - 37, 2, 1, '#e8c04a'); rect(c, x + i, y - 35, 1, 2, '#e8c04a') }
  drawLantern(c, x - 26, y - 38, t, 1)
  drawLantern(c, x + 26, y - 38, t, 2)
}

export function drawProp(c, p, t) {
  const { x, y } = p
  switch (p.k) {
    case 'wish': {
      c.fillStyle = 'rgba(0,0,0,.3)'
      c.fillRect(x - 26, y - 3, 52, 5)
      c.fillRect(x - 20, y + 2, 40, 2)
      c.drawImage(wishSprite(), x - WISH_W / 2, y - WISH_H + 4)
      const ox = x - WISH_W / 2
      const oy = y - WISH_H + 4
      RIBBONS.forEach(([rx, ry], i) => {
        const col = RIBBON_COLORS[i % RIBBON_COLORS.length]
        const sway = Math.sin(t / 700 + i * 1.7) > 0.35 ? 1 : 0
        rect(c, ox + rx, oy + ry, 1, 3, col)
        rect(c, ox + rx + sway, oy + ry + 3, 1, 2, col)
      })
      fireflies(c, x, y, t)
      return
    }
    case 'tree':
      shadow(c, x, y, 18, 3)
      c.drawImage(treeSprite(p.v ?? 0), x - 18, y - 45)
      return
    case 'bush':
      shadow(c, x, y, 16)
      c.drawImage(bushSprite(), x - 10, y - 12)
      return
    case 'fire':
      drawFire(c, x, y, t)
      return
    case 'stump':
      shadow(c, x, y + 1, 10)
      rect(c, x - 4, y - 3, 8, 3, '#4e3828')
      rect(c, x - 4, y - 1, 8, 1, '#3a2a1e')
      rect(c, x + 2, y - 3, 2, 3, '#3a2a1e')
      rect(c, x - 3, y - 6, 6, 1, '#9a7650')
      rect(c, x - 4, y - 5, 8, 2, '#9a7650')
      rect(c, x - 2, y - 5, 4, 1, '#7e5e3e')
      rect(c, x - 1, y - 5, 1, 1, '#6a4c30')
      return
    case 'pole': {
      const arm = x > 448 ? -1 : 1
      shadow(c, x, y, 6)
      rect(c, x - 1, y - 30, 2, 30, '#4a3626')
      rect(c, x - 1, y - 30, 1, 30, '#5e4632')
      rect(c, arm > 0 ? x : x - 6, y - 30, 7, 1, '#4a3626')
      rect(c, x - 1, y - 31, 2, 1, '#6e5238')
      drawLantern(c, x + arm * 5, y - 29, t, x)
      return
    }
    case 'stone':
      shadow(c, x, y, 12)
      rect(c, x - 5, y - 3, 10, 3, '#4a4a58')
      rect(c, x - 5, y - 3, 10, 1, '#5c5c6c')
      rect(c, x - 2, y - 10, 4, 7, '#5a5a68')
      rect(c, x + 1, y - 10, 1, 7, '#44444f')
      rect(c, x - 4, y - 16, 8, 6, '#5a5a68')
      rect(c, x + 3, y - 16, 1, 6, '#44444f')
      rect(c, x - 2, y - 15, 4, 3, Math.floor(t / 300 + x) % 3 ? '#ffc36b' : '#f0a64a')
      rect(c, x - 6, y - 19, 12, 3, '#3e3e4c')
      rect(c, x - 5, y - 20, 10, 1, '#50505e')
      rect(c, x - 7, y - 18, 1, 1, '#3e3e4c')
      rect(c, x + 6, y - 18, 1, 1, '#3e3e4c')
      rect(c, x - 1, y - 22, 2, 2, '#3e3e4c')
      drawGlow(c, x, y - 14, 8, '#ffb347', 0.8)
      return
    case 'table':
      shadow(c, x, y + 1, 16, 3)
      rect(c, x - 2, y - 5, 4, 5, '#3e2a1c')
      rect(c, x - 6, y - 12, 12, 1, '#a07450')
      rect(c, x - 8, y - 11, 16, 1, '#946a44')
      rect(c, x - 9, y - 10, 18, 3, '#8a6040')
      rect(c, x - 8, y - 7, 16, 1, '#7a5434')
      rect(c, x - 6, y - 6, 12, 1, '#5a3c24')
      rect(c, x - 5, y - 11, 2, 2, '#e0d8c8')
      rect(c, x - 5, y - 11, 2, 1, '#b8a888')
      rect(c, x + 3, y - 10, 2, 2, '#e0d8c8')
      rect(c, x + 3, y - 10, 2, 1, '#b8a888')
      rect(c, x - 1, y - 12, 1, 2, '#f3ead6')
      rect(c, x - 1, y - 13 - (Math.floor(t / 200 + x) % 2), 1, 1, '#ffcf5a')
      drawGlow(c, x - 1, y - 12, 6, '#ffb347', 0.7)
      return
    case 'stool':
      shadow(c, x, y + 1, 7)
      rect(c, x - 3, y - 3, 1, 3, '#3e2a1c')
      rect(c, x + 2, y - 3, 1, 3, '#3e2a1c')
      rect(c, x - 3, y - 5, 6, 2, '#8a6040')
      rect(c, x - 3, y - 5, 6, 1, '#a07450')
      return
    case 'bench':
      shadow(c, x, y + 1, 28)
      rect(c, x - 12, y - 11, 1, 11, '#4a3020')
      rect(c, x + 11, y - 11, 1, 11, '#3e2a1c')
      rect(c, x - 1, y - 4, 1, 4, '#3e2a1c')
      rect(c, x - 13, y - 11, 26, 2, '#7a5434')
      rect(c, x - 13, y - 11, 26, 1, '#946a44')
      rect(c, x - 13, y - 6, 26, 2, '#8a6040')
      rect(c, x - 13, y - 6, 26, 1, '#a07450')
      rect(c, x - 13, y - 4, 26, 1, '#5a3c24')
      return
    case 'gate':
      drawGate(c, x, y, t)
  }
}

/** 초롱 줄: 기둥 꼭대기끼리 처지게 걸린 줄에 작은 전구가 달려 깜빡입니다 (캐릭터 위에 그립니다) */
const BULBS = ['#ffd36b', '#ff7a6b', '#7ad0ff', '#a8f09a']
export function drawStrings(c, strings, t, lit = 1) {
  strings.forEach(([[x0, y0], [x1, y1]], si) => {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))))
    const sag = Math.min(16, 3 + Math.hypot(x1 - x0, y1 - y0) * 0.07)
    let k = 0
    for (let i = 0; i <= n; i++) {
      const s = i / n
      const x = Math.round(x0 + (x1 - x0) * s)
      const y = Math.round(y0 + (y1 - y0) * s + sag * 4 * s * (1 - s))
      rect(c, x, y, 1, 1, '#1a1626')
      if (i % 7 !== 3 || i < 2 || i > n - 2) continue
      const col = BULBS[(k + si) % BULBS.length]
      const on = ((k * 0.618 + si * 0.371) % 1) < lit && Math.sin(t / 520 + k * 1.3 + si * 0.7) > -0.55
      rect(c, x, y + 1, 1, 2, on ? col : '#3a3446')
      if (on) drawGlow(c, x, y + 2, 3, col, 0.9)
      k++
    }
  })
}

/* ── 배포운 상자 · 오늘 켜진 초 게시판 ── */

/**
 * @param fx 배포운 상자 연출 { shake: -1 · 0 · 1, slip: 쪽지가 올라온 정도 0~1 } (없으면 가만히)
 */
export function drawFortune(c, f, fx) {
  const x = f.x
  const y = f.y
  const w = f.w
  const h = f.h
  c.fillStyle = 'rgba(0,0,0,.28)'
  c.fillRect(x + 1, y + h - 1, w - 2, 3)
  // 받침대: 다리 둘 · 가로대 · 선반 (충돌 상자 안)
  rect(c, x + 3, y + 9, 2, h - 9, '#4e301b')
  rect(c, x + w - 5, y + 9, 2, h - 9, '#4e301b')
  rect(c, x + 3, y + 14, w - 6, 1, '#4e301b')
  rect(c, x + 1, y + 7, w - 2, 2, '#6b4022')
  rect(c, x + 1, y + 7, w - 2, 1, '#8a5a34')
  // 상자: 선반 위로 올라와 캐릭터보다 조금 큽니다. 흔들면 좌우로 1px씩 떨립니다
  const bx = x + 2 + (fx?.shake ?? 0)
  const bw = w - 4
  const top = y - 9
  const mid = bx + Math.floor(bw / 2)
  rect(c, bx + 1, top, bw - 2, 1, '#c88a4e')
  rect(c, bx, top + 1, bw, 4, '#a8693a')
  rect(c, bx, top + 1, bw, 1, '#c88a4e')
  rect(c, mid - 3, top + 2, 6, 2, '#2a170c')
  if (fx?.slip) {
    const sh = Math.max(1, Math.round(11 * fx.slip))
    rect(c, mid - 1, top + 3 - sh, 3, sh, '#f3ead6')
    rect(c, mid + 1, top + 3 - sh, 1, sh, '#d9cbb0')
    rect(c, mid - 1, top + 3 - sh, 3, Math.min(2, sh), '#c8282e')
  }
  rect(c, bx, top + 5, bw, 11, '#7a4b2a')
  rect(c, bx, top + 5, bw, 1, '#8f5a33')
  rect(c, bx + 4, top + 6, 1, 10, '#6b4022')
  rect(c, bx + bw - 5, top + 6, 1, 10, '#6b4022')
  rect(c, bx + bw - 2, top + 5, 2, 11, '#5e3a20')
  rect(c, bx + 6, top + 7, bw - 12, 8, '#ecdcb4')
  rect(c, bx + 6, top + 7, bw - 12, 2, '#c8282e')
  rect(c, bx + 8, top + 11, bw - 16, 1, '#8a7650')
  rect(c, bx + 8, top + 13, bw - 17, 1, '#8a7650')
  rect(c, bx, top + 15, bw, 1, '#4e301b')
}

export function drawBoard(c, b) {
  c.fillStyle = 'rgba(0,0,0,.28)'
  c.fillRect(b.x + 2, b.y + b.h + 2, b.w - 4, 3)
  rect(c, b.x + 4, b.y + b.h - 2, 3, 6, '#4e301b')
  rect(c, b.x + b.w - 7, b.y + b.h - 2, 3, 6, '#4e301b')
  // 작은 지붕
  rect(c, b.x - 2, b.y - 4, b.w + 4, 3, '#2a2f3e')
  rect(c, b.x - 1, b.y - 5, b.w + 2, 1, '#3a4256')
  rect(c, b.x, b.y - 1, b.w, b.h + 1, '#6b4022')
  rect(c, b.x + 2, b.y + 2, b.w - 4, b.h - 4, '#ecdcb4')
  // 붙은 쪽지들과 초
  rect(c, b.x + 12, b.y + 4, 8, 6, '#f3ead6')
  rect(c, b.x + 22, b.y + 5, 7, 8, '#e8d8a8')
  rect(c, b.x + 13, b.y + 12, 6, 5, '#f0e2c0')
  rect(c, b.x + 15, b.y + 4, 2, 1, '#c8282e')
  rect(c, b.x + 25, b.y + 5, 1, 1, '#c8282e')
  rect(c, b.x + 6, b.y + 7, 2, 8, '#f3ead6')
  rect(c, b.x + 6, b.y + 5, 2, 2, '#f39a2b')
}

/* ── 사당 (위에서 본 맵용) ── */

function candleTop(c, x, top, tier, t, period) {
  rect(c, x, top + 19, 2, 5, tier < 0 ? '#8a8f9c' : '#f3ead6')
  if (tier < 0) {
    rect(c, x, top + 17, 1, 1, '#6f788b')
    return
  }
  const f = Math.floor(t / period) % 2
  c.fillStyle = `rgba(255,179,71,${[0.12, 0.2, 0.32][tier]})`
  c.fillRect(x - 3 - tier, top + 12 - tier, 8 + tier * 2, 9 + tier)
  const h = [1, 2, 3][tier]
  rect(c, x, top + 19 - h + f, 2, h, '#f39a2b')
  rect(c, x + (f ? 1 : 0), top + 18, 1, 1, '#fff1a8')
}

/**
 * @param mini 실제 화면을 12×7로 줄인 캔버스 (없으면 빈 화면)
 * @param tier 초 밝기 0 · 1 · 2
 */
export function drawShrine(c, plot, s, tier, t, mini) {
  const cx = plot.x + 24
  const top = plot.y
  const R = (x, y, w, h, color) => rect(c, cx + x, top + y, w, h, color)
  const live = s.status === 'live'
  const roof = !live ? '#4a5266' : s.keeper ? '#b06a1f' : '#9c3b2a'
  R(-20, 32, 40, 8, '#3a3148'); R(-20, 32, 40, 1, '#4a3f5c')
  R(-17, 12, 3, 20, '#6b4022'); R(14, 12, 3, 20, '#6b4022')
  R(-18, 5, 36, 3, roof); R(-21, 8, 42, 5, roof); R(-21, 12, 42, 1, '#2a1a14')
  R(-7, 6, 14, 3, '#ecdcb4')
  R(-12, 24, 24, 6, '#8a5a34'); R(-12, 24, 24, 1, '#a8703f')
  R(-7, 14, 14, 9, '#2b303c')
  if (live && mini) c.drawImage(mini, cx - 6, top + 15, 12, 7)
  else R(-6, 15, 12, 7, live ? '#0d2418' : '#2d323d')
  if (!live) { R(-1, 16, 2, 3, '#f2c14b'); R(-1, 20, 2, 1, '#f2c14b') }
  if (s.keeper) R(-2, 1, 4, 4, '#f0a64a')
  candleTop(c, cx - 11, top, live ? tier : -1, t, 350)
  candleTop(c, cx + 9, top, live ? tier : -1, t, 430)
  // 입점 첫 주: 사당 주인이 고른 고사 상
  if (s.isNew) gosaMap(R, s.gosa)
}

/** 빈 자리 천막 색 (자리 번호마다 돌아가며) */
const TENTS = [
  ['#93423c', '#6e2e2c'], ['#3b5c8e', '#2a4268'], ['#3a7a5e', '#285a44'], ['#a07a34', '#765a24'], ['#7a4a86', '#583462'],
]

/** 빈 자리: 줄무늬 천막만 쳐 두고 아직 문을 열지 않은 부스. 계산대에 '입점 대기' 팻말 */
export function drawEmptyPlot(c, plot) {
  const v = plot.id % TENTS.length
  c.drawImage(sprite(`tent${v}`, 48, 44, g => paintTent(g, TENTS[v])), plot.x, plot.y)
}

function paintTent(c, [col, colD]) {
  const cx = 24
  const cream = '#c4bba6'
  const creamD = '#968e7c'
  c.fillStyle = 'rgba(0,0,0,.25)'
  c.fillRect(cx - 22, 38, 44, 3)
  // 마루와 천막 안쪽 (어두운 뒷면에 줄무늬가 비칩니다)
  rect(c, cx - 20, 33, 40, 6, '#3a3040')
  rect(c, cx - 20, 33, 40, 1, '#4e4258')
  rect(c, cx - 18, 13, 36, 20, '#1b1726')
  for (let x = cx - 18; x < cx + 18; x += 6) rect(c, x, 13, 3, 20, '#221d30')
  // 기둥
  rect(c, cx - 20, 12, 2, 22, '#5e4836')
  rect(c, cx + 18, 12, 2, 22, '#46362a')
  // 빈 계산대와 팻말
  rect(c, cx - 17, 24, 34, 2, '#8a6a48')
  rect(c, cx - 17, 26, 34, 7, '#5a4330')
  rect(c, cx - 17, 26, 34, 1, '#46342a')
  rect(c, cx - 7, 27, 14, 5, '#b8ae98')
  rect(c, cx - 7, 27, 14, 1, '#d0c6b0')
  rect(c, cx - 5, 29, 10, 1, '#6e624e')
  rect(c, cx - 4, 31, 6, 1, '#8a7e68')
  // 천막 지붕: 아래로 갈수록 넓어지는 줄무늬 천
  for (let y = 0; y < 10; y++) {
    const half = 19 + Math.floor(y / 3)
    for (let x = cx - half; x < cx + half; x++) {
      const stripe = Math.floor((x - cx + 24) / 4) % 2
      const lit = y < 3 ? 0 : y < 7 ? 1 : 2
      const color = stripe
        ? [col, col, colD][lit]
        : [cream, cream, creamD][lit]
      rect(c, x, 3 + y, 1, 1, color)
    }
  }
  rect(c, cx - 18, 2, 36, 1, colD)
  rect(c, cx - 1, 0, 2, 2, '#5e4836')
  // 앞 처마의 물결 장식
  for (let i = 0; i < 11; i++) {
    const x = cx - 22 + i * 4
    const color = i % 2 ? col : cream
    rect(c, x, 13, 4, 1, color)
    rect(c, x + 1, 14, 2, 1, color)
  }
}

/** 실제 화면 이미지를 w×h로 줄여 도트처럼 쓰는 작은 캔버스 */
export function shrink(img, w, h) {
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const c = cv.getContext('2d')
  c.imageSmoothingEnabled = true
  c.imageSmoothingQuality = 'high'
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight)
  const sw = w / scale
  const sh = h / scale
  c.drawImage(img, 0, 0, sw, sh, 0, 0, w, h)
  return cv
}

/* ── 사당 정면 (패널용, 80×60 SVG) — 1차 코드 shrinePixels를 옮겨 왔습니다 ── */

function frontShapes(o) {
  const s = []
  const r = (x, y, w, h, f, c, d) => s.push({ k: 'r', x, y, w, h, f, c, d })
  r(0, 0, 80, 44, '#14213d'); r(0, 0, 80, 2, '#0e182e'); r(0, 31, 80, 1, '#1b2b4d')
  r(0, 44, 80, 16, '#2a2338'); r(0, 44, 80, 1, '#3b3150'); r(0, 50, 80, 1, '#241e31'); r(0, 56, 80, 1, '#241e31')
  r(70, 11, 9, 33, '#1a2130')
  for (let i = 0; i < 6; i++) {
    const y = 13 + i * 5
    r(71, y, 7, 4, '#2a3448')
    r(72, y + 1, 1, 1, o.screen === 'check' && i === 2 ? '#f5a33b' : '#46e07a', 'led', i * 0.21)
    r(74, y + 1, 3, 1, '#3a4660')
  }
  r(28, 0, 1, 2, '#6b4022'); r(51, 0, 1, 2, '#6b4022'); r(25, 2, 30, 7, '#6b4022'); r(26, 3, 28, 5, '#ecdcb4')
  if (o.deco.includes('cactus')) {
    r(5, 43, 2, 9, '#3f9a4f'); r(3, 46, 2, 1, '#3f9a4f'); r(3, 44, 1, 2, '#3f9a4f'); r(7, 47, 2, 1, '#3f9a4f'); r(8, 45, 1, 2, '#3f9a4f')
    r(3, 52, 6, 4, '#b5653a'); r(3, 52, 6, 1, '#cf7c4c')
  }
  r(10, 36, 60, 3, '#8a5a34'); r(10, 36, 60, 1, '#a8703f'); r(12, 39, 56, 8, '#6a4326'); r(14, 41, 52, 1, '#5a381f'); r(12, 46, 56, 1, '#4e301b')
  r(26, 14, 28, 19, '#2b303c'); r(26, 14, 28, 1, '#3d4454')
  if (o.screen === 'check') {
    r(28, 16, 24, 14, '#2d323d'); r(44, 18, 2, 6, '#f2c14b'); r(44, 25, 2, 2, '#f2c14b')
  } else {
    r(28, 16, 24, 14, '#0b1220')
  }
  r(38, 33, 4, 2, '#2b303c'); r(34, 35, 12, 1, '#3d4454')
  frontCandle(s, 13, 'cl', o.flame)
  frontCandle(s, 63, 'cr', o.flame)
  if (o.charm) { r(23, 15, 4, 9, '#f2d24b'); r(23, 15, 4, 1, '#fff1a0'); r(24, 17, 2, 1, '#c8282e'); r(24, 19, 1, 3, '#c8282e'); r(24, 22, 2, 1, '#c8282e') }
  if (o.deco.includes('cat')) {
    r(28, 12, 3, 1, '#e39b4a'); r(31, 11, 9, 3, '#e39b4a'); r(39, 9, 5, 4, '#e39b4a'); r(39, 8, 1, 1, '#e39b4a'); r(43, 8, 1, 1, '#e39b4a'); r(41, 10, 1, 1, '#1b1b1b')
  }
  if (o.deco.includes('duck')) { r(19, 33, 5, 3, '#f6cf3a'); r(22, 30, 3, 3, '#f6cf3a'); r(25, 31, 1, 1, '#f08a24'); r(23, 31, 1, 1, '#1b1b1b') }
  if (o.deco.includes('coffee')) { r(47, 33, 3, 3, '#e9edf3'); r(50, 34, 1, 1, '#e9edf3'); r(47, 33, 3, 1, '#5b3a24'); r(48, 31, 1, 1, '#c7ced9', 'blink') }
  if (o.deco.includes('makgeolli')) { r(58, 25, 2, 2, '#1d6a3b'); r(57, 27, 4, 9, '#2f9e5a'); r(57, 30, 4, 3, '#eef6ef') }
  // 입점 첫 주 고사 상 (케이크 촛불은 켜진 사당만, 정면 초처럼 깜빡임)
  if (o.gosa) gosaFront(r, o.gosa, o.flame !== 'off')
  return s
}

function frontCandle(s, cx, side, flame) {
  const r = (x, y, w, h, f, c) => s.push({ k: 'r', x, y, w, h, f, c: c ? `${c} ${side}` : undefined })
  r(cx - 1, 33, 6, 3, '#b48a3a'); r(cx, 24, 4, 9, '#f3ead6'); r(cx + 3, 24, 1, 9, '#d8c8a6'); r(cx + 1, 22, 1, 2, '#3b2a1a')
  if (flame === 'off') { r(cx + 1, 20, 1, 1, '#6f788b'); return }
  const glow = { small: [7, 0.35], mid: [10, 0.55], big: [13, 0.8] }[flame]
  s.push({ k: 'c', cx: cx + 1.5, cy: 19, r: glow[0], o: glow[1] })
  if (flame === 'big') {
    r(cx - 1, 16, 5, 6, '#f39a2b', 'fla'); r(cx, 17, 3, 5, '#ffcf5a', 'fla'); r(cx + 1, 18, 1, 4, '#fff6c8', 'fla')
    r(cx - 1, 17, 5, 5, '#f39a2b', 'flb'); r(cx, 17, 3, 5, '#ffcf5a', 'flb'); r(cx + 2, 15, 1, 2, '#f39a2b', 'flb')
  } else if (flame === 'mid') {
    r(cx, 18, 3, 4, '#f39a2b', 'fla'); r(cx + 1, 19, 1, 3, '#fff1a8', 'fla'); r(cx + 1, 17, 1, 1, '#f39a2b', 'fla')
    r(cx, 19, 3, 3, '#f39a2b', 'flb'); r(cx + 1, 19, 1, 3, '#fff1a8', 'flb'); r(cx + 2, 17, 1, 2, '#f39a2b', 'flb')
  } else {
    r(cx + 1, 20, 1, 2, '#f39a2b', 'fla'); r(cx + 1, 19, 1, 3, '#f39a2b', 'flb')
  }
}

let gradientSeq = 0

/** 사당 정면 SVG. DOM API로만 만듭니다 (HTML 문자열을 넣지 않음). */
export function buildFront(s, tier) {
  const NS = 'http://www.w3.org/2000/svg'
  const live = s.status === 'live'
  const flame = !live ? 'off' : tier === 2 ? 'big' : tier === 1 ? 'mid' : 'small'
  const shapes = frontShapes({ flame, screen: live ? 'image' : 'check', deco: s.deco, charm: !!s.charm, gosa: s.isNew ? gosaKey(s.gosa) : null })
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 80 60')
  svg.setAttribute('shape-rendering', 'crispEdges')
  svg.setAttribute('aria-hidden', 'true')
  const id = `shrine-glow-${++gradientSeq}`
  const defs = document.createElementNS(NS, 'defs')
  const grad = document.createElementNS(NS, 'radialGradient')
  grad.setAttribute('id', id)
  for (const [offset, color, opacity] of [['0', '#ffc36b', '1'], ['0.45', '#ffb347', '0.45'], ['1', '#ffb347', '0']]) {
    const stop = document.createElementNS(NS, 'stop')
    stop.setAttribute('offset', offset)
    stop.setAttribute('stop-color', color)
    stop.setAttribute('stop-opacity', opacity)
    grad.append(stop)
  }
  defs.append(grad)
  svg.append(defs)
  for (const sh of shapes) {
    const node = document.createElementNS(NS, sh.k === 'r' ? 'rect' : 'circle')
    if (sh.k === 'r') {
      node.setAttribute('x', sh.x); node.setAttribute('y', sh.y)
      node.setAttribute('width', sh.w); node.setAttribute('height', sh.h)
      node.setAttribute('fill', sh.f)
      if (sh.d) node.style.animationDelay = `${sh.d}s`
    } else {
      node.setAttribute('cx', sh.cx); node.setAttribute('cy', sh.cy); node.setAttribute('r', sh.r)
      node.setAttribute('fill', `url(#${id})`)
      node.setAttribute('fill-opacity', sh.o)
      node.setAttribute('shape-rendering', 'geometricPrecision')
      sh.c = 'glow'
    }
    if (sh.c) node.setAttribute('class', sh.c)
    svg.append(node)
  }
  return svg
}
