// 운영 작업: 사당 넣기 · 고치기 · 옮기기 · 상태 바꾸기 · 내리기.
// 운영자 화면(admin.ts)과 운영 도구(cli.ts)가 함께 씁니다. 입력을 여기서 검사하고, 사당 규칙(validateShrine)으로 한 번 더 봅니다.
// 실패하면 OpError(화면에 그대로 보여 줄 한국어 문장 + HTTP 상태)를 던집니다.
import { db } from './db.ts'
import {
  CATEGORY_KEYS, clearShrineCache, fromRow, insertShrine, isPrayerKey, isValidEmail, parseGithub, validateShrine,
  type Shrine, type ShrineRow,
} from './shrines.ts'
import { NAME_MAX, TAGLINE_MAX, domainOf, readLinks, slugify, uniqueSlug, type Links } from './registry.ts'
import { kstDate } from './util.ts'
import { PLOTS } from './world.ts'

export class OpError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

const SIGN_MAX = 8
const OPERATOR_MAX = 20
const NOTE_MAX = 80
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu

/** 운영자가 쓰는 글: 보이지 않는 문자를 빼고 공백은 하나로. 비어 있으면 optional일 때만 '' */
export function cleanOpText(raw: unknown, max: number, label: string, optional = false): string {
  if (raw != null && typeof raw !== 'string') throw new OpError(`${label}: 글자로 넣어 주세요`)
  const text = (raw ?? '').normalize('NFC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()
  if (!text && !optional) throw new OpError(`${label}: 비어 있습니다`)
  if ([...text].length > max) throw new OpError(`${label}: ${max}자까지 쓸 수 있습니다`)
  return text
}

/** 메모 · 사유 (없어도 됨, 80자까지) */
export const cleanNote = (raw: unknown) => cleanOpText(raw, NOTE_MAX, '사유', true)

function readCategory(raw: unknown): string {
  if (typeof raw !== 'string' || !CATEGORY_KEYS.includes(raw)) throw new OpError('분류를 골라 주세요')
  return raw
}

function readStatus(raw: unknown): 'live' | 'check' {
  if (raw === 'live' || raw === 'check') return raw
  throw new OpError('상태는 live(운영 중) 또는 check(닫힘 · 점검 중)입니다')
}

const LINK_FAIL: Record<string, string> = {
  github: 'GitHub 저장소 주소가 올바르지 않습니다 (https://github.com/<owner>/<repo>)',
  url: '서비스 주소는 https 도메인 주소여야 합니다 (IP · localhost · 포트 불가)',
  link: 'GitHub 저장소나 서비스 주소 중 하나는 있어야 합니다',
}

function readLinksOrThrow(github: unknown, url: unknown): Links {
  const r = readLinks(github, url)
  if (!r.ok) throw new OpError(LINK_FAIL[r.reason] ?? LINK_FAIL.link!)
  return r.links
}

/** 사당에 저장된 대표 링크를 GitHub · 서비스 주소 두 칸으로 */
function linksOf(s: Shrine): Links {
  return { github: s.repo, url: s.domain.startsWith('github.com/') ? '' : s.url }
}

/** 자리 번호 읽기: 있는 자리이고 비어 있어야 합니다 */
function readFreePlot(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,3}$/.test(raw) ? Number(raw) : NaN
  if (!Number.isInteger(n) || !PLOTS[n]) throw new OpError(`없는 자리 번호입니다 (0~${PLOTS.length - 1})`)
  if (db.prepare('SELECT 1 FROM shrines WHERE plot = ?').get(n)) throw new OpError(`이미 사당이 있는 자리입니다: ${n}번`, 409)
  return n
}

/** 빈 자리 번호들 (작은 번호부터) */
export function freePlotIds(): number[] {
  const used = new Set((db.prepare('SELECT plot FROM shrines').all() as unknown as { plot: number }[]).map(r => r.plot))
  return PLOTS.map(p => p.id).filter(id => !used.has(id))
}

/** 같은 주소를 쓰는 다른 사당이 있으면 막습니다 */
function ensureDomainFree(domain: string, exceptSlug: string) {
  const clash = db.prepare('SELECT slug FROM shrines WHERE domain = ? AND slug <> ?').get(domain, exceptSlug) as { slug: string } | undefined
  if (clash) throw new OpError(`다른 사당(${clash.slug})이 같은 주소를 씁니다: ${domain}`, 409)
}

function readEmail(raw: unknown): string {
  if (raw == null || raw === '') return ''
  if (typeof raw !== 'string') throw new OpError('이메일 형식이 올바르지 않습니다')
  const e = raw.trim().toLowerCase()
  if (!e) return ''
  if (!isValidEmail(e)) throw new OpError('이메일 형식이 올바르지 않습니다')
  return e
}

