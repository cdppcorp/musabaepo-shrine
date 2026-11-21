"""모든 HTTP 요청의 입구 (http.ts handleRequest 372-387 + main.ts의 500 처리).

Node와 같은 순서:
  0. 보안 머리글을 모든 응답 앞에 붙임 (500 · 429 · 304 포함). 응답이 같은 이름을 적으면 그 값으로 바뀜
  1. 주소 = new URL(req.url, 'http://local').pathname (쿼리 무시, 퍼센트 인코딩은 풀지 않음, 점 조각 정리)
  2. GET/HEAD ${BASE}/healthz 또는 /healthz → 헬스 체크 (요청 제한보다 먼저)
  3. 요청 제한: 그날 IP 해시당 1분 240번 → 429 'Too Many Requests'
  4. /robots.txt (모든 메서드) · GET/HEAD /.well-known/security.txt (도메인 루트만)
  5. BASE가 있을 때 / 또는 ${BASE} → 302 ${BASE}/
  6. BASE가 없을 때 /shrine, /shrine/* → 302 (예전 주소)
  7. ${BASE}/로 시작하지 않으면 404
  8. 나머지는 FastAPI 라우터로 (routes.py): scope['path']를 1의 주소로 바꿔서 넘깁니다
처리 중 예외: 응답을 시작하기 전이면 500 text/plain no-store 빈 본문(+ 보안 머리글), 시작한 뒤면 연결을 끊음.
로그에는 SQL 매개변수(이메일 · PIN 해시 등)를 남기지 않습니다 (describe_error, DB 엔진도 hide_parameters).

보안 점검으로 Node와 일부러 다르게 둔 곳:
  · 머리글이 50개를 넘으면 버리지 않고 431로 거절 (버리면 X-Forwarded-For가 빠져 IP별 제한 · 차단을 비켜 감).
    Node처럼 앞 50개만 보고 IP를 정하는 것보다 안전합니다: 다른 머리글(Origin · Cookie 등)도 반쪽만 보는 일이 없음.
  · 요청 본문 읽기 시간 한도 (BodyDeadline): 전체 60초, 조각 사이 15초, 10초가 지나면 평균 초당 8KB 이상.
    넘으면 본문이 끊긴 것으로 다루고(업로드는 408 {reason: timeout}, JSON 등 그 밖은 408 Request Timeout)
    응답에 Connection: close를 붙여 연결을 닫습니다.
    느린 본문이 업로드 자리(서버 전체 3개) · 연결을 오래 붙잡지 못하게.
  · 요청 제한 키의 IP는 IPv6 /64로 묶어 해시 (web/net.py ip_hash).

요청마다 request.state에 client_ip(TRUST_PROXY 반영) · ip_hash(그날 해시)를 넣어 둡니다 (나중 단계가 씀).
"""

from __future__ import annotations

import asyncio
import logging
import traceback
from urllib.parse import quote

from starlette.requests import ClientDisconnect, Request

from ..context import AppContext
from ..whatwg import InvalidURL, request_pathname
from . import seo
from .health import healthz
from .net import MAX_HEADERS, client_ip, ip_hash, node_header
from .responses import not_found, redirect, text_response
from .security import merge_headers, security_headers

log = logging.getLogger("shrine.http")

#: 요청 본문 읽기 한도 (BodyDeadline)
BODY_TOTAL_S = 60.0
BODY_IDLE_S = 15.0
BODY_RATE_GRACE_S = 10.0
BODY_MIN_RATE = 8 * 1024


def describe_error(err: BaseException) -> str:
    """로그용 예외. SQLAlchemy 예외는 SQL 문장 · 매개변수 없이 DB 드라이버의 글만 (realtime/core.py describe_error와 같은 방법)."""
    orig = getattr(err, "orig", None)
    if orig is not None:
        head = f"{type(err).__name__} ({type(orig).__module__}.{type(orig).__name__}): {orig}"
    else:
        head = f"{type(err).__name__}: {err}"
    stack = "".join(traceback.format_tb(err.__traceback__)).rstrip()
    return f"{head}\n{stack}" if stack else head


