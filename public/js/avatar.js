// 캐릭터 꾸미기 (도트) · 합성기.
// 사용자가 직접 그려 확정한 캐릭터(17×33, 맵 1px = 도트 1칸)를 기준으로, 부위별 도트 그림을 겹쳐 그립니다.
//   몸 · 옷 · 동작: avatar-body.js · 머리카락 · 소품: avatar-hair.js · 얼굴 · 눈 · 종족: avatar-face.js · 색표: avatar-colors.js
// 도트 그림은 글자(재료 키)로 되어 있고, 고른 색(look)에 따라 키마다 색을 입힙니다 (avatar-colors.js 참고).
// 한 장면은 24×40 캔버스, 발 아랫줄 y 37 · 몸 가운데 x 11. 방향 0 아래 · 1 위 · 2 왼쪽(오른쪽을 뒤집음) · 3 오른쪽.
// 부위 순서와 개수는 서버 server/world.ts의 LOOK_SIZES와 같아야 합니다.
import * as COL from './avatar-colors.js'
import * as BODYM from './avatar-body.js'
import * as HAIRM from './avatar-hair.js'
import * as FACEM from './avatar-face.js'

/* ══════════ 선택지 (서버 LOOK_SIZES와 같은 순서 · 개수) ══════════ */

const named = list => list.map(([name, color]) => ({ name, color }))
const names = list => list.map(name => ({ name }))
const skinOpts = sp => COL.SKIN[sp].map(([name, d]) => ({ name, color: d }))
const tone = (list, k) => list.map(([name, t]) => ({ name, color: t ? t[k] : '#e0c8b0' }))

export const PARTS = [
  { key: 'species', label: '종족', kind: 'cycle', options: names(COL.SPECIES_NAMES) },
  { key: 'body', label: '몸 색', kind: 'swatch', options: skinOpts('human'), dynamic: look => skinOpts(COL.SPECIES_KEYS[look[0]] ?? 'human') },
  { key: 'eyes', label: '눈', kind: 'cycle', options: names(['기본', '반짝 눈', '웃는 눈', '졸린 눈', '점 눈', '고양이 눈']) },
  { key: 'eyeColor', label: '눈 색', kind: 'swatch', options: named(COL.EYES) },
  { key: 'hair', label: '머리 모양', kind: 'cycle', options: names(['짧은 머리', '가르마', '투블럭', '덥수룩', '바가지', '뻗친 머리', '곱슬', '아프로',
    '모히칸', '긴 생머리', '웨이브 장발', '포니테일', '양갈래', '단발', '똥머리', '민머리']) },
  { key: 'hairColor', label: '머리 색', kind: 'swatch', options: tone(COL.HAIR, 2) },
  { key: 'top', label: '상의', kind: 'cycle', options: names(['티셔츠', '후드티', '셔츠와 넥타이', '줄무늬 티', '체크 남방', '정장', '조끼', '스웨터', '코딩 티']) },
  { key: 'topColor', label: '상의 색', kind: 'swatch', options: tone(COL.TOP, 1) },
  { key: 'bottom', label: '하의', kind: 'cycle', options: names(['청바지', '반바지', '면바지', '치마', '트레이닝 바지']) },
  { key: 'bottomColor', label: '하의 색', kind: 'swatch', options: tone(COL.BOTTOM, 1) },
  { key: 'shoes', label: '신발', kind: 'cycle', options: names(COL.SHOES.map(s => s[0])) },
  { key: 'acc', label: '소품', kind: 'cycle', options: names(['없음', '안경', '선글라스', '헤드셋', '비니', '야구 모자', '리본', '러버덕 모자', '안전모', '꽃 핀']) },
]
export const LOOK_SIZES = PARTS.map(p => p.options.length)
/** 기본 모습 = 사용자가 확정한 시안 (흑갈색 가르마 · 주황 후드티 · 청바지 · 검정 구두) */
export const DEFAULT_LOOK = [0, 1, 0, 0, 1, 1, 1, 2, 0, 0, 1, 0]
export const optionsOf = (i, look) => (PARTS[i].dynamic ? PARTS[i].dynamic(look) : PARTS[i].options)
export const validLook = v =>
  Array.isArray(v) && v.length === PARTS.length && v.every((n, i) => Number.isInteger(n) && n >= 0 && n < LOOK_SIZES[i])
