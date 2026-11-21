// 운영자 화면 (/admin): 운영 도구(npm run shrine)로 하던 일을 브라우저에서 합니다.
//   · ADMIN_PASSWORD(16자 이상)를 넣어야만 켜집니다. 꺼져 있거나 ADMIN_IPS 밖의 IP면 /admin · /api/admin/*는 404입니다.
//   · 로그인: 비밀번호 하나를 상수 시간으로 비교합니다. 틀리면 IP당 15분에 5번, 서버 전체 15분에 50번에서 잠깁니다.
//   · 세션: 입장 표처럼 HMAC으로 서명한 쿠키(8시간, HttpOnly · SameSite=Strict, localhost가 아니면 Secure).
//     서명 키는 TICKET_SECRET과 비밀번호에서 따로 만들어서, 비밀번호를 바꾸고 다시 띄우면 예전 세션은 모두 끊깁니다.
//   · 바꾸는 요청은 모두 POST + JSON 본문 + 같은 출처 + 세션이어야 합니다. 화면 파일(public/admin/)의 앱 코드는 로그인한 뒤에만 줍니다.
//   · 한 일은 모두 admin_log에 남깁니다 (시각 · 작업 · 대상 · 관리자 IP 해시). IP 원문은 남기지 않습니다.
//   · 접속자 관리: 채널별 접속자 보기, 강퇴(입장 표 무효) · 차단(입장 표 / IP, 기간), 사람 신고 처리, 차단 풀기,
//     직접 쓰는 채팅 켜고 끄기 (moderation.ts · realtime.ts). 접속자의 IP · 입장 표 값은 화면에 내보내지 않습니다.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, devSkipHumanCheck, isProd } from './config.ts'
import { db } from './db.ts'
import { clientIp, ipHash, parseCookies } from './security.ts'
import { candleSummary, freePlotsByChannel } from './shrines.ts'
import {
  approveProject, isProjectFilter, projectCounts, projectForAdmin, projectsByFilter, rejectProject,
} from './registry.ts'
import { OpError, addShrine, cleanNote, moveShrine, moveText, removeShrine, shrinesForAdmin, spotName, updateShrine } from './ops.ts'
import { deletePost, findPost, postCounts, postsForReview, setPostHidden } from './ai.ts'
import { UPLOAD_MAX, ownsUpload, saveUpload, setReviewerCheck } from './uploads.ts'
import { destroyProjectNow } from './retention.ts'
import { blockPlayer, blockTarget, channelStats, isOnline, kickPlayer, playersForAdmin, setFreeChat } from './realtime.ts'
import {
  BLOCK_MAX_MS, ModerationError, addBlock, blockCounts, closeUserReport, findUserReport, listBlocks, listUserReports, openReportCount,
  removeBlock, type BlockView,
} from './moderation.ts'
import { CHANNELS, PLOTS, isChannel } from './world.ts'

/** 빈 자리 수 (채널 1~3 모두) */
const freeCount = (free: Record<number, number[]>) => Object.values(free).reduce((a, list) => a + list.length, 0)

const ADMIN_DIR = resolve(fileURLToPath(new URL('../public/admin', import.meta.url)))
const base = config.basePath

export const ADMIN_COOKIE = 'shrine_admin'
const SESSION_MS = 8 * 3600_000
const PASSWORD_MAX = 256
/** 로그인 실패: IP당 15분에 5번, 서버 전체 15분에 50번 */
const FAIL_WINDOW_MS = 15 * 60_000
const FAILS_PER_IP = 5
const FAILS_TOTAL = 50
/** 요청 본문: 보통 8KB, 이미지 올리기는 base64라서 10MB의 4/3 + 여유 */
const BODY_MAX = 8 * 1024
const UPLOAD_BODY_MAX = Math.ceil(UPLOAD_MAX / 3) * 4 + 1024
/** 로그인 실패 기록은 최근 1000건만 둡니다 (기록이 밀려나지 않게) */
const LOGIN_FAIL_KEEP = 1000