class BodyDeadline:
    """ASGI receive를 감싸 요청 본문 읽기에 시간 한도를 겁니다. 넘으면 http.disconnect를 돌려줍니다
    (Starlette가 ClientDisconnect로 바꿈). 본문을 다 받은 뒤(more_body 없음)에는 원래 receive를 그대로 부릅니다
    (응답 중 연결 끊김 감시에 한도를 걸지 않음)."""

    def __init__(self, receive) -> None:
        self._receive = receive
        # 모듈 값을 만들 때마다 읽습니다 (시험에서 짧게 바꿀 수 있게)
        self.total, self.idle, self.grace, self.min_rate = BODY_TOTAL_S, BODY_IDLE_S, BODY_RATE_GRACE_S, BODY_MIN_RATE
        self._start: float | None = None
        self._bytes = 0
        self._done = False
        self.timed_out = False

    def _cut(self) -> dict:
        self.timed_out = True
        return {"type": "http.disconnect"}

    async def receive(self) -> dict:
        if self.timed_out:
            return {"type": "http.disconnect"}
        if self._done:
            return await self._receive()
        loop = asyncio.get_running_loop()
        if self._start is None:
            self._start = loop.time()
        wait = min(self.total - (loop.time() - self._start), self.idle)
        if wait <= 0:
            return self._cut()
        try:
            async with asyncio.timeout(wait):
                msg = await self._receive()
        except TimeoutError:
            return self._cut()
        if msg.get("type") != "http.request" or not msg.get("more_body", False):
            self._done = True
            return msg
        self._bytes += len(msg.get("body", b""))
        elapsed = loop.time() - self._start
        if elapsed > self.grace and self._bytes < self.min_rate * elapsed:
            return self._cut()
        return msg