export const randomLook = () => LOOK_SIZES.map(n => Math.floor(Math.random() * n))

/* ══════════ 합성 ══════════ */

const W = 24
const H = 40
/** 발 기준점: 캔버스 x 11 칸 가운데 · 발 아랫줄 y 37 */
const FOOT_X = 11
const FOOT_Y = 37
const EMPTY = () => Array.from({ length: H }, () => '.'.repeat(W))
const FIXED = { ...(BODYM.FIXED ?? {}), ...(HAIRM.FIXED ?? {}), ...(FACEM.FIXED ?? {}) }

/** 글자 격자 b 위에 over를 덮기 ('.'은 그대로). dx, dy만큼 옮겨서 */
function stamp(buf, over, dx = 0, dy = 0, clipY = -1) {
  if (!over) return
  for (let y = 0; y < over.length; y++) {
    const ty = y + dy
    if (ty < 0 || ty >= H || y < clipY) continue
    const row = over[y]
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]
      if (ch === '.' || ch === ' ') continue
      const tx = x + dx
      if (tx < 0 || tx >= W) continue
      buf[ty][tx] = ch
    }
  }
}
const toBuf = rows => (rows ?? EMPTY()).map(r => [...r.padEnd(W, '.')])
const toRows = buf => buf.map(r => r.join(''))

const DIR_KEY = ['front', 'back', 'side', 'side']
const WALK = ['idle', 'walkA', 'idle', 'walkB', 'idle']

/** 몸 + 옷 한 장 (서 있는 자세 key) */
function dressed(look, dir, key) {
  const body = BODYM.BODY[dir]?.[key] ?? BODYM.BODY[dir]?.idle ?? EMPTY()
  const buf = toBuf(body)
  // 신발 다음에 하의: 긴 바지 밑단이 신발 윗줄을 덮도록
  stamp(buf, BODYM.shoeLayer?.(look[10], dir, key, body))
  stamp(buf, BODYM.bottomLayer?.(look[8], dir, key, body))
  stamp(buf, BODYM.topLayer?.(look[6], dir, key, body))
  return buf
}

/** 앉은 자세: 위(목~허리)는 그 동작의 서 있는 그림을 SIT.dy만큼 내리고, 아래는 앉은 다리 그림 */
function seatedBody(look, dir, poseKey, seat) {
  const S = BODYM.SIT?.[seat] ?? { dy: 0, waist: 28 }
  const upper = dressed(look, dir, poseKey)
  const lower = dressed(look, dir, seat)
  const out = EMPTY().map(r => [...r])
  for (let y = 0; y < H; y++) {
    if (y <= S.waist + S.dy) {
      const src = y - S.dy
      if (src >= 0) out[y] = upper[src].slice()
    } else out[y] = lower[y].slice()
  }
  return out
}

function headOffset(dir, key, seat) {
  const o = BODYM.HEAD?.[dir]?.[key] ?? [0, 0]
  const sdy = seat ? (BODYM.SIT?.[seat]?.dy ?? 0) : 0
  return [o[0], o[1] + sdy]
}

