// 얼굴 · 종족 도트 (24×40, 확정 시안 v8 기준). 머리 바탕(맨머리 살) · 눈 · 볼 · 입 · 종족 덧그림 · 꼬리.
// 좌표: 발 아랫줄 y 37 · 몸 가운데 x 11. 머리는 서 있는 자세 기준으로 그리고, 합성기가 HEAD[dir][frame]만큼 옮깁니다.
// 키: 피부 d 바탕 · c 그늘 · h 깊은 그늘 · f 볼 · g 입 / 눈 e 눈동자 · y 눈 색 · w 눈 빛 / 고정색 Q–Z (FIXED)
// 머리 바탕은 맨머리(HEAD_BASE_BALD) + 머리카락 가장자리 그늘(HAIRLINE). headBase(sp, dir, 머리 over)가 머리카락 바로 옆 칸에만 그늘을 넣고,
// HEAD_BASE는 가르마용으로 그늘을 다 넣은 것. 어느 쪽이든 가르마(a z b x 칸)를 덮으면 확정 시안과 한 칸도 다르지 않습니다.
// 얼굴 창(가르마 기준, 맨살이 보이는 칸): 10줄 x10–12 · 11줄 x8–13 · 12줄 x7–14 · 13–16줄 x6–15 · 17줄 x7–15 · 18줄 x9–13,
// 귀 13–14줄 x4 · x17–18. 모든 종족이 이 창을 빈틈없이 채웁니다 (어떤 머리를 얹어도 구멍이 나지 않게).

const W = 24
const H = 40
const blank = () => Array.from({ length: H }, () => Array(W).fill('.'))
const out = g => g.map(r => r.join(''))
/** 격자 g의 (x0, y0)에 작은 그림을 찍음 ('.'은 건너뜀) */
function put(g, x0, y0, lines) {
  lines.forEach((line, dy) => [...line].forEach((ch, dx) => {
    const x = x0 + dx, y = y0 + dy
    if (ch !== '.' && x >= 0 && x < W && y >= 0 && y < H) g[y][x] = ch
  }))
  return g
}
/** 0줄부터 적은 줄들 → 24×40 */
const sheet = lines => out(put(blank(), 0, 0, lines))
/** 여러 조각 [x, y, lines]을 한 장에 */
const pieces = list => (list ? out(list.reduce((g, [x, y, l]) => put(g, x, y, l), blank())) : null)
/** 두 장 겹치기 (b가 위) */
const over = (a, b) => out(put(a.map(r => [...r]), 0, 0, b))

/* ══════════ 고정색 (종족 · 얼굴 모듈 몫 Q–Z) ══════════ */
export const FIXED = {
  Q: '#f39a3c', // 부리 · 빛 (볼터치 분홍과 구분되게 진한 주황)
  R: '#c4652a', // 부리 · 아랫부분
  S: '#f1e8da', // 고양이 수염 (머리카락 위에서도 보이게 밝게)
  T: '#3e2c28', // 강아지 코
  U: '#ec9ea2', // 고양이 코 · 귀 속
  V: '#353c48', // 로봇 얼굴 화면(바이저)
  W: '#a6e8d6', // 로봇 눈 빛
  X: '#f6dc8c', // 외계인 더듬이 구슬
  Y: '#e47a64', // 로봇 안테나 불
  Z: '#4c5664', // 로봇 화면 테두리 빛 · 나사
}

