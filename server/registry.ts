// 내 프로젝트 등록소: 누구나 GitHub 저장소나 서비스 주소로 프로젝트를 접수합니다. 사업자 확인은 받지 않습니다.
//   접수 → 운영자 검토(관리자 페이지 또는 npm run shrine -- approve) → 맵의 빈 사당 자리에 올라갑니다.
//   접수할 때 채널(1~3)과 그 채널의 자리를 고를 수 있습니다 (사당은 자기 채널에서만 보입니다). 고른 채널 · 자리는 want_channel · want_plot.
//   맵에 오른 뒤 이름 · 소개 · 지붕 글자 · 링크 · 이미지를 바꾸면 운영자가 다시 볼 때까지 pending_* 칸에 두고, 사당은 그대로입니다.
//   분류 · 이메일 · 이메일 공개 여부는 바로 반영합니다.
//   이메일은 접수 때 꼭 받고(개인정보 수집 동의 consent 필수), 공개 여부는 작성자가 고릅니다 (공개를 고른 경우에만 사당 창에 보임).
//   관리 비밀번호(PIN)로 나중에 고치거나 내릴 수 있습니다. 관리 비밀번호(PIN)는 숫자 4자리입니다 (12자리까지 받음).
//   PIN은 scrypt 해시로만 저장하고, 틀리면 프로젝트당 5번(15분 잠금) · IP당 하루 30번에서 잠기고,
//   한 프로젝트가 하루 20번 틀리면 24시간 잠그고 운영자에게 알립니다 (이 잠금은 DB에 둬서 다시 띄워도 남습니다).
//   반려 · 내린 접수의 개인정보는 30일 뒤 retention.ts가 파기합니다. 90일 동안 처리하지 못한 검토는 저절로 끝냅니다.
//   이메일 · PIN은 로그와 알림에 남기지 않습니다.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { cleanChat } from './chat.ts'
import { db } from './db.ts'
import { notify } from './notify.ts'
import {
  CATEGORY_KEYS, clearShrineCache, freePlotsIn, insertShrine, isValidEmail, normalizeServiceUrl, parseGithub,
  plotTaken, validateShrine, type Shrine,
} from './shrines.ts'
import { kstDate } from './util.ts'
import { grantUploadView, ownsUpload } from './uploads.ts'
import { CHANNELS, PLOTS, isChannel } from './world.ts'

export const NAME_MAX = 20
export const TAGLINE_MAX = 40
/** 새로 정하는 PIN: 숫자 4자리(화면 기준) ~ 12자리. 짧은 대신 잠금(IP 15분 · 접수별 하루 20번 → 24시간)으로 막습니다 */
const NEW_PIN_RE = /^\d{4,12}$/
/** 확인할 때 받는 PIN: 예전 4자리도 */
const PIN_RE = /^\d{4,12}$/
const CODE_RE = /^[A-Za-z0-9_-]{16,32}$/
/** 접수: 한 사람(입장 표) 2분에 하나, IP당 하루 3개 */
const SUBMIT_GAP_MS = 2 * 60_000
const SUBMITS_PER_DAY = 3
/** PIN: 프로젝트당 5번 틀리면 15분 잠금, IP당 하루 30번 틀리면 그날 잠금, 프로젝트당 하루 20번 틀리면 24시간 잠금 */
const PIN_TRIES = 5
const PIN_LOCK_MS = 15 * 60_000
const PIN_FAILS_PER_DAY = 30
const PIN_FAILS_PER_PROJECT_DAY = 20
const PIN_DAY_LOCK_MS = 24 * 3600_000

export type ProjectStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn'

interface ProjectRow {
  id: number; code: string; at: number; name: string; tagline: string; category: string; sign: string
  github: string; url: string; email: string; email_public: number; pin_hash: string; nick: string
  status: ProjectStatus; note: string; slug: string; pending_github: string | null; pending_url: string | null
  repo_ok: number; stars: number; screen: string; pending_screen: string | null; want_plot: number | null; want_channel: number | null
  pending_name: string | null; pending_tagline: string | null; pending_sign: string | null
  consent_at: number | null; review_at: number | null; closed_at: number | null; purged_at: number | null
}

/* ── 표 구조 보강 ──
   이 파일이 쓰는 칸 · 표가 없으면 만듭니다 (있으면 그대로). db.ts 마이그레이션에 같은 칸을 넣어도 겹치지 않습니다.
   pending_name · pending_tagline · pending_sign: 맵에 오른 사당의 글자를 바꾸면 검토 전까지 여기에 (NULL = 바꾼 것 없음)
   consent_at: 개인정보 수집 동의 시각 · review_at: 지금 검토를 기다리기 시작한 시각 (90일 지나면 저절로 끝냄)
   closed_at: 반려되거나 내린 시각 (30일 뒤 파기) · purged_at: 개인정보를 파기한 시각
   want_channel: 등록할 때 고른 채널 (NULL = 아무 채널, db.ts v4)
   pin_locks: 프로젝트별 그날 PIN 틀린 횟수와 24시간 잠금 */
