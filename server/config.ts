// 환경 변수에서 설정을 읽고 검사합니다 (.env.example에 모든 값의 설명이 있습니다).
//   · 형식이 틀린 값(숫자 칸에 글자, true/false 칸에 다른 말 등)은 운영 · 개발 모두 시작하지 않습니다.
//   · 운영(NODE_ENV=production)에서는 빠졌거나 약하거나 예시 그대로인 값도 시작하지 않습니다.
//     (입장 표 서명 키, Cloudflare Turnstile 키, 공개 주소, 운영 연락처, 운영자 비밀번호, 알림 주소)
//   · 개발에서는 안전한 기본값을 쓰고, 문제 있는 선택 값은 경고만 하고 그 기능을 끕니다.
// 문제는 한 번에 모두 모아서 보여 줍니다.
import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'

const env = process.env
const get = (name: string) => (env[name] ?? '').trim()

const nodeEnv = get('NODE_ENV')
export const isProd = nodeEnv === 'production'

/** 운영 · 개발 모두 시작하지 않는 문제 (형식이 틀림) */
const errors: string[] = []
/** 운영에서만 시작하지 않는 문제 (빠짐 · 약함 · 예시 값) */
const prodErrors: string[] = []
/** 개발에서 알려 주기만 하는 문제 */
const warnings: string[] = []
/** 운영이면 시작 거부, 개발이면 경고 */
const prodOnly = (msg: string) => (isProd ? prodErrors : warnings).push(msg)

if (nodeEnv && !['production', 'development', 'test'].includes(nodeEnv)) {
  errors.push(`NODE_ENV는 production(운영) 또는 development(개발)입니다. 지금 값: "${nodeEnv}"`)
}

/* ── 검사 도구 ── */

/** 예시로 흔히 넣는 글자. 무작위 16진 · base64 값에는 나오지 않는 말만 둡니다 */
const EXAMPLE_WORDS = ['change', 'example', 'secret', 'password', 'passwd', 'sample', 'dummy', 'replace', 'your', 'test', 'todo', 'xxxx', 'qwer', 'admin']

/** 비밀 값이 약하면 이유, 괜찮으면 null */
export function secretWeakness(v: string, minDistinct = 10): string | null {
  const low = v.toLowerCase()
  const word = EXAMPLE_WORDS.find(w => low.includes(w))
  if (word) return `예시 글자('${word}')가 들어 있습니다`
  if (new Set(v).size < minDistinct) return '쓰인 글자 종류가 너무 적습니다'
  if (/(.)\1{5,}/.test(v) || /(.{2,8})\1{3,}/.test(v)) return '같은 글자나 묶음이 되풀이됩니다'
  return null
}

/** 예시 · 로컬 주소 (운영에 넣으면 안 되는 도메인) */
export function isPlaceholderHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!h || isIP(h)) return !h || h.startsWith('127.') || h === '::1' || h === '0.0.0.0'
  return /(^|\.)example\.(com|net|org)$/.test(h) || /(^|\.)(localhost|test|example|invalid|local)$/.test(h)
}

/** 비워 두면 기본값. 'true' · 'false'만 받습니다 */
function bool(name: string, fallback: boolean): boolean {
  const v = get(name).toLowerCase()
  if (!v) return fallback
  if (v === 'true') return true
  if (v === 'false') return false
  errors.push(`${name}는 true 또는 false입니다. 지금 값: "${get(name)}"`)
  return fallback
}

/** 비워 두면 기본값. 'on' · 'off'만 받습니다 */
function onOff(name: string, fallback: boolean): boolean {
  const v = get(name).toLowerCase()
  if (!v) return fallback
  if (v === 'on') return true
  if (v === 'off') return false
  errors.push(`${name}는 on 또는 off입니다. 지금 값: "${get(name)}"`)
  return fallback
}

