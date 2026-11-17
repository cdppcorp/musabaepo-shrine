// 맵 정의. 서버(충돌 · 거리 확인)와 화면(그리기)이 같은 값을 씁니다. 화면에는 /api/world로 내려갑니다.
// 단위는 픽셀(도트 1칸 = 1px, 타일 16px). 화면은 창 크기에 맞춰 정수 배로 키워 그립니다.
//
// 배치는 밤 축제 마당입니다. 줄 맞춘 거리 대신 마당마다 사당이 둘러서고, 길을 따라 한 바퀴 돌 수 있습니다.
//   아래 가운데 입구 문 → 큰길 → 가운데 광장(모닥불 · 그루터기 의자 · 배포운 상자) → 큰길 → 맨 위 GitHub 신당(옥토캣 신상 · 향로)
//   광장 서쪽 길 → 서쪽 마당(돗자리, 사당 다섯 채가 반원으로 둘러쌈) · 동쪽 길 → 오른쪽 AI 신당 다섯 채(돌마당을 반원으로 둘러쌈)
//   위쪽 골목(GitHub 신당 양옆으로 물결치듯 다섯 채씩), 서쪽 비탈 골목(입구로 내려오는 길을 따라 다섯 채)
//   오른쪽 아래 AI 트렌드 게시판과 탁자 둘(글을 쓰고 둘러앉아 이야기하는 곳)
//   광장 북쪽 큰길 옆 '프로젝트 등록소' (GitHub · 서비스 주소를 접수, 검토 뒤 사당으로)
//   왼쪽 아래 구석 '고뇌와 번뇌의 공간' (흡연구역: 재떨이 · 벤치 · 희미한 등, 여기서만 온라인 흡연)
//   양쪽 끝 오솔길이 위쪽 골목과 마당 · 비탈 골목을 이어 줍니다.

export const TILE = 16
export const MAP_W = 56 * TILE // 896
/** 아래 울타리 바깥으로 조금 더 그려, 화면 아래 버튼 줄에 입구 문이 가리지 않게 합니다 */
export const MAP_H = 42 * TILE // 672
/** 걷는 속도 (px/초) */
export const SPEED = 70
/** 사당 · 상자 앞에 '서 있다'고 보는 거리 */
export const NEAR = 26
/**
 * 캐릭터 꾸미기 부위별 선택지 개수 (화면 public/js/avatar.js의 PARTS 순서와 같아야 합니다).
 * 종족 · 몸 색 · 눈 · 눈 색 · 머리 모양 · 머리 색 · 상의 · 상의 색 · 하의 · 하의 색 · 신발 · 소품
 */
export const LOOK_SIZES = [6, 6, 6, 6, 16, 12, 9, 12, 5, 8, 6, 10] as const

export function isValidLook(v: unknown): v is number[] {
  return Array.isArray(v) && v.length === LOOK_SIZES.length
    && v.every((n, i) => Number.isInteger(n) && n >= 0 && n < (LOOK_SIZES[i] ?? 0))
}
/** 고르는 말풍선 개수 (화면 public/js/data.js의 BUBBLES와 같아야 합니다) */
export const BUBBLE_COUNT = 10
/** 행동: 절하기 · 손 흔들기 · 깡충 · 빙글 · 뽀뽀 · 한 대 피우기(흡연구역 안에서만) */
export const EMOTES = ['bow', 'wave', 'jump', 'spin', 'kiss', 'smoke'] as const
/** 흡연할 때 머리 위에 뜨는 한숨 문구 개수 (화면 data.js의 SIGHS와 같아야 합니다) */
export const SIGH_COUNT = 10

export interface Rect { x: number; y: number; w: number; h: number }
export interface Point { x: number; y: number }
export interface Plot { id: number; x: number; y: number; body: Rect; front: Point; box: Rect }

/** 위쪽 담 · 양옆 담 두께, 아래 울타리가 시작하는 y */
const WALL_TOP = 24
const WALL_SIDE = 8
const FENCE_Y = 612
const mirror = (x: number) => MAP_W - x

