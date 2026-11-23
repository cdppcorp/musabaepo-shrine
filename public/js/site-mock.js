// 사당 창의 "이미지 없는" 서비스 화면.
//   화면 이미지를 올리지 않았거나 불러오지 못한 사당도 사당 창 브라우저 틀 안에 화면이 보이게, 작은 웹 페이지를 도트로 그립니다.
//   그림은 96×54(16:9) 캔버스에 그려 CSS가 image-rendering: pixelated로 키우고, 이름 같은 글자는 캔버스 위에 HTML로 얹어
//   어느 화면에서나 또렷하게 둡니다. 맵 부스 화면(shrine-art.js의 기본 웹 화면 · 저장소 카드)과 같은 색 · 같은 짜임이라
//   맵에서 본 화면을 가까이서 보는 느낌이 납니다. 모양은 사당 slug로 정해져 늘 같고, 사당마다 조금씩 다릅니다.
// 글자는 textContent로만 넣습니다 (HTML 문자열 금지).
import { rect } from './pixels.js'
import { hash, repoCells, shade, siteAccent } from './shrine-art.js'

const W = 96
const H = 54
/** 그림 px → 상자 너비 기준 길이. 상자가 container라 1cqw = 상자 너비의 1%, 캔버스도 너비에 맞춰 늘어납니다 */
const cq = u => `${+(u * 100 / W).toFixed(3)}cqw`

/** 분류 아이콘 7×7 ('#' = 칠함). 머리글 로고(1배) · 첫 화면 그림(2배)에 씁니다 */
const ICONS = {
  business: ['.......', '.....#.', '.....#.', '...#.#.', '.#.#.#.', '.#.#.#.', '#######'],
  productivity: ['.......', '......#', '.....##', '#...##.', '##.##..', '.###...', '..#....'],
  commerce: ['..###..', '.#...#.', '#######', '#######', '#######', '#######', '.#####.'],
  education: ['...#...', '.#####.', '#######', '.#####.', '..###.#', '..###.#', '......#'],
  devtools: ['#......', '.#.....', '..#....', '.#.....', '#......', '.......', '...####'],
  content: ['.#####.', '##.####', '##..###', '##...##', '##..###', '##.####', '.#####.'],
  life: ['.##.##.', '#######', '#######', '#######', '.#####.', '..###..', '...#...'],
  etc: ['...#...', '...#...', '..###..', '#######', '..###..', '...#...', '...#...'],
  dot: ['..###..', '.#####.', '#######', '#######', '#######', '.#####.', '..###..'],
}

function icon(c, key, x, y, k, color) {
  const rows = ICONS[key] ?? ICONS.etc
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) if (row[i] === '#') rect(c, x + i * k, y + j * k, k, k, color)
  })
}

/** 늘 같은 순서로 나오는 0~1 난수 (사당마다 배치를 조금씩 다르게) */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), a | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 그림 좌표(x, y, w, h)에 글자 한 칸을 얹습니다. 글자 크기는 상자 너비를 따라가되 min px 아래로는 줄이지 않습니다.
 * 한 줄 칸은 줄 높이 = 칸 높이로 세로 가운데, 넘치면 … (CSS)
 */
function label(box, cls, text, [x, y, w, h], size, min, oneLine = true) {
  const t = document.createElement('span')
  t.className = cls
  t.textContent = text
  t.style.left = cq(x)
  t.style.top = cq(y)
  t.style.width = cq(w)
  t.style.height = cq(h)
  t.style.fontSize = `max(${min}px, ${cq(size)})`
  if (oneLine) t.style.lineHeight = cq(h)
  box.append(t)
}