/** 비워 두면 기본값. min~max 정수만 받습니다 */
function int(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const raw = get(name)
  if (!raw) return fallback
  const n = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
    errors.push(`${name}는 ${max === Number.MAX_SAFE_INTEGER ? `${min} 이상의` : `${min}~${max} 사이`} 정수입니다. 지금 값: "${raw}"`)
    return fallback
  }
  return n
}

/* ── 서버 ── */

const port = int('PORT', 3300, 1, 65535)
const host = get('HOST') || '127.0.0.1'
if (!isIP(host.replace(/^\[|\]$/g, '')) && !/^[a-z0-9.-]+$/i.test(host)) errors.push(`HOST는 IP 주소나 호스트 이름입니다. 지금 값: "${host}"`)

const basePath = get('BASE_PATH').replace(/\/$/, '')
if (!/^(\/[a-z0-9-]+)*$/.test(basePath)) errors.push('BASE_PATH는 비우거나 /shrine 같은 모양입니다 (영문 소문자 · 숫자 · -)')

/* ── 공개 주소 ── */

let publicOrigin = get('PUBLIC_ORIGIN').replace(/\/$/, '')
const shrineDomain = get('SHRINE_DOMAIN').toLowerCase()
if (publicOrigin) {
  let u: URL | null = null
  try {
    u = new URL(publicOrigin)
  } catch { /* 아래에서 알림 */ }
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin !== publicOrigin.toLowerCase()) {
    errors.push(`PUBLIC_ORIGIN은 https://shrine.my-domain.com 처럼 경로 없이 주소 앞부분만 넣습니다. 지금 값: "${publicOrigin}"`)
  } else {
    publicOrigin = u.origin
    if (isProd && u.protocol !== 'https:') prodErrors.push('PUBLIC_ORIGIN은 운영에서 https://로 시작해야 합니다')
    if (isProd && isPlaceholderHost(u.hostname)) prodErrors.push(`PUBLIC_ORIGIN이 예시 · 로컬 주소(${u.hostname})입니다. 실제 운영 도메인을 넣어 주세요`)
    if (isProd && shrineDomain && shrineDomain !== u.host) prodErrors.push(`PUBLIC_ORIGIN의 도메인(${u.host})과 SHRINE_DOMAIN(${shrineDomain})이 다릅니다`)
  }
} else if (isProd) {
  prodErrors.push('PUBLIC_ORIGIN이 비어 있습니다 (예: https://shrine.my-domain.com). WebSocket · 입장 요청의 출처 확인에 씁니다')
}
if (shrineDomain) {
  if (!/^[a-z0-9.-]+$/.test(shrineDomain)) errors.push(`SHRINE_DOMAIN은 shrine.my-domain.com 같은 도메인 이름만 넣습니다. 지금 값: "${shrineDomain}"`)
  else if (isProd && isPlaceholderHost(shrineDomain)) prodErrors.push(`SHRINE_DOMAIN이 예시 · 로컬 주소(${shrineDomain})입니다`)
}

/* ── 입장 표 서명 키 ── */

const ticketSecretRaw = get('TICKET_SECRET')
if (!ticketSecretRaw) {
  if (isProd) prodErrors.push('TICKET_SECRET이 비어 있습니다 (32자 이상 무작위 값, .env.example의 만드는 법 참고)')
} else if (ticketSecretRaw.length < 32) {
  prodOnly(`TICKET_SECRET은 32자 이상이어야 합니다 (지금 ${ticketSecretRaw.length}자)`)
} else {
  const weak = secretWeakness(ticketSecretRaw)
  if (weak) prodOnly(`TICKET_SECRET이 약합니다: ${weak}. 무작위 값으로 바꿔 주세요`)
}
const ticketSecret = ticketSecretRaw || randomBytes(32).toString('hex')

/* ── Cloudflare Turnstile ── */

