"""GET/HEAD /healthz (http.ts 343-370). 요청 제한보다 먼저, 캐시하지 않습니다.

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


async def redis_ok(ctx: AppContext) -> bool:
    if ctx.redis is None:
        return False
    try:
        return bool(await asyncio.wait_for(ctx.redis.ping(), CHECK_TIMEOUT_S))
    except Exception:
        return False


async def healthz(request: Request, ctx: AppContext) -> NodeResponse:
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
    return NodeResponse(
        200 if ok else 503,
        [("Content-Type", "application/json; charset=utf-8"), ("Cache-Control", "no-store"), ("X-Robots-Tag", "noindex")],
        js_json(body).encode("utf-8"),
    )
