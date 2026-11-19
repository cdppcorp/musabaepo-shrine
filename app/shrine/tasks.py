"""주기 작업 (main.ts의 setInterval 자리). 예외는 잡아서 로그만 남기고 다음 번에 다시 돕니다.

    ctx.tasks.every("업로드 정리", 6 * 3600, cleanup_uploads)          # 시작할 때 한 번 + 6시간마다
    ctx.tasks.every("보관 기간", 24 * 3600, run_retention, immediate=True)

lifespan이 끝날 때 모두 취소합니다.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

log = logging.getLogger("shrine.tasks")


class PeriodicTasks:
    def __init__(self) -> None:
        self._tasks: list[asyncio.Task] = []

    def every(self, name: str, seconds: float, fn: Callable[[], Awaitable[None]], *, immediate: bool = True) -> None:
        async def loop() -> None:
            if not immediate:
                await asyncio.sleep(seconds)
            while True:
                try:
                    await fn()
                except asyncio.CancelledError:
                    raise
                except Exception:
                    log.exception("[shrine] 주기 작업 실패: %s", name)
                await asyncio.sleep(seconds)

        self._tasks.append(asyncio.create_task(loop(), name=f"shrine:{name}"))

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
