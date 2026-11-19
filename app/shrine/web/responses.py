"""Node(server/http.ts)와 같은 모양의 응답.

Starlette의 Response는 content-length · charset을 스스로 붙이므로 쓰지 않고, 머리글을 적은 그대로 보내는
NodeResponse를 씁니다. 전송 방식도 Node와 같게 맞춥니다:
  · Node의 writeHead + end(body)는 Content-Length 없이 chunked로 갑니다 → 여기서도 content-length를 넣지 않으면
    uvicorn이 chunked로 보냅니다 (HEAD · 304에는 본문도 길이도 없음).
  · 정적 파일 · 약관 문서처럼 Node가 Content-Length를 직접 적는 응답만 길이를 넣습니다.
보안 머리글(CSP 등)은 여기서 붙이지 않습니다. web/front.py가 모든 응답 앞에 붙이고, 응답이 같은 이름을 적으면
그 값으로 바꿉니다 (Node의 setHeader 뒤 writeHead와 같음).
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

import anyio
from starlette.requests import Request
from starlette.responses import Response

from ..jscompat import js_json, js_trim
from .net import node_header

Headers = list[tuple[str, str]]

CHUNK = 64 * 1024


class NodeResponse(Response):
    """머리글을 적은 그대로 (이름 · 순서 · 값) 보내는 응답. file을 주면 그 파일을 나눠 보냅니다."""

    def __init__(self, status: int, headers: Iterable[tuple[str, str]] = (), body: bytes = b"", *, file: Path | None = None):
        self.status_code = status
        self.body = body
        self.file = file
        self.background = None
        self.raw_headers = [(k.encode("latin-1"), v.encode("latin-1")) for k, v in headers]

    async def __call__(self, scope, receive, send) -> None:
        await send({"type": "http.response.start", "status": self.status_code, "headers": self.raw_headers})
        if self.file is None or scope.get("method") == "HEAD":
            await send({"type": "http.response.body", "body": b"" if scope.get("method") == "HEAD" else self.body})
            return
        # 보내다 실패하면(파일이 지워짐 등) 예외가 올라가고 uvicorn이 이 연결만 끊습니다 (uploads.ts pipeFile)
        async with await anyio.open_file(self.file, "rb") as f:
            while True:
                chunk = await f.read(CHUNK)
                more = len(chunk) == CHUNK
                await send({"type": "http.response.body", "body": chunk, "more_body": more})
                if not more:
                    break


def json_response(status: int, body, cache: str = "no-store") -> NodeResponse:
    return NodeResponse(
        status, [("Content-Type", "application/json; charset=utf-8"), ("Cache-Control", cache)], js_json(body).encode("utf-8")
    )


def text_response(status: int, body: str, content_type: str = "text/plain; charset=utf-8") -> NodeResponse:
    return NodeResponse(status, [("Content-Type", content_type), ("Cache-Control", "no-store")], body.encode("utf-8"))


def redirect(to: str, status: int = 302) -> NodeResponse:
    return NodeResponse(status, [("Location", to), ("Cache-Control", "no-store")])


def not_found_html(base: str) -> bytes:
    return f"""<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>찾는 페이지가 없습니다 · 무사배포 기원소</title>
  <link rel="stylesheet" href="{base}/style.css">
</head>
<body class="legal">
  <main class="legal-wrap">
    <p class="lab">404</p>
    <h1>찾는 페이지가 없습니다</h1>
    <p>주소가 바뀌었거나 사당이 내려갔을 수 있어요.</p>
    <p><a href="{base}/">무사배포 기원소로 돌아가기</a></p>
  </main>
</body>
</html>
""".encode()


class AnyMethod:
    """모든 메서드를 받는 Starlette Route용 끝점. (함수를 그대로 주면 Starlette가 GET/HEAD만 받게 바꿉니다)

        Route("/x/{rest:path}", AnyMethod(handler))   # handler(request) -> NodeResponse
    """

    def __init__(self, handler):
        self.handler = handler

    async def __call__(self, scope, receive, send) -> None:
        response = await self.handler(Request(scope, receive))
        await response(scope, receive, send)


def not_found(request: Request | None = None) -> NodeResponse:
    """브라우저가 페이지로 연 주소(GET/HEAD + Accept에 text/html)면 작은 HTML, 아니면 글자 한 줄.

    request 없이 부르면 늘 글자 (Node의 notFound(res)와 같음).
    """
    wants_page = (
        request is not None
        and request.method in ("GET", "HEAD")
        and "text/html" in (node_header(request.scope["headers"], "accept") or "")
    )
    if not wants_page:
        return text_response(404, "Not Found")
    base = request.app.state.ctx.config.base_path
    return NodeResponse(404, [("Content-Type", "text/html; charset=utf-8"), ("Cache-Control", "no-store")], not_found_html(base))


def not_modified(request: Request, etag: str, headers: Headers) -> NodeResponse | None:
    """If-None-Match가 이 ETag와 같으면 304 (원래 머리글 + ETag), 아니면 None."""
    inm = node_header(request.scope["headers"], "if-none-match")
    if not inm:
        return None
    tags = [_strip_weak(js_trim(t)) for t in inm.split(",")]
    if _strip_weak(etag) not in tags and "*" not in tags:
        return None
    return NodeResponse(304, [*headers, ("ETag", etag)])


def _strip_weak(tag: str) -> str:
    return tag[2:] if tag.startswith("W/") else tag