/* ── 켜기: ADMIN_PASSWORD · ADMIN_IPS (검사는 config.ts: 운영에서 약하거나 틀리면 시작하지 않고, 개발에서는 화면만 끔) ── */

/** '::ffff:1.2.3.4'처럼 IPv6에 담긴 IPv4는 IPv4로 */
function normIp(raw: string): string {
  const v = raw.trim().toLowerCase()
  return v.startsWith('::ffff:') && isIP(v.slice(7)) === 4 ? v.slice(7) : v
}

interface Setup { enabled: boolean; pwDigest: Buffer; sessionKey: Buffer; logKey: Buffer; ips: Set<string> }

function setup(): Setup {
  const off: Setup = { enabled: false, pwDigest: Buffer.alloc(32), sessionKey: Buffer.alloc(32), logKey: Buffer.alloc(32), ips: new Set() }
  const pw = config.adminPassword
  if (!pw) return off
  const ips = new Set(config.adminIps.map(normIp).filter(ip => isIP(ip)))
  const pwDigest = createHash('sha256').update(pw, 'utf8').digest()
  // 입장 표와 다른 키: 같은 비밀(TICKET_SECRET)에서 용도별로 따로 만들고, 세션 키에는 비밀번호도 섞습니다
  const sessionKey = createHmac('sha256', config.ticketSecret).update('shrine-admin-session\0').update(pwDigest).digest()
  const logKey = createHmac('sha256', config.ticketSecret).update('shrine-admin-ip\0').digest()
  return { enabled: true, pwDigest, sessionKey, logKey, ips }
}

const A = setup()
/** .env의 FREE_CHAT (화면에서 바꾸기 전 값) */
const envFreeChat = config.freeChat
export const adminEnabled = A.enabled
if (A.enabled) console.log(`[shrine] 운영자 화면을 켰습니다: ${base}/admin${A.ips.size ? ` (허용 IP ${A.ips.size}개)` : ''}`)

export const isAdminPath = (rel: string) =>
  rel === '/admin' || rel.startsWith('/admin/') || rel === '/api/admin' || rel.startsWith('/api/admin/')

const ipAllowed = (req: IncomingMessage) => !A.ips.size || A.ips.has(normIp(clientIp(req)))

/* ── 응답 ── */

function adminHeaders(res: ServerResponse) {
  // 운영자 화면은 외부 스크립트(Turnstile) · WebSocket이 필요 없어서 더 좁게 엽니다
  res.setHeader('Content-Security-Policy', [
    "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:", "connect-src 'self'",
    "font-src 'self'", "manifest-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; '))
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Cache-Control', 'no-store')
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function notFound(res: ServerResponse) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end('Not Found')
}

const fail = (res: ServerResponse, status: number, reason: string, message?: string) =>
  json(res, status, { ok: false, reason, ...(message ? { message } : {}) })

async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown> | null> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return null
  if (Number(req.headers['content-length'] ?? 0) > limit) return null
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) return null
    chunks.push(chunk as Buffer)
  }
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * 같은 출처 확인 (기존 API보다 엄격): Origin이 있으면 우리 주소와 같아야 하고,
 * 없으면 브라우저가 붙이는 Sec-Fetch-Site가 same-origin이어야 합니다. 둘 다 없으면 받지 않습니다.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin') return false
  const origin = req.headers.origin
  if (!origin) return site === 'same-origin'
  if (config.publicOrigin) return origin === config.publicOrigin
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/* ── 세션 ── */

interface Session { sid: string; iat: number; exp: number }
const SID_RE = /^[A-Za-z0-9_-]{24}$/
/** 로그아웃한 세션 (만료될 때까지만 기억) */
const revoked = new Map<string, number>()

function signSession(s: Session): string {
  const body = Buffer.from(JSON.stringify({ k: 'admin', ...s })).toString('base64url')
  return `${body}.${createHmac('sha256', A.sessionKey).update(body).digest('base64url')}`
}

