"""P2a 비교 시험: Node(기준)와 Python 서버에 같은 씨앗 · 같은 요청을 넣어 바이트 단위로 맞춰 봅니다.

다루는 것: GET /api/world (사당 · 초 요약 · 채팅 설정 · 최근 글 주제), GET /api/posts, POST /api/enter (실패 본문 ·
쿠키 속성 · 표 모양 · 요청 제한), /go/<slug>[/repo] (리다이렉트 · X-Robots-Tag · 클릭 수), /healthz의 사당 수,
운영 명령 add (출력 · 종료 코드).

씨앗: 규칙을 지키는 사당은 양쪽 운영 명령(`node server/cli.ts add -` · `python -m shrine.cli add -`)으로, 규칙에 어긋난
사당(숨겨져야 함) · 초 · 게시판 글은 양쪽 DB에 같은 SQL로 바로 넣습니다 (Node: node:sqlite, Python: asyncpg).
포트: Node 3360~3362, Python 3370~3372 (변형마다 하나). Redis DB 15. PostgreSQL은 변형마다 무작위 역할 + 새 DB를 만들고 지웁니다.
node · PostgreSQL · Redis 중 하나라도 없으면 건너뜁니다.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

from _parity_util import Req, RawResponse, base_env, send_raw, start, stop, tail, wait_ready

REPO = Path(__file__).resolve().parents[2]
APP = REPO / "app"
NODE = shutil.which("node")
NODE_FLAGS = ["--disable-warning=ExperimentalWarning"]
PG_ADMIN = os.environ.get("SHRINE_TEST_PG", "postgresql://postgres:dev@127.0.0.1:55432/postgres")
REDIS_URL = os.environ.get("SHRINE_TEST_REDIS_P2A", "redis://127.0.0.1:56379/15")
#: 두 서버가 같은 비밀로 서명해야 한쪽에서 받은 입장 표가 다른 쪽에서도 통합니다 (시험 전용 값)
TICKET_SECRET = "p2a-parity-7Hq2Lx9Vw4Rk8Ns3Bd6Fz1Mc5Tj0Yg"

VARIANTS: dict[str, dict[str, str]] = {
    "root": {},
    "base": {
        "BASE_PATH": "/shrine",
        "ALLOW_INDEXING": "true",
        "PUBLIC_ORIGIN": "https://shrine.test.invalid",
        "CONTACT_EMAIL": "ops@shrine.test.invalid",
        "FREE_CHAT": "off",
    },
    # 운영 모드: TURNSTILE_SECRET이 있어 사람 확인을 건너뛰지 않습니다 (네트워크로 나가지 않는 토큰만 보냄)
    "prod": {
        "NODE_ENV": "production",
        "PUBLIC_ORIGIN": "https://shrine.parity-check.kr",
        "SHRINE_DOMAIN": "shrine.parity-check.kr",
        "TURNSTILE_SITE_KEY": "0x4AAAAAAAparitySiteKey",
        "TURNSTILE_SECRET": "0x4AAAAAAAparitySecretKey",
        "CONTACT_EMAIL": "ops@parity-check.kr",
        "ALLOW_INDEXING": "true",
    },
}
PORTS = {name: (3360 + i, 3370 + i) for i, name in enumerate(VARIANTS)}

SHRINE_COLUMNS = (
    "slug, name, tagline, category, domain, url, operator, keeper, paid, verified_domain, verified_business, joined_at, "
    "status, prayer, charm, deco, screens, captured_at, channel, plot, repo, email, email_public, project_id, sign"
)

# ── 씨앗 ──────────────────────────────────────────────────────────────

DAY_MS = 86_400_000


def kst_day(offset_days: int = 0) -> str:
    from shrine.logic.util import kst_date, now_ms

    return kst_date(now_ms() + offset_days * DAY_MS)


def shrine(slug: str, channel: int, plot: int, **over) -> dict:
    s = {
        "slug": slug, "name": f"{slug} 사당", "tagline": "무사히 배포되기를 비는 시험 서비스", "category": "devtools",
        "domain": f"{slug}.example.kr", "url": f"https://{slug}.example.kr", "operator": "OPS", "keeper": False, "paid": False,
        "verifiedDomain": kst_day(-30), "verifiedBusiness": None, "joinedAt": kst_day(-20), "status": "live", "prayer": "deploy",
        "charm": None, "deco": [], "screens": [f"{slug}-1.png"], "capturedAt": kst_day(-20), "channel": channel, "plot": plot,
        "sign": "", "repo": "", "email": "", "emailPublic": False, "projectId": 0,
    }  # fmt: skip
    s.update(over)
    return s


def valid_shrines() -> list[dict]:
    return [
        # 지붕 소개가 비면 한 줄 소개 앞 8글자(코드 포인트, 이모지 포함)를 잘라 trim
        shrine("alpha", 1, 0, tagline="🙏 무사배포를 빕니다 정말로요", joinedAt=kst_day(0), keeper=True, paid=True,
               verifiedBusiness=kst_day(-30), charm="no-404", deco=["duck", "cat"], url="https://www.alpha.example.kr/app",
               prayer="security", category="business"),
        # 숫자 모양 slug: JSON 객체 키 순서(배열 인덱스 키가 먼저)를 봅니다
        shrine("123", 1, 5, joinedAt=kst_day(-3), sign="숫자 사당", repo="https://github.com/owner-1/numeric.repo",
               email="a@b.kr", emailPublic=False),
        shrine("10", 1, 6, joinedAt=kst_day(-7), sign="열"),
        # GitHub 저장소만 있는 등록소 사당 (도메인 · 사업자 확인 없음, 화면 없어도 됨, 이메일 공개)
        shrine("gh-only", 2, 3, domain="github.com/octo-org/hello.world", url="https://github.com/Octo-Org/Hello.World",
               repo="https://github.com/Octo-Org/Hello.World", verifiedDomain="", projectId=7, screens=[],
               email="dev@example.kr", emailPublic=True, joinedAt=kst_day(-10), sign="깃허브"),
        shrine("checking", 3, 19, status="check", repo="https://github.com/octo-org/checking", joinedAt=kst_day(-1)),
        shrine("future", 2, 0, joinedAt=kst_day(2), charm="no-friday", deco=["coffee", "makgeolli", "cactus"],
               screens=["future-1.webp", "future-2.jpg"]),
        shrine("zz-last", 1, 19, prayer="uptime", tagline="짧다"),
    ]  # fmt: skip


def hidden_shrines() -> list[dict]:
    """규칙에 어긋나 맵에서 숨겨져야 하는 사당 (운영 명령은 받지 않으므로 SQL로 바로 넣음)."""
    return [
        shrine("bad-cat", 1, 7, category="nope"),
        shrine("bad-url", 1, 8, url="http://bad-url.example.kr"),
    ]


def shrine_row(s: dict) -> list:
    return [
        s["slug"], s["name"], s["tagline"], s["category"], s["domain"], s["url"], s["operator"], int(s["keeper"]), int(s["paid"]),
        s["verifiedDomain"], s["verifiedBusiness"], s["joinedAt"], s["status"], s["prayer"], s["charm"],
        json.dumps(s["deco"], ensure_ascii=False, separators=(",", ":")), json.dumps(s["screens"], ensure_ascii=False, separators=(",", ":")),
        s["capturedAt"], s["channel"], s["plot"], s["repo"], s["email"], int(s["emailPublic"]), s["projectId"], s["sign"],
    ]  # fmt: skip


def raw_statements(now: int) -> list[tuple[str, list]]:
    from shrine.logic.util import kst_week_days

    week = kst_week_days(now)
    monday = week[-1]
    sql: list[tuple[str, list]] = []
    for s in hidden_shrines():
        sql.append((f"INSERT INTO shrines ({SHRINE_COLUMNS}) VALUES ({', '.join('?' * 25)})", shrine_row(s)))
    candles = [
        (kst_day(0), "zz-last", "uptime", 2), (kst_day(0), "alpha", "deploy", 3), (kst_day(0), "alpha", "security", 2),
        (kst_day(0), "123", "deploy", 4), (monday, "zz-last", "deploy", 5), (kst_day(-8), "alpha", "deploy", 100),
        (kst_day(0), "ghost", "bug", 1), (kst_day(0), "10", "payment", 2), (monday, "gh-only", "success", 1),
    ]  # fmt: skip
    for c in candles:
        sql.append(("INSERT INTO candles (day, slug, prayer, n) VALUES (?, ?, ?, ?) "
                    "ON CONFLICT (day, slug, prayer) DO UPDATE SET n = candles.n + excluded.n", list(c)))  # fmt: skip
    topics = ["gpt", "claude", "etc", "gemini", "deepseek", "grok"]
    for i in range(1, 21):
        at = now - i * 60_000
        if i == 4:
            at = now - 3 * 60_000  # 3번 글과 같은 시각: 나중 글(번호 큰 것)이 먼저
        hidden = 1 if i == 6 else 0
        sql.append(("INSERT INTO posts (id, at, topic, text, nick, hidden) VALUES (?, ?, ?, ?, ?, ?)",
                    [i, at, topics[i % len(topics)], f"글 {i} — \"따옴표\" \\ 끝", f"새벽의 러버덕 {10 + i}", hidden]))  # fmt: skip
    sql.append(("INSERT INTO posts (id, at, topic, text, nick, hidden) VALUES (?, ?, ?, ?, ?, ?)",
                [50, now - 8 * DAY_MS, "gpt", "오래된 글", "새벽의 서버 99", 0]))  # fmt: skip
    return sql


NODE_SQL = r"""
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
const [file, specFile] = process.argv.slice(2)
const db = new DatabaseSync(file)
db.exec('PRAGMA busy_timeout = 3000')
const out = []
for (const [sql, params] of JSON.parse(readFileSync(specFile, 'utf8'))) {
  const st = db.prepare(sql)
  out.push(/^\s*select/i.test(sql) ? st.all(...params) : (st.run(...params), null))
}
db.close()
process.stdout.write(JSON.stringify(out))
"""


def node_sql(work: Path, data_dir: Path, statements: list[tuple[str, list]]) -> list:
    script = work / "sql.mjs"
    script.write_text(NODE_SQL, encoding="utf-8")
    spec = work / f"sql-{secrets.token_hex(4)}.json"
    spec.write_text(json.dumps(statements, ensure_ascii=False), encoding="utf-8")
    out = subprocess.run([NODE, *NODE_FLAGS, str(script), str(data_dir / "shrine.db"), str(spec)], capture_output=True, timeout=60)
    assert out.returncode == 0, out.stderr.decode("utf-8", "replace")
    return json.loads(out.stdout.decode("utf-8"))


def pg_sql(db_url: str, statements: list[tuple[str, list]]) -> list:
    import asyncpg

    def dollar(sql: str) -> str:
        n = iter(range(1, 1000))
        return re.sub(r"\?", lambda _m: f"${next(n)}", sql)

    async def run() -> list:
        conn = await asyncpg.connect(db_url)
        out = []
        try:
            for sql, params in statements:
                if sql.lstrip().lower().startswith("select"):
                    out.append([dict(r) for r in await conn.fetch(dollar(sql), *params)])
                else:
                    await conn.execute(dollar(sql), *params)
                    out.append(None)
        finally:
            await conn.close()
        return out

    return asyncio.run(run())


# ── 준비 ──────────────────────────────────────────────────────────────


def _infra_missing() -> str | None:
    if NODE is None:
        return "node가 없어 Node 기준 서버를 띄울 수 없습니다"
    try:
        import asyncpg
        import redis
    except ImportError as e:
        return f"{e.name} 없음"

    async def check() -> None:
        conn = await asyncpg.connect(PG_ADMIN, timeout=3)
        await conn.close()

    try:
        asyncio.run(check())
    except Exception as e:
        return f"PostgreSQL에 연결하지 못함 ({type(e).__name__})"
    try:
        redis.Redis.from_url(REDIS_URL, socket_connect_timeout=3).ping()
    except Exception as e:
        return f"Redis에 연결하지 못함 ({type(e).__name__})"
    return None


@pytest.fixture(scope="module")
def snapshot(tmp_path_factory):
    why = _infra_missing()
    if why:
        pytest.skip(why)
    root = tmp_path_factory.mktemp("p2a")
    snap = root / "repo"
    shutil.copytree(REPO / "server", snap / "server")
    shutil.copytree(REPO / "public", snap / "public")
    shutil.copy2(REPO / "package.json", snap / "package.json")
    shutil.copytree(REPO / "node_modules" / "ws", snap / "node_modules" / "ws")
    return root


def _port_free(port: int) -> bool:
    import socket

    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def _cli(cmd: list[str], cwd: Path, env: dict[str, str], stdin: str) -> tuple[int, str, str]:
    r = subprocess.run(cmd, cwd=cwd, env=env, input=stdin.encode("utf-8"), capture_output=True, timeout=120)
    return r.returncode, r.stdout.decode("utf-8", "replace").strip(), r.stderr.decode("utf-8", "replace").strip()


@pytest.fixture(scope="module", params=list(VARIANTS))
def servers(request, snapshot):
    import asyncpg
    import redis
    from sqlalchemy.engine import make_url

    variant = request.param
    node_port, py_port = PORTS[variant]
    for p in (node_port, py_port):
        if not _port_free(p):
            pytest.skip(f"포트 {p}를 다른 프로그램이 쓰고 있습니다")
    work = snapshot / variant
    work.mkdir()
    suffix = secrets.token_hex(4)
    role, db_name, password = f"shrine_p2a_{suffix}", f"shrine_p2a_{suffix}", secrets.token_urlsafe(24)

    async def pg(stmts: list[str]) -> None:
        conn = await asyncpg.connect(PG_ADMIN)
        try:
            for s in stmts:
                await conn.execute(s)
        finally:
            await conn.close()

    asyncio.run(pg([f"CREATE ROLE {role} LOGIN PASSWORD '{password}'", f"CREATE DATABASE {db_name} OWNER {role}"]))
    db_url = make_url(PG_ADMIN).set(username=role, password=password, database=db_name).render_as_string(hide_password=False)
    r = redis.Redis.from_url(REDIS_URL)
    r.flushdb()
    common = {**base_env(), **VARIANTS[variant], "HOST": "127.0.0.1", "TRUST_PROXY": "true", "TICKET_SECRET": TICKET_SECRET,
              "PYTHONIOENCODING": "utf-8"}  # fmt: skip
    node_env = {**common, "PORT": str(node_port), "DATA_DIR": str(work / "node-data")}
    py_env = {**common, "PORT": str(py_port), "DATA_DIR": str(work / "py-data"), "DATABASE_URL": db_url, "REDIS_URL": REDIS_URL,
              "PUBLIC_DIR": str(snapshot / "repo" / "public")}  # fmt: skip
    node_cli = [NODE, *NODE_FLAGS, "server/cli.ts"]
    py_cli = [sys.executable, "-m", "shrine.cli"]

    # 씨앗 1: 운영 명령 add (양쪽 출력 · 종료 코드를 함께 모아 둠)
    cli_runs = []
    adds = [json.dumps(s, ensure_ascii=False) for s in valid_shrines()]
    extra = [
        json.dumps(valid_shrines()[0], ensure_ascii=False),  # 같은 slug → 실패
        json.dumps(shrine("dup-plot", 1, 0), ensure_ascii=False),  # 같은 채널 · 자리 → 실패
        json.dumps(shrine("rule-bad", 1, 9, category="nope", name=""), ensure_ascii=False),  # 규칙 → 실패 (까닭 글자)
        json.dumps({k: v for k, v in shrine("ch-default", 1, 11).items() if k != "channel"}, ensure_ascii=False),  # 채널을 빼면 1번
    ]
    for text in adds + extra:
        n = _cli([*node_cli, "add", "-"], snapshot / "repo", node_env, text)
        p = _cli([*py_cli, "add", "-"], APP, py_env, text)
        cli_runs.append((text[:60], n, p))
    now = int(time.time() * 1000)
    statements = raw_statements(now)
    node_sql(work, work / "node-data", statements)
    pg_sql(db_url, statements)

    node_log, py_log = work / "node.log", work / "python.log"
    node = start([NODE, *NODE_FLAGS, "server/main.ts"], snapshot / "repo", node_env, node_log)
    py = start([sys.executable, "-m", "shrine"], APP, py_env, py_log)
    try:
        wait_ready(node_port, node, node_log)
        wait_ready(py_port, py, py_log)
        yield {
            "variant": variant, "base": VARIANTS[variant].get("BASE_PATH", ""), "ports": (node_port, py_port), "work": work,
            "db_url": db_url, "node_log": node_log, "py_log": py_log, "cli": cli_runs, "prod": variant == "prod",
        }  # fmt: skip
    finally:
        stop(node)
        stop(py)
        r.flushdb()
        asyncio.run(pg([f"DROP DATABASE IF EXISTS {db_name} WITH (FORCE)", f"DROP ROLE IF EXISTS {role}"]))


# ── 비교 ──────────────────────────────────────────────────────────────

HTML = ("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
JSON_CT = ("Content-Type", "application/json")


def headers_for(xff: str, extra: list[tuple[str, str]], host: str = "shrine.local") -> list[tuple[str, str]]:
    hdrs = [("Host", host), ("User-Agent", "p2a-parity"), ("X-Forwarded-For", xff)]
    return hdrs + extra


def send_body(port: int, method: str, target: str, headers: list[tuple[str, str]], body: bytes | None) -> RawResponse:
    """본문이 있는 요청 (Content-Length를 직접 적지 않았으면 붙임)."""
    import socket

    if body is None:
        return send_raw(port, method, target, headers)
    hdrs = list(headers)
    if not any(k.lower() == "content-length" for k, _ in hdrs):
        hdrs.append(("Content-Length", str(len(body))))
    lines = [f"{method} {target} HTTP/1.1", *(f"{k}: {v}" for k, v in hdrs), "Connection: close"]
    data = ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + body
    with socket.create_connection(("127.0.0.1", port), timeout=15) as s:
        s.sendall(data)
        chunks = []
        while True:
            try:
                c = s.recv(65536)
            except ConnectionResetError:
                break
            if not c:
                break
            chunks.append(c)
    raw = b"".join(chunks)
    head, _, rest = raw.partition(b"\r\n\r\n")
    head_lines = head.decode("latin-1").split("\r\n")
    status = int(head_lines[0].split(" ")[1])
    out = [(k.strip(), v.strip()) for k, _, v in (line.partition(":") for line in head_lines[1:])]
    te = next((v for k, v in out if k.lower() == "transfer-encoding"), "")
    from _parity_util import _dechunk

    return RawResponse(status, out, _dechunk(rest) if "chunked" in te.lower() else rest, head.decode("latin-1"))


def normalize(r: RawResponse, target: str) -> tuple[int, list, bytes]:
    body = r.body
    if target.split("?")[0].endswith("/healthz") and body:
        d = json.loads(body)
        d["uptime"] = 0
        body = json.dumps(d).encode()
    hdrs = r.normalized_headers()
    # 입장 표는 sid · 별명이 무작위라 값만 가립니다 (속성은 그대로 비교)
    hdrs = [(k, re.sub(r"^shrine_ticket=[A-Za-z0-9_.-]+;", "shrine_ticket=X;", v) if k == "set-cookie" else v) for k, v in hdrs]
    if r.status == 200 and b'"nick"' in body and target.split("?")[0].endswith("/api/enter"):
        body = re.sub(rb'"nick":"[^"]*"', b'"nick":"X"', body)
    return r.status, hdrs, body


def diff(label: str, node: RawResponse, py: RawResponse, target: str) -> list[str]:
    ns, nh, nb = normalize(node, target)
    ps, ph, pb = normalize(py, target)
    out = []
    if ns != ps:
        out.append(f"상태 Node {ns} / Python {ps}")
    if nh != ph:
        out.append(f"머리글 Node만 {[h for h in nh if h not in ph]} / Python만 {[h for h in ph if h not in nh]}")
    if nb != pb:
        i = next((k for k in range(min(len(nb), len(pb))) if nb[k] != pb[k]), min(len(nb), len(pb)))
        out.append(f"본문 {i}바이트째부터 다름: Node {nb[max(0, i - 60) : i + 80]!r} / Python {pb[max(0, i - 60) : i + 80]!r}")
    return [f"{label}\n    " + "\n    ".join(out)] if out else []


def world_cases(b: str) -> list[Req]:
    long_slug = "a" * 41
    return [
        Req("GET", f"{b}/api/world", []),
        Req("GET", f"{b}/api/world", [HTML]),
        Req("GET", f"{b}/api/world?x=1", []),
        Req("HEAD", f"{b}/api/world", [HTML]),
        Req("POST", f"{b}/api/world", []),
        Req("DELETE", f"{b}/api/world", []),
        Req("GET", f"{b}/api/world/", [HTML]),
        Req("GET", f"{b}/api/%77orld", []),
        Req("GET", f"{b}/api/posts", []),
        Req("HEAD", f"{b}/api/posts", []),
        Req("POST", f"{b}/api/posts", []),
        Req("GET", "/healthz", []),
        Req("GET", f"{b}/api/enter", [HTML]),
        Req("HEAD", f"{b}/api/enter", []),
        Req("PUT", f"{b}/api/enter", []),
        # /go (입장 표 없이: 클릭은 세지 않음)
        Req("GET", f"{b}/go/alpha", []),
        Req("GET", f"{b}/go/alpha?utm=1", [HTML]),
        Req("GET", f"{b}/go/alpha/repo", [HTML]),
        Req("GET", f"{b}/go/alpha/repo", []),
        Req("GET", f"{b}/go/123/repo", []),
        Req("GET", f"{b}/go/123", []),
        Req("GET", f"{b}/go/gh-only", []),
        Req("GET", f"{b}/go/gh-only/repo", []),
        Req("GET", f"{b}/go/checking", []),
        Req("GET", f"{b}/go/checking/repo", []),
        Req("GET", f"{b}/go/future", []),
        Req("GET", f"{b}/go/bad-cat", [HTML]),
        Req("GET", f"{b}/go/bad-url", []),
        Req("GET", f"{b}/go/nope", [HTML]),
        Req("GET", f"{b}/go/nope", []),
        Req("GET", f"{b}/go/ALPHA", [HTML]),
        Req("GET", f"{b}/go/alpha/", [HTML]),
        Req("GET", f"{b}/go/alpha/repo/", []),
        Req("GET", f"{b}/go/alpha/x", []),
        Req("GET", f"{b}/go/{long_slug}", []),
        Req("GET", f"{b}/go/%61lpha", []),
        Req("GET", f"{b}/go//alpha", []),
        Req("GET", f"{b}/go/", [HTML]),
        Req("GET", f"{b}/go", []),
        Req("HEAD", f"{b}/go/alpha", []),
        Req("POST", f"{b}/go/alpha", []),
        Req("GET", f"{b}/go/./alpha", []),
        Req("GET", f"{b}/x/../go/zz-last", []),
    ]


def test_world_posts_go_healthz_parity(servers):
    node_port, py_port = servers["ports"]
    b = servers["base"]
    failures = []
    reqs = world_cases(b)
    for i, req in enumerate(reqs):
        hdrs = headers_for(f"10.50.{list(VARIANTS).index(servers['variant'])}.{i % 200}", req.headers)
        node = send_raw(node_port, req.method, req.target, hdrs)
        py = send_raw(py_port, req.method, req.target, hdrs)
        failures += diff(f"[{servers['variant']}] {req.label()}", node, py, req.target)
    assert not failures, f"{len(failures)}/{len(reqs)}건이 다릅니다:\n" + "\n".join(failures) + f"\n--- python.log ---\n{tail(servers['py_log'], 15)}"


def test_world_content(servers):
    """양쪽이 같다는 것 말고도 내용이 맞는지 (씨앗이 실제로 들어가 비교가 헛돌지 않게)."""
    from shrine.logic.world import WORLD_JSON_TEXT

    _, py_port = servers["ports"]
    r = send_raw(py_port, "GET", f"{servers['base']}/api/world", headers_for("10.51.0.1", []))
    assert r.status == 200 and r.header("cache-control") == "no-cache"
    assert r.body.startswith(b'{"world":' + WORLD_JSON_TEXT.encode() + b',"shrines":[')
    d = json.loads(r.body)
    assert list(d) == ["world", "shrines", "candles", "chat", "recentTopics", "registry"]
    slugs = [s["slug"] for s in d["shrines"]]
    assert slugs == ["alpha", "123", "10", "ch-default", "zz-last", "future", "gh-only", "checking"]
    alpha = d["shrines"][0]
    assert list(alpha) == ["repo", "fromProject", "sign", "slug", "name", "tagline", "category", "domain", "operator", "keeper",
                           "business", "verifiedDomain", "verifiedBusiness", "joinedAt", "status", "prayer", "charm", "deco",
                           "screens", "capturedAt", "channel", "plot", "isNew"]  # fmt: skip
    assert alpha["sign"] == "🙏 무사배포를" and alpha["isNew"] is True and alpha["business"] is True
    gh = next(s for s in d["shrines"] if s["slug"] == "gh-only")
    assert gh["email"] == "dev@example.kr" and gh["fromProject"] is True and list(gh)[3] == "email"
    assert next(s for s in d["shrines"] if s["slug"] == "future")["isNew"] is False
    assert "url" not in alpha and "paid" not in alpha
    week = d["candles"]["week"]
    assert list(week)[:2] == ["10", "123"]  # 배열 인덱스 모양 키가 먼저 (JS 객체 순서)
    from shrine.logic.util import kst_week_days

    monday_is_today = kst_week_days()[-1] == kst_day(0)
    assert "alpha" in week and week["alpha"] == 5 and d["candles"]["today"] == 14 + (6 if monday_is_today else 0)
    assert d["candles"]["weekTotal"] == 20 and week["zz-last"] == 7 and week["ghost"] == 1
    assert d["chat"] == {"free": servers["variant"] != "base", "max": 40, "postMax": 80,
                         "contact": VARIANTS[servers["variant"]].get("CONTACT_EMAIL", "")}  # fmt: skip
    assert len(d["recentTopics"]) == 16 and d["registry"] == {"open": True}
    posts = json.loads(send_raw(py_port, "GET", f"{servers['base']}/api/posts", headers_for("10.51.0.1", [])).body)["posts"]
    assert [p["id"] for p in posts][:5] == [1, 2, 4, 3, 5] and 6 not in [p["id"] for p in posts] and len(posts) == 19
    # 숨긴 사당은 양쪽 로그에 같은 까닭으로
    for log in (servers["node_log"], servers["py_log"]):
        text = log.read_text(encoding="utf-8", errors="replace")
        assert "'bad-cat' 사당을 숨겼습니다: 카테고리" in text, log
        assert "'bad-url' 사당을 숨겼습니다: 대표 링크는 https + 그 도메인 안" in text, log
    h = json.loads(send_raw(py_port, "GET", "/healthz", headers_for("10.51.0.1", [])).body)
    assert h["shrines"] == 8


def test_cli_add_parity(servers):
    """운영 명령 add: 표준 출력 · 종료 코드가 같고, 규칙 · 중복 실패는 까닭 글자까지 같음."""
    problems = []
    for label, (nc, no, ne), (pc, po, pe) in servers["cli"]:
        # Python은 빈 DB에 구조를 처음 만들 때 한 줄을 더 찍습니다 (db/engine.py). 마지막 줄만 비교
        no, po = (no.splitlines() or [""])[-1], (po.splitlines() or [""])[-1]
        if nc != pc or no != po:
            problems.append(f"{label}: Node ({nc}, {no!r}) / Python ({pc}, {po!r}) / stderr {ne[-200:]!r} | {pe[-200:]!r}")
        elif nc != 0 and ne.splitlines()[-1:] != pe.splitlines()[-1:]:
            problems.append(f"{label}: 까닭 Node {ne[-200:]!r} / Python {pe[-200:]!r}")
    codes = [n[0] for _, n, _ in servers["cli"]]
    assert codes == [0] * len(valid_shrines()) + [1, 1, 1, 0], codes
    assert not problems, "\n".join(problems)


def enter_cases(prod: bool) -> list[tuple[str, list[tuple[str, str]], bytes | None]]:
    look = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3]
    ok = json.dumps({"look": look}).encode()
    cases: list[tuple[str, list[tuple[str, str]], bytes | None]] = [
        ("본문 없음", [], None),
        ("text/plain", [("Content-Type", "text/plain")], ok),
        ("대문자 Content-Type", [("Content-Type", "Application/json")], ok),
        ("charset 붙음", [("Content-Type", "application/json; charset=utf-8")], json.dumps({"look": [9] + look[1:]}).encode()),
        ("look 11칸", [JSON_CT], json.dumps({"look": look[:11]}).encode()),
        ("look 범위 밖", [JSON_CT], json.dumps({"look": [6] + look[1:]}).encode()),
        ("look 음수", [JSON_CT], json.dumps({"look": [-1] + look[1:]}).encode()),
        ("look 1.5", [JSON_CT], json.dumps({"look": [1.5] + look[1:]}).encode()),
        ("look true", [JSON_CT], b'{"look":[true,1,2,3,4,5,6,7,0,1,2,3]}'),
        ("look 글자", [JSON_CT], b'{"look":"012345670123"}'),
        ("배열 본문", [JSON_CT], json.dumps([look]).encode()),
        ("null 본문", [JSON_CT], b"null"),
        ("숫자 본문", [JSON_CT], b"12"),
        ("JSON 아님", [JSON_CT], b"{look:[0]}"),
        ("BOM", [JSON_CT], b"\xef\xbb\xbf" + ok),
        ("4096 넘음 (선언)", [JSON_CT, ("Content-Length", "5000")], ok + b" " * (5000 - len(ok))),
        ("4096 넘음 (실제)", [JSON_CT], ok + b" " * 4100),
        ("Origin 다름", [JSON_CT, ("Origin", "https://evil.example")], ok),
        ("Origin null", [JSON_CT, ("Origin", "null")], ok),
        ("Origin 주소 아님", [JSON_CT, ("Origin", "::")], ok),
    ]
    if prod:
        cases += [
            ("토큰 없음", [JSON_CT, ("Origin", "https://shrine.parity-check.kr")], ok),
            ("토큰 짧음", [JSON_CT], json.dumps({"look": look, "token": "abc"}).encode()),
            ("토큰 숫자", [JSON_CT], json.dumps({"look": look, "token": 1234567890123}).encode()),
            ("토큰 너무 김", [JSON_CT], json.dumps({"look": look, "token": "x" * 2049}).encode()),
        ]
    else:
        cases += [
            ("통과", [JSON_CT], ok),
            ("통과 1.0 · -0", [JSON_CT], b'{"look":[1.0,-0,2,3,4,5,6,7,0,1,2,3],"token":5,"extra":{"a":1}}'),
            ("통과 Origin = Host", [JSON_CT, ("Origin", "http://shrine.local")], ok),
            ("통과 charset", [("Content-Type", "application/json;charset=UTF-8")], ok),
            ("통과 공백 JSON", [JSON_CT], b' \n{"look":[0,1,2,3,4,5,6,7,0,1,2,3]}\t'),
        ]
    return cases


def test_enter_parity(servers):
    from shrine.logic.crypto import node_base64_decode, verify_ticket

    node_port, py_port = servers["ports"]
    b = servers["base"]
    v = list(VARIANTS).index(servers["variant"])
    failures = []
    if servers["variant"] == "base":
        origin_ok = ("Origin", "https://shrine.test.invalid")
    else:
        origin_ok = ("Origin", "http://shrine.local")
    for i, (label, extra, body) in enumerate(enter_cases(servers["prod"])):
        if servers["variant"] == "base" and label == "통과 Origin = Host":
            extra = [JSON_CT, origin_ok]
        hdrs = headers_for(f"10.52.{v}.{i}", extra)
        node = send_body(node_port, "POST", f"{b}/api/enter", hdrs, body)
        py = send_body(py_port, "POST", f"{b}/api/enter", hdrs, body)
        failures += diff(f"[{servers['variant']}] /api/enter {label}", node, py, f"{b}/api/enter")
        if label.startswith("통과"):
            for who, r in (("Node", node), ("Python", py)):
                assert r.status == 200, f"{who} {label}: {r.status} {r.body!r}"
                cookie = r.header("set-cookie") or ""
                value = cookie.split(";", 1)[0].split("=", 1)[1]
                assert cookie.endswith(f"; Path={b}/; Max-Age=10800; HttpOnly; SameSite=Strict"), cookie
                t = verify_ticket(value, TICKET_SECRET)
                assert t is not None and list(t) == ["sid", "look", "nick", "exp"], (who, t)
                assert re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", t["sid"])
                assert json.loads(r.body)["nick"] == t["nick"] and json.loads(r.body)["look"] == t["look"]
                assert abs(t["exp"] - (time.time() * 1000 + 3 * 3600_000)) < 60_000
                # 본문 글자가 JSON.stringify 모양 그대로 (1.0 → 1, -0 → 0)
                assert node_base64_decode(value.split(".")[0]).decode().startswith('{"sid":"')
                assert b'"look":[1,0,2,' in r.body or b'"look":[0,1,2,' in r.body
    assert not failures, f"{len(failures)}건이 다릅니다:\n" + "\n".join(failures) + f"\n--- python.log ---\n{tail(servers['py_log'], 15)}"


def test_enter_rate_limit(servers):
    """IP(그날 해시)당 10분에 10번: 형식이 틀린 요청도 세고, 11번째는 429 busy (출처 · 차단 검사 뒤, 본문 읽기 전)."""
    node_port, py_port = servers["ports"]
    b = servers["base"]
    v = list(VARIANTS).index(servers["variant"])
    hdrs = headers_for(f"10.53.{v}.1", [])
    results = {}
    for port in (node_port, py_port):
        statuses = [send_body(port, "POST", f"{b}/api/enter", hdrs, None).status for _ in range(10)]
        over = send_body(port, "POST", f"{b}/api/enter", hdrs, None)
        bad_origin = send_body(port, "POST", f"{b}/api/enter", hdrs + [("Origin", "https://evil.example")], None)
        other = send_body(port, "POST", f"{b}/api/enter", headers_for(f"10.53.{v}.2", []), None)
        results[port] = (statuses, over, bad_origin, other)
    for port in (node_port, py_port):
        statuses, over, bad_origin, other = results[port]
        assert statuses == [400] * 10, (port, statuses)
        assert over.status == 429 and json.loads(over.body) == {"ok": False, "reason": "busy"}, port
        assert bad_origin.status == 403 and json.loads(bad_origin.body)["reason"] == "origin"
        assert other.status == 400
    assert not diff("429", results[node_port][1], results[py_port][1], f"{b}/api/enter")
    keys = __import__("redis").Redis.from_url(REDIS_URL).keys("shrine:rl:enter:*")
    assert keys and all(len(k) == len(b"shrine:rl:enter:") + 22 for k in keys)


def test_click_counts(servers):
    """클릭은 유효한 입장 표가 있을 때만 셉니다. 한쪽에서 받은 표는 다른 쪽에서도 통합니다 (같은 TICKET_SECRET)."""
    from shrine.logic.crypto import sign_ticket

    node_port, py_port = servers["ports"]
    b = servers["base"]
    now = int(time.time() * 1000)
    look = [0] * 12
    good = sign_ticket({"sid": "a1b2c3d4-0000-4000-8000-000000000001", "look": look, "nick": "n", "exp": now + 3600_000}, TICKET_SECRET)
    expired = sign_ticket({"sid": "s", "look": look, "nick": "n", "exp": now - 1}, TICKET_SECRET)
    sloppy = good + "!!"  # 예전 관대한 디코드라면 통과했을 표: 이제는 양쪽 다 세지 않음
    jar = {"good": good, "expired": expired, "sloppy": sloppy, "junk": "x.y"}
    plan = [
        ("alpha", "good", 2), ("alpha", None, 1), ("alpha", "junk", 1), ("alpha", "expired", 1), ("alpha", "sloppy", 1),
        ("123/repo", "good", 1), ("gh-only/repo", "good", 1), ("gh-only", "good", 3), ("checking", "good", 1),
        ("checking/repo", "good", 1), ("alpha/repo", "good", 1), ("nope", "good", 1), ("bad-url", "good", 1),
    ]  # fmt: skip
    for port in (node_port, py_port):
        for path, which, times in plan:
            extra = [("Cookie", f"a=1; shrine_ticket={jar[which]}; b=2")] if which else []
            for _ in range(times):
                send_raw(port, "GET", f"{b}/go/{path}", headers_for("10.54.0.1", extra))
    sql = [("SELECT day, slug, n FROM clicks ORDER BY slug", [])]
    node_rows = node_sql(servers["work"], servers["work"] / "node-data", sql)[0]
    py_rows = pg_sql(servers["db_url"], sql)[0]
    today = kst_day(0)
    want = [{"day": today, "slug": "123", "n": 1}, {"day": today, "slug": "alpha", "n": 2}, {"day": today, "slug": "gh-only", "n": 4}]
    assert node_rows == want
    assert py_rows == want
