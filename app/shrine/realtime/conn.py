"""WebSocket 연결 하나의 보내기 쪽 (Node ws의 readyState · send · close · terminate · bufferedAmount 자리).

ASGI ``send``는 기다리는 함수라서, 느린 사람 하나 때문에 채널 전체에 보내기가 멈추지 않게 연결마다 보낼 줄(out)과
보내는 작업(writer)을 둡니다. 보낼 줄에 쌓인 바이트가 256KB를 넘은 채로 또 보내려 하면 그 연결을 끊습니다
(Node: bufferedAmount > 256KB면 terminate). 끊기(terminate)는 닫기 프레임 없이 TCP를 닫습니다 — 받는 쪽 처리
(serve)가 닫기를 보내지 않고 끝나면 uvicorn이 연결을 닫습니다. 화면은 1006으로 보고 다시 붙습니다.

상태: OPEN → close() → CLOSING (닫기 프레임을 줄 맨 뒤에 넣음, 그 뒤로는 보내지 않음) / terminate() → CLOSED.
"""

from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import Awaitable, Callable
from typing import Any

__all__ = ["CLOSED", "CLOSING", "MAX_BUFFERED", "OPEN", "Conn"]

OPEN = 1
CLOSING = 2
CLOSED = 3

MAX_BUFFERED = 256 * 1024

_CLOSE = object()


class Conn:
    __slots__ = ("_send", "close_code", "close_reason", "done", "kill", "out", "out_bytes", "state", "wake", "writer")

    def __init__(self, send: Callable[[dict[str, Any]], Awaitable[None]]) -> None:
        self._send = send
        self.state = OPEN
        self.out: deque[Any] = deque()
        self.out_bytes = 0
        self.wake = asyncio.Event()
        #: terminate()가 채움: 받는 쪽 처리가 기다리다 바로 끝남
        self.kill: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self.done = asyncio.Event()
        self.close_code = 1000
        self.close_reason = ""
        self.writer: asyncio.Task[None] | None = None

    def push(self, data: str, size: int) -> None:
        """보낼 줄에 넣기 (상태는 부르는 쪽이 OPEN인지 봄). 이미 256KB 넘게 쌓였으면 끊습니다."""
        if self.out_bytes > MAX_BUFFERED:
            self.terminate()
            return
        self.out.append((data, size))
        self.out_bytes += size
        self.wake.set()

    def close(self, code: int, reason: str = "") -> None:
        """닫기 프레임을 보낼 줄 맨 뒤에 (먼저 넣은 메시지는 다 보냄). 이미 닫는 중이면 그대로."""
        if self.state != OPEN:
            return
        self.state = CLOSING
        self.close_code = code
        self.close_reason = reason
        self.out.append(_CLOSE)
        self.wake.set()

    def terminate(self) -> None:
        if self.state == CLOSED:
            return
        self.state = CLOSED
        if not self.kill.done():
            self.kill.set_result(None)

    def start(self) -> None:
        self.writer = asyncio.create_task(self._run(), name="shrine:ws-writer")

    async def stop(self) -> None:
        task, self.writer = self.writer, None
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def _run(self) -> None:
        try:
            while True:
                if not self.out:
                    self.wake.clear()
                    await self.wake.wait()
                    continue
                item = self.out.popleft()
                if item is _CLOSE:
                    await self._send({"type": "websocket.close", "code": self.close_code, "reason": self.close_reason})
                    return
                data, size = item
                self.out_bytes -= size
                await self._send({"type": "websocket.send", "text": data})
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — 끊긴 연결 (uvicorn ClientDisconnected 등): 받는 쪽이 disconnect를 받음
            self.state = CLOSED
