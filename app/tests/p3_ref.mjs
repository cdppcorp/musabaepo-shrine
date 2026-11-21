// P3 Node 기준값: server/npc.ts의 findPath(길 찾기 · 줄이기), world.ts의 blocked, 그리고 realtime.ts가 메시지 칸에 쓰는
// JS Number() · ?ch= 읽기 · NPC 격자(입구 · 걸어갈 수 있는 칸).
//   node --disable-warning=ExperimentalWarning app/tests/p3_ref.mjs < 요청.json   (DATA_DIR = 임시 폴더: npc.ts가 shrines.ts → db.ts를 엶)
//   요청: {"op": "paths", "cases": [[{x,y}, {x,y}], …]}       → [[{x,y}…] | null, …]
//         {"op": "blocked", "cases": [[x, y], …]}              → [bool, …]
//         {"op": "numbers", "cases": ["<JSON 글자>", …]}       → [{n: 숫자 글자} | {err: 'TypeError'}, …]  (Number(JSON.parse(c)))
//         {"op": "channel", "cases": ["?ch=…", …]}             → [0~3, …]   (realtime.ts handleUpgrade의 ?ch= 읽기 그대로)
//         {"op": "grid"}                                        → {gate, reachable: 칸 수, first: 앞 칸 20개, sum}
// 서버 소스는 읽기만 합니다.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, '..', '..', 'server')
const input = JSON.parse(readFileSync(0, 'utf8'))
const load = name => import(pathToFileURL(join(SERVER, name)).href)

let out
if (input.op === 'paths') {
  const { findPath } = await load('npc.ts')
  out = input.cases.map(([a, b]) => findPath(a, b))
} else if (input.op === 'blocked') {
  const { blocked } = await load('world.ts')
  out = input.cases.map(([x, y]) => blocked(x, y))
} else if (input.op === 'numbers') {
  out = input.cases.map(c => {
    try {
      const n = Number(JSON.parse(c))
      return { n: Object.is(n, -0) ? '-0' : String(n) }
    } catch (e) {
      return { err: e.constructor.name }
    }
  })
} else if (input.op === 'channel') {
  const { CHANNELS } = await load('world.ts')
  out = input.cases.map(q => {
    let want = 0
    try {
      want = Number(new URL(`/ws${q}`, 'http://x').searchParams.get('ch')) || 0
    } catch { /* 잘못된 주소면 자동 배정 */ }
    if (!Number.isInteger(want) || want < 1 || want > CHANNELS) want = 0
    return want
  })
} else if (input.op === 'grid') {
  // npc.ts는 격자 · 입구를 내보내지 않으므로 같은 계산을 공개 함수로 확인합니다: findPath(입구 → 입구)와 입구 칸
  const { findPath } = await load('npc.ts')
  const { blocked, SPAWN, MAP_W, MAP_H } = await load('world.ts')
  const gate = blocked(448, 604) ? { ...SPAWN } : { x: 448, y: 604 }
  const GW = Math.ceil(MAP_W / 8)
  const GH = Math.ceil(MAP_H / 8)
  let open = 0
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) if (!blocked(x * 8 + 4, y * 8 + 4)) open++
  out = { gate, open, self: findPath(gate, gate) }
} else {
  throw new Error(`모르는 op: ${input.op}`)
}
process.stdout.write(JSON.stringify(out))
