// NPC 방문자: 채널 1에는 늘 6명, 채널 2에는 3~10명이 거닐게 합니다. 화면에는 다른 방문객과 똑같이 보입니다(스냅샷의 npc: true는 인원 계산용).
// NPC는 데이터를 남기지 않습니다 — 초 · AI 기도 · 게시판 · 직접 쓴 말 없이, 걷기 · 앉기 · 고른 말풍선 · 행동만 합니다.
// 서버가 직접 움직이며(길 찾기는 목적지가 바뀔 때만), 실제 사람과 같은 모양의 메시지(join · st · sit · say · emo · leave)를 보냅니다.
// 채널 정원(30명)에는 세지 않습니다.
import { randomBytes } from 'node:crypto'
import { makeNick } from './security.ts'
import { allShrines } from './shrines.ts'
import {
  AI_SHRINES, BUBBLE_COUNT, FORTUNE, LOOK_SIZES, MAP_H, MAP_W, PLOTS, REGISTRY_FRONT, SEATS, SIGH_COUNT, SMOKE_FRONT,
  SPAWN, SPEED, TEMPLE_FRONT, TREND_FRONT, blocked, type Point,
} from './world.ts'

/** NPC가 사는 채널과 머릿수 범위 */
export const NPC_CHANNELS = [1, 2] as const
/** 채널별 NPC 수 [최소, 최대]. 채널 1은 늘 6명, 채널 2는 3~10명 사이에서 천천히 오르내림 */
const NPC_RANGE: Record<number, readonly [number, number]> = { 1: [6, 6], 2: [3, 10] }
const rangeOf = (id: number) => NPC_RANGE[id] ?? [3, 10]
/** 걷는 속도: 사람보다 조금 느긋하게 */
/** 천천히 거닐 듯 (플레이어보다 한참 느리게) */
const NPC_SPEED = SPEED * 0.6
/** 한 채널에서 NPC 말풍선 사이 최소 간격 */
const NPC_SAY_GAP = 20_000
/** 입구 문 바로 안쪽: 여기로 들어오고 여기로 나갑니다 */
const GATE: Point = blocked(448, 604) ? { ...SPAWN } : { x: 448, y: 604 }

type GoalKind = 'shrine' | 'ai' | 'temple' | 'trend' | 'registry' | 'smoke' | 'fortune' | 'seat' | 'wander' | 'gate'
interface Goal { kind: GoalKind; at: Point; seat?: number }

export interface Npc {
  id: string
  nick: string
  look: number[]
  x: number
  y: number
  d: number
  moving: boolean
  seat: number
  dirty: boolean
  state: 'walk' | 'idle' | 'sit'
  goal: Goal | null
  path: Point[]
  until: number
  nextChatter: number
  leaving: boolean
}

/** realtime.ts가 넘겨주는 연결부 */
export interface NpcHost {
  /** 그 채널의 실제 사람들에게 보내기 */
  send(channel: number, msg: object): void
  /** 실제 사람이 그 자리에 앉아 있는지 */
  seatTaken(channel: number, seat: number): boolean
  /** 그 채널에 NPC가 더 있을 수 있는 자리 수 (정원 - 실제 사람). NPC도 인원에 세므로 사람이 오면 비켜 줍니다 */
  room(channel: number): number
}

interface NpcChannel {
  id: number
  target: number
  nextDrift: number
  nextSpawn: number
  /** 이 채널에서 NPC가 마지막으로 말풍선을 띄운 때 (채널 전체가 시끄럽지 않게) */
  lastSay: number
  npcs: Map<string, Npc>
}

const rand = (a: number, b: number) => a + Math.random() * (b - a)
const randInt = (a: number, b: number) => Math.floor(rand(a, b + 1))
const pick = <T>(list: readonly T[]): T | undefined => list[Math.floor(Math.random() * list.length)]

/* ── 길 찾기: 8px 칸, 8방향, 막힌 칸은 맵 그대로 (처음 한 번만 만듭니다) ── */