/** 서비스 사당 자리 20칸의 왼쪽 위 모서리. 자리 하나는 48×44, 몸체(부딪히는 곳)는 40×40, 앞에 서는 곳은 몸체 아래 */
const SPOTS: [number, number][] = [
  // 0~9 위쪽 골목: GitHub 신당 양옆으로 물결치듯
  [40, 40], [96, 32], [152, 28], [208, 32], [264, 42],
  [584, 42], [640, 32], [696, 28], [752, 32], [808, 40],
  // 10~14 서쪽 마당을 둘러싼 반원
  [40, 236], [92, 208], [148, 198], [204, 208], [256, 236],
  // 15~19 서쪽 비탈 골목: 입구 쪽으로 한 채씩 내려옵니다
  [96, 404], [152, 420], [208, 436], [264, 452], [320, 468],
]

export const PLOTS: Plot[] = SPOTS.map(([x, y], id) => ({
  id, x, y,
  // 위쪽 골목 사당은 뒤가 담에 붙어 있고 옆 사당과 이어져 있습니다 (사당 사이 막다른 틈으로 들어가지 않게)
  body: id < 10 ? { x: x - 4, y: WALL_TOP, w: 56, h: y + 40 - WALL_TOP } : { x: x + 4, y, w: 40, h: 40 },
  front: { x: x + 24, y: y + 52 },
  box: { x, y: y - 4, w: 48, h: 48 },
}))

/** 배포운 상자는 광장 서쪽 길목 */
export const FORTUNE: Rect = { x: 334, y: 270, w: 24, h: 18 }
/** GitHub 신당 (맨 위 가운데). 기도하는 곳은 향로 왼쪽 앞 (가운데 서면 머리가 향로를 가립니다) */
const TEMPLE = { x: 448, y: 108 }
export const TEMPLE_FRONT: Point = { x: TEMPLE.x - 20, y: TEMPLE.y + 32 }

/**
 * AI 신당: 초 켜기와 따로 "잘 돌아가게 해 주세요" 기도를 올리는 곳 (오른쪽 돌마당, 반원).
 * 이름은 글자로만 씁니다 (각 회사 로고는 쓰지 않음). 색은 신당 구슬 · 이름표에 씁니다.
 */
export const AIS = [
  { key: 'gpt', name: 'ChatGPT', color: '#19c37d' },
  { key: 'gemini', name: 'Gemini', color: '#a07cf2' },
  { key: 'claude', name: 'Claude', color: '#d97757' },
  { key: 'deepseek', name: 'DeepSeek', color: '#3d7bff' },
  { key: 'grok', name: 'Grok', color: '#c8ccd6' },
] as const
export type AiKey = (typeof AIS)[number]['key']
const AI_SPOTS: [number, number][] = [[640, 300], [692, 284], [744, 278], [796, 284], [848, 300]]
export const AI_SHRINES = AIS.map((ai, i) => {
  const [x, y] = AI_SPOTS[i] ?? [0, 0]
  return { ...ai, x, y, front: { x, y: y + 14 }, box: { x: x - 16, y: y - 44, w: 32, h: 44 } }
})
export const isAiKey = (v: unknown): v is AiKey => AIS.some(a => a.key === v)

/** 프로젝트 등록소 (광장 북쪽 큰길 옆). 근처에서 접수합니다 */
const REGISTRY = { x: 516, y: 212 }
export const REGISTRY_FRONT: Point = { x: REGISTRY.x, y: REGISTRY.y + 14 }

/** 고뇌와 번뇌의 공간 (흡연구역, 왼쪽 아래 구석). 이 안에서만 '한 대 피우기'가 됩니다 */
export const SMOKE_ZONE = { x: 60, y: 548, r: 52 }
/** 재떨이 오른쪽 앞 (바로 앞에 서면 캐릭터가 재떨이를 가립니다) */
export const SMOKE_FRONT: Point = { x: 80, y: 556 }

/** AI 트렌드 게시판 (오른쪽 아래). 앞에 서서 글을 읽고 씁니다 */
const TREND = { x: 700, y: 470 }
export const TREND_FRONT: Point = { x: TREND.x, y: TREND.y + 20 }
/** 입구 문 바로 안쪽 */
export const SPAWN: Point = { x: 448, y: 548 }

