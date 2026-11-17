// 차단 · 강퇴 · 사람 신고 (운영자용).
//
// 차단(block): 입장 표(sid)나 IP 키로 겁니다. 기간이 있고(1분 ~ 90일), 기간이 끝나면 기록을 지웁니다.
//   · IP 키 = HMAC(서버 키, IP). IPv6는 /64 대역으로 묶습니다. 원래 IP는 어디에도 두지 않고,
//     키도 차단한 사람 것만 차단 기간 동안 DB에 둡니다. 다른 접속자는 security.ts의 '그날만 쓰는 해시'로만 다룹니다.
//   · 서버 키는 TICKET_SECRET에서 용도별로 따로 만듭니다. 그래서 TICKET_SECRET을 바꾸면 IP 차단은 모두 풀립니다.
//   · 통신사 CGNAT · 회사 · 행사장 Wi-Fi처럼 여러 사람이 IP 하나를 같이 쓰면 IP 차단이 그 사람들도 막습니다.
//     IP 차단은 짧게 걸고, 오래 막아야 할 때만 길게 겁니다.
// 강퇴(kick): 지금 연결을 끊고 그 입장 표를 무효로 합니다 (입장 표가 끝나는 시각까지 sid 차단).
//   다시 들어오려면 사람 확인부터 다시 해야 합니다.
// 사람 신고: 접속자가 다른 접속자를 신고하면 그 사람의 최근 말풍선 몇 개(메모리에만 있던 것)와 함께 운영자 화면에 올립니다.
//   신고는 메모리에만 두고(최대 200건, 24시간) DB에 남기지 않습니다. 알림(notify)에는 말풍선 내용을 넣지 않습니다.
//
// 다른 파일에서: isBlocked(clientIp(req), ticket?.sid)
//   · 첫 값은 원래 IP(clientIp)나 blockKey(ip)를 넘깁니다. 원래 IP는 여기서 바로 키로 바꾸고 어디에도 두지 않습니다.
//   · security.ts의 그날 해시(ipHash)를 넘기면, 오늘 WebSocket으로 들어오려 한 적 있는 IP만 알아봅니다 (예비 경로).
// 운영 도구(cli.ts)처럼 다른 프로세스가 바꾼 차단은 PRAGMA data_version으로 알아채 10초 안에 다시 읽습니다.
import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'
import { config } from './config.ts'
import { db } from './db.ts'
import { notify } from './notify.ts'
import { kstDate } from './util.ts'

export type BlockKind = 'kick' | 'block'

export const BLOCK_MIN_MS = 60_000
export const BLOCK_MAX_MS = 90 * 24 * 3600_000
/** 입장 표 수명(security.ts TICKET_TTL_MS)과 같은 3시간. 강퇴는 이보다 길 필요가 없습니다 */
const KICK_MAX_MS = 3 * 3600_000
const REASON_MAX = 80
const REFRESH_MS = 10_000
const PRUNE_MS = 3600_000
const KEY_RE = /^k:[A-Za-z0-9_-]{32}$/
const SID_RE = /^[A-Za-z0-9_:-]{8,64}$/

export class ModerationError extends Error {}

/** 운영 화면 · 운영 도구에 보여 주는 차단 한 줄 (IP 키 원문은 앞 몇 글자만) */
export interface BlockView {
  id: number
  at: number
  until: number
  kind: BlockKind
  byIp: boolean
  bySid: boolean
  /** 표시용 짧은 꼬리표 (같은 대상인지 견줄 때만) */
  tag: string
  nick: string
  reason: string
}

interface BlockRow {
  id: number
  at: number
  until: number
  kind: BlockKind
  ip_key: string
  sid: string
  nick: string
  reason: string
}

/* ── IP 키 ── */

const ipKeyMac = createHmac('sha256', config.ticketSecret).update('shrine-block-ip\0').digest()