const CELL = 8
const GW = Math.ceil(MAP_W / CELL)
const GH = Math.ceil(MAP_H / CELL)
let grid: Uint8Array | null = null
/** 입구에서 걸어갈 수 있는 칸 목록 (아무 데나 거닐 곳 고르기용) */
let reachable: number[] = []

function ensureGrid() {
  if (grid) return grid
  grid = new Uint8Array(GW * GH)
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) grid[y * GW + x] = blocked(x * CELL + 4, y * CELL + 4) ? 1 : 0
  const seen = flood(cellOf(GATE))
  reachable = []
  for (let i = 0; i < seen.length; i++) if (seen[i] && !grid[i]) reachable.push(i)
  return grid
}

const cellOf = (p: Point) => Math.min(GH - 1, Math.max(0, Math.floor(p.y / CELL))) * GW + Math.min(GW - 1, Math.max(0, Math.floor(p.x / CELL)))
const centerOf = (c: number): Point => ({ x: (c % GW) * CELL + 4, y: Math.floor(c / GW) * CELL + 4 })

const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]

function flood(start: number): Uint8Array {
  const g = ensureGridRaw()
  const seen = new Uint8Array(GW * GH)
  const q = [start]
  seen[start] = 1
  for (let i = 0; i < q.length; i++) {
    const c = q[i] as number
    const cx = c % GW
    const cy = (c - cx) / GW
    for (const [dx, dy] of DIRS.slice(0, 4)) {
      const nx = cx + dx
      const ny = cy + dy
      if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue
      const n = ny * GW + nx
      if (seen[n] || g[n]) continue
      seen[n] = 1
      q.push(n)
    }
  }
  return seen
}

/** flood가 ensureGrid 안에서 불릴 때를 위해 (grid가 막 만들어진 상태) */
function ensureGridRaw(): Uint8Array {
  if (!grid) throw new Error('grid not ready')
  return grid
}

/** 막힌 칸이면 가까운 빈 칸으로 */
function openCell(c: number): number {
  const g = ensureGrid()
  if (!g[c]) return c
  const cx = c % GW
  const cy = (c - cx) / GW
  for (let r = 1; r <= 3; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = cx + dx
        const ny = cy + dy
        if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue
        const n = ny * GW + nx
        if (!g[n]) return n
      }
    }
  }
  return c
}

/** 두 점 사이를 막힘 없이 곧게 걸을 수 있는지 (3px 간격으로 확인) */
function clearLine(a: Point, b: Point): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  const n = Math.max(1, Math.ceil(len / 3))
  for (let i = 1; i <= n; i++) {
    const s = i / n
    if (blocked(a.x + (b.x - a.x) * s, a.y + (b.y - a.y) * s)) return false
  }
  return true
}

/** 출발점에서 목적지까지 길 (곧게 걸을 수 있는 구간은 줄여서). 못 가면 null */
export function findPath(from: Point, to: Point): Point[] | null {
  const g = ensureGrid()
  const start = openCell(cellOf(from))
  const goal = openCell(cellOf(to))
  const prev = new Int32Array(GW * GH).fill(-1)
  prev[start] = start
  const q = [start]
  for (let i = 0; i < q.length && prev[goal] === -1; i++) {
    const c = q[i] as number
    const cx = c % GW
    const cy = (c - cx) / GW
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx
      const ny = cy + dy
      if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue
      const n = ny * GW + nx
      if (prev[n] !== -1 || g[n]) continue
      // 대각선은 양옆이 모두 비어 있을 때만 (모서리 끼임 방지)
      if (dx && dy && (g[cy * GW + nx] || g[ny * GW + cx])) continue
      prev[n] = c
      q.push(n)
    }
  }
  if (prev[goal] === -1) return null
  const cells: number[] = []
  for (let c = goal; c !== start; c = prev[c] as number) cells.push(c)
  cells.reverse()
  const raw = cells.map(centerOf)
  if (!blocked(to.x, to.y)) raw.push({ x: to.x, y: to.y })
  // 줄이기: 지금 자리에서 곧게 보이는 가장 먼 점으로 건너뜁니다
  const out: Point[] = []
  let cur = from
  let i = 0
  while (i < raw.length) {
    let j = raw.length - 1
    while (j > i && !clearLine(cur, raw[j] as Point)) j--
    const p = raw[j] as Point
    out.push(p)
    cur = p
    i = j + 1
  }
  return out
}

