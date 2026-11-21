"""운영자 화면 (/admin, /admin/*, /api/admin, /api/admin/*) — server/admin.ts handleAdmin (557-626).

  · ADMIN_PASSWORD가 없거나 ADMIN_IPS 밖의 IP면 모든 메서드에 글자 404 (운영자 머리글 없이).
  · 그 밖의 응답에는 좁은 CSP · X-Robots-Tag noindex · Referrer-Policy no-referrer · Cache-Control no-store를 붙입니다.
    보안 머리글 중 같은 이름은 그 자리의 값을 바꿉니다 (front.merge_headers: Node의 setHeader 뒤 writeHead와 같은 순서).
  · 화면: GET/HEAD /admin → 로그인 전 login.html, 로그인 뒤 index.html ({{BASE}} 바꿈) · /admin/ → 302 /admin ·
    /admin/admin.css · /admin/login.js는 누구에게나, /admin/app.js는 로그인한 세션에만. public/admin의 다른 파일은 404.
  · API: POST login은 출처 → 잠금 → 본문(1KB). GET은 세션만, POST는 출처 → 세션 → JSON 본문(8KB, upload만 13,982,040바이트).
    처리는 admin_api.py, 세션 · 잠금 · 출처는 admin_auth.py.
"""

from __future__ import annotations

from pathlib import Path

import anyio
from starlette.requests import Request
from starlette.routing import Route

from .. import admin_api as api
from .. import admin_auth as auth
from ..jscompat import js_json
from ..logic.crypto import SESSION_MS, admin_password_ok, new_session, sign_session
from ..logic.jsstr import utf8_decode
from ..logic.util import now_ms
from .api import read_json
from .responses import AnyMethod, NodeResponse, text_response

ADMIN_CSP = "; ".join(
    [
        "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:", "connect-src 'self'",
        "font-src 'self'", "manifest-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'",
        "frame-ancestors 'none'",
    ]
)  # fmt: skip
ADMIN_HEADERS = [
    ("Content-Security-Policy", ADMIN_CSP),
    ("X-Robots-Tag", "noindex, nofollow, noarchive"),
    ("Referrer-Policy", "no-referrer"),
    ("Cache-Control", "no-store"),
]
PAGE_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8"}


def is_admin_path(rel: str) -> bool:
    return auth.is_admin_path(rel)


def _admin(status: int, headers: list[tuple[str, str]], body: bytes = b"") -> NodeResponse:
    """운영자 머리글 + 이 응답의 머리글 (Cache-Control은 운영자 머리글 자리에 하나만)."""
    out = list(ADMIN_HEADERS)
    for k, v in headers:
        if k.lower() == "cache-control":
            out[3] = ("Cache-Control", v)
        else:
            out.append((k, v))
    return NodeResponse(status, out, body)


def _json(r: api.Reply) -> NodeResponse:
    if r.body is None:
        return _not_found()
    extra = [("Set-Cookie", r.cookie)] if r.cookie is not None else []
    return _admin(
        r.status, [*extra, ("Content-Type", "application/json; charset=utf-8"), ("Cache-Control", "no-store")], js_json(r.body).encode("utf-8")
    )


def _not_found() -> NodeResponse:
    return _admin(404, [("Content-Type", "text/plain; charset=utf-8"), ("Cache-Control", "no-store")], b"Not Found")


async def _send_file(request: Request, name: str) -> NodeResponse:
    ctx = request.app.state.ctx
    ext = name[name.rfind(".") :]
    ctype = PAGE_TYPES.get(ext)
    if ctype is None:
        return _not_found()
    try:
        raw = await anyio.Path(Path(ctx.config.public_dir) / "admin" / name).read_bytes()
    except OSError:
        return _not_found()
    if name.endswith(".html"):
        # BASE_PATH는 config.py에서 /[a-z0-9-] 모양만 받으므로 HTML에 그대로 넣어도 안전합니다
        raw = utf8_decode(raw).replace("{{BASE}}", ctx.config.base_path).encode("utf-8", "surrogatepass")
    return _admin(200, [("Content-Type", ctype), ("Cache-Control", "no-store")], raw)


