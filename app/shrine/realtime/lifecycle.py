"""프로세스 끝내기 · 예외 처리 (server/main.ts 74-130) + uvicorn WebSocket 설정 + PostgreSQL lock_timeout.

끝내기 (SIGTERM · SIGINT, docker compose stop · 배포, 시험은 SHRINE_TEST_STDIN의 'term'):
  로그 '[shrine] 끝내는 중 (SIGTERM) …' → 새 연결 거부(듣는 소켓 닫기) → 모든 WebSocket에 1012 'restart'를 보내고
  닫힐 때까지 최대 3초 → uvicorn이 처리 중인 HTTP를 최대 2초(timeout_graceful_shutdown) 기다림 → lifespan 끝
  (main.shutdown: 훅 · 주기 작업 · Redis · DB 닫기, '[shrine] 끝났습니다 (SIGTERM)') → 종료 코드 0.
  전체 8초를 넘으면 '[shrine] 8초 안에 정리하지 못해 강제로 끝냅니다' 후 강제 종료(1). 신호를 한 번 더 받으면 바로 1.
  uvicorn.Server를 이어받아 신호 처리를 직접 합니다 (uvicorn 기본은 끝난 뒤 신호를 다시 올려 종료 코드가 143이 됨).
잡히지 않은 예외 (이벤트 루프 콜백에서 올라온 예외 = Node uncaughtException):
  '[shrine] 잡히지 않은 예외 — 정리한 뒤 끝냅니다 (Docker가 다시 띄웁니다)' + 예외, 알림('서버 비정상 종료'), 위와 같은 정리 후 1.
처리되지 않은 비동기 실패 (아무도 결과를 보지 않은 Future/Task의 예외 = Node unhandledRejection):
  '[shrine] 처리되지 않은 Promise 거부 (서버는 계속 돕니다)' + 예외. 로그만.
시험 훅 SHRINE_TEST_STDIN=1 (운영 모드면 무시): 표준 입력 줄 'term' · 'crash'(콜백에서 Exception('시험용 예외')) ·
  'reject'(아무도 보지 않는 Future에 Exception('시험용 거부')). tests/conformance/README.md §3.

WebSocket (uvicorn websockets-sansio): 메시지 512바이트 넘으면 1009 (Node maxPayload), 압축 없음, ping 25초 · 답 25초 기다림.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import signal
import sys
import threading
import traceback
from collections.abc import Generator
from typing import TYPE_CHECKING, Any

import uvicorn

if TYPE_CHECKING:
    from ..context import AppContext
    from ..db.engine import Database

__all__ = ["HTTP_DRAIN_S", "SHUTDOWN_S", "WS_CLOSE_WAIT_S", "WS_OPTIONS", "ShrineServer", "serve", "set_lock_timeout"]

log = logging.getLogger("shrine")

#: 끝내기 전체 제한 (Docker stop 기본 유예 10초 안)
SHUTDOWN_S = 8.0
WS_CLOSE_WAIT_S = 3.0
HTTP_DRAIN_S = 2.0
#: PostgreSQL이 잠금을 기다리는 최대 시간 (Node SQLite busy_timeout = 3000과 같게)
LOCK_TIMEOUT_MS = 3000

WS_OPTIONS: dict[str, Any] = {
    "ws": "websockets-sansio",
    "ws_max_size": 512,
    "ws_ping_interval": 25.0,
    "ws_ping_timeout": 25.0,
    "ws_per_message_deflate": False,
}


def _emit(msg: str, stream: Any) -> None:
    """한 줄 남기기. 받는 쪽이 닫힌 출력(EPIPE · 닫힌 파일)이면 버립니다: 신호 처리 · 끝내기 · 예외 처리 길이 로그 때문에 멈추면
    안 됩니다 (예: 리눅스에서 부모가 표준 출력 파이프를 먼저 닫고 SIGTERM을 보내면 print가 BrokenPipeError를 냄)."""
    try:
        print(msg, file=stream, flush=True)
    except (OSError, ValueError):
        pass


def say(msg: str) -> None:
    _emit(msg, sys.stdout)


def say_err(msg: str) -> None:
    _emit(msg, sys.stderr)


def _fmt(exc: BaseException) -> str:
    return "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)).rstrip()


def set_lock_timeout(db: Database, ms: int = LOCK_TIMEOUT_MS) -> None:
    """이 DB의 모든 새 연결에 lock_timeout (연결할 때 보내는 설정이라 왕복이 늘지 않음). 연결을 만들기 전에 부릅니다."""
    from sqlalchemy import event

    @event.listens_for(db.engine.sync_engine, "do_connect")
    def _lock_timeout(dialect: Any, conn_rec: Any, cargs: Any, cparams: dict[str, Any]) -> None:
        settings = dict(cparams.get("server_settings") or {})
        settings["lock_timeout"] = str(ms)
        cparams["server_settings"] = settings


class _NoClientAddr(logging.Filter):
    """uvicorn이 WebSocket마다 남기는 '<IP:포트> - "WebSocket /ws" …' 줄을 뺍니다 (앱은 원래 IP를 로그에 남기지 않음)."""

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.msg
        return not (isinstance(msg, str) and msg.startswith('%s - "WebSocket '))


class ShrineServer(uvicorn.Server):
    def __init__(self, config: uvicorn.Config, ctx: AppContext) -> None:
        super().__init__(config)
        self.ctx = ctx
        #: 끝내는 까닭 ('SIGTERM' · 'SIGINT' · 'uncaughtException'). None이면 아직 돌고 있음
        self.why: str | None = None
        self.exit_code = 0
        self.loop: asyncio.AbstractEventLoop | None = None
        self._graceful_task: asyncio.Task[None] | None = None

    # ── 신호 ──

    @contextlib.contextmanager
    def capture_signals(self) -> Generator[None, None, None]:
        if threading.current_thread() is not threading.main_thread():
            yield
            return
        names = ["SIGINT", "SIGTERM", "SIGBREAK"]
        old: dict[int, Any] = {}
        for name in names:
            sig = getattr(signal, name, None)
            if sig is None:
                continue
            try:
                old[sig] = signal.signal(sig, self._on_signal)
            except (ValueError, OSError):
                pass
        try:
            yield
        finally:
            for sig, handler in old.items():
                with contextlib.suppress(ValueError, OSError):
                    signal.signal(sig, handler)

    def _on_signal(self, sig: int, frame: Any) -> None:
        name = signal.Signals(sig).name
        if self.why is not None:
            say_err(f"[shrine] {name}를 다시 받아 바로 끝냅니다")
            os._exit(1)
        if self.loop is None:
            self.should_exit = True
            return
        self.loop.call_soon_threadsafe(self.begin_shutdown, name, 0)

    # ── 시작 ──

    async def serve(self, sockets: Any = None) -> None:
        self.loop = asyncio.get_running_loop()
        self.loop.set_exception_handler(self._on_loop_error)
        _start_stdin_hooks(self)
        await super().serve(sockets)

    # ── 끝내기 ──

    def begin_shutdown(self, why: str, code: int) -> None:
        """정리하고 끝냅니다. 두 번째 부름은 무시합니다 (제한 시간이 지나면 강제 종료)."""
        if self.why is not None:
            return
        self.why = why
        self.exit_code = code
        self.ctx.__dict__["stop_reason"] = why
        # 제한 시간 타이머를 먼저: 아래 어느 단계가 막혀도 SHUTDOWN_S 안에 끝납니다
        timer = threading.Timer(SHUTDOWN_S, self._force_exit)
        timer.daemon = True
        timer.start()
        say(f"[shrine] 끝내는 중 ({why}) …")
        self.ctx.stopping = True
        assert self.loop is not None
        self._graceful_task = self.loop.create_task(self._graceful())

    def _force_exit(self) -> None:
        say_err(f"[shrine] {int(SHUTDOWN_S)}초 안에 정리하지 못해 강제로 끝냅니다")
        os._exit(self.exit_code or 1)

    async def _graceful(self) -> None:
        from . import stop_realtime

        loop = asyncio.get_running_loop()
        deadline = loop.time() + WS_CLOSE_WAIT_S
        # 1) 새 연결 거부 (처리 중인 요청은 마저 끝냄)
        for server in list(getattr(self, "servers", []) or []):
            server.close()
        # 2) WebSocket: 1012로 닫고 닫힐 때까지 (최대 3초)
        try:
            await stop_realtime(self.ctx, WS_CLOSE_WAIT_S)
            ws_class = getattr(self.config, "ws_protocol_class", None)
            while ws_class is not None and loop.time() < deadline:
                if not any(isinstance(c, ws_class) for c in self.server_state.connections):
                    break
                await asyncio.sleep(0.05)
        except Exception:  # noqa: BLE001
            log.exception("[shrine] 실시간 연결 정리 실패")
        # 3) uvicorn: 처리 중인 HTTP를 최대 timeout_graceful_shutdown 기다린 뒤 lifespan 끝 (DB 닫기)
        self.should_exit = True

    # ── 예외 ──

    def _on_loop_error(self, loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
        exc = context.get("exception")
        if exc is not None and context.get("future") is not None:
            # 기다리지 않은 작업의 실패 (Node unhandledRejection): 로그만 남기고 계속 돕니다
            say_err(f"[shrine] 처리되지 않은 Promise 거부 (서버는 계속 돕니다) {_fmt(exc)}")
            return
        if isinstance(exc, Exception) and context.get("handle") is not None:
            self.on_uncaught(exc)
            return
        loop.default_exception_handler(context)

    def on_uncaught(self, exc: BaseException) -> None:
        from .. import notify as notify_mod
        from ..logic.jsstr import slice_units

        say_err(f"[shrine] 잡히지 않은 예외 — 정리한 뒤 끝냅니다 (Docker가 다시 띄웁니다) {_fmt(exc)}")
        notify_mod.notify("서버 비정상 종료", {"이유": f"{type(exc).__name__}: {slice_units(str(exc), 0, 120)}"})
        self.begin_shutdown("uncaughtException", 1)


def _start_stdin_hooks(server: ShrineServer) -> None:
    """SHRINE_TEST_STDIN=1이면 표준 입력 줄 명령 (운영 모드면 무시). Windows는 다른 프로세스에 SIGTERM을 보낼 수 없어서."""
    if os.environ.get("SHRINE_TEST_STDIN") != "1" or server.ctx.config.is_prod:
        return
    loop = server.loop
    assert loop is not None

    def handle(cmd: str) -> None:
        if cmd == "term":
            server.begin_shutdown("SIGTERM", 0)
        elif cmd == "crash":
            # 이 콜백에서 그대로 올라가 이벤트 루프의 예외 처리(_on_loop_error)로 갑니다
            raise Exception("시험용 예외")  # noqa: TRY002
        elif cmd == "reject":
            fut = loop.create_future()
            fut.set_exception(Exception("시험용 거부"))
            del fut  # 아무도 결과를 보지 않은 채 사라짐 → 'exception was never retrieved'

    def reader() -> None:
        buf = b""
        while True:
            try:
                chunk = os.read(0, 4096)
            except OSError:
                return
            if not chunk:
                return
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                cmd = line.decode("utf-8", "replace").strip()
                if cmd:
                    loop.call_soon_threadsafe(handle, cmd)

    threading.Thread(target=reader, name="shrine-test-stdin", daemon=True).start()


def serve(config: uvicorn.Config, ctx: AppContext) -> int:
    """uvicorn으로 띄우고 종료 코드를 돌려줍니다 (정상 0, 잡히지 않은 예외 1, 시작 실패 3)."""
    logging.getLogger("uvicorn.error").addFilter(_NoClientAddr())
    server = ShrineServer(config, ctx)
    with contextlib.suppress(KeyboardInterrupt):
        server.run()
    if not server.started:
        return 3
    return server.exit_code