/** 한 장면의 글자 격자 (오른쪽을 보는 옆모습 기준; 왼쪽은 그릴 때 뒤집음) */
export function composeRows(look, dirN, frame, pose, seat = '') {
  const dir = DIR_KEY[dirN] ?? 'front'
  const key = pose || WALK[frame] || 'idle'
  const sp = COL.SPECIES_KEYS[look[0]] ?? 'human'
  const body = seat ? seatedBody(look, dir, pose || 'idle', seat) : dressed(look, dir, key)
  const [hx, hy] = headOffset(dir, seat ? (pose || 'idle') : key, seat)
  const hair = HAIRM.HAIR?.[look[4]]?.[dir]
  const acc = HAIRM.ACC?.[look[11]]?.[dir]
  const clip = HAIRM.HAT_CLIP?.[look[11]] ?? -1
  const buf = EMPTY().map(r => [...r])
  const tail = FACEM.TAIL?.[sp]?.[dir]
  // 꼬리는 몸에 붙어 있어 걷기 출렁임 · 앉기만 따라갑니다 (절할 때 머리처럼 내려가지 않게)
  const walkBob = !pose && (key === 'walkA' || key === 'walkB') ? (BODYM.HEAD?.[dir]?.[key] ?? [0, 0]) : [0, 0]
  const tx = walkBob[0], ty = walkBob[1] + (seat ? (BODYM.SIT?.[seat]?.dy ?? 0) : 0)
  stamp(buf, hair?.under, hx, hy, clip ?? -1)
  if (dir !== 'back') stamp(buf, tail, tx, ty)
  // 몸 덮개의 '_'는 '지움' 표시 (맨다리 · 맨발을 가늘게): 몸 칸으로 옮기지 않아 꼬리 · 뒷머리가 그대로 보임
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (body[y][x] !== '.' && body[y][x] !== '_') buf[y][x] = body[y][x]
  if (dir === 'back') stamp(buf, tail, tx, ty)
  // 머리 바탕: 머리카락 바로 옆 칸에만 그늘을 넣는 headBase (민머리 · 모히칸에서 이마 선이 생기지 않게)
  stamp(buf, FACEM.headBase?.(sp, dir, hair?.over) ?? FACEM.HEAD_BASE?.[sp]?.[dir], hx, hy)
  if (dir !== 'back') stamp(buf, FACEM.face?.(sp, look[2], dir), hx, hy)
  stamp(buf, FACEM.EXTRA?.[sp]?.[dir], hx, hy)
  stamp(buf, hair?.over, hx, hy, clip ?? -1)
  // 머리카락 위에 와야 하는 종족 부위 (강아지 늘어진 귀 · 고양이 수염)
  stamp(buf, FACEM.EXTRA_OVER?.[sp]?.[dir], hx, hy)
  stamp(buf, acc, hx, hy)
  // 머리 위로 다시 그릴 팔 칸 (입에 댄 손 · 머리 옆으로 든 팔): OVER에 표시된 자리는 몸 그림으로 덮음
  const ov = BODYM.OVER?.[dir]?.[seat ? (pose || 'idle') : key]
  const sdy = seat ? (BODYM.SIT?.[seat]?.dy ?? 0) : 0
  if (ov) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (ov[y]?.[x] && ov[y][x] !== '.' && y + sdy < H) {
      const ch = body[y + sdy][x]
      if (ch !== '.' && ch !== '_') buf[y + sdy][x] = ch
    }
  }
  return toRows(buf)
}

const cache = new Map()
/** 한 장면 캔버스 (24×40). frame: 0 서기 · 1~4 걷기, pose: '' · bow · wave0/1 · kiss0/1 · smoke0/1, seat: '' · chair · floor */
export function getSprite(look, dirN, frame, pose, seat = '') {
  const k = `${look.join('.')}|${dirN}|${frame}|${pose}|${seat}`
  const hit = cache.get(k)
  if (hit) return hit
  if (cache.size > 1500) cache.clear()
  const rows = composeRows(look, dirN, frame, pose, seat)
  const pal = { ...FIXED, ...COL.paletteOf(look) }
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const c = cv.getContext('2d')
  const img = c.createImageData(W, H)
  const flip = dirN === 2
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ch = rows[y][flip ? W - 1 - x : x]
      const hex = ch === '.' ? null : pal[ch]
      if (!hex) continue
      const i = (y * W + x) * 4
      img.data[i] = parseInt(hex.slice(1, 3), 16)
      img.data[i + 1] = parseInt(hex.slice(3, 5), 16)
      img.data[i + 2] = parseInt(hex.slice(5, 7), 16)
      img.data[i + 3] = 255
    }
  }
  c.putImageData(img, 0, 0)
  cache.set(k, cv)
  return cv
}

