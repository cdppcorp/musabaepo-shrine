// 실시간: 같은 채널(최대 20명) 사람들이 서로 걷는 모습을 봅니다 (N1).
// 위치는 화면이 보내고 서버가 검사합니다(속도 · 벽). 초 켜기는 사당 앞에 있을 때만 받습니다.
// 채널은 1~3번이 늘 있고, 1번에는 NPC 방문자 6명, 2번에는 3~10명이 거닙니다 (npc.ts).
// NPC도 채널 인원에 셉니다(n/20명). 실제 사람이 들어오면 NPC가 자리를 비켜 주므로 사람 정원은 그대로 20명입니다.
//
// 안정성: 메시지 하나를 처리하다 예외가 나도(DB 쓰기 실패 등) 그 메시지만 버리고 로그를 남깁니다. 서버는 계속 돕니다.
//   같은 사람이 1분에 5번 넘게 오류를 내면 그 연결만 끊습니다(1011).
// 연결을 닫는 코드 (화면 main.js가 보고 다르게 처리합니다):
//   1003 바이너리 · 1008 너무 빠름 · 1011 서버 오류 반복 · 1012 서버 재시작(곧 다시 붙으면 됨)
//   4001 다른 창에서 같은 표로 입장 · 4002 오래 자리 비움(채널이 거의 찼을 때만) · 4003 채널 꽉 참
//   4004 운영자가 강퇴(입장 표 무효) · 4005 차단됨
import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import { config } from './config.ts'
import { cleanChat } from './chat.ts'
import { POST_MAX, addPost, isPostTopic, reportPost } from './ai.ts'
import { addCandle, candleSummary, findShrine, isPrayerKey, type CandleSummary } from './shrines.ts'
import { CandleGuard, TICKET_COOKIE, WindowLimiter, clientIp, ipHash, parseCookies, verifyTicket, type Ticket } from './security.ts'
import {
  BLOCK_MIN_MS, addBlock, addUserReport, blockKey, closeReportsFor, isBlocked, isReportReason, onBlocksChanged, openReportsFor,
  refreshBlocks, rememberVisitor, type BlockView, type ChatLine, type ReportTarget,
} from './moderation.ts'
import { NpcWorld, npcSnapshot } from './npc.ts'
import { AI_SHRINES, blocked, BUBBLE_COUNT, EMOTES, MAP_H, MAP_W, near, nearBox, PLOTS, REACH_SERVER, SEATS, SIGH_COUNT, SMOKE_ZONE, SPAWN, SPEED, TREND_FRONT, TREND_RECT } from './world.ts'

/** 채널당 실제 접속자 수 (NPC는 세지 않음) */
const CHANNEL_MAX = 20
/** 채널은 1~3번만. 모두 차면 더 받지 않습니다 */
const FIXED_CHANNELS = 3
const CAPACITY = CHANNEL_MAX * FIXED_CHANNELS
const MAX_CONNECTIONS = 900
/** IP당 새 연결 시도: 1분에 30번 (동시 연결 수는 config.wsMaxPerIp) */
const CONNECTS_PER_MIN = 30
const MSG_PER_SEC = 15
const MSG_BURST = 30
const SAY_COOLDOWN_MS = 1500
const EMOTE_COOLDOWN_MS = 1000
/** 직접 쓴 메시지: 1분에 12개까지, 같은 말은 15초 안에 다시 못 보냄 */
const CHAT_PER_MIN = 12
const CHAT_REPEAT_MS = 15_000
const MAX_BUFFERED = 256 * 1024
/** 신고할 때 함께 올리는 그 사람의 최근 말풍선 수 (메모리에만) */
const RECENT_LINES = 5
/** 사람 신고: 한 사람 15초에 하나, 1시간에 10개 */
const REPORT_GAP_MS = 15_000
const REPORTS_PER_HOUR = 10
/** 같은 IP에서 같은 사당에 켤 수 있는 초: 1시간에 10개 (사무실 · 통신사 IP를 같이 쓰는 사람들 몫) */
const IP_CANDLES_PER_HOUR = 10
/** 채널이 거의 찼을 때(90%) 이만큼 아무 입력이 없는 사람은 자리를 비워 줍니다 */
const IDLE_MS = 10 * 60_000
/** 한 사람이 1분에 이만큼 서버 오류를 내면 그 연결만 끊습니다 */
const ERRORS_PER_MIN = 5

interface Channel {
  id: number
  players: Map<string, Player>
}

