// SQLite (Node 기본 내장 node:sqlite, WAL 모드).
//   · 백업은 server/backup.ts로 뜹니다. 서버가 도는 중에 db 파일만 복사하면 -wal에 있는 최근 쓰기가 빠지거나 사본이 깨질 수 있습니다.
//   · 표 구조는 아래 MIGRATIONS 배열로만 바꿉니다. PRAGMA user_version에 마지막으로 돌린 번호를 두고,
//     새 번호만 차례로 한 번씩, 하나하나 트랜잭션 안에서 돌립니다. 이미 데이터가 있는 DB를 바꾸기 전에는
//     DATA_DIR/pre-migrate/에 사본을 먼저 뜹니다 (최근 3개만 남김).
//   · 새 마이그레이션은 배열 끝에 다음 번호로만 붙입니다. 이미 배포한 항목은 고치지 않습니다.
import { chmodSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.ts'

mkdirSync(config.dataDir, { recursive: true })

export const db = new DatabaseSync(join(config.dataDir, 'shrine.db'))

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 3000;
`)

/** 예전 파일에 없는 칸 채우기 (있으면 그대로) */
function addColumn(table: string, column: string, spec: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]
  if (!cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`)
}

interface Migration {
  v: number
  name: string
  up: () => void
}

const MIGRATIONS: Migration[] = [
  {
    // 버전 관리 전에 만든 DB와 같은 모양. 그런 DB(user_version 0)에도 돌기 때문에 모두 '없으면 만들기'입니다.
    v: 1,
    name: '기본 표',
    up: () => {
      db.exec(`
        -- 사당. 사업자등록번호 같은 비공개 정보는 여기에 두지 않습니다 (확인한 날짜만).
        CREATE TABLE IF NOT EXISTS shrines (
          slug              TEXT PRIMARY KEY,
          name              TEXT NOT NULL,
          tagline           TEXT NOT NULL,
          category          TEXT NOT NULL,
          domain            TEXT NOT NULL UNIQUE,
          url               TEXT NOT NULL,
          operator          TEXT NOT NULL,
          keeper            INTEGER NOT NULL DEFAULT 0,
          paid              INTEGER NOT NULL DEFAULT 0,
          verified_domain   TEXT NOT NULL,
          verified_business TEXT,
          joined_at         TEXT NOT NULL,
          status            TEXT NOT NULL CHECK (status IN ('live', 'check')),
          prayer            TEXT NOT NULL,
          charm             TEXT,
          deco              TEXT NOT NULL DEFAULT '[]',
          screens           TEXT NOT NULL DEFAULT '[]',
          captured_at       TEXT NOT NULL,
          plot              INTEGER NOT NULL UNIQUE
        );

        -- 날짜(한국 시간) · 사당 · 기원별 초 개수
        CREATE TABLE IF NOT EXISTS candles (
          day    TEXT NOT NULL,
          slug   TEXT NOT NULL,
          prayer TEXT NOT NULL,
          n      INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (day, slug, prayer)
        );

        -- 날짜 · AI별 "잘 돌아가게" 기도 수 (초와 따로)
        CREATE TABLE IF NOT EXISTS ai_prayers (
          day TEXT NOT NULL,
          ai  TEXT NOT NULL,
          n   INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (day, ai)
        );

        -- AI 트렌드 게시판 글 (7일 보관, 자동 닉네임만). 신고 3번이면 hidden
        CREATE TABLE IF NOT EXISTS posts (
          id     INTEGER PRIMARY KEY AUTOINCREMENT,
          at     INTEGER NOT NULL,
          topic  TEXT NOT NULL,
          text   TEXT NOT NULL,
          nick   TEXT NOT NULL,
          hidden INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS posts_at ON posts (at);
        CREATE TABLE IF NOT EXISTS post_reports (
          post_id  INTEGER NOT NULL,
          reporter TEXT NOT NULL,
          PRIMARY KEY (post_id, reporter)
        );

        -- 프로젝트 등록소 접수. 링크는 운영자가 검토한 뒤 사당으로 올라갑니다.
        -- 이메일은 꼭 받고 공개 여부(email_public)는 작성자가 고릅니다. PIN은 scrypt 해시('salt:hash')로만 둡니다.
        -- pending_github · pending_url: 승인된 프로젝트의 링크를 바꾸면 검토 전까지 여기에 둡니다 (NULL = 바꾼 것 없음)
        CREATE TABLE IF NOT EXISTS projects (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          code           TEXT NOT NULL UNIQUE,
          at             INTEGER NOT NULL,
          name           TEXT NOT NULL,
          tagline        TEXT NOT NULL,
          category       TEXT NOT NULL,
          github         TEXT NOT NULL DEFAULT '',
          url            TEXT NOT NULL DEFAULT '',
          email          TEXT NOT NULL,
          email_public   INTEGER NOT NULL DEFAULT 0,
          pin_hash       TEXT NOT NULL,
          nick           TEXT NOT NULL,
          status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
          note           TEXT NOT NULL DEFAULT '',
          slug           TEXT NOT NULL DEFAULT '',
          pending_github TEXT,
          pending_url    TEXT,
          repo_ok        INTEGER NOT NULL DEFAULT 0,
          stars          INTEGER NOT NULL DEFAULT 0
        );

        -- 날짜 · 사당별 '서비스 가보기' 클릭 수
        CREATE TABLE IF NOT EXISTS clicks (
          day  TEXT NOT NULL,
          slug TEXT NOT NULL,
          n    INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (day, slug)
        );

        -- 운영자 화면(admin.ts)에서 한 일. 관리자 IP는 서버 키로 만든 해시로만 남기고 원래 IP는 두지 않습니다.
        CREATE TABLE IF NOT EXISTS admin_log (
          id      INTEGER PRIMARY KEY AUTOINCREMENT,
          at      INTEGER NOT NULL,
          action  TEXT NOT NULL,
          target  TEXT NOT NULL DEFAULT '',
          ip_hash TEXT NOT NULL DEFAULT '',
          detail  TEXT NOT NULL DEFAULT ''
        );
      `)
      // 등록소에서 올라온 사당 (GitHub 저장소 · 이메일 · 어느 접수에서 왔는지)
      addColumn('shrines', 'repo', "TEXT NOT NULL DEFAULT ''")
      addColumn('shrines', 'email', "TEXT NOT NULL DEFAULT ''")
      addColumn('shrines', 'email_public', 'INTEGER NOT NULL DEFAULT 0')
      addColumn('shrines', 'project_id', 'INTEGER NOT NULL DEFAULT 0')
      // 사당 지붕 위에 늘 떠 있는 짧은 소개
      addColumn('shrines', 'sign', "TEXT NOT NULL DEFAULT ''")
      addColumn('projects', 'sign', "TEXT NOT NULL DEFAULT ''")
      // 등록소 이미지 (DATA_DIR/uploads의 파일 이름). 맵에 뜬 뒤 바꾸면 pending_screen에 두고 다시 확인
      addColumn('projects', 'screen', "TEXT NOT NULL DEFAULT ''")
      addColumn('projects', 'pending_screen', 'TEXT')
      // 등록할 때 고른 자리 (NULL이면 아무 데나)
      addColumn('projects', 'want_plot', 'INTEGER')
    },
  },
  {
    // 운영자 차단 · 강퇴 (moderation.ts). 원래 IP는 두지 않고, 서버 키로 만든 IP 키만 차단 기간 동안 둡니다.
    v: 2,
    name: '차단 · 강퇴',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS blocks (
          id     INTEGER PRIMARY KEY AUTOINCREMENT,
          at     INTEGER NOT NULL,
          until  INTEGER NOT NULL,
          kind   TEXT NOT NULL CHECK (kind IN ('kick', 'block')),
          ip_key TEXT NOT NULL DEFAULT '',
          sid    TEXT NOT NULL DEFAULT '',
          nick   TEXT NOT NULL DEFAULT '',
          reason TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS blocks_until ON blocks (until);
      `)
    },
  },
  {
    // 등록소: 맵에 오른 사당의 글자 변경 검토(pending_*), 개인정보 수집 동의 · 검토 시작 · 닫힘 · 파기 시각 (registry.ts · retention.ts)
    v: 3,
    name: '등록소 글자 검토 · 보관 기간',
    up: () => {
      for (const col of ['pending_name', 'pending_tagline', 'pending_sign']) addColumn('projects', col, 'TEXT')
      for (const col of ['consent_at', 'review_at', 'closed_at', 'purged_at']) addColumn('projects', col, 'INTEGER')
    },
  },
  {
    // 채널별 사당: 채널 1~3마다 자리 20칸이 따로 있고, 사당은 자기 채널에서만 보입니다 (world.ts CHANNELS).
    //   shrines.channel: 예전 사당은 모두 1번 채널로. 자리는 (채널, 자리) 짝으로만 겹치지 않으면 됩니다.
    //   예전 표는 plot 칸 자체에 UNIQUE가 붙어 있어(지울 수 없는 자동 색인) 표를 새로 만들어 옮깁니다.
    //   옮길 때 이 목록에 없는 칸이 예전 표에 있으면 그 칸도 그대로 붙여 옮깁니다 (데이터를 버리지 않게).
    //   projects.want_channel: 등록할 때 고른 채널 (NULL = 아무 채널). 자리를 골라 둔 예전 접수는 1번 채널로 봅니다.
    v: 4,
    name: '채널별 사당 자리',
    up: () => {
      db.exec(`
        DROP TABLE IF EXISTS shrines_v4;
        CREATE TABLE shrines_v4 (
          slug              TEXT PRIMARY KEY,
          name              TEXT NOT NULL,
          tagline           TEXT NOT NULL,
          category          TEXT NOT NULL,
          domain            TEXT NOT NULL UNIQUE,
          url               TEXT NOT NULL,
          operator          TEXT NOT NULL,
          keeper            INTEGER NOT NULL DEFAULT 0,
          paid              INTEGER NOT NULL DEFAULT 0,
          verified_domain   TEXT NOT NULL,
          verified_business TEXT,
          joined_at         TEXT NOT NULL,
          status            TEXT NOT NULL CHECK (status IN ('live', 'check')),
          prayer            TEXT NOT NULL,
          charm             TEXT,
          deco              TEXT NOT NULL DEFAULT '[]',
          screens           TEXT NOT NULL DEFAULT '[]',
          captured_at       TEXT NOT NULL,
          channel           INTEGER NOT NULL DEFAULT 1,
          plot              INTEGER NOT NULL,
          repo              TEXT NOT NULL DEFAULT '',
          email             TEXT NOT NULL DEFAULT '',
          email_public      INTEGER NOT NULL DEFAULT 0,
          project_id        INTEGER NOT NULL DEFAULT 0,
          sign              TEXT NOT NULL DEFAULT '',
          UNIQUE (channel, plot)
        );
      `)
      type Col = { name: string; type: string }
      const colsOf = (t: string) => db.prepare(`PRAGMA table_info(${t})`).all() as unknown as Col[]
      const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
      const fresh = new Set(colsOf('shrines_v4').map(c => c.name))
      const old = colsOf('shrines')
      for (const c of old) {
        if (!fresh.has(c.name)) db.exec(`ALTER TABLE shrines_v4 ADD COLUMN ${quote(c.name)} ${c.type || ''}`)
      }
      const names = old.map(c => quote(c.name)).join(', ')
      // 예전 표에는 channel 칸이 없어서 모두 기본값(1번 채널)이 됩니다
      db.exec(`INSERT INTO shrines_v4 (${names}) SELECT ${names} FROM shrines`)
      const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
      const before = count('shrines')
      const after = count('shrines_v4')
      if (before !== after) throw new Error(`옮긴 사당 수가 맞지 않습니다 (${before} → ${after})`)
      db.exec('DROP TABLE shrines; ALTER TABLE shrines_v4 RENAME TO shrines;')
      addColumn('projects', 'want_channel', 'INTEGER')
      db.exec('UPDATE projects SET want_channel = 1 WHERE want_plot IS NOT NULL AND want_channel IS NULL')
    },
  },
]

/** 이 서버가 아는 마지막 DB 구조 번호 */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.v ?? 0

const userVersion = () => Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)

/** 바꾸기 전 사본: DATA_DIR/pre-migrate/shrine-v1-to-v2-<시각>.db (최근 3개만) */
function snapshotBeforeMigrate(from: number, to: number) {
  const dir = join(config.dataDir, 'pre-migrate')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const at = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const file = join(dir, `shrine-v${from}-to-v${to}-${at}.db`)
  db.prepare('VACUUM INTO ?').run(file)
  // 이메일 같은 개인정보가 들어 있어 만든 사용자만 읽게 합니다 (Windows에서는 의미 없음)
  try {
    chmodSync(file, 0o600)
  } catch { /* 권한을 못 바꾸는 파일 시스템 */ }
  const old = readdirSync(dir).filter(f => /^shrine-v\d+-to-v\d+-.+\.db$/.test(f)).sort()
  for (const f of old.slice(0, Math.max(0, old.length - 3))) rmSync(join(dir, f), { force: true })
  console.log(`[shrine] DB 구조를 v${from} → v${to}로 바꾸기 전에 사본을 떴습니다: ${file}`)
}

function migrate() {
  const current = userVersion()
  if (current > SCHEMA_VERSION) {
    throw new Error(`DB 구조 버전(v${current})이 이 서버가 아는 버전(v${SCHEMA_VERSION})보다 높습니다. 더 새 서버가 만든 DB입니다. 서버를 그 버전 이상으로 올리거나 백업에서 되살려 주세요.`)
  }
  const pending = MIGRATIONS.filter(m => m.v > current)
  if (!pending.length) return
  const tables = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as { n: number }).n
  if (tables > 0) snapshotBeforeMigrate(current, SCHEMA_VERSION)
  for (const m of pending) {
    db.exec('BEGIN IMMEDIATE')
    try {
      // 서버와 운영 도구가 동시에 떠도 한 번만 돌게, 잠근 뒤 번호를 다시 봅니다
      if (userVersion() >= m.v) {
        db.exec('COMMIT')
        continue
      }
      m.up()
      db.exec(`PRAGMA user_version = ${m.v}`)
      db.exec('COMMIT')
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch { /* 이미 끝난 트랜잭션 */ }
      throw new Error(`DB 구조 바꾸기 v${m.v}(${m.name})에 실패했습니다: ${(e as Error).message}`)
    }
  }
}

migrate()

let closed = false

/** 끝낼 때: WAL을 db 파일에 모두 옮기고(-wal 비우기) 닫습니다. 두 번 불러도 됩니다 */
export function closeDb() {
  if (closed) return
  closed = true
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch (e) {
    console.error('[shrine] DB 체크포인트 실패 (닫기는 계속합니다):', (e as Error).message)
  }
  db.close()
}

export const dbClosed = () => closed
