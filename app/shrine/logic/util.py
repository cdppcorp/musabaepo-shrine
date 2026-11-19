"""날짜(한국 시간) 도우미: server/util.ts를 옮겼습니다. 시각은 JS처럼 1970-01-01 UTC부터의 ms 정수입니다.

| 함수 | util.ts | 비고 |
|---|---|---|
| ``kst_date`` | 5-8 ``kstDate`` | ``new Date(now + 9h).toISOString().slice(0, 10)``. 10000년 이후는 JS처럼 ``+010000-0`` |
| ``kst_days_back`` | 10-13 ``kstDaysBack`` | 오늘부터 거꾸로 n일 |
| ``kst_week_days`` | 15-20 ``kstWeekDays`` | 이번 주 월요일부터 오늘까지를 오늘부터 거꾸로 (JS와 같은 순서) |
| ``days_since`` | 22-26 ``daysSince`` | ``Date.parse(`${date}T00:00:00+09:00`)``: 월 1~12 · 일 1~31만 받고 2월 30일은 3월 1일로 넘김 (V8). 아니면 NaN |
| ``now_ms`` | ``Date.now()`` | |
| ``KST_OFFSET_MS`` · ``DAY_MS`` | 2-3 | |
"""

from __future__ import annotations

import math
import re
import time

from .jsnum import js_round

__all__ = ["DAY_MS", "KST_OFFSET_MS", "days_since", "kst_date", "kst_days_back", "kst_week_days", "now_ms"]

KST_OFFSET_MS = 9 * 60 * 60 * 1000
DAY_MS = 24 * 60 * 60 * 1000
_MAX_TIME = 8.64e15


def now_ms() -> int:
    """JS ``Date.now()``."""
    return time.time_ns() // 1_000_000


def _days_from_civil(y: int, m: int, d: int) -> int:
    y -= m <= 2
    era = y // 400  # 파이썬 // 는 내림이라 음수 보정이 필요 없음
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def _civil_from_days(z: int) -> tuple[int, int, int]:
    z += 719468
    era = z // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    m = mp + (3 if mp < 10 else -9)
    return y + (m <= 2), m, d


def _iso_date(ms: int) -> str:
    """``new Date(ms).toISOString().slice(0, 10)``."""
    if isinstance(ms, float):
        if math.isnan(ms):
            raise ValueError("Invalid time value")
        ms = int(ms)  # TimeClip: 0 쪽으로 자름
    if not (-_MAX_TIME <= ms <= _MAX_TIME):
        raise ValueError("Invalid time value")  # JS RangeError
    y, m, d = _civil_from_days(ms // DAY_MS)
    if 0 <= y <= 9999:
        year = f"{y:04d}"
    else:
        year = ("+" if y > 0 else "-") + f"{abs(y):06d}"
    return f"{year}-{m:02d}-{d:02d}"[:10]


def kst_date(now: int | None = None) -> str:
    """util.ts ``kstDate``: 한국 시간 기준 YYYY-MM-DD."""
    if now is None:
        now = now_ms()
    return _iso_date(now + KST_OFFSET_MS)


def kst_days_back(n: int, now: int | None = None) -> list[str]:
    """util.ts ``kstDaysBack``: 오늘부터 거꾸로 n일."""
    if now is None:
        now = now_ms()
    return [kst_date(now - i * DAY_MS) for i in range(n)]


def kst_week_days(now: int | None = None) -> list[str]:
    """util.ts ``kstWeekDays``: 이번 주(한국 시간 월요일 0시부터 오늘까지)의 날짜, 오늘부터 거꾸로."""
    if now is None:
        now = now_ms()
    days = (now + KST_OFFSET_MS) // DAY_MS
    utc_day = (days + 4) % 7  # 1970-01-01은 목요일(4)
    since_monday = (utc_day + 6) % 7
    return kst_days_back(since_monday + 1, now)


_DATE = re.compile(r"([+-][0-9]{6}|[0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?")


def _parse_kst_midnight(date: str) -> float:
    """``Date.parse(`${date}T00:00:00+09:00`)``: ES 날짜 형식(``YYYY`` · ``YYYY-MM`` · ``YYYY-MM-DD``, 확장 연도 ``±YYYYYY``)만.

    V8처럼 월 1~12 · 일 1~31만 보고(2월 30일은 3월 1일로 넘김), ``-000000``과 ±8.64e15 ms 밖은 NaN.
    그 밖의 모양은 NaN으로 봅니다 (V8 옛 파서가 받는 모양은 뒤에 ``T…``가 붙어 이 서버 입력에서는 나오지 않음).
    """
    m = _DATE.fullmatch(date) if isinstance(date, str) else None
    if not m or m.group(1) == "-000000":
        return math.nan
    y = int(m.group(1))
    mo = int(m.group(2) or 1)
    d = int(m.group(3) or 1)
    if not (1 <= mo <= 12 and 1 <= d <= 31):
        return math.nan
    days = _days_from_civil(y, mo, 1) + d - 1
    t = days * DAY_MS - KST_OFFSET_MS
    return math.nan if abs(t) > _MAX_TIME else t


def days_since(date: str, now: int | None = None) -> float:
    """util.ts ``daysSince``: 그 날짜(한국 시간 0시)부터 오늘까지 며칠. 날짜가 틀리면 NaN (JS처럼 비교가 모두 거짓)."""
    if now is None:
        now = now_ms()
    frm = _parse_kst_midnight(date)
    to = _parse_kst_midnight(kst_date(now))
    if math.isnan(frm) or math.isnan(to):
        return math.nan
    v = js_round((to - frm) / DAY_MS)
    return int(v)