function rulesOrThrow(s: Shrine) {
  const errors = validateShrine(s)
  if (errors.length) throw new OpError(`사당 규칙에 맞지 않습니다: ${errors.join(' / ')}`)
}

function getShrine(slug: unknown): Shrine {
  const row = typeof slug === 'string' && SLUG_RE.test(slug)
    ? db.prepare('SELECT * FROM shrines WHERE slug = ?').get(slug) as ShrineRow | undefined
    : undefined
  if (!row) throw new OpError(`없는 사당입니다: ${typeof slug === 'string' ? slug.slice(0, 40) : ''}`, 404)
  return fromRow(row)
}

/** 묶어서 한 번에 (중간에 실패하면 되돌림) */
function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/* ── 목록 ── */

/** 사당 전부 (규칙에 어긋나 맵에서 빠진 사당도 이유와 함께) */
export function shrinesForAdmin() {
  const rows = db.prepare('SELECT * FROM shrines ORDER BY plot').all() as unknown as ShrineRow[]
  return rows.map(r => {
    const s = fromRow(r)
    return { ...s, errors: validateShrine(s) }
  })
}

/* ── 넣기 ── */

/**
 * 운영자가 사당을 직접 넣습니다. 도메인(저장소) 확인 날짜는 오늘로 남습니다.
 * screens는 호출하는 쪽이 확인한 이미지 이름('up/<이름>')입니다 (직접 넣는 사당은 1~3장).
 */
export function addShrine(body: Record<string, unknown>, screens: string[]): Shrine {
  const name = cleanOpText(body.name, NAME_MAX, '이름')
  const tagline = cleanOpText(body.tagline, TAGLINE_MAX, '한 줄 소개')
  const sign = cleanOpText(body.sign, SIGN_MAX, '지붕 소개', true) || [...tagline].slice(0, SIGN_MAX).join('').trim()
  const category = readCategory(body.category)
  const links = readLinksOrThrow(body.github, body.url)
  const domain = domainOf(links)
  ensureDomainFree(domain, '')
  const operator = cleanOpText(body.operator, OPERATOR_MAX, '운영 표시명', true) || '익명'
  const prayer = body.prayer == null || body.prayer === '' ? 'deploy' : body.prayer
  if (!isPrayerKey(prayer)) throw new OpError('현판 기원을 골라 주세요')
  let plot: number
  if (body.plot == null || body.plot === '') {
    const free = freePlotIds()[0]
    if (free == null) throw new OpError('빈 사당 자리가 없습니다', 409)
    plot = free
  } else plot = readFreePlot(body.plot)
  const status = readStatus(body.status ?? 'live')
  const email = readEmail(body.email)
  let slug: string
  if (typeof body.slug === 'string' && body.slug.trim()) {
    slug = body.slug.trim().toLowerCase()
    if (!SLUG_RE.test(slug)) throw new OpError('주소 이름(slug)은 영문 소문자 · 숫자 · 하이픈 1~40자입니다')
    if (uniqueSlug(slug) !== slug) throw new OpError(`이미 쓰는 주소 이름입니다: ${slug}`, 409)
  } else {
    slug = uniqueSlug(slugify(parseGithub(links.github)?.repo ?? '') || slugify(name) || slugify(domain) || 'shrine')
  }
  const today = kstDate()
  const s: Shrine = {
    slug, name, tagline, category, domain, url: links.url || links.github, operator, keeper: body.keeper === true,
    paid: false, verifiedDomain: today, verifiedBusiness: null, joinedAt: today, status, prayer, charm: null, deco: [],
    screens, capturedAt: today, plot, repo: links.github, email, emailPublic: email ? body.emailPublic === true : false,
    projectId: 0, sign,
  }
  rulesOrThrow(s)
  insertShrine(s)
  clearShrineCache()
  return s
}

/* ── 고치기 ── */

/**
 * 이름 · 한 줄 소개 · 지붕 소개 · 분류 · 링크 · 운영 표시명 · 상태 · 이미지를 고칩니다 (보낸 칸만).
 * 등록소에서 온 사당이면 접수 기록도 같이 고쳐서, 작성자가 나중에 고칠 때 되돌아가지 않게 합니다.
 */