/**
 * 소품. x · y는 바닥에 닿는 곳(가운데 아래)입니다. 화면은 y 순서로 캐릭터와 섞어 그려 앞뒤가 맞습니다.
 * mat(돗자리)만 바닥에 깔려 밟고 지나갈 수 있습니다 (돗자리의 x · y는 한가운데).
 */
export type PropKind = 'temple' | 'censer' | 'ai' | 'trend' | 'registry' | 'ashtray' | 'sign' | 'tree' | 'bush' | 'fire' | 'stump' | 'pole' | 'stone' | 'table' | 'stool' | 'bench' | 'mat' | 'gate'
export interface Prop { k: PropKind; x: number; y: number; w?: number; h?: number; v?: number; a?: string }

const pole = (x: number, y: number): Prop => ({ k: 'pole', x, y })
/** 초롱 기둥 꼭대기 (줄을 거는 곳) */
const POLE_TOP = 29
const ring = (cx: number, cy: number, rx: number, ry: number, n: number, k: PropKind): Prop[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2
    return { k, x: Math.round(cx + Math.cos(a) * rx), y: Math.round(cy + Math.sin(a) * ry) }
  })

const PLAZA = { x: 448, y: 300, r: 74 }
const plazaPoles = [pole(384, 240), pole(512, 240), pole(384, 360), pole(512, 360)]
const northPoles = [pole(422, 168), pole(474, 168)]
const gatePoles = [pole(422, 500), pole(474, 500)]
const westPoles = [pole(52, 352), pole(300, 352)]
const eastPoles = [pole(mirror(300), 352), pole(mirror(52), 352)]

export const PROPS: Prop[] = [
  // 오른쪽 AI 신당 다섯 채
  ...AI_SHRINES.map((a): Prop => ({ k: 'ai', x: a.x, y: a.y, a: a.key })),
  // 맨 위 GitHub 신당: 옥토캣 신상을 모신 집과 앞의 향로, 양옆 석등. 향로 앞(TEMPLE_FRONT)에서 기도합니다
  { k: 'temple', x: TEMPLE.x, y: TEMPLE.y }, { k: 'censer', x: TEMPLE.x, y: TEMPLE.y + 14 },
  { k: 'stone', x: TEMPLE.x - 60, y: TEMPLE.y + 18 }, { k: 'stone', x: TEMPLE.x + 60, y: TEMPLE.y + 18 },
  // 광장 북쪽 프로젝트 등록소
  { k: 'registry', x: REGISTRY.x, y: REGISTRY.y },
  // 왼쪽 아래 구석 고뇌와 번뇌의 공간: 스탠드 재떨이 · 팻말 · 벤치 · 희미한 등
  { k: 'ashtray', x: SMOKE_ZONE.x, y: SMOKE_ZONE.y - 2 }, { k: 'sign', x: 26, y: 534 },
  { k: 'bench', x: SMOKE_ZONE.x, y: 590 }, pole(100, 530),
  // 오른쪽 아래 AI 트렌드 게시판과 탁자 둘
  { k: 'trend', x: TREND.x, y: TREND.y },
  { k: 'table', x: 632, y: 556 }, { k: 'stool', x: 614, y: 556 }, { k: 'stool', x: 650, y: 556 }, { k: 'stool', x: 632, y: 568 },
  { k: 'table', x: 776, y: 540 }, { k: 'stool', x: 758, y: 540 }, { k: 'stool', x: 794, y: 540 }, { k: 'stool', x: 776, y: 552 },
  // 광장: 모닥불을 그루터기 의자 여섯이 둘러쌉니다
  { k: 'fire', x: PLAZA.x, y: PLAZA.y },
  ...ring(PLAZA.x, PLAZA.y, 32, 22, 6, 'stump'),
  ...plazaPoles, ...northPoles, ...gatePoles,
  // 서쪽 마당: 돗자리 둘
  { k: 'mat', x: 130, y: 312, w: 40, h: 22, v: 0 }, { k: 'mat', x: 206, y: 330, w: 34, h: 20, v: 1 },
  ...westPoles,
  ...eastPoles,
  // 나무 그늘 벤치 (위쪽 골목과 마당 사이 쉼터)
  { k: 'bench', x: 162, y: 172 }, { k: 'bench', x: mirror(162), y: 172 },
  // 나무 · 덤불
  { k: 'tree', x: 100, y: 164 }, { k: 'tree', x: 236, y: 152, v: 1 }, { k: 'tree', x: 350, y: 182 },
  { k: 'tree', x: mirror(100), y: 164, v: 1 }, { k: 'tree', x: mirror(236), y: 152 }, { k: 'tree', x: 572, y: 188, v: 1 },
  { k: 'tree', x: 176, y: 560 }, { k: 'tree', x: mirror(40), y: 572 }, { k: 'tree', x: mirror(176), y: 560, v: 1 },
  { k: 'bush', x: 300, y: 596 }, { k: 'bush', x: 112, y: 596 }, { k: 'bush', x: mirror(300), y: 596 }, { k: 'bush', x: mirror(112), y: 596 },
  { k: 'bush', x: 330, y: 404 }, { k: 'bush', x: mirror(330), y: 404 },
  // 입구 문 (울타리 가운데)
  { k: 'gate', x: 448, y: FENCE_Y },
]

