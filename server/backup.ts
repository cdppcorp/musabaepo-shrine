// 백업 · 복구 도구.
//   · SQLite는 온라인 백업 API(node:sqlite backup)로 한 시점의 사본을 뜹니다. WAL 모드라 서버가 도는 중에 떠도 안전합니다.
//     (db 파일만 복사하면 -wal에 있는 최근 쓰기가 빠지거나 사본이 깨질 수 있습니다)
//   · 백업 하나는 tar 파일 하나입니다: shrine.db + uploads/(등록소 이미지) + manifest.json(표별 행 수 · 이미지 수)
//   · BACKUP_DIR에 shrine-YYYYMMDD-HHMMSSZ.tar(UTC) 이름으로 두고, 최근 BACKUP_KEEP개만 남깁니다.
//   · 백업에는 이메일 같은 개인정보가 들어 있어서 파일은 만든 사용자만 읽을 수 있게(600) 만듭니다.
//
//   npm run backup                           지금 백업 하나 만들기
//   npm run backup -- list                   백업 목록
//   npm run backup -- verify <파일>           백업 검사: DB 무결성, 표별 행 수 · 이미지 수를 manifest와 맞춰 봄
//   npm run backup -- restore <파일> [폴더]   백업을 폴더(기본 DATA_DIR)에 되살림. 서버를 멈춘 뒤에만 씁니다.
//                                            원래 있던 DB · 이미지는 지우지 않고 그 폴더의 pre-restore-<시각>/으로 옮깁니다.
//
// Docker: docker compose exec -T shrine node --disable-warning=ExperimentalWarning server/backup.ts [명령]
// 설정: DATA_DIR(기본 ./data, config.ts와 같음) · BACKUP_DIR(기본 ./backups) · BACKUP_KEEP(기본 14)
// config.ts · db.ts는 불러오지 않습니다. 운영 설정이 비어 있거나 DB가 깨졌을 때도 백업 · 복구는 돌아야 해서입니다.
import { createHash } from 'node:crypto'
import {
  accessSync, closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readSync,
  readdirSync, renameSync, rmSync, statSync, statfsSync, unlinkSync, writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'

const DB_NAME = 'shrine.db'
const UPLOADS = 'uploads'
const MANIFEST = 'manifest.json'
const FORMAT = 'musabaepo-shrine-backup'
/** 백업 파일 이름. 같은 초에 또 만들면 뒤에 -2, -3 … */
const NAME_RE = /^shrine-(\d{8}-\d{6})Z(?:-(\d+))?\.tar$/
/** 이미지 파일 이름으로 받아 줄 글자 (경로 문자 · 점으로 시작하는 이름은 안 받음) */
const SAFE_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/
/** 백업이 끝난 뒤에도 디스크에 남겨 둘 여유. 디스크가 차면 SQLite 쓰기가 실패합니다 */
const DISK_RESERVE = 256 * 1024 * 1024
/** 중간에 멈춘 백업이 남긴 임시 파일을 지우기까지 */
const STALE_MS = 6 * 3600_000
const BLOCK = 512

export class BackupError extends Error {}

export interface BackupSettings {
  dataDir: string
  backupDir: string
  keep: number
}

export function backupSettings(): BackupSettings {
  const keepRaw = process.env.BACKUP_KEEP?.trim()
  const keep = keepRaw ? Number(keepRaw) : 14
  if (!Number.isSafeInteger(keep) || keep < 1) throw new BackupError('BACKUP_KEEP는 1 이상의 정수여야 합니다')
  return {
    dataDir: resolve(process.env.DATA_DIR ?? './data'),
    backupDir: resolve(process.env.BACKUP_DIR?.trim() || './backups'),
    keep,
  }
}

interface Manifest {
  format: string
  version: number
  createdAt: string
  tables: Record<string, number>
  uploads: number
  uploadBytes: number
  node: string
  /** tar 안 파일별 SHA-256. integrity_check는 구조만 보므로 내용이 바뀐 것(비트 손상)은 이걸로 잡습니다 */
  sha256?: Record<string, string>
}

/* ── 작은 도움 함수 ── */

function size(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

/** 20261117-031500 (UTC) */
function stamp(d = new Date()): string {
  const iso = d.toISOString()
  return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function code(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code
}

function tableLine(tables: Record<string, number>): string {
  return Object.entries(tables).map(([k, v]) => `${k} ${v}`).join(' · ') || '(표 없음)'
}

/** DB를 열어 무결성을 보고 표별 행 수를 셉니다. 사본은 한 파일로 다니게 저널 모드를 DELETE로 바꿉니다 (서버가 열면 다시 WAL) */
function inspectDb(path: string): Record<string, number> {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = DELETE')
    const check = (db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[])
      .map(r => r.integrity_check).join('; ')
    if (check !== 'ok') throw new BackupError(`DB 무결성 검사에 실패했습니다: ${check}`)
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
    const tables: Record<string, number> = {}
    for (const { name } of names) {
      const row = db.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get() as { n: number }
      tables[name] = row.n
    }
    return tables
  } finally {
    db.close()
  }
}

/* ── tar (ustar) 쓰기 · 읽기: 이 도구가 만드는 형식만 다루면 되므로 직접 씁니다 ── */

const octal = (n: number, width: number) => `${Math.floor(n).toString(8).padStart(width - 1, '0')}\0`

class TarWriter {
  private fd: number
  private buf = Buffer.alloc(1 << 20)
  private uid: number
  private gid: number
  /** 넣은 파일별 SHA-256 (manifest에 적음) */
  hashes: Record<string, string> = {}

  constructor(path: string) {
    // 'wx': 이미 있으면 덮어쓰지 않음, 600: 만든 사용자만 읽기
    this.fd = openSync(path, 'wx', 0o600)
    const uid = process.getuid?.() ?? 0
    const gid = process.getgid?.() ?? 0
    this.uid = uid < 0o7777777 ? uid : 0
    this.gid = gid < 0o7777777 ? gid : 0
  }

  private header(name: string, bytes: number, type: '0' | '5', mtimeMs: number, mode: number) {
    if (Buffer.byteLength(name) > 100) throw new BackupError(`tar에 넣을 이름이 너무 깁니다: ${name}`)
    if (bytes >= 8 ** 11) throw new BackupError(`파일이 너무 큽니다: ${name}`)
    const h = Buffer.alloc(BLOCK)
    h.write(name, 0, 100, 'utf8')
    h.write(octal(mode, 8), 100, 'ascii')
    h.write(octal(this.uid, 8), 108, 'ascii')
    h.write(octal(this.gid, 8), 116, 'ascii')
    h.write(octal(bytes, 12), 124, 'ascii')
    h.write(octal(mtimeMs / 1000, 12), 136, 'ascii')
    h.write('        ', 148, 'ascii')
    h.write(type, 156, 'ascii')
    h.write('ustar\0', 257, 'ascii')
    h.write('00', 263, 'ascii')
    let sum = 0
    for (const b of h) sum += b
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
    writeSync(this.fd, h)
  }

  private zeros(n: number) {
    while (n > 0) {
      const k = Math.min(n, this.buf.length)
      writeSync(this.fd, this.buf.fill(0, 0, k), 0, k)
      n -= k
    }
  }

  private pad(bytes: number) {
    this.zeros((BLOCK - (bytes % BLOCK)) % BLOCK)
  }

  dir(name: string, mtimeMs: number) {
    this.header(name.endsWith('/') ? name : `${name}/`, 0, '5', mtimeMs, 0o755)
  }

  data(name: string, body: Buffer, mtimeMs: number) {
    this.header(name, body.length, '0', mtimeMs, 0o644)
    writeSync(this.fd, body)
    this.pad(body.length)
  }

  /** 파일을 그대로 넣습니다. 그새 지워졌으면 null */
  file(name: string, path: string, mode = 0o644): number | null {
    let src: number
    try {
      src = openSync(path, 'r')
    } catch (e) {
      if (code(e) === 'ENOENT') return null
      throw e
    }
    try {
      const st = fstatSync(src)
      if (!st.isFile()) return null
      this.header(name, st.size, '0', st.mtimeMs, mode)
      const hash = createHash('sha256')
      let left = st.size
      while (left > 0) {
        const n = readSync(src, this.buf, 0, Math.min(this.buf.length, left), null)
        if (n <= 0) break
        writeSync(this.fd, this.buf, 0, n)
        hash.update(this.buf.subarray(0, n))
        left -= n
      }
      // 읽는 사이 파일이 줄었으면 0으로 채워 tar 모양을 지킵니다. 이미지는 한 번 쓰면 바뀌지 않으므로
      // 이런 파일은 DB 사본보다 뒤에 막 올라온(사본이 가리키지 않는) 것뿐입니다.
      if (left > 0) {
        hash.update(Buffer.alloc(left))
        this.zeros(left)
      }
      this.hashes[name] = hash.digest('hex')
      this.pad(st.size)
      return st.size
    } finally {
      closeSync(src)
    }
  }

  finish() {
    this.zeros(BLOCK * 2)
    fsyncSync(this.fd)
    closeSync(this.fd)
  }

  abort() {
    try { closeSync(this.fd) } catch { /* 이미 닫힘 */ }
  }
}

interface TarEntry { name: string; type: 'file' | 'dir' | 'other'; size: number }
interface Sink { write(chunk: Buffer): void; end(): void }

/** tar를 앞에서부터 읽으며 항목마다 visit을 부릅니다. Sink를 돌려주면 그 항목의 내용을 넘깁니다 (chunk는 다음 조각에서 덮어씀) */
function readTar(path: string, visit: (e: TarEntry) => Sink | null) {
  const cut = () => new BackupError('백업 파일이 중간에 끊겼습니다 (복사가 덜 됐는지 확인하세요)')
  const fd = openSync(path, 'r')
  try {
    const total = fstatSync(fd).size
    const h = Buffer.alloc(BLOCK)
    const buf = Buffer.alloc(1 << 20)
    let pos = 0
    for (;;) {
      if (pos + BLOCK > total) throw cut()
      if (readSync(fd, h, 0, BLOCK, pos) !== BLOCK) throw cut()
      if (h.every(b => b === 0)) return
      const str = (start: number, len: number) => {
        const end = h.indexOf(0, start)
        return h.toString('utf8', start, end >= start && end < start + len ? end : start + len)
      }
      const num = (start: number, len: number) => {
        if ((h[start] ?? 0) & 0x80) throw new BackupError('지원하지 않는 tar 형식입니다 (8GB 넘는 항목)')
        const v = str(start, len).trim()
        return v ? parseInt(v, 8) : 0
      }
      let sum = 0
      for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (h[i] ?? 0)
      if (num(148, 8) !== sum) throw new BackupError(`tar 머리 검사값이 맞지 않습니다 (위치 ${pos}). 백업 파일이 깨졌을 수 있습니다`)
      if (!str(257, 6).startsWith('ustar')) throw new BackupError('ustar 형식의 tar가 아닙니다')
      const prefix = str(345, 155)
      const name = (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100)).replace(/^\.\//, '')
      const bytes = num(124, 12)
      const flag = String.fromCharCode(h[156] ?? 0)
      const type = flag === '0' || flag === '\0' ? 'file' : flag === '5' ? 'dir' : 'other'
      const start = pos + BLOCK
      const padded = Math.ceil(bytes / BLOCK) * BLOCK
      if (start + padded > total) throw cut()
      const sink = visit({ name, type, size: bytes })
      if (sink) {
        try {
          let off = 0
          while (off < bytes) {
            const n = readSync(fd, buf, 0, Math.min(buf.length, bytes - off), start + off)
            if (n <= 0) throw cut()
            sink.write(buf.subarray(0, n))
            off += n
          }
        } finally {
          sink.end()
        }
      }
      pos = start + padded
    }
  } finally {
    closeSync(fd)
  }
}

function fileSink(path: string, mode: number): Sink {
  const fd = openSync(path, 'wx', mode)
  return {
    write: chunk => { writeSync(fd, chunk) },
    end: () => { closeSync(fd) },
  }
}

interface Extracted {
  manifest: Manifest | null
  hasDb: boolean
  uploads: number
  uploadBytes: number
  /** 읽으면서 잰 파일별 SHA-256 */
  sha256: Record<string, string>
  skipped: string[]
}

/** 백업에서 쓸 것만 dest에 풉니다: shrine.db, manifest, uploads/<이름>. withUploads=false면 이미지는 세기만 합니다 */
function extract(file: string, dest: string, withUploads: boolean): Extracted {
  const out: Extracted = { manifest: null, hasDb: false, uploads: 0, uploadBytes: 0, sha256: {}, skipped: [] }
  const manifestChunks: Buffer[] = []
  /** 내용을 넘기면서 SHA-256도 잽니다. inner가 없으면 재기만 */
  const hashed = (name: string, inner: Sink | null): Sink => {
    const h = createHash('sha256')
    return {
      write: c => { h.update(c); inner?.write(c) },
      end: () => { out.sha256[name] = h.digest('hex'); inner?.end() },
    }
  }
  readTar(file, e => {
    if (e.type === 'dir') {
      if (e.name.replace(/\/$/, '') === UPLOADS) {
        if (withUploads) mkdirSync(join(dest, UPLOADS), { recursive: true })
      } else out.skipped.push(e.name)
      return null
    }
    if (e.type !== 'file') {
      out.skipped.push(e.name)
      return null
    }
    if (e.name === MANIFEST && e.size <= 1024 * 1024) {
      return { write: c => { manifestChunks.push(Buffer.from(c)) }, end: () => {} }
    }
    if (e.name === DB_NAME) {
      if (out.hasDb) throw new BackupError('백업 안에 shrine.db가 두 개 있습니다')
      out.hasDb = true
      return hashed(DB_NAME, fileSink(join(dest, DB_NAME), 0o600))
    }
    const m = /^uploads\/([^/]+)$/.exec(e.name)
    if (m?.[1] && SAFE_NAME_RE.test(m[1])) {
      out.uploads++
      out.uploadBytes += e.size
      if (!withUploads) return hashed(e.name, null)
      mkdirSync(join(dest, UPLOADS), { recursive: true })
      return hashed(e.name, fileSink(join(dest, UPLOADS, m[1]), 0o644))
    }
    out.skipped.push(e.name)
    return null
  })
  if (manifestChunks.length) {
    try {
      out.manifest = JSON.parse(Buffer.concat(manifestChunks).toString('utf8')) as Manifest
    } catch {
      throw new BackupError('manifest.json을 읽을 수 없습니다')
    }
  }
  return out
}

/** 백업 당시 기록(manifest)과 되살린 내용이 같은지. 다르면 이유 목록 */
function compare(x: Extracted, tables: Record<string, number>): string[] {
  const m = x.manifest
  if (!m) return []
  const problems: string[] = []
  if (m.format !== FORMAT) problems.push(`이 도구가 만든 백업이 아닙니다 (format: ${String(m.format)})`)
  for (const [t, n] of Object.entries(m.tables ?? {})) {
    if (tables[t] !== n) problems.push(`${t}: 백업 당시 ${n}행, 지금 ${tables[t] ?? '없음'}`)
  }
  if (m.uploads !== x.uploads) problems.push(`이미지: 백업 당시 ${m.uploads}개, 지금 ${x.uploads}개`)
  if (m.uploadBytes !== x.uploadBytes) problems.push(`이미지 용량: 백업 당시 ${m.uploadBytes}B, 지금 ${x.uploadBytes}B`)
  const broken = Object.entries(m.sha256 ?? {}).filter(([name, sum]) => x.sha256[name] !== sum).map(([name]) => name)
  if (broken.length) {
    problems.push(`내용이 백업 당시와 다릅니다 (파일 손상): ${broken.slice(0, 10).join(', ')}${broken.length > 10 ? ` 외 ${broken.length - 10}개` : ''}`)
  }
  return problems
}

/* ── 백업 폴더 ── */

function ensureWritableDir(dir: string) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    accessSync(dir, constants.W_OK)
  } catch (e) {
    if (code(e) === 'EACCES' || code(e) === 'EPERM' || code(e) === 'EROFS') {
      throw new BackupError(`백업 폴더에 쓸 수 없습니다: ${dir}\n  Docker라면 호스트에서 deploy/backups 폴더 주인을 컨테이너 사용자로 바꿔 주세요: sudo chown 1000:1000 backups`)
    }
    throw e
  }
}