function ensureColumn(table: string, column: string, spec: string) {
  const has = () => (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).some(c => c.name === column)
  if (has()) return
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`)
  } catch (e) {
    if (!has()) throw e
  }
}
for (const col of ['pending_name', 'pending_tagline', 'pending_sign']) ensureColumn('projects', col, 'TEXT')
for (const col of ['consent_at', 'review_at', 'closed_at', 'purged_at', 'want_channel']) ensureColumn('projects', col, 'INTEGER')
db.exec(`CREATE TABLE IF NOT EXISTS pin_locks (
  project_id INTEGER PRIMARY KEY,
  day        TEXT NOT NULL,
  fails      INTEGER NOT NULL DEFAULT 0,
  until      INTEGER NOT NULL DEFAULT 0
)`)

/** 실패: HTTP 상태 + 화면이 읽는 까닭 */
export interface Fail { ok: false; status: number; reason: string }
const fail = (status: number, reason: string): Fail => ({ ok: false, status, reason })

const linkChange = (r: ProjectRow) => r.pending_github != null || r.pending_url != null
const textChange = (r: ProjectRow) => r.pending_name != null || r.pending_tagline != null || r.pending_sign != null
/** 맵에 오른 사당에 검토를 기다리는 변경이 있는지 */
const hasChange = (r: ProjectRow) => linkChange(r) || textChange(r) || r.pending_screen != null

/** 지금 반영된 값 + 검토를 기다리는 값(pending*)을 따로. PIN 해시 · 접수 코드 · 닉네임은 빼고 */
function view(r: ProjectRow) {
  return {
    id: r.id, status: r.status, name: r.name, tagline: r.tagline, sign: r.sign ?? '', category: r.category, github: r.github, url: r.url,
    email: r.email, emailPublic: r.email_public === 1, slug: r.slug,
    pendingGithub: r.pending_github, pendingUrl: r.pending_url,
    pendingName: r.pending_name ?? null, pendingTagline: r.pending_tagline ?? null, pendingSign: r.pending_sign ?? null,
    note: r.note, screen: r.screen ?? '', pendingScreen: r.pending_screen ?? null, wantPlot: r.want_plot ?? null,
    wantChannel: wishChannel(r),
  }
}

/** 작성자가 고른 채널 (NULL = 아무 채널). 자리만 골라 둔 예전 접수는 1번 채널로 봅니다 */
const wishChannel = (r: ProjectRow): number | null => r.want_channel ?? (r.want_plot != null ? 1 : null)

/**
 * 작성자에게 돌려주는 모양. 고칠 칸(이름 · 소개 · 지붕 글자 · 링크)에는 검토를 기다리는 값이 있으면 그 값을 넣습니다.
 * 그래서 다른 칸만 고쳐 다시 저장해도 검토 요청이 풀리지 않습니다. 지금 맵의 값은 운영자 화면에서 봅니다.
 */
function ownerView(r: ProjectRow) {
  const links = linkChange(r)
  return {
    ...view(r),
    name: r.pending_name ?? r.name, tagline: r.pending_tagline ?? r.tagline, sign: r.pending_sign ?? r.sign ?? '',
    github: links ? (r.pending_github ?? '') : r.github, url: links ? (r.pending_url ?? '') : r.url,
  }
}

const getRow = (id: number) => db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined

/** 바뀐 것 이름 (알림 · 메시지용) */
function changeKinds(r: ProjectRow): string[] {
  const kinds: string[] = []
  if (textChange(r)) kinds.push('글자')
  if (r.pending_screen != null) kinds.push('이미지')
  if (linkChange(r)) kinds.push('링크')
  return kinds
}

/* ── 입력 검사 ── */

/** 사당 지붕 위 소개 (공백 포함 8글자) */
const SIGN_MAX = 8

/** 소개: 비어 있으면 한 줄 소개 앞 8자로 */
function cleanSign(raw: unknown, tagline: string): { ok: true; text: string } | Fail {
  if (raw == null || (typeof raw === 'string' && !raw.trim())) return { ok: true, text: [...tagline].slice(0, SIGN_MAX).join('').trim() }
  return cleanText(raw, SIGN_MAX, 'sign')
}

function cleanText(raw: unknown, max: number, field: 'name' | 'tagline' | 'sign'): { ok: true; text: string } | Fail {
  const v = cleanChat(raw, max)
  if (v.ok) return v
  // 욕설 · 연락처는 그 까닭대로, 빈칸 · 길이 · 이름에 들어간 링크는 칸 이름으로 돌려줍니다
  if (v.reason === 'word' || v.reason === 'contact') return fail(400, v.reason)
  return fail(400, field)
}

function cleanEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const e = raw.trim().toLowerCase()
  return isValidEmail(e) ? e : null
}

export interface Links { github: string; url: string }

/** GitHub · 서비스 주소 읽기 ('' = 없음). 서비스 주소 칸에 GitHub 주소를 넣으면 GitHub로 봅니다 */
export function readLinks(githubRaw: unknown, urlRaw: unknown): { ok: true; links: Links } | Fail {
  const gText = typeof githubRaw === 'string' ? githubRaw.trim() : ''
  const uText = typeof urlRaw === 'string' ? urlRaw.trim() : ''
  if ((githubRaw != null && typeof githubRaw !== 'string') || (urlRaw != null && typeof urlRaw !== 'string')) return fail(400, 'link')
  let github = ''
  let url = ''
  if (gText) {
    const g = parseGithub(gText)
    if (!g) return fail(400, 'github')
    github = g.url
  }
  if (uText) {
    const asGithub = parseGithub(uText)
    if (asGithub && !github) github = asGithub.url
    else {
      const u = normalizeServiceUrl(uText)
      if (!u) return fail(400, 'url')
      if (u.host === 'github.com' || u.host === 'www.github.com') return fail(400, 'url')
      url = u.url
    }
  }
  if (!github && !url) return fail(400, 'link')
  return { ok: true, links: { github, url } }
}

/** 사당 domain 자리에 들어갈 값: 서비스 주소가 있으면 그 호스트, 없으면 'github.com/owner/repo' */
export function domainOf(l: Links): string {
  if (l.url) return normalizeServiceUrl(l.url)?.host ?? ''
  return parseGithub(l.github)?.key ?? ''
}

/** 같은 GitHub 저장소나 같은 서비스 도메인이 이미 접수(검토 중 · 승인)됐거나 사당에 있는지 */
function isDuplicate(l: Links, exceptId: number): boolean {
  const keys = new Set<string>()
  if (l.github) keys.add(parseGithub(l.github)?.key ?? '')
  if (l.url) keys.add(normalizeServiceUrl(l.url)?.host ?? '')
  keys.delete('')
  const rows = db.prepare(`SELECT id, github, url, pending_github, pending_url FROM projects
                           WHERE status IN ('pending', 'approved') AND id <> ?`).all(exceptId) as unknown as
    { id: number; github: string; url: string; pending_github: string | null; pending_url: string | null }[]
  for (const r of rows) {
    for (const g of [r.github, r.pending_github]) if (g && keys.has(parseGithub(g)?.key ?? '')) return true
    for (const u of [r.url, r.pending_url]) if (u && keys.has(normalizeServiceUrl(u)?.host ?? '')) return true
  }
  const shrines = db.prepare('SELECT domain, repo, project_id FROM shrines').all() as unknown as
    { domain: string; repo: string; project_id: number }[]
  for (const s of shrines) {
    if (s.project_id === exceptId && exceptId > 0) continue
    if (keys.has(s.domain)) return true
    if (s.repo && keys.has(parseGithub(s.repo)?.key ?? '')) return true
  }
  return false
}

/**
 * GitHub에 저장소가 있는지 가볍게 확인합니다 (3초). 없거나 비공개면 false, 확인을 못 하면 null.
 * GITHUB_CHECK=off면 확인하지 않습니다 (시험 · 오프라인).
 * GITHUB_TOKEN(권한 없는 토큰)을 넣으면 서버 IP당 시간 60번 제한 대신 토큰 제한을 씁니다.
 */
async function checkGithub(github: string): Promise<{ exists: boolean | null; stars: number }> {
  const g = parseGithub(github)
  if (!g || process.env.GITHUB_CHECK === 'off') return { exists: null, stars: 0 }
  const token = (process.env.GITHUB_TOKEN ?? '').trim()
  try {
    const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(g.owner)}/${encodeURIComponent(g.repo)}`, {
      headers: { 'User-Agent': 'musabaepo-shrine', Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(3000),
    })
    if (res.status === 404) return { exists: false, stars: 0 }
    if (!res.ok) return { exists: null, stars: 0 }
    const data = (await res.json()) as { private?: boolean; stargazers_count?: number }
    if (data.private) return { exists: false, stars: 0 }
    return { exists: true, stars: Number(data.stargazers_count) || 0 }
  } catch {
    return { exists: null, stars: 0 }
  }
}