/** 소품이 차지해 부딪히는 곳 */
function solidsOf(p: Prop): Rect[] {
  switch (p.k) {
    case 'temple': return [{ x: p.x - 44, y: p.y - 30, w: 88, h: 30 }]
    case 'censer': return [{ x: p.x - 6, y: p.y - 4, w: 12, h: 5 }]
    case 'ai': return [{ x: p.x - 13, y: p.y - 12, w: 26, h: 12 }]
    case 'trend': return [{ x: p.x - 36, y: p.y - 6, w: 72, h: 6 }]
    case 'registry': return [{ x: p.x - 22, y: p.y - 14, w: 44, h: 14 }]
    case 'ashtray': return [{ x: p.x - 3, y: p.y - 3, w: 6, h: 4 }]
    case 'sign': return [{ x: p.x - 2, y: p.y - 3, w: 4, h: 4 }]
    case 'tree': return [{ x: p.x - 3, y: p.y - 3, w: 6, h: 4 }]
    case 'bush': return [{ x: p.x - 6, y: p.y - 3, w: 12, h: 4 }]
    case 'fire': return [{ x: p.x - 8, y: p.y - 4, w: 16, h: 7 }]
    case 'stump': return [{ x: p.x - 4, y: p.y - 2, w: 8, h: 4 }]
    case 'pole': return [{ x: p.x - 2, y: p.y - 2, w: 4, h: 3 }]
    case 'stone': return [{ x: p.x - 5, y: p.y - 3, w: 10, h: 4 }]
    case 'table': return [{ x: p.x - 9, y: p.y - 4, w: 18, h: 7 }]
    case 'stool': return [{ x: p.x - 3, y: p.y - 2, w: 6, h: 3 }]
    case 'bench': return [{ x: p.x - 13, y: p.y - 4, w: 26, h: 4 }]
    case 'gate': return [{ x: p.x - 45, y: p.y - 8, w: 10, h: 8 }, { x: p.x + 35, y: p.y - 8, w: 10, h: 8 }]
    default: return []
  }
}

/** 초롱 줄 (기둥 꼭대기끼리). 화면은 캐릭터 위에 그립니다 */
const top = (p: Prop | undefined): [number, number] => [p?.x ?? 0, (p?.y ?? 0) - POLE_TOP]
export const STRINGS: [number, number][][] = [
  [top(plazaPoles[0]), top(plazaPoles[1])],
  [top(plazaPoles[2]), top(plazaPoles[3])],
  [top(plazaPoles[0]), top(plazaPoles[3])],
  [top(plazaPoles[1]), top(plazaPoles[2])],
  [top(northPoles[0]), top(northPoles[1])],
  [top(gatePoles[0]), top(gatePoles[1])],
  [top(westPoles[0]), top(westPoles[1])],
  [top(eastPoles[0]), top(eastPoles[1])],
]

/**
 * 바닥 무늬 (화면만 씁니다). stone은 돌바닥, dirt는 흙길 · 마당. 나머지는 풀밭입니다.
 * line은 점을 이은 굵기 r의 길, circle · ellipse는 둥근 마당.
 */