export function updateShrine(slugRaw: unknown, body: Record<string, unknown>, screens?: string[]): { shrine: Shrine; changed: string[] } {
  const cur = getShrine(slugRaw)
  const next: Shrine = { ...cur }
  if ('name' in body) next.name = cleanOpText(body.name, NAME_MAX, '이름')
  if ('tagline' in body) next.tagline = cleanOpText(body.tagline, TAGLINE_MAX, '한 줄 소개')
  if ('sign' in body) next.sign = cleanOpText(body.sign, SIGN_MAX, '지붕 소개', true) || [...next.tagline].slice(0, SIGN_MAX).join('').trim()
  if ('category' in body) next.category = readCategory(body.category)
  if ('operator' in body) next.operator = cleanOpText(body.operator, OPERATOR_MAX, '운영 표시명', true) || '익명'
  if ('status' in body) next.status = readStatus(body.status)
  if ('github' in body || 'url' in body) {
    const now = linksOf(cur)
    const links = readLinksOrThrow('github' in body ? body.github : now.github, 'url' in body ? body.url : now.url)
    next.domain = domainOf(links)
    next.url = links.url || links.github
    next.repo = links.github
    if (next.domain !== cur.domain) {
      ensureDomainFree(next.domain, cur.slug)
      // 직접 넣은 사당은 운영자가 새 주소를 확인한 날로
      if (!cur.projectId) next.verifiedDomain = kstDate()
    }
  }
  if (screens) next.screens = screens
  const fields = ['name', 'tagline', 'sign', 'category', 'operator', 'status', 'domain', 'url', 'repo', 'screens'] as const
  const changed = fields.filter(k => JSON.stringify(next[k]) !== JSON.stringify(cur[k]))
  if (!changed.length) return { shrine: cur, changed }
  rulesOrThrow(next)
  tx(() => {
    db.prepare(`UPDATE shrines SET name = ?, tagline = ?, sign = ?, category = ?, operator = ?, status = ?, domain = ?, url = ?,
                  repo = ?, screens = ?, verified_domain = ? WHERE slug = ?`)
      .run(next.name, next.tagline, next.sign, next.category, next.operator, next.status, next.domain, next.url,
        next.repo, JSON.stringify(next.screens), next.verifiedDomain, cur.slug)
    if (cur.projectId) {
      const l = linksOf(next)
      const img = next.screens[0]?.startsWith('up/') ? next.screens[0].slice(3) : ''
      db.prepare('UPDATE projects SET name = ?, tagline = ?, sign = ?, category = ?, github = ?, url = ?, screen = ? WHERE id = ?')
        .run(next.name, next.tagline, next.sign, next.category, l.github, l.url, img, cur.projectId)
    }
  })
  clearShrineCache()
  return { shrine: next, changed }
}

/** 상태: live(운영 중) · check(닫힘 · 점검 중) */
export function setShrineStatus(slug: unknown, status: unknown): Shrine {
  const st = readStatus(status)
  const cur = getShrine(slug)
  db.prepare('UPDATE shrines SET status = ? WHERE slug = ?').run(st, cur.slug)
  clearShrineCache()
  return { ...cur, status: st }
}

/** 다른 빈 자리로 옮기기 */
export function moveShrine(slug: unknown, plotRaw: unknown): { shrine: Shrine; from: number } {
  const cur = getShrine(slug)
  const plot = readFreePlot(plotRaw)
  db.prepare('UPDATE shrines SET plot = ? WHERE slug = ?').run(plot, cur.slug)
  clearShrineCache()
  return { shrine: { ...cur, plot }, from: cur.plot }
}

/**
 * 맵에서 내리기. 등록소에서 온 사당이면 그 접수는 '반려'(사유: removed)로 바꿔서,
 * 작성자가 고쳐 다시 내면 검토 대기로 돌아오게 합니다. 올린 이미지는 하루 뒤 정리됩니다 (uploads.ts).
 */
export function removeShrine(slug: unknown, noteRaw: unknown = ''): Shrine {
  const cur = getShrine(slug)
  const why = cleanNote(noteRaw)
  tx(() => {
    db.prepare('DELETE FROM shrines WHERE slug = ?').run(cur.slug)
    if (cur.projectId) {
      // 반려로 바꾸고 검토 대기 값은 버립니다. closed_at부터 30일 뒤 retention.ts가 개인정보를 파기합니다
      db.prepare(`UPDATE projects SET status = 'rejected', pending_github = NULL, pending_url = NULL, pending_screen = NULL,
                    pending_name = NULL, pending_tagline = NULL, pending_sign = NULL, review_at = NULL, closed_at = ?, note = ?
                  WHERE id = ? AND status = 'approved'`).run(Date.now(), `removed${why ? `: ${why}` : ''}`, cur.projectId)
    }
  })
  clearShrineCache()
  return cur
}