class FrontController:
    """순수 ASGI 미들웨어. main.py가 FastAPI 앱에 가장 바깥 사용자 미들웨어로 붙입니다."""

    def __init__(self, app, ctx: AppContext):
        self.app = app
        self.ctx = ctx

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] == "http":
            await self.http(scope, receive, send)
        elif scope["type"] == "websocket":
            await self.websocket(scope, receive, send)
        else:
            await self.app(scope, receive, send)

    async def websocket(self, scope, receive, send) -> None:
        # P3: Node는 ${BASE}/ws가 아닌 업그레이드를 응답 없이 끊습니다 (main.ts:47-59). 요청 제한 · 보안 머리글은 없음.
        # 여기서는 주소만 Node처럼 정리해 라우터로 넘깁니다. 맞는 라우트가 없으면 Starlette가 닫습니다(uvicorn 403).
        try:
            path = request_pathname(_raw_target(scope))
        except Exception:
            await send({"type": "websocket.close", "code": 1008})
            return
        scope["path"] = path
        scope["raw_path"] = path.encode("ascii")
        await self.app(scope, receive, send)

    async def http(self, scope, receive, send) -> None:
        ctx = self.ctx
        config = ctx.config
        body = BodyDeadline(receive)
        # 업로드처럼 본문이 끊긴 까닭을 알아야 하는 곳이 봅니다 (request.scope['state']['body_deadline'])
        scope.setdefault("state", {})["body_deadline"] = body
        sec = [
            (k.encode("latin-1"), v.encode("latin-1"))
            for k, v in security_headers(config, node_header(scope["headers"], "host"))
        ]
        started = False

        async def send_with_headers(message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                headers = merge_headers(sec, list(message.get("headers", [])))
                if body.timed_out:
                    # 남은 본문을 읽지 않았으므로 이 연결은 닫습니다
                    headers = [h for h in headers if h[0].lower() != b"connection"] + [(b"Connection", b"close")]
                message = {**message, "headers": headers}
            await send(message)

        # 보안 점검: 50개를 넘으면 버리지 않고 거절 (Node는 버림 → X-Forwarded-For가 빠져 IP 제한을 비켜 갔음)
        if len(scope["headers"]) > MAX_HEADERS:
            return await self.plain(send_with_headers, 431, b"Request Header Fields Too Large", close=True)
        try:
            await self.dispatch(scope, body.receive, send_with_headers)
        except InvalidURL:
            # new URL()이 받지 않는 주소 (예: GET ///). Node도 여기서 500을 냅니다
            log.warning("[shrine] 요청 처리 실패: 주소로 볼 수 없는 요청")
            if started:
                raise
            await self.server_error(send_with_headers)
        except ClientDisconnect:
            if started:
                raise
            if body.timed_out:
                log.warning("[shrine] 요청 본문이 너무 느려 끊었습니다 (%s %s)", scope.get("method"), scope.get("path"))
                await self.plain(send_with_headers, 408, b"Request Timeout", close=True)
            else:
                log.warning("[shrine] 요청 처리 중 연결이 끊겼습니다")
                await self.server_error(send_with_headers)
        except Exception as err:
            log.error("[shrine] 요청 처리 실패: %s", describe_error(err))
            if started:
                raise  # 머리글을 이미 보냄: uvicorn이 이 연결만 끊습니다
            await self.server_error(send_with_headers)

    @staticmethod
    async def plain(send, status: int, text: bytes, *, close: bool = False) -> None:
        headers = [(b"Content-Type", b"text/plain; charset=utf-8"), (b"Cache-Control", b"no-store")]
        if close:
            headers.append((b"Connection", b"close"))
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": text})

    @staticmethod
    async def server_error(send) -> None:
        """500 text/plain no-store 빈 본문 (main.ts:33-41)."""
        await send(
            {
                "type": "http.response.start",
                "status": 500,
                "headers": [(b"Content-Type", b"text/plain; charset=utf-8"), (b"Cache-Control", b"no-store")],
            }
        )
        await send({"type": "http.response.body", "body": b""})

    async def dispatch(self, scope, receive, send) -> None:
        ctx = self.ctx
        config = ctx.config
        base = config.base_path
        path = request_pathname(_raw_target(scope))
        method = scope["method"]
        read = method in ("GET", "HEAD")
        request = Request(scope, receive)
        ip = client_ip(scope, config.trust_proxy)
        state = scope.setdefault("state", {})
        state["client_ip"] = ip

        async def reply(response) -> None:
            await response(scope, receive, send)

        # 헬스 체크는 요청 제한 앞에서 (Docker HEALTHCHECK · 바깥 가동 감시)
        if read and (path == f"{base}/healthz" or path == "/healthz"):
            return await reply(await healthz(request, ctx))
        hashed = ip_hash(ip)
        state["ip_hash"] = hashed
        assert ctx.request_limiter is not None
        if not await ctx.request_limiter.allow(hashed):
            return await reply(text_response(429, "Too Many Requests"))

        if path == "/robots.txt":
            return await reply(text_response(200, seo.robots(config)))
        if read and path == "/.well-known/security.txt":
            return await reply(text_response(200, seo.security_txt(config)) if config.contact_email else not_found(request))
        # 경로 앞부분을 쓸 때만 / → /shrine/ 로 보냅니다 (독립 도메인 루트면 그대로)
        if base and (path == "/" or path == base):
            return await reply(redirect(f"{base}/"))
        # 예전 주소(/shrine/...)로 들어오면 도메인 루트의 같은 곳으로
        if not base and (path == "/shrine" or path.startswith("/shrine/")):
            return await reply(redirect(legacy_target(path)))
        if not path.startswith(f"{base}/"):
            return await reply(not_found(request))

        scope["path"] = path
        scope["raw_path"] = path.encode("ascii")
        scope["root_path"] = ""
        await self.app(scope, receive, send)


def legacy_target(path: str) -> str:
    """/shrine/x → /x.

    Node는 path.slice(7)을 그대로 보내서 /shrine//evil.com → Location: //evil.com (다른 사이트로 가는 열린
    리다이렉트)이 됩니다. 여기서는 앞 빗금을 하나로 줄여 같은 사이트 안에 둡니다 (일부러 다르게 둔 곳).
    """
    rest = path[len("/shrine") :] or "/"
    return "/" + rest.lstrip("/")


def _raw_target(scope) -> str:
    raw = scope.get("raw_path")
    if raw is None:
        return quote(scope.get("path") or "/", safe="/%:@!$&'()*+,;=-._~")
    # uvicorn은 raw_path에 쿼리를 넣지 않습니다. Node처럼 latin-1 글자로 봅니다
    return raw.decode("latin-1")