interface Player {
  id: string
  sid: string
  ws: WebSocket
  /** 그날 IP 해시 (security.ts) */
  ipKey: string
  /** 차단용 IP 키 (moderation.ts, 메모리에만) */
  banKey: string
  /** 입장 표가 끝나는 시각 */
  exp: number
  look: number[]
  nick: string
  x: number
  y: number
  d: number
  moving: boolean
  channel: Channel
  dirty: boolean
  /** 이동 허용량 (px). 시간이 지나면 차고, 움직이면 줄어듭니다 */
  budget: number
  lastMoveAt: number
  tokens: number
  tokensAt: number
  lastSay: number
  lastEmote: number
  chatTimes: number[]
  lastChat: string
  lastChatAt: number
  /** 앉아 있는 자리 번호 (-1이면 서 있음) */
  seat: number
  lastPostAt: number
  lastAiPray: number
  alive: boolean
  since: number
  lastInputAt: number
  /** 최근 직접 쓴 말풍선 (신고할 때만 씀, 메모리에만) */
  recent: ChatLine[]
  lastReportAt: number
  reportTimes: number[]
  errorTimes: number[]
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 512, perMessageDeflate: false })
const channels = new Map<number, Channel>()
const bySid = new Map<string, Player>()
const ipConnections = new Map<string, number>()
const connectLimiter = new WindowLimiter(CONNECTS_PER_MIN, 60_000)
const candleGuard = new CandleGuard()
/** `${그날 IP 해시}|${사당}` → 이번 시간에 켠 초 수 */
const ipCandles = new Map<string, { hour: number; n: number }>()
/** AI 기도는 몇 번이든 되지만 너무 잦으면 무시합니다 (ms) */
const AI_PRAY_GAP_MS = 1200
/** 게시판 글: 한 사람 30초에 하나, IP당 하루 20개 */
const POST_GAP_MS = 30_000
const POSTS_PER_DAY = 20
const postsByIp = new Map<string, { day: string; n: number }>()
let total = 0
for (let id = 1; id <= FIXED_CHANNELS; id++) channels.set(id, { id, players: new Map() })
/** NPC 방문자 (startRealtime에서 만듭니다) */
let npcs: NpcWorld | null = null
const timers: NodeJS.Timeout[] = []
let stopping = false

/* ── 오류 기록 (1분에 20줄까지. 채팅 내용 같은 메시지 본문은 남기지 않습니다) ── */

let errWindow = 0
let errLogged = 0
let errSkipped = 0

function logError(where: string, err: unknown) {
  const now = Date.now()
  if (now - errWindow >= 60_000) {
    if (errSkipped) console.error(`[shrine] 실시간 오류 로그 ${errSkipped}건을 건너뛰었습니다 (1분에 20줄까지)`)
    errWindow = now
    errLogged = 0
    errSkipped = 0
  }
  if (errLogged >= 20) {
    errSkipped += 1
    return
  }
  errLogged += 1
  console.error(`[shrine] 실시간 ${where} 실패:`, err instanceof Error ? (err.stack ?? err.message) : err)
}

/** 초 요약: DB를 못 읽으면 마지막으로 읽은 값 */
let lastCandles: CandleSummary | null = null
function candlesNow(): CandleSummary | null {
  try {
    lastCandles = candleSummary()
  } catch (err) {
    logError('초 요약 읽기', err)
  }
  return lastCandles
}

/** 채널 목록: 실제 사람 수와 NPC 수 */
const chanList = () => [...channels.values()].sort((a, b) => a.id - b.id)
  .map(ch => ({ id: ch.id, n: ch.players.size, npc: npcs?.count(ch.id) ?? 0 }))

const snapshot = (p: Player) => ({ id: p.id, nick: p.nick, look: p.look, x: p.x, y: p.y, d: p.d, m: p.moving, s: p.seat })

function send(p: Player, msg: object) {
  if (p.ws.readyState !== WebSocket.OPEN) return
  if (p.ws.bufferedAmount > MAX_BUFFERED) {
    p.ws.terminate()
    return
  }
  p.ws.send(JSON.stringify(msg))
}

function broadcast(ch: Channel, msg: object, except?: Player) {
  const data = JSON.stringify(msg)
  for (const p of ch.players.values()) {
    if (p === except || p.ws.readyState !== WebSocket.OPEN) continue
    if (p.ws.bufferedAmount > MAX_BUFFERED) {
      p.ws.terminate()
      continue
    }
    p.ws.send(data)
  }
}

function broadcastAll(msg: object) {
  for (const ch of channels.values()) broadcast(ch, msg)
}