/* ══════════ 머리 바탕 (맨머리 살) ══════════ */
// 사람 앞(맨머리): 윤곽 x5–16 · 귀 x3–4 / x17–18 (13–15줄), 귀 뒤 주름 h. 오른쪽 · 아래가 한 단계 어둡게.
const BALD_FRONT = sheet([
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........dddddc..........',
  '......ddddddddcc........',
  '.....ddddddddddcc.......',
  '.....dddddddddddc.......',
  '.....dddddddddddc.......',
  '.....dddddddddddc.......',
  '.....ddddddddddcc.......',
  '...cchdddddddddchcc.....',
  '...cchdddddddddchcc.....',
  '....ccdddddddddccc......',
  '......cddddddddc........',
  '.......cdddddddc........',
  '.........ccccc..........',
])
// 사람 옆(맨머리, 오른쪽 보기): 뒤통수 x4 · 이마 x18, 귀 x9–11 (12–15줄). 코 튀어나옴 없음, 턱 끝은 다듬음.
const BALD_SIDE = sheet([
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '.........ddddc..........',
  '.......ddddddddc........',
  '......ddddddddddc.......',
  '.....ddddddddddddc......',
  '.....dddddddddddddc.....',
  '....ddddddddddddddc.....',
  '....ddddddccddddddc.....',
  '....dddddcdcddddddc.....',
  '....dddddchcddddddc.....',
  '....cdddddccddddddc.....',
  '.....cddddddcdddddc.....',
  '......cdddddcccccc......',
  '........ccccccccc.......',
])
// 머리카락 가장자리 그늘: 머리카락 바로 옆 맨살 칸만 c (가르마 얼굴 창의 가장자리). 가르마에서는 모든 칸이 머리카락 옆이라 시안 그대로.
const HAIRLINE = {
  front: [[10, 10], [12, 10], [8, 11], [13, 11], [7, 12], [14, 12], [6, 13], [6, 14], [6, 15]],
  side: [[16, 10], [14, 11], [13, 12]],
  back: [],
}
const withLine = (rows, dir) => out(HAIRLINE[dir].reduce((g, [x, y]) => { if (g[y][x] !== '.') g[y][x] = 'c'; return g }, rows.map(r => [...r])))
const HUMAN_FRONT = withLine(BALD_FRONT, 'front')
const HUMAN_SIDE = withLine(BALD_SIDE, 'side')
// 사람 뒤: 앞과 같은 윤곽, 아래쪽 · 오른쪽이 한 단계 어둡게
const HUMAN_BACK = sheet([
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........dddddc..........',
  '......ddddddddcc........',
  '.....ddddddddddcc.......',
  '.....dddddddddddc.......',
  '.....dddddddddddc.......',
  '.....dddddddddddc.......',
  '.....ddddddddddcc.......',
  '...cccdddddddddcccc.....',
  '...cccddddddddccccc.....',
  '....ccddddddddcccc......',
  '......cddddddccc........',
  '.......ccccccccc........',
  '.........chhhc..........',
])

// 오리 · 고양이 · 강아지: 사람 귀 자리는 볼 털(아래로 뾰족)로. 가르마 창(x4 · x17–18, 13–14줄)은 그대로 채움
const CHEEK = rows => over(rows.map((r, y) => (y >= 13 && y <= 15 ? [...r].map((ch, x) => (x <= 4 || x >= 17 ? '.' : ch)).join('') : r)),
  pieces([[3, 13, ['cc', 'cc', 'c.']], [17, 13, ['cc', 'cc', '.c']]]))
// 옆: 사람 귀 대신 볼 털 그늘 한 줄
const NO_EAR_SIDE = rows => over(rows, pieces([[9, 12, ['ddd', 'ddc', 'ddc', 'ddd']]]))

// 로봇: 둥근 네모 머리, 화면(V)은 머리 바탕에 포함. 귀 자리엔 나사(Z/h), 18줄은 목 관절
const ROBOT_FRONT = sheet([
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '......dddddddddc........',
  '.....ddddddddddcc.......',
  '.....dddddddddddc.......',
  '.....dddddddddddc.......',
  '.....dddddddddddc.......',
  '.....ddVVVVVVVVdc.......',
  '...hZdVVVVVVVVVVcZh.....',
  '...hZdVVVVVVVVVVcZh.....',
  '.....ddVVVVVVVVcc.......',
  '.....dddddddddddc.......',
  '......cccccccccc........',
  '.........hhhhh..........',
])
const ROBOT_SIDE = sheet([
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '......dddddddddddc......',
  '.....dddddddddddddc.....',
  '.....dddddddddddddc.....',
  '.....dddddddddddddc.....',
  '.....dddddddddddddc.....',
  '.....dddcZcddddVVVV.....',
  '.....ddchZhcdddVVVV.....',
  '.....ddchhhcdddVVVV.....',
  '.....dddcccddddVVVV.....',
  '.....ddddddddddddcc.....',
  '......cccccccccccc......',
  '...........hhcccc.......',
])
const ROBOT_BACK = sheet([
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '......dddddddddc........',
  '.....ddddddddddcc.......',
  '.....dddddddddddc.......',
  '.....dccccccccddc.......',
  '.....dcddddddcddc.......',
  '.....dchhhhhhcddc.......',
  '...hZdcddddddcdcZh......',
  '...hZdchhhhhhcdcZh......',
  '.....dccccccccdcc.......',
  '.....dddddddddddc.......',
  '......cccccccccc........',
  '.........hhhhh..........',
])