function readSession(req: IncomingMessage): Session | null {
  const raw = parseCookies(req.headers.cookie)[ADMIN_COOKIE]
  if (!raw || raw.length > 400) return null
  const parts = raw.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  const [body, sig] = parts as [string, string]
  // 조각마다 정규 base64url (A-Z a-z 0-9 - _ 만, 패딩 없음, 다시 인코딩하면 같은 글자)
  const canonical = (p: string) => /^[A-Za-z0-9_-]+$/.test(p) && Buffer.from(p, 'base64url').toString('base64url') === p
  if (!canonical(body) || !canonical(sig)) return null
  const want = createHmac('sha256', A.sessionKey).update(body).digest()
  const got = Buffer.from(sig, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>
    if (v.k !== 'admin' || typeof v.sid !== 'string' || !SID_RE.test(v.sid)) return null
    if (typeof v.iat !== 'number' || typeof v.exp !== 'number') return null
    const now = Date.now()
    if (v.exp <= now || v.exp - v.iat > SESSION_MS || v.iat > now + 60_000) return null
    if (revoked.has(v.sid)) return null
    return { sid: v.sid, iat: v.iat, exp: v.exp }
  } catch {
    return null
  }
}

function isLoopbackHost(host: string | undefined): boolean {
  const h = (host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '::1'
}

function sessionCookie(req: IncomingMessage, value: string, maxAgeSec: number): string {
  const secure = !isLoopbackHost(req.headers.host)
  return `${ADMIN_COOKIE}=${value}; Path=${base}/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
}

/* ── 로그인 실패 제한 ── */

const ipFails = new Map<string, { start: number; n: number }>()
let allFails = { start: 0, n: 0 }

function loginLocked(key: string, now: number): boolean {
  if (now - allFails.start >= FAIL_WINDOW_MS) allFails = { start: now, n: 0 }
  if (allFails.n >= FAILS_TOTAL) return true
  const f = ipFails.get(key)
  return !!f && now - f.start < FAIL_WINDOW_MS && f.n >= FAILS_PER_IP
}

function addLoginFail(key: string, now: number) {
  allFails.n += 1
  const f = ipFails.get(key)
  if (!f || now - f.start >= FAIL_WINDOW_MS) ipFails.set(key, { start: now, n: 1 })
  else f.n += 1
  if (ipFails.size > 5000) for (const [k, v] of ipFails) if (now - v.start >= FAIL_WINDOW_MS) ipFails.delete(k)
}

/* ── 기록 (admin_log) ── */

/** 관리자 IP 해시: 서버 키로 만든 HMAC 앞 16자. 같은 IP는 같은 값이 되어 누가 했는지 묶어 볼 수 있습니다 */
const adminIpHash = (req: IncomingMessage) => createHmac('sha256', A.logKey).update(normIp(clientIp(req))).digest('base64url').slice(0, 16)

function logAction(req: IncomingMessage, action: string, target: string | number = '', detail = '') {
  db.prepare('INSERT INTO admin_log (at, action, target, ip_hash, detail) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), action, String(target).slice(0, 80), adminIpHash(req), detail.slice(0, 200))
  if (action === 'login-fail') {
    db.prepare(`DELETE FROM admin_log WHERE action = 'login-fail' AND id <=
                  (SELECT id FROM admin_log WHERE action = 'login-fail' ORDER BY id DESC LIMIT 1 OFFSET ?)`).run(LOGIN_FAIL_KEEP)
  }
}

function readLog(limitRaw: string | null) {
  const n = Number(limitRaw ?? 100)
  const limit = Number.isInteger(n) && n > 0 ? Math.min(n, 500) : 100
  return db.prepare('SELECT id, at, action, target, ip_hash AS ip, detail FROM admin_log ORDER BY id DESC LIMIT ?').all(limit)
}

/* ── 로그인 · 로그아웃 ── */

async function login(req: IncomingMessage, res: ServerResponse) {
  if (!sameOrigin(req)) return fail(res, 403, 'origin')
  const now = Date.now()
  const key = ipHash(clientIp(req))
  if (loginLocked(key, now)) return fail(res, 429, 'locked')
  const body = await readJson(req, 1024)
  if (!body) return fail(res, 400, 'bad')
  const pw = body.password
  const good = typeof pw === 'string' && pw.length > 0 && pw.length <= PASSWORD_MAX * 4
    && timingSafeEqual(createHash('sha256').update(pw, 'utf8').digest(), A.pwDigest)
  if (!good) {
    addLoginFail(key, now)
    logAction(req, 'login-fail')
    return fail(res, 401, 'password')
  }
  ipFails.delete(key)
  const s: Session = { sid: randomBytes(18).toString('base64url'), iat: now, exp: now + SESSION_MS }
  res.setHeader('Set-Cookie', sessionCookie(req, signSession(s), SESSION_MS / 1000))
  logAction(req, 'login')
  return json(res, 200, { ok: true, exp: s.exp })
}

function logout(req: IncomingMessage, res: ServerResponse, s: Session) {
  const now = Date.now()
  revoked.set(s.sid, s.exp)
  for (const [k, exp] of revoked) if (exp <= now) revoked.delete(k)
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0))
  logAction(req, 'logout')
  return json(res, 200, { ok: true })
}

/* ── 읽기 ── */

function dashboard() {
  const rt = channelStats()
  const candles = candleSummary()
  const shrines = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(status = 'live'), 0) AS live FROM shrines`).get() as { total: number; live: number }
  // 사당 자리는 채널마다 20칸 (free · plots는 세 채널을 합한 수, freeByChannel은 채널별 빈 자리 수)
  const free = freePlotsByChannel()
  return {
    connections: rt.connections,
    channels: rt.channels,
    moderation: { reports: openReportCount(), ...blockCounts(), freeChat: config.freeChat },
    candles: { today: candles.today, week: candles.weekTotal },
    projects: projectCounts(),
    posts: postCounts(),
    shrines: {
      total: shrines.total, live: shrines.live, check: shrines.total - shrines.live, free: freeCount(free), plots: PLOTS.length * CHANNELS,
      freeByChannel: Object.fromEntries(Object.entries(free).map(([ch, list]) => [ch, list.length])),
    },
  }
}

