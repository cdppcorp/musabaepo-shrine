// HTTP: 첫 화면, 맵 정보, 입장, 서비스 가보기, 내 프로젝트 등록소, 정적 파일, 약관 · 처리방침, 헬스 체크.
// 모든 응답에 보안 헤더를 붙입니다. 정적 파일은 ETag로 다시 확인(304)하고, 읽다가 실패해도 그 응답만 끊습니다.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, isProd } from './config.ts'
import { db } from './db.ts'
import { addClick, allShrines, candleSummary, findShrine, isSafeShrineUrl, parseGithub, publicShrine } from './shrines.ts'
import { manageGet, manageSave, manageWithdraw, statusByCode, submitProject, type Fail, findMine } from './registry.ts'
import { UPLOAD_MAX, beginUpload, pipeFile, readBody, saveUpload, serveUpload, uploadStats } from './uploads.ts'
import {
  TICKET_COOKIE, TICKET_TTL_MS, WindowLimiter, clientIp, ipHash, makeNick, parseCookies, signTicket, verifyHuman,
  verifyTicket, type Ticket,
} from './security.ts'
import { WORLD_JSON, isValidLook } from './world.ts'
import { CHAT_MAX } from './chat.ts'
import { POST_MAX, listPosts } from './ai.ts'
import { handleAdmin, isAdminPath } from './admin.ts'
import { isBlocked } from './moderation.ts'

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)))
const LEGAL_DIR = join(PUBLIC_DIR, 'legal')
const base = config.basePath

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}
/** public/ 아래에서 내보내는 파일 (그 밖은 모두 404) */
const STATIC_RE = /^\/(?:js\/[a-z0-9-]+\.js|style\.css|favicon\.(?:ico|svg)|apple-touch-icon\.png|img\/[a-z0-9/_-]+\.(?:png|jpe?g|webp|svg))$/
/** 약관 · 처리방침: 주소 → public/legal 파일 */
const LEGAL: Record<string, string> = { '/privacy': 'privacy.html', '/terms': 'terms.html' }

/** IP당 입장 표 발급: 10분에 10장 */
const enterLimiter = new WindowLimiter(10, 10 * 60 * 1000)
/** IP당 일반 요청: 1분에 240번 */
const requestLimiter = new WindowLimiter(240, 60 * 1000)

const htmlEscape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

// 첫 화면: {{BASE}} 주소 앞부분, {{ORIGIN}} 공개 주소(링크 미리보기 og:url · og:image 절대 주소용)
const indexTemplate = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8')
const indexHtml = indexTemplate
  .replaceAll('{{BASE}}', base)
  .replaceAll('{{ORIGIN}}', htmlEscape(config.publicOrigin))
  .replaceAll('{{TURNSTILE_SITE_KEY}}', config.turnstileSiteKey)
const indexEtag = `"${createHash('sha1').update(indexHtml).digest('base64url').slice(0, 16)}"`

function securityHeaders(req: IncomingMessage, res: ServerResponse) {
  const host = (req.headers.host ?? '').replace(/[^a-z0-9.:-]/gi, '')
  const wsOrigin = config.publicOrigin ? config.publicOrigin.replace(/^http/, 'ws') : `ws://${host}`
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    `connect-src 'self' ${wsOrigin}`,
    "img-src 'self' data: blob:",
    "style-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  if (isProd) res.setHeader('Strict-Transport-Security', 'max-age=31536000')
  if (!config.allowIndexing) res.setHeader('X-Robots-Tag', 'noindex, nofollow')
}

function json(res: ServerResponse, status: number, body: unknown, cache = 'no-store') {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache })
  res.end(JSON.stringify(body))
}

function text(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(body)
}

function redirect(res: ServerResponse, to: string, status = 302) {
  res.writeHead(status, { Location: to, 'Cache-Control': 'no-store' })
  res.end()
}

/** 브라우저가 페이지로 연 주소면 작은 HTML, 아니면 글자 한 줄 */
const notFoundHtml = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>찾는 페이지가 없습니다 · 무사배포 기원소</title>
  <link rel="stylesheet" href="${base}/style.css">
