// AI 트렌드 게시판 (AI 신당 기도는 기록하지 않아 여기 없습니다 — realtime.ts에서 연출만 알림).
//   게시판: 80자 짧은 글을 7일 동안 보여 주고 지웁니다. 서로 다른 3명이 신고하면 숨깁니다.
//   글에는 자동 닉네임만 남기고 IP 같은 정보는 저장하지 않습니다.
//   신고한 사람은 "그날만 쓰는 IP 해시 + 글 번호"를 한 번 더 해시한 값으로만 구분해서, 글끼리 묶어 볼 수 없습니다.
//   신고 기록은 글과 함께 지웁니다 (글은 최대 7일).
import { createHash } from 'node:crypto'
import { db } from './db.ts'
import { notify } from './notify.ts'
import { kstDate } from './util.ts'
import { AIS } from './world.ts'

export const POST_MAX = 80
export const POST_KEEP_DAYS = 7
export const REPORT_HIDE = 3
/** 글 주제: AI 다섯 + 기타 */
export const POST_TOPICS = [...AIS.map(a => a.key), 'etc'] as const
export const isPostTopic = (v: unknown): v is string => typeof v === 'string' && (POST_TOPICS as readonly string[]).includes(v)

export interface Post { id: number; at: number; topic: string; text: string; nick: string }

const KEEP_MS = POST_KEEP_DAYS * 24 * 3600_000

/** 7일 지난 글과 그 신고 기록(그리고 글이 없어진 신고 기록)을 지웁니다. 지운 글 · 신고 수 */
export function prunePosts(now = Date.now()): { posts: number; reports: number } {
  const posts = db.prepare('DELETE FROM posts WHERE at < ?').run(now - KEEP_MS).changes
  const reports = db.prepare('DELETE FROM post_reports WHERE post_id NOT IN (SELECT id FROM posts)').run().changes
  return { posts: Number(posts), reports: Number(reports) }
}

export function addPost(topic: string, text: string, nick: string): Post {
  const at = Date.now()
  prunePosts(at)
  const r = db.prepare('INSERT INTO posts (at, topic, text, nick) VALUES (?, ?, ?, ?)').run(at, topic, text, nick)
  return { id: Number(r.lastInsertRowid), at, topic, text, nick }
}

/** 보이는 글 (최근 7일, 숨기지 않은 것), 새 글부터 */
export function listPosts(limit = 60): Post[] {
  return db.prepare(`SELECT id, at, topic, text, nick FROM posts WHERE hidden = 0 AND at >= ?
                     ORDER BY at DESC LIMIT ?`).all(Date.now() - KEEP_MS, limit) as unknown as Post[]
}

/** 신고. 서로 다른 사람이 REPORT_HIDE번 신고하면 숨깁니다 */
export function reportPost(id: number, reporter: string): 'none' | 'ok' | 'hidden' {
  const row = db.prepare('SELECT hidden, topic FROM posts WHERE id = ?').get(id) as { hidden: number; topic: string } | undefined
  if (!row) return 'none'
  const key = createHash('sha256').update(`post-report:${id}:${reporter}`).digest('base64url').slice(0, 22)
  const added = db.prepare('INSERT OR IGNORE INTO post_reports (post_id, reporter) VALUES (?, ?)').run(id, key).changes > 0
  const n = (db.prepare('SELECT COUNT(*) AS n FROM post_reports WHERE post_id = ?').get(id) as { n: number }).n
  if (!row.hidden && n >= REPORT_HIDE) {
    db.prepare('UPDATE posts SET hidden = 1 WHERE id = ?').run(id)
    notify('게시판 글을 신고로 숨김', { 글: id, 주제: row.topic, 신고: n })
    return 'hidden'
  }
  // 운영자에게는 첫 신고 때 한 번 (글 내용은 알림에 넣지 않습니다)
  if (added && n === 1) notify('게시판 글 신고', { 글: id, 주제: row.topic, 신고: n })
  return 'ok'
}

/* ── 운영 도구용 ── */

export function allPostsForAdmin(limit = 100) {
  return db.prepare(`SELECT p.id, p.at, p.topic, p.text, p.nick, p.hidden,
                       (SELECT COUNT(*) FROM post_reports r WHERE r.post_id = p.id) AS reports
                     FROM posts p ORDER BY p.at DESC LIMIT ?`).all(limit) as unknown as (Post & { hidden: number; reports: number })[]
}

/** 운영자 화면: 신고된 글 먼저, 그다음 새 글부터 (숨긴 글 포함) */
export function postsForReview(limit = 200) {
  return db.prepare(`SELECT p.id, p.at, p.topic, p.text, p.nick, p.hidden,
                       (SELECT COUNT(*) FROM post_reports r WHERE r.post_id = p.id) AS reports
                     FROM posts p ORDER BY (reports > 0) DESC, p.at DESC LIMIT ?`).all(limit) as unknown as (Post & { hidden: number; reports: number })[]
}

/** 운영자 화면 요약: 신고가 하나라도 있는 글 · 숨긴 글 · 보관 중인 글 */
export function postCounts() {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n
  return {
    reported: n('SELECT COUNT(DISTINCT post_id) AS n FROM post_reports r JOIN posts p ON p.id = r.post_id'),
    hidden: n('SELECT COUNT(*) AS n FROM posts WHERE hidden = 1'),
    total: n('SELECT COUNT(*) AS n FROM posts'),
  }
}

export const findPost = (id: number) =>
  db.prepare('SELECT id, at, topic, text, nick, hidden FROM posts WHERE id = ?').get(id) as (Post & { hidden: number }) | undefined

export function setPostHidden(id: number, hidden: boolean): boolean {
  return db.prepare('UPDATE posts SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id).changes > 0
}

export function deletePost(id: number): boolean {
  db.prepare('DELETE FROM post_reports WHERE post_id = ?').run(id)
  return db.prepare('DELETE FROM posts WHERE id = ?').run(id).changes > 0
}