/** 흔한 웹 페이지: 머리글(로고 · 이름 · 메뉴) → 분류 색 첫 화면(제목 · 단추 · 그림) → 카드 */
function paintPage(c, box, s) {
  const r = rng(hash(`${s.slug || s.name || ''}|mock`))
  const accent = siteAccent(s)
  const hero = shade(accent, -18)
  const flip = r() < 0.5
  const links = r() < 0.5 ? 2 : 3
  const cards = r() < 0.6 ? 3 : 2
  const cta = r() < 0.65 ? ['#ffd36b', '#d9a63a', '#8a5a14'] : ['#ffffff', '#cfd5e0', shade(accent, -30)]
  const R = (x, y, w, h, col) => rect(c, x, y, w, h, col)
  R(0, 0, W, H, '#e9ecf2')
  // 머리글
  R(0, 0, W, 9, '#ffffff')
  R(0, 9, W, 1, '#d7dce5')
  icon(c, s.category, 3, 1, 1, accent)
  for (let i = 0; i < links; i++) R(72 - i * 9, 4, 6, 1, '#9aa3b2')
  R(81, 2, 12, 5, accent)
  R(84, 4, 6, 1, '#ffffff')
  // 첫 화면: 글은 한쪽, 분류 그림은 다른 쪽
  R(0, 10, W, 24, hero)
  const tx = flip ? 41 : 5
  const ax = flip ? 5 : 60
  R(tx, 24, 30, 1, '#dfe7ff')
  R(tx, 26, 20, 1, '#dfe7ff')
  R(tx, 28, 16, 4, cta[0])
  R(tx, 31, 16, 1, cta[1])
  R(tx + 3, 29, 10, 1, cta[2])
  R(ax, 12, 31, 19, shade(accent, 40))
  R(ax, 30, 31, 1, shade(accent, 18))
  icon(c, s.category, ax + 8, 14, 2, hero)
  // 카드 (세 장 또는 넓은 두 장)
  if (cards === 3) {
    for (let i = 0; i < 3; i++) {
      const x = 4 + i * 31
      R(x, 36, 26, 16, '#ffffff')
      R(x + 2, 38, 22, 7, shade(accent, 30 - i * 14))
      R(x + 2, 47, 18, 1, '#b4bccb')
      R(x + 2, 49, 13, 1, '#cfd5e0')
    }
  } else {
    for (let i = 0; i < 2; i++) {
      const x = 4 + i * 46
      R(x, 36, 42, 16, '#ffffff')
      R(x + 2, 38, 12, 12, shade(accent, 30 - i * 20))
      R(x + 17, 40, 20, 1, '#b4bccb')
      R(x + 17, 43, 16, 1, '#cfd5e0')
      R(x + 17, 46, 22, 1, '#cfd5e0')
    }
  }
  const brandEnd = 72 - (links - 1) * 9 - 3
  label(box, 'mock-brand', s.name, [12, 0, brandEnd - 12, 9], 3.3, 10)
  label(box, 'mock-head', s.sign || s.name, [tx, 12, flip ? 51 : 52, 11], 4.4, 12, false)
}

/** GitHub 저장소만 있는 사당: 저장소 화면 (잔디 칸은 맵 저장소 카드와 같은 무늬를 넓게) */
function paintRepo(c, box, s) {
  const R = (x, y, w, h, col) => rect(c, x, y, w, h, col)
  R(0, 0, W, H, '#0d1117')
  // 머리글: 로고 · 검색 칸 · 알림 · 프로필
  R(0, 0, W, 9, '#161b22')
  R(0, 9, W, 1, '#30363d')
  icon(c, 'dot', 3, 1, 1, '#e6edf3')
  R(13, 2, 34, 5, '#21262d')
  R(15, 4, 12, 1, '#6e7681')
  R(80, 3, 3, 3, '#6e7681')
  R(86, 2, 6, 6, siteAccent(s))
  // 저장소 이름 줄: 책 아이콘 · 이름 · 별 단추
  R(4, 12, 4, 6, '#8b949e')
  R(5, 13, 2, 4, '#0d1117')
  R(77, 11, 15, 7, '#21262d')
  R(77, 11, 15, 1, '#30363d')
  R(80, 13, 1, 3, '#e3b341')
  R(79, 14, 3, 1, '#e3b341')
  R(84, 14, 6, 1, '#8b949e')
  // 탭
  R(4, 23, 10, 1, '#e6edf3')
  R(20, 23, 10, 1, '#8b949e')
  R(36, 23, 10, 1, '#8b949e')
  R(3, 26, 12, 1, '#f78166')
  R(0, 27, W, 1, '#21262d')
  // 잔디
  R(4, 30, 26, 1, '#8b949e')
  repoCells(s, 22).forEach((col, cx) => col.forEach((g, cy) => R(4 + cx * 4, 33 + cy * 4, 3, 3, g)))
  const path = s.domain.slice('github.com/'.length).split('/').filter(Boolean).join(' / ')
  label(box, 'mock-repo', path || s.name, [11, 10, 64, 9], 3.6, 10)
}

/**
 * 이미지 없는 사당 화면 (figure.shot 안, 브라우저 틀 아래에 넣습니다).
 * 상자는 .shot img와 같은 16:9 · 같은 높이 상한이라, 낮은 화면에서는 위쪽(머리글 · 첫 화면)부터 보이게 아래가 잘립니다.
 */
export function siteMock(s) {
  const repo = typeof s.domain === 'string' && s.domain.startsWith('github.com/')
  const box = document.createElement('div')
  box.className = repo ? 'shot-mock repo' : 'shot-mock'
  box.setAttribute('role', 'img')
  box.setAttribute('aria-label', `${s.name} 화면 (이미지 없음)`)
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  box.append(cv)
  const c = cv.getContext('2d')
  if (repo) paintRepo(c, box, s)
  else paintPage(c, box, s)
  return box
}
