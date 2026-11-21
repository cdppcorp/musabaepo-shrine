"""공개 API가 같이 쓰는 요청 도우미 (http.ts sameOrigin · readJson · ticketOf · json 실패 본문).

  · same_origin(request): Origin이 없으면 통과, PUBLIC_ORIGIN이 있으면 정확히 같아야, 없으면 URL(origin).host === Host
  · read_json(request, limit): Content-Type이 application/json으로 시작하고(대소문자 그대로) Content-Length · 실제 본문이
    limit 바이트 이하이며 JSON.parse 결과가 객체 · 배열일 때만 그 값, 아니면 None
  · ticket_of(request): 입장 표 쿠키(shrine_ticket)를 검증한 표 dict 또는 None
  · fail(status, reason): {ok:false, reason} + no-store
web/registry.py(P2b)에 같은 일을 하는 함수가 있습니다. 나중에 이쪽으로 모아도 됩니다.
"""

from __future__ import annotations

from typing import Any

from starlette.requests import Request

from ..logic.crypto import TICKET_COOKIE, parse_cookies, verify_ticket
from ..logic.jsnum import JSONParseError, json_parse
from ..logic.jsstr import js_trim, utf8_decode
from ..logic.weburl import InvalidURL, UnsupportedScheme, parse_special_url
from .net import node_header
from .responses import NodeResponse, json_response

__all__ = ["fail", "origin_host", "read_json", "same_origin", "ticket_of"]


def origin_host(origin: str) -> str | None:
    """JS ``new URL(origin).host``. 주소가 아니면 None. 특수하지 않은 scheme은 '//' 뒤 권한 부분의 host[:port]를 그대로."""
    try:
        return parse_special_url(origin).host_port
    except UnsupportedScheme:
        rest = origin.split(":", 1)[1] if ":" in origin else ""
        if not rest.startswith("//"):
            return ""
        authority = rest[2:]
        for c in "/?#":
            authority = authority.split(c, 1)[0]
        return authority.rsplit("@", 1)[-1]
    except InvalidURL:
        return None


def same_origin(request: Request) -> bool:
    headers = request.scope["headers"]
    origin = node_header(headers, "origin")
    if not origin:
        return True
    config = request.app.state.ctx.config
    if config.public_origin:
        return origin == config.public_origin
    host = origin_host(origin)
    return host is not None and host == node_header(headers, "host")


def _js_number(v: str) -> float:
    """``Number(header)``: 비면 0, 숫자 모양이 아니면 NaN (HTTP 파서가 이미 숫자만 들여보내므로 대강)."""
    t = js_trim(v)
    if not t:
        return 0.0
    if t.isascii() and t.isdigit():
        return float(int(t))
    try:
        return float(t)
    except ValueError:
        return float("nan")


async def read_json(request: Request, limit: int) -> dict[str, Any] | list[Any] | None:
    headers = request.scope["headers"]
    if not (node_header(headers, "content-type") or "").startswith("application/json"):
        return None
    if _js_number(node_header(headers, "content-length") or "0") > limit:
        return None
    size = 0
    chunks: list[bytes] = []
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            return None
        chunks.append(chunk)
    try:
        v = json_parse(utf8_decode(b"".join(chunks)))
    except JSONParseError:
        return None
    return v if isinstance(v, (dict, list)) else None


def ticket_of(request: Request) -> dict[str, Any] | None:
    cookies = parse_cookies(node_header(request.scope["headers"], "cookie"))
    return verify_ticket(cookies.get(TICKET_COOKIE), request.app.state.ctx.config.ticket_secret)


def fail(status: int, reason: str) -> NodeResponse:
    return json_response(status, {"ok": False, "reason": reason})
