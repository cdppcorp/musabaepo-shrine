// 사당 데이터와 입점 규칙, 초 · 클릭 집계.
// 규칙: 대표 링크는 https 도메인(IP 주소 불가), 글자 수 제한, 자리 번호 확인.
// 11/17: 등록소(registry.ts)에서 올라온 프로젝트도 사당이 됩니다. GitHub 저장소만 있는 프로젝트는
// domain을 'github.com/<owner>/<repo>'로 두고, 도메인 · 사업자 확인 없이(빈 값) 올라갈 수 있습니다.
import { isIP } from 'node:net'
import { db } from './db.ts'
import { daysSince, kstDate, kstWeekDays } from './util.ts'
import { PLOTS } from './world.ts'

export const PRAYER_KEYS = ['deploy', 'security', 'success', 'bug', 'payment', 'uptime'] as const
export type PrayerKey = (typeof PRAYER_KEYS)[number]
const CHARM_KEYS = ['zero-downtime', 'no-rollback', 'no-cve', 'no-friday', 'prod-db', 'no-404']
const DECO_KEYS = ['duck', 'coffee', 'makgeolli', 'cat', 'cactus']
export const CATEGORY_KEYS = ['business', 'productivity', 'commerce', 'education', 'devtools', 'content', 'life', 'etc']

export const isPrayerKey = (v: unknown): v is PrayerKey =>
  typeof v === 'string' && (PRAYER_KEYS as readonly string[]).includes(v)

export interface Shrine {
  slug: string
  name: string
  tagline: string
  category: string
  domain: string
  url: string
  operator: string
  keeper: boolean
  paid: boolean
  verifiedDomain: string
  verifiedBusiness: string | null
  joinedAt: string
  status: 'live' | 'check'
  prayer: PrayerKey
  charm: string | null
  deco: string[]
  /** public/img/shrines/ 아래 파일 이름. 첫 장이 모니터에 뜹니다. */
  screens: string[]
  capturedAt: string
  plot: number
  /** 사당 지붕 위 소개 (공백 포함 8글자) */
  sign: string
  /** GitHub 저장소 주소 (없으면 '') */
  repo: string
  /** 작성자 이메일 (등록소 접수 때 받음). emailPublic일 때만 화면에 보냅니다 */
  email: string
  emailPublic: boolean
  /** 등록소 접수 번호 (운영자가 직접 넣은 사당은 0) */
  projectId: number
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const SCREEN_RE = /^[a-z0-9][a-z0-9_-]{0,60}\.(?:jpg|jpeg|png|webp)$/
/** 등록소에서 올린 이미지 (DATA_DIR/uploads, 화면은 /img/shrines/up/<이름>) */
const UPLOAD_SCREEN_RE = /^up\/[A-Za-z0-9_-]{16}\.(?:png|jpg|webp)$/

const chars = (s: string) => Array.from(s).length
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/
const EMAIL_RE = /^[^\s@<>()"',;:]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i

/** GitHub 저장소 주소를 https://github.com/<owner>/<repo> 모양으로 (아니면 null). key는 소문자 'github.com/owner/repo' */
export function parseGithub(raw: string): { url: string; key: string; owner: string; repo: string } | null {
  let text = raw.trim()
  if (!text) return null
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null
  if (u.hostname.toLowerCase() !== 'github.com' && u.hostname.toLowerCase() !== 'www.github.com') return null
  const parts = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean)
  if (parts.length !== 2) return null
  const owner = parts[0] ?? ''
  const repo = (parts[1] ?? '').replace(/\.git$/i, '')
  if (!GITHUB_OWNER.test(owner) || !GITHUB_REPO.test(repo) || repo === '.' || repo === '..') return null
  return { url: `https://github.com/${owner}/${repo}`, key: `github.com/${owner}/${repo}`.toLowerCase(), owner, repo }
}

/** 서비스 주소: https, 실제 도메인(IP · localhost 불가), 포트 · 계정 정보 없음. 쿼리 · 해시는 뺍니다 (아니면 null) */
export function normalizeServiceUrl(raw: string): { url: string; host: string } | null {
  let text = raw.trim()
  if (!text || text.length > 200) return null
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null
  const host = u.hostname.toLowerCase()
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0 || !DOMAIN_RE.test(host) || host === 'localhost' || host.endsWith('.localhost')) return null
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')
  return { url: `https://${host}${path}`, host }
}

export const isValidEmail = (v: string) => v.length <= 80 && EMAIL_RE.test(v)

/** GitHub 저장소만 있는 사당의 domain 모양 */
const isGithubDomain = (domain: string) => /^github\.com\/[a-z0-9-]+\/[a-z0-9._-]+$/.test(domain)

/** 사당 대표 링크가 나가도 되는 곳인지 (서비스 가보기 직전에도 다시 봅니다) */
export function isSafeShrineUrl(s: Pick<Shrine, 'url' | 'domain'>): boolean {
  if (isGithubDomain(s.domain)) return parseGithub(s.url)?.key === s.domain
  return isAllowedServiceUrl(s.url, s.domain)
}

