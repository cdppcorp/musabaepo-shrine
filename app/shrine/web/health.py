"""GET/HEAD /healthz (http.ts 343-370). 요청 제한보다 먼저 돕니다.

보안 점검: 요청 제한 앞이라 누구나 마구 부를 수 있으므로, 확인 결과(상태 · 본문)를 2초 동안 다시 씁니다
(그 사이 요청은 DB · Redis를 두드리지 않음. 동시에 몰리면 한 번만 확인하고 나머지는 그 결과를 기다림).
응답의 Cache-Control: no-store는 그대로입니다 (브라우저 · 프록시 캐시가 아니라 서버 안에서만).

본문 모양은 Node와 같습니다: {ok, db, uptime, shrines, uploads:{usedPct, lowDisk, writable}}
  · DB(SELECT 1)가 답하지 않으면 db:'fail', shrines:null, 503.
  · Redis가 답하지 않아도 503입니다 (칸은 늘리지 않음: Node와 모양을 같게 두고 ok만 false).
    요청 제한 · 잠금 · 신고가 Redis에 있어서 그 상태로는 제대로 돌지 않기 때문입니다.
  · 업로드 폴더 상태는 참고로만 (다시 띄워도 낫지 않으므로 503으로 만들지 않음).
"""

from __future__ import annotations

import asyncio
import logging
import time

from starlette.requests import Request

from ..context import AppContext
from ..jscompat import js_json, js_round
from .responses import NodeResponse

log = logging.getLogger("shrine.health")

CHECK_TIMEOUT_S = 3.0
#: 확인 결과를 다시 쓰는 시간 (초)
CACHE_S = 2.0


async def redis_ok(ctx: AppContext) -> bool:
    if ctx.redis is None:
        return False
    try:
        return bool(await asyncio.wait_for(ctx.redis.ping(), CHECK_TIMEOUT_S))
    except Exception:
        return False


def _response(ok: bool, body: bytes) -> NodeResponse:
    return NodeResponse(
        200 if ok else 503,
        [("Content-Type", "application/json; charset=utf-8"), ("Cache-Control", "no-store"), ("X-Robots-Tag", "noindex")],
        body,
    )


def _fresh(ctx: AppContext) -> tuple[bool, bytes] | None:
    cached = getattr(ctx, "_health_cache", None)
    if cached is not None and time.monotonic() - cached[0] < CACHE_S:
        return cached[1], cached[2]
    return None


async def healthz(request: Request, ctx: AppContext) -> NodeResponse:
    hit = _fresh(ctx)
    if hit is not None:
        return _response(*hit)
    lock = getattr(ctx, "_health_lock", None)
    if lock is None:
        lock = ctx._health_lock = asyncio.Lock()  # type: ignore[attr-defined]
    async with lock:
        hit = _fresh(ctx)
        if hit is None:
            hit = await _check(ctx)
            ctx._health_cache = (time.monotonic(), *hit)  # type: ignore[attr-defined]
    return _response(*hit)


async def _check(ctx: AppContext) -> tuple[bool, bytes]:
    db_ok = True
    shrines: int | None = None
    try:
        assert ctx.db is not None
        await ctx.db.ping(CHECK_TIMEOUT_S)
        shrines = await asyncio.wait_for(ctx.shrine_count(), CHECK_TIMEOUT_S)
    except Exception as e:
        log.warning("[shrine] 헬스 체크: DB가 답하지 않습니다 (%s)", type(e).__name__)
        db_ok = False
        shrines = None
    r_ok = await redis_ok(ctx)
    if not r_ok:
        log.warning("[shrine] 헬스 체크: Redis가 답하지 않습니다")
    ok = db_ok and r_ok
    assert ctx.uploads is not None
    body = {
        "ok": ok,
        "db": "ok" if db_ok else "fail",
        "uptime": js_round(time.monotonic() - ctx.started_at),
        "shrines": shrines,
        "uploads": ctx.uploads.stats(),
    }
    return ok, js_json(body).encode("utf-8")