const turnstileSiteKey = get('TURNSTILE_SITE_KEY')
const turnstileSecret = get('TURNSTILE_SECRET')
if (!/^[\w-]*$/.test(turnstileSiteKey)) errors.push('TURNSTILE_SITE_KEY 형식이 올바르지 않습니다 (영문 · 숫자 · _ · -만)')
if (isProd) {
  if (!turnstileSiteKey) prodErrors.push('TURNSTILE_SITE_KEY가 비어 있습니다 (Cloudflare 대시보드 → Turnstile에서 운영 도메인으로 발급)')
  if (!turnstileSecret) prodErrors.push('TURNSTILE_SECRET이 비어 있습니다')
  // Cloudflare 공개 시험 키(1x0000…, 2x0000…, 3x0000…)는 사람 확인을 늘 통과시키거나 늘 막습니다
  if (/^[123]x0{8,}/i.test(turnstileSiteKey)) prodErrors.push('TURNSTILE_SITE_KEY가 Cloudflare 시험용 키입니다. 운영 도메인으로 발급한 키를 넣어 주세요')
  if (/^[123]x0{8,}/i.test(turnstileSecret)) prodErrors.push('TURNSTILE_SECRET이 Cloudflare 시험용 키입니다 (봇 차단이 꺼집니다)')
}

/* ── 운영 연락처 ── */

const contactEmail = get('CONTACT_EMAIL')
if (contactEmail) {
  const at = contactEmail.lastIndexOf('@')
  if (contactEmail.length > 120 || !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(contactEmail)) {
    errors.push(`CONTACT_EMAIL이 메일 주소 모양이 아닙니다. 지금 값: "${contactEmail}"`)
  } else if (isProd && isPlaceholderHost(contactEmail.slice(at + 1))) {
    prodErrors.push('CONTACT_EMAIL이 예시 주소입니다. 실제로 받는 운영 메일을 넣어 주세요')
  }
} else if (isProd) {
  prodErrors.push('CONTACT_EMAIL이 비어 있습니다. 화면 아래 · 개인정보 처리방침에 보이는 운영 연락처입니다')
}

/* ── 운영자 화면 ── */

const PASSWORD_MIN = 16
const PASSWORD_MAX = 256
let adminPassword = get('ADMIN_PASSWORD')
const adminIps: string[] = []
if (adminPassword) {
  const len = [...adminPassword].length
  if (len < PASSWORD_MIN || len > PASSWORD_MAX) {
    prodOnly(`ADMIN_PASSWORD는 ${PASSWORD_MIN}~${PASSWORD_MAX}자여야 합니다 (지금 ${len}자). 운영자 화면을 켜지 않습니다`)
    adminPassword = ''
  } else {
    const weak = secretWeakness(adminPassword, 8)
    if (weak && isProd) prodErrors.push(`ADMIN_PASSWORD가 약합니다: ${weak}. 무작위 값으로 바꿔 주세요`)
    else if (weak) warnings.push(`ADMIN_PASSWORD가 약합니다: ${weak} (개발이라 그대로 켭니다. 운영에서는 시작하지 않습니다)`)
  }
  for (const raw of get('ADMIN_IPS').split(',')) {
    let ip = raw.trim().toLowerCase()
    if (!ip) continue
    if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7)
    if (!isIP(ip)) {
      prodOnly(`ADMIN_IPS에 IP 주소가 아닌 값("${raw.trim()}")이 있습니다 (쉼표로 나눈 IP만). 운영자 화면을 켜지 않습니다`)
      adminPassword = ''
      break
    }
    adminIps.push(ip)
  }
}

/* ── 운영자 알림 (notify.ts가 직접 읽습니다. 여기서는 검사만) ── */

const notifyUrl = get('NOTIFY_WEBHOOK_URL')
if (notifyUrl) {
  let u: URL | null = null
  try {
    u = new URL(notifyUrl)
  } catch { /* 아래에서 알림 */ }
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) prodOnly('NOTIFY_WEBHOOK_URL이 웹 주소(https://…) 모양이 아닙니다. 알림을 보내지 않습니다')
  else if (isProd && u.protocol !== 'https:') prodErrors.push('NOTIFY_WEBHOOK_URL은 운영에서 https://여야 합니다 (웹훅 주소 자체가 비밀입니다)')
}