/** 대표 링크가 https이고, IP가 아닌 도메인이며, 확인한 도메인(또는 하위 도메인) 안에 있는지 */
export function isAllowedServiceUrl(raw: string, domain: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false
  const host = u.hostname.toLowerCase()
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0) return false
  return host === domain || host.endsWith(`.${domain}`)
}

/** 입점 규칙에 어긋난 이유 목록 (빈 배열 = 통과) */
export function validateShrine(s: Shrine): string[] {
  const e: string[] = []
  if (!SLUG_RE.test(s.slug)) e.push('slug 형식')
  if (chars(s.name) < 1 || chars(s.name) > 20) e.push('서비스명 1~20자')
  if (chars(s.tagline) < 1 || chars(s.tagline) > 40) e.push('한 줄 소개 1~40자')
  if (chars(s.sign ?? '') > 8) e.push('사당 소개는 공백 포함 8자까지')
  if (!CATEGORY_KEYS.includes(s.category)) e.push('카테고리')
  const github = isGithubDomain(s.domain)
  if (!github && (!DOMAIN_RE.test(s.domain) || isIP(s.domain) !== 0)) e.push('도메인 형식 (IP 주소 불가)')
  if (!isSafeShrineUrl(s)) e.push(github ? '대표 링크는 그 GitHub 저장소 주소' : '대표 링크는 https + 그 도메인 안')
  if (s.repo && !parseGithub(s.repo)) e.push('GitHub 저장소 주소 형식')
  if (s.email && !isValidEmail(s.email)) e.push('이메일 형식')
  if (!s.operator.trim() || chars(s.operator) > 20) e.push('운영자 표시명')
  // 등록소에서 올라온 사당은 도메인 · 사업자 확인 없이도 됩니다 (빈 값)
  if (s.verifiedDomain && !DATE_RE.test(s.verifiedDomain)) e.push('도메인 확인 날짜 형식')
  if (!s.verifiedDomain && !s.projectId) e.push('도메인 확인 날짜 (직접 넣는 사당)')
  if (s.verifiedBusiness && !DATE_RE.test(s.verifiedBusiness)) e.push('사업자 확인 날짜 형식')
  if (!DATE_RE.test(s.joinedAt) || !DATE_RE.test(s.capturedAt)) e.push('날짜 형식')
  if (s.status !== 'live' && s.status !== 'check') e.push('상태')
  if (!isPrayerKey(s.prayer)) e.push('현판 기원')
  if (s.charm && !CHARM_KEYS.includes(s.charm)) e.push('부적')
  if (s.deco.length > 3 || s.deco.some(d => !DECO_KEYS.includes(d))) e.push('소품 최대 3개')
  // 실제 화면은 직접 넣는 사당은 1~3장, 등록소 사당은 없어도 됩니다
  // 올린 이미지는 up/<무작위 이름> (DATA_DIR/uploads). 등록소 사당과 운영자 화면에서 넣는 사당이 씁니다
  const okScreen = (f: string) => SCREEN_RE.test(f) || UPLOAD_SCREEN_RE.test(f)
  if (s.screens.length < (s.projectId ? 0 : 1) || s.screens.length > 3 || s.screens.some(f => !okScreen(f))) e.push('실제 화면 1~3장')
  if (!Number.isInteger(s.plot) || !PLOTS[s.plot]) e.push('자리 번호')
  return e
}

/* ── 처음 띄울 때 넣는 자리: 없음 (빈 맵으로 시작) ──
   사당은 프로젝트 등록소 접수 → 운영자 승인, 또는 관리자 페이지 · 운영 도구(npm run shrine)로 넣습니다. */
const SEED: Shrine[] = []

