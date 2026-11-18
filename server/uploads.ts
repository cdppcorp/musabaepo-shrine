// 등록소 이미지 (사당 모니터에 뜨는 사이트 화면 · 대표 이미지).
//   - 10MB까지, PNG · JPEG · WebP만 (파일 앞부분 서명으로 확인하고 크기도 읽어 봅니다)
//   - 화면은 올리기 전에 가로 1280px 안쪽으로 줄여 보내지만, 서버는 받은 그대로 다시 검사하고
//     위치 정보(EXIF) · XMP · 글 메타데이터를 지운 뒤 저장합니다
//   - DATA_DIR/uploads에 무작위 이름으로 저장하고, 접수에 쓰이지 않은 파일은 하루 뒤 지웁니다
//   - 누구나 받을 수 있는 것은 맵에 떠 있는 사당의 이미지뿐입니다. 검토를 기다리는 이미지는
//     올린 사람 · 관리 비밀번호로 그 접수를 연 사람 · 운영자에게만, 캐시하지 말라는 표시를 붙여 보냅니다
//   - 반려되거나 내린 접수의 이미지는 30일 뒤 retention.ts가 지웁니다
//   - 본문을 읽기 전에 할당량 · 동시 업로드 수 · 디스크 여유를 먼저 봅니다 (형식이 틀린 시도도 셉니다)
import { randomBytes } from 'node:crypto'
import { accessSync, constants, createReadStream, mkdirSync, readdirSync, statSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { pipeline } from 'node:stream'
import { config } from './config.ts'
import { db } from './db.ts'
import { notify } from './notify.ts'
import { WindowLimiter } from './security.ts'
import { allShrines } from './shrines.ts'
import { kstDate } from './util.ts'

export const UPLOAD_MAX = 10 * 1024 * 1024
export const UPLOAD_DIR = join(config.dataDir, 'uploads')
mkdirSync(UPLOAD_DIR, { recursive: true })

/** 저장 이름: 무작위 16자 + 확장자 */
export const UPLOAD_NAME_RE = /^[A-Za-z0-9_-]{16}\.(png|jpg|webp)$/
const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }
/** 한 사람(입장 표) 1시간 10장, IP 하루 30장, 전체 2GB */
const PER_SID_HOUR = 10
const PER_IP_DAY = 30
const TOTAL_MAX = 2 * 1024 * 1024 * 1024
/** IP당 10분에 시도 20번까지 (형식이 틀려 실패한 것도 셉니다) */
const tryLimiter = new WindowLimiter(20, 10 * 60_000)
/** 서버 전체에서 동시에 받는 업로드 수. 넘으면 잠시 뒤 다시 (메모리에 10MB씩 올라가므로) */
const MAX_ACTIVE = 3
/** 디스크 여유가 이보다 적으면 받지 않고 운영자에게 알립니다 */
const MIN_FREE = 1024 * 1024 * 1024
/** 접수에 안 쓰인 파일을 지우기까지 */
const ORPHAN_MS = 24 * 3600_000
/** 관리 비밀번호로 접수를 연 사람에게 검토 대기 이미지를 보여 주는 시간 */
const GRANT_MS = 3 * 3600_000

const bySid = new Map<string, number[]>()
const byIp = new Map<string, { day: string; n: number }>()
/** 누가 올렸는지 (접수할 때 남의 파일을 끌어다 쓰지 못하게, 올린 사람에게 미리 보기를 보여 주게) */
const owner = new Map<string, { sid: string; at: number }>()
/** 입장 표(sid)별로 볼 수 있게 한 검토 대기 이미지 */
const grants = new Map<string, { ids: Set<string>; until: number }>()
let active = 0

export type UploadFail = 'type' | 'size' | 'slow' | 'many' | 'full' | 'bad' | 'busy'

/** 파일 앞부분으로 형식과 크기(가로 · 세로)를 읽습니다. 모르는 형식이면 null */
export function sniffImage(b: Buffer): { ext: 'png' | 'jpg' | 'webp'; w: number; h: number } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    return { ext: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue }
      const marker = b[i + 1] ?? 0
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      const len = b.readUInt16BE(i + 2)
      // SOF0~SOF15 (DHT · JPG · DAC 빼고)에 크기가 있습니다
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { ext: 'jpg', w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) }
      }
      i += 2 + len
    }
    return null
  }
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16)
    if (kind === 'VP8X') return { ext: 'webp', w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) }
    if (kind === 'VP8L') {
      const bits = b.readUInt32LE(21)
      return { ext: 'webp', w: 1 + (bits & 0x3fff), h: 1 + ((bits >> 14) & 0x3fff) }
    }
    if (kind === 'VP8 ') return { ext: 'webp', w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff }
  }
  return null
}

