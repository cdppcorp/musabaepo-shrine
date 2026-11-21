"""등록소 이미지 올리기 · 보여 주기 (http.ts uploadApi 244-268 · 423, uploads.ts serveUpload 384-422).

POST /api/upload — 입장한 사람만, 같은 출처에서만, 5MB까지 (본문은 이미지 그대로, Content-Type은 보지 않음):
  출처 403 origin → 입장 표 401 ticket → 차단 403 blocked → Content-Length > 5MB 413 size
  → 시도 · 할당량 · 용량 · 동시 업로드 수(본문을 읽기 전) → 본문 읽기(넘치거나 끊기면 413 size,
  너무 느리면 408 timeout + Connection: close: web/front.py BodyDeadline) → 검사 · 저장 → 201 {ok, id}
  동시 업로드 자리는 어떤 경우에도(느린 본문 · 끊김 · 예외) finally에서 돌려줍니다.
GET/HEAD /img/shrines/up/<16자>.<png|jpg|webp>
  · 맵에 떠 있는 사당의 이미지: 누구나, Cache-Control: public, max-age=86400, ETag = 따옴표로 감싼 이름, 같으면 304
  · 검토 대기 이미지: 올린 사람(24시간) · 관리 비밀번호로 연 사람(3시간) · 운영자만, private, no-store + noindex, 304 없음
  · 볼 수 없거나 파일이 없으면 404 (HEAD도)
"""

from __future__ import annotations

import os
import stat

import anyio
from starlette.convertors import Convertor, register_url_convertor
from starlette.requests import Request
from starlette.routing import Route

from .. import uploads as up
from ..context import AppContext
from .net import node_header
from .registry import is_blocked, read_limited, same_origin, ticket_of
from .responses import NodeResponse, json_response, not_found


class _UploadName(Convertor):
    regex = "[A-Za-z0-9_-]{16}\\.(?:png|jpg|webp)"

    def convert(self, value: str) -> str:
        return value

    def to_string(self, value: str) -> str:
        return value


register_url_convertor("shrine_upload", _UploadName())


def _declared(v: str | None) -> float:
    if v is None or not v.strip():
        return 0.0
    try:
        return float(v.strip())
    except ValueError:
        return float("nan")


async def upload_api(request: Request) -> NodeResponse:
    ctx: AppContext = request.app.state.ctx
    if not same_origin(request):
        return json_response(403, {"ok": False, "reason": "origin"})
    ticket = ticket_of(request)
    if ticket is None:
        return json_response(401, {"ok": False, "reason": "ticket"})
    ip = request.state.client_ip
    sid = ticket["sid"]
    if await is_blocked(ctx, ip, sid):
        return json_response(403, {"ok": False, "reason": "blocked"})
    if _declared(node_header(request.scope["headers"], "content-length")) > up.UPLOAD_MAX:
        return json_response(413, {"ok": False, "reason": "size"})
    ip_key = request.state.ip_hash
    slot = await up.begin_upload(ctx, sid, ip_key)
    if isinstance(slot, str):
        return json_response(up.UPLOAD_STATUS.get(slot, 400), {"ok": False, "reason": slot})
    try:
        buf = await read_limited(request, up.UPLOAD_MAX)
        deadline = request.scope.get("state", {}).get("body_deadline")
        if buf is None and deadline is not None and deadline.timed_out:
            return json_response(408, {"ok": False, "reason": "timeout"})
        r = await up.save_upload(ctx, buf, sid, ip_key)
    finally:
        slot.done()
    if r["ok"]:
        return json_response(201, r)
    return json_response(up.UPLOAD_STATUS.get(r["reason"], 400), r)


async def serve_upload(request: Request) -> NodeResponse:
    ctx: AppContext = request.app.state.ctx
    name = request.path_params["name"]
    is_open = await up.is_public_upload(ctx, name)
    if not is_open:
        ticket = ticket_of(request)
        if not await up.can_see_private(ctx, request, name, ticket["sid"] if ticket else None):
            return not_found(request)
    path = ctx.uploads.path_of(name)
    try:
        st = await anyio.to_thread.run_sync(os.stat, path)
    except OSError:
        return not_found(request)
    if not stat.S_ISREG(st.st_mode):
        return not_found(request)
    ext = name.rsplit(".", 1)[1]
    # 파일 이름은 무작위이고 한 번 쓴 뒤 바뀌지 않으므로 이름이 곧 ETag입니다
    etag = f'"{name}"'
    headers = [
        ("Content-Type", up.TYPES.get(ext, "application/octet-stream")),
        ("Cross-Origin-Resource-Policy", "same-origin"),
        ("ETag", etag),
    ]
    if is_open:
        headers.append(("Cache-Control", "public, max-age=86400"))
    else:
        headers.append(("Cache-Control", "private, no-store"))
        headers.append(("X-Robots-Tag", "noindex"))
    if is_open and node_header(request.scope["headers"], "if-none-match") == etag:
        return NodeResponse(304, headers)
    return NodeResponse(200, [*headers, ("Content-Length", str(st.st_size))], file=path)


def routes(base: str) -> list[Route]:
    return [
        Route(f"{base}/api/upload", upload_api, methods=["POST"], include_in_schema=False),
        Route(f"{base}/img/shrines/up/{{name:shrine_upload}}", serve_upload, methods=["GET", "HEAD"], include_in_schema=False),
    ]