/* ══════════ 동작 · 앉기 · 그리기 (main.js가 쓰는 것) ══════════ */

/** 동작 길이(초). 화면은 동작을 받으면 p.bow · p.wave · p.jump · p.spin · p.kiss · p.smoke에 이 값을 넣고 줄여 갑니다 */
export const EMOTE_TIME = { bow: 1.1, wave: 1.6, jump: 0.7, spin: 0.9, kiss: 1.2, smoke: 6 }
/** 빙글: 아래 → 오른쪽 → 위 → 왼쪽 */
const SPIN = [0, 3, 1, 2]

/** 지금 자세. 절 > 뽀뽀 > 담배 > 손 흔들기 */
function poseOf(p, t) {
  if (p.bow > 0) return 'bow'
  if (p.kiss > 0) return EMOTE_TIME.kiss - p.kiss < 0.5 ? 'kiss0' : 'kiss1'
  if (p.smoke > 0) return (EMOTE_TIME.smoke - p.smoke) % 2 < 0.8 ? 'smoke0' : 'smoke1'
  if (p.wave > 0) return Math.floor(t / 160) % 2 ? 'wave1' : 'wave0'
  return ''
}

/** 깡충 높이 (맵 px). 앉아 있으면 0 */
function hopOf(p) {
  if (p.seated || !(p.jump > 0)) return 0
  return Math.round(Math.abs(Math.sin(((EMOTE_TIME.jump - p.jump) / EMOTE_TIME.jump) * Math.PI * 2)) * 6)
}

/** 앉았을 때 그림을 세로로 옮기는 양: 엉덩이 줄(SIT.seatRow)이 앉는 면(발 기준 y - seatH)에 닿게 */
function seatShift(seated, seatH) {
  if (!seated) return 0
  const h = Math.max(0, seatH ?? 0)
  const S = BODYM.SIT?.[h > 0 ? 'chair' : 'floor']
  const row = S?.seatRow ?? FOOT_Y
  return FOOT_Y - row - h
}

/** 캔버스 좌표 (X, Y) → 발 기준점에서의 맵 거리. 왼쪽(2)은 좌우를 뒤집음 */
function offsetOf(X, Y, dirN) {
  const x = dirN === 2 ? W - 1 - X : X
  return { dx: x - footX(dirN), dy: Y + 0.5 - (FOOT_Y + 1) }
}
/** 뒤집은 그림(왼쪽)은 몸 가운데 칸이 24-1-11 = 12번 칸이 됩니다 */
const footX = dirN => (dirN === 2 ? W - 1 - FOOT_X : FOOT_X)

/** 입 위치: 발 기준점(앉았으면 의자 바닥 가운데)에서의 맵 거리 { dx, dy }. 연기를 뿜는 곳 */
export function mouthOffset(dirN, seated = false, seatH = 0) {
  const dir = DIR_KEY[dirN] ?? 'front'
  const [X, Y] = BODYM.ANCHOR?.mouth?.[dir] ?? [11, 16]
  const sdy = seated ? (BODYM.SIT?.[(seatH ?? 0) > 0 ? 'chair' : 'floor']?.dy ?? 0) : 0
  const o = offsetOf(X, Y + sdy, dirN)
  return { dx: o.dx, dy: o.dy + seatShift(seated, seatH) }
}