const insertStmt = db.prepare(`
  INSERT INTO shrines (slug, name, tagline, category, domain, url, operator, keeper, paid, verified_domain,
    verified_business, joined_at, status, prayer, charm, deco, screens, captured_at, plot, repo, email, email_public, project_id, sign)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)

export function insertShrine(s: Shrine) {
  const errors = validateShrine(s)
  if (errors.length) throw new Error(`입점 규칙에 맞지 않습니다: ${errors.join(' / ')}`)
  insertStmt.run(s.slug, s.name, s.tagline, s.category, s.domain, s.url, s.operator, s.keeper ? 1 : 0, s.paid ? 1 : 0,
    s.verifiedDomain, s.verifiedBusiness, s.joinedAt, s.status, s.prayer, s.charm, JSON.stringify(s.deco),
    JSON.stringify(s.screens), s.capturedAt, s.plot, s.repo, s.email, s.emailPublic ? 1 : 0, s.projectId, s.sign ?? '')
  shrineCache = null
}

export function seedShrines() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM shrines').get() as { n: number }
  if (row.n === 0) for (const s of SEED) insertShrine(s)
}

export interface ShrineRow {
  slug: string; name: string; tagline: string; category: string; domain: string; url: string; operator: string
  keeper: number; paid: number; verified_domain: string; verified_business: string | null; joined_at: string
  status: 'live' | 'check'; prayer: PrayerKey; charm: string | null; deco: string; screens: string
  captured_at: string; plot: number; repo: string; email: string; email_public: number; project_id: number; sign: string
}

export function fromRow(r: ShrineRow): Shrine {
  const list = (raw: string) => {
    try {
      const v: unknown = JSON.parse(raw)
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }
  return {
    slug: r.slug, name: r.name, tagline: r.tagline, category: r.category, domain: r.domain, url: r.url,
    operator: r.operator, keeper: r.keeper === 1, paid: r.paid === 1, verifiedDomain: r.verified_domain,
    verifiedBusiness: r.verified_business, joinedAt: r.joined_at, status: r.status, prayer: r.prayer,
    charm: r.charm, deco: list(r.deco), screens: list(r.screens), capturedAt: r.captured_at, plot: r.plot,
    repo: r.repo ?? '', email: r.email ?? '', emailPublic: r.email_public === 1, projectId: r.project_id ?? 0,
    sign: r.sign ?? '',
  }
}

let shrineCache: Shrine[] | null = null
let shrineCacheAt = 0
/** 운영 도구(cli)로 바꾼 내용도 서버를 다시 띄우지 않고 30초 안에 맵에 반영되게 합니다 */
const SHRINE_CACHE_MS = 30_000
const warned = new Set<string>()

/** 규칙을 통과한 사당만. 어긋난 사당은 로그에 이유를 남기고 맵에서 뺍니다. */
export function allShrines(): Shrine[] {
  if (shrineCache && Date.now() - shrineCacheAt < SHRINE_CACHE_MS) return shrineCache
  const rows = db.prepare('SELECT * FROM shrines ORDER BY plot').all() as unknown as ShrineRow[]
  shrineCache = rows.map(fromRow).filter(s => {
    const errors = validateShrine(s)
    const why = `${s.slug}: ${errors.join(' / ')}`
    if (errors.length && !warned.has(why)) {
      warned.add(why)
      console.warn(`[shrine] '${s.slug}' 사당을 숨겼습니다: ${errors.join(' / ')}`)
    }
    return errors.length === 0
  })
  shrineCacheAt = Date.now()
  return shrineCache
}

export const findShrine = (slug: string) => allShrines().find(s => s.slug === slug)
export const clearShrineCache = () => { shrineCache = null }

/**
 * 화면으로 내려보내는 모양. 대표 링크(url)와 결제 여부는 보내지 않습니다 (서비스 가보기는 /go 경유, 저장소는 /go/<slug>/repo).
 * repo는 GitHub 저장소 주소('' = 없음), email은 작성자가 공개를 고른 경우에만 넣습니다.
 */
export function publicShrine(s: Shrine) {
  return {
    repo: s.repo, fromProject: s.projectId > 0, sign: s.sign || [...s.tagline].slice(0, 8).join('').trim(), ...(s.emailPublic && s.email ? { email: s.email } : {}),
    slug: s.slug, name: s.name, tagline: s.tagline, category: s.category, domain: s.domain, operator: s.operator,
    keeper: s.keeper, business: !!s.verifiedBusiness, verifiedDomain: s.verifiedDomain,
    verifiedBusiness: s.verifiedBusiness, joinedAt: s.joinedAt, status: s.status, prayer: s.prayer,
    charm: s.charm, deco: s.deco, screens: s.screens, capturedAt: s.capturedAt, plot: s.plot,
    isNew: daysSince(s.joinedAt) >= 0 && daysSince(s.joinedAt) < 7,
  }
}

/* ── 초 · 클릭 ── */

/** 초 집계: week는 이번 주(월요일부터) 사당별, weekTotal은 이번 주 전체, today는 오늘 전체 */
export interface CandleSummary {
  week: Record<string, number>
  weekTotal: number
  today: number
}

let summaryCache: { at: number; value: CandleSummary } | null = null

export function addCandle(slug: string, prayer: PrayerKey) {
  db.prepare(`INSERT INTO candles (day, slug, prayer, n) VALUES (?, ?, ?, 1)
              ON CONFLICT (day, slug, prayer) DO UPDATE SET n = n + 1`).run(kstDate(), slug, prayer)
  summaryCache = null
}

export function candleSummary(): CandleSummary {
  if (summaryCache && Date.now() - summaryCache.at < 15_000) return summaryCache.value
  const days = kstWeekDays()
  const marks = days.map(() => '?').join(',')
  const rows = db.prepare(`SELECT slug, SUM(n) AS n FROM candles WHERE day IN (${marks}) GROUP BY slug`)
    .all(...days) as unknown as { slug: string; n: number }[]
  const today = db.prepare('SELECT COALESCE(SUM(n), 0) AS n FROM candles WHERE day = ?').get(kstDate()) as { n: number }
  const value = { week: Object.fromEntries(rows.map(r => [r.slug, r.n])), weekTotal: rows.reduce((a, r) => a + r.n, 0), today: today.n }
  summaryCache = { at: Date.now(), value }
  return value
}

export function addClick(slug: string) {
  db.prepare(`INSERT INTO clicks (day, slug, n) VALUES (?, ?, 1)
              ON CONFLICT (day, slug) DO UPDATE SET n = n + 1`).run(kstDate(), slug)
}