/* ── 메타데이터 지우기 ── */

/** PNG: 위치 · 시각 · 글 조각(eXIf, tEXt, iTXt, zTXt, tIME)을 빼고, IEND 뒤에 붙은 것도 버립니다 */
const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME'])

function stripPng(b: Buffer): Buffer | null {
  const out: Buffer[] = [b.subarray(0, 8)]
  let i = 8
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i)
    const type = b.toString('latin1', i + 4, i + 8)
    const end = i + 12 + len
    if (!/^[A-Za-z]{4}$/.test(type) || len > 0x7fffffff || end > b.length) return null
    if (!PNG_DROP.has(type)) out.push(b.subarray(i, end))
    i = end
    if (type === 'IEND') return Buffer.concat(out)
  }
  return null
}

/** JPEG: APP0(JFIF) · APP2(ICC 색 정보) · APP14(Adobe)만 두고 APP1(EXIF · XMP) · 다른 APPn · 주석은 뺍니다. 영상 데이터(SOS)부터는 그대로 */
function stripJpeg(b: Buffer): Buffer | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null
  const out: Buffer[] = [b.subarray(0, 2)]
  let i = 2
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1] ?? 0
    if (marker === 0xff) { i++; continue }
    if (marker === 0xda || marker === 0xd9) {
      out.push(b.subarray(i))
      return Buffer.concat(out)
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(b.subarray(i, i + 2))
      i += 2
      continue
    }
    if (i + 4 > b.length) return null
    const len = b.readUInt16BE(i + 2)
    const end = i + 2 + len
    if (len < 2 || end > b.length) return null
    const app = marker >= 0xe0 && marker <= 0xef
    const drop = (app && marker !== 0xe0 && marker !== 0xe2 && marker !== 0xee) || marker === 0xfe
    if (!drop) out.push(b.subarray(i, end))
    i = end
  }
  return null
}

/** WebP: EXIF · XMP 조각을 빼고 VP8X 표시 비트도 끕니다. RIFF 크기를 다시 셉니다 */
function stripWebp(b: Buffer): Buffer | null {
  if (b.length < 20 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null
  const riffEnd = Math.min(b.length, 8 + b.readUInt32LE(4))
  const chunks: Buffer[] = []
  let i = 12
  while (i + 8 <= riffEnd) {
    const fourcc = b.toString('latin1', i, i + 4)
    const size = b.readUInt32LE(i + 4)
    const dataEnd = i + 8 + size
    if (dataEnd > riffEnd) return null
    const end = Math.min(riffEnd, dataEnd + (size & 1))
    if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
      let chunk = b.subarray(i, end)
      if (fourcc === 'VP8X' && chunk.length > 8) {
        chunk = Buffer.from(chunk)
        chunk[8] = (chunk[8] ?? 0) & ~0x0c
      }
      chunks.push(chunk)
    }
    i = end
  }
  if (!chunks.length) return null
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(12)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(4 + body.length, 4)
  head.write('WEBP', 8, 'latin1')
  return Buffer.concat([head, body])
}

/** 위치 정보(EXIF) · XMP · 글 메타데이터를 뺀 사본. 구조가 깨진 파일이면 null */
export function stripMetadata(b: Buffer, ext: 'png' | 'jpg' | 'webp'): Buffer | null {
  try {
    return ext === 'png' ? stripPng(b) : ext === 'jpg' ? stripJpeg(b) : stripWebp(b)
  } catch {
    return null
  }
}

/* ── 용량 ── */

function dirBytes(): number {
  let n = 0
  for (const f of readdirSync(UPLOAD_DIR)) {
    try { n += statSync(join(UPLOAD_DIR, f)).size } catch { /* 지워진 파일 */ }
  }
  return n
}

/** 업로드 폴더 합계. 시작할 때와 정리할 때 다시 세고, 그 사이에는 더하고 빼기만 합니다 */
let totalBytes = dirBytes()
let freeCache = { at: 0, bytes: Number.POSITIVE_INFINITY }
let capWarned = false
let fullWarnedAt = 0

