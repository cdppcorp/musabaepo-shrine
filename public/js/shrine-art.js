// 서비스 사당(부스) 2배 도트.
//   맵 1px = 그림 2px로 따로 그린 뒤 반 크기로 붙입니다. 화면 배율 k가 짝수라 반 칸 도트도 또렷합니다.
//   부스 가운데에 사이트 화면(32×18 맵 px = 64×36 그림 px)을 크게 걸어, 도트로나마 어떤 사이트인지 보이게 합니다.
//   움직이지 않는 부분은 사당마다 한 번 그려 두고(화면이 늦게 불러와지면 다시), 초 불꽃 · 불빛만 매번 그립니다.
import { drawGlow, rect } from './pixels.js'

/** 사이트 화면 크기 (그림 px). 맵에서는 32×18. main.js는 shrink(img, ...SCREEN_ART)로 만들어 넘깁니다 */
export const SCREEN_ART = [64, 36]
/** 6글자 소개 이름표를 띄울 자리: plot.y 기준 맵 px (지붕 꼭대기 바로 위, 가운데 = plot.x + 24) */
export const SIGN_Y = -12
/** 그리는 범위: 가운데(plot.x + 24)에서 좌우 26, 바닥(plot.y + 44)에서 위로 60 맵 px */
export const SHRINE_BOX = [26, 60]

/** 그림 캔버스: 왼쪽 위 = (plot.x - 2, plot.y - 12), 크기 52×58 맵 px */
const OX = -2
const OY = -12
const CW = 104
const CH = 116
const LINE = '#120e18'

const cache = new Map()

function canvas() {
  const cv = document.createElement('canvas')
  cv.width = CW
  cv.height = CH
  return cv
}

const hexRgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
function shade(h, n) {
  const f = v => Math.max(0, Math.min(255, Math.round(v + n))).toString(16).padStart(2, '0')
  const [r, g, b] = hexRgb(h)
  return `#${f(r)}${f(g)}${f(b)}`
}

function hash(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619)
  return h >>> 0
}

/** 실루엣 바깥에 1px 어두운 외곽선 (캐릭터와 같은 느낌) */
function outline(c) {
  const img = c.getImageData(0, 0, CW, CH)
  const d = img.data
  const solid = i => d[i * 4 + 3] > 40
  const add = []
  for (let y = 0; y < CH; y++) {
    for (let x = 0; x < CW; x++) {
      const i = y * CW + x
      if (solid(i)) continue
      if ((x > 0 && solid(i - 1)) || (x < CW - 1 && solid(i + 1)) || (y > 0 && solid(i - CW)) || (y < CH - 1 && solid(i + CW))) add.push(i)
    }
  }
  const [r, g, b] = hexRgb(LINE)
  for (const i of add) {
    d[i * 4] = r
    d[i * 4 + 1] = g
    d[i * 4 + 2] = b
    d[i * 4 + 3] = 255
  }
  c.putImageData(img, 0, 0)
}

/* ── 사이트 화면 ── */

/**
 * 사이트 화면 캔버스 만들기 (SCREEN_ART 크기). 그냥 줄이면 흰 바탕 사이트의 가는 글씨 · 버튼이 다 지워지므로,
 * 4배 크기에서 칸마다 평균 색과 가장 눈에 띄는 색(어둡거나 진한 색)을 섞어 글 줄 · 로고 · 버튼이 남게 합니다.
 * 위쪽(머리글 · 로고 쪽)을 기준으로 16:9로 잘라 씁니다.
 */
