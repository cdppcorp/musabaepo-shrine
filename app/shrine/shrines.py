"""사당 데이터 층 (server/shrines.ts의 DB 쪽): 맵에 띄울 사당 · 채널별 자리 · 사당 넣기 · 초 · 클릭.

입점 규칙 · 링크 검사 · 행 → 사당 바꾸기 · 화면으로 보내는 모양은 logic/links.py에 있고(Node와 차분 시험으로 맞춤),
여기서는 그것을 DB와 캐시에 잇습니다. 사당은 TS ``Shrine``과 같은 camelCase 키의 dict입니다 (links.from_row).

| 함수 | shrines.ts | 메모 |
|---|---|---|
| ``all_shrines`` | ``allShrines`` | 검증을 통과한 사당만, ``ORDER BY channel, plot``. 30초 캐시 (CLI가 바꾼 것도 30초 안에 반영) |
| ``find_shrine`` · ``shrines_in`` | ``findShrine`` · ``shrinesIn`` | 캐시에서 |
| ``clear_shrine_cache`` | ``clearShrineCache`` | 사당 표를 바꾼 뒤. 트랜잭션 안이면 ``invalidate_after_commit``도 |
| ``public_shrine`` · ``public_shrines`` | ``publicShrine`` | 키 순서까지 Node와 같음 (url · paid 빼고, email은 공개일 때만) |
| ``taken_plots`` · ``plot_taken`` · ``free_plots_in`` · ``free_plots_by_channel`` | 같은 이름 | 캐시 없이 DB에서 (숨긴 사당의 자리도 찬 것으로) |
| ``insert_shrine`` | ``insertShrine`` | 규칙 검사 → ``ShrineRuleError``. UNIQUE 위반은 ``sqlalchemy.exc.IntegrityError`` |
| ``add_candle`` · ``candle_summary`` | ``addCandle`` · ``candleSummary`` | 요약은 15초 캐시, 초를 켜면 비움 |
| ``add_click`` | ``addClick`` | ``/go`` (입장 표가 있을 때만 셈) |
| ``count_shrines`` · ``install`` | (main.ts · /healthz) | ``ctx.count_shrines``를 이 캐시의 개수로, 시작할 때 캐시 채우기 |

부르는 쪽 (``target``):
  · 읽기 캐시(``all_shrines`` 등)는 ``ctx``(AppContext) 또는 ``Database``를 받습니다. 캐시는 Database마다 따로입니다.
  · DB를 바로 보는 함수(``plot_taken`` · ``insert_shrine`` · ``add_click`` …)는 ``ctx`` · ``Database`` ·
    ``AsyncSession`` · ``AsyncConnection``을 받습니다. 세션 · 연결을 주면 그 트랜잭션 안에서 돌고(커밋은 부르는 쪽),
    ctx · Database를 주면 문장 하나를 자기 트랜잭션으로 돌립니다.

Node는 DB 호출이 동기라 '자리 확인 → 넣기' 사이에 다른 요청이 끼지 않았습니다. 여기서는 같은 자리를 두 요청이 동시에
고를 수 있으므로, 넣기는 UNIQUE(channel, plot) · UNIQUE(domain) · PK(slug) 제약이 막고 부르는 쪽이 IntegrityError를
받아 다시 고르거나 409로 답합니다 (PostgreSQL은 오류가 난 트랜잭션을 더 쓸 수 없으니 재시도는 SAVEPOINT
``session.begin_nested()`` 안에서).
"""

from __future__ import annotations

import asyncio
import logging
import time
import weakref
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from sqlalchemy import bindparam, event, text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession

from .db.engine import Database
from .logic.jsnum import is_integer, json_stringify
from .logic.links import free_plots, from_row, is_prayer_key, public_shrine, validate_shrine
from .logic.util import kst_date, kst_week_days, now_ms
from .logic.world import CHANNELS

if TYPE_CHECKING:
    from .context import AppContext

__all__ = [
    "SHRINE_CACHE_S", "SUMMARY_CACHE_S", "ShrineRuleError", "add_candle", "add_click", "all_shrines", "candle_summary",
    "clear_shrine_cache", "count_shrines", "find_shrine", "free_plots_by_channel", "free_plots_in", "insert_shrine",
    "install", "invalidate_after_commit", "plot_taken", "public_shrine", "public_shrines", "shrines_in", "taken_plots",
]  # fmt: skip

log = logging.getLogger("shrine.shrines")

Shrine = dict[str, Any]