/* ── NPC 세계 ── */

const randomLook = () => LOOK_SIZES.map(n => Math.floor(Math.random() * n))
const dirOf = (dx: number, dy: number) => (Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 2 : 3) : dy < 0 ? 1 : 0)
const jitter = (p: Point, r: number): Point => {
  for (let k = 0; k < 6; k++) {
    const q = { x: Math.round(p.x + rand(-r, r)), y: Math.round(p.y + rand(-r / 2, r / 2)) }
    if (!blocked(q.x, q.y)) return q
  }
  return { ...p }
}

export const npcSnapshot = (n: Npc) => ({ id: n.id, nick: n.nick, look: n.look, x: n.x, y: n.y, d: n.d, m: n.moving, s: n.seat, npc: true })

export class NpcWorld {
  private chans = new Map<number, NpcChannel>()
  private host: NpcHost

  constructor(host: NpcHost) {
    this.host = host
    ensureGrid()
    const now = Date.now()
    for (const id of NPC_CHANNELS) {
      const ch: NpcChannel = { id, target: randInt(...rangeOf(id)), nextDrift: now + rand(120_000, 300_000), nextSpawn: 0, lastSay: 0, npcs: new Map() }
      this.chans.set(id, ch)
      // 처음부터 맵 곳곳에 흩어져 있게 (서버가 막 떴을 때도 채널이 비어 보이지 않게)
      for (let i = 0; i < ch.target; i++) this.spawn(ch, now, false)
    }
  }

  list(channel: number): Npc[] {
    return [...(this.chans.get(channel)?.npcs.values() ?? [])]
  }

  count(channel: number): number {
    return this.chans.get(channel)?.npcs.size ?? 0
  }

  seatTaken(channel: number, seat: number): boolean {
    for (const n of this.chans.get(channel)?.npcs.values() ?? []) if (n.seat === seat) return true
    return false
  }

  /** 위치가 바뀐 NPC (이번 묶음 전송에 실을 것). 꺼내면서 표시를 지웁니다 */
  takeDirty(channel: number): Npc[] {
    const out: Npc[] = []
    for (const n of this.chans.get(channel)?.npcs.values() ?? []) {
      if (!n.dirty) continue
      n.dirty = false
      out.push(n)
    }
    return out
  }

  /** 100ms마다 */
  tick(now: number, dt: number) {
    for (const ch of this.chans.values()) {
      if (now >= ch.nextDrift) {
        const [lo, hi] = rangeOf(ch.id)
        ch.target = Math.max(lo, Math.min(hi, ch.target + randInt(-3, 3)))
        ch.nextDrift = now + rand(120_000, 300_000)
      }
      const staying = [...ch.npcs.values()].filter(n => !n.leaving)
      // NPC도 채널 인원(정원 20)에 셉니다: 실제 사람이 늘면 그만큼 NPC가 줄어 자리를 비켜 줍니다
      const room = Math.max(0, this.host.room(ch.id))
      const want = Math.min(ch.target, room)
      // 정원을 넘으면(사람이 막 들어옴) 기다리지 않고 바로 한 명씩 내보냅니다
      const over = ch.npcs.size > room
      if (staying.length < want && now >= ch.nextSpawn) {
        this.spawn(ch, now, true)
        ch.nextSpawn = now + rand(3000, 8000)
      } else if (staying.length > want && (over || now >= ch.nextSpawn)) {
        // 앉아 있지 않은 NPC부터 집에 보냅니다
        const n = staying.find(s => s.seat < 0) ?? staying[0]
        if (n) this.sendHome(ch, n, now)
        ch.nextSpawn = now + (over ? 0 : rand(4000, 9000))
      }
      for (const n of [...ch.npcs.values()]) this.step(ch, n, now, dt)
    }
  }

