"""``${BASE}/ws`` WebSocket 라우트 (main.ts 'upgrade' + realtime.ts handleUpgrade) · 실시간 시작/끝 훅.

routes.py가 ``ws.install(app, ctx)``로 붙입니다. 라우트는 Starlette WebSocketRoute에 ASGI 앱(WsEndpoint)을 그대로 넣어
Starlette의 WebSocket 감싸기 없이 ASGI 메시지를 직접 다룹니다:
  · 거절은 업그레이드 전에 HTTP 상태로 (ASGI WebSocket Denial Response — uvicorn websockets-sansio가 지원,
    scope['extensions']['websocket.http.response']): 503 끝내는 중 / 403 출처 / 401 입장 표 / 429 연결 폭주 · IP당 동시 연결 /
    503 전체 900 · 세 채널 꽉 참. 막힌 사람은 받은 뒤 4005.
  · front.py가 주소를 Node pathname으로 정리해 둡니다. ${BASE}/ws가 아닌 업그레이드는 Starlette가 받기 전에 닫습니다(403;
    Node는 응답 없이 끊음 — front.py에 적힌 그대로 둔 차이).
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from starlette.routing import WebSocketRoute

from .. import moderation
from ..context import AppContext
from ..realtime import realtime_of, start_realtime, stop_realtime

__all__ = ["WsEndpoint", "install"]


class WsEndpoint:
    """ASGI 앱 (함수가 아니라서 Starlette가 그대로 부름)."""

    def __init__(self, ctx: AppContext) -> None:
        self.ctx = ctx

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        await realtime_of(self.ctx).serve(scope, receive, send)


def install(app: FastAPI, ctx: AppContext) -> None:
    app.router.routes.append(WebSocketRoute(f"{ctx.config.base_path}/ws", WsEndpoint(ctx), name="ws"))

    @ctx.on_startup
    async def start_p3_realtime(c: AppContext) -> None:
        await moderation.start(c)
        await start_realtime(c)

    @ctx.on_shutdown
    async def stop_p3_realtime(c: AppContext) -> None:
        # 신호 · 예외로 끝낼 때는 lifecycle이 먼저 1012로 닫아 두므로 여기서는 남은 것만 정리합니다
        await stop_realtime(c)
        await moderation.stop(c)