</head>
<body class="legal">
  <main class="legal-wrap">
    <p class="lab">404</p>
    <h1>찾는 페이지가 없습니다</h1>
    <p>주소가 바뀌었거나 사당이 내려갔을 수 있어요.</p>
    <p><a href="${base}/">무사배포 기원소로 돌아가기</a></p>
  </main>
</body>
</html>
`

function notFound(res: ServerResponse, req?: IncomingMessage) {
  const wantsPage = !!req && (req.method === 'GET' || req.method === 'HEAD') && (req.headers.accept ?? '').includes('text/html')
  if (!wantsPage) return text(res, 404, 'Not Found')
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(req.method === 'HEAD' ? undefined : notFoundHtml)
}

/** If-None-Match가 이 ETag와 같으면 304를 보내고 true */
function notModified(req: IncomingMessage, res: ServerResponse, etag: string, headers: Record<string, string>): boolean {
  const inm = req.headers['if-none-match']
  if (!inm) return false
  const tags = inm.split(',').map(t => t.trim().replace(/^W\//, ''))
  if (!tags.includes(etag.replace(/^W\//, '')) && !tags.includes('*')) return false
  res.writeHead(304, { ...headers, ETag: etag })
  res.end()
  return true
}

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
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  if (config.publicOrigin) return origin === config.publicOrigin
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

const ticketOf = (req: IncomingMessage): Ticket | null => verifyTicket(parseCookies(req.headers.cookie)[TICKET_COOKIE])

/** 입장: 캐릭터 꾸미기 번호 + 사람 확인 → 입장 표 쿠키 */
async function enter(req: IncomingMessage, res: ServerResponse) {
  if (!sameOrigin(req)) return json(res, 403, { ok: false, reason: 'origin' })
  const ip = clientIp(req)
  if (isBlocked(ip)) return json(res, 403, { ok: false, reason: 'blocked' })
  if (!enterLimiter.allow(ipHash(ip))) return json(res, 429, { ok: false, reason: 'busy' })
  const body = await readJson(req, 4096)
  const look = body?.look
  if (!isValidLook(look)) return json(res, 400, { ok: false, reason: 'bad' })
  if (!(await verifyHuman(body?.token, ip))) return json(res, 403, { ok: false, reason: 'human' })

  const ticket = { sid: randomUUID(), look: [...look], nick: makeNick(), exp: Date.now() + TICKET_TTL_MS }
  res.setHeader('Set-Cookie', `${TICKET_COOKIE}=${signTicket(ticket)}; Path=${base}/; Max-Age=${TICKET_TTL_MS / 1000}; HttpOnly; SameSite=Strict${isProd ? '; Secure' : ''}`)
  return json(res, 200, { ok: true, nick: ticket.nick, look: ticket.look })
}

/**
 * 서비스 가보기: 나가기 직전에 사당 상태를 한 번 더 보고, repo면 GitHub 저장소로.
 * 클릭 수는 입장한 사람(입장 표)이 누른 것만 셉니다 (주소만 불러 부풀리지 못하게).
 */
function goTo(req: IncomingMessage, res: ServerResponse, slug: string, repo: boolean) {
  const s = findShrine(slug)
  if (!s) return notFound(res, req)
  res.setHeader('X-Robots-Tag', 'noindex, nofollow')
  const count = () => { if (ticketOf(req)) addClick(s.slug) }
  if (repo) {
    const g = s.repo ? parseGithub(s.repo) : null
    if (!g) return notFound(res, req)
    if (s.status !== 'live') return redirect(res, `${base}/`)
    count()
    return redirect(res, g.url)
  }
  if (s.status !== 'live' || !isSafeShrineUrl(s)) return redirect(res, `${base}/`)
  count()
  return redirect(res, s.url)
}

/* ── 내 프로젝트 등록소: 입장한 사람(입장 표)만, 같은 출처에서만, 본문 4KB까지 ── */

const failJson = (res: ServerResponse, f: Fail) => json(res, f.status, { ok: false, reason: f.reason })

async function registryApi(req: IncomingMessage, res: ServerResponse, rel: string) {
  if (!sameOrigin(req)) return json(res, 403, { ok: false, reason: 'origin' })
  const ticket = ticketOf(req)
  if (!ticket) return json(res, 401, { ok: false, reason: 'ticket' })
  const ip = clientIp(req)
  // 차단된 사람은 새로 접수하거나 고칠 수 없습니다 (내 접수 보기 · 내리기는 그대로)
  if ((rel === '/api/submit' || rel === '/api/manage/save') && isBlocked(ip, ticket.sid)) {
    return json(res, 403, { ok: false, reason: 'blocked' })
  }
  const body = await readJson(req, 4096)
  if (!body) return json(res, 400, { ok: false, reason: 'bad' })
  const ipKey = ipHash(ip)
  if (rel === '/api/submit') {
    const r = await submitProject(body, { sid: ticket.sid, ipKey, nick: ticket.nick })
    return r.ok ? json(res, 201, r) : failJson(res, r)
  }
  if (rel === '/api/manage/find') {
    const r = findMine(body, ipKey)
    return r.ok ? json(res, 200, r) : failJson(res, r)
  }
  if (rel === '/api/manage/get') {
    const r = manageGet(body, ipKey, ticket.sid)
    return r.ok ? json(res, 200, r) : failJson(res, r)
  }
  if (rel === '/api/manage/save') {
    const r = await manageSave(body, ipKey, ticket.sid)
    return r.ok ? json(res, 200, r) : failJson(res, r)
  }
  if (rel === '/api/manage/withdraw') {
    const r = manageWithdraw(body, ipKey)
    return r.ok ? json(res, 200, r) : failJson(res, r)
  }
  return notFound(res)
}

const UPLOAD_STATUS: Record<string, number> = { size: 413, slow: 429, many: 429, busy: 429, full: 503 }

/**
 * 등록소 이미지 올리기: 입장한 사람만, 같은 출처에서만, 10MB까지 (본문은 이미지 그대로).
 * 할당량 · 동시 업로드 수 · 용량은 본문을 읽기 전에 봅니다.
 */
async function uploadApi(req: IncomingMessage, res: ServerResponse) {
  if (!sameOrigin(req)) return json(res, 403, { ok: false, reason: 'origin' })
  const ticket = ticketOf(req)
  if (!ticket) return json(res, 401, { ok: false, reason: 'ticket' })
  const ip = clientIp(req)
  if (isBlocked(ip, ticket.sid)) return json(res, 403, { ok: false, reason: 'blocked' })
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > UPLOAD_MAX) return json(res, 413, { ok: false, reason: 'size' })
  const ipKey = ipHash(ip)
  const slot = beginUpload(ticket.sid, ipKey)
  if (!slot.ok) return json(res, UPLOAD_STATUS[slot.reason] ?? 400, slot)
  try {
    const buf = await readBody(req, UPLOAD_MAX)
    const r = saveUpload(buf, ticket.sid, ipKey)
    return r.ok ? json(res, 201, r) : json(res, UPLOAD_STATUS[r.reason] ?? 400, r)
  } finally {
    slot.done()
  }
}

/* ── 정적 파일 · 문서 ── */

/** 크기 + 고친 시각으로 만든 약한 ETag */
const fileEtag = (size: number, mtimeMs: number) => `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`

async function serveStatic(req: IncomingMessage, res: ServerResponse, rel: string) {
  const ext = extname(rel).toLowerCase()
  const type = TYPES[ext]
  if (!type || !STATIC_RE.test(rel)) return notFound(res, req)
  const file = normalize(join(PUBLIC_DIR, rel))
  if (!file.startsWith(PUBLIC_DIR + sep)) return notFound(res, req)
  try {
    const info = await stat(file)
    if (!info.isFile()) return notFound(res, req)
    // 스크립트 · 스타일은 매번 다시 확인(바뀐 게 없으면 304), 이미지는 하루 캐시
    const headers = {
      'Content-Type': type,
      'Cache-Control': ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=86400',
      'Last-Modified': info.mtime.toUTCString(),
    }
    const etag = fileEtag(info.size, info.mtimeMs)
    if (notModified(req, res, etag, headers)) return
    res.writeHead(200, { ...headers, ETag: etag, 'Content-Length': info.size })
    if (req.method === 'HEAD') return res.end()
    pipeFile(res, file)
  } catch {
    notFound(res, req)
  }
}

/** 개인정보처리방침 · 이용약관 (public/legal). 문서 안 링크는 상대 주소라서 그대로 보냅니다. 파일이 없으면 404 */
async function serveLegal(req: IncomingMessage, res: ServerResponse, name: string) {
  const file = join(LEGAL_DIR, name)
  let body: Buffer
  let etag: string
  let modified: Date
  try {
    const info = await stat(file)
    if (!info.isFile()) return notFound(res, req)
    etag = fileEtag(info.size, info.mtimeMs)
    modified = info.mtime
    body = await readFile(file)
  } catch {
    return notFound(res, req)
  }
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Last-Modified': modified.toUTCString() }
  if (notModified(req, res, etag, headers)) return
  res.writeHead(200, { ...headers, ETag: etag, 'Content-Length': body.length })
  res.end(req.method === 'HEAD' ? undefined : body)
}

/* ── 검색 · 보안 안내 ── */

function robots(): string {
  if (!config.allowIndexing) return 'User-agent: *\nDisallow: /\n'
  const lines = ['User-agent: *', `Disallow: ${base}/go/`, `Disallow: ${base}/api/`]
  if (config.publicOrigin) lines.push('', `Sitemap: ${config.publicOrigin}${base}/sitemap.xml`)
  return `${lines.join('\n')}\n`
}

function sitemap(): string {
  const urls = ['/', '/privacy', '/terms'].map(p => `  <url><loc>${htmlEscape(`${config.publicOrigin}${base}${p}`)}</loc></url>`)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`
}

