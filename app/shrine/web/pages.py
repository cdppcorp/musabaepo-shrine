"""첫 화면 · 약관/처리방침 · 사이트맵 · 정적 파일 (http.ts 50-56, 270-333, 393-406, 434).

FastAPI의 StaticFiles는 머리글 · 끝 빗금 · HEAD 처리가 Node와 달라 쓰지 않고 직접 보냅니다.
  · 정적 파일: STATIC_RE에 맞고 확장자가 TYPES에 있는 것만. 약한 ETag W/"<크기 16진>-<floor(mtimeMs) 16진>",
    Last-Modified, Content-Length, .js/.css는 no-cache · 이미지는 하루 캐시, 304 · HEAD.
  · 첫 화면: 시작할 때 한 번 읽어 {{BASE}} · {{ORIGIN}} · {{TURNSTILE_SITE_KEY}}를 바꾸고 강한 ETag(sha1 앞 16자).
"""

from __future__ import annotations

import base64
import email.utils
import hashlib
import math
import os
import posixpath
import re
import stat
from pathlib import Path

import anyio
from fastapi import APIRouter
from starlette.requests import Request

from ..config import Config
from .responses import NodeResponse, not_found, not_modified, redirect, text_response

TYPES = {
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}
#: public/ 아래에서 내보내는 파일 (그 밖은 모두 404)
STATIC_RE = re.compile(
    r"/(?:js/[a-z0-9-]+\.js|style\.css|favicon\.(?:ico|svg)|apple-touch-icon\.png|img/[a-z0-9/_-]+\.(?:png|jpe?g|webp|svg))"
)
#: 약관 · 처리방침: 주소 → public/legal 파일
LEGAL = {"/privacy": "privacy.html", "/terms": "terms.html"}
LEGAL_FILE_RE = re.compile(r"/legal/(privacy|terms)\.html")

READ = ["GET", "HEAD"]


def html_escape(s: str) -> str:
    return re.sub(r"[&<>\"']", lambda m: f"&#{ord(m.group())};", s)


def mtime_ms(st: os.stat_result) -> float:
    """Node의 stats.mtimeMs와 같은 계산 (초 × 1000 + 나노초 / 1e6, 부동소수)."""
    sec, nsec = divmod(st.st_mtime_ns, 10**9)
    return sec * 1e3 + nsec / 1e6


def file_etag(size: int, mtime: float) -> str:
    """크기 + 고친 시각으로 만든 약한 ETag."""
    return f'W/"{size:x}-{math.floor(mtime):x}"'


def http_date(mtime: float) -> str:
    """Date.prototype.toUTCString (초 아래는 버림)."""
    return email.utils.formatdate(math.floor(mtime / 1000), usegmt=True)