/** 지금 설정 요약. 비밀 값(비밀번호 · 서명 키 · Turnstile 비밀 키)은 들어 있는지만 보여 줍니다 */
function settings() {
  const on = (v: boolean) => (v ? '켜짐' : '꺼짐')
  const set = (name: string) => ((process.env[name] ?? '').trim() ? '설정됨' : '비어 있음')
  return [
    { key: 'NODE_ENV', label: '실행 모드', value: isProd ? '운영 (production)' : '개발' },
    { key: 'HOST · PORT', label: '받는 주소', value: `${config.host}:${config.port}` },
    { key: 'BASE_PATH', label: '주소 앞부분', value: base || '(도메인 루트)' },
    { key: 'PUBLIC_ORIGIN', label: '공개 주소', value: config.publicOrigin || '(없음)' },
    { key: 'TRUST_PROXY', label: '프록시가 준 IP 믿기', value: on(config.trustProxy) },
    { key: 'DATA_DIR', label: '데이터 폴더', value: config.dataDir },
    { key: 'ALLOW_INDEXING', label: '검색 노출', value: on(config.allowIndexing) },
    { key: 'FREE_CHAT', label: '직접 쓰는 채팅', value: `${on(config.freeChat)}${config.freeChat !== envFreeChat ? ' (접속자 화면에서 바꿈, 다시 띄우면 .env 값)' : ''}` },
    { key: 'BOARD_OPEN', label: 'AI 트렌드 게시판 글쓰기', value: config.boardOpen ? '열림' : '준비 중 (닫힘)' },
    { key: 'WS_MAX_PER_IP', label: '같은 IP 동시 접속', value: `${config.wsMaxPerIp}개` },
    { key: 'NOTIFY_WEBHOOK_URL', label: '운영자 알림 (웹훅)', value: set('NOTIFY_WEBHOOK_URL') },
    { key: 'CONTACT_EMAIL', label: '화면에 보이는 연락처', value: config.contactEmail || '(안 보임)' },
    { key: 'CANDLE_COOLDOWN_MS', label: '같은 사당 초 다시 켜기', value: `${Math.round(config.candleCooldownMs / 60_000)}분` },
    { key: 'GITHUB_CHECK', label: '등록소 GitHub 저장소 확인', value: on(process.env.GITHUB_CHECK !== 'off') },
    { key: 'TURNSTILE_*', label: '사람 확인 (Turnstile)', value: devSkipHumanCheck ? '건너뜀 (개발, 키 없음)' : '켜짐' },
    { key: 'TICKET_SECRET', label: '입장 표 · 세션 서명 키', value: (process.env.TICKET_SECRET ?? '').trim() ? '설정됨' : '임시 키 (다시 띄우면 바뀜)' },
    { key: 'ADMIN_PASSWORD', label: '운영자 비밀번호', value: set('ADMIN_PASSWORD') },
    { key: 'ADMIN_IPS', label: '운영자 화면 허용 IP', value: A.ips.size ? [...A.ips].join(', ') : '(제한 없음)' },
    { key: '—', label: '운영자 세션 길이', value: `${SESSION_MS / 3600_000}시간` },
    { key: '—', label: '사당 자리', value: `채널마다 ${PLOTS.length}칸 × ${CHANNELS}채널 (빈 자리 ${freeCount(freePlotsByChannel())})` },
    { key: '—', label: 'Node', value: process.version },
  ]
}

