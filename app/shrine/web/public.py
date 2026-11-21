"""공개 API: 맵 정보 · 게시판 글 · 입장 · 서비스 가보기 (http.ts 169-203, 407-421, 430-433).

  GET  /api/world             맵 · 사당 · 초 요약 · 채팅 설정 · 최근 글 주제 · 등록소 (Cache-Control: no-cache)
  GET  /api/posts             {posts: 최근 7일 글 60개} (no-store)
  POST /api/enter             캐릭터 꾸미기 번호 + 사람 확인 → 입장 표 쿠키
  GET  /go/<slug>[/repo]      나가기 직전에 사당 상태를 다시 보고 302. 클릭은 입장 표가 있을 때만 셈

GET만 받는 라우트에 HEAD가 오면 Node처럼 맨 끝 fallback(정적 파일) → 404가 됩니다 (routes.py 규칙).
routes.py의 13~20 자리에서 ``app.include_router(public.build_router(ctx), prefix=base)``로 붙입니다.
"""

from __future__ import annotations

import re
import uuid

from fastapi import APIRouter
from starlette.requests import Request

from .. import moderation, shrines
from ..context import AppContext
from ..logic.chat import CHAT_MAX
from ..logic.crypto import TICKET_COOKIE, TICKET_TTL_MS, make_nick, sign_ticket
from ..logic.jsnum import UNDEFINED, json_stringify
from ..logic.links import is_safe_shrine_url, parse_github
from ..logic.util import now_ms
from ..logic.world import WORLD_JSON_TEXT, is_valid_look
from ..posts import POST_MAX, list_posts
from ..redis import FixedWindowLimiter
from ..turnstile import verify_human
from .api import fail, read_json, same_origin, ticket_of
from .responses import NodeResponse, json_response, not_found, redirect

__all__ = ["ENTER_LIMIT", "ENTER_WINDOW_MS", "build_router", "ticket_cookie"]

#: IP(그날 해시)당 입장 표 발급: 10분에 10장 (http.ts enterLimiter). Redis 키 shrine:rl:enter:<그날 IP 해시>
ENTER_LIMIT = 10
ENTER_WINDOW_MS = 10 * 60 * 1000
JSON_LIMIT = 4096

GO_RE = re.compile(r"/go/([a-z0-9-]{1,40})(/repo)?")
JSON_TYPE = ("Content-Type", "application/json; charset=utf-8")
ROBOTS = (b"X-Robots-Tag", b"noindex, nofollow")


def ticket_cookie(value: str, base: str, is_prod: bool) -> str:
    """http.ts:180 입장 표 쿠키 (운영이면 Secure)."""
    secure = "; Secure" if is_prod else ""
    return f"{TICKET_COOKIE}={value}; Path={base}/; Max-Age={TICKET_TTL_MS // 1000}; HttpOnly; SameSite=Strict{secure}"


def _noindex(resp: NodeResponse) -> NodeResponse:
    """res.setHeader('X-Robots-Tag', 'noindex, nofollow') 뒤의 응답 (보안 머리글의 같은 이름은 front가 그 자리에서 바꿈)."""
    resp.raw_headers.insert(0, ROBOTS)
    return resp