#: 운영 도구(cli)로 바꾼 내용도 서버를 다시 띄우지 않고 30초 안에 맵에 반영되게 (shrines.ts SHRINE_CACHE_MS)
SHRINE_CACHE_S = 30.0
#: 초 요약 캐시 (shrines.ts candleSummary 15_000)
SUMMARY_CACHE_S = 15.0


class ShrineRuleError(ValueError):
    """입점 규칙(validate_shrine)에 맞지 않는 사당. ``errors``에 까닭 목록 (Node 메시지와 같은 글자)."""

    def __init__(self, errors: list[str]) -> None:
        self.errors = errors
        super().__init__(f"입점 규칙에 맞지 않습니다: {' / '.join(errors)}")


# ── 부르는 쪽 정리 ──────────────────────────────────────────────────


def _database(target: Any) -> Database:
    db = target if isinstance(target, Database) else getattr(target, "db", None)
    if not isinstance(db, Database):
        raise TypeError(f"ctx 또는 Database가 필요합니다: {type(target).__name__}")
    return db


async def _rows(target: Any, sql: Any, params: Mapping[str, Any] | None = None) -> list[Mapping[str, Any]]:
    if isinstance(target, (AsyncSession, AsyncConnection)):
        return list((await target.execute(sql, dict(params or {}))).mappings().all())
    async with _database(target).engine.connect() as conn:
        return list((await conn.execute(sql, dict(params or {}))).mappings().all())


async def _write(target: Any, sql: Any, params: Mapping[str, Any]) -> None:
    if isinstance(target, (AsyncSession, AsyncConnection)):
        await target.execute(sql, dict(params))
        return
    async with _database(target).engine.begin() as conn:
        await conn.execute(sql, dict(params))


# ── 캐시 (Database마다) ──────────────────────────────────────────────


class _State:
    def __init__(self) -> None:
        self.shrines: list[Shrine] | None = None
        self.shrines_at = 0.0
        #: 비울 때마다 늘림: 비우기 전에 읽기 시작한 결과는 캐시에 넣지 않습니다
        self.shrines_gen = 0
        self.lock = asyncio.Lock()
        #: 숨긴 까닭을 한 번만 로그에 (shrines.ts warned)
        self.warned: set[str] = set()
        self.summary: tuple[float, dict[str, Any]] | None = None
        self.summary_gen = 0


_states: weakref.WeakKeyDictionary[Database, _State] = weakref.WeakKeyDictionary()


def _state(db: Database) -> _State:
    st = _states.get(db)
    if st is None:
        st = _states[db] = _State()
    return st


SELECT_ALL = text("SELECT * FROM shrines ORDER BY channel, plot")


async def all_shrines(target: AppContext | Database) -> list[Shrine]:
    """규칙을 통과한 사당만 (채널 · 자리 순). 어긋난 사당은 로그에 까닭을 한 번 남기고 맵에서 뺍니다.

    돌려주는 목록은 캐시와 같은 객체입니다. 고치지 말고 읽기만 하세요.
    """
    db = _database(target)
    st = _state(db)
    if st.shrines is not None and time.monotonic() - st.shrines_at < SHRINE_CACHE_S:
        return st.shrines
    async with st.lock:
        if st.shrines is not None and time.monotonic() - st.shrines_at < SHRINE_CACHE_S:
            return st.shrines
        gen = st.shrines_gen
        rows = await _rows(db, SELECT_ALL)
        out: list[Shrine] = []
        for row in rows:
            s = from_row(dict(row))
            errors = validate_shrine(s)
            if errors:
                why = f"{s['slug']}: {' / '.join(errors)}"
                if why not in st.warned:
                    st.warned.add(why)
                    log.warning("[shrine] '%s' 사당을 숨겼습니다: %s", s["slug"], " / ".join(errors))
                continue
            out.append(s)
        if gen == st.shrines_gen:
            st.shrines = out
            st.shrines_at = time.monotonic()
        return out


async def find_shrine(target: AppContext | Database, slug: str) -> Shrine | None:
    for s in await all_shrines(target):
        if s["slug"] == slug:
            return s
    return None


async def shrines_in(target: AppContext | Database, channel: int) -> list[Shrine]:
    """그 채널(1~3)에 서 있는 사당만."""
    return [s for s in await all_shrines(target) if s["channel"] == channel]


def clear_shrine_cache(target: AppContext | Database | None = None) -> None:
    """사당 캐시를 비웁니다 (target이 없으면 모든 DB의 캐시). 동기 함수입니다."""
    states = list(_states.values()) if target is None else [_state(_database(target))]
    for st in states:
        st.shrines = None
        st.shrines_gen += 1