/** 디스크 여유 (1분 캐시). 알 수 없으면 무한대 */
function freeBytes(): number {
  const now = Date.now()
  if (now - freeCache.at < 60_000) return freeCache.bytes
  try {
    const s = statfsSync(UPLOAD_DIR)
    freeCache = { at: now, bytes: Number(s.bavail) * Number(s.bsize) }
  } catch {
    freeCache = { at: now, bytes: Number.POSITIVE_INFINITY }
  }
  return freeCache.bytes
}

const mb = (n: number) => Math.round(n / 1024 / 1024)

function warnFull() {
  const now = Date.now()
  if (now - fullWarnedAt < 3600_000) return
  fullWarnedAt = now
  const free = freeBytes()
  notify('이미지 업로드를 받지 못함 (용량)', {
    '업로드 폴더(MB)': mb(totalBytes), '상한(MB)': mb(TOTAL_MAX), '디스크 여유(MB)': Number.isFinite(free) ? mb(free) : '알 수 없음',
  })
}

function checkCapacity() {
  if (!capWarned && totalBytes >= TOTAL_MAX * 0.8) {
    capWarned = true
    notify('이미지 업로드 폴더 80% 넘음', { '사용(MB)': mb(totalBytes), '상한(MB)': mb(TOTAL_MAX) })
  } else if (capWarned && totalBytes < TOTAL_MAX * 0.7) capWarned = false
}

/** 용량 · 디스크 여유가 모자라면 true */
const noRoom = (extra: number) => totalBytes + extra > TOTAL_MAX || freeBytes() < MIN_FREE + extra

/* ── 올리기 ── */

/** 본문을 끝까지 읽되 limit을 넘으면 그만 읽습니다 */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        over = true
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)) })
    req.on('error', () => resolve(null))
    req.on('close', () => { if (!over) resolve(null) })
  })
}

function quotaFail(sid: string, ipKey: string, now: number): UploadFail | null {
  const recent = (bySid.get(sid) ?? []).filter(t => now - t < 3600_000)
  if (recent.length >= PER_SID_HOUR) return 'slow'
  const ip = byIp.get(ipKey)
  if (ip && ip.day === kstDate() && ip.n >= PER_IP_DAY) return 'many'
  return null
}

/**
 * 방문자 업로드를 받기 전 확인 (본문을 읽기 전에 부릅니다). 통과하면 done()을 꼭 불러 자리를 돌려줍니다.
 * 시도 횟수 · 할당량 · 용량 · 동시 업로드 수를 봅니다.
 */
export function beginUpload(sid: string, ipKey: string): { ok: true; done: () => void } | { ok: false; reason: UploadFail } {
  if (!tryLimiter.allow(ipKey)) return { ok: false, reason: 'slow' }
  const q = quotaFail(sid, ipKey, Date.now())
  if (q) return { ok: false, reason: q }
  if (noRoom(0)) {
    warnFull()
    return { ok: false, reason: 'full' }
  }
  if (active >= MAX_ACTIVE) return { ok: false, reason: 'busy' }
  active++
  let released = false
  return {
    ok: true,
    done: () => {
      if (released) return
      released = true
      active--
    },
  }
}

export function saveUpload(buf: Buffer | null, sid: string, ipKey: string): { ok: true; id: string } | { ok: false; reason: UploadFail } {
  if (!buf) return { ok: false, reason: 'size' }
  if (buf.length === 0) return { ok: false, reason: 'bad' }
  const img = sniffImage(buf)
  if (!img || img.w < 16 || img.h < 16 || img.w > 8000 || img.h > 8000) return { ok: false, reason: 'type' }
  const clean = stripMetadata(buf, img.ext)
  if (!clean || sniffImage(clean)?.ext !== img.ext) return { ok: false, reason: 'type' }
  const now = Date.now()
  const q = quotaFail(sid, ipKey, now)
  if (q) return { ok: false, reason: q }
  if (noRoom(clean.length)) {
    warnFull()
    return { ok: false, reason: 'full' }
  }
  const id = `${randomBytes(12).toString('base64url')}.${img.ext}`
  writeFileSync(join(UPLOAD_DIR, id), clean, { flag: 'wx' })
  totalBytes += clean.length
  checkCapacity()
  const recent = (bySid.get(sid) ?? []).filter(t => now - t < 3600_000)
  recent.push(now)
  bySid.set(sid, recent)
  const day = kstDate()
  const ip = byIp.get(ipKey)
  byIp.set(ipKey, { day, n: ip && ip.day === day ? ip.n + 1 : 1 })
  owner.set(id, { sid, at: now })
  return { ok: true, id }
}