type Ground =
  | { t: 'stone' | 'dirt'; k: 'line'; r: number; pts: [number, number][] }
  | { t: 'stone' | 'dirt'; k: 'circle'; x: number; y: number; r: number }
  | { t: 'stone' | 'dirt'; k: 'ellipse'; x: number; y: number; rx: number; ry: number }
const flipLine = (pts: [number, number][]) => pts.map(([x, y]) => [mirror(x), y] as [number, number])
const northLane: [number, number][] = [[12, 102], [64, 98], [120, 90], [176, 86], [232, 90], [288, 100], [352, 112], [400, 116]]
const westTrail: [number, number][] = [[24, 104], [22, 200], [44, 286]]
const westSlope: [number, number][] = [[60, 350], [58, 436], [84, 458], [120, 462], [176, 478], [232, 494], [288, 510], [344, 526], [396, 556], [440, 596]]
export const GROUND: Ground[] = [
  { t: 'dirt', k: 'line', r: 14, pts: [[448, MAP_H], [448, 120]] },
  { t: 'dirt', k: 'line', r: 13, pts: northLane }, { t: 'dirt', k: 'line', r: 13, pts: flipLine(northLane) },
  { t: 'dirt', k: 'line', r: 10, pts: westTrail }, { t: 'dirt', k: 'line', r: 10, pts: [[872, 104], [874, 200], [874, 318]] },
  { t: 'dirt', k: 'ellipse', x: 172, y: 300, rx: 136, ry: 62 }, { t: 'stone', k: 'ellipse', x: 744, y: 322, rx: 118, ry: 48 },
  { t: 'dirt', k: 'line', r: 12, pts: [[300, 300], [380, 300]] }, { t: 'dirt', k: 'line', r: 12, pts: [[mirror(300), 300], [mirror(380), 300]] },
  { t: 'dirt', k: 'line', r: 12, pts: westSlope }, { t: 'dirt', k: 'line', r: 12, pts: flipLine(westSlope) },
  { t: 'stone', k: 'circle', x: PLAZA.x, y: PLAZA.y, r: PLAZA.r },
  { t: 'stone', k: 'ellipse', x: 448, y: 112, rx: 82, ry: 38 },
  { t: 'stone', k: 'circle', x: 448, y: 618, r: 40 },
  // 흡연구역 돌바닥과 비탈 골목에서 내려오는 오솔길
  { t: 'stone', k: 'ellipse', x: 62, y: 556, rx: 46, ry: 32 },
  { t: 'dirt', k: 'line', r: 8, pts: [[74, 462], [70, 500], [64, 530]] },
]

export const SOLIDS: Rect[] = [
  { x: 0, y: 0, w: MAP_W, h: WALL_TOP },
  { x: 0, y: FENCE_Y, w: MAP_W, h: MAP_H - FENCE_Y },
  { x: 0, y: 0, w: WALL_SIDE, h: MAP_H },
  { x: MAP_W - WALL_SIDE, y: 0, w: WALL_SIDE, h: MAP_H },
  ...PLOTS.map(p => p.body),
  FORTUNE,
  ...PROPS.flatMap(solidsOf),
]

/**
 * 앉는 자리. x · y는 앉은 사람의 발 기준점(의자 바로 앞), d는 바라보는 방향(0 아래 · 1 위 · 2 왼쪽 · 3 오른쪽),
 * h는 앉는 면 높이(그리기용), stand는 일어설 때 서는 곳입니다.
 * 그루터기는 모닥불을, 탁자 의자는 탁자를 바라보고, 벤치는 둘이 나란히, 돗자리는 둘씩 바닥에 앉습니다.
 */
