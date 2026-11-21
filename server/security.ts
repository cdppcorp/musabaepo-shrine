// 봇 차단과 요청 제한.
//  · 입구: Turnstile 사람 확인 → 서명된 입장 표(쿠키, 3시간)
//  · 서버: IP당 입장 표 발급 수, 같은 사당 초는 30분에 1번, 사당별 시간당 상한
// IP는 그날만 쓰는 무작위 값과 섞은 해시로만 메모리에 둡니다. 디스크에 남기지 않습니다.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { config, devSkipHumanCheck } from './config.ts'
import { kstDate } from './util.ts'
import { isValidLook } from './world.ts'

/* ── 방문자 IP ── */

export function clientIp(req: IncomingMessage): string {
  if (config.trustProxy) {
    const xff = req.headers['x-forwarded-for']
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim()
    if (first) return first
  }
  return req.socket.remoteAddress ?? 'unknown'
}

let saltDay = ''
let salt = randomBytes(16)

/** 그날만 유효한 IP 해시. 날짜가 바뀌면 같은 IP도 다른 값이 됩니다. */
export function ipHash(ip: string): string {
  const day = kstDate()
  if (day !== saltDay) {
    saltDay = day
    salt = randomBytes(16)
  }
  return createHash('sha256').update(salt).update(ip).digest('base64url').slice(0, 22)
}

/* ── 입장 표 ── */

export interface Ticket {
  /** 입장 한 번마다 새로 만드는 값 */
  sid: string
  /** 캐릭터 꾸미기 부위별 번호 (world.ts LOOK_SIZES 범위) */
  look: number[]
  nick: string
  /** 만료 시각 (ms) */
  exp: number
}

export const TICKET_TTL_MS = 3 * 60 * 60 * 1000
export const TICKET_COOKIE = 'shrine_ticket'

const mac = (body: string) => createHmac('sha256', config.ticketSecret).update(body).digest()

export function signTicket(t: Ticket): string {
  const body = Buffer.from(JSON.stringify(t)).toString('base64url')
  return `${body}.${mac(body).toString('base64url')}`
}

export function verifyTicket(raw: string | undefined): Ticket | null {
  if (!raw || raw.length > 600) return null
  // 정확히 두 조각, 조각마다 정규 base64url (A-Z a-z 0-9 - _ 만, 패딩 없음, 다시 인코딩하면 같은 글자)
  const parts = raw.split('.')
  if (parts.length !== 2) return null
  const [body, sig] = parts as [string, string]
  const canonical = (p: string) => /^[A-Za-z0-9_-]+$/.test(p) && Buffer.from(p, 'base64url').toString('base64url') === p
  if (!canonical(body) || !canonical(sig)) return null
  const expected = mac(body)
  const got = Buffer.from(sig, 'base64url')
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null
  try {
    const t = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<Ticket>
    if (typeof t.sid !== 'string' || typeof t.nick !== 'string' || typeof t.exp !== 'number') return null
    if (!isValidLook(t.look)) return null
    if (t.exp < Date.now()) return null
    return t as Ticket
  } catch {
    return null
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

/* ── 자동 닉네임 (자유 입력 없음) ── */

const NICK_A = ['새벽의', '배포 중인', '커밋하는', '리뷰하는', '야근하는', '무사한', '테스트하는', '디버깅하는', '캐시 비운', '롤백 없는']
const NICK_B = ['러버덕', '고양이', '개발자', '사장님', '서버', '선인장', '막걸리', '부적']

export function makeNick(): string {
  return `${NICK_A[randomInt(NICK_A.length)]} ${NICK_B[randomInt(NICK_B.length)]} ${randomInt(10, 100)}`
}

/* ── 사람 확인 (Cloudflare Turnstile) ── */

export async function verifyHuman(token: unknown, ip: string): Promise<boolean> {
  if (devSkipHumanCheck) return true
  if (typeof token !== 'string' || token.length < 10 || token.length > 2048) return false
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: config.turnstileSecret, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(5000),
    })
    const data = (await res.json()) as { success?: boolean }
    return data.success === true
  } catch {
    return false
  }
}

/* ── 요청 제한 ── */

/** 고정 창 제한: key마다 windowMs 동안 limit번까지 */
export class WindowLimiter {
  private hits = new Map<string, { start: number; n: number }>()
  private limit: number
  private windowMs: number

  constructor(limit: number, windowMs: number) {
    this.limit = limit
    this.windowMs = windowMs
  }

  allow(key: string): boolean {
    const now = Date.now()
    const h = this.hits.get(key)
    if (!h || now - h.start >= this.windowMs) {
      this.hits.set(key, { start: now, n: 1 })
      if (this.hits.size > 5000) this.prune(now)
      return true
    }
    if (h.n >= this.limit) return false
    h.n += 1
    return true
  }

  private prune(now: number) {
    for (const [k, h] of this.hits) if (now - h.start >= this.windowMs) this.hits.delete(k)
  }
}

/** 초 켜기 판정. waitMs는 그 사당에 다시 켤 수 있을 때까지 남은 시간 (ok면 기다림 전체, busy면 0) */
export interface CandleVerdict {
  verdict: 'ok' | 'already' | 'busy'
  waitMs: number
}

/**
 * 초 켜기 제한 (로그인 없이 한 사람이 같은 사당에는 30분에 한 번, 다른 사당은 따로 셈).
 * 입장 표와 IP 해시 둘 다로 막고, 사당 하나에 한 시간 60개를 넘으면 잠시 막습니다.
 * 확인과 기록을 한 번에 해서 동시에 두 번 눌러도 한 번만 통과합니다.
 * 마지막으로 켠 시각은 `${key}|${slug}`마다 두고, 기다림이 끝난 기록은 지워서 메모리가 계속 늘지 않게 합니다.
 */
export class CandleGuard {
  /** `${key}|${slug}` → 마지막으로 켠 시각(ms) */
  private last = new Map<string, number>()
  private hourly = new Map<string, { hour: number; n: number }>()
  private cooldownMs: number
  private prunedAt = 0

  constructor(cooldownMs: number = config.candleCooldownMs) {
    this.cooldownMs = cooldownMs
  }

  check(keys: string[], slug: string, now: number = Date.now()): CandleVerdict {
    this.prune(now)
    let waitMs = 0
    for (const k of keys) {
      const at = this.last.get(`${k}|${slug}`)
      if (at !== undefined) waitMs = Math.max(waitMs, Math.min(this.cooldownMs, at + this.cooldownMs - now))
    }
    if (waitMs > 0) return { verdict: 'already', waitMs }
    const hour = Math.floor(now / 3_600_000)
    const h = this.hourly.get(slug)
    if (h && h.hour === hour && h.n >= 60) return { verdict: 'busy', waitMs: 0 }
    for (const k of keys) this.last.set(`${k}|${slug}`, now)
    if (h && h.hour === hour) h.n += 1
    else this.hourly.set(slug, { hour, n: 1 })
    return { verdict: 'ok', waitMs: this.cooldownMs }
  }

  /** 지금 들고 있는 기록 수 (시험용) */
  get size(): number {
    return this.last.size
  }

  /** 기다림이 끝난 기록과 지난 시간대 상한 지우기 (1분에 한 번) */
  private prune(now: number) {
    if (now - this.prunedAt < 60_000) return
    this.prunedAt = now
    for (const [k, at] of this.last) if (now - at >= this.cooldownMs) this.last.delete(k)
    const hour = Math.floor(now / 3_600_000)
    for (const [slug, h] of this.hourly) if (h.hour !== hour) this.hourly.delete(slug)
  }
}