/** 이 사람이 하루 안에 올린 파일인가 (접수 · 수정에 붙일 수 있는지) */
export function ownsUpload(id: unknown, sid: string): id is string {
  if (typeof id !== 'string' || !UPLOAD_NAME_RE.test(id)) return false
  const o = owner.get(id)
  return !!o && o.sid === sid && Date.now() - o.at < ORPHAN_MS
}

/* ── 보여 주기 ── */

/** 맵에 떠 있는 사당의 이미지 이름 (allShrines 캐시가 바뀔 때만 다시 만듭니다) */
let publicFrom: unknown = null
let publicSet = new Set<string>()

function publicUploads(): Set<string> {
  const list = allShrines()
  if (list !== publicFrom) {
    publicFrom = list
    publicSet = new Set(list.flatMap(s => s.screens).filter(f => f.startsWith('up/')).map(f => f.slice(3)))
  }
  return publicSet
}

export const isPublicUpload = (id: string) => publicUploads().has(id)

type ReviewerCheck = (req: IncomingMessage) => boolean
let isReviewer: ReviewerCheck = () => false

/**
 * 운영자 화면(admin.ts)이 "이 요청은 로그인한 운영자"인지 알려 주는 함수를 넣습니다.
 * 넣으면 검토 대기 이미지를 운영자 화면에서도 볼 수 있습니다.
 */
export function setReviewerCheck(fn: ReviewerCheck) {
  isReviewer = fn
}

/** 관리 비밀번호로 접수를 연 사람(입장 표)에게 그 접수의 검토 대기 이미지를 잠시 보여 줍니다 */
export function grantUploadView(sid: string, ids: (string | null | undefined)[]) {
  if (!sid) return
  const list = ids.filter((x): x is string => typeof x === 'string' && UPLOAD_NAME_RE.test(x))
  if (!list.length) return
  const now = Date.now()
  const g = grants.get(sid)
  const set = g && g.until > now ? g.ids : new Set<string>()
  for (const id of list) set.add(id)
  grants.set(sid, { ids: set, until: now + GRANT_MS })
}

function canSeePrivate(req: IncomingMessage, id: string, sid: string | null): boolean {
  const now = Date.now()
  if (sid) {
    const o = owner.get(id)
    if (o && o.sid === sid && now - o.at < ORPHAN_MS) return true
    const g = grants.get(sid)
    if (g && g.until > now && g.ids.has(id)) return true
  }
  try {
    return isReviewer(req)
  } catch {
    return false
  }
}

/** 파일을 응답으로 흘려보냅니다. 읽다가 실패해도(파일이 지워짐 · EMFILE) 프로세스가 죽지 않고 그 응답만 끊습니다 */
export function pipeFile(res: ServerResponse, path: string) {
  pipeline(createReadStream(path), res, err => {
    if (!err) return
    const code = (err as NodeJS.ErrnoException).code ?? ''
    if (code !== 'ERR_STREAM_PREMATURE_CLOSE') console.warn(`[shrine] 파일 보내기 실패: ${code || err.message}`)
  })
}

/**
 * GET /img/shrines/up/<이름>. 보여 줄 수 없으면 false (부른 쪽이 404).
 * 맵에 있는 사당 이미지는 누구에게나 1일 캐시로, 검토 대기 이미지는 볼 수 있는 사람에게만 캐시 없이 보냅니다.
 */