export function makeScreen(img) {
  const [w, h] = SCREEN_ART
  const K = 4
  const big = document.createElement('canvas')
  big.width = w * K
  big.height = h * K
  const b = big.getContext('2d')
  b.imageSmoothingEnabled = true
  b.imageSmoothingQuality = 'high'
  const iw = img.naturalWidth || img.width
  const ih = img.naturalHeight || img.height
  const scale = Math.max(big.width / iw, big.height / ih)
  b.drawImage(img, 0, 0, big.width / scale, big.height / scale, 0, 0, big.width, big.height)
  const src = b.getImageData(0, 0, big.width, big.height).data
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const o = out.getContext('2d')
  const pic = o.createImageData(w, h)
  const d = pic.data
  const lum = (r, g, bl) => 0.299 * r + 0.587 * g + 0.114 * bl
  const q = v => Math.min(255, Math.round(v / 17) * 17)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let mr = 0
      let mg = 0
      let mb = 0
      for (let j = 0; j < K; j++) {
        for (let i = 0; i < K; i++) {
          const p = ((y * K + j) * big.width + x * K + i) * 4
          mr += src[p]
          mg += src[p + 1]
          mb += src[p + 2]
        }
      }
      mr /= K * K
      mg /= K * K
      mb /= K * K
      const ml = lum(mr, mg, mb)
      let best = -1
      let br = mr
      let bg = mg
      let bb = mb
      for (let j = 0; j < K; j++) {
        for (let i = 0; i < K; i++) {
          const p = ((y * K + j) * big.width + x * K + i) * 4
          const r = src[p]
          const g = src[p + 1]
          const bl = src[p + 2]
          const ink = Math.abs(lum(r, g, bl) - ml) + (Math.max(r, g, bl) - Math.min(r, g, bl)) * 0.6
          if (ink > best) {
            best = ink
            br = r
            bg = g
            bb = bl
          }
        }
      }
      const k = best > 70 ? 0.75 : best > 35 ? 0.45 : 0
      const at = (y * w + x) * 4
      d[at] = q(mr + (br - mr) * k)
      d[at + 1] = q(mg + (bg - mg) * k)
      d[at + 2] = q(mb + (bb - mb) * k)
      d[at + 3] = 255
    }
  }
  o.putImageData(pic, 0, 0)
  out.dataset.pixel = '1'
  return out
}

/** 실제 화면: 대비를 조금 올리고(흰 바탕 사이트도 글 · 버튼이 보이게) 16단계로 색을 눌러 도트 느낌을 살림 */
function paintScreenshot(c, screen, x, y) {
  const [w, h] = SCREEN_ART
  c.drawImage(screen, 0, 0, screen.width, screen.height, x, y, w, h)
  // makeScreen으로 만든 화면은 이미 도트로 정리돼 있어 그대로 씁니다
  if (screen.dataset?.pixel) return
  const img = c.getImageData(x, y, w, h)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const v = Math.max(0, Math.min(1, (d[i + k] / 255 - 0.5) * 1.35 + 0.5)) ** 1.25
      d[i + k] = Math.min(255, Math.round((v * 242) / 17) * 17)
    }
  }
  c.putImageData(img, x, y)
}

/** GitHub 저장소만 있는 사당: 저장소 카드 (잔디 칸은 이름으로 정해져 늘 같음) */
function paintRepoCard(c, s, x, y) {
  const [w, h] = SCREEN_ART
  const R = (a, b, ww, hh, col) => rect(c, x + a, y + b, ww, hh, col)
  R(0, 0, w, h, '#0d1117')
  R(0, 0, w, 5, '#161b22')
  R(2, 2, 1, 1, '#f85149'); R(4, 2, 1, 1, '#d29922'); R(6, 2, 1, 1, '#3fb950')
  R(4, 8, 4, 4, '#8b949e')
  R(10, 8, 22, 2, '#58a6ff'); R(10, 11, 14, 1, '#8b949e')
  R(46, 8, 14, 4, '#21262d'); R(48, 9, 2, 2, '#e3b341'); R(51, 10, 7, 1, '#8b949e')
  const greens = ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353']
  let seed = hash(s.slug || s.domain || 'repo')
  for (let cx = 0; cx < 15; cx++) {
    for (let cy = 0; cy < 5; cy++) {
      seed = Math.imul(seed ^ (seed >>> 15), 2246822519) >>> 0
      const v = seed % 9
      R(3 + cx * 4, 16 + cy * 4, 3, 3, greens[v < 3 ? 0 : v < 5 ? 1 : v < 7 ? 2 : v < 8 ? 3 : 4])
    }
  }
}