const ANIMAL = (f, s) => ({ front: CHEEK(f), side: NO_EAR_SIDE(s), back: CHEEK(HUMAN_BACK) })
const ROBOT = { front: ROBOT_FRONT, side: ROBOT_SIDE, back: ROBOT_BACK }
/** 맨머리 (머리카락 가장자리 그늘 없음): 민머리처럼 머리카락이 없을 때의 모습 */
export const HEAD_BASE_BALD = {
  human: { front: BALD_FRONT, side: BALD_SIDE, back: HUMAN_BACK },
  alien: { front: BALD_FRONT, side: BALD_SIDE, back: HUMAN_BACK },
  duck: ANIMAL(BALD_FRONT, BALD_SIDE),
  cat: ANIMAL(BALD_FRONT, BALD_SIDE),
  dog: ANIMAL(BALD_FRONT, BALD_SIDE),
  robot: ROBOT,
}
/** 가르마처럼 얼굴을 감싸는 머리용 (확정 시안과 한 칸도 다르지 않음). 합성기가 headBase()를 쓰면 필요 없음 */
export const HEAD_BASE = {
  human: { front: HUMAN_FRONT, side: HUMAN_SIDE, back: HUMAN_BACK },
  alien: { front: HUMAN_FRONT, side: HUMAN_SIDE, back: HUMAN_BACK },
  duck: ANIMAL(HUMAN_FRONT, HUMAN_SIDE),
  cat: ANIMAL(HUMAN_FRONT, HUMAN_SIDE),
  dog: ANIMAL(HUMAN_FRONT, HUMAN_SIDE),
  robot: ROBOT,
}
const isHair = ch => ch !== undefined && ch !== '.' && ch !== ' '
/**
 * 머리 바탕 (권장). 맨머리 위에, 고른 머리카락(hairOver: 그 머리의 over 격자, 서 있는 자세 기준) 바로 왼쪽/오른쪽에 붙은
 * 얼굴 창 가장자리 칸만 c로 그늘을 넣습니다. 가르마 → 확정 시안 그대로, 민머리 · 모히칸 → 깨끗한 맨머리.
 */
export function headBase(sp, dir, hairOver) {
  const bald = (HEAD_BASE_BALD[sp] ?? HEAD_BASE_BALD.human)[dir]
  if (!bald || !hairOver || sp === 'robot') return bald ?? null
  const g = bald.map(r => [...r])
  for (const [x, y] of HAIRLINE[dir] ?? []) {
    if (g[y][x] === '.') continue
    if (isHair(hairOver[y]?.[x - 1]) || isHair(hairOver[y]?.[x + 1])) g[y][x] = 'c'
  }
  return out(g)
}

/* ══════════ 눈 · 볼 · 입 ══════════ */
export const EYE_STYLES = ['기본', '반짝 눈', '웃는 눈', '졸린 눈', '점 눈', '고양이 눈']