/** RFC 9116 security.txt. 연락처(CONTACT_EMAIL)가 있을 때만 */
function securityTxt(): string {
  const expires = new Date(Date.now() + 365 * 24 * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z')
  const lines = [`Contact: mailto:${config.contactEmail}`, `Expires: ${expires}`, 'Preferred-Languages: ko, en']
  if (config.publicOrigin) lines.push(`Canonical: ${config.publicOrigin}/.well-known/security.txt`)
  return `${lines.join('\n')}\n`
}

/* ── 헬스 체크 ── */

const startedAt = Date.now()

/**
 * GET /healthz: DB가 답하면 200, 아니면 503. 업로드 폴더 상태는 참고로만 붙입니다 (다시 띄워도 낫지 않으므로 503으로 만들지 않음).
 * 요청 제한에서 빼고 캐시하지 않습니다.
 */
async function healthz(req: IncomingMessage, res: ServerResponse) {
  let ok = true
  let dbOk = true
  try {
    db.prepare('SELECT 1').get()
  } catch {
    dbOk = false
    ok = false
  }
  const up = uploadStats()
  const body = {
    ok,
    db: dbOk ? 'ok' : 'fail',
    uptime: Math.round((Date.now() - startedAt) / 1000),
    shrines: dbOk ? allShrines().length : null,
    uploads: { usedPct: up.usedPct, lowDisk: up.lowDisk, writable: up.writable },
  }
  res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' })
  res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body))
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  securityHeaders(req, res)
  const path = new URL(req.url ?? '/', 'http://local').pathname
  const method = req.method ?? 'GET'
  const read = method === 'GET' || method === 'HEAD'
  // 헬스 체크는 요청 제한 앞에서 (Docker HEALTHCHECK · 바깥 가동 감시)
  if (read && (path === `${base}/healthz` || path === '/healthz')) return healthz(req, res)
  if (!requestLimiter.allow(ipHash(clientIp(req)))) return text(res, 429, 'Too Many Requests')

  if (path === '/robots.txt') return text(res, 200, robots())
  if (read && path === '/.well-known/security.txt') return config.contactEmail ? text(res, 200, securityTxt()) : notFound(res, req)
  // 경로 앞부분을 쓸 때만 / → /shrine/ 로 보냅니다 (독립 도메인 루트면 그대로)
  if (base && (path === '/' || path === base)) return redirect(res, `${base}/`)
  // 예전 주소(/shrine/...)로 들어오면 도메인 루트의 같은 곳으로.
  // 앞의 / 여러 개는 하나로 (/shrine//evil.com → //evil.com 이면 다른 사이트로 가는 열린 리다이렉트가 됨)
  if (!base && (path === '/shrine' || path.startsWith('/shrine/'))) return redirect(res, `/${path.slice('/shrine'.length).replace(/^\/+/, '')}`)
  if (!path.startsWith(`${base}/`)) return notFound(res, req)

  const rel = path.slice(base.length)
  // 운영자 화면: ADMIN_PASSWORD가 없으면 404 (admin.ts)
  if (isAdminPath(rel)) return handleAdmin(req, res, rel)

  if (read && rel === '/') {
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }
    if (notModified(req, res, indexEtag, headers)) return
    res.writeHead(200, { ...headers, ETag: indexEtag })
    return res.end(method === 'HEAD' ? undefined : indexHtml)
  }
  const legal = LEGAL[rel]
  if (read && legal) return serveLegal(req, res, legal)
  // 문서 파일 주소로 들어오면 정식 주소로 (문서 안 상대 링크가 맞게)
  const legalFile = /^\/legal\/(privacy|terms)\.html$/.exec(rel)
  if (read && legalFile?.[1]) return redirect(res, `${base}/${legalFile[1]}`, 301)
  if (read && config.allowIndexing && config.publicOrigin && rel === '/sitemap.xml') {
    return text(res, 200, sitemap(), 'application/xml; charset=utf-8')
  }
  // 사당마다 channel(1~3)이 붙어 있습니다. 화면은 자기 채널(넘침 채널이면 1번)의 사당만 그립니다
  if (method === 'GET' && rel === '/api/world') {
    const chat = { free: config.freeChat, max: CHAT_MAX, postMax: POST_MAX, contact: config.contactEmail }
    // 게시판에 꽂힌 쪽지 색을 그리려고 최근 글 주제만 함께 보냅니다
    const recent = listPosts(16).map(p => p.topic)
    return json(res, 200, {
      world: WORLD_JSON, shrines: allShrines().map(publicShrine), candles: candleSummary(), chat,
      recentTopics: recent, registry: { open: true },
    }, 'no-cache')
  }
  if (method === 'GET' && rel === '/api/posts') {
    return json(res, 200, { posts: listPosts() })
  }
  if (method === 'POST' && rel === '/api/enter') return enter(req, res)
  if (method === 'POST' && rel === '/api/upload') return uploadApi(req, res)
  if (method === 'POST' && (rel === '/api/submit' || rel.startsWith('/api/manage/'))) return registryApi(req, res, rel)
  const up = /^\/img\/shrines\/up\/([A-Za-z0-9_-]{16}\.(?:png|jpg|webp))$/.exec(rel)
  if (read && up?.[1]) return serveUpload(req, res, up[1], ticketOf(req)?.sid ?? null) || notFound(res, req)
  const receipt = /^\/api\/submit\/([A-Za-z0-9_-]{16,32})$/.exec(rel)
  if (method === 'GET' && receipt?.[1]) {
    const st = statusByCode(receipt[1])
    return st ? json(res, 200, { ok: true, ...st }) : json(res, 404, { ok: false, reason: 'none' })
  }

  const go = /^\/go\/([a-z0-9-]{1,40})(\/repo)?$/.exec(rel)
  if (method === 'GET' && go?.[1]) return goTo(req, res, go[1], !!go[2])

  if (read) return serveStatic(req, res, rel)
  return notFound(res)
}
