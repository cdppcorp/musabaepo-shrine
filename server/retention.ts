// 개인정보 보관 기간 (개인정보처리방침과 같은 숫자).
//   · 검토를 90일(PENDING_DAYS) 동안 처리하지 못하면 저절로 끝냅니다.
//       새 접수 → 반려(note 'expired'). 맵에 있는 사당의 변경 요청 → 바꾸려던 것만 버리고 사당은 그대로.
//   · 반려되거나 작성자가 내린 접수는 30일(RETENTION_DAYS) 뒤 이메일 · 관리 비밀번호 해시 · 링크 · 이름 · 올린 이미지를 파기합니다.
//     번호 · 시각 · 분류 · 상태 같은 개인정보가 아닌 기록만 남깁니다.
//   · 게시판 글은 7일, 신고 기록은 글과 함께 지웁니다.
//   · 작성자가 요청하면 운영자가 바로 파기할 수 있습니다: destroyProjectNow(접수 번호).
// 시작할 때 한 번, 그다음 하루에 한 번 돕니다 (startRetention). 시험할 때만 RETENTION_DAYS · PENDING_DAYS를 줄입니다 (0이면 바로).
import { prunePosts } from './ai.ts'
import { notify } from './notify.ts'
import { closedBefore, eraseProject, expireStaleReviews, purgeProject } from './registry.ts'
import { removeUploads } from './uploads.ts'

const DAY_MS = 24 * 3600_000
const RUN_EVERY_MS = DAY_MS

/** 0 이상의 일 수 (소수 가능). 비우면 기본값 */
function days(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name}는 0 이상의 숫자(일)여야 합니다`)
  return n
}

/** 반려 · 내린 뒤 파기까지 (일) */
export const RETENTION_DAYS = days('RETENTION_DAYS', 30)
/** 처리하지 못한 검토를 끝내기까지 (일) */
export const PENDING_DAYS = days('PENDING_DAYS', 90)

export interface RetentionResult {
  /** 기한이 지나 반려한 접수 · 버린 변경 요청 */
  expired: number
  expiredChanges: number
  /** 개인정보를 파기한 접수 */
  purged: number
  /** 지운 이미지 파일 */
  images: number
  /** 지운 게시판 글 · 신고 기록 */
  posts: number
  reports: number
}

/** 한 번 돌리기. 무엇을 얼마나 했는지 돌려줍니다 (개인정보는 담지 않습니다) */
export function runRetention(now = Date.now()): RetentionResult {
  const stale = expireStaleReviews(now - PENDING_DAYS * DAY_MS, now)
  let purged = 0
  let images = 0
  for (const id of closedBefore(now - RETENTION_DAYS * DAY_MS, now)) {
    const files = purgeProject(id, now)
    if (!files) continue
    purged++
    images += removeUploads(files)
  }
  const p = prunePosts(now)
  const result = {
    expired: stale.registrations, expiredChanges: stale.changes, purged, images, posts: p.posts, reports: p.reports,
  }
  if (stale.registrations || stale.changes || purged) {
    console.log(`[shrine] 보관 기간 정리: 기한 지난 접수 ${stale.registrations} · 변경 요청 ${stale.changes}, 파기 ${purged}건 (이미지 ${images})`)
  }
  if (stale.registrations || stale.changes) {
    notify(`검토 기한(${PENDING_DAYS}일)이 지나 저절로 끝냄`, { 접수: stale.registrations, '변경 요청': stale.changes })
  }
  return result
}

/**
 * 작성자 요청으로 바로 파기 (운영자 화면 · 운영 도구에서). 맵에 있으면 사당도 뺍니다.
 * 없는 접수면 ok: false.
 */
export function destroyProjectNow(id: number): { ok: boolean; images: number; message: string } {
  if (!Number.isInteger(id) || id <= 0) return { ok: false, images: 0, message: `없는 접수입니다: ${id}` }
  const files = eraseProject(id)
  if (!files) return { ok: false, images: 0, message: `없는 접수입니다: ${id}` }
  const images = removeUploads(files)
  return { ok: true, images, message: `접수 #${id}의 개인정보를 파기했습니다 (이미지 ${images}개)` }
}

let timer: ReturnType<typeof setInterval> | null = null

function safeRun() {
  try {
    runRetention()
  } catch (e) {
    console.error('[shrine] 보관 기간 정리 실패:', (e as Error).message)
  }
}

/** 시작할 때 한 번, 그다음 하루마다. 여러 번 불러도 한 번만 겁니다 */
export function startRetention() {
  if (timer) return
  safeRun()
  timer = setInterval(safeRun, RUN_EVERY_MS)
  timer.unref()
}