// 작은 눈 (사람 · 오리 · 고양이 · 강아지). 앞: 왼눈 기둥 x8 · 오른눈 x13 (사이 4칸), 13–14줄. 옆: x16.
// 반짝 눈의 빛(w)은 빛이 오는 왼쪽 위에 두 눈 모두 같은 쪽.
const SMALL = {
  front: [
    [[8, 13, ['e', 'y']], [13, 13, ['e', 'y']]], // 기본 = 확정 시안 (아래 칸은 눈 색)
    [[7, 13, ['we', 'yy']], [13, 13, ['we', 'yy']]], // 반짝
    [[7, 13, ['.e.', 'e.e']], [12, 13, ['.e.', 'e.e']]], // 웃는 ^ ^
    [[7, 13, ['cc', 'ee']], [13, 13, ['cc', 'ee']]], // 졸린: 눈꺼풀 그늘 + 감은 선
    [[8, 14, ['e']], [13, 14, ['e']]], // 점
    [[7, 13, ['we', 'ee']], [13, 13, ['we', 'ee']]], // 고양이: 동그란 2×2 + 왼쪽 위 빛 (사용자 선택 A)
  ],
  side: [
    [[16, 13, ['e', 'y']]],
    [[15, 13, ['we', 'yy']]],
    [[15, 13, ['.e.', 'e.e']]],
    [[15, 13, ['cc', 'ee']]],
    [[16, 14, ['e']]],
    [[15, 13, ['we', 'ee']]],
  ],
}
// 외계인: 같은 모양을 크게
const BIG = {
  front: [
    [[7, 12, ['ee', 'ee', 'yy']], [13, 12, ['ee', 'ee', 'yy']]],
    [[7, 12, ['we', 'ee', 'yy']], [13, 12, ['we', 'ee', 'yy']]],
    [[7, 12, ['.e.', 'e.e', 'e.e']], [12, 12, ['.e.', 'e.e', 'e.e']]],
    [[7, 13, ['ccc', 'eee']], [12, 13, ['ccc', 'eee']]],
    [[7, 13, ['ee', 'ee']], [13, 13, ['ee', 'ee']]],
    [[7, 12, ['we', 'ee', 'ee']], [13, 12, ['we', 'ee', 'ee']]],
  ],
  side: [
    [[15, 12, ['ee', 'ee', 'yy']]],
    [[15, 12, ['we', 'ee', 'yy']]],
    [[15, 12, ['.e.', 'e.e', 'e.e']]],
    [[14, 13, ['ccc', 'eee']]],
    [[15, 13, ['ee', 'ee']]],
    [[15, 12, ['we', 'ee', 'ee']]],
  ],
}
// 로봇: 화면 위 빛나는 눈 (W), 반짝 빛은 w
const GLOW = {
  front: [
    [[8, 13, ['W', 'W']], [13, 13, ['W', 'W']]],
    [[7, 13, ['wW', 'WW']], [13, 13, ['wW', 'WW']]],
    [[7, 13, ['.W.', 'W.W']], [12, 13, ['.W.', 'W.W']]],
    [[7, 14, ['WW']], [13, 14, ['WW']]],
    [[8, 14, ['W']], [13, 14, ['W']]],
    [[7, 13, ['wW', 'WW']], [13, 13, ['wW', 'WW']]],
  ],
  side: [
    [[17, 13, ['W', 'W']]],
    [[16, 13, ['wW', 'WW']]],
    [[16, 13, ['.W', 'W.']]],
    [[16, 14, ['WW']]],
    [[17, 14, ['W']]],
    [[16, 13, ['wW', 'WW']]],
  ],
}
const BLUSH = { front: [[7, 15, ['ff', 'ff']], [13, 15, ['ff', 'ff']]], side: [[14, 15, ['ff', 'ff']]] }
const MOUTH = {
  human: { front: [[10, 16, ['gg']]], side: [[17, 16, ['g']]] },
  alien: { front: [[10, 16, ['gg']]], side: [[17, 16, ['g']]] },
  // 오리: 입 대신 납작한 부리 (옆에서 1칸만 나옴)
  duck: { front: [[10, 15, ['QQ', 'RR']]], side: [[17, 15, ['QQQ', '.RR']]] }, // 앞 부리는 2칸: 양옆 볼터치와 한 칸 띄움
  // 고양이: 가로 3칸 시옷(ㅅ) 입 (사용자 선택), 수염 몇 칸
  cat: { front: [[10, 16, ['.g.', 'g.g']]], side: [[17, 16, ['g', 'g']], [18, 15, ['U']]] },
  // 강아지: 작은 코 + 입 (옆에서 1칸 둥근 코끝만)
  dog: { front: [[10, 15, ['TT', 'cc']]], side: [[18, 14, ['.c', 'TT']], [17, 16, ['g']]] },
  robot: { front: [[10, 16, ['gg']]], side: [[17, 16, ['g']]] },
}

const styleIndex = s => {
  if (typeof s === 'number') return s >= 0 && s < 6 ? s : 0
  const i = EYE_STYLES.indexOf(s)
  return i >= 0 ? i : 0
}
/** 얼굴 (눈 + 볼 + 입). sp: 종족 키, eyeStyle: 0–5 또는 이름, dir: front | side | back(null) */
export function face(sp, eyeStyle, dir) {
  if (dir === 'back') return null
  const d = dir === 'side' ? 'side' : 'front'
  const kind = sp === 'alien' ? BIG : sp === 'robot' ? GLOW : SMALL
  const eyes = kind[d][styleIndex(eyeStyle)]
  const list = []
  if (sp !== 'robot') list.push(...BLUSH[d])
  list.push(...(MOUTH[sp] ?? MOUTH.human)[d])
  list.push(...eyes)
  return pieces(list)
}

