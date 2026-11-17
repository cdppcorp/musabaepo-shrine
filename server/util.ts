// 날짜는 모두 한국 시간 기준입니다.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** 한국 시간 기준 YYYY-MM-DD */
export function kstDate(now: Date = new Date()): string {
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10)
}

/** 오늘부터 거꾸로 n일 */
export function kstDaysBack(n: number, now: Date = new Date()): string[] {
  return Array.from({ length: n }, (_, i) => kstDate(new Date(now.getTime() - i * DAY_MS)))
}

/** 이번 주(한국 시간 월요일 0시부터 오늘까지)의 날짜들. 초는 매주 월요일에 새로 셉니다 */
export function kstWeekDays(now: Date = new Date()): string[] {
  const today = new Date(now.getTime() + KST_OFFSET_MS)
  const sinceMonday = (today.getUTCDay() + 6) % 7
  return kstDaysBack(sinceMonday + 1, now)
}

export function daysSince(date: string, now: Date = new Date()): number {
  const from = Date.parse(`${date}T00:00:00+09:00`)
  const to = Date.parse(`${kstDate(now)}T00:00:00+09:00`)
  return Math.round((to - from) / DAY_MS)
}
