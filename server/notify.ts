// 운영자 알림. NOTIFY_WEBHOOK_URL(슬랙 · 디스코드 웹훅)로 짧은 글을 보내고 기다리지 않습니다.
// - 값이 비어 있으면 아무것도 하지 않습니다.
// - 3초 안에 답이 없으면 끊고, 실패는 로그 한 줄만 남깁니다. 절대 throw하지 않습니다.
// - 분당 상한을 넘으면 버리고, 다음 알림에 버린 개수를 붙입니다.
// - 이메일 · PIN · 입장 표 같은 개인정보는 넣지 않습니다. 이름에 그런 말이 들어간 칸은 빼고,
//   값에 메일 주소처럼 생긴 글자가 있으면 가립니다.

const TIMEOUT_MS = 3_000
const PER_MINUTE = 20
const MAX_TEXT = 1_800
const MAX_VALUE = 200
const PRIVATE_KEY = /^(ip|sid|pin)(_?key|_?hash)?$|e-?mail|pass|secret|token|ticket|cookie|hash/i
const EMAIL_LIKE = /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/g

let windowStart = 0
let sentInWindow = 0
let dropped = 0

function webhookUrl(): URL | null {
  const raw = (process.env.NOTIFY_WEBHOOK_URL ?? '').trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null
  } catch {
    return null
  }
}

/** 웹훅이 멘션 · 링크로 해석하지 않게 다듬습니다 (@everyone, <!channel> 등) */
function clean(value: string, max: number): string {
  const s = value
    .replace(EMAIL_LIKE, '[메일 가림]')
    .replace(/@/g, '@​')
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function buildText(event: string, fields: Record<string, string | number>, skipped: number): string {
  const lines = [`[무사배포 기원소] ${clean(event, 60)}`]
  for (const [key, raw] of Object.entries(fields)) {
    if (PRIVATE_KEY.test(key)) continue
    const value = typeof raw === 'number' ? String(raw) : clean(String(raw ?? ''), MAX_VALUE)
    lines.push(`• ${clean(key, 40)}: ${value}`)
  }
  if (skipped > 0) lines.push(`(앞서 알림 ${skipped}건을 상한 때문에 건너뜀)`)
  const text = lines.join('\n')
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text
}

/**
 * 운영자에게 알립니다. 기다리지 않고, 실패해도 throw하지 않습니다.
 * fields에는 번호 · 이름 · 링크처럼 공개해도 되는 값만 넣으세요.
 */
export function notify(event: string, fields: Record<string, string | number>): void {
  try {
    const url = webhookUrl()
    if (!url) return
    const now = Date.now()
    if (now - windowStart >= 60_000) {
      windowStart = now
      sentInWindow = 0
    }
    if (sentInWindow >= PER_MINUTE) {
      dropped++
      return
    }
    sentInWindow++
    const text = buildText(event, fields, dropped)
    dropped = 0
    // 슬랙은 text, 디스코드는 content를 읽습니다. 둘 다 모르는 칸은 무시합니다.
    const body = JSON.stringify({ text, content: text })
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
      .then(res => {
        res.body?.cancel().catch(() => {})
        if (!res.ok) console.warn(`[shrine] 알림 실패: HTTP ${res.status}`)
      })
      .catch(err => {
        console.warn(`[shrine] 알림 실패: ${err instanceof Error ? err.name : 'error'}`)
      })
  } catch {
    // 알림 때문에 요청 처리가 실패하면 안 됩니다
  }
}