export interface Seat { id: number; x: number; y: number; d: number; h: number; stand: Point }
const facing = (dx: number, dy: number) => (Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 2 : 3) : dy < 0 ? 1 : 0)
export const SEATS: Seat[] = PROPS.flatMap((p): Omit<Seat, 'id'>[] => {
  const away = (cx: number, cy: number, by: number) => {
    const len = Math.hypot(p.x - cx, p.y - cy) || 1
    return { x: Math.round(p.x + ((p.x - cx) / len) * by), y: Math.round(p.y + ((p.y - cy) / len) * by) }
  }
  if (p.k === 'stump') return [{ x: p.x, y: p.y + 1, d: facing(PLAZA.x - p.x, PLAZA.y - p.y), h: 5, stand: away(PLAZA.x, PLAZA.y, 11) }]
  if (p.k === 'bench') return [-7, 7].map(dx => ({ x: p.x + dx, y: p.y + 1, d: 0, h: 5, stand: { x: p.x + dx, y: p.y + 8 } }))
  if (p.k === 'stool') {
    const t = PROPS.filter(q => q.k === 'table').sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0]
    if (!t) return []
    return [{ x: p.x, y: p.y + 1, d: facing(t.x - p.x, t.y - p.y), h: 4, stand: away(t.x, t.y, 9) }]
  }
  if (p.k === 'mat') return [-1, 1].map(side => {
    const at = { x: Math.round(p.x + side * (p.w ?? 20) / 4), y: p.y + 3 }
    return { ...at, d: 0, h: 0, stand: at }
  })
  return []
}).map((s, id) => ({ id, ...s }))

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

/** 발밑 상자(8×4)가 벽 · 사당 · 소품에 걸리거나 맵 밖이면 true */
export function blocked(x: number, y: number): boolean {
  if (x < 4 || y < 4 || x > MAP_W - 4 || y > MAP_H - 2) return true
  const feet = { x: x - 4, y: y - 3, w: 8, h: 4 }
  return SOLIDS.some(s => overlap(feet, s))
}

export const near = (a: Point, b: Point, r: number = NEAR) => Math.hypot(a.x - b.x, a.y - b.y) <= r

/**
 * 물건 '근처'인지: 정면 한 점이 아니라 물건이 보이는 상자(앞 · 뒤 · 옆 어디든)에서 r 안이면 근처입니다.
 * 화면은 REACH, 서버는 지연을 감안해 조금 넓게(REACH_SERVER) 봅니다.
 */
export const REACH = 18
export const REACH_SERVER = 26
export function nearBox(a: Point, b: Rect, r: number = REACH): boolean {
  const dx = Math.max(b.x - a.x, 0, a.x - (b.x + b.w))
  const dy = Math.max(b.y - a.y, 0, a.y - (b.y + b.h))
  return Math.hypot(dx, dy) <= r
}
/** 물건이 보이는 상자 (근처 판정용) */
export const TEMPLE_RECT: Rect = { x: TEMPLE.x - 50, y: TEMPLE.y - 94, w: 100, h: 112 }
export const TREND_RECT: Rect = { x: TREND.x - 40, y: TREND.y - 52, w: 80, h: 54 }
export const REGISTRY_RECT: Rect = { x: REGISTRY.x - 26, y: REGISTRY.y - 46, w: 52, h: 48 }
export const FORTUNE_RECT: Rect = { x: FORTUNE.x, y: FORTUNE.y - 12, w: FORTUNE.w, h: FORTUNE.h + 12 }


/** 화면으로 내려보내는 맵 정보 */
export const WORLD_JSON = {
  tile: TILE,
  w: MAP_W,
  h: MAP_H,
  wallTop: WALL_TOP,
  wallSide: WALL_SIDE,
  fenceY: FENCE_Y,
  speed: SPEED,
  near: NEAR,
  plots: PLOTS,
  solids: SOLIDS,
  fortune: FORTUNE,
  spawn: SPAWN,
  templeFront: TEMPLE_FRONT,
  ais: AI_SHRINES,
  registryFront: REGISTRY_FRONT,
  smokeZone: SMOKE_ZONE,
  smokeFront: SMOKE_FRONT,
  sighs: SIGH_COUNT,
  trendFront: TREND_FRONT,
  reach: REACH,
  boxes: { temple: TEMPLE_RECT, trend: TREND_RECT, registry: REGISTRY_RECT, fortune: FORTUNE_RECT },
  seats: SEATS,
  props: PROPS,
  strings: STRINGS,
  ground: GROUND,
  lookSizes: LOOK_SIZES,
  bubbles: BUBBLE_COUNT,
}