def invalidate_after_commit(session: AsyncSession, target: AppContext | Database | None = None) -> None:
    """이 세션의 트랜잭션이 커밋되면 사당 캐시를 비웁니다 (지금도 한 번 비움).

    트랜잭션 안에서 사당 표를 바꾼 뒤 부릅니다. 커밋 전에 비우기만 하면 다른 요청이 커밋 전 내용으로 캐시를
    다시 채워 30초 동안 옛 목록이 보일 수 있습니다.
    """
    clear_shrine_cache(target)
    event.listen(session.sync_session, "after_commit", lambda _s: clear_shrine_cache(target), once=True)


async def public_shrines(target: AppContext | Database, now: int | None = None) -> list[dict[str, Any]]:
    """/api/world의 shrines (publicShrine 목록)."""
    return [public_shrine(s, now) for s in await all_shrines(target)]


async def count_shrines(ctx: AppContext) -> int:
    """/healthz의 shrines: allShrines().length."""
    return len(await all_shrines(ctx))


def install(ctx: AppContext) -> None:
    """``ctx.count_shrines``를 이 캐시로 바꾸고, 시작할 때 캐시를 한 번 채웁니다 (main.ts: 시작할 때 allShrines())."""
    ctx.count_shrines = count_shrines

    @ctx.on_startup
    async def warm_shrine_cache(ctx: AppContext) -> None:
        await all_shrines(ctx)


# ── 채널별 자리 (캐시 없이 DB) ───────────────────────────────────────


async def taken_plots(target: Any, channel: int) -> set[int]:
    """그 채널에 사당이 서 있는 자리 번호들 (규칙에 어긋나 맵에서 숨긴 사당의 자리도 찬 것으로)."""
    rows = await _rows(target, text("SELECT plot FROM shrines WHERE channel = :channel"), {"channel": channel})
    return {r["plot"] for r in rows}


async def plot_taken(target: Any, channel: int, plot: int) -> bool:
    rows = await _rows(
        target, text("SELECT 1 AS x FROM shrines WHERE channel = :channel AND plot = :plot"), {"channel": channel, "plot": plot}
    )
    return bool(rows)


async def free_plots_in(target: Any, channel: int) -> list[int]:
    """그 채널의 빈 자리 번호 (작은 번호부터)."""
    return free_plots(await taken_plots(target, channel))


async def free_plots_by_channel(target: Any) -> dict[int, list[int]]:
    """채널 번호 → 빈 자리 번호들 (1~3번 모두). JSON으로 내면 키는 "1" · "2" · "3"."""
    return {ch: await free_plots_in(target, ch) for ch in range(1, CHANNELS + 1)}


# ── 사당 넣기 ────────────────────────────────────────────────────────

INSERT_SHRINE = text(
    """INSERT INTO shrines (slug, name, tagline, category, domain, url, operator, keeper, paid, verified_domain,
         verified_business, joined_at, status, prayer, charm, deco, screens, captured_at, channel, plot, repo, email,
         email_public, project_id, sign)
       VALUES (:slug, :name, :tagline, :category, :domain, :url, :operator, :keeper, :paid, :verified_domain,
         :verified_business, :joined_at, :status, :prayer, :charm, :deco, :screens, :captured_at, :channel, :plot, :repo,
         :email, :email_public, :project_id, :sign)"""
)


def _truthy(v: Any) -> bool:
    """JS 참 거짓 (``s.keeper ? 1 : 0``): false · 0 · NaN · '' · null · undefined만 거짓, 빈 배열은 참."""
    if v is None or v is False or v == "":
        return False
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v == v and v != 0
    return True


def _int(v: Any) -> Any:
    """INTEGER 칸: 1.0처럼 소수부 없는 실수는 정수로 (SQLite INTEGER 친화성과 같음)."""
    return int(v) if is_integer(v) else v


def shrine_params(s: Mapping[str, Any]) -> dict[str, Any]:
    """insertShrine이 묶는 값 (deco · screens는 JSON 글자, 참 거짓은 0/1)."""
    return {
        "slug": s["slug"], "name": s["name"], "tagline": s["tagline"], "category": s["category"], "domain": s["domain"],
        "url": s["url"], "operator": s["operator"], "keeper": 1 if _truthy(s.get("keeper")) else 0,
        "paid": 1 if _truthy(s.get("paid")) else 0, "verified_domain": s["verifiedDomain"],
        "verified_business": s.get("verifiedBusiness"), "joined_at": s["joinedAt"], "status": s["status"],
        "prayer": s["prayer"], "charm": s.get("charm"), "deco": json_stringify(s["deco"]),
        "screens": json_stringify(s["screens"]), "captured_at": s["capturedAt"], "channel": _int(s["channel"]),
        "plot": _int(s["plot"]), "repo": s["repo"], "email": s["email"],
        "email_public": 1 if _truthy(s.get("emailPublic")) else 0, "project_id": _int(s["projectId"]),
        "sign": "" if s.get("sign") is None else s["sign"],
    }  # fmt: skip


