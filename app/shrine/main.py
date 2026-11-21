"""무사배포 기원소 서버 (FastAPI). HTTP와 실시간(WebSocket)을 프로세스 하나에서 받습니다 (uvicorn 워커 1개).

시작 순서 (main.ts와 같은 흐름):
  설정 검사(실패하면 1로 끝냄) → 업로드 폴더 준비 → DB 연결 · Alembic upgrade head → Redis 연결 확인
  → 요청 제한 준비 → ctx.startup_hooks (나중 단계: 사당 캐시, 실시간, 주기 작업 …) → 요청 받기

끝내기 (SIGTERM · SIGINT, docker compose stop):
  uvicorn이 새 연결을 받지 않고, 열린 WebSocket에 1012(서버 재시작)를 보내고, 처리 중인 HTTP를
  최대 GRACEFUL_S초 기다립니다 → 그다음 lifespan 끝: ctx.stopping=True → ctx.shutdown_hooks를 거꾸로
  (훅마다 SHUTDOWN_HOOK_S초) → 주기 작업 취소 → Redis · DB 닫기. 신호를 두 번 받으면 uvicorn이 바로 끝냅니다.
  P3: 신호 · 잡히지 않은 예외 · SHRINE_TEST_STDIN 시험 훅은 realtime/lifecycle.py (ShrineServer)가 받아
      '끝내는 중 (SIGTERM) …' → 듣는 소켓 닫기 → WebSocket 1012 'restart' (최대 3초) → 위 순서 → 종료 코드 0 (예외면 1, 8초 넘으면 강제).

실행:  uv run python -m shrine [--env-file ../.env]     (app/ 폴더에서)
"""

from __future__ import annotations

import asyncio
import logging
import sys
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from . import redis as shrine_redis
from .config import Config, config_or_exit
from .context import AppContext
from .db.engine import Database, MigrationError
from .storage import UploadStore
from .web import routes
from .web.front import FrontController

log = logging.getLogger("shrine")

#: Caddy의 keep-alive(4초)보다 길게: 앱이 먼저 끊으면 그 사이 요청이 드물게 502가 됩니다 (main.ts:44와 같은 130초)
KEEP_ALIVE_S = 130
#: 처리 중인 요청 · WebSocket 정리를 기다리는 시간 (Node: WS 3초 + HTTP 2초)
GRACEFUL_S = 2  # P3: WebSocket 1012 · 3초는 lifecycle이 먼저 하므로 여기는 HTTP만 (Node HTTP_DRAIN_MS 2초)
#: 끝내기 훅 하나당 제한 (전체가 Docker stop_grace_period 15초 안에 끝나게)
SHUTDOWN_HOOK_S = 3


def say(msg: str) -> None:
    print(msg, flush=True)


class StartupError(RuntimeError):
    pass


def create_app(config: Config | None = None) -> FastAPI:
    """앱을 만듭니다. config가 없으면 환경 변수를 검사하고, 문제가 있으면 1로 끝냅니다."""
    config = config or config_or_exit()
    ctx = AppContext(config=config)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        try:
            await startup(ctx)
        except StartupError as e:
            # 까닭을 한 줄로 먼저 남깁니다 (그 뒤 uvicorn이 자세한 내용과 함께 시작을 멈춤, 종료 코드 3)
            log.error("%s", e)
            raise
        try:
            yield
        finally:
            await shutdown(ctx)

    app = FastAPI(
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        swagger_ui_oauth2_redirect_url=None,
        redirect_slashes=False,
    )
    app.state.ctx = ctx
    routes.install(app, ctx)
    app.add_middleware(FrontController, ctx=ctx)
    return app