/* ── 그 밖의 선택 값 (다른 파일이 직접 읽는 것도 형식만 미리 봅니다) ── */

onOff('GITHUB_CHECK', true)
int('BACKUP_KEEP', 14, 1, 10_000)
int('BACKUP_MAX_DAYS', 14, 1, 10_000)
/** 0 이상의 일 수 (retention.ts가 직접 읽음) */
for (const name of ['RETENTION_DAYS', 'PENDING_DAYS']) {
  const raw = get(name)
  if (raw && !(/^\d+(\.\d+)?$/.test(raw) && Number.isFinite(Number(raw)))) errors.push(`${name}는 0 이상의 숫자(일)입니다. 지금 값: "${raw}"`)
}
if (/\s/.test(get('GITHUB_TOKEN'))) errors.push('GITHUB_TOKEN에 빈칸이 들어 있습니다')
const acmeEmail = get('ACME_EMAIL')
if (acmeEmail && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(acmeEmail)) errors.push(`ACME_EMAIL이 메일 주소 모양이 아닙니다. 지금 값: "${acmeEmail}"`)

export const config = {
  port,
  host,
  /** 주소 앞부분. 기본은 도메인 루트(''). 다른 사이트 아래 /shrine 같은 경로로 붙일 때만 씁니다 */
  basePath,
  publicOrigin,
  trustProxy: bool('TRUST_PROXY', false),
  dataDir: get('DATA_DIR') || './data',
  ticketSecret,
  turnstileSiteKey,
  turnstileSecret,
  allowIndexing: bool('ALLOW_INDEXING', false),
  /** 직접 쓰는 메시지. FREE_CHAT=off면 고르는 말풍선만 남습니다. 운영자 화면에서 서버를 띄운 동안만 바꿀 수 있습니다 */
  freeChat: onOff('FREE_CHAT', true),
  /** AI 트렌드 게시판 글쓰기 · 글 신고 (기본 꺼짐 = 화면에 '준비 중'). 꺼져 있으면 실시간으로 오는 글 · 신고를 받지 않습니다 */
  boardOpen: onOff('BOARD_OPEN', false),
  /** 화면에 보이는 운영 연락처 (문제 신고). 운영에서는 꼭 넣습니다 */
  contactEmail,
  /** 같은 사람이 같은 사당에 초를 다시 켤 수 있을 때까지 (ms, 기본 30분). 시험할 때만 줄입니다 */
  candleCooldownMs: int('CANDLE_COOLDOWN_MS', 30 * 60_000),
  /** 같은 IP에서 동시에 열 수 있는 실시간 연결 수. 통신사 CGNAT · 회사 · 행사장 Wi-Fi를 생각해 넉넉히 */
  wsMaxPerIp: int('WS_MAX_PER_IP', 12, 1, 1000),
  /** 운영자 화면 비밀번호 (비었거나 약하면 '' = 운영자 화면 꺼짐) */
  adminPassword,
  /** 운영자 화면을 열 수 있는 IP (비면 제한 없음) */
  adminIps,
}

const fatal = [...errors, ...prodErrors]
if (fatal.length) {
  console.error([
    `[shrine] 설정에 문제가 있어 시작하지 않습니다${isProd ? ' (운영 모드)' : ''}:`,
    ...fatal.map(s => `  - ${s}`),
    '  .env.example을 참고해 .env를 고친 뒤 다시 시작해 주세요.',
  ].join('\n'))
  process.exit(1)
}
for (const w of warnings) console.warn(`[shrine] 설정 경고: ${w}`)

/** 개발에서 Turnstile 키가 없으면 사람 확인을 건너뜁니다. 운영에서는 절대 켜지지 않습니다. */
export const devSkipHumanCheck = !isProd && !turnstileSecret
