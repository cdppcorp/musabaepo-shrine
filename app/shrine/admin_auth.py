"""운영자 화면 켜기 · 허용 IP · 같은 출처 · 세션 · 로그인 잠금 (server/admin.ts 53-226).

  · 켜지는 조건: ADMIN_PASSWORD가 있을 때 (길이 · 약함 · ADMIN_IPS 검사는 config.py가 해서 틀리면 비워 둠). 꺼져 있거나
    ADMIN_IPS 밖의 IP면 /admin · /api/admin/*는 404입니다.
  · 세션 쿠키 shrine_admin: HMAC으로 서명한 8시간짜리 값 (logic.crypto.sign_session · read_session).
    서명 키는 TICKET_SECRET과 비밀번호에서 따로 만들어서, 비밀번호를 바꾸고 다시 띄우면 예전 세션은 모두 끊깁니다.
  · 로그아웃한 세션: Node는 메모리 Map이었고, 여기서는 Redis에 만료(세션이 끝나는 시각)를 붙여 둡니다 (다시 띄워도 남음).
  · 로그인 실패: IP(그날 해시)당 15분에 5번, 서버 전체 15분에 50번에서 잠급니다. Node와 같이 프로세스 메모리에 둡니다
    (다시 띄우면 비움). 창 규칙도 같습니다: IP 창은 첫 실패부터 15분, 전체 창은 창이 끝난 뒤 처음 로그인을 시도한 때부터 15분.
    보안 점검: ADMIN_IPS가 있으면 서버 전체 잠금은 쓰지 않습니다 (그때 로그인까지 오는 요청은 ADMIN_IPS뿐이라, 남이 전체
    잠금을 걸어 운영자를 내쫓을 수 없게). IP별 잠금은 그대로입니다. ADMIN_IPS가 비면 config.py가 운영에서 경고합니다.
    Redis를 쓰지 않으므로 Redis가 멈추거나 가득 차도 잠금이 풀리지 않습니다.
  · Redis가 답하지 않으면 세션은 없는 것으로 봅니다 (로그아웃한 세션을 다시 받지 않게) — 경고 로그를 1분에 한 번.

Redis 키 (만료가 붙음):
  shrine:admin:revoked:<sid>      로그아웃한 세션 (PX = 세션이 끝날 때까지)
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

from redis.exceptions import RedisError
from starlette.requests import Request

from .logic.crypto import (
    ADMIN_COOKIE,
    SESSION_MS,
    AdminKeys,
    admin_ip_hash,
    admin_keys,
    admin_password_ok,
    new_session,
    norm_admin_ip,
    parse_cookies,
    sign_session,
)
from .logic.crypto import read_session as _read_session_value
from .logic.crypto import session_cookie as _session_cookie
from .logic.util import now_ms
from .logic.weburl import is_ip
from .redis import key as rkey
from .web.api import origin_host
from .web.net import node_header

__all__ = [
    "ADMIN_COOKIE", "FAILS_PER_IP", "FAILS_TOTAL", "FAIL_WINDOW_MS", "SESSION_MS", "AdminSetup", "add_login_fail",
    "admin_password_ok", "clear_ip_fails", "ip_allowed", "is_admin_path", "log_ip", "login_locked", "new_session",
    "read_session", "revoke", "same_origin", "session_cookie", "setup", "sign_session",
]  # fmt: skip

log = logging.getLogger("shrine.admin")

FAIL_WINDOW_MS = 15 * 60_000
FAILS_PER_IP = 5
FAILS_TOTAL = 50


@dataclass
class AdminSetup:
    enabled: bool
    keys: AdminKeys | None = None
    #: 허용 IP (normIp한 값, 넣은 순서 · 중복 없음). 비면 제한 없음
    ips: list[str] = field(default_factory=list)
    warned_at: float = 0.0


def setup(ctx) -> AdminSetup:
    """admin.ts setup(): ctx에 한 번 만들어 둡니다."""
    st = getattr(ctx, "_p4_admin", None)
    if st is not None:
        return st
    pw = ctx.config.admin_password
    if not pw:
        st = AdminSetup(enabled=False)
    else:
        ips: list[str] = []
        for raw in ctx.config.admin_ips:
            ip = norm_admin_ip(raw)
            if is_ip(ip) and ip not in ips:
                ips.append(ip)
        st = AdminSetup(enabled=True, keys=admin_keys(ctx.config.ticket_secret, pw), ips=ips)
    ctx._p4_admin = st
    return st


def is_admin_path(rel: str) -> bool:
    return rel == "/admin" or rel.startswith("/admin/") or rel == "/api/admin" or rel.startswith("/api/admin/")


def _client_ip(request: Request) -> str:
    return getattr(request.state, "client_ip", None) or (request.client.host if request.client else "unknown")


def ip_allowed(st: AdminSetup, request: Request) -> bool:
    return not st.ips or norm_admin_ip(_client_ip(request)) in st.ips


def log_ip(st: AdminSetup, request: Request) -> str:
    """admin_log에 남기는 관리자 IP 해시 (서버 키로 만든 HMAC 앞 16자)."""
    assert st.keys is not None
    return admin_ip_hash(_client_ip(request), st.keys)


def same_origin(ctx, request: Request) -> bool:
    """기존 API보다 엄격: Sec-Fetch-Site가 있으면 same-origin이어야 하고, Origin이 없으면 Sec-Fetch-Site: same-origin이
    꼭 있어야 하며, Origin이 있으면 PUBLIC_ORIGIN(없으면 Host)과 같아야 합니다."""
    headers = request.scope["headers"]
    site = node_header(headers, "sec-fetch-site")
    if site and site != "same-origin":
        return False
    origin = node_header(headers, "origin")
    if not origin:
        return site == "same-origin"
    if ctx.config.public_origin:
        return origin == ctx.config.public_origin
    host = origin_host(origin)
    return host is not None and host == node_header(headers, "host")


def session_cookie(ctx, request: Request, value: str, max_age_sec: int) -> str:
    return _session_cookie(node_header(request.scope["headers"], "host"), value, max_age_sec, ctx.config.base_path)


def _warn(st: AdminSetup, what: str, e: BaseException) -> None:
    now = time.monotonic()
    if now - st.warned_at > 60:
        st.warned_at = now
        log.warning("[shrine] 운영자 %s을(를) Redis에서 확인하지 못했습니다 (%s): 막는 쪽으로 처리합니다", what, type(e).__name__)


def _revoked_key(sid: str) -> str:
    return rkey("admin", "revoked", sid)


async def read_session(ctx, request: Request) -> dict[str, Any] | None:
    """쿠키의 세션 → {sid, iat, exp} 또는 None (서명 · 모양 · 기간 · 로그아웃 확인)."""
    st = setup(ctx)
    if not st.enabled or st.keys is None:
        return None
    raw = parse_cookies(node_header(request.scope["headers"], "cookie")).get(ADMIN_COOKIE)
    s = _read_session_value(raw, st.keys)
    if s is None:
        return None
    try:
        if await ctx.redis.exists(_revoked_key(s["sid"])):
            return None
    except (RedisError, OSError) as e:
        _warn(st, "세션", e)
        return None
    return s


async def revoke(ctx, s: dict[str, Any]) -> None:
    """로그아웃: 그 세션이 끝날 때까지 받지 않습니다."""
    ttl = int(s["exp"] - now_ms())
    if ttl > 0:
        await ctx.redis.set(_revoked_key(s["sid"]), "1", px=ttl)


# ── 로그인 실패 제한 (프로세스 메모리, admin.ts 194-212와 같음) ──────
#
# Node처럼 이 프로세스 메모리에 둡니다 (워커 1개). 서버를 다시 띄우면 비는 것도 같습니다.
# Redis에 두면 다시 띄워도 '서버 전체 50번' 잠금이 15분 남아, 운영자가 비밀번호를 바꾸고 다시 띄워도 못 들어옵니다.


@dataclass
class _Window:
    start: int = 0
    n: int = 0


def _fails(ctx) -> tuple[dict[str, _Window], _Window]:
    st = getattr(ctx, "_p4_login_fails", None)
    if st is None:
        st = ({}, _Window())
        ctx._p4_login_fails = st
    return st


async def login_locked(ctx, ip_key: str, now: int | None = None) -> bool:
    ip_fails, _ = _fails(ctx)
    n = now_ms() if now is None else now
    all_fails = ctx._p4_login_fails[1]
    if n - all_fails.start >= FAIL_WINDOW_MS:
        all_fails.start, all_fails.n = n, 0
    # ADMIN_IPS가 있으면 ADMIN_IPS 밖은 여기까지 오지 못합니다 (web/admin.py가 404). 그때는 IP별 잠금만
    if all_fails.n >= FAILS_TOTAL and not setup(ctx).ips:
        return True
    f = ip_fails.get(ip_key)
    return f is not None and n - f.start < FAIL_WINDOW_MS and f.n >= FAILS_PER_IP


async def add_login_fail(ctx, ip_key: str, now: int | None = None) -> None:
    ip_fails, all_fails = _fails(ctx)
    n = now_ms() if now is None else now
    all_fails.n += 1
    f = ip_fails.get(ip_key)
    if f is None or n - f.start >= FAIL_WINDOW_MS:
        ip_fails[ip_key] = _Window(n, 1)
    else:
        f.n += 1
    if len(ip_fails) > 5000:
        for k in [k for k, v in ip_fails.items() if n - v.start >= FAIL_WINDOW_MS]:
            del ip_fails[k]


async def clear_ip_fails(ctx, ip_key: str) -> None:
    _fails(ctx)[0].pop(ip_key, None)