/** 고른 채널에 자리가 있으면 그곳, 아니면 1번부터 빈 곳. 세 채널이 모두 차면 null */
function pickChannel(want = 0): Channel | null {
  const wanted = channels.get(want)
  if (wanted && want <= FIXED_CHANNELS && wanted.players.size < CHANNEL_MAX) return wanted
  for (let id = 1; id <= FIXED_CHANNELS; id++) {
    const ch = channels.get(id)
    if (ch && ch.players.size < CHANNEL_MAX) return ch
  }
  return null
}

function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return false
  if (config.publicOrigin) return origin === config.publicOrigin
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** HTTP 업그레이드 요청을 받아 검사한 뒤 WebSocket으로 넘깁니다 */
export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const reject = (code: number, text: string) => {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    socket.destroy()
  }
  if (stopping) return reject(503, 'Service Unavailable')
  if (!originAllowed(req)) return reject(403, 'Forbidden')
  const ticket = verifyTicket(parseCookies(req.headers.cookie)[TICKET_COOKIE])
  if (!ticket) return reject(401, 'Unauthorized')
  const ip = clientIp(req)
  const ipKey = ipHash(ip)
  const banKey = blockKey(ip)
  rememberVisitor(ipKey, banKey)
  // 같은 IP의 연결 폭주는 막되, 동시 연결 수는 넉넉히 (여러 사람이 IP 하나를 같이 쓰는 경우)
  if (!connectLimiter.allow(ipKey)) return reject(429, 'Too Many Requests')
  // 막힌 사람은 연결을 받은 뒤 4005로 닫아서 화면이 이유를 알 수 있게 합니다
  if (isBlocked(banKey, ticket.sid)) return wss.handleUpgrade(req, socket, head, ws => ws.close(4005, 'blocked'))
  if (total >= MAX_CONNECTIONS) return reject(503, 'Service Unavailable')
  if ((ipConnections.get(ipKey) ?? 0) >= config.wsMaxPerIp) return reject(429, 'Too Many Requests')
  // ?ch=N (1~3): 들어갈 채널 고르기
  let want = 0
  try {
    want = Number(new URL(req.url ?? '', 'http://x').searchParams.get('ch')) || 0
  } catch { /* 잘못된 주소면 자동 배정 */ }
  if (!Number.isInteger(want) || want < 1 || want > FIXED_CHANNELS) want = 0
  // 세 채널이 모두 차면 받지 않습니다
  if (!pickChannel(want)) return reject(503, 'Service Unavailable')
  wss.handleUpgrade(req, socket, head, ws => {
    try {
      onConnect(ws, ticket, ipKey, banKey, want)
    } catch (err) {
      logError('입장 처리', err)
      ws.terminate()
    }
  })
}

function spawnPoint() {
  for (let i = 0; i < 20; i++) {
    const x = SPAWN.x + Math.round((Math.random() - 0.5) * 60)
    const y = SPAWN.y + Math.round((Math.random() - 0.5) * 24)
    if (!blocked(x, y)) return { x, y }
  }
  return { ...SPAWN }
}

function onConnect(ws: WebSocket, t: Ticket, ipKey: string, banKey: string, want = 0) {
  bySid.get(t.sid)?.ws.close(4001, 'replaced')

  const channel = pickChannel(want)
  if (!channel) {
    ws.close(4003, 'full')
    return
  }
  total += 1
  ipConnections.set(ipKey, (ipConnections.get(ipKey) ?? 0) + 1)
  const now = Date.now()
  const at = spawnPoint()
  const p: Player = {
    id: randomBytes(6).toString('base64url'), sid: t.sid, ws, ipKey, banKey, exp: t.exp, look: t.look, nick: t.nick,
    x: at.x, y: at.y, d: 0, moving: false, channel, dirty: false, budget: SPEED, lastMoveAt: now,
    tokens: MSG_BURST, tokensAt: now, lastSay: 0, lastEmote: 0, chatTimes: [], lastChat: '', lastChatAt: 0, seat: -1, lastPostAt: 0, lastAiPray: 0, alive: true,
    since: now, lastInputAt: now, recent: [], lastReportAt: 0, reportTimes: [], errorTimes: [],
  }
  channel.players.set(p.id, p)
  bySid.set(t.sid, p)
  // 아래에서 예외가 나도 자리 정리가 되도록 리스너를 먼저 붙입니다
  ws.on('message', (data, isBinary) => {
    try {
      onMessage(p, data, isBinary)
    } catch (err) {
      onHandlerError(p, '?', err)
    }
  })
  ws.on('pong', () => { p.alive = true })
  ws.on('close', () => {
    try {
      onClose(p)
    } catch (err) {
      logError('연결 정리', err)
    }
  })
  ws.on('error', () => undefined)

  send(p, {
    t: 'hello', id: p.id, channel: channel.id, max: CHANNEL_MAX, me: snapshot(p),
    players: [...[...channel.players.values()].filter(o => o !== p).map(snapshot), ...(npcs?.list(channel.id) ?? []).map(npcSnapshot)],
    candles: candlesNow(),
    channels: chanList(),
    chat: { free: config.freeChat },
  })
  broadcast(channel, { t: 'join', p: snapshot(p) }, p)
}