/** 중간에 멈춘 백업 · 검사가 남긴 임시 파일 정리 */
function cleanStale(dir: string) {
  const now = Date.now()
  for (const n of readdirSync(dir)) {
    if (!/^\.(work-|verify-|shrine-.*\.partial$)/.test(n)) continue
    const p = join(dir, n)
    try {
      if (now - statSync(p).mtimeMs > STALE_MS) rmSync(p, { recursive: true, force: true })
    } catch { /* 다른 백업이 지웠음 */ }
  }
}

/** 이 도구가 만든 백업 파일, 새것부터 */
export function listBackups(dir = backupSettings().backupDir): { name: string; path: string; bytes: number; mtimeMs: number }[] {
  if (!existsSync(dir)) return []
  const key = (n: string) => {
    const m = NAME_RE.exec(n)
    return `${m?.[1] ?? ''}-${(m?.[2] ?? '1').padStart(6, '0')}`
  }
  return readdirSync(dir)
    .filter(n => NAME_RE.test(n))
    .sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0))
    .map(name => {
      const path = join(dir, name)
      const st = statSync(path)
      return { name, path, bytes: st.size, mtimeMs: st.mtimeMs }
    })
}

/* ── 백업 만들기 ── */

export interface BackupResult {
  file: string
  bytes: number
  tables: Record<string, number>
  uploads: number
  uploadBytes: number
  removed: string[]
}