/** 화면 없는 사이트: 분류 색으로 만든 흔한 웹 페이지 모양 */
function paintGenericPage(c, s, x, y) {
  const [w, h] = SCREEN_ART
  const hues = ['#3b6fd8', '#2f9e7a', '#d0703a', '#8a5ad0', '#c8484e', '#2a8fb0']
  const accent = hues[hash(s.slug || s.name || '') % hues.length]
  const R = (a, b, ww, hh, col) => rect(c, x + a, y + b, ww, hh, col)
  R(0, 0, w, h, '#e9ecf2')
  R(0, 0, w, 5, '#ffffff')
  R(3, 2, 6, 1, accent)
  for (const a of [40, 47, 54]) R(a, 2, 5, 1, '#9aa3b2')
  R(0, 5, w, 13, shade(accent, -10))
  R(4, 8, 26, 2, '#ffffff'); R(4, 12, 18, 1, '#dfe7ff')
  R(4, 14, 10, 2, '#ffd36b')
  R(40, 7, 20, 9, shade(accent, 40))
  for (let i = 0; i < 3; i++) {
    R(4 + i * 20, 21, 17, 12, '#ffffff')
    R(6 + i * 20, 23, 6, 4, shade(accent, 20 - i * 15))
    R(6 + i * 20, 29, 12, 1, '#b4bccb')
    R(6 + i * 20, 31, 9, 1, '#cfd5e0')
  }
}

/** 점검중: 어두운 화면에 노란 느낌표와 공사 띠 */
function paintCheck(c, x, y) {
  const [w, h] = SCREEN_ART
  rect(c, x, y, w, h, '#2d323d')
  for (let i = -8; i < w; i += 8) {
    for (let k = 0; k < 4; k++) rect(c, x + Math.max(0, i + k), y + h - 6, 1, 6, '#f2c14b')
  }
  rect(c, x, y + h - 7, w, 1, '#1e2129')
  rect(c, x + 30, y + 6, 4, 14, '#f2c14b')
  rect(c, x + 30, y + 23, 4, 4, '#f2c14b')
}

/* ── 장식: 계산대 앞 마루 위 ── */

const DECO = {
  duck(c, x, b) {
    rect(c, x + 1, b - 4, 7, 4, '#f6cf3a'); rect(c, x + 5, b - 7, 4, 4, '#f6cf3a')
    rect(c, x + 9, b - 6, 2, 1, '#f08a24'); rect(c, x + 7, b - 6, 1, 1, '#1b1b1b')
    rect(c, x + 1, b - 4, 7, 1, '#ffe27a'); rect(c, x + 2, b - 1, 6, 1, '#d8a820')
  },
  coffee(c, x, b) {
    rect(c, x + 1, b - 6, 6, 6, '#e9edf3'); rect(c, x + 7, b - 5, 2, 3, '#e9edf3')
    rect(c, x + 1, b - 6, 6, 1, '#5b3a24'); rect(c, x + 6, b - 5, 1, 5, '#b8c0cc')
    rect(c, x + 3, b - 9, 1, 2, '#c7ced9'); rect(c, x + 5, b - 10, 1, 2, '#c7ced9')
  },
  makgeolli(c, x, b) {
    rect(c, x + 2, b - 13, 3, 2, '#1d6a3b'); rect(c, x + 1, b - 11, 5, 11, '#2f9e5a')
    rect(c, x + 1, b - 7, 5, 3, '#eef6ef'); rect(c, x + 5, b - 11, 1, 11, '#247a46')
    rect(c, x + 2, b - 6, 3, 1, '#2f9e5a')
  },
  cat(c, x, b) {
    rect(c, x, b - 5, 11, 5, '#e39b4a'); rect(c, x + 7, b - 8, 5, 4, '#e39b4a')
    rect(c, x + 7, b - 9, 1, 1, '#e39b4a'); rect(c, x + 11, b - 9, 1, 1, '#e39b4a')
    rect(c, x + 9, b - 7, 1, 1, '#1b1b1b'); rect(c, x - 2, b - 3, 2, 1, '#e39b4a')
    rect(c, x + 1, b - 4, 5, 1, '#c97a32'); rect(c, x, b - 1, 11, 1, '#b8692a')
  },
  cactus(c, x, b) {
    rect(c, x + 1, b - 4, 7, 4, '#b5653a'); rect(c, x + 1, b - 4, 7, 1, '#cf7c4c')
    rect(c, x + 3, b - 12, 3, 8, '#3f9a4f'); rect(c, x + 1, b - 10, 2, 1, '#3f9a4f'); rect(c, x + 1, b - 12, 1, 2, '#3f9a4f')
    rect(c, x + 6, b - 9, 2, 1, '#3f9a4f'); rect(c, x + 7, b - 11, 1, 2, '#3f9a4f'); rect(c, x + 4, b - 12, 1, 8, '#5ab868')
  },
}

/* ── 부스 그리기 (그림 px, 캔버스 104×116) ── */

function roofColor(s) {
  if (s.status !== 'live') return '#4a5266'
  return s.keeper ? '#b06a1f' : '#9c3b2a'
}