function onClose(p: Player) {
  // 같은 연결에서 두 번 오지 않게
  if (!p.channel.players.has(p.id)) return
  total -= 1
  const n = (ipConnections.get(p.ipKey) ?? 1) - 1
  if (n > 0) ipConnections.set(p.ipKey, n)
  else ipConnections.delete(p.ipKey)
  if (bySid.get(p.sid) === p) bySid.delete(p.sid)
  p.channel.players.delete(p.id)
  broadcast(p.channel, { t: 'leave', id: p.id })
  if (p.channel.players.size === 0 && p.channel.id > FIXED_CHANNELS) channels.delete(p.channel.id)
}

/** 메시지 처리 중 예외: 로그만 남기고, 같은 사람이 계속 내면 그 연결만 끊습니다 */
function onHandlerError(p: Player, type: string, err: unknown) {
  logError(`메시지 처리(${type})`, err)
  const now = Date.now()
  p.errorTimes = p.errorTimes.filter(t => now - t < 60_000)
  p.errorTimes.push(now)
  if (p.errorTimes.length >= ERRORS_PER_MIN && p.ws.readyState === WebSocket.OPEN) p.ws.close(1011, 'error')
}

/** 초당 메시지 수 제한 (토큰 버킷). 넘으면 연결을 끊습니다. */
function takeToken(p: Player): boolean {
  const now = Date.now()
  p.tokens = Math.min(MSG_BURST, p.tokens + ((now - p.tokensAt) / 1000) * MSG_PER_SEC)
  p.tokensAt = now
  if (p.tokens < 1) return false
  p.tokens -= 1
  return true
}

function onMessage(p: Player, data: RawData, isBinary: boolean) {
  if (isBinary) return p.ws.close(1003, 'binary')
  if (!takeToken(p)) return p.ws.close(1008, 'rate')
  let m: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(data.toString())
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    m = parsed as Record<string, unknown>
  } catch {
    return
  }
  const type = typeof m.t === 'string' ? m.t.slice(0, 12) : '?'
  p.lastInputAt = Date.now()
  try {
    dispatch(p, m)
  } catch (err) {
    onHandlerError(p, type, err)
  }
}

function dispatch(p: Player, m: Record<string, unknown>) {
  switch (m.t) {
    case 'mv': return onMove(p, m)
    case 'say': return onSay(p, m)
    case 'emo': return onEmote(p, m)
    case 'chat': return onChat(p, m)
    case 'sit': return onSit(p, m)
    case 'aipray': return onAiPray(p, m)
    case 'post': return onPost(p, m)
    case 'report': return onReport(p, m)
    case 'reportUser': return onReportUser(p, m)
    case 'light': return onLight(p, m)
    case 'chans': return send(p, { t: 'chans', list: chanList() })
  }
}

