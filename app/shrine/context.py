"""앱 하나가 들고 있는 것 (설정 · DB · Redis · 업로드 폴더 · 주기 작업 · 시작/끝 훅).

요청 처리에서:    ctx = request.app.state.ctx        (또는 Depends(get_ctx))
WebSocket에서:    ctx = websocket.app.state.ctx
주기 작업에서:    lifespan이 만든 ctx를 넘겨받아 씁니다

나중 단계가 붙는 곳:
  · ctx.on_startup(fn):  DB · Redis가 준비된 뒤 차례로 (예: 사당 목록 캐시 채우기, 실시간 시작, 주기 작업 등록)
  · ctx.on_shutdown(fn): 끝낼 때 거꾸로 (예: 실시간 정리). 훅마다 SHUTDOWN_HOOK_S 안에 끝나야 합니다
  · ctx.count_shrines:   /healthz의 shrines 칸. P2에서 allShrines()(검증 통과 · 캐시)의 개수로 바꿉니다
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from sqlalchemy import text
from starlette.requests import HTTPConnection

from .config import Config
from .storage import UploadStore
from .tasks import PeriodicTasks

if TYPE_CHECKING:
    import redis.asyncio as aioredis

    from .db.engine import Database
    from .redis import FixedWindowLimiter

Hook = Callable[["AppContext"], Awaitable[None]]


@dataclass
class AppContext:
    config: Config
    #: 앱이 뜬 시각 (/healthz uptime). 벽시계가 바뀌어도(호스트 절전 · 시간 맞춤) 흔들리지 않게 monotonic
    started_at: float = field(default_factory=time.monotonic)
    db: Database | None = None
    redis: aioredis.Redis | None = None
    uploads: UploadStore | None = None
    tasks: PeriodicTasks = field(default_factory=PeriodicTasks)
    #: 모든 HTTP 요청: IP(그날 해시)당 1분에 240번 (http.ts requestLimiter)
    request_limiter: FixedWindowLimiter | None = None
    #: 끝내는 중 (새 WebSocket을 받지 않는 등 나중 단계가 봄)
    stopping: bool = False
    startup_hooks: list[Hook] = field(default_factory=list)
    shutdown_hooks: list[Hook] = field(default_factory=list)
    count_shrines: Callable[["AppContext"], Awaitable[int]] | None = None

    def on_startup(self, fn: Hook) -> Hook:
        self.startup_hooks.append(fn)
        return fn

    def on_shutdown(self, fn: Hook) -> Hook:
        self.shutdown_hooks.append(fn)
        return fn

    async def shrine_count(self) -> int:
        if self.count_shrines is not None:
            return await self.count_shrines(self)
        assert self.db is not None
        async with self.db.engine.connect() as conn:
            return int((await conn.execute(text("SELECT COUNT(*) FROM shrines"))).scalar_one())


def get_ctx(conn: HTTPConnection) -> AppContext:
    """FastAPI Depends용: `ctx: AppContext = Depends(get_ctx)`."""
    return conn.app.state.ctx