function paintBooth(c, s, screen) {
  const live = s.status === 'live'
  const roof = roofColor(s)
  const R = (x, y, w, h, col) => rect(c, x, y, w, h, col)

  // 마루 (바닥 판)
  R(6, 98, 92, 4, '#463b56'); R(6, 98, 92, 1, '#5a4d6c')
  R(6, 102, 92, 6, '#2e2639')
  for (let x = 14; x < 98; x += 16) R(x, 102, 1, 6, '#241e2e')
  // 기둥 (나무, 왼쪽이 밝음)
  for (const px of [12, 88]) {
    R(px, 42, 5, 56, '#6b4022')
    R(px, 42, 1, 56, '#8a5a34')
    R(px + 4, 42, 1, 56, '#4e301b')
    R(px - 1, 96, 7, 2, '#4e301b')
  }
  // 뒷벽 · 화면 틀
  R(17, 44, 71, 40, '#1b1724')
  R(18, 44, 68, 40, '#2b303c')
  R(18, 44, 68, 1, '#3d4454')
  R(19, 45, 66, 38, '#11141b')
  const [sw, sh] = SCREEN_ART
  if (!live) paintCheck(c, 20, 46)
  else if (screen) paintScreenshot(c, screen, 20, 46)
  else if (typeof s.domain === 'string' && s.domain.startsWith('github.com/')) paintRepoCard(c, s, 20, 46)
  else paintGenericPage(c, s, 20, 46)
  // 화면 위쪽 빛 반사 한 줄
  c.globalAlpha = 0.18
  R(20, 46, sw, 1, '#ffffff')
  c.globalAlpha = 1
  R(20, 46 + sh, sw, 1, '#0b0d12')
  // 계산대
  R(14, 84, 76, 3, '#c88a4e'); R(14, 84, 76, 1, '#e0a868')
  R(15, 87, 74, 11, '#8a5a34')
  for (let x = 23; x < 88; x += 12) R(x, 87, 1, 11, '#6b4022')
  R(15, 97, 74, 1, '#4e301b')
  // 계산대 앞 천 (기원 색 띠)
  R(40, 88, 24, 7, live ? '#c8282e' : '#5a5f6e'); R(40, 88, 24, 1, live ? '#e04a4e' : '#6e7384')
  R(44, 90, 16, 1, '#f3ead6'); R(46, 92, 12, 1, '#f3ead6')
  // 초 두 자루 (계산대 양끝, 불꽃은 매번 그림)
  // 화면을 가리지 않게 계산대 양 끝(화면 바깥)에 짧게
  for (const cx of [15, 85]) {
    R(cx - 1, 82, 6, 2, '#b48a3a')
    R(cx, 75, 4, 7, live ? '#f3ead6' : '#8a8f9c')
    R(cx + 3, 75, 1, 7, live ? '#d8c8a6' : '#6f788b')
    R(cx + 1, 73, 1, 2, '#3b2a1a')
  }
  // 지붕: 기와 줄 · 들린 처마 · 용마루
  for (let y = 20; y < 40; y++) {
    const half = 30 + Math.floor((y - 20) * 0.95)
    const l = 52 - half
    const r = 52 + half
    const row = (y - 20) % 4 === 3
    for (let x = l; x < r; x++) {
      const tile = (x - l) % 4 === 0
      const lit = x < 52 ? 8 : -6
      R(x, y, 1, 1, row ? shade(roof, -38) : tile ? shade(roof, -20) : shade(roof, lit + (y < 24 ? 10 : 0)))
    }
  }
  R(2, 36, 6, 3, shade(roof, -10)); R(0, 33, 4, 3, shade(roof, 6))
  R(96, 36, 6, 3, shade(roof, -16)); R(100, 33, 4, 3, shade(roof, 0))
  R(26, 16, 52, 4, shade(roof, -44)); R(26, 16, 52, 1, shade(roof, -10))
  R(22, 17, 4, 3, shade(roof, -44)); R(78, 17, 4, 3, shade(roof, -44))
  // 처마 아래 단청 띠
  R(6, 40, 92, 3, '#2a6a5a')
  for (let x = 8; x < 96; x += 6) { R(x, 41, 2, 1, '#e8c04a'); R(x + 3, 41, 1, 1, '#c8282e') }
  R(6, 43, 92, 1, '#161a26')
  // 현판
  R(38, 28, 28, 11, '#8a5a34')
  R(39, 29, 26, 9, live ? '#ecdcb4' : '#b8b2a0')
  for (const x of [43, 49, 55]) { R(x, 31, 4, 1, '#5a3a24'); R(x + 1, 33, 2, 3, '#5a3a24') }
  // 운영자 사당(keeper): 용마루 위 금빛 장식
  if (s.keeper) { R(49, 9, 6, 7, '#f0a64a'); R(50, 8, 4, 1, '#ffd38a'); R(51, 6, 2, 2, '#f0a64a') }
  // 부적: 왼쪽 기둥에 걸린 노란 종이
  if (s.charm) {
    R(11, 50, 7, 15, '#f2d24b'); R(11, 50, 7, 1, '#fff1a0')
    R(13, 53, 3, 1, '#c8282e'); R(14, 55, 1, 5, '#c8282e'); R(13, 61, 3, 1, '#c8282e')
  }
  // 처마 양끝 초롱 (불빛은 매번)
  if (live) {
    for (const lx of [8, 94]) {
      R(lx, 43, 1, 3, '#2a2030')
      R(lx - 2, 46, 5, 1, '#3858a8'); R(lx - 2, 47, 5, 5, '#c83838'); R(lx - 1, 48, 3, 3, '#f08048'); R(lx - 2, 52, 5, 1, '#3858a8')
    }
  }
  // 장식: 마루 앞 양쪽
  const deco = Array.isArray(s.deco) ? s.deco : []
  const slots = [[16, 100], [76, 100], [28, 100], [66, 100]]
  deco.slice(0, 4).forEach((k, i) => DECO[k]?.(c, slots[i][0], slots[i][1]))
  // 입점 첫 주: 돼지머리 고사 (마루 앞 가운데)
  if (s.isNew) {
    R(42, 104, 20, 3, '#7a3b1e')
    R(45, 93, 4, 4, '#e48c8c'); R(55, 93, 4, 4, '#e48c8c')
    R(45, 95, 14, 9, '#f3aaa8'); R(45, 95, 14, 1, '#ffc8c4')
    R(49, 99, 6, 4, '#e48c8c'); R(50, 100, 1, 2, '#8f4545'); R(53, 100, 1, 2, '#8f4545')
    R(47, 97, 3, 1, '#5a2b2b'); R(54, 97, 3, 1, '#5a2b2b')
  }
  outline(c)
}

