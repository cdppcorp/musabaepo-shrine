"""Node 서버(기준)와 Python 서버에 같은 요청을 보내 상태 · 머리글 · 본문을 바이트 단위로 맞춰 봅니다.

- 저장소의 server/ · public/을 시험 시작 때 임시 폴더로 복사하고(시험용 이미지 등을 더 넣음) 두 서버가 같은 파일을 봅니다.
- Node: node server/main.ts (PORT 3330, 새 DATA_DIR). Python: python -m shrine (PORT 3331, 새 PostgreSQL DB · Redis DB).
- 빼는 머리글: Date · Server · Connection · Keep-Alive (hop-by-hop). /healthz의 uptime, security.txt의 Expires는 맞춰서 비교.
- 아직 옮기지 않은 기능(/api/world GET, /api/enter, 등록소, 업로드, /go, 운영자 로그인, WebSocket)은 넣지 않았습니다.
- node · PostgreSQL · Redis 중 하나라도 없으면 건너뜁니다. 접속 주소는 SHRINE_TEST_PG · SHRINE_TEST_REDIS로 바꿀 수 있습니다
  (기본: 개발용 컨테이너 musabaepo-dev-pg 127.0.0.1:55432, musabaepo-dev-redis 127.0.0.1:56379).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import shutil
import sys
from pathlib import Path

import pytest

from _parity_util import Req, RawResponse, base_env, send_raw, start, stop, tail, wait_ready

REPO = Path(__file__).resolve().parents[2]
APP = REPO / "app"
NODE = shutil.which("node")
NODE_PORT = 3330
PY_PORT = 3331
PG_ADMIN = os.environ.get("SHRINE_TEST_PG", "postgresql://postgres:dev@127.0.0.1:55432/postgres")
REDIS_URL = os.environ.get("SHRINE_TEST_REDIS", "redis://127.0.0.1:56379/13")

VARIANTS: dict[str, dict[str, str]] = {
    # 기본: 도메인 루트, 검색 막음, 연락처 없음
    "root": {},
    # 경로 앞부분 + 검색 허용 + 공개 주소 · 연락처 (사이트맵 · security.txt · wss CSP)
    "base": {
        "BASE_PATH": "/shrine",
        "ALLOW_INDEXING": "true",
        "PUBLIC_ORIGIN": "https://shrine.test.invalid",
        "CONTACT_EMAIL": "ops@shrine.test.invalid",
        "TURNSTILE_SITE_KEY": "0x4AAAAparity",
    },
    # 운영 모드 (HSTS 머리글, 운영 필수 값을 모두 채움). 시험용 값이며 실제 비밀이 아닙니다
    "prod": {
        "NODE_ENV": "production",
        "PUBLIC_ORIGIN": "https://shrine.parity-check.kr",
        "SHRINE_DOMAIN": "shrine.parity-check.kr",
        "TICKET_SECRET": "9f2c71e04ab8d35c6e19f0a7b42d8c53",
        "TURNSTILE_SITE_KEY": "0x4AAAAAAAparitySiteKey",
        "TURNSTILE_SECRET": "0x4AAAAAAAparitySecretKey",
        "CONTACT_EMAIL": "ops@parity-check.kr",
        "ALLOW_INDEXING": "true",
    },
}

# 시험용 정적 파일 (public/ 사본에만 넣음)
EXTRA_FILES = {
    "img/parity/dot.png": b"\x89PNG\r\n\x1a\n" + b"\x00" * 40,
    "img/parity/a.svg": b'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    "img/parity/deep/x_y-1.webp": b"RIFF\x00\x00\x00\x00WEBP",
    "img/parity/.png": b"dotfile",
    "img/parity/c.jpeg": b"\xff\xd8\xff\xe0",
    "favicon.ico": b"\x00\x00\x01\x00",
    "favicon.svg": b"<svg/>",
    "apple-touch-icon.png": b"\x89PNG",
    "js/parity-x.js": b"export const x = 1\n",
}
EXTRA_DIRS = ["img/parity-dir.png"]


# ── 준비 ──


def _pg_ready() -> str | None:
    try:
        import asyncpg
    except ImportError:
        return "asyncpg 없음"

    async def check() -> None:
        conn = await asyncpg.connect(PG_ADMIN, timeout=3)
        await conn.close()

    try:
        asyncio.run(check())
    except Exception as e:
        return f"PostgreSQL에 연결하지 못함 ({type(e).__name__})"
    return None


def _redis_ready() -> str | None:
    import redis

    try:
        redis.Redis.from_url(REDIS_URL, socket_connect_timeout=3).ping()
    except Exception as e:
        return f"Redis에 연결하지 못함 ({type(e).__name__})"
    return None


@pytest.fixture(scope="module")
def infra(tmp_path_factory):
    if NODE is None:
        pytest.skip("node가 없어 Node 기준 서버를 띄울 수 없습니다")
    for why in (_pg_ready(), _redis_ready()):
        if why:
            pytest.skip(f"{why} — docker의 musabaepo-dev-pg · musabaepo-dev-redis를 띄우거나 SHRINE_TEST_PG · SHRINE_TEST_REDIS를 정하세요")

    import asyncpg
    from sqlalchemy.engine import make_url

    root = tmp_path_factory.mktemp("parity")
    snap = root / "repo"
    shutil.copytree(REPO / "server", snap / "server")
    shutil.copytree(REPO / "public", snap / "public")
    shutil.copy2(REPO / "package.json", snap / "package.json")
    shutil.copytree(REPO / "node_modules" / "ws", snap / "node_modules" / "ws")
    for rel, data in EXTRA_FILES.items():
        p = snap / "public" / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    for rel in EXTRA_DIRS:
        (snap / "public" / rel).mkdir(parents=True, exist_ok=True)

    # 운영 모드 검사를 통과하는 무작위 비밀번호의 전용 역할 + 새 DB
    suffix = secrets.token_hex(4)
    role, db_name, password = f"shrine_parity_{suffix}", f"shrine_parity_{suffix}", secrets.token_urlsafe(24)

    async def setup() -> None:
        conn = await asyncpg.connect(PG_ADMIN)
        try:
            await conn.execute(f"CREATE ROLE {role} LOGIN PASSWORD '{password}'")
            await conn.execute(f"CREATE DATABASE {db_name} OWNER {role}")
        finally:
            await conn.close()

    async def teardown() -> None:
        conn = await asyncpg.connect(PG_ADMIN)
        try:
            await conn.execute(f"DROP DATABASE IF EXISTS {db_name} WITH (FORCE)")
            await conn.execute(f"DROP ROLE IF EXISTS {role}")
        finally:
            await conn.close()

    asyncio.run(setup())
    admin = make_url(PG_ADMIN)
    db_url = admin.set(username=role, password=password, database=db_name).render_as_string(hide_password=False)
    try:
        yield {"root": root, "snap": snap, "db_url": db_url}
    finally:
        asyncio.run(teardown())


@pytest.fixture(scope="module", params=list(VARIANTS))
def servers(request, infra):
    import redis

    variant = request.param
    root: Path = infra["root"]
    work = root / variant
    work.mkdir()
    redis.Redis.from_url(REDIS_URL).flushdb()
    common = {**base_env(), **VARIANTS[variant], "HOST": "127.0.0.1", "TRUST_PROXY": "true"}
    node_log, py_log = work / "node.log", work / "python.log"
    node = start(
        [NODE, "--disable-warning=ExperimentalWarning", "server/main.ts"],
        infra["snap"],
        {**common, "PORT": str(NODE_PORT), "DATA_DIR": str(work / "node-data")},
        node_log,
    )
    py = start(
        [sys.executable, "-m", "shrine"],
        APP,
        {
            **common,
            "PORT": str(PY_PORT),
            "DATA_DIR": str(work / "py-data"),
            "DATABASE_URL": infra["db_url"],
            "REDIS_URL": REDIS_URL,
            "PUBLIC_DIR": str(infra["snap"] / "public"),
            "PYTHONIOENCODING": "utf-8",
        },
        py_log,
    )
    try:
        wait_ready(NODE_PORT, node, node_log)
        wait_ready(PY_PORT, py, py_log)
        yield {"variant": variant, "base": VARIANTS[variant].get("BASE_PATH", ""), "node_log": node_log, "py_log": py_log}
    finally:
        stop(node)
        stop(py)


# ── 요청 목록 ──

HTML = ("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")


def cases(b: str, variant: str) -> list[Req]:
    """b = BASE_PATH. '@etag:<주소>'는 Node에서 그 주소의 ETag를 먼저 받아 넣습니다."""
    out = [
        # 첫 화면
        Req("GET", f"{b}/", [HTML]),
        Req("HEAD", f"{b}/", [HTML]),
        Req("GET", f"{b}/?utm=x", []),
        Req("GET", f"{b}/", [("If-None-Match", f"@etag:{b}/")]),
        Req("HEAD", f"{b}/", [("If-None-Match", f"@etag:{b}/")]),
        Req("GET", f"{b}/", [("If-None-Match", f"@weak:{b}/")]),
        Req("GET", f"{b}/", [("If-None-Match", '"nope"')]),
        Req("PUT", f"{b}/", []),
        Req("OPTIONS", f"{b}/", []),
        Req("PROPFIND", f"{b}/", [HTML]),
        # 정적 파일
        Req("GET", f"{b}/style.css", []),
        Req("HEAD", f"{b}/style.css", []),
        Req("GET", f"{b}/style.css", [("If-None-Match", f"@etag:{b}/style.css")]),
        Req("GET", f"{b}/style.css", [("If-None-Match", f"@strong:{b}/style.css")]),
        Req("GET", f"{b}/style.css", [("If-None-Match", f"@list:{b}/style.css")]),
        Req("GET", f"{b}/style.css", [("If-None-Match", "*")]),
        Req("HEAD", f"{b}/style.css", [("If-None-Match", f"@etag:{b}/style.css")]),
        Req("GET", f"{b}/style.css", [("If-None-Match", 'W/"0-0"')]),
        Req("GET", f"{b}/style.css?v=2", []),
        Req("GET", f"{b}/js/main.js", []),
        Req("GET", f"{b}/js/parity-x.js", []),
        Req("GET", f"{b}/img/parity/dot.png", []),
        Req("HEAD", f"{b}/img/parity/dot.png", []),
        Req("GET", f"{b}/img/parity/dot.png", [("If-None-Match", f"@etag:{b}/img/parity/dot.png")]),
        Req("GET", f"{b}/img/parity/a.svg", []),
        Req("GET", f"{b}/img/parity/c.jpeg", []),
        Req("GET", f"{b}/img/parity/deep/x_y-1.webp", []),
        Req("GET", f"{b}/img/parity//dot.png", []),
        Req("GET", f"{b}/favicon.ico", []),
        Req("GET", f"{b}/favicon.svg", []),
        Req("GET", f"{b}/apple-touch-icon.png", []),
        Req("GET", f"{b}/img/parity/.png", [HTML]),
        Req("GET", f"{b}/img/parity-dir.png", [HTML]),
        Req("GET", f"{b}/js/missing.js", []),
        Req("GET", f"{b}/js/Main.js", []),
        Req("GET", f"{b}/STYLE.CSS", []),
        Req("GET", f"{b}/style.css/", []),
        Req("GET", f"{b}/index.html", [HTML]),
        Req("GET", f"{b}/legal/privacy.htm", []),
        Req("GET", f"{b}/admin/app.js", []),
        Req("GET", f"{b}/img/shrines/.gitkeep", []),
        Req("POST", f"{b}/style.css", []),
        # 경로 정리 · 탈출
        Req("GET", f"{b}/%2e%2e/%2e%2e/etc/passwd", [HTML]),
        Req("GET", f"{b}/js/..%2f..%2fserver/main.ts", []),
        Req("GET", f"{b}/js/%2e%2e/style.css", []),
        Req("GET", f"{b}/js/%2E%2E/style.css", []),
        Req("GET", f"{b}/img/../../server/main.ts", []),
        Req("GET", f"{b}/./style.css", []),
        Req("GET", f"{b}/js/./main.js", []),
        Req("GET", f"{b}/js/main.js/..", []),
        Req("GET", f"{b}/style%2ecss", []),
        Req("GET", f"{b}/style.css%00", []),
        Req("GET", f"{b}/%73tyle.css", []),
        Req("GET", "/a/b/../../style.css" if not b else f"{b}/a/../style.css", []),
        Req("GET", "//style.css", []),
        Req("GET", "//evil.example/style.css", []),
        Req("GET", "///", []),
        Req("GET", "//", []),
        Req("GET", "//h:99999/x", []),
        # 날것의 비 ASCII 바이트: 두 서버 모두 HTTP 파서가 400으로 거절 (본문 · 머리글은 서버 프로그램마다 다름 → 상태만 비교)
        Req("GET", f"{b}/caf\u00e9", [HTML], parser_reject=True),
        Req("GET", f"{b}/a^b", []),
        # 약관 · 처리방침
        Req("GET", f"{b}/privacy", [HTML]),
        Req("HEAD", f"{b}/privacy", []),
        Req("GET", f"{b}/privacy", [("If-None-Match", f"@etag:{b}/privacy")]),
        Req("GET", f"{b}/terms", []),
        Req("GET", f"{b}/terms", [("If-None-Match", "*")]),
        Req("GET", f"{b}/privacy/", [HTML]),
        Req("POST", f"{b}/privacy", [HTML]),
        Req("GET", f"{b}/legal/privacy.html", []),
        Req("HEAD", f"{b}/legal/terms.html", []),
        Req("GET", f"{b}/legal/terms.html?x=1", []),
        Req("POST", f"{b}/legal/terms.html", []),
        Req("GET", f"{b}/legal/other.html", [HTML]),
        Req("GET", f"{b}/legal/", []),
        # 404 모양 (Accept)
        Req("GET", f"{b}/nope", [HTML]),
        Req("HEAD", f"{b}/nope", [HTML]),
        Req("GET", f"{b}/nope", []),
        Req("GET", f"{b}/nope", [("Accept", "application/json")]),
        Req("GET", f"{b}/nope", [("Accept", "application/json"), ("Accept", "text/html")], name="Accept 두 줄"),
        Req("POST", f"{b}/nope", [HTML]),
        Req("DELETE", f"{b}/nope", []),
        Req("GET", "/totally/elsewhere", [HTML]),
        # 아직 옮기지 않은 GET 라우트에 HEAD (Node도 정적 → 404)
        Req("HEAD", f"{b}/api/world", [HTML]),
        Req("HEAD", f"{b}/api/posts", []),
        Req("POST", f"{b}/api/world", []),
        # 운영자 화면 (ADMIN_PASSWORD 없음 → 모든 메서드 글자 404)
        Req("GET", f"{b}/admin", [HTML]),
        Req("GET", f"{b}/admin/", [HTML]),
        Req("HEAD", f"{b}/admin/login", [HTML]),
        Req("POST", f"{b}/api/admin/login", []),
        Req("GET", f"{b}/api/admin", []),
        Req("GET", f"{b}/adminx", [HTML]),
        # 검색 · 보안 안내
        Req("GET", "/robots.txt", []),
        Req("HEAD", "/robots.txt", []),
        Req("POST", "/robots.txt", []),
        Req("DELETE", "/robots.txt?x", []),
        Req("GET", f"{b}/robots.txt" if b else "/robots.txt/", []),
        Req("GET", f"{b}/sitemap.xml", []),
        Req("HEAD", f"{b}/sitemap.xml", []),
        Req("POST", f"{b}/sitemap.xml", []),
        Req("GET", "/.well-known/security.txt", [HTML]),
        Req("HEAD", "/.well-known/security.txt", []),
        Req("POST", "/.well-known/security.txt", [HTML]),
        Req("GET", f"{b}/.well-known/security.txt" if b else "/.well-known/security.txt/", []),
        # 헬스 체크
        Req("GET", "/healthz", []),
        Req("HEAD", "/healthz", []),
        Req("GET", f"{b}/healthz", []),
        Req("GET", "/healthz?x=1", []),
        Req("POST", "/healthz", []),
        Req("GET", "/healthz/", []),
        # 머리글 처리: Host 정리(CSP ws 주소). 50개 넘는 머리글은 일부러 다름 → test_too_many_headers_intended_difference
        Req("GET", f"{b}/nope", [("Host", 'EXAMPLE.org:8080"<x>')], name="Host 정리"),
        Req("GET", f"{b}/nope", [("Host", "")], name="빈 Host"),
        Req("GET", f"{b}/nope", [(f"X-Fill-{i}", "1") for i in range(40)] + [HTML], name="머리글 41개"),
        Req("GET", f"{b}/style.css", [("If-None-Match", "x"), ("If-None-Match", "@etag:" + f"{b}/style.css")], name="If-None-Match 두 줄"),
    ]
    if b:
        out += [
            Req("GET", "/", [HTML]),
            Req("POST", "/", []),
            Req("GET", b, []),
            Req("GET", f"{b}?x=1", []),
            Req("GET", f"{b}x", [HTML]),
            Req("GET", "/style.css", []),
            Req("GET", "/privacy", [HTML]),
            Req("GET", f"{b}{b}/", []),
        ]
    else:
        out += [
            Req("GET", "/shrine", []),
            Req("GET", "/shrine/", []),
            Req("GET", "/shrine/privacy?x=1", []),
            Req("POST", "/shrine/style.css", []),
            Req("GET", "/shrine%2fx", [HTML]),
            Req("GET", "/shrinex", [HTML]),
            Req("GET", "/Shrine/", []),
        ]
    return out


# ── 비교 ──

COMMON = [("User-Agent", "parity-test")]


def build_headers(req: Req, xff: str, etags: dict[str, str]) -> list[tuple[str, str]]:
    hdrs: list[tuple[str, str]] = []
    if not any(k.lower() == "host" for k, _ in req.headers):
        hdrs.append(("Host", "shrine.local"))
    hdrs += [*COMMON, ("X-Forwarded-For", xff)]
    for k, v in req.headers:
        if v.startswith(("@etag:", "@weak:", "@strong:", "@list:")):
            kind, _, path = v.partition(":")
            etag = etags[path]
            v = {
                "@etag": etag,
                "@weak": etag if etag.startswith("W/") else f"W/{etag}",
                "@strong": etag.removeprefix("W/"),
                "@list": f'"zzz", {etag} ,W/"x"',
            }[kind]
        if k.lower() == "host" and v == "":
            hdrs.append((k, v))
            continue
        hdrs.append((k, v))
    return hdrs


def normalize_body(target: str, r: RawResponse) -> bytes:
    path = target.split("?")[0]
    if path.endswith("/healthz") and r.body and (r.header("content-type") or "").startswith("application/json"):
        data = json.loads(r.body)
        assert isinstance(data.get("uptime"), int)
        data["uptime"] = 0
        return json.dumps(data).encode()
    if path == "/.well-known/security.txt" and r.status == 200:
        return re.sub(rb"Expires: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", b"Expires: X", r.body)
    return r.body


def compare(req: Req, node: RawResponse, py: RawResponse) -> list[str]:
    problems = []
    if node.status != py.status:
        problems.append(f"상태 Node {node.status} / Python {py.status}")
    nh, ph = node.normalized_headers(), py.normalized_headers()
    if nh != ph:
        only_node = [h for h in nh if h not in ph]
        only_py = [h for h in ph if h not in nh]
        problems.append(f"머리글 Node만 {only_node} / Python만 {only_py}")
    nb, pb = normalize_body(req.target, node), normalize_body(req.target, py)
    if nb != pb:
        problems.append(f"본문 Node {len(nb)}B {nb[:120]!r} / Python {len(pb)}B {pb[:120]!r}")
    return problems


def collect_etags(reqs: list[Req], xff: str) -> dict[str, str]:
    paths = {v.partition(":")[2] for r in reqs for _, v in r.headers if v.startswith(("@etag:", "@weak:", "@strong:", "@list:"))}
    out = {}
    for p in paths:
        r = send_raw(NODE_PORT, "GET", p, [("Host", "shrine.local"), ("X-Forwarded-For", xff)])
        etag = r.header("etag")
        assert etag, f"{p}에 ETag가 없습니다 (Node {r.status})"
        out[p] = etag
    return out


def test_parity(servers):
    variant, b = servers["variant"], servers["base"]
    xff = f"10.9.{list(VARIANTS).index(variant)}.1"
    reqs = cases(b, variant)
    etags = collect_etags(reqs, xff)
    failures = []
    for req in reqs:
        hdrs = build_headers(req, xff, etags)
        node = send_raw(NODE_PORT, req.method, req.target, hdrs)
        py = send_raw(PY_PORT, req.method, req.target, hdrs)
        problems = compare(req, node, py)
        if req.parser_reject:
            problems = [] if node.status == py.status == 400 else [f"상태 Node {node.status} / Python {py.status} (둘 다 400이어야 함)"]
        if problems:
            failures.append(f"[{variant}] {req.label()}\n    " + "\n    ".join(problems))
    assert not failures, (
        f"{len(failures)}/{len(reqs)}건이 다릅니다:\n" + "\n".join(failures) + f"\n--- python.log ---\n{tail(servers['py_log'], 15)}"
    )


@pytest.mark.parametrize("servers", ["root"], indirect=True)
def test_rate_limit_and_healthz_exempt(servers):
    """IP(그날 해시)당 1분 240번까지, 241번째는 429. /healthz는 세지 않고, 다른 IP는 따로 셉니다."""
    hdrs = [("Host", "shrine.local"), ("X-Forwarded-For", "10.77.0.1")]
    results = {}
    for port in (NODE_PORT, PY_PORT):
        statuses = [send_raw(port, "GET", "/robots.txt", hdrs).status for _ in range(240)]
        over = send_raw(port, "GET", "/nope", hdrs)
        health = send_raw(port, "GET", "/healthz", hdrs)
        other = send_raw(port, "GET", "/robots.txt", [("Host", "shrine.local"), ("X-Forwarded-For", "10.77.0.2")])
        # X-Forwarded-For 첫 값만 봅니다 (뒤에 붙은 프록시 주소는 무시)
        chained = send_raw(port, "GET", "/robots.txt", [("Host", "shrine.local"), ("X-Forwarded-For", " 10.77.0.1 , 10.0.0.9")])
        results[port] = (statuses, over, health, other, chained)
    node, py = results[NODE_PORT], results[PY_PORT]
    assert set(node[0]) == {200} and set(py[0]) == {200}
    assert node[1].status == py[1].status == 429
    assert compare(Req("GET", "/nope"), node[1], py[1]) == []
    assert py[1].body == b"Too Many Requests"
    assert node[2].status == py[2].status == 200
    assert node[3].status == py[3].status == 200
    assert node[4].status == py[4].status == 429


@pytest.mark.parametrize("servers", ["root"], indirect=True)
def test_too_many_headers_intended_difference(servers):
    """보안 점검 (일부러 다름): Node는 50개 넘는 머리글을 버리고(→ Accept가 빠져 글자 404), Python은 431로 거절합니다.
    버리면 X-Forwarded-For도 빠져 IP별 요청 제한 · 차단을 비켜 갈 수 있었습니다 (web/front.py). Node는 그대로 둡니다."""
    req = Req("GET", "/nope", [(f"X-Fill-{i}", "1") for i in range(52)] + [HTML])
    hdrs = build_headers(req, "10.9.9.52", {})
    node = send_raw(NODE_PORT, "GET", "/nope", hdrs)
    py = send_raw(PY_PORT, "GET", "/nope", hdrs)
    assert node.status == 404 and py.status == 431 and py.body == b"Request Header Fields Too Large"
    # 50개까지는 둘이 같음 (위 test_parity의 '머리글 41개'와 함께)
    req = Req("GET", "/nope", [(f"X-Fill-{i}", "1") for i in range(50 - 5)] + [HTML])
    hdrs = build_headers(req, "10.9.9.50", {})
    assert len(hdrs) + 1 == 50  # send_raw가 Connection: close를 붙임
    node = send_raw(NODE_PORT, "GET", "/nope", hdrs)
    py = send_raw(PY_PORT, "GET", "/nope", hdrs)
    assert node.status == py.status == 404 and compare(req, node, py) == []


@pytest.mark.parametrize("servers", ["root"], indirect=True)
def test_legacy_redirect_open_redirect_fixed(servers):
    """예전 주소 /shrine//evil.com: 앞의 / 여러 개를 하나로 줄여 같은 사이트(/evil.com)로만 보냅니다. Node도 247a161에서 고쳐 둘이 같습니다."""
    hdrs = [("Host", "shrine.local"), ("X-Forwarded-For", "10.9.9.9")]
    expected = {  # 주소: (Node Location, Python Location)
        "/shrine//evil.com": ("/evil.com", "/evil.com"),
        "/shrine/\\evil.com": ("/evil.com", "/evil.com"),
        "/shrine///a?x=1": ("/a", "/a"),
        "/shrine/ok": ("/ok", "/ok"),
    }
    for target, (want_node, want_py) in expected.items():
        node = send_raw(NODE_PORT, "GET", target, hdrs)
        py = send_raw(PY_PORT, "GET", target, hdrs)
        assert node.status == py.status == 302
        assert (node.header("location"), py.header("location")) == (want_node, want_py)
        # Location 말고는 같아야 합니다
        same = [h for h in node.normalized_headers() if h[0] != "location"]
        assert same == [h for h in py.normalized_headers() if h[0] != "location"]