def build_router(ctx: AppContext) -> APIRouter:
    """BASE_PATH 아래 경로 (prefix는 routes.py가 붙입니다). ctx.count_shrines도 사당 캐시로 바꿉니다."""
    router = APIRouter()
    config = ctx.config
    base = config.base_path
    shrines.install(ctx)
    limiter: list[FixedWindowLimiter] = []

    def enter_limiter() -> FixedWindowLimiter:
        if not limiter or limiter[0].client is not ctx.redis:
            assert ctx.redis is not None
            limiter[:] = [FixedWindowLimiter(ctx.redis, "enter", ENTER_LIMIT, ENTER_WINDOW_MS)]
        return limiter[0]

    # 사당마다 channel(1~3)이 붙어 있습니다. 화면은 자기 채널(넘침 채널이면 1번)의 사당만 그립니다
    @router.api_route("/api/world", methods=["GET"], include_in_schema=False)
    async def world(request: Request) -> NodeResponse:
        public = await shrines.public_shrines(ctx)
        candles = await shrines.candle_summary(ctx)
        chat = {"free": config.free_chat, "max": CHAT_MAX, "postMax": POST_MAX, "contact": config.contact_email}
        # 게시판에 꽂힌 쪽지 색을 그리려고 최근 글 주제만 함께 보냅니다
        recent = [p["topic"] for p in await list_posts(ctx, 16)]
        rest = json_stringify(
            {"shrines": public, "candles": candles, "chat": chat, "recentTopics": recent, "registry": {"open": True}}
        )
        assert rest is not None and rest.startswith("{")
        body = '{"world":' + WORLD_JSON_TEXT + "," + rest[1:]
        return NodeResponse(200, [JSON_TYPE, ("Cache-Control", "no-cache")], body.encode("utf-8"))

    @router.api_route("/api/posts", methods=["GET"], include_in_schema=False)
    async def posts(request: Request) -> NodeResponse:
        return json_response(200, {"posts": await list_posts(ctx)})

    # 입장: 캐릭터 꾸미기 번호 + 사람 확인 → 입장 표 쿠키
    @router.api_route("/api/enter", methods=["POST"], include_in_schema=False)
    async def enter(request: Request) -> NodeResponse:
        if not same_origin(request):
            return fail(403, "origin")
        ip: str = request.state.client_ip
        if await moderation.is_blocked(ctx, ip):
            return fail(403, "blocked")
        if not await enter_limiter().allow(request.state.ip_hash):
            return fail(429, "busy")
        body = await read_json(request, JSON_LIMIT)
        look = body.get("look", UNDEFINED) if isinstance(body, dict) else UNDEFINED
        if not is_valid_look(look):
            return fail(400, "bad")
        token = body.get("token", UNDEFINED) if isinstance(body, dict) else UNDEFINED
        if not await verify_human(config, token, ip):
            return fail(403, "human")
        ticket = {"sid": str(uuid.uuid4()), "look": list(look), "nick": make_nick(), "exp": now_ms() + TICKET_TTL_MS}
        cookie = ticket_cookie(sign_ticket(ticket, config.ticket_secret), base, config.is_prod)
        out = json_stringify({"ok": True, "nick": ticket["nick"], "look": ticket["look"]}) or ""
        return NodeResponse(
            200, [("Set-Cookie", cookie), JSON_TYPE, ("Cache-Control", "no-store")], out.encode("utf-8")
        )

    # 서비스 가보기: 나가기 직전에 사당 상태를 한 번 더 보고, repo면 GitHub 저장소로.
    # 클릭 수는 입장한 사람(입장 표)이 누른 것만 셉니다 (주소만 불러 부풀리지 못하게)
    async def go(request: Request) -> NodeResponse:
        m = GO_RE.fullmatch(request.scope["path"][len(base) :])
        if m is None:
            return not_found(request)
        s = await shrines.find_shrine(ctx, m.group(1))
        if s is None:
            return not_found(request)

        async def count() -> None:
            if ticket_of(request) is not None:
                await shrines.add_click(ctx, s["slug"])

        if m.group(2):
            g = parse_github(s["repo"]) if s["repo"] else None
            if g is None:
                return _noindex(not_found(request))
            if s["status"] != "live":
                return _noindex(redirect(f"{base}/"))
            await count()
            return _noindex(redirect(g["url"]))
        if s["status"] != "live" or not is_safe_shrine_url(s):
            return _noindex(redirect(f"{base}/"))
        await count()
        return _noindex(redirect(s["url"]))

    router.add_api_route("/go/{slug}", go, methods=["GET"], include_in_schema=False)
    router.add_api_route("/go/{slug}/repo", go, methods=["GET"], include_in_schema=False)
    return router