/** IPv6 앞 64비트 (2001:db8:1:2::/64 모양) */
function ipv6Prefix64(v: string): string {
  let s = v
  // 끝에 IPv4가 붙은 모양(64:ff9b::1.2.3.4 같은)은 16진 두 묶음으로 바꿉니다
  const m = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s)
  if (m) {
    const [a, b, c, d] = [m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number]
    s = `${m[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const parts = s.split('::')
  const head = parts[0] ? parts[0].split(':') : []
  const tail = parts.length > 1 && parts[1] ? parts[1].split(':') : []
  const groups = parts.length > 1 ? [...head, ...new Array<string>(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head
  return `${groups.slice(0, 4).map(g => parseInt(g || '0', 16).toString(16)).join(':')}::/64`
}

/** 비교용 IP 모양: IPv4는 그대로, IPv6에 담긴 IPv4는 IPv4로, IPv6는 /64 대역으로. IP가 아니면 null */
export function normalizeIp(raw: string): string | null {
  let v = raw.trim().toLowerCase()
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1)
  const zone = v.indexOf('%')
  if (zone > 0) v = v.slice(0, zone)
  if (v.startsWith('::ffff:') && isIP(v.slice(7)) === 4) v = v.slice(7)
  const family = isIP(v)
  if (family === 4) return v
  if (family === 6) return ipv6Prefix64(v)
  return null
}

/** 차단용 IP 키 (서버 키로 만든 HMAC). IP가 아니면 '' */
export function blockKey(ip: string): string {
  const n = normalizeIp(ip)
  if (!n) return ''
  return `k:${createHmac('sha256', ipKeyMac).update(n).digest('base64url').slice(0, 32)}`
}

/* ── 그날 해시 → IP 키 (예비 경로, 메모리에만) ── */

const dailyKeys = new Map<string, string>()
let dailyDay = ''

/** realtime.ts가 WebSocket 업그레이드 때 알려 줍니다 (그날 해시와 IP 키를 같이 아는 곳) */
export function rememberVisitor(dailyHash: string, key: string) {
  if (!dailyHash || !key) return
  const day = kstDate()
  if (day !== dailyDay || dailyKeys.size > 20_000) {
    dailyKeys.clear()
    dailyDay = day
  }
  dailyKeys.set(dailyHash, key)
}

/** 넘겨받은 값을 IP 키로: IP 키면 그대로, 원래 IP면 바꾸고, 그날 해시면 오늘 본 것만 */
function toKey(v: string | undefined): string {
  if (!v) return ''
  if (KEY_RE.test(v)) return v
  const fromIp = blockKey(v)
  if (fromIp) return fromIp
  return dailyDay === kstDate() ? (dailyKeys.get(v) ?? '') : ''
}

/* ── 차단 목록 (메모리 사본 + DB) ── */

const byIp = new Map<string, number>()
const bySid = new Map<string, number>()
/** DB에 못 쓴 차단 (이번 실행 동안만) */
const memOnly: { ipKey: string; sid: string; until: number }[] = []
let seenVersion = -1
let checkedAt = 0
let prunedAt = 0
const listeners = new Set<() => void>()

/** 차단이 바뀌면(이 서버에서든 운영 도구에서든) 부릅니다. realtime.ts가 접속 중인 사람을 다시 봅니다 */
export function onBlocksChanged(fn: () => void) {
  listeners.add(fn)
}

function changed() {
  for (const fn of listeners) {
    try {
      fn()
    } catch (e) {
      console.error('[shrine] 차단 반영 실패:', e)
    }
  }
}

function put(map: Map<string, number>, key: string, until: number) {
  if (key && until > (map.get(key) ?? 0)) map.set(key, until)
}

function load(now: number) {
  byIp.clear()
  bySid.clear()
  const rows = db.prepare('SELECT ip_key, sid, until FROM blocks WHERE until > ?').all(now) as unknown as { ip_key: string; sid: string; until: number }[]
  for (const r of rows) {
    put(byIp, r.ip_key, r.until)
    put(bySid, r.sid, r.until)
  }
  for (let i = memOnly.length - 1; i >= 0; i--) {
    const m = memOnly[i]!
    if (m.until <= now) memOnly.splice(i, 1)
    else {
      put(byIp, m.ipKey, m.until)
      put(bySid, m.sid, m.until)
    }
  }
}

function dataVersion(): number {
  return Number((db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version)
}

/**
 * 다른 프로세스(운영 도구)가 DB를 바꿨으면 다시 읽습니다. 10초에 한 번만 봅니다 (force면 바로).
 * 다시 읽었으면 true. DB가 안 되면 지금 메모리 사본을 그대로 씁니다.
 */
export function refreshBlocks(force = false): boolean {
  const now = Date.now()
  if (!force && now - checkedAt < REFRESH_MS) return false
  checkedAt = now
  try {
    if (now - prunedAt >= PRUNE_MS) {
      prunedAt = now
      db.prepare('DELETE FROM blocks WHERE until <= ?').run(now)
    }
    const v = dataVersion()
    if (!force && v === seenVersion) return false
    seenVersion = v
    load(now)
  } catch (e) {
    console.error('[shrine] 차단 목록을 다시 읽지 못했습니다 (지금 목록을 계속 씁니다):', (e as Error).message)
    return false
  }
  changed()
  return true
}

/**
 * 막힌 사람인지. ipKey: 원래 IP · blockKey(ip) · (예비로) 그날 해시. sid: 입장 표의 sid.
 * 요청마다 불러도 됩니다 (메모리 사본을 봄). 어떤 경우에도 throw하지 않습니다.
 */
export function isBlocked(ipKey: string, sid?: string): boolean {
  try {
    refreshBlocks()
    const now = Date.now()
    if (sid && (bySid.get(sid) ?? 0) > now) return true
    const key = toKey(ipKey)
    return !!key && (byIp.get(key) ?? 0) > now
  } catch {
    return false
  }
}

function cleanReason(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return [...raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()].slice(0, REASON_MAX).join('')
}

function tagOf(ipKey: string, sid: string): string {
  return ipKey ? `ip ${ipKey.slice(2, 8)}` : sid ? `표 ${sid.slice(0, 8)}` : '-'
}

function view(r: BlockRow): BlockView {
  return {
    id: r.id, at: r.at, until: r.until, kind: r.kind, byIp: !!r.ip_key, bySid: !!r.sid,
    tag: tagOf(r.ip_key, r.sid), nick: r.nick, reason: r.reason,
  }
}

export interface NewBlock {
  kind?: BlockKind
  /** IP 키 · 원래 IP · 그날 해시 (그날 해시는 오늘 본 것만) */
  ipKey?: string
  sid?: string
  /** 기간 (ms) */
  ms: number
  nick?: string
  reason?: unknown
}

/** 차단 · 강퇴 기록. 대상이 없거나 기간이 틀리면 ModerationError. DB에 못 쓰면 이번 실행 동안만 막습니다 */
export function addBlock(b: NewBlock): BlockView {
  const kind: BlockKind = b.kind === 'kick' ? 'kick' : 'block'
  const ipKey = kind === 'kick' ? '' : toKey(b.ipKey)
  if (b.ipKey && kind === 'block' && !ipKey) throw new ModerationError('IP 주소 형식이 아닙니다')
  const sid = b.sid && SID_RE.test(b.sid) ? b.sid : ''
  if (!ipKey && !sid) throw new ModerationError('막을 대상(IP나 입장 표)이 없습니다')
  const max = kind === 'kick' ? KICK_MAX_MS : BLOCK_MAX_MS
  if (!Number.isFinite(b.ms) || b.ms < BLOCK_MIN_MS || b.ms > max) {
    throw new ModerationError(`기간은 1분부터 ${kind === 'kick' ? '3시간' : '90일'}까지입니다`)
  }
  const at = Date.now()
  const until = at + Math.round(b.ms)
  const nick = cleanReason(b.nick).slice(0, 40)
  const reason = cleanReason(b.reason)
  put(byIp, ipKey, until)
  put(bySid, sid, until)
  let id = 0
  try {
    id = Number(db.prepare('INSERT INTO blocks (at, until, kind, ip_key, sid, nick, reason) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(at, until, kind, ipKey, sid, nick, reason).lastInsertRowid)
  } catch (e) {
    memOnly.push({ ipKey, sid, until })
    console.error('[shrine] 차단을 DB에 남기지 못했습니다 (서버를 다시 띄우기 전까지만 막습니다):', (e as Error).message)
  }
  changed()
  return view({ id, at, until, kind, ip_key: ipKey, sid, nick, reason })
}

/** 차단 풀기. 없으면 null */
export function removeBlock(id: number): BlockView | null {
  const row = db.prepare('SELECT * FROM blocks WHERE id = ?').get(id) as unknown as BlockRow | undefined
  if (!row) return null
  db.prepare('DELETE FROM blocks WHERE id = ?').run(id)
  load(Date.now())
  changed()
  return view(row)
}

/** 지금 걸려 있는 차단 · 강퇴 (새것부터) */
export function listBlocks(limit = 500): BlockView[] {
  const rows = db.prepare('SELECT * FROM blocks WHERE until > ? ORDER BY id DESC LIMIT ?').all(Date.now(), limit) as unknown as BlockRow[]
  return rows.map(view)
}

/** 운영자 화면 요약 */
export function blockCounts() {
  const r = db.prepare(`SELECT COALESCE(SUM(kind = 'block'), 0) AS block, COALESCE(SUM(kind = 'kick'), 0) AS kick FROM blocks WHERE until > ?`)
    .get(Date.now()) as { block: number; kick: number }
  return { blocks: r.block, kicks: r.kick }
}

/* ── 사람 신고 (메모리에만) ── */

export const REPORT_REASONS = {
  abuse: '욕설 · 괴롭힘',
  spam: '도배 · 광고',
  lewd: '음란 · 불쾌한 말',
  other: '기타',
} as const
export type ReportReason = keyof typeof REPORT_REASONS
export const isReportReason = (v: unknown): v is ReportReason => typeof v === 'string' && Object.hasOwn(REPORT_REASONS, v)

export interface ChatLine {
  at: number
  s: string
}

/** 신고 대상 (접속 중일 때 realtime.ts가 채움). sid · ipKey는 운영자 화면에도 내보내지 않습니다 */
export interface ReportTarget {
  pid: string
  sid: string
  ipKey: string
  nick: string
  channel: number
  /** 입장 표가 끝나는 시각 (강퇴 기간) */
  exp: number
}

interface UserReport {
  id: number
  at: number
  last: number
  target: ReportTarget
  reporters: Set<string>
  reasons: Map<ReportReason, number>
  lines: ChatLine[]
  state: 'open' | 'dismissed' | 'kicked' | 'blocked'
}

const REPORT_KEEP_MS = 24 * 3600_000
const REPORT_MAX = 200
const LINES_MAX = 8
/** 서로 다른 사람이 이만큼 신고하면 한 번 더 알립니다 */
const REPORT_ALERT_AT = 3
const reports: UserReport[] = []
let reportSeq = 0

function pruneReports(now: number) {
  for (let i = reports.length - 1; i >= 0; i--) if (now - reports[i]!.last > REPORT_KEEP_MS) reports.splice(i, 1)
  while (reports.length > REPORT_MAX) reports.shift()
}

/**
 * 사람 신고 받기. 같은 대상(입장 표)의 열린 신고에 합칩니다.
 * reporterKey는 신고한 사람 구분용 (그날 IP 해시). 이미 신고한 사람이면 'again'
 */
export function addUserReport(target: ReportTarget, reporterKey: string, reason: ReportReason, lines: ChatLine[]): { id: number; count: number; again: boolean } {
  const now = Date.now()
  pruneReports(now)
  let r = reports.find(x => x.state === 'open' && x.target.sid === target.sid)
  if (!r) {
    r = { id: ++reportSeq, at: now, last: now, target: { ...target }, reporters: new Set(), reasons: new Map(), lines: [], state: 'open' }
    reports.push(r)
  }
  const again = r.reporters.has(reporterKey)
  r.last = now
  r.target = { ...target }
  for (const l of lines) if (!r.lines.some(x => x.at === l.at && x.s === l.s)) r.lines.push({ at: l.at, s: l.s })
  r.lines.sort((a, b) => a.at - b.at)
  if (r.lines.length > LINES_MAX) r.lines.splice(0, r.lines.length - LINES_MAX)
  if (!again) {
    r.reporters.add(reporterKey)
    r.reasons.set(reason, (r.reasons.get(reason) ?? 0) + 1)
    const count = r.reporters.size
    if (count === 1 || count === REPORT_ALERT_AT) {
      // 말풍선 내용 · IP · 입장 표는 넣지 않습니다
      notify(count === 1 ? '접속자 신고' : '접속자 신고 누적', {
        대상: target.nick, 채널: `${target.channel}번`, 사유: REPORT_REASONS[reason], 신고한_사람: `${count}명`, 신고_번호: `#${r.id}`,
      })
    }
  }
  return { id: r.id, count: r.reporters.size, again }
}