function readId(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,9}$/.test(raw) ? Number(raw) : NaN
  return Number.isInteger(n) && n > 0 ? n : null
}

async function reads(req: IncomingMessage, res: ServerResponse, s: Session, action: string, q: URLSearchParams) {
  switch (action) {
    case 'me':
      return json(res, 200, { ok: true, exp: s.exp })
    case 'dashboard':
      return json(res, 200, { ok: true, ...dashboard() })
    case 'projects': {
      const filter = q.get('filter') ?? 'review'
      if (!isProjectFilter(filter)) return fail(res, 400, 'bad')
      return json(res, 200, { ok: true, filter, projects: projectsByFilter(filter), freePlots: freePlotsByChannel(), channels: CHANNELS })
    }
    case 'project': {
      const id = readId(q.get('id'))
      const p = id ? projectForAdmin(id) : null
      if (!p) return fail(res, 404, 'none')
      // 이메일(개인정보)을 보는 화면이라 누가 언제 어느 접수를 열었는지 남깁니다
      if (p.email) logAction(req, 'project-view', id ?? '')
      return json(res, 200, { ok: true, project: p, freePlots: freePlotsByChannel(), channels: CHANNELS })
    }
    case 'shrines': {
      const shrines = shrinesForAdmin()
      const withEmail = shrines.filter(x => x.email).length
      if (withEmail) logAction(req, 'shrines-view', '', `이메일 ${withEmail}곳`)
      // freePlots: 채널 번호 → 빈 자리 번호들, plots: 채널 하나의 자리 수
      return json(res, 200, { ok: true, shrines, freePlots: freePlotsByChannel(), plots: PLOTS.length, channels: CHANNELS })
    }
    case 'posts':
      return json(res, 200, { ok: true, posts: postsForReview() })
    case 'settings':
      return json(res, 200, { ok: true, settings: settings() })
    case 'log':
      return json(res, 200, { ok: true, log: readLog(q.get('limit')) })
    case 'players':
      return json(res, 200, { ok: true, channels: playersForAdmin(), freeChat: config.freeChat })
    case 'reports':
      return json(res, 200, { ok: true, reports: listUserReports(isOnline) })
    case 'blocks':
      return json(res, 200, { ok: true, blocks: listBlocks() })
  }
  return notFound(res)
}

/* ── 접속자 관리 ── */

/** 기간: 분(1 ~ 90일). 틀리면 null */
function readMinutes(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,6}$/.test(raw) ? Number(raw) : NaN
  return Number.isInteger(n) && n >= 1 && n * 60_000 <= BLOCK_MAX_MS ? n : null
}