/** 빈 자리 천막 색 (자리 번호마다 돌아가며) */
const TENTS = [
  ['#93423c', '#6e2e2c'], ['#3b5c8e', '#2a4268'], ['#3a7a5e', '#285a44'], ['#a07a34', '#765a24'], ['#7a4a86', '#583462'],
]

function paintTent(c, [col, colD]) {
  const R = (x, y, w, h, color) => rect(c, x, y, w, h, color)
  const cream = '#c4bba6'
  const creamD = '#968e7c'
  // 마루
  R(10, 92, 84, 4, '#3d3346'); R(10, 92, 84, 1, '#524462')
  R(10, 96, 84, 8, '#2b2434')
  // 천막 안쪽 (뒤 천에 줄무늬가 비침)
  R(14, 48, 76, 44, '#1b1726')
  for (let x = 14; x < 90; x += 12) R(x, 48, 6, 44, '#221d30')
  // 기둥
  R(10, 44, 5, 50, '#5e4836'); R(10, 44, 1, 50, '#76604a')
  R(89, 44, 5, 50, '#46362a')
  // 빈 계산대와 팻말
  R(16, 70, 72, 3, '#9a7a56'); R(16, 70, 72, 1, '#b8946a')
  R(17, 73, 70, 19, '#5a4330')
  for (let x = 27; x < 86; x += 12) R(x, 73, 1, 19, '#4a3626')
  R(36, 76, 32, 12, '#6e624e'); R(37, 77, 30, 10, '#b8ae98'); R(37, 77, 30, 1, '#d0c6b0')
  R(41, 80, 22, 1, '#6e624e'); R(41, 83, 14, 1, '#8a7e68')
  // 줄무늬 천막 지붕: 아래로 갈수록 넓어짐
  for (let y = 0; y < 22; y++) {
    const half = 40 + Math.floor(y / 2)
    for (let x = 52 - half; x < 52 + half; x++) {
      const stripe = Math.floor((x - 52 + 64) / 8) % 2
      const lit = y < 6 ? 0 : y < 15 ? 1 : 2
      R(x, 22 + y, 1, 1, stripe ? [col, col, colD][lit] : [cream, cream, creamD][lit])
    }
  }
  R(14, 20, 76, 2, colD)
  R(50, 14, 4, 6, '#5e4836')
  // 앞 처마 물결
  for (let i = 0; i < 13; i++) {
    const x = 6 + i * 8
    const color = i % 2 ? col : cream
    R(x, 44, 8, 2, color)
    R(x + 2, 46, 4, 2, color)
  }
  outline(c)
}