  private spawn(ch: NpcChannel, now: number, fromGate: boolean) {
    ensureGrid()
    let at: Point = { ...GATE }
    if (!fromGate) {
      const c = pick(reachable)
      if (c != null) at = jitter(centerOf(c), 2)
    }
    const n: Npc = {
      id: `npc_${randomBytes(5).toString('base64url')}`, nick: makeNick(), look: randomLook(),
      x: at.x, y: at.y, d: fromGate ? 1 : randInt(0, 3), moving: false, seat: -1, dirty: false,
      state: 'idle', goal: null, path: [], until: now + (fromGate ? rand(1000, 3000) : rand(2000, 15_000)),
      nextChatter: now + rand(30_000, 120_000), leaving: false,
    }
    ch.npcs.set(n.id, n)
    if (fromGate) this.host.send(ch.id, { t: 'join', p: npcSnapshot(n) })
  }

  private sendHome(ch: NpcChannel, n: Npc, now: number) {
    n.leaving = true
    if (n.seat >= 0) this.stand(ch, n)
    this.walkTo(n, { kind: 'gate', at: GATE }, now)
  }

  private walkTo(n: Npc, goal: Goal, now: number): boolean {
    const path = findPath(n, goal.at)
    if (!path) {
      n.state = 'idle'
      n.until = now + rand(1500, 4000)
      return false
    }
    n.goal = goal
    n.path = path
    n.state = 'walk'
    return true
  }

  /** 다음 목적지 고르기 */
  private chooseGoal(ch: NpcChannel): Goal {
    const live = allShrines().filter(s => s.status === 'live').map(s => PLOTS[s.plot]?.front).filter((p): p is Point => !!p)
    const freeSeats = SEATS.filter(s => !this.seatTaken(ch.id, s.id) && !this.host.seatTaken(ch.id, s.id))
    const fortune = { x: FORTUNE.x + FORTUNE.w + 9, y: FORTUNE.y + FORTUNE.h - 2 }
    const roll = Math.random()
    if (roll < 0.35 && freeSeats.length) {
      const s = pick(freeSeats)
      if (s) return { kind: 'seat', at: s.stand, seat: s.id }
    }
    if (roll < 0.5 && live.length) return { kind: 'shrine', at: jitter(pick(live) as Point, 6) }
    if (roll < 0.62) return { kind: 'ai', at: jitter((pick(AI_SHRINES) ?? AI_SHRINES[0])!.front, 4) }
    if (roll < 0.69) return { kind: 'temple', at: jitter(TEMPLE_FRONT, 6) }
    if (roll < 0.77) return { kind: 'trend', at: jitter(TREND_FRONT, 10) }
    if (roll < 0.83) return { kind: 'registry', at: jitter(REGISTRY_FRONT, 8) }
    if (roll < 0.91) return { kind: 'smoke', at: jitter(SMOKE_FRONT, 8) }
    if (roll < 0.97) return { kind: 'fortune', at: fortune }
    const c = pick(reachable)
    return { kind: 'wander', at: c != null ? jitter(centerOf(c), 2) : { ...GATE } }
  }

  private arrive(ch: NpcChannel, n: Npc, now: number) {
    const g = n.goal
    n.goal = null
    n.moving = false
    n.dirty = true
    if (n.leaving) {
      ch.npcs.delete(n.id)
      this.host.send(ch.id, { t: 'leave', id: n.id })
      return
    }
    n.state = 'idle'
    n.until = now + rand(8000, 20_000)
    switch (g?.kind) {
      case 'seat': {
        const seat = g.seat != null ? SEATS[g.seat] : undefined
        if (seat && !this.seatTaken(ch.id, seat.id) && !this.host.seatTaken(ch.id, seat.id)) {
          n.seat = seat.id
          n.x = seat.x
          n.y = seat.y
          n.d = seat.d
          n.state = 'sit'
          n.until = now + rand(30_000, 90_000)
          n.dirty = false
          this.host.send(ch.id, { t: 'sit', id: n.id, s: seat.id, x: n.x, y: n.y, d: n.d })
        }
        break
      }
      case 'shrine':
      case 'ai':
      case 'temple':
        n.d = 1
        if (Math.random() < 0.6) this.emote(ch, n, 'bow', now)
        n.until = now + rand(8000, 18_000)
        break
      case 'trend':
      case 'registry':
        n.d = 1
        n.until = now + rand(10_000, 22_000)
        break
      case 'smoke':
        n.d = pick([0, 2, 3]) ?? 0
        // 한숨 말풍선은 가끔만 (채널 말풍선 간격도 지킴). i가 없으면 담배만 피우고 말은 안 함
        if (Math.random() < 0.35 && now - ch.lastSay >= NPC_SAY_GAP) {
          ch.lastSay = now
          this.host.send(ch.id, { t: 'emo', id: n.id, k: 'smoke', i: randInt(0, SIGH_COUNT - 1) })
        } else this.host.send(ch.id, { t: 'emo', id: n.id, k: 'smoke' })
        n.nextChatter = Math.max(n.nextChatter, now + 7000)
        n.until = now + rand(10_000, 18_000)
        break
      case 'fortune':
        n.d = 2
        if (Math.random() < 0.5) this.emote(ch, n, 'wave', now)
        n.until = now + rand(5000, 10_000)
        break
    }
  }