async def insert_shrine(target: Any, s: Mapping[str, Any]) -> None:
    """shrines.ts insertShrine: 규칙 검사(어긋나면 ShrineRuleError) 뒤 넣고 사당 캐시를 비웁니다.

    세션을 주면 그 트랜잭션 안에서 넣고 커밋 뒤에 캐시를 다시 비우도록 겁니다 (invalidate_after_commit).
    같은 slug · 도메인 · (채널, 자리)가 있으면 IntegrityError가 그대로 올라갑니다.
    """
    errors = validate_shrine(s)
    if errors:
        raise ShrineRuleError(errors)
    await _write(target, INSERT_SHRINE, shrine_params(s))
    db = _database(target) if not isinstance(target, (AsyncSession, AsyncConnection)) else None
    if isinstance(target, AsyncSession):
        invalidate_after_commit(target, None)
    else:
        clear_shrine_cache(db)


# ── 초 · 클릭 ────────────────────────────────────────────────────────

ADD_CANDLE = text(
    """INSERT INTO candles (day, slug, prayer, n) VALUES (:day, :slug, :prayer, 1)
       ON CONFLICT (day, slug, prayer) DO UPDATE SET n = candles.n + 1"""
)
# SQLite의 GROUP BY는 slug(BINARY) 순으로 내므로 같은 순서를 바이트 순 정렬(COLLATE "C")로 적어 둡니다.
# 결과가 JS 객체 키 순서(= JSON 글자 순서)가 됩니다 (숫자 모양 slug는 json_stringify가 JS처럼 앞으로 보냄)
WEEK_SUMS = text(
    'SELECT slug, SUM(n) AS n FROM candles WHERE day IN :days GROUP BY slug ORDER BY slug COLLATE "C"'
).bindparams(bindparam("days", expanding=True))
TODAY_SUM = text("SELECT COALESCE(SUM(n), 0) AS n FROM candles WHERE day = :day")
ADD_CLICK = text(
    """INSERT INTO clicks (day, slug, n) VALUES (:day, :slug, 1)
       ON CONFLICT (day, slug) DO UPDATE SET n = clicks.n + 1"""
)


async def add_candle(target: Any, slug: str, prayer: str, *, db: AppContext | Database | None = None) -> None:
    """오늘(KST) 그 사당 · 기원의 초 하나. 초 요약 캐시를 비웁니다 (세션을 주면 ``db``로 어느 캐시인지 알려 주세요)."""
    if not is_prayer_key(prayer):
        raise ValueError(f"기원 키가 아닙니다: {prayer!r}")
    await _write(target, ADD_CANDLE, {"day": kst_date(), "slug": slug, "prayer": prayer})
    owner = db if db is not None else (None if isinstance(target, (AsyncSession, AsyncConnection)) else target)
    states = list(_states.values()) if owner is None else [_state(_database(owner))]
    for st in states:
        st.summary = None
        st.summary_gen += 1


async def candle_summary(target: AppContext | Database) -> dict[str, Any]:
    """{week: {slug: n}, weekTotal, today}: 이번 주(KST 월요일부터) 사당별 합 · 이번 주 전체 · 오늘 전체 (15초 캐시)."""
    db = _database(target)
    st = _state(db)
    if st.summary is not None and time.monotonic() - st.summary[0] < SUMMARY_CACHE_S:
        return st.summary[1]
    gen = st.summary_gen
    now = now_ms()
    rows = await _rows(db, WEEK_SUMS, {"days": kst_week_days(now)})
    today = await _rows(db, TODAY_SUM, {"day": kst_date(now)})
    week = {r["slug"]: int(r["n"]) for r in rows}
    value = {"week": week, "weekTotal": sum(week.values()), "today": int(today[0]["n"])}
    if gen == st.summary_gen:
        st.summary = (time.monotonic(), value)
    return value


async def add_click(target: Any, slug: str) -> None:
    """서비스 가보기 클릭 하나 (오늘 KST)."""
    await _write(target, ADD_CLICK, {"day": kst_date(), "slug": slug})