/* ══════════ 종족 덧그림 (얼굴 다음, 머리카락 아래) ══════════ */
// 외계인 더듬이: 머리카락 위로 3–4줄 나옴
const ANT_FRONT = [[6, 1, ['XX', 'XX', '.c', '..c', '..c']], [14, 1, ['XX', 'XX', 'c.', 'c', 'c']]]
// 고양이 귀: 머리카락 위로 끝이 나옴, 귀 속 분홍
const CAT_EARS_FRONT = [[5, 3, ['c', 'dc', 'dUc', 'dUdc', 'dddd']], [13, 3, ['...c', '..cc', '.cUc', 'cdUc', 'dddc']]]
const CAT_EARS_BACK = [[5, 3, ['c', 'dc', 'ddc', 'dddc', 'dddd']], [13, 3, ['...c', '..cc', '.cdc', 'cddc', 'dddc']]]
// 강아지 귀(늘어진 귀)는 머리카락 위에 그려야 보여서 EXTRA_OVER에 둡니다
export const EXTRA = {
  human: { front: null, side: null, back: null },
  alien: {
    front: pieces(ANT_FRONT),
    side: pieces([[8, 1, ['XX', 'XX', '.h', '.h', '.h']], [14, 1, ['XX', 'XX', 'c', 'c.', '.c']]]),
    back: pieces(ANT_FRONT),
  },
  duck: {
    front: pieces([[10, 2, ['.c', 'c.', 'dc', 'dd']]]),
    side: pieces([[11, 2, ['c.', '.c', 'cd', 'dd']]]),
    back: pieces([[10, 2, ['.c', 'c.', 'cc', 'dd']]]),
  },
  cat: {
    front: pieces(CAT_EARS_FRONT),
    side: pieces([[11, 3, ['.c', 'dc', 'dUc', 'dddc']], [8, 3, ['c', 'cc', 'ccc']]]),
    back: pieces(CAT_EARS_BACK),
  },
  dog: { front: null, side: null, back: null },
  robot: {
    front: pieces([[10, 2, ['YY', 'YY', 'h.', 'h.', 'hh']]]),
    side: pieces([[11, 2, ['YY', 'YY', 'h.', 'h.', 'hh']]]),
    back: pieces([[10, 2, ['YY', 'YY', 'h.', 'h.', 'hh']]]),
  },
}
/** 머리카락 위에 그리는 종족 덧그림 (강아지 늘어진 귀). 합성기에서 머리카락 다음 · 소품 전에 찍어 주세요 */
export const EXTRA_OVER = {
  human: { front: null, side: null, back: null },
  alien: { front: null, side: null, back: null },
  duck: { front: null, side: null, back: null },
  cat: {
    front: pieces([[4, 15, ['SS', '..', 'SS']], [16, 15, ['SS', '..', 'SS']]]),
    side: null,
    back: null,
  },
  dog: {
    front: pieces([[3, 7, ['..hh', '.hch', 'hcch', 'hcc', 'hcc', 'hcc', 'hcc', 'hch', '.hh']],
      [15, 7, ['hh..', 'hch.', 'hcch', '.cch', '.cch', '.cch', '.cch', '.hch', '.hh.']]]),
    side: pieces([[8, 8, ['.hh.', 'hddh', 'hdch', 'hdch', 'hcch', 'hcch', 'hcch', '.hch', '..h.']]]),
    back: pieces([[3, 7, ['..hh', '.hhh', 'hcch', 'hcc', 'hcc', 'hcc', 'hcc', 'hch', '.hh']],
      [15, 7, ['hh..', 'hhh.', 'hcch', '.cch', '.cch', '.cch', '.cch', '.hch', '.hh.']]]),
  },
  robot: { front: null, side: null, back: null },
}

/* ══════════ 꼬리 (몸 기준, 서 있는 자세) ══════════ */
// 옆: 몸 뒤(왼쪽)에서 나옴, 합성기가 몸 뒤에 그림. 뒤: 몸 위에 그림 (엉덩이 가운데 x 11).
export const TAIL = {
  human: { front: null, side: null, back: null },
  alien: { front: null, side: null, back: null },
  robot: { front: null, side: null, back: null },
  cat: {
    front: null,
    side: pieces([[4, 21, ['.c', 'dc', 'd.', 'dc', '.dc', '..dcc', '...dcc']]]),
    back: pieces([[11, 27, ['dc...', 'dc...', 'dc...', '.dc.c', '..ddc']]]),
  },
  dog: {
    front: null,
    side: pieces([[6, 23, ['c.', 'dc', '.dc', '..dc']]]),
    back: pieces([[11, 24, ['dc', 'dc', 'dc', 'c.']]]),
  },
  duck: {
    front: null,
    side: pieces([[6, 25, ['dd.', '.cc']]]),
    back: pieces([[10, 27, ['dcc', '.c.']]]),
  },
}