  private stand(ch: NpcChannel, n: Npc) {
    const seat = SEATS[n.seat]
    n.seat = -1
    if (!seat) return
    n.x = seat.stand.x
    n.y = seat.stand.y
    this.host.send(ch.id, { t: 'sit', id: n.id, s: -1, x: n.x, y: n.y, d: n.d })
  }

  private emote(ch: NpcChannel, n: Npc, k: string, now: number) {
    this.host.send(ch.id, { t: 'emo', id: n.id, k })
    n.nextChatter = Math.max(n.nextChatter, now + 4000)
  }

  /** 가끔(한 사람당 1~2.5분에 한 번) 고른 말풍선을 띄우거나 손을 흔듭니다.
   * 말풍선은 채널 전체에서 20초에 한 번까지만 (NPC끼리 떠들어 화면이 시끄럽지 않게) */
  private chatter(ch: NpcChannel, n: Npc, now: number) {
    n.nextChatter = now + rand(60_000, 150_000)
    if (Math.random() < 0.35) {
      if (now - ch.lastSay < NPC_SAY_GAP) return
      ch.lastSay = now
      this.host.send(ch.id, { t: 'say', id: n.id, k: randInt(0, BUBBLE_COUNT - 1) })
    } else {
      const k = n.seat >= 0 ? pick(['wave', 'kiss']) : pick(['wave', 'jump', 'kiss'])
      if (k) this.host.send(ch.id, { t: 'emo', id: n.id, k })
    }
  }

  private step(ch: NpcChannel, n: Npc, now: number, dt: number) {
    if (now >= n.nextChatter && n.state !== 'walk') this.chatter(ch, n, now)
    if (n.state === 'sit') {
      if (now >= n.until) {
        this.stand(ch, n)
        n.state = 'idle'
        n.until = now + rand(4000, 10_000)
      }
      return
    }
    if (n.state === 'idle') {
      if (now < n.until) return
      if (n.leaving) {
        this.walkTo(n, { kind: 'gate', at: GATE }, now)
        return
      }
      this.walkTo(n, this.chooseGoal(ch), now)
      return
    }
    // 걷기
    let left = NPC_SPEED * dt
    while (left > 0 && n.path.length) {
      const t = n.path[0] as Point
      const dx = t.x - n.x
      const dy = t.y - n.y
      const len = Math.hypot(dx, dy)
      if (len <= left) {
        n.x = t.x
        n.y = t.y
        left -= len
        n.path.shift()
        if (len > 0.01) n.d = dirOf(dx, dy)
      } else {
        n.x += (dx / len) * left
        n.y += (dy / len) * left
        n.d = dirOf(dx, dy)
        left = 0
      }
    }
    n.x = Math.round(n.x * 10) / 10
    n.y = Math.round(n.y * 10) / 10
    n.moving = n.path.length > 0
    n.dirty = true
    if (!n.path.length) this.arrive(ch, n, now)
  }

  stats() {
    return [...this.chans.values()].map(c => ({ id: c.id, npc: c.npcs.size, target: c.target }))
  }
}