export async function createBackup(opts: Partial<BackupSettings> = {}): Promise<BackupResult> {
  const s = { ...backupSettings(), ...opts }
  const dbPath = join(s.dataDir, DB_NAME)
  const uploadsDir = join(s.dataDir, UPLOADS)
  if (!existsSync(dbPath)) throw new BackupError(`DB 파일이 없습니다: ${dbPath} (DATA_DIR을 확인하세요)`)
  if (isInside(s.backupDir, uploadsDir)) throw new BackupError('BACKUP_DIR을 이미지 폴더(uploads) 안에 둘 수 없습니다')
  ensureWritableDir(s.backupDir)
  cleanStale(s.backupDir)

  // 디스크 여유: DB 임시 사본 + tar(DB + 이미지)를 쓰고도 DISK_RESERVE가 남아야 합니다
  const dbBytes = statSync(dbPath).size + (existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0)
  let uploadBytes = 0
  const uploadNames: string[] = []
  if (existsSync(uploadsDir)) {
    for (const d of readdirSync(uploadsDir, { withFileTypes: true })) {
      if (!d.isFile() || !SAFE_NAME_RE.test(d.name)) continue
      uploadNames.push(d.name)
      try { uploadBytes += statSync(join(uploadsDir, d.name)).size } catch { /* 그새 지워짐 */ }
    }
  }
  uploadNames.sort()
  try {
    const fs = statfsSync(s.backupDir)
    const free = Number(fs.bavail) * Number(fs.bsize)
    const need = dbBytes * 2 + uploadBytes
    if (free < need + DISK_RESERVE) {
      throw new BackupError(`백업 폴더의 디스크 여유가 부족합니다 (남은 ${size(free)}, 필요 ${size(need)} + 여유 ${size(DISK_RESERVE)}). 오래된 백업을 서버 밖으로 옮기거나 BACKUP_KEEP을 줄이세요`)
    }
  } catch (e) {
    if (e instanceof BackupError) throw e
    // statfs를 못 쓰는 파일 시스템이면 건너뜁니다
  }

  // 같은 초에 또 만들면 그 초의 가장 큰 번호 + 1 (정리로 지워진 이름을 다시 쓰면 순서가 꼬입니다)
  const created = new Date()
  const sec = stamp(created)
  let last = 0
  for (const n of readdirSync(s.backupDir)) {
    const m = NAME_RE.exec(n.replace(/^\.(.*)\.partial$/, '$1'))
    if (m?.[1] === sec) last = Math.max(last, Number(m[2] ?? 1))
  }
  const base = last ? `shrine-${sec}Z-${last + 1}` : `shrine-${sec}Z`
  const final = join(s.backupDir, `${base}.tar`)
  const partial = join(s.backupDir, `.${base}.tar.partial`)
  const work = mkdtempSync(join(s.backupDir, '.work-'))
  let tar: TarWriter | null = null
  try {
    // 1) DB 사본: 한 번에 전부(rate -1) 떠서 그 시점의 모습 그대로
    const snap = join(work, DB_NAME)
    const src = new DatabaseSync(dbPath, { timeout: 10_000 })
    try {
      await backup(src, snap, { rate: -1 })
    } finally {
      src.close()
    }
    const tables = inspectDb(snap)

    // 2) tar: DB → 이미지 → manifest. DB를 먼저 떴으므로 사본이 가리키는 이미지는 모두 이미 다 써진 파일입니다
    const at = created.getTime()
    tar = new TarWriter(partial)
    tar.file(DB_NAME, snap, 0o600)
    tar.dir(UPLOADS, at)
    let uploads = 0
    let packedBytes = 0
    for (const name of uploadNames) {
      const n = tar.file(`${UPLOADS}/${name}`, join(uploadsDir, name))
      if (n == null) continue
      uploads++
      packedBytes += n
    }
    const manifest: Manifest = {
      format: FORMAT, version: 1, createdAt: created.toISOString(), tables, uploads, uploadBytes: packedBytes, node: process.version,
      sha256: tar.hashes,
    }
    tar.data(MANIFEST, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), at)
    tar.finish()
    tar = null
    renameSync(partial, final)
    try {
      const dfd = openSync(s.backupDir, 'r')
      try { fsyncSync(dfd) } finally { closeSync(dfd) }
    } catch { /* 폴더 fsync가 안 되는 곳(Windows) */ }

    // 3) 오래된 백업 정리: 새것부터 keep개만
    const removed: string[] = []
    for (const old of listBackups(s.backupDir).slice(s.keep)) {
      if (old.path === final) continue
      unlinkSync(old.path)
      removed.push(old.name)
    }
    return { file: final, bytes: statSync(final).size, tables, uploads, uploadBytes: packedBytes, removed }
  } catch (e) {
    tar?.abort()
    rmSync(partial, { force: true })
    throw e
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/* ── 검사 ── */

export function verifyBackup(file: string): { manifest: Manifest | null; tables: Record<string, number>; uploads: number; uploadBytes: number } {
  const src = resolve(file)
  if (!existsSync(src)) throw new BackupError(`백업 파일이 없습니다: ${src}`)
  // DB만 잠깐 풉니다. 백업 파일 옆(같은 디스크)에, 안 되면 임시 폴더에
  let tmp: string
  try {
    tmp = mkdtempSync(join(dirname(src), '.verify-'))
  } catch {
    tmp = mkdtempSync(join(tmpdir(), 'shrine-verify-'))
  }
  try {
    const x = extract(src, tmp, false)
    if (!x.hasDb) throw new BackupError('백업 안에 shrine.db가 없습니다')
    const tables = inspectDb(join(tmp, DB_NAME))
    const problems = compare(x, tables)
    if (problems.length) throw new BackupError(`백업 당시 기록과 다릅니다:\n  ${problems.join('\n  ')}`)
    return { manifest: x.manifest, tables, uploads: x.uploads, uploadBytes: x.uploadBytes }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/* ── 되살리기 ── */

export interface RestoreResult {
  dest: string
  tables: Record<string, number>
  uploads: number
  /** 원래 있던 파일을 옮겨 둔 곳 (없었으면 null) */
  aside: string | null
  skipped: string[]
}

/** 서버를 멈춘 뒤에만 부릅니다. 먼저 옆 폴더에 풀어 검사하고, 통과하면 원래 파일을 옮기고 바꿔 넣습니다 */
export function restoreBackup(file: string, target = backupSettings().dataDir): RestoreResult {
  const src = resolve(file)
  if (!existsSync(src)) throw new BackupError(`백업 파일이 없습니다: ${src}`)
  const dest = resolve(target)
  mkdirSync(dest, { recursive: true })
  const stage = mkdtempSync(join(dest, '.restore-'))
  try {
    const x = extract(src, stage, true)
    if (!x.hasDb) throw new BackupError('백업 안에 shrine.db가 없습니다')
    const tables = inspectDb(join(stage, DB_NAME))
    const problems = compare(x, tables)
    if (problems.length) throw new BackupError(`백업 당시 기록과 달라 되살리지 않았습니다:\n  ${problems.join('\n  ')}`)
    if (!existsSync(join(stage, UPLOADS))) mkdirSync(join(stage, UPLOADS))

    // 지금 있는 DB(-wal · -shm 포함)와 이미지는 지우지 않고 옆으로. 옛 -wal이 새 DB 옆에 남으면 안 됩니다
    const aside = join(dest, `pre-restore-${stamp()}Z`)
    const moved: string[] = []
    try {
      for (const n of [DB_NAME, `${DB_NAME}-wal`, `${DB_NAME}-shm`, `${DB_NAME}-journal`, UPLOADS]) {
        if (!existsSync(join(dest, n))) continue
        mkdirSync(aside, { recursive: true })
        renameSync(join(dest, n), join(aside, n))
        moved.push(n)
      }
      renameSync(join(stage, DB_NAME), join(dest, DB_NAME))
      renameSync(join(stage, UPLOADS), join(dest, UPLOADS))
    } catch (e) {
      // 반쯤 바뀐 채로 두지 않게 되돌립니다
      for (const n of [DB_NAME, UPLOADS]) {
        if (moved.includes(n) && existsSync(join(dest, n))) {
          try { renameSync(join(dest, n), join(stage, `${n}.new`)) } catch { /* 그대로 둠 */ }
        }
      }
      for (const n of moved) {
        try { renameSync(join(aside, n), join(dest, n)) } catch { /* 그대로 둠 */ }
      }
      throw e
    }
    return { dest, tables, uploads: x.uploads, aside: moved.length ? aside : null, skipped: x.skipped }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

/* ── 명령 ── */

const USAGE = `사용법:
  npm run backup                          지금 백업 하나 만들기
  npm run backup -- list                  백업 목록
  npm run backup -- verify <파일>          백업 검사
  npm run backup -- restore <파일> [폴더]  되살리기 (기본 DATA_DIR, 서버를 멈춘 뒤에만)
Docker: docker compose exec -T shrine node --disable-warning=ExperimentalWarning server/backup.ts [명령]`

if (import.meta.main) {
  const [cmd = 'create', arg, arg2] = process.argv.slice(2)
  try {
    switch (cmd) {
      case 'create': {
        const s = backupSettings()
        const r = await createBackup(s)
        console.log(`[backup] 만들었습니다: ${r.file} (${size(r.bytes)})`)
        console.log(`  표: ${tableLine(r.tables)}`)
        console.log(`  이미지 ${r.uploads}개 (${size(r.uploadBytes)})`)
        if (r.removed.length) console.log(`  오래된 백업 ${r.removed.length}개를 지웠습니다 (최근 ${s.keep}개 보관): ${r.removed.join(', ')}`)
        break
      }
      case 'list': {
        const s = backupSettings()
        const list = listBackups(s.backupDir)
        if (!list.length) console.log(`(백업 없음: ${s.backupDir})`)
        for (const b of list) console.log(`${b.name}  ${size(b.bytes).padStart(8)}  ${new Date(b.mtimeMs).toISOString()}`)
        break
      }
      case 'verify': {
        if (!arg) throw new BackupError(USAGE)
        const r = verifyBackup(arg)
        console.log(`[backup] 이상 없습니다: ${resolve(arg)}`)
        console.log(`  만든 때: ${r.manifest?.createdAt ?? '(manifest 없음)'}`)
        console.log(`  표: ${tableLine(r.tables)}`)
        console.log(`  이미지 ${r.uploads}개 (${size(r.uploadBytes)})`)
        break
      }
      case 'restore': {
        if (!arg) throw new BackupError(USAGE)
        const r = restoreBackup(arg, arg2)
        console.log(`[backup] 되살렸습니다: ${r.dest}`)
        console.log(`  표: ${tableLine(r.tables)}`)
        console.log(`  이미지 ${r.uploads}개`)
        if (r.skipped.length) console.log(`  모르는 항목은 건너뜀: ${r.skipped.join(', ')}`)
        if (r.aside) console.log(`  원래 있던 파일은 ${r.aside} 로 옮겨 두었습니다. 서버를 띄워 확인한 뒤 지워도 됩니다.`)
        break
      }
      case 'help':
      case '-h':
      case '--help':
        console.log(USAGE)
        break
      default:
        throw new BackupError(USAGE)
    }
  } catch (e) {
    if (!(e instanceof BackupError)) throw e
    console.error(`[backup] ${e.message}`)
    process.exitCode = 1
  }
}