/* ── PIN ── */

function hashPin(pin: string): string {
  const salt = randomBytes(16)
  return `${salt.toString('base64url')}:${scryptSync(pin, salt, 32).toString('base64url')}`
}

function pinMatches(pin: string, stored: string): boolean {
  const [saltText, hashText] = stored.split(':')
  if (!saltText || !hashText) return false
  const want = Buffer.from(hashText, 'base64url')
  const got = scryptSync(pin, Buffer.from(saltText, 'base64url'), want.length)
  return got.length === want.length && timingSafeEqual(got, want)
}

const pinFails = new Map<number, { n: number; until: number }>()
const ipPinFails = new Map<string, { day: string; n: number }>()

/** 하루 20번 잠금 (DB) */
function dayLocked(id: number, now: number): boolean {
  const r = db.prepare('SELECT until FROM pin_locks WHERE project_id = ?').get(id) as { until: number } | undefined
  return !!r && r.until > now
}

/** 그날 틀린 횟수를 하나 올리고, 20번이 되면 24시간 잠급니다. 잠갔으면 true */
function addDayFail(id: number, now: number): boolean {
  const day = kstDate()
  const r = db.prepare('SELECT day, fails FROM pin_locks WHERE project_id = ?').get(id) as { day: string; fails: number } | undefined
  const fails = (r && r.day === day ? r.fails : 0) + 1
  const lock = fails >= PIN_FAILS_PER_PROJECT_DAY
  db.prepare(`INSERT INTO pin_locks (project_id, day, fails, until) VALUES (?, ?, ?, ?)
              ON CONFLICT (project_id) DO UPDATE SET day = excluded.day, fails = excluded.fails,
                until = CASE WHEN excluded.until > 0 THEN excluded.until ELSE pin_locks.until END`)
    .run(id, day, lock ? 0 : fails, lock ? now + PIN_DAY_LOCK_MS : 0)
  if (lock) notify('관리 비밀번호 잠금 (하루 20번 틀림, 24시간)', { 접수: id })
  return lock
}

/** 접수 번호 + PIN 확인 */
function authorize(idRaw: unknown, pinRaw: unknown, ipKey: string): { ok: true; row: ProjectRow } | Fail {
  const id = Number(idRaw)
  if (!Number.isInteger(id) || id <= 0) return fail(404, 'none')
  const row = getRow(id)
  if (!row || row.status === 'withdrawn' || row.purged_at != null) return fail(404, 'none')
  const now = Date.now()
  const day = kstDate()
  const ipf = ipPinFails.get(ipKey)
  if (ipf && ipf.day === day && ipf.n >= PIN_FAILS_PER_DAY) return fail(429, 'locked')
  const pf = pinFails.get(id)
  if (pf && pf.until > now) return fail(429, 'locked')
  if (dayLocked(id, now)) return fail(429, 'locked')
  const pin = typeof pinRaw === 'string' ? pinRaw : typeof pinRaw === 'number' ? String(pinRaw).padStart(4, '0') : ''
  if (!PIN_RE.test(pin) || !pinMatches(pin, row.pin_hash)) {
    const n = (pf && pf.until <= now ? pf.n : 0) + 1
    pinFails.set(id, n >= PIN_TRIES ? { n: 0, until: now + PIN_LOCK_MS } : { n, until: 0 })
    ipPinFails.set(ipKey, { day, n: ipf && ipf.day === day ? ipf.n + 1 : 1 })
    const dayLock = addDayFail(id, now)
    return fail(403, n >= PIN_TRIES || dayLock ? 'locked' : 'pin')
  }
  pinFails.delete(id)
  return { ok: true, row }
}

/** 이메일별 PIN 틀린 횟수 (이메일 + PIN 조회용, 메모리에만) */
const emailFails = new Map<string, { n: number; until: number }>()
/** 없는 이메일도 같은 시간이 걸리게 대신 맞춰 보는 해시 */
const DUMMY_PIN_HASH = hashPin('000000')

/**
 * 이메일 + 관리 비밀번호로 내 접수 찾기 (내 접수 현황 · 관리하기).
 * 그 이메일로 접수했고 비밀번호가 맞는 것만 돌려줍니다. 이메일이 없어도 비밀번호가 틀린 것과 똑같이 답해
 * 남의 이메일로 접수했는지 떠볼 수 없게 합니다. 5번 틀리면 그 이메일은 15분 잠기고, IP당 하루 30번까지.
 */