function onMove(p: Player, m: Record<string, unknown>) {
  const x = Number(m.x)
  const y = Number(m.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  // 앉은 채로 움직이면 먼저 일으켜 세웁니다 (화면은 보통 일어나기를 먼저 보냄)
  if (p.seat >= 0) standUp(p)
  const now = Date.now()
  p.budget = Math.min(SPEED * 1.2, p.budget + (SPEED * 1.5 * (now - p.lastMoveAt)) / 1000)
  p.lastMoveAt = now
  const dist = Math.hypot(x - p.x, y - p.y)
  if (dist > p.budget + 6 || x < 0 || y < 0 || x > MAP_W || y > MAP_H || blocked(x, y)) {
    send(p, { t: 'fix', x: p.x, y: p.y })
    return
  }
  p.budget -= dist
  p.x = Math.round(x * 10) / 10
  p.y = Math.round(y * 10) / 10
  const d = Number(m.d)
  if (Number.isInteger(d) && d >= 0 && d <= 3) p.d = d
  p.moving = m.m === true
  p.dirty = true
}

function onSay(p: Player, m: Record<string, unknown>) {
  const k = Number(m.k)
  const now = Date.now()
  if (!Number.isInteger(k) || k < 0 || k >= BUBBLE_COUNT || now - p.lastSay < SAY_COOLDOWN_MS) return
  p.lastSay = now
  broadcast(p.channel, { t: 'say', id: p.id, k })
}

/** AI 신당 기도: 그 신당 앞에서만, AI별 하루 한 번. 모두에게 새 기도 수를 알립니다 */
function onAiPray(p: Player, m: Record<string, unknown>) {
  const shrine = AI_SHRINES.find(a => a.key === m.a)
  if (!shrine) return
  // 신당 앞 · 뒤 · 옆 어디든 근처면 됩니다
  if (!nearBox(p, shrine.box, REACH_SERVER)) return send(p, { t: 'aiNo', a: shrine.key, reason: 'far' })
  // 몇 번이든 기도할 수 있고, 어디에도 기록하지 않습니다. 같은 채널 사람들에게 빛나는 연출만 알립니다
  const now = Date.now()
  if (now - p.lastAiPray < AI_PRAY_GAP_MS) return
  p.lastAiPray = now
  broadcast(p.channel, { t: 'aipray', a: shrine.key, by: p.id })
}

/** AI 트렌드 게시판 글쓰기: 게시판 앞에서만. 거르는 규칙은 채팅과 같고 길이만 80자 */
function onPost(p: Player, m: Record<string, unknown>) {
  // 게시판은 BOARD_OPEN=on일 때만 엽니다 (기본은 '준비 중')
  if (!config.boardOpen) return send(p, { t: 'postNo', reason: 'closed' })
  if (!config.freeChat) return send(p, { t: 'postNo', reason: 'off' })
  if (!nearBox(p, TREND_RECT, REACH_SERVER)) return send(p, { t: 'postNo', reason: 'far' })
  if (!isPostTopic(m.a)) return send(p, { t: 'postNo', reason: 'topic' })
  const now = Date.now()
  if (now - p.lastPostAt < POST_GAP_MS) return send(p, { t: 'postNo', reason: 'slow' })
  const day = new Date(now + 9 * 3600_000).toISOString().slice(0, 10)
  const used = postsByIp.get(p.ipKey)
  if (used && used.day === day && used.n >= POSTS_PER_DAY) return send(p, { t: 'postNo', reason: 'many' })
  const v = cleanChat(m.s, POST_MAX)
  if (!v.ok) return send(p, { t: 'postNo', reason: v.reason })
  let post
  try {
    post = addPost(m.a, v.text, p.nick)
  } catch (err) {
    logError('게시판 글 저장', err)
    return send(p, { t: 'postNo', reason: 'error' })
  }
  p.lastPostAt = now
  postsByIp.set(p.ipKey, { day, n: used && used.day === day ? used.n + 1 : 1 })
  send(p, { t: 'postOk', id: post.id })
  broadcastAll({ t: 'post', post })
}

/** 게시판 글 신고: 서로 다른 사람(IP 해시) 3명이면 숨기고 모두에게 알립니다. 게시판이 닫혀 있으면 { t: 'reportNo', reason: 'closed' } */
function onReport(p: Player, m: Record<string, unknown>) {
  const id = Number(m.id)
  if (!config.boardOpen) return send(p, { t: 'reportNo', id: Number.isInteger(id) ? id : 0, reason: 'closed' })
  if (!Number.isInteger(id) || id <= 0) return
  const r = reportPost(id, p.ipKey)
  if (r === 'none') return
  send(p, { t: 'reported', id })
  if (r === 'hidden') broadcastAll({ t: 'postHide', id })
}

/** 신고 대상 정보 (운영자 화면 · 차단에 씀. 화면에는 sid · IP 키를 내보내지 않습니다) */
const targetOf = (p: Player): ReportTarget => ({ pid: p.id, sid: p.sid, ipKey: p.banKey, nick: p.nick, channel: p.channel.id, exp: p.exp })

/**
 * 사람 신고: { t: 'reportUser', id: 상대 id, r: 'abuse' | 'spam' | 'lewd' | 'other' }
 * 같은 채널의 실제 사람만. 그 사람의 최근 말풍선 몇 개와 함께 운영자 화면에 올리고 운영자에게 알립니다.
 * 답: { t: 'reportUserOk', id, again } 또는 { t: 'reportUserNo', id, reason: 'none' | 'self' | 'slow' }
 */
function onReportUser(p: Player, m: Record<string, unknown>) {
  const id = typeof m.id === 'string' ? m.id.slice(0, 16) : ''
  const target = id ? p.channel.players.get(id) : undefined
  if (!target) return send(p, { t: 'reportUserNo', id, reason: 'none' })
  if (target === p) return send(p, { t: 'reportUserNo', id, reason: 'self' })
  const now = Date.now()
  p.reportTimes = p.reportTimes.filter(t => now - t < 3600_000)
  if (now - p.lastReportAt < REPORT_GAP_MS || p.reportTimes.length >= REPORTS_PER_HOUR) return send(p, { t: 'reportUserNo', id, reason: 'slow' })
  p.lastReportAt = now
  p.reportTimes.push(now)
  const r = addUserReport(targetOf(target), p.ipKey, isReportReason(m.r) ? m.r : 'other', target.recent)
  send(p, { t: 'reportUserOk', id, again: r.again })
}

/** 앉기 · 일어나기. 의자 가까이에서만, 다른 사람이 앉은 자리는 안 됩니다 */
function onSit(p: Player, m: Record<string, unknown>) {
  const s = Number(m.s)
  if (s === -1) return standUp(p)
  const seat = Number.isInteger(s) ? SEATS[s] : undefined
  if (!seat || p.seat === s) return
  if (!near(p, seat, 26)) return send(p, { t: 'sitNo', reason: 'far' })
  for (const o of p.channel.players.values()) {
    if (o !== p && o.seat === s) return send(p, { t: 'sitNo', reason: 'taken' })
  }
  if (npcs?.seatTaken(p.channel.id, s)) return send(p, { t: 'sitNo', reason: 'taken' })
  p.seat = s
  p.x = seat.x
  p.y = seat.y
  p.d = seat.d
  p.moving = false
  p.budget = 0
  broadcast(p.channel, { t: 'sit', id: p.id, s, x: p.x, y: p.y, d: p.d })
}

function standUp(p: Player) {
  const seat = SEATS[p.seat]
  if (!seat) return
  p.seat = -1
  p.x = seat.stand.x
  p.y = seat.stand.y
  p.moving = false
  p.lastMoveAt = Date.now()
  broadcast(p.channel, { t: 'sit', id: p.id, s: -1, x: p.x, y: p.y, d: p.d })
}

/** 직접 쓴 메시지: 검사를 통과하면 같은 채널에 말풍선으로만 뿌리고, 디스크에는 남기지 않습니다 (신고용으로 최근 몇 개만 메모리에) */
function onChat(p: Player, m: Record<string, unknown>) {
  if (!config.freeChat) return send(p, { t: 'chatNo', reason: 'off' })
  const now = Date.now()
  p.chatTimes = p.chatTimes.filter(t => now - t < 60_000)
  if (now - p.lastSay < SAY_COOLDOWN_MS || p.chatTimes.length >= CHAT_PER_MIN) return send(p, { t: 'chatNo', reason: 'slow' })
  const v = cleanChat(m.s)
  if (!v.ok) return send(p, { t: 'chatNo', reason: v.reason })
  if (v.text === p.lastChat && now - p.lastChatAt < CHAT_REPEAT_MS) return send(p, { t: 'chatNo', reason: 'same' })
  p.lastSay = now
  p.lastChat = v.text
  p.lastChatAt = now
  p.chatTimes.push(now)
  p.recent.push({ at: now, s: v.text })
  if (p.recent.length > RECENT_LINES) p.recent.shift()
  broadcast(p.channel, { t: 'chat', id: p.id, s: v.text })
}

function onEmote(p: Player, m: Record<string, unknown>) {
  const k = m.k
  const now = Date.now()
  if (typeof k !== 'string' || !(EMOTES as readonly string[]).includes(k) || now - p.lastEmote < EMOTE_COOLDOWN_MS) return
  if (k === 'smoke') {
    // 흡연은 '고뇌와 번뇌의 공간' 안에서만
    if (!near(p, SMOKE_ZONE, SMOKE_ZONE.r)) return send(p, { t: 'emoNo', k, reason: 'zone' })
    const i = Number(m.i)
    p.lastEmote = now
    return broadcast(p.channel, { t: 'emo', id: p.id, k, i: Number.isInteger(i) && i >= 0 && i < SIGH_COUNT ? i : 0 })
  }
  p.lastEmote = now
  broadcast(p.channel, { t: 'emo', id: p.id, k })
}

function onLight(p: Player, m: Record<string, unknown>) {
  const slug = typeof m.s === 'string' ? m.s.slice(0, 40) : ''
  const shrine = findShrine(slug)
  if (!shrine || shrine.status !== 'live') return send(p, { t: 'lit', s: slug, ok: false, reason: 'closed' })
  if (!isPrayerKey(m.p)) return send(p, { t: 'lit', s: slug, ok: false, reason: 'prayer' })
  const prayer = m.p
  const plot = PLOTS[shrine.plot]
  if (!plot || !nearBox(p, plot.box, REACH_SERVER)) return send(p, { t: 'lit', s: slug, ok: false, reason: 'far' })
  // 같은 IP(사무실 · 통신사)에서 같은 사당은 시간당 상한만 둡니다
  const hour = Math.floor(Date.now() / 3_600_000)
  const ipSlot = `${p.ipKey}|${slug}`
  const used = ipCandles.get(ipSlot)
  if (used && used.hour === hour && used.n >= IP_CANDLES_PER_HOUR) return send(p, { t: 'lit', s: slug, ok: false, reason: 'busy' })
  // 같은 사당은 한 사람(입장 표) 30분에 한 번. wait = 이 사당에 다시 켤 수 있을 때까지 남은 초 (켰을 때 · 이미 켰을 때)
  const { verdict, waitMs } = candleGuard.check([`s:${p.sid}`], slug)
  const wait = Math.ceil(waitMs / 1000)
  if (verdict === 'already') return send(p, { t: 'lit', s: slug, ok: false, reason: verdict, wait })
  if (verdict !== 'ok') return send(p, { t: 'lit', s: slug, ok: false, reason: verdict })
  try {
    addCandle(slug, prayer)
  } catch (err) {
    // 디스크가 차거나 잠긴 경우. 이 사람만 실패를 알리고 서버는 계속 돕니다
    logError('초 기록', err)
    return send(p, { t: 'lit', s: slug, ok: false, reason: 'error' })
  }
  ipCandles.set(ipSlot, { hour, n: used && used.hour === hour ? used.n + 1 : 1 })
  const sum = candlesNow()
  send(p, { t: 'lit', s: slug, ok: true, p: prayer, wait })
  if (sum) broadcastAll({ t: 'candle', s: slug, n: sum.week[slug] ?? 0, weekTotal: sum.weekTotal, today: sum.today, by: p.id, p: prayer })
}

/* ── 운영자 화면 · 차단 ── */

function allPlayers(): Player[] {
  return [...channels.values()].flatMap(ch => [...ch.players.values()])
}

const findPlayer = (id: unknown) => (typeof id === 'string' ? allPlayers().find(p => p.id === id) : undefined)

/** 차단 목록이 바뀌면 접속 중인 사람 중 막힌 사람을 내보냅니다 (4005) */
function enforceBlocks() {
  for (const p of allPlayers()) {
    if (p.ws.readyState === WebSocket.OPEN && isBlocked(p.banKey, p.sid)) p.ws.close(4005, 'blocked')
  }
}

/** 운영자 화면: 채널별 접속자 (닉네임 · 들어온 시각 · 마지막 입력 · 같은 IP 연결 수 · 열린 신고 수). IP · sid는 내보내지 않습니다 */
export function playersForAdmin() {
  const now = Date.now()
  return [...channels.values()].sort((a, b) => a.id - b.id).map(ch => ({
    id: ch.id,
    npc: npcs?.count(ch.id) ?? 0,
    players: [...ch.players.values()].sort((a, b) => a.since - b.since).map(p => ({
      id: p.id, nick: p.nick, since: p.since, idleSec: Math.round((now - p.lastInputAt) / 1000), seated: p.seat >= 0,
      sameIp: ipConnections.get(p.ipKey) ?? 1, reports: openReportsFor(p.sid),
    })),
  }))
}

export const isOnline = (sid: string) => bySid.has(sid)

/** 강퇴: 지금 끊고(4004) 그 입장 표를 끝날 때까지 무효로. 없는 사람이면 null */
export function kickPlayer(id: unknown, reason: unknown): { nick: string; block: BlockView } | null {
  const p = findPlayer(id)
  if (!p) return null
  if (p.ws.readyState === WebSocket.OPEN) p.ws.close(4004, 'kicked')
  const block = addBlock({ kind: 'kick', sid: p.sid, ms: Math.max(BLOCK_MIN_MS, Math.min(p.exp - Date.now(), 3 * 3600_000)), nick: p.nick, reason })
  closeReportsFor(p.sid, 'kicked')
  return { nick: p.nick, block }
}

/** 차단 (입장 표, 원하면 IP까지). 대상: 접속자 id나 신고에서 꺼낸 대상. 걸리는 사람은 바로 4005로 끊깁니다 */
export function blockTarget(t: ReportTarget, ms: number, byIp: boolean, reason: unknown): BlockView {
  const block = addBlock({ kind: 'block', ipKey: byIp ? t.ipKey : undefined, sid: t.sid, ms, nick: t.nick, reason })
  closeReportsFor(t.sid, 'blocked')
  return block
}

export function blockPlayer(id: unknown, ms: number, byIp: boolean, reason: unknown): { nick: string; block: BlockView } | null {
  const p = findPlayer(id)
  if (!p) return null
  return { nick: p.nick, block: blockTarget(targetOf(p), ms, byIp, reason) }
}

/** 직접 쓰는 채팅 켜고 끄기 (서버를 다시 띄우면 .env의 FREE_CHAT으로 돌아갑니다). 접속 중인 화면에 알립니다 */
export function setFreeChat(on: boolean) {
  config.freeChat = on
  broadcastAll({ t: 'chatMode', free: on })
}

/* ── 주기 작업 ── */

/** 위치 묶음 전송(초당 10번), 끊긴 연결 정리(25초마다), 차단 · 자리 비움 · 메모리 정리(5초마다) */
export function startRealtime() {
  npcs = new NpcWorld({
    send: (id, msg) => {
      const ch = channels.get(id)
      if (ch && ch.players.size) broadcast(ch, msg)
    },
    seatTaken: (id, seat) => [...(channels.get(id)?.players.values() ?? [])].some(o => o.seat === seat),
    room: id => CHANNEL_MAX - (channels.get(id)?.players.size ?? 0),
  })
  onBlocksChanged(enforceBlocks)
  let last = Date.now()
  timers.push(setInterval(() => {
    try {
      const now = Date.now()
      npcs?.tick(now, Math.min(0.25, (now - last) / 1000))
      last = now
      for (const ch of channels.values()) {
        const moved = [...ch.players.values()].filter(p => p.dirty)
        for (const p of moved) p.dirty = false
        const movedNpc = npcs?.takeDirty(ch.id) ?? []
        if ((!moved.length && !movedNpc.length) || !ch.players.size) continue
        broadcast(ch, {
          t: 'st',
          ps: [...moved, ...movedNpc].map(p => [p.id, p.x, p.y, p.d, p.moving ? 1 : 0]),
        })
      }
    } catch (err) {
      logError('위치 전송', err)
    }
  }, 100).unref())

  timers.push(setInterval(() => {
    try {
      for (const p of allPlayers()) {
        if (!p.alive) {
          p.ws.terminate()
          continue
        }
        p.alive = false
        p.ws.ping()
      }
    } catch (err) {
      logError('연결 확인', err)
    }
  }, 25_000).unref())

  let prunedAt = Date.now()
  timers.push(setInterval(() => {
    try {
      const now = Date.now()
      // 운영 도구(다른 프로세스)가 바꾼 차단을 읽어 오면 onBlocksChanged → enforceBlocks
      refreshBlocks()
      // 채널이 거의 찼을 때만, 오래 아무것도 안 한 사람의 자리를 비웁니다
      if (total >= Math.ceil(CAPACITY * 0.9)) {
        for (const p of allPlayers()) if (now - p.lastInputAt > IDLE_MS && p.ws.readyState === WebSocket.OPEN) p.ws.close(4002, 'idle')
      }
      if (now - prunedAt >= 3600_000) {
        prunedAt = now
        const hour = Math.floor(now / 3_600_000)
        for (const [k, v] of ipCandles) if (v.hour !== hour) ipCandles.delete(k)
        const day = new Date(now + 9 * 3600_000).toISOString().slice(0, 10)
        for (const [k, v] of postsByIp) if (v.day !== day) postsByIp.delete(k)
      }
    } catch (err) {
      logError('정리 작업', err)
    }
  }, 5_000).unref())
}

/**
 * 끝낼 때: 새 연결을 받지 않고, 모든 연결에 1012(서버 재시작)를 보낸 뒤 닫힐 때까지 기다립니다.
 * timeoutMs 안에 안 닫히면 끊어 버립니다. 화면은 1012를 받으면 잠시 뒤 다시 붙습니다.
 */
export function stopRealtime(timeoutMs = 3000): Promise<void> {
  stopping = true
  for (const t of timers) clearInterval(t)
  timers.length = 0
  const sockets = [...wss.clients]
  for (const ws of sockets) {
    try {
      ws.close(1012, 'restart')
    } catch {
      ws.terminate()
    }
  }
  return new Promise(resolve => {
    const open = sockets.filter(ws => ws.readyState !== WebSocket.CLOSED)
    let left = open.length
    if (!left) return resolve()
    const timer = setTimeout(() => {
      for (const ws of open) ws.terminate()
      resolve()
    }, timeoutMs)
    for (const ws of open) {
      ws.once('close', () => {
        left -= 1
        if (left <= 0) {
          clearTimeout(timer)
          resolve()
        }
      })
    }
  })
}

export const realtimeStats = () => ({ connections: total, channels: channels.size, npcs: npcs?.stats() ?? [] })

/** 운영자 화면: 채널별 실제 사람 수(n)와 NPC 수 */
export const channelStats = () => ({ connections: total, channels: chanList() })
