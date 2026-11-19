"""운영자 화면 자리 (/admin, /admin/*, /api/admin, /api/admin/*). P4에서 채웁니다.

지금은 ADMIN_PASSWORD가 없을 때의 Node와 같게 모든 메서드에 글자 404를 냅니다 (admin.ts 104-107, 583).
P4에서는 이 파일의 handle()을 admin.ts handleAdmin처럼 바꾸면 됩니다. 운영자 응답은 보안 머리글 중
CSP · X-Robots-Tag · Referrer-Policy를 같은 이름으로 적어 덮어씁니다 (front.merge_headers).
"""

from __future__ import annotations

from starlette.requests import Request
from starlette.routing import Route

from .responses import AnyMethod, NodeResponse, text_response


def is_admin_path(rel: str) -> bool:
    return rel == "/admin" or rel.startswith("/admin/") or rel == "/api/admin" or rel.startswith("/api/admin/")


async def handle(request: Request) -> NodeResponse:
    return text_response(404, "Not Found")


def routes(base: str) -> list[Route]:
    """모든 메서드를 받는 Starlette Route (FastAPI 라우트는 메서드가 다르면 405를 내므로)."""
    endpoint = AnyMethod(handle)
    return [
        Route(f"{base}/admin", endpoint, include_in_schema=False),
        Route(f"{base}/admin/{{rest:path}}", endpoint, include_in_schema=False),
        Route(f"{base}/api/admin", endpoint, include_in_schema=False),
        Route(f"{base}/api/admin/{{rest:path}}", endpoint, include_in_schema=False),
    ]