/** 운영자 화면용 신고 목록 (열린 것 먼저, 새것부터). online은 realtime.ts가 sid로 판단해 넘겨 줍니다 */
export function listUserReports(online: (sid: string) => boolean) {
  pruneReports(Date.now())
  return [...reports]
    .sort((a, b) => Number(b.state === 'open') - Number(a.state === 'open') || b.last - a.last)
    .map(r => ({
      id: r.id, at: r.at, last: r.last, state: r.state,
      nick: r.target.nick, channel: r.target.channel, pid: r.target.pid, online: online(r.target.sid),
      count: r.reporters.size,
      reasons: [...r.reasons].map(([k, n]) => ({ key: k, label: REPORT_REASONS[k], n })),
      lines: r.lines.map(l => ({ at: l.at, s: l.s })),
    }))
}

export const openReportCount = () => reports.filter(r => r.state === 'open').length

/** 같은 입장 표에 열린 신고 수 (접속자 목록 표시용) */
export const openReportsFor = (sid: string) => reports.find(r => r.state === 'open' && r.target.sid === sid)?.reporters.size ?? 0

/** 신고 하나 (운영자가 차단할 때 대상 정보를 씀) */
export function findUserReport(id: number): { target: ReportTarget; state: UserReport['state'] } | null {
  const r = reports.find(x => x.id === id)
  return r ? { target: { ...r.target }, state: r.state } : null
}

/** 신고 닫기 (처리 결과 표시). 없으면 false */
export function closeUserReport(id: number, state: 'dismissed' | 'kicked' | 'blocked'): boolean {
  const r = reports.find(x => x.id === id)
  if (!r) return false
  r.state = state
  return true
}

/** 같은 입장 표의 열린 신고를 모두 닫습니다 (운영자가 접속자 목록에서 강퇴 · 차단했을 때) */
export function closeReportsFor(sid: string, state: 'kicked' | 'blocked') {
  for (const r of reports) if (r.state === 'open' && r.target.sid === sid) r.state = state
}

// 시작할 때 한 번 읽어 둡니다
refreshBlocks(true)
