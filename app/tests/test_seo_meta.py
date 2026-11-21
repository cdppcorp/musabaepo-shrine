"""검색 · 공유 머리 (첫 화면 · 약관/처리방침): 정식 주소 · 공유 카드 · robots · 아이콘 파일 (DB 없이 도는 단위 시험)."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from starlette.requests import Request

from shrine.config import load_config
from shrine.web.pages import STATIC_RE, TYPES, Pages

DB = "postgresql://u:p@127.0.0.1:5432/db"
ORIGIN = "https://musabaepo.example.com"


def pages(**env) -> Pages:
    return Pages(load_config({"DATABASE_URL": DB, "PUBLIC_ORIGIN": ORIGIN, **env}).config)


def meta(html: str, attr: str, name: str) -> str:
    m = re.search(rf'<meta {attr}="{re.escape(name)}" content="([^"]*)">', html)
    assert m, f"{attr}={name} 없음"
    return m.group(1)


def get(path: str = "/") -> Request:
    return Request({"type": "http", "method": "GET", "path": path, "headers": [], "query_string": b""})


@pytest.mark.parametrize("base", ["", "/shrine"])
def test_index_absolute_canonical_and_share_card(base):
    html = pages(BASE_PATH=base, ALLOW_INDEXING="true").index_body.decode("utf-8")
    home = f"{ORIGIN}{base}/"
    assert "{{" not in html
    assert f'<link rel="canonical" href="{home}">' in html
    assert meta(html, "property", "og:url") == home
    assert meta(html, "property", "og:image") == f"{ORIGIN}{base}/img/meta/og-image.png"
    assert meta(html, "property", "og:type") == "website"
    assert meta(html, "property", "og:locale") == "ko_KR"
    assert (meta(html, "property", "og:image:width"), meta(html, "property", "og:image:height")) == ("1200", "630")
    assert meta(html, "name", "twitter:card") == "summary_large_image"
    assert meta(html, "name", "robots") == "index, follow, max-image-preview:large"
    ld = json.loads(re.search(r'<script type="application/ld\+json">(.*?)</script>', html).group(1))
    assert ld["@type"] == "WebSite" and ld["url"] == home
    assert f'<link rel="icon" href="{base}/favicon.ico"' in html
    assert f'<link rel="apple-touch-icon" href="{base}/apple-touch-icon.png">' in html
    assert f'<link rel="manifest" href="{base}/site.webmanifest">' in html


def test_robots_meta_follows_allow_indexing():
    on = pages(ALLOW_INDEXING="true").index_body.decode("utf-8")
    off = pages(ALLOW_INDEXING="false").index_body.decode("utf-8")
    assert meta(on, "name", "robots") == "index, follow, max-image-preview:large"
    assert meta(off, "name", "robots") == "noindex, nofollow"
    # 기본(설정 없음)은 꺼짐
    assert meta(pages().index_body.decode("utf-8"), "name", "robots") == "noindex, nofollow"


@pytest.mark.parametrize("name", ["privacy", "terms"])
async def test_legal_canonical_robots_and_etag(name):
    for indexing, robots in (("true", "index, follow, max-image-preview:large"), ("false", "noindex, nofollow")):
        p = pages(BASE_PATH="/shrine", ALLOW_INDEXING=indexing)
        r = await p.legal(get(), f"{name}.html")
        html = r.body.decode("utf-8")
        headers = {k.decode().lower(): v.decode() for k, v in r.raw_headers}
        assert r.status_code == 200 and "{{" not in html
        assert f'<link rel="canonical" href="{ORIGIN}/shrine/{name}">' in html
        assert meta(html, "name", "robots") == robots
        assert headers["content-length"] == str(len(r.body))
        # 채운 내용이 바뀌면 ETag도 바뀜 (robots 값이 다르면 다른 ETag)
        if indexing == "true":
            etag_on = headers["etag"]
        else:
            assert headers["etag"] != etag_on


async def test_head_links_are_served_static_files():
    """머리에 건 아이콘 · 공유 이미지 · 매니페스트가 실제로 있고 정적 파일 허용 목록에 들어 있는지."""
    p = pages(ALLOW_INDEXING="true")
    html = p.index_body.decode("utf-8")
    head = html[: html.index("</head>")]
    urls = set(re.findall(r'(?:href|content)="(?:' + re.escape(ORIGIN) + r')?(/[^"]*\.(?:ico|png|webmanifest))"', head))
    assert {"/favicon.ico", "/apple-touch-icon.png", "/site.webmanifest", "/img/meta/og-image.png"} <= urls
    for rel in sorted(urls):
        r = await p.static(get(rel), rel)
        ctype = dict((k.decode().lower(), v.decode()) for k, v in r.raw_headers)["content-type"]
        assert r.status_code == 200, rel
        assert ctype == TYPES[Path(rel).suffix], rel
    # 매니페스트 안 아이콘도 (매니페스트 기준 상대 주소)
    manifest = json.loads(Path(p.public_dir, "site.webmanifest").read_text(encoding="utf-8"))
    for icon in manifest["icons"]:
        rel = "/" + icon["src"]
        assert STATIC_RE.fullmatch(rel) and Path(p.public_dir, *rel.split("/")).is_file(), rel


def test_sitemap_lists_home_and_legal_with_origin():
    xml = pages(ALLOW_INDEXING="true").sitemap()
    assert [f"{ORIGIN}/", f"{ORIGIN}/privacy", f"{ORIGIN}/terms"] == re.findall(r"<loc>([^<]+)</loc>", xml)