export function findMine(body: Record<string, unknown>, ipKey: string) {
  const email = cleanEmail(body.email)
  if (!email) return fail(400, 'email')
  const pin = typeof body.pin === 'string' ? body.pin : ''
  if (!PIN_RE.test(pin)) return fail(400, 'pin')
  const now = Date.now()
  const day = kstDate()
  const ipf = ipPinFails.get(ipKey)
  if (ipf && ipf.day === day && ipf.n >= PIN_FAILS_PER_DAY) return fail(429, 'locked')
  const ef = emailFails.get(email)
  if (ef && ef.until > now) return fail(429, 'locked')
  const rows = db.prepare(`SELECT * FROM projects WHERE email = ? AND status != 'withdrawn' AND purged_at IS NULL ORDER BY at DESC LIMIT 20`)
    .all(email) as unknown as ProjectRow[]
  if (!rows.length) pinMatches(pin, DUMMY_PIN_HASH)
  const mine = rows.filter(r => pinMatches(pin, r.pin_hash))
  if (!mine.length) {
    const n = (ef && ef.until <= now ? ef.n : 0) + 1
    emailFails.set(email, n >= PIN_TRIES ? { n: 0, until: now + PIN_LOCK_MS } : { n, until: 0 })
    ipPinFails.set(ipKey, { day, n: ipf && ipf.day === day ? ipf.n + 1 : 1 })
    return fail(403, n >= PIN_TRIES ? 'locked' : 'pin')
  }
  emailFails.delete(email)
  return {
    ok: true as const,
    projects: mine.map(r => ({
      id: r.id, name: r.pending_name ?? r.name, status: r.status, note: r.note, slug: r.slug, at: r.at,
      linkReview: r.status === 'approved' && hasChange(r),
    })),
  }
}

/* ── 접수 ── */

const lastSubmitBySid = new Map<string, number>()
const submitsByIp = new Map<string, { day: string; n: number }>()

export interface Who { sid: string; ipKey: string; nick: string }

