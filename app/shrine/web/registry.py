"""내 프로젝트 등록소 API (http.ts registryApi 205-242, 424-428) + 업로드 라우트 붙이기 + 주기 작업 등록.

  POST /api/submit · /api/manage/{find,get,save,withdraw}  (그 밖의 /api/manage/* 는 검사 뒤 404 글자)
  GET  /api/submit/<접수 코드 16~32자>   (GET만. HEAD는 정적 파일 → 404, Node와 같음)
  (web/uploads.py) POST /api/upload · GET/HEAD /img/shrines/up/<이름>

공통 순서: 출처(Origin) 403 origin → 입장 표 없음 401 ticket → (submit · manage/save만) 차단 403 blocked
→ application/json 4096바이트가 아니면 400 bad → 처리. 실패 본문은 {ok:false, reason} + 상태.
본문은 FastAPI 모델로 받지 않고 직접 읽습니다 (JSON.parse와 같은 규칙, 422를 내지 않음).
출처 · 입장 표 · 본문 읽기는 web/api.py(P2a), 차단 확인은 moderation.py를 같이 씁니다.

install(app, ctx)를 routes.py의 13~20 자리에서 부릅니다: 라우트를 붙이고, 시작할 때 알림 주소 · 주기 작업을 겁니다.
"""

from __future__ import annotations

from typing import Any

from starlette.convertors import Convertor, register_url_convertor
from starlette.requests import ClientDisconnect, Request
from starlette.routing import Route

from .. import moderation
from .. import notify as notify_mod
from .. import registry as reg
from ..context import AppContext
from . import api
from .api import same_origin, ticket_of
from .responses import NodeResponse, json_response, not_found

__all__ = ["install", "is_blocked", "read_json", "read_limited", "routes", "same_origin", "ticket_of"]

JSON_LIMIT = 4096


class _ReceiptCode(Convertor):
    regex = "[A-Za-z0-9_-]{16,32}"

    def convert(self, value: str) -> str:
        return value

    def to_string(self, value: str) -> str:
        return value


register_url_convertor("shrine_receipt", _ReceiptCode())


async def is_blocked(ctx: AppContext, ip: str, sid: str = "") -> bool:
    """moderation.ts isBlocked(ip, sid) — 어떤 오류에도 False."""
    return await moderation.is_blocked(ctx, ip, sid)


async def read_json(request: Request, limit: int = JSON_LIMIT) -> dict[str, Any] | None:
    """http.ts readJson. JSON 배열도 객체로 받지만(typeof 'object') 칸을 읽으면 모두 없으므로 빈 dict로."""
    v = await api.read_json(request, limit)
    if isinstance(v, list):
        return {}
    return v


async def read_limited(request: Request, limit: int) -> bytes | None:
    """본문을 끝까지 읽되 limit을 넘거나 끊기면 None (uploads.ts readBody)."""
    chunks: list[bytes] = []
    size = 0
    try:
        async for chunk in request.stream():
            size += len(chunk)
            if size > limit:
                return None
            chunks.append(chunk)
    except ClientDisconnect:
        return None
    return b"".join(chunks)


def fail_json(f: dict) -> NodeResponse:
    return json_response(f["status"], {"ok": False, "reason": f["reason"]})


async def registry_api(request: Request) -> NodeResponse:
    ctx: AppContext = request.app.state.ctx
    rel = request.scope["path"][len(ctx.config.base_path) :]
    if not same_origin(request):
        return json_response(403, {"ok": False, "reason": "origin"})
    ticket = ticket_of(request)
    if ticket is None:
        return json_response(401, {"ok": False, "reason": "ticket"})
    ip = request.state.client_ip
    sid = ticket["sid"]
    # 차단된 사람은 새로 접수하거나 고칠 수 없습니다 (내 접수 보기 · 내리기는 그대로)
    if rel in ("/api/submit", "/api/manage/save") and await is_blocked(ctx, ip, sid):
        return json_response(403, {"ok": False, "reason": "blocked"})
    body = await read_json(request)
    if body is None:
        return json_response(400, {"ok": False, "reason": "bad"})
    ip_key = request.state.ip_hash
    if rel == "/api/submit":
        r = await reg.submit_project(ctx, body, sid, ip_key, ticket["nick"])
        return json_response(201, r) if r["ok"] else fail_json(r)
    if rel == "/api/manage/find":
        r = await reg.find_mine(ctx, body, ip_key)
    elif rel == "/api/manage/get":
        r = await reg.manage_get(ctx, body, ip_key, sid)
    elif rel == "/api/manage/save":
        r = await reg.manage_save(ctx, body, ip_key, sid)
    elif rel == "/api/manage/withdraw":
        r = await reg.manage_withdraw(ctx, body, ip_key)
    else:
        return not_found()
    return json_response(200, r) if r["ok"] else fail_json(r)


async def receipt(request: Request) -> NodeResponse:
    ctx: AppContext = request.app.state.ctx
    st = await reg.status_by_code(ctx, request.path_params["code"])
    if st is None:
        return json_response(404, {"ok": False, "reason": "none"})
    return json_response(200, {"ok": True, **st})


def routes(base: str) -> list[Route]:
    code = Route(f"{base}/api/submit/{{code:shrine_receipt}}", receipt, methods=["GET"], include_in_schema=False)
    # Node는 접수 코드 조회를 GET만 받습니다 (HEAD는 정적 파일 → 404). Starlette가 GET에 붙이는 HEAD를 뺍니다
    code.methods.discard("HEAD")
    return [
        Route(f"{base}/api/submit", registry_api, methods=["POST"], include_in_schema=False),
        Route(f"{base}/api/manage/{{rest:path}}", registry_api, methods=["POST"], include_in_schema=False),
        code,
    ]


def install(app, ctx: AppContext) -> None:
    """routes.py 13~20 자리: 등록소 · 업로드 라우트 + 시작할 때 알림 주소 · 주기 작업(업로드 정리 · 보관 기간 · PIN 잠금)."""
    from ..retention import install_tasks
    from . import uploads as web_uploads

    base = ctx.config.base_path
    app.router.routes.extend([*web_uploads.routes(base), *routes(base)])

    @ctx.on_startup
    async def _p2b_startup(c: AppContext) -> None:
        notify_mod.configure(c.config.notify_webhook_url)
        install_tasks(c)