/** 담배 끝(불씨) 맵 좌표 { x, y }. 담배를 들고 있지 않으면 입 위치 */
export function smokeTip(p) {
  const pose = poseOf(p, 0)
  const dirN = p.d ?? 0
  const dir = DIR_KEY[dirN] ?? 'front'
  const seat = p.seated ? ((p.seatH ?? 0) > 0 ? 'chair' : 'floor') : ''
  const sdy = seat ? (BODYM.SIT?.[seat]?.dy ?? 0) : 0
  const tip = (pose === 'smoke0' || pose === 'smoke1') ? BODYM.ANCHOR?.ember?.[dir]?.[pose] : null
  const [X, Y] = tip ?? BODYM.ANCHOR?.mouth?.[dir] ?? [11, 16]
  const o = offsetOf(X, Y + sdy, dirN)
  return { x: Math.round(p.x) + o.dx, y: Math.round(p.y) + o.dy + seatShift(p.seated, p.seatH) - hopOf(p) }
}

/** 머리 꼭대기 높이 (발에서 위로 맵 px): 이름표 · 말풍선 자리 */
export function headTop(p) {
  const top = 5
  if (!p.seated) return FOOT_Y + 1 - top
  // 앉으면 머리가 SIT.dy만큼 내려가고, 그림 전체가 seatShift만큼 옮겨집니다
  const dy = BODYM.SIT?.[(p.seatH ?? 0) > 0 ? 'chair' : 'floor']?.dy ?? 0
  return FOOT_Y + 1 - top - dy - seatShift(true, p.seatH)
}

/**
 * 맵에 캐릭터 하나 그리기. p: { x, y(발), d, moving, step, bow, wave, jump, spin, kiss, smoke, seated, seatH }
 * seated면 (x, y)는 의자 바닥 가운데, seatH는 앉는 면 높이(맵 px, 0이면 바닥 책상다리). 앉아 있으면 깡충 · 빙글은 무시.
 * 맵 1px = 도트 1칸, 24×40 그대로 그립니다.
 */
export function drawAvatar(c, p, look, t) {
  const spinning = p.spin > 0
  const frame = p.moving && !spinning ? 1 + (Math.floor(p.step) % 4) : 0
  const pose = poseOf(p, t)
  const x = Math.round(p.x)
  const y = Math.round(p.y)
  if (p.seated) {
    const seatH = Math.max(0, p.seatH ?? 0)
    const seat = seatH > 0 ? 'chair' : 'floor'
    if (seat === 'floor') {
      c.fillStyle = 'rgba(0,0,0,.2)'
      c.fillRect(x - 7, y - 1, 14, 2)
    }
    c.drawImage(getSprite(look, p.d ?? 0, 0, pose, seat), x - footX(p.d ?? 0), y - FOOT_Y - 1 + seatShift(true, seatH), W, H)
    return
  }
  const dir = spinning ? SPIN[Math.floor((EMOTE_TIME.spin - p.spin) * 9) % 4] : (p.d ?? 0)
  const hop = hopOf(p)
  const sw = hop > 3 ? 10 : 12
  c.fillStyle = 'rgba(0,0,0,.26)'
  c.fillRect(x - sw / 2, y - 1, sw, 2)
  c.fillRect(x - sw / 2 + 1, y + 1, sw - 2, 1)
  c.drawImage(getSprite(look, dir, pose ? 0 : frame, pose), x - footX(dir), y - FOOT_Y - 1 - hop, W, H)
}

/** 시험용: 부위 그림이 다 있는지 (문제 없으면 빈 배열) */
export function checkTemplates() {
  const bad = []
  for (const d of ['front', 'back', 'side']) {
    for (const k of ['idle', 'walkA', 'walkB', 'bow', 'wave0', 'wave1', 'kiss0', 'kiss1', 'smoke0', 'smoke1', 'chair', 'floor']) {
      const g = BODYM.BODY?.[d]?.[k]
      if (!g || g.length !== H || g.some(r => r.length !== W)) bad.push(`body.${d}.${k}`)
    }
  }
  if ((HAIRM.HAIR?.length ?? 0) !== LOOK_SIZES[4]) bad.push('hair.length')
  if ((HAIRM.ACC?.length ?? 0) !== LOOK_SIZES[11]) bad.push('acc.length')
  for (const sp of COL.SPECIES_KEYS) if (!FACEM.HEAD_BASE?.[sp]) bad.push(`head.${sp}`)
  return bad
}