function fmtMinutes(min: number): string {
  if (min % 1440 === 0) return `${min / 1440}일`
  if (min % 60 === 0) return `${min / 60}시간`
  return `${min}분`
}

const blockDetail = (b: BlockView, min: number | null) =>
  [b.nick || '-', min ? fmtMinutes(min) : '', b.byIp ? 'IP · 입장 표' : '입장 표', b.reason].filter(Boolean).join(' · ')

async function moderationWrites(req: IncomingMessage, res: ServerResponse, action: string, body: Record<string, unknown>) {
  switch (action) {
    case 'player/kick': {
      const r = kickPlayer(body.id, body.reason)
      if (!r) return fail(res, 404, 'gone')
      logAction(req, 'player-kick', r.block.tag, blockDetail(r.block, null))
      return json(res, 200, { ok: true, nick: r.nick })
    }
    case 'player/block': {
      const min = readMinutes(body.minutes)
      if (!min) return fail(res, 400, 'bad')
      const r = blockPlayer(body.id, min * 60_000, body.ip === true, body.reason)
      if (!r) return fail(res, 404, 'gone')
      logAction(req, 'player-block', r.block.tag, blockDetail(r.block, min))
      return json(res, 200, { ok: true, nick: r.nick, block: r.block })
    }
    case 'report/kick':
    case 'report/block': {
      const id = readId(body.id)
      const rep = id ? findUserReport(id) : null
      if (!id || !rep) return fail(res, 404, 'none')
      if (action === 'report/kick') {
        const r = kickPlayer(rep.target.pid, body.reason)
        if (!r) return fail(res, 404, 'gone')
        closeUserReport(id, 'kicked')
        logAction(req, 'player-kick', r.block.tag, `신고 #${id} · ${blockDetail(r.block, null)}`)
        return json(res, 200, { ok: true, nick: r.nick })
      }
      const min = readMinutes(body.minutes)
      if (!min) return fail(res, 400, 'bad')
      // 접속을 끊은 사람도 신고에 남은 입장 표 · IP 키로 막을 수 있습니다
      const b = blockTarget(rep.target, min * 60_000, body.ip === true, body.reason)
      closeUserReport(id, 'blocked')
      logAction(req, 'player-block', b.tag, `신고 #${id} · ${blockDetail(b, min)}`)
      return json(res, 200, { ok: true, nick: rep.target.nick, block: b })
    }
    case 'report/dismiss': {
      const id = readId(body.id)
      if (!id || !closeUserReport(id, 'dismissed')) return fail(res, 404, 'none')
      logAction(req, 'report-dismiss', `#${id}`)
      return json(res, 200, { ok: true })
    }
    case 'block/ip': {
      // 운영자가 아는 IP(예: 서버 로그)를 바로 막기. IP 원문은 키로만 바꿔 두고 기록에도 남기지 않습니다
      const min = readMinutes(body.minutes)
      if (!min || typeof body.ip !== 'string' || body.ip.length > 64) return fail(res, 400, 'bad')
      const b = addBlock({ kind: 'block', ipKey: body.ip, ms: min * 60_000, reason: body.reason })
      logAction(req, 'ip-block', b.tag, blockDetail(b, min))
      return json(res, 200, { ok: true, block: b })
    }
    case 'block/remove': {
      const id = readId(body.id)
      const b = id ? removeBlock(id) : null
      if (!b) return fail(res, 404, 'none')
      logAction(req, 'block-remove', b.tag, `${b.kind === 'kick' ? '강퇴' : '차단'} #${b.id} · ${b.nick || '-'}`)
      return json(res, 200, { ok: true })
    }
    case 'chat/free': {
      if (typeof body.on !== 'boolean') return fail(res, 400, 'bad')
      setFreeChat(body.on)
      logAction(req, 'chat-free', body.on ? 'on' : 'off')
      return json(res, 200, { ok: true, freeChat: config.freeChat })
    }
  }
  return null
}

/* ── 바꾸기 ── */