export async function submitProject(body: Record<string, unknown>, who: Who): Promise<{ ok: true; id: number; code: string } | Fail> {
  const now = Date.now()
  const day = kstDate()
  const last = lastSubmitBySid.get(who.sid)
  if (last && now - last < SUBMIT_GAP_MS) return fail(429, 'slow')
  const used = submitsByIp.get(who.ipKey)
  if (used && used.day === day && used.n >= SUBMITS_PER_DAY) return fail(429, 'many')

  const name = cleanText(body.name, NAME_MAX, 'name')
  if (!name.ok) return name
  const tagline = cleanText(body.tagline, TAGLINE_MAX, 'tagline')
  if (!tagline.ok) return tagline
  const sign = cleanSign(body.sign, tagline.text)
  if (!sign.ok) return sign
  if (typeof body.category !== 'string' || !CATEGORY_KEYS.includes(body.category)) return fail(400, 'category')
  const links = readLinks(body.github, body.url)
  if (!links.ok) return links
  const email = cleanEmail(body.email)
  if (!email) return fail(400, 'email')
  const pin = typeof body.pin === 'string' ? body.pin : ''
  if (!NEW_PIN_RE.test(pin)) return fail(400, 'pin')
  // 개인정보(이메일) 수집 · 이용 동의: 화면의 체크 상자가 true를 보냅니다
  if (body.consent !== true) return fail(400, 'consent')
  const screen = body.screen == null || body.screen === '' ? '' : ownsUpload(body.screen, who.sid) ? body.screen : null
  if (screen == null) return fail(400, 'image')
  const want = readWant(body.plot, body.channel)
  if (!want.ok) return want
  if (isDuplicate(links.links, 0)) return fail(409, 'dup')

  let repoOk = 0
  let stars = 0
  if (links.links.github) {
    const check = await checkGithub(links.links.github)
    if (check.exists === false) return fail(400, 'github')
    if (check.exists) {
      repoOk = 1
      stars = check.stars
    }
  }

  const code = randomBytes(12).toString('base64url')
  const r = db.prepare(`INSERT INTO projects (code, at, name, tagline, sign, category, github, url, email, email_public, pin_hash, nick,
                          repo_ok, stars, screen, want_plot, want_channel, consent_at, review_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(code, now, name.text, tagline.text, sign.text, body.category, links.links.github, links.links.url, email,
      body.emailPublic === true ? 1 : 0, hashPin(pin), who.nick.slice(0, 20), repoOk, stars, screen, want.plot, want.channel, now, now)
  lastSubmitBySid.set(who.sid, now)
  submitsByIp.set(who.ipKey, { day, n: used && used.day === day ? used.n + 1 : 1 })
  const id = Number(r.lastInsertRowid)
  notify('새 접수', { 접수: id, 이름: name.text, 링크: links.links.url || links.links.github, 이미지: screen ? '있음' : '없음' })
  return { ok: true, id, code }
}

/** 접수 코드로 진행 상황 보기 (PIN 없이: 상태 · 이름 · 사당 주소 정도만) */
export function statusByCode(code: string) {
  if (!CODE_RE.test(code)) return null
  const r = db.prepare('SELECT * FROM projects WHERE code = ?').get(code) as ProjectRow | undefined
  if (!r) return null
  return {
    status: r.status, id: r.id, name: r.name,
    ...(r.slug ? { slug: r.slug } : {}), ...(r.note ? { note: r.note } : {}),
    linkReview: r.status === 'approved' && hasChange(r),
  }
}

/* ── 관리 (PIN) ── */

export function manageGet(body: Record<string, unknown>, ipKey: string, sid = '') {
  const a = authorize(body.id, body.pin, ipKey)
  if (!a.ok) return a
  // 검토를 기다리는 이미지는 공개 주소로 나가지 않으므로, 비밀번호로 연 이 사람에게만 잠시 보여 줍니다
  grantUploadView(sid, [a.row.screen, a.row.pending_screen])
  return { ok: true as const, project: ownerView(a.row) }
}

export async function manageSave(body: Record<string, unknown>, ipKey: string, sid = '') {
  const a = authorize(body.id, body.pin, ipKey)
  if (!a.ok) return a
  const row = a.row
  const live = row.status === 'approved'
  const next = { ...row }

  // 글자: 맵에 있는 사당이면 검토를 기다리는 칸에, 아니면 바로
  let name = row.pending_name ?? row.name
  let tagline = row.pending_tagline ?? row.tagline
  let sign = row.pending_sign ?? row.sign ?? ''
  if ('name' in body) {
    const v = cleanText(body.name, NAME_MAX, 'name')
    if (!v.ok) return v
    name = v.text
  }
  if ('tagline' in body) {
    const v = cleanText(body.tagline, TAGLINE_MAX, 'tagline')
    if (!v.ok) return v
    tagline = v.text
  }
  if ('sign' in body) {
    const v = cleanSign(body.sign, tagline)
    if (!v.ok) return v
    sign = v.text
  }
  if (live) {
    next.pending_name = name !== row.name ? name : null
    next.pending_tagline = tagline !== row.tagline ? tagline : null
    next.pending_sign = sign !== (row.sign ?? '') ? sign : null
  } else {
    next.name = name
    next.tagline = tagline
    next.sign = sign
    next.pending_name = null
    next.pending_tagline = null
    next.pending_sign = null
  }
  if ('category' in body) {
    if (typeof body.category !== 'string' || !CATEGORY_KEYS.includes(body.category)) return fail(400, 'category')
    next.category = body.category
  }
  // 채널 · 자리는 맵에 오르기 전에만. 한쪽만 보내면 다른 쪽은 지금 값으로 봅니다
  if (('plot' in body || 'channel' in body) && !live) {
    const v = readWant('plot' in body ? body.plot : row.want_plot, 'channel' in body ? body.channel : wishChannel(row))
    if (!v.ok) return v
    next.want_plot = v.plot
    next.want_channel = v.channel
  }
  if ('email' in body) {
    const e = cleanEmail(body.email)
    if (!e) return fail(400, 'email')
    next.email = e
  }
  if ('emailPublic' in body) next.email_public = body.emailPublic === true ? 1 : 0
  if ('newPin' in body) {
    const p = typeof body.newPin === 'string' ? body.newPin : ''
    if (!NEW_PIN_RE.test(p)) return fail(400, 'pin')
    next.pin_hash = hashPin(p)
  }

  if ('github' in body || 'url' in body) {
    const base = live && linkChange(row)
      ? { github: row.pending_github ?? '', url: row.pending_url ?? '' }
      : { github: row.github, url: row.url }
    const links = readLinks('github' in body ? body.github : base.github, 'url' in body ? body.url : base.url)
    if (!links.ok) return links
    const l = links.links
    const current = { github: row.github, url: row.url }
    const same = (x: Links, y: Links) => x.github === y.github && x.url === y.url
    if (!same(l, current)) {
      if (isDuplicate(l, row.id)) return fail(409, 'dup')
      if (l.github && l.github !== row.github) {
        const check = await checkGithub(l.github)
        if (check.exists === false) return fail(400, 'github')
        next.repo_ok = check.exists ? 1 : 0
        if (check.exists) next.stars = check.stars
      }
      if (live) {
        // 이미 맵에 있는 사당의 링크는 운영자가 다시 볼 때까지 그대로 둡니다
        next.pending_github = l.github
        next.pending_url = l.url
      } else {
        next.github = l.github
        next.url = l.url
      }
    } else if (live) {
      // 바꾸려던 링크를 원래대로 되돌림 → 검토할 것 없음
      next.pending_github = null
      next.pending_url = null
    }
  }
  // 이미지: 지우기는 바로, 새 이미지는 맵에 있으면 다시 확인 뒤 (본인이 방금 올린 파일만)
  if ('screen' in body) {
    if (body.screen === '' || body.screen == null) {
      next.screen = ''
      next.pending_screen = null
      if (live) db.prepare('UPDATE shrines SET screens = ? WHERE project_id = ?').run('[]', row.id)
    } else if (body.screen === row.screen) {
      next.pending_screen = null
    } else if (body.screen !== row.pending_screen) {
      if (!ownsUpload(body.screen, sid)) return fail(400, 'image')
      if (live) next.pending_screen = body.screen
      else next.screen = body.screen
    }
  }

  const now = Date.now()
  if (live) {
    const was = hasChange(row)
    const is = hasChange(next)
    if (is) next.note = 'link-review'
    else if (next.note === 'link-review') next.note = ''
    if (is && !was) next.review_at = now
    if (!is) next.review_at = null
  }
  // 반려된 접수를 고치면 다시 검토 대기로 (파기 시계도 멈춥니다)
  if (row.status === 'rejected') {
    next.status = 'pending'
    next.note = ''
    next.closed_at = null
    next.review_at = now
  }

  db.prepare(`UPDATE projects SET name = ?, tagline = ?, sign = ?, category = ?, email = ?, email_public = ?, pin_hash = ?,
                github = ?, url = ?, pending_github = ?, pending_url = ?, note = ?, status = ?, repo_ok = ?, stars = ?,
                screen = ?, pending_screen = ?, want_plot = ?, want_channel = ?, pending_name = ?, pending_tagline = ?, pending_sign = ?,
                review_at = ?, closed_at = ?
              WHERE id = ?`)
    .run(next.name, next.tagline, next.sign ?? '', next.category, next.email, next.email_public, next.pin_hash, next.github, next.url,
      next.pending_github, next.pending_url, next.note, next.status, next.repo_ok, next.stars,
      next.screen ?? '', next.pending_screen ?? null, next.want_plot ?? null, next.want_channel ?? null, next.pending_name ?? null, next.pending_tagline ?? null,
      next.pending_sign ?? null, next.review_at ?? null, next.closed_at ?? null, row.id)
  if (live) {
    // 분류 · 이메일 · 공개 여부는 맵의 사당에도 바로. 이름 · 소개 · 지붕 글자는 검토 뒤에
    db.prepare('UPDATE shrines SET category = ?, email = ?, email_public = ? WHERE project_id = ?')
      .run(next.category, next.email, next.email_public, row.id)
    clearShrineCache()
  }
  const saved = getRow(row.id) ?? next
  grantUploadView(sid, [saved.screen, saved.pending_screen])

  // 운영자에게: 맵에 있는 사당의 새 변경 요청, 반려됐다가 다시 낸 접수
  const pendingKey = (r: ProjectRow) => JSON.stringify([r.pending_name, r.pending_tagline, r.pending_sign, r.pending_github, r.pending_url, r.pending_screen])
  if (live && hasChange(saved) && pendingKey(saved) !== pendingKey(row)) {
    notify('사당 변경 검토 요청', { 접수: row.id, 사당: row.slug || '-', 이름: row.name, '바뀐 것': changeKinds(saved).join(', ') })
  } else if (row.status === 'rejected') {
    notify('반려된 접수를 고쳐 다시 냄', { 접수: row.id, 이름: saved.name, 링크: saved.url || saved.github })
  }
  return { ok: true as const, project: ownerView(saved), linkReview: live && hasChange(saved) }
}

/** 내리기: 접수를 거두고, 맵에 있던 사당도 뺍니다. 개인정보는 30일 뒤 retention.ts가 파기합니다 */
export function manageWithdraw(body: Record<string, unknown>, ipKey: string) {
  const a = authorize(body.id, body.pin, ipKey)
  if (!a.ok) return a
  db.prepare(`UPDATE projects SET status = 'withdrawn', pending_github = NULL, pending_url = NULL, pending_screen = NULL,
                pending_name = NULL, pending_tagline = NULL, pending_sign = NULL, note = 'withdrawn', review_at = NULL, closed_at = ?
              WHERE id = ?`).run(Date.now(), a.row.id)
  db.prepare('DELETE FROM shrines WHERE project_id = ?').run(a.row.id)
  clearShrineCache()
  notify('작성자가 프로젝트를 내림', { 접수: a.row.id, 이름: a.row.name, '전 상태': a.row.status })
  return { ok: true as const }
}

/* ── 운영 도구 (cli.ts) ── */

const CHANGES_SQL = `(pending_github IS NOT NULL OR pending_url IS NOT NULL OR pending_screen IS NOT NULL
  OR pending_name IS NOT NULL OR pending_tagline IS NOT NULL OR pending_sign IS NOT NULL)`

export function projectsForAdmin(all: boolean) {
  const where = all ? '' : `WHERE status = 'pending' OR (status = 'approved' AND ${CHANGES_SQL})`
  return db.prepare(`SELECT * FROM projects ${where} ORDER BY at DESC LIMIT 200`).all() as unknown as ProjectRow[]
}

/** 확인을 기다리던 새 이미지를 사당에 반영 */
function applyPendingScreen(row: ProjectRow) {
  const img = row.pending_screen ?? ''
  db.prepare('UPDATE shrines SET screens = ? WHERE project_id = ?').run(JSON.stringify(img ? [`up/${img}`] : []), row.id)
  db.prepare('UPDATE projects SET screen = ?, pending_screen = NULL WHERE id = ?').run(img, row.id)
}

/** 확인을 기다리던 이름 · 소개 · 지붕 글자를 사당과 접수에 반영 */
function applyPendingText(row: ProjectRow): string {
  const name = row.pending_name ?? row.name
  const tagline = row.pending_tagline ?? row.tagline
  const sign = row.pending_sign ?? row.sign ?? ''
  db.prepare('UPDATE shrines SET name = ?, tagline = ?, sign = ? WHERE project_id = ?').run(name, tagline, sign, row.id)
  db.prepare('UPDATE projects SET name = ?, tagline = ?, sign = ?, pending_name = NULL, pending_tagline = NULL, pending_sign = NULL WHERE id = ?')
    .run(name, tagline, sign, row.id)
  return name
}

/**
 * 고른 채널 · 자리. 채널이 없으면 null(아무 채널), 자리가 없으면 null(그 채널의 빈 자리 아무 데나).
 * 자리만 보내면(채널을 모르는 예전 화면) 1번 채널로 봅니다. 자리는 그 채널 안에서만 비어 있으면 됩니다.
 * 없는 채널은 'channel', 없는 자리 · 그 채널에 이미 사당이 있는 자리는 'plot'
 */
function readWant(plotRaw: unknown, channelRaw: unknown): { ok: true; plot: number | null; channel: number | null } | Fail {
  let channel: number | null = null
  if (channelRaw != null && channelRaw !== '') {
    const c = typeof channelRaw === 'number' ? channelRaw : typeof channelRaw === 'string' && /^\d{1,2}$/.test(channelRaw) ? Number(channelRaw) : NaN
    if (!isChannel(c)) return fail(400, 'channel')
    channel = c
  }
  if (plotRaw == null || plotRaw === '') return { ok: true, plot: null, channel }
  const n = Number(plotRaw)
  if (!Number.isInteger(n) || !PLOTS[n]) return fail(400, 'plot')
  const ch = channel ?? 1
  if (plotTaken(ch, n)) return fail(409, 'plot')
  return { ok: true, plot: n, channel: ch }
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '')
}

export function uniqueSlug(base: string): string {
  const taken = new Set([
    ...(db.prepare('SELECT slug FROM shrines').all() as unknown as { slug: string }[]).map(r => r.slug),
    ...(db.prepare("SELECT slug FROM projects WHERE slug <> ''").all() as unknown as { slug: string }[]).map(r => r.slug),
  ])
  if (!taken.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const s = `${base.slice(0, 36)}-${i}`
    if (!taken.has(s)) return s
  }
  return `${base.slice(0, 30)}-${randomBytes(3).toString('hex')}`
}

const ALL_CHANNELS = Array.from({ length: CHANNELS }, (_, i) => i + 1)

/**
 * 자리를 정하지 않고 승인할 때 세울 곳.
 *   · 작성자가 고른 채널 · 자리가 비어 있으면 그곳 (운영자가 채널을 정했으면 그 채널이 작성자가 고른 채널일 때만)
 *   · 아니면 그 채널(운영자가 정한 채널 → 작성자가 고른 채널)의 첫 빈 자리
 *   · 운영자가 채널을 정하지 않았고 그 채널이 꽉 찼거나 아무 채널이면 1번 채널부터 첫 빈 자리
 */
function autoPlace(row: ProjectRow, channelArg?: number): { channel: number; plot: number } | null {
  const wish = wishChannel(row)
  const first = channelArg ?? wish
  if (first != null && first === wish && row.want_plot != null && PLOTS[row.want_plot] && !plotTaken(first, row.want_plot)) {
    return { channel: first, plot: row.want_plot }
  }
  const order = first == null ? ALL_CHANNELS : channelArg != null ? [first] : [first, ...ALL_CHANNELS.filter(c => c !== first)]
  for (const channel of order) {
    const plot = freePlotsIn(channel)[0]
    if (plot != null) return { channel, plot }
  }
  return null
}

/**
 * 승인: 검토 중이면 빈 자리에 사당을 세우고, 맵에 있는 사당의 변경(글자 · 이미지 · 링크)이면 사당에 반영합니다.
 * plotArg · channelArg: 운영자가 정한 자리 · 채널. 자리만 정하면 채널은 작성자가 고른 채널(없으면 1번)입니다.
 */
export function approveProject(id: number, plotArg?: number, channelArg?: number): string {
  const row = getRow(id)
  if (!row) throw new Error(`없는 접수입니다: ${id}`)

  if (row.status === 'approved' && hasChange(row)) {
    const kinds = changeKinds(row)
    const links = { github: row.pending_github ?? '', url: row.pending_url ?? '' }
    const domain = linkChange(row) ? domainOf(links) : ''
    if (linkChange(row)) {
      const clash = db.prepare('SELECT slug FROM shrines WHERE domain = ? AND project_id <> ?').get(domain, id) as { slug: string } | undefined
      if (clash) throw new Error(`다른 사당(${clash.slug})이 같은 주소를 씁니다: ${domain}`)
    }
    let name = row.name
    if (textChange(row)) name = applyPendingText(row)
    if (row.pending_screen != null) applyPendingScreen(row)
    if (linkChange(row)) {
      db.prepare('UPDATE shrines SET domain = ?, url = ?, repo = ? WHERE project_id = ?')
        .run(domain, links.url || links.github, links.github, id)
      db.prepare('UPDATE projects SET github = ?, url = ?, pending_github = NULL, pending_url = NULL WHERE id = ?')
        .run(links.github, links.url, id)
    }
    db.prepare(`UPDATE projects SET note = '', review_at = NULL WHERE id = ?`).run(id)
    clearShrineCache()
    return `${kinds.join(' · ')} 변경을 승인했습니다: ${name}${linkChange(row) ? ` (${links.github || links.url})` : ''}`
  }
  if (row.status !== 'pending') throw new Error(`검토 대기 상태가 아닙니다 (${row.status}): ${id}`)

  if (channelArg != null && !isChannel(channelArg)) throw new Error(`없는 채널입니다: ${channelArg} (1~${CHANNELS})`)
  let channel: number
  let plot: number
  if (plotArg != null) {
    channel = channelArg ?? wishChannel(row) ?? 1
    if (!PLOTS[plotArg]) throw new Error(`없는 자리 번호입니다: ${plotArg} (0~${PLOTS.length - 1})`)
    if (plotTaken(channel, plotArg)) throw new Error(`이미 사당이 있는 자리입니다: 채널 ${channel} · ${plotArg}번`)
    plot = plotArg
  } else {
    const spot = autoPlace(row, channelArg)
    if (!spot) throw new Error(channelArg != null ? `채널 ${channelArg}에는 빈 사당 자리가 없습니다` : '빈 사당 자리가 없습니다')
    channel = spot.channel
    plot = spot.plot
  }
  const links = { github: row.github, url: row.url }
  const repoName = parseGithub(row.github)?.repo ?? ''
  const slug = uniqueSlug(slugify(repoName) || slugify(row.name) || `project-${row.id}`)
  const today = kstDate()
  const shrine: Shrine = {
    slug, name: row.name, tagline: row.tagline, category: row.category, domain: domainOf(links),
    url: links.url || links.github, operator: row.nick.slice(0, 20) || '익명', keeper: false, paid: false,
    verifiedDomain: '', verifiedBusiness: null, joinedAt: today, status: 'live', prayer: 'deploy', charm: null,
    deco: [], screens: row.screen ? [`up/${row.screen}`] : [], capturedAt: today, channel, plot, repo: links.github, email: row.email,
    emailPublic: row.email_public === 1, projectId: row.id, sign: row.sign ?? '',
  }
  const errors = validateShrine(shrine)
  if (errors.length) throw new Error(`사당 규칙에 맞지 않습니다: ${errors.join(' / ')}`)
  insertShrine(shrine)
  db.prepare(`UPDATE projects SET status = 'approved', slug = ?, note = '', review_at = NULL, closed_at = NULL WHERE id = ?`).run(slug, id)
  clearShrineCache()
  return `승인했습니다: ${row.name} → 사당 '${slug}' (채널 ${channel} · 자리 ${plot})`
}

/** 반려: 검토 중이면 접수 반려(30일 뒤 개인정보 파기), 맵에 있는 사당의 변경 검토면 바꾸려던 것만 버립니다 (사당은 그대로) */
export function rejectProject(id: number, reason: string): string {
  const row = getRow(id)
  if (!row) throw new Error(`없는 접수입니다: ${id}`)
  const why = reason.trim().slice(0, 80)
  if (row.status === 'approved' && hasChange(row)) {
    db.prepare(`UPDATE projects SET pending_github = NULL, pending_url = NULL, pending_screen = NULL,
                  pending_name = NULL, pending_tagline = NULL, pending_sign = NULL, note = ?, review_at = NULL WHERE id = ?`)
      .run(`link-rejected${why ? `: ${why}` : ''}`, id)
    return `변경을 반려했습니다: ${row.name} (사당은 원래 글자 · 링크 · 이미지 그대로)`
  }
  if (row.status !== 'pending') throw new Error(`검토 대기 상태가 아닙니다 (${row.status}): ${id}`)
  db.prepare(`UPDATE projects SET status = 'rejected', note = ?, review_at = NULL, closed_at = ? WHERE id = ?`).run(why || 'rejected', Date.now(), id)
  return `반려했습니다: ${row.name}${why ? ` (${why})` : ''}`
}

/* ── 보관 기간 (retention.ts가 부릅니다) ── */

/**
 * 오래 처리하지 못한 검토 끝내기: review_at(없으면 접수 시각)이 cutoff보다 오래된
 *   · 새 접수 → 반려(note 'expired'), 그날부터 30일 파기 시계가 돕니다
 *   · 맵에 있는 사당의 변경 요청 → 바꾸려던 것만 버림(note 'link-expired'), 사당은 그대로
 * 예전 기록처럼 시각이 비어 있는 변경 요청은 지금부터 셉니다.
 */
export function expireStaleReviews(cutoff: number, now = Date.now()): { registrations: number; changes: number } {
  db.prepare(`UPDATE projects SET review_at = ? WHERE status = 'approved' AND review_at IS NULL AND ${CHANGES_SQL}`).run(now)
  const registrations = db.prepare(`UPDATE projects SET status = 'rejected', note = 'expired', review_at = NULL, closed_at = ?
                                     WHERE status = 'pending' AND COALESCE(review_at, at) < ?`).run(now, cutoff).changes
  const changes = db.prepare(`UPDATE projects SET pending_github = NULL, pending_url = NULL, pending_screen = NULL,
                                pending_name = NULL, pending_tagline = NULL, pending_sign = NULL, note = 'link-expired', review_at = NULL
                              WHERE status = 'approved' AND review_at < ? AND ${CHANGES_SQL}`).run(cutoff).changes
  return { registrations: Number(registrations), changes: Number(changes) }
}

/** 반려 · 내린 시각이 비어 있는 접수(예전 기록 · 다른 경로로 반려된 것)는 지금부터 셉니다. 파기할 접수 번호들을 돌려줍니다 */
export function closedBefore(cutoff: number, now = Date.now()): number[] {
  db.prepare(`UPDATE projects SET closed_at = ? WHERE status IN ('rejected', 'withdrawn') AND closed_at IS NULL AND purged_at IS NULL`).run(now)
  return (db.prepare(`SELECT id FROM projects WHERE status IN ('rejected', 'withdrawn') AND purged_at IS NULL AND closed_at <= ?`)
    .all(cutoff) as unknown as { id: number }[]).map(r => r.id)
}

/**
 * 접수의 개인정보 파기: 이메일 · PIN 해시 · 링크 · 이름 · 소개 · 이미지 칸을 비우고 파기 시각을 남깁니다.
 * 남는 것은 번호 · 접수 코드 · 시각 · 분류 · 상태 · 메모 · 자동 닉네임뿐입니다. 맵의 사당은 건드리지 않으니
 * 맵에 있는 접수는 먼저 내리세요 (eraseProject). 지울 이미지 이름들을 돌려줍니다 (파일은 uploads.removeUploads로).
 */
export function purgeProject(id: number, now = Date.now()): string[] | null {
  const row = getRow(id)
  if (!row) return null
  db.prepare(`UPDATE projects SET name = '(파기됨)', tagline = '', sign = '', github = '', url = '', email = '', email_public = 0,
                pin_hash = '', slug = '', screen = '', pending_screen = NULL, pending_github = NULL, pending_url = NULL,
                pending_name = NULL, pending_tagline = NULL, pending_sign = NULL, want_plot = NULL, want_channel = NULL, review_at = NULL,
                closed_at = COALESCE(closed_at, ?), purged_at = ?
              WHERE id = ?`).run(now, now, id)
  db.prepare('DELETE FROM pin_locks WHERE project_id = ?').run(id)
  pinFails.delete(id)
  return [row.screen, row.pending_screen].filter((x): x is string => !!x)
}

/**
 * 작성자가 요청하면 바로 파기: 맵에 있으면 사당을 빼고 내린 것으로 바꾼 뒤 purgeProject.
 * 지울 이미지 이름들을 돌려줍니다. 없는 접수면 null, 이미 파기했으면 빈 배열.
 */
export function eraseProject(id: number, now = Date.now()): string[] | null {
  const row = getRow(id)
  if (!row) return null
  if (row.purged_at != null) return []
  if (row.status === 'pending' || row.status === 'approved') {
    db.prepare(`UPDATE projects SET status = 'withdrawn', note = 'erased', closed_at = ? WHERE id = ?`).run(now, id)
    db.prepare('DELETE FROM shrines WHERE project_id = ?').run(id)
    clearShrineCache()
  }
  return purgeProject(id, now)
}

/* ── 운영자 화면 (admin.ts) ── */

/** 접수 목록 거르기: 검토할 것 전부 · 새 접수 · 맵에 있는 사당의 글자 · 링크 · 이미지 변경 · 상태별 · 전부 */
export const PROJECT_FILTERS = ['review', 'pending', 'changes', 'approved', 'rejected', 'withdrawn', 'all'] as const
export type ProjectFilter = (typeof PROJECT_FILTERS)[number]
export const isProjectFilter = (v: unknown): v is ProjectFilter => typeof v === 'string' && (PROJECT_FILTERS as readonly string[]).includes(v)

const FILTER_SQL: Record<ProjectFilter, string> = {
  review: `status = 'pending' OR (status = 'approved' AND ${CHANGES_SQL})`,
  pending: `status = 'pending'`,
  changes: `status = 'approved' AND ${CHANGES_SQL}`,
  approved: `status = 'approved'`,
  rejected: `status = 'rejected'`,
  withdrawn: `status = 'withdrawn'`,
  all: '1 = 1',
}

/** 운영자에게 보이는 모양: 지금 값 + 검토 대기 값 + 접수 시각 · 닉네임 · 저장소 확인 · 동의 · 파기. PIN 해시 · 접수 코드는 빼고 */
function adminView(r: ProjectRow) {
  return {
    ...view(r), at: r.at, nick: r.nick, repoOk: r.repo_ok === 1, stars: r.stars,
    changes: r.status === 'approved' && hasChange(r),
    consentAt: r.consent_at ?? null, reviewAt: r.review_at ?? null, closedAt: r.closed_at ?? null, purgedAt: r.purged_at ?? null,
  }
}

/** 목록에는 이메일을 넣지 않습니다 (자세히 보기에서만) */
export function projectsByFilter(filter: ProjectFilter, limit = 200) {
  const rows = db.prepare(`SELECT * FROM projects WHERE ${FILTER_SQL[filter]} ORDER BY at DESC LIMIT ?`).all(limit) as unknown as ProjectRow[]
  return rows.map(r => {
    const { email: _email, ...rest } = adminView(r)
    return rest
  })
}

export function projectForAdmin(id: number) {
  const row = Number.isInteger(id) && id > 0 ? getRow(id) : undefined
  return row ? adminView(row) : null
}

export function projectCounts() {
  const n = (sql: string) => (db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE ${sql}`).get() as { n: number }).n
  return { pending: n(FILTER_SQL.pending), changes: n(FILTER_SQL.changes), approved: n(FILTER_SQL.approved) }
}

/* ── 메모리 기록 정리 (1시간마다) ── */

setInterval(() => {
  const now = Date.now()
  const day = kstDate()
  for (const [k, v] of pinFails) if (v.until <= now) pinFails.delete(k)
  for (const [k, v] of emailFails) if (v.until <= now) emailFails.delete(k)
  for (const [k, v] of ipPinFails) if (v.day !== day) ipPinFails.delete(k)
  for (const [k, v] of submitsByIp) if (v.day !== day) submitsByIp.delete(k)
  for (const [k, at] of lastSubmitBySid) if (now - at >= SUBMIT_GAP_MS) lastSubmitBySid.delete(k)
  db.prepare('DELETE FROM pin_locks WHERE until <= ? AND day <> ?').run(now, day)
}, 3600_000).unref()