export function serveUpload(req: IncomingMessage, res: ServerResponse, id: string, viewerSid: string | null): boolean {
  if (!UPLOAD_NAME_RE.test(id)) return false
  const open = isPublicUpload(id)
  if (!open && !canSeePrivate(req, id, viewerSid)) return false
  const path = join(UPLOAD_DIR, id)
  let size = 0
  try {
    const st = statSync(path)
    if (!st.isFile()) return false
    size = st.size
  } catch {
    return false
  }
  const ext = id.slice(id.lastIndexOf('.') + 1)
  // 파일 이름은 무작위이고 한 번 쓴 뒤 바뀌지 않으므로 이름이 곧 ETag입니다
  const etag = `"${id}"`
  const headers: Record<string, string | number> = {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ETag: etag,
  }
  if (open) headers['Cache-Control'] = 'public, max-age=86400'
  else {
    headers['Cache-Control'] = 'private, no-store'
    headers['X-Robots-Tag'] = 'noindex'
  }
  if (open && req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers)
    res.end()
    return true
  }
  res.writeHead(200, { ...headers, 'Content-Length': size })
  if (req.method === 'HEAD') res.end()
  else pipeFile(res, path)
  return true
}

/* ── 정리 ── */

/** 사당(맵에 있든 없든)이 쓰는 이미지 이름 */
function shrineImages(): Set<string> {
  const used = new Set<string>()
  const shrines = db.prepare('SELECT screens FROM shrines').all() as unknown as { screens: string }[]
  for (const s of shrines) {
    try {
      for (const f of JSON.parse(s.screens) as unknown[]) if (typeof f === 'string' && f.startsWith('up/')) used.add(f.slice(3))
    } catch { /* 무시 */ }
  }
  return used
}

/**
 * 파기: 이 이미지들을 바로 지웁니다 (retention.ts). 사당이나 다른 접수가 아직 쓰는 파일은 남깁니다.
 * 부르기 전에 그 접수의 screen · pending_screen을 먼저 비워 두세요. 지운 개수를 돌려줍니다.
 */
export function removeUploads(ids: (string | null | undefined)[]): number {
  const inShrine = shrineImages()
  const inProject = db.prepare('SELECT 1 FROM projects WHERE screen = ? OR pending_screen = ? LIMIT 1')
  let n = 0
  for (const id of new Set(ids)) {
    if (typeof id !== 'string' || !UPLOAD_NAME_RE.test(id) || inShrine.has(id) || inProject.get(id, id)) continue
    const path = join(UPLOAD_DIR, id)
    try {
      const size = statSync(path).size
      unlinkSync(path)
      totalBytes = Math.max(0, totalBytes - size)
      n++
    } catch { /* 이미 없음 */ }
    owner.delete(id)
  }
  return n
}

/** 메모리 기록 정리 (지난 할당량 · 소유 · 보기 허락) */
function pruneMemory(now = Date.now()) {
  for (const [sid, list] of bySid) {
    const recent = list.filter(t => now - t < 3600_000)
    if (recent.length) bySid.set(sid, recent)
    else bySid.delete(sid)
  }
  const day = kstDate()
  for (const [k, v] of byIp) if (v.day !== day) byIp.delete(k)
  for (const [id, o] of owner) if (now - o.at >= ORPHAN_MS) owner.delete(id)
  for (const [sid, g] of grants) if (g.until <= now) grants.delete(sid)
}
setInterval(pruneMemory, 3600_000).unref()

/**
 * 접수 · 사당 어디에도 안 쓰인 지 하루 넘은 파일 지우기.
 * 반려 · 내린 접수는 파기 전(30일)까지 이미지를 남겨 두고, 파기할 때 retention.ts가 지웁니다.
 */
export function cleanupUploads() {
  const used = shrineImages()
  const rows = db.prepare('SELECT screen, pending_screen FROM projects').all() as unknown as { screen: string; pending_screen: string | null }[]
  for (const r of rows) {
    if (r.screen) used.add(r.screen)
    if (r.pending_screen) used.add(r.pending_screen)
  }
  const now = Date.now()
  for (const f of readdirSync(UPLOAD_DIR)) {
    if (used.has(f)) continue
    const path = join(UPLOAD_DIR, f)
    try {
      if (now - statSync(path).mtimeMs > ORPHAN_MS) unlinkSync(path)
    } catch { /* 무시 */ }
  }
  totalBytes = dirBytes()
  checkCapacity()
  pruneMemory(now)
}

/** 헬스 체크용: 업로드 폴더 상태 (사용률 · 디스크 여유 부족 · 쓸 수 있는지) */
export function uploadStats() {
  let writable = true
  try {
    accessSync(UPLOAD_DIR, constants.W_OK)
  } catch {
    writable = false
  }
  return { usedPct: Math.round((totalBytes / TOTAL_MAX) * 100), lowDisk: freeBytes() < MIN_FREE, writable }
}