/* ── 불꽃 (매번) ── */

const FLAME = [
  [[1, 0, 1, 2]],
  [[1, -1, 2, 3], [0, 1, 1, 1]],
  [[0, -2, 3, 4], [1, -3, 1, 1], [3, 0, 1, 1]],
]

function flame(c, mx, my, tier, t, seed) {
  // mx, my: 심지 위 (맵 좌표). 불꽃 모양은 그림 px 단위로 반 칸씩
  const f = Math.floor(t / (330 + seed * 40)) % 2
  const h = [3, 5, 7][tier]
  const w = [2, 3, 4][tier]
  const px = (ax, ay, aw, ah, col) => {
    c.fillStyle = col
    c.fillRect(mx + ax / 2, my + ay / 2, aw / 2, ah / 2)
  }
  px(-w / 2, -h + f, w, h, '#f39a2b')
  px(-w / 2 + 1, -h + 2 + f, Math.max(1, w - 2), h - 2, '#ffcf5a')
  px(-0.5 + (f ? 1 : 0), -h - 1 + f, 1, 1, '#f39a2b')
  if (tier === 2) px(-0.5, -2, 1, 2, '#fff6c8')
}

/**
 * 사당 그리기 (맵 좌표, 캐릭터와 같은 배율 변환 안에서).
 * @param screen shrink(img, ...SCREEN_ART)로 만든 사이트 화면 캔버스 (없으면 저장소 카드나 기본 웹 화면)
 * @param tier 초 밝기 0 · 1 · 2
 */
export function drawShrineHD(c, plot, s, tier, t, screen) {
  const key = `s|${s.slug}|${s.status}|${s.keeper ? 1 : 0}|${s.isNew ? 1 : 0}|${s.charm ? 1 : 0}|${(s.deco ?? []).join(',')}|${s.domain}|${screen ? 1 : 0}`
  let cv = cache.get(key)
  if (!cv) {
    cv = canvas()
    paintBooth(cv.getContext('2d'), s, screen)
    cache.set(key, cv)
  }
  const x0 = plot.x + OX
  const y0 = plot.y + OY
  c.fillStyle = 'rgba(0,0,0,.3)'
  c.fillRect(plot.x + 2, plot.y + 42, 44, 3)
  c.drawImage(cv, x0, y0, CW / 2, CH / 2)
  const live = s.status === 'live'
  // 화면이 내는 은은한 빛
  if (live) drawGlow(c, plot.x + 24, plot.y + 20, 16, '#bcd8ff', 0.35)
  // 초 불꽃: 심지 위 (그림 x 16 · 86, y 73 → 맵)
  if (live) {
    for (const [ax, seed] of [[16.5, 0], [86.5, 1]]) {
      const mx = x0 + ax / 2
      const my = y0 + 73 / 2
      drawGlow(c, mx, my - 2, 6 + tier * 3, '#ffb347', 0.75 + tier * 0.1)
      flame(c, mx, my, tier, t, seed)
    }
    // 처마 초롱 깜빡임
    for (const ax of [8, 94]) drawGlow(c, x0 + ax / 2, y0 + 49 / 2, 5, '#ffb347', 0.6 + (Math.floor(t / 260 + ax) % 3) * 0.12)
  }
}

/** 빈 자리: 줄무늬 천막만 쳐 두고 아직 문을 열지 않은 부스 */
export function drawEmptyHD(c, plot, t) {
  const v = plot.id % TENTS.length
  const key = `e|${v}`
  let cv = cache.get(key)
  if (!cv) {
    cv = canvas()
    paintTent(cv.getContext('2d'), TENTS[v])
    cache.set(key, cv)
  }
  c.fillStyle = 'rgba(0,0,0,.25)'
  c.fillRect(plot.x + 2, plot.y + 40, 44, 3)
  c.drawImage(cv, plot.x + OX, plot.y + OY, CW / 2, CH / 2)
}