/** 올린 이미지 이름 → 사당 화면 목록. 이 세션에서 하루 안에 올린 것만 받습니다 */
function screensFrom(raw: unknown, s: Session): string[] {
  if (!ownsUpload(raw, `admin:${s.sid}`)) throw new OpError('이미지를 다시 올려 주세요 (이 로그인에서 올린 이미지만 쓸 수 있습니다)')
  return [`up/${raw}`]
}

async function writes(req: IncomingMessage, res: ServerResponse, s: Session, action: string, body: Record<string, unknown>) {
  const moderated = await moderationWrites(req, res, action, body)
  if (moderated !== null) return moderated
  switch (action) {
    case 'logout':
      return logout(req, res, s)

    case 'upload': {
      const data = body.data
      if (typeof data !== 'string' || !data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return fail(res, 400, 'bad')
      const buf = Buffer.from(data, 'base64')
      if (buf.length > UPLOAD_MAX) return fail(res, 413, 'size')
      const r = saveUpload(buf, `admin:${s.sid}`, ipHash(clientIp(req)))
      if (!r.ok) return fail(res, r.reason === 'size' ? 413 : r.reason === 'slow' || r.reason === 'many' ? 429 : 400, r.reason)
      logAction(req, 'upload', r.id)
      return json(res, 201, { ok: true, id: r.id })
    }

    case 'project/approve': {
      const id = readId(body.id)
      if (!id) return fail(res, 400, 'bad')
      let plot: number | undefined
      if (body.plot != null && body.plot !== '') {
        const n = readId(body.plot) ?? (body.plot === 0 || body.plot === '0' ? 0 : null)
        if (n == null) return fail(res, 400, 'bad')
        plot = n
      }
      // 채널을 비우면 작성자가 고른 채널 (registry.ts approveProject)
      let channel: number | undefined
      if (body.channel != null && body.channel !== '') {
        const n = readId(body.channel)
        if (n == null || !isChannel(n)) return fail(res, 400, 'bad')
        channel = n
      }
      const message = approveProject(id, plot, channel)
      const p = projectForAdmin(id)
      logAction(req, 'project-approve', id, message)
      return json(res, 200, { ok: true, message, project: p })
    }

    case 'project/erase': {
      // 작성자의 요청 등으로 30일을 기다리지 않고 개인정보를 바로 파기 (되돌릴 수 없음)
      const id = readId(body.id)
      if (!id) return fail(res, 400, 'bad')
      const r = destroyProjectNow(id)
      if (!r.ok) return fail(res, 404, 'none', r.message)
      logAction(req, 'project-erase', id, `이미지 ${r.images}개`)
      return json(res, 200, { ok: true, message: r.message, project: projectForAdmin(id) })
    }

    case 'project/reject': {
      const id = readId(body.id)
      if (!id) return fail(res, 400, 'bad')
      const note = cleanNote(body.note)
      const message = rejectProject(id, note)
      logAction(req, 'project-reject', id, note)
      return json(res, 200, { ok: true, message, project: projectForAdmin(id) })
    }

    case 'shrine/add': {
      const shrine = addShrine(body, screensFrom(body.screen, s))
      logAction(req, 'shrine-add', shrine.slug, `${shrine.name} · ${spotName(shrine.channel, shrine.plot)}`)
      return json(res, 201, { ok: true, shrine })
    }

    case 'shrine/update': {
      const { screen, slug, ...patch } = body
      const screens = screen == null || screen === '' ? undefined : screensFrom(screen, s)
      const r = updateShrine(slug, patch, screens)
      if (r.changed.length) logAction(req, 'shrine-update', r.shrine.slug, r.changed.join(', '))
      return json(res, 200, { ok: true, shrine: r.shrine, changed: r.changed })
    }

    case 'shrine/move': {
      const r = moveShrine(body.slug, body.plot, body.channel)
      logAction(req, 'shrine-move', r.shrine.slug, moveText(r))
      return json(res, 200, { ok: true, shrine: r.shrine })
    }

    case 'shrine/remove': {
      const r = removeShrine(body.slug, body.note)
      logAction(req, 'shrine-remove', r.slug, `${r.name}${r.projectId ? ` · 접수 #${r.projectId} 반려로` : ''}`)
      return json(res, 200, { ok: true })
    }

    case 'post/hide':
    case 'post/show':
    case 'post/delete': {
      const id = readId(body.id)
      const post = id ? findPost(id) : undefined
      if (!id || !post) return fail(res, 404, 'none')
      const done = action === 'post/delete' ? deletePost(id) : setPostHidden(id, action === 'post/hide')
      if (!done) return fail(res, 404, 'none')
      logAction(req, action.replace('/', '-'), id, `[${post.topic}] ${post.text.slice(0, 40)}`)
      return json(res, 200, { ok: true })
    }
  }
  return notFound(res)
}

/* ── 화면 파일 ── */

const PAGE_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

async function sendFile(req: IncomingMessage, res: ServerResponse, name: string) {
  const type = PAGE_TYPES[name.slice(name.lastIndexOf('.'))]
  if (!type) return notFound(res)
  let body: string
  try {
    body = await readFile(join(ADMIN_DIR, name), 'utf8')
  } catch {
    return notFound(res)
  }
  // BASE_PATH는 config.ts에서 /[a-z0-9-] 모양만 받으므로 HTML에 그대로 넣어도 안전합니다
  if (name.endsWith('.html')) body = body.replaceAll('{{BASE}}', base)
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(req.method === 'HEAD' ? undefined : body)
}

/* ── 들어오는 곳 ── */

// 검토 대기 이미지(/img/shrines/up/…)는 로그인한 운영자에게도 보여 줍니다 (uploads.ts는 공개 사당 이미지만 누구에게나 줌)
if (A.enabled) setReviewerCheck(req => ipAllowed(req) && readSession(req) != null)

export async function handleAdmin(req: IncomingMessage, res: ServerResponse, rel: string) {
  if (!A.enabled || !ipAllowed(req)) return notFound(res)
  adminHeaders(res)
  const method = req.method ?? 'GET'
  const read = method === 'GET' || method === 'HEAD'

  // 화면: 로그인 전에는 로그인 화면만, 앱 코드(app.js)는 로그인한 세션에만
  if (read && rel === '/admin') return sendFile(req, res, readSession(req) ? 'index.html' : 'login.html')
  if (read && rel === '/admin/') {
    res.writeHead(302, { Location: `${base}/admin`, 'Cache-Control': 'no-store' })
    return res.end()
  }
  if (read && (rel === '/admin/admin.css' || rel === '/admin/login.js')) return sendFile(req, res, rel.slice('/admin/'.length))
  if (read && rel === '/admin/app.js') return readSession(req) ? sendFile(req, res, 'app.js') : notFound(res)
  if (!rel.startsWith('/api/admin/')) return notFound(res)

  const action = rel.slice('/api/admin/'.length)
  if (method === 'POST' && action === 'login') return login(req, res)

  if (method === 'GET') {
    const s = readSession(req)
    if (!s) return fail(res, 401, 'session')
    return reads(req, res, s, action, new URL(req.url ?? '/', 'http://local').searchParams)
  }
  if (method !== 'POST') return notFound(res)
  if (!sameOrigin(req)) return fail(res, 403, 'origin')
  const s = readSession(req)
  if (!s) return fail(res, 401, 'session')
  const body = await readJson(req, action === 'upload' ? UPLOAD_BODY_MAX : BODY_MAX)
  if (!body) return fail(res, 400, 'bad')
  try {
    return await writes(req, res, s, action, body)
  } catch (e) {
    if (e instanceof OpError) return fail(res, e.status, 'rule', e.message)
    if (e instanceof ModerationError) return fail(res, 400, 'rule', e.message)
    // registry.ts approve · reject는 운영 도구와 같은 한국어 Error를 던집니다
    const msg = e instanceof Error ? e.message : ''
    if (/UNIQUE constraint/i.test(msg)) return fail(res, 409, 'rule', '같은 주소 · 자리 · 이름을 쓰는 사당이 이미 있습니다')
    if (/[가-힣]/.test(msg)) return fail(res, 409, 'rule', msg.slice(0, 200))
    throw e
  }
}