async def _login(ctx, request: Request) -> NodeResponse:
    if not auth.same_origin(ctx, request):
        return _json(api.fail(403, "origin"))
    now = now_ms()
    ip_key = request.state.ip_hash
    if await auth.login_locked(ctx, ip_key, now):
        return _json(api.fail(429, "locked"))
    body = await read_json(request, 1024)
    if not isinstance(body, dict):
        return _json(api.fail(400, "bad"))
    st = auth.setup(ctx)
    assert st.keys is not None
    if not admin_password_ok(body.get("password"), st.keys):
        await auth.add_login_fail(ctx, ip_key, now)
        await api.log_action(ctx, request, "login-fail")
        return _json(api.fail(401, "password"))
    await auth.clear_ip_fails(ctx, ip_key)
    s = new_session(now)
    cookie = auth.session_cookie(ctx, request, sign_session(s, st.keys), SESSION_MS // 1000)
    await api.log_action(ctx, request, "login")
    return _json(api.ok({"exp": s["exp"]}, cookie=cookie))


async def handle(request: Request) -> NodeResponse:
    ctx = request.app.state.ctx
    st = auth.setup(ctx)
    if not st.enabled or not auth.ip_allowed(st, request):
        return text_response(404, "Not Found")
    base = ctx.config.base_path
    rel = request.scope["path"][len(base) :]
    method = request.method
    read = method in ("GET", "HEAD")

    # 화면: 로그인 전에는 로그인 화면만, 앱 코드(app.js)는 로그인한 세션에만
    if read and rel == "/admin":
        return await _send_file(request, "index.html" if await auth.read_session(ctx, request) else "login.html")
    if read and rel == "/admin/":
        return _admin(302, [("Location", f"{base}/admin"), ("Cache-Control", "no-store")])
    if read and rel in ("/admin/admin.css", "/admin/login.js"):
        return await _send_file(request, rel[len("/admin/") :])
    if read and rel == "/admin/app.js":
        return await _send_file(request, "app.js") if await auth.read_session(ctx, request) else _not_found()
    if not rel.startswith("/api/admin/"):
        return _not_found()

    action = rel[len("/api/admin/") :]
    if method == "POST" and action == "login":
        return await _login(ctx, request)
    if method == "GET":
        s = await auth.read_session(ctx, request)
        if s is None:
            return _json(api.fail(401, "session"))
        return _json(await api.reads(ctx, request, s, action))
    if method != "POST":
        return _not_found()
    if not auth.same_origin(ctx, request):
        return _json(api.fail(403, "origin"))
    s = await auth.read_session(ctx, request)
    if s is None:
        return _json(api.fail(401, "session"))
    body = await read_json(request, api.UPLOAD_BODY_MAX if action == "upload" else api.BODY_MAX)
    if not isinstance(body, dict):
        return _json(api.fail(400, "bad"))
    try:
        return _json(await api.writes(ctx, request, s, action, body))
    except Exception as e:
        r = api.error_reply(e)
        if r is None:
            raise
        return _json(r)


async def _reviewer(ctx, request: Request) -> bool:
    """검토 대기 이미지(/img/shrines/up/…)를 로그인한 운영자(+ 허용 IP)에게도 보여 줍니다 (admin.ts setReviewerCheck)."""
    st = auth.setup(ctx)
    return st.enabled and auth.ip_allowed(st, request) and await auth.read_session(ctx, request) is not None


def install(ctx) -> None:
    """시작할 때: 켜졌다는 안내 한 줄 + 업로드 미리 보기 확인 함수 넣기."""

    @ctx.on_startup
    async def _p4_admin_startup(c) -> None:
        st = auth.setup(c)
        if not st.enabled:
            return
        from ..uploads import set_reviewer_check

        set_reviewer_check(c, lambda request: _reviewer(c, request))
        n = f" (허용 IP {len(st.ips)}개)" if st.ips else ""
        print(f"[shrine] 운영자 화면을 켰습니다: {c.config.base_path}/admin{n}", flush=True)


def routes(base: str, ctx=None) -> list[Route]:
    """모든 메서드를 받는 Starlette Route (FastAPI 라우트는 메서드가 다르면 405를 내므로). ctx를 주면 시작 훅도 겁니다."""
    if ctx is not None:
        install(ctx)
    endpoint = AnyMethod(handle)
    return [
        Route(f"{base}/admin", endpoint, include_in_schema=False),
        Route(f"{base}/admin/{{rest:path}}", endpoint, include_in_schema=False),
        Route(f"{base}/api/admin", endpoint, include_in_schema=False),
        Route(f"{base}/api/admin/{{rest:path}}", endpoint, include_in_schema=False),
    ]