async def startup(ctx: AppContext) -> None:
    config = ctx.config
    ctx.started_at = time.monotonic()
    ctx.uploads = UploadStore(config.data_dir)
    try:
        ctx.uploads.prepare()
    except OSError as e:
        raise StartupError(f"[shrine] 업로드 폴더를 만들지 못했습니다 ({ctx.uploads.dir}): {e}") from e

    ctx.db = Database(config.database_url)
    from .realtime.lifecycle import set_lock_timeout  # P3: 잠금은 3초까지만 기다림 (Node busy_timeout 3000)

    set_lock_timeout(ctx.db)
    try:
        await ctx.db.ping(5)
    except Exception as e:
        await ctx.db.dispose()
        raise StartupError(f"[shrine] PostgreSQL에 연결하지 못했습니다 (DATABASE_URL): {type(e).__name__}: {e}") from e
    try:
        await ctx.db.migrate()
    except MigrationError as e:
        await ctx.db.dispose()
        raise StartupError(f"[shrine] {e}") from e

    ctx.redis = shrine_redis.connect(config.redis_url)
    try:
        await asyncio.wait_for(ctx.redis.ping(), 5)
    except Exception as e:
        await ctx.redis.aclose()
        await ctx.db.dispose()
        raise StartupError(f"[shrine] Redis에 연결하지 못했습니다 (REDIS_URL): {type(e).__name__}: {e}") from e
    ctx.request_limiter = shrine_redis.FixedWindowLimiter(ctx.redis, "req", 240, 60_000)

    for hook in ctx.startup_hooks:
        await hook(ctx)

    say(f"[shrine] http://{config.host}:{config.port}{config.base_path}/ ({'운영' if config.is_prod else '개발'})")
    if config.dev_skip_human_check:
        log.warning("[shrine] 개발 모드: Turnstile 키가 없어 사람 확인을 건너뜁니다. 운영에서는 키가 꼭 필요합니다.")
    # P4: 운영 모드면 notify('서버 시작', {주소, Python}) (main.ts:71)


async def shutdown(ctx: AppContext) -> None:
    ctx.stopping = True
    why = ctx.__dict__.get("stop_reason")  # P3: 신호 · 예외로 끝낼 때는 lifecycle이 이미 '끝내는 중 (까닭) …'을 남김
    if why is None:
        say("[shrine] 끝내는 중 …")
    for hook in reversed(ctx.shutdown_hooks):
        try:
            await asyncio.wait_for(hook(ctx), SHUTDOWN_HOOK_S)
        except Exception:
            log.exception("[shrine] 끝내기 작업 실패: %s", getattr(hook, "__name__", hook))
    await ctx.tasks.stop()
    if ctx.redis is not None:
        try:
            await ctx.redis.aclose()
        except Exception:
            log.exception("[shrine] Redis 닫기 실패")
    if ctx.db is not None:
        try:
            await ctx.db.dispose()
        except Exception:
            log.exception("[shrine] DB 닫기 실패")
    say(f"[shrine] 끝났습니다 ({why})" if why else "[shrine] 끝났습니다")


def run(config: Config) -> None:
    """uvicorn으로 띄웁니다 (워커 1개: 채널 · 접속자 · 그날 IP 소금이 이 프로세스 메모리에 있음)."""
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    # Alembic의 단계별 안내는 숨기고, 구조를 바꿨을 때만 db/engine.py가 한 줄 남깁니다
    logging.getLogger("alembic").setLevel(logging.WARNING)
    app = create_app(config)
    from .realtime import lifecycle  # P3: 신호 · 예외 · 시험 훅을 직접 받는 uvicorn.Server

    uv = uvicorn.Config(
        app,
        host=config.host.strip("[]"),
        port=config.port,
        http="httptools",
        lifespan="on",
        timeout_keep_alive=KEEP_ALIVE_S,
        timeout_graceful_shutdown=GRACEFUL_S,
        # Node는 Server 머리글을 보내지 않습니다. Date는 보냅니다
        server_header=False,
        date_header=True,
        # X-Forwarded-For는 앱이 TRUST_PROXY로 직접 봅니다 (uvicorn이 client 주소를 바꾸지 않게)
        proxy_headers=False,
        # 접속 기록은 Caddy가 IP를 가려서 남깁니다. 앱은 원래 IP를 로그에 남기지 않습니다
        access_log=False,
        log_level="info",
        # P3: 메시지 512바이트 넘으면 1009 · 압축 없음 · ping 25초 (realtime.ts WebSocketServer 설정)
        **lifecycle.WS_OPTIONS,
    )
    code = lifecycle.serve(uv, app.state.ctx)
    if code:
        sys.exit(code)