class Pages:
    def __init__(self, config: Config):
        self.config = config
        self.base = config.base_path
        self.public_dir = os.path.normpath(config.public_dir)
        self.legal_dir = os.path.join(self.public_dir, "legal")
        template = Path(self.public_dir, "index.html").read_text(encoding="utf-8")
        html = (
            template.replace("{{BASE}}", self.base)
            .replace("{{ORIGIN}}", html_escape(config.public_origin))
            .replace("{{TURNSTILE_SITE_KEY}}", config.turnstile_site_key)
        )
        self.index_body = html.encode("utf-8")
        digest = base64.urlsafe_b64encode(hashlib.sha1(self.index_body).digest()).decode("ascii").rstrip("=")
        self.index_etag = f'"{digest[:16]}"'

    # ── 첫 화면 ──

    async def index(self, request: Request) -> NodeResponse:
        headers = [("Content-Type", "text/html; charset=utf-8"), ("Cache-Control", "no-cache")]
        return not_modified(request, self.index_etag, headers) or NodeResponse(
            200, [*headers, ("ETag", self.index_etag)], self.index_body
        )

    # ── 약관 · 처리방침 ──

    async def legal(self, request: Request, name: str) -> NodeResponse:
        """문서 안 링크는 상대 주소라서 그대로 보냅니다. 파일이 없으면 404."""
        path = os.path.join(self.legal_dir, name)
        try:
            st = await anyio.to_thread.run_sync(os.stat, path)
            if not stat.S_ISREG(st.st_mode):
                return not_found(request)
            body = await anyio.Path(path).read_bytes()
        except OSError:
            return not_found(request)
        mtime = mtime_ms(st)
        etag = file_etag(st.st_size, mtime)
        headers = [("Content-Type", "text/html; charset=utf-8"), ("Cache-Control", "no-cache"), ("Last-Modified", http_date(mtime))]
        return not_modified(request, etag, headers) or NodeResponse(
            200, [*headers, ("ETag", etag), ("Content-Length", str(len(body)))], body
        )

    # ── 정적 파일 ──

    async def static(self, request: Request, rel: str) -> NodeResponse:
        ext = posixpath.splitext(rel)[1].lower()
        content_type = TYPES.get(ext)
        if not content_type or not STATIC_RE.fullmatch(rel):
            return not_found(request)
        # path.join + normalize 뒤 public/ 밖이면 404 (경로 탈출 방지)
        file = os.path.normpath(os.path.join(self.public_dir, *rel.split("/")))
        if not file.startswith(self.public_dir + os.sep):
            return not_found(request)
        try:
            st = await anyio.to_thread.run_sync(os.stat, file)
        except OSError:
            return not_found(request)
        if not stat.S_ISREG(st.st_mode):
            return not_found(request)
        mtime = mtime_ms(st)
        # 스크립트 · 스타일은 매번 다시 확인(바뀐 게 없으면 304), 이미지는 하루 캐시
        headers = [
            ("Content-Type", content_type),
            ("Cache-Control", "no-cache" if ext in (".js", ".css") else "public, max-age=86400"),
            ("Last-Modified", http_date(mtime)),
        ]
        etag = file_etag(st.st_size, mtime)
        return not_modified(request, etag, headers) or NodeResponse(
            200, [*headers, ("ETag", etag), ("Content-Length", str(st.st_size))], file=Path(file)
        )

    # ── 사이트맵 ──

    def sitemap(self) -> str:
        urls = [
            f"  <url><loc>{html_escape(f'{self.config.public_origin}{self.base}{p}')}</loc></url>"
            for p in ("/", "/privacy", "/terms")
        ]
        return (
            '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            + "\n".join(urls)
            + "\n</urlset>\n"
        )


def build_router(pages: Pages) -> APIRouter:
    """BASE_PATH 아래 경로 (prefix는 routes.py가 붙입니다)."""
    router = APIRouter()
    config = pages.config

    @router.api_route("/", methods=READ, include_in_schema=False)
    async def index(request: Request):
        return await pages.index(request)

    @router.api_route("/privacy", methods=READ, include_in_schema=False)
    async def privacy(request: Request):
        return await pages.legal(request, LEGAL["/privacy"])

    @router.api_route("/terms", methods=READ, include_in_schema=False)
    async def terms(request: Request):
        return await pages.legal(request, LEGAL["/terms"])

    # 문서 파일 주소로 들어오면 정식 주소로 (문서 안 상대 링크가 맞게)
    @router.api_route("/legal/{name}", methods=READ, include_in_schema=False)
    async def legal_file(request: Request, name: str):
        m = LEGAL_FILE_RE.fullmatch(f"/legal/{name}")
        if m:
            return redirect(f"{pages.base}/{m.group(1)}", 301)
        return await pages.static(request, f"/legal/{name}")

    @router.api_route("/sitemap.xml", methods=READ, include_in_schema=False)
    async def sitemap(request: Request):
        if config.allow_indexing and config.public_origin:
            return text_response(200, pages.sitemap(), "application/xml; charset=utf-8")
        return await pages.static(request, "/sitemap.xml")

    return router
