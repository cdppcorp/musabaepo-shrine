"""등록소 · 업로드 · 보관 기간을 Node 서버(기준)와 Python 서버에 똑같이 돌려 상태 · 머리글 · 본문 · 알림 · 남은 DB 행을 맞춰 봅니다.

  · Node: node server/main.ts (PORT 3380, 새 DATA_DIR) · 운영 명령 server/cli.ts · 시험용 훅 tests/conformance/lib/node-hooks.mjs
  · Python: python -m shrine (PORT 3390, 새 PostgreSQL DB · Redis DB 14) · python -m shrine.cli
  · 알림 웹훅은 이 시험이 3389에서 받아 두 서버의 글을 비교합니다.
  · 입장 표는 같은 TICKET_SECRET으로 시험이 직접 만듭니다 (sid가 두 서버에서 같음). GitHub 확인은 끔.
  · 무작위 값(업로드 이름 · 접수 코드)은 서버마다 나온 순서대로 <up1> · <code1>로, ms 시각은 <ms>로 바꿔 비교합니다.
  · 빼는 머리글: Date · Server · Connection · Keep-Alive.
  · 승인 뒤에는 두 서버를 다시 띄웁니다 (사당 캐시 30초). Node는 그때 메모리(업로드 주인 · PIN 틀린 수 · 2분 제한)를 잃고
    Python은 Redis에 남기므로, 다시 띄운 뒤에는 그 차이가 드러나지 않는 요청만 보냅니다 (새 입장 표 · 새 IP).
node · PostgreSQL · Redis 중 하나라도 없으면 건너뜁니다.
"""

from __future__ import annotations

import asyncio
import http.client
import http.server
import json
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from _p2b_util import PG_ADMIN, REDIS_BASE, TICKET_SECRET, jpeg, png, png_chunk, ticket, webp
from _parity_util import base_env, send_raw, start, stop, tail

REPO = Path(__file__).resolve().parents[2]
APP = REPO / "app"
NODE = shutil.which("node")
NODE_PORT, PY_PORT, HOOK_PORT = 3380, 3390, 3389
REDIS_URL = f"{REDIS_BASE}/14"
IGNORED = frozenset({"date", "server", "connection", "keep-alive"})


# ── 웹훅 받는 곳 ──


class _Hook(http.server.BaseHTTPRequestHandler):
    got: dict[str, list[str]] = {"/node": [], "/py": []}

    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        try:
            self.got.setdefault(self.path, []).append(json.loads(body)["text"])
        except Exception:  # noqa: BLE001
            self.got.setdefault(self.path, []).append(f"<bad {body[:40]!r}>")
        self.send_response(204)
        self.end_headers()

    def log_message(self, *a):  # 조용히
        pass


# ── 서버 ──


class Server:
    def __init__(self, kind: str, port: int, env: dict[str, str], cwd: Path, log: Path):
        self.kind, self.port, self.env, self.cwd, self.log = kind, port, env, cwd, log
        self.proc: subprocess.Popen | None = None
        self.tokens: dict[str, str] = {}

    def cmd(self) -> list[str]:
        if self.kind == "node":
            return [NODE, "--disable-warning=ExperimentalWarning", "server/main.ts"]
        return [sys.executable, "-m", "shrine"]

    def start(self) -> None:
        self.proc = start(self.cmd(), self.cwd, self.env, self.log)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"{self.kind} 서버가 끝났습니다:\n{tail(self.log)}")
            try:
                if send_raw(self.port, "GET", "/healthz", [("Host", "127.0.0.1")], timeout=2).status in (200, 503):
                    return
            except OSError:
                pass
            time.sleep(0.2)
        raise RuntimeError(f"{self.kind} 서버가 뜨지 않았습니다:\n{tail(self.log)}")

    def stop(self) -> None:
        if self.proc is not None:
            stop(self.proc)
            self.proc = None

    def restart(self) -> None:
        self.stop()
        self.start()

    def cli(self, *args: str, extra: dict[str, str] | None = None) -> subprocess.CompletedProcess:
        env = {**self.env, **(extra or {}), "PYTHONIOENCODING": "utf-8"}
        if self.kind == "node":
            cmd = [NODE, "--disable-warning=ExperimentalWarning", "server/cli.ts", *args]
        else:
            cmd = [sys.executable, "-m", "shrine.cli", *args]
        return subprocess.run(cmd, cwd=self.cwd, env=env, capture_output=True, timeout=120, encoding="utf-8", errors="replace")

    def hook(self, *args: str, extra: dict[str, str] | None = None) -> subprocess.CompletedProcess:
        env = {**self.env, **(extra or {}), "PYTHONIOENCODING": "utf-8"}
        if self.kind == "node":
            cmd = [NODE, "--disable-warning=ExperimentalWarning", str(REPO / "tests/conformance/lib/node-hooks.mjs"), *args]
        else:
            cmd = [sys.executable, "-m", "shrine.cli", "dev", *args]
        return subprocess.run(cmd, cwd=self.cwd, env=env, capture_output=True, timeout=120, encoding="utf-8", errors="replace")

    # 무작위 값 → 이름
    def remember(self, kind: str, value: str) -> str:
        if value not in self.tokens:
            n = sum(1 for k in self.tokens.values() if k.startswith(f"<{kind}"))
            self.tokens[value] = f"<{kind}{n + 1}>"
        return value


def _pg_db():
    import asyncpg

    async def make():
        conn = await asyncpg.connect(PG_ADMIN, timeout=3)
        name = f"shrine_p2b_http_{secrets.token_hex(4)}"
        await conn.execute(f"CREATE DATABASE {name}")
        await conn.close()
        return name

    return asyncio.run(make())


def _pg_drop(name: str) -> None:
    import asyncpg

    async def drop():
        conn = await asyncpg.connect(PG_ADMIN, timeout=3)
        await conn.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")
        await conn.close()

    asyncio.run(drop())


@pytest.fixture(scope="module")
def pair(tmp_path_factory):
    if NODE is None:
        pytest.skip("node가 없습니다")
    try:
        import redis

        redis.Redis.from_url(REDIS_URL, socket_connect_timeout=3).flushdb()
        db_name = _pg_db()
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"PostgreSQL · Redis가 없습니다 ({type(e).__name__})")
    from sqlalchemy.engine import make_url

    root = tmp_path_factory.mktemp("p2b-parity")
    hook = http.server.ThreadingHTTPServer(("127.0.0.1", HOOK_PORT), _Hook)
    threading.Thread(target=hook.serve_forever, daemon=True).start()
    common = {
        **base_env(), "HOST": "127.0.0.1", "TRUST_PROXY": "true", "TICKET_SECRET": TICKET_SECRET, "GITHUB_CHECK": "off",
        "PYTHONIOENCODING": "utf-8",
    }  # fmt: skip
    node = Server(
        "node", NODE_PORT,
        {**common, "PORT": str(NODE_PORT), "DATA_DIR": str(root / "node"), "NOTIFY_WEBHOOK_URL": f"http://127.0.0.1:{HOOK_PORT}/node"},
        REPO, root / "node.log",
    )  # fmt: skip
    db_url = make_url(PG_ADMIN).set(database=db_name).render_as_string(hide_password=False)
    py = Server(
        "py", PY_PORT,
        {**common, "PORT": str(PY_PORT), "DATA_DIR": str(root / "py"), "NOTIFY_WEBHOOK_URL": f"http://127.0.0.1:{HOOK_PORT}/py",
         "DATABASE_URL": db_url, "REDIS_URL": REDIS_URL},
        APP, root / "py.log",
    )  # fmt: skip
    try:
        node.start()
        py.start()
        yield {"node": node, "py": py, "db_url": db_url}
    finally:
        node.stop()
        py.stop()
        hook.shutdown()
        hook.server_close()
        try:
            import redis

            redis.Redis.from_url(REDIS_URL).flushdb()
        finally:
            _pg_drop(db_name)


# ── 요청 · 정리 ──

ORIGIN_OK = "same"


def request(srv: Server, method: str, path: str, *, body: bytes | None = None, ck: str = "", ip: str = "10.0.0.1",
            ctype: str | None = "application/json", origin: str | None = ORIGIN_OK, extra: list[tuple[str, str]] = ()):  # fmt: skip
    conn = http.client.HTTPConnection("127.0.0.1", srv.port, timeout=30)
    headers = {"X-Forwarded-For": ip, "Connection": "close"}
    if ctype:
        headers["Content-Type"] = ctype
    if ck:
        headers["Cookie"] = f"shrine_ticket={ck}"
    if origin:
        headers["Origin"] = f"http://127.0.0.1:{srv.port}" if origin == ORIGIN_OK else origin
    for k, v in extra:
        headers[k] = v
    conn.request(method, path, body=body, headers=headers)
    res = conn.getresponse()
    data = res.read()
    out = (res.status, [(k, v) for k, v in res.getheaders() if k.lower() not in IGNORED], data)
    conn.close()
    return out


def jbody(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False).encode()


_MS = re.compile(rb"(?<![0-9])1[0-9]{12}(?![0-9])")


def normalize(srv: Server, rec):
    status, headers, data = rec
    text_ = data
    for value, name in sorted(srv.tokens.items(), key=lambda kv: -len(kv[0])):
        text_ = text_.replace(value.encode(), name.encode())
        headers = [(k, v.replace(value, name)) for k, v in headers]
    text_ = _MS.sub(b"<ms>", text_).replace(str(srv.port).encode(), b"<port>")
    # HTTP 머리글 이름은 대소문자를 가리지 않습니다 (uvicorn은 소문자로 보냄). 순서는 그대로 비교
    headers = [(k.lower(), v.replace(str(srv.port), "<port>")) for k, v in headers]
    return status, headers, text_


def flow_phase1(srv: Server) -> list:
    """승인 전: 업로드 · 미리 보기 · 접수 검사 · 접수 코드 · 찾기 · PIN 잠금 · 관리 · 내리기."""
    out = []

    def rec(label, r):
        out.append((label, r))
        return r

    A, B, C = ticket("sid-A"), ticket("sid-B"), ticket("sid-C")
    up = lambda body, ck=A, ip="10.0.0.1", **kw: request(srv, "POST", "/api/upload", body=body, ck=ck, ip=ip, ctype="image/png", **kw)  # noqa: E731
    r = rec("upload png", up(png(64, 36, [png_chunk("tEXt", b"Comment\0SECRET")])))
    img_a = srv.remember("up", json.loads(r[2])["id"])
    r = rec("upload jpeg", up(jpeg(64, 48)))
    img_jpg = srv.remember("up", json.loads(r[2])["id"])
    r = rec("upload webp", up(webp(50, 40), ck=B, ip="10.0.0.2"))
    img_b = srv.remember("up", json.loads(r[2])["id"])
    rec("upload garbage", up(b"not an image"))
    rec("upload empty", up(b""))
    rec("upload no ticket", up(png(32, 32), ck=""))
    rec("upload bad origin", up(png(32, 32), origin="http://evil.example"))
    rec("upload broken ticket", up(png(32, 32), ck=A[:-2] + "xx"))
    raw = send_raw(srv.port, "POST", "/api/upload", [("Host", f"127.0.0.1:{srv.port}"), ("Cookie", f"shrine_ticket={A}"),
                                                     ("X-Forwarded-For", "10.0.0.1"), ("Content-Length", str(11 * 1024 * 1024))])  # fmt: skip
    out.append(("upload declared 11MB", (raw.status, [(k, v) for k, v in raw.headers if k.lower() not in IGNORED], raw.body)))
    for label, ck, extra in [("img owner", A, ()), ("img no ticket", "", ()), ("img other", B, ()), ("img html 404", "", [("Accept", "text/html")]),
                             ("img owner inm (private: no 304)", A, [("If-None-Match", f'"{img_a}"')])]:  # fmt: skip
        rec(label, request(srv, "GET", f"/img/shrines/up/{img_a}", ck=ck, ctype=None, origin=None, extra=extra))
    rec("img owner HEAD", request(srv, "HEAD", f"/img/shrines/up/{img_a}", ck=A, ctype=None, origin=None))
    rec("img jpeg bytes", request(srv, "GET", f"/img/shrines/up/{img_jpg}", ck=A, ctype=None, origin=None))
    rec("img webp bytes", request(srv, "GET", f"/img/shrines/up/{img_b}", ck=B, ctype=None, origin=None))
    rec("img bad name", request(srv, "GET", "/img/shrines/up/short.png", ctype=None, origin=None))
    rec("img POST", request(srv, "POST", f"/img/shrines/up/{img_a}", ctype=None, origin=None))

    base = {"name": "데모 프로젝트", "tagline": "등록소 시험용 프로젝트", "category": "devtools", "url": "https://p2b-parity.dev",
            "email": "Dev@Example.com", "emailPublic": True, "pin": "123456", "consent": True}  # fmt: skip
    sub = lambda body, ck=A, ip="10.0.1.1", **kw: request(srv, "POST", "/api/submit", body=jbody(body), ck=ck, ip=ip, **kw)  # noqa: E731
    bad = [{"name": ""}, {"name": "시발 프로젝트"}, {"tagline": "가" * 41}, {"tagline": "카톡 주세요"}, {"category": "x"},
           {"url": ""}, {"github": "https://gitlab.com/a/b"}, {"url": "http://plain.example"}, {"url": "https://127.0.0.1"},
           {"email": "nope"}, {"pin": "123"}, {"pin": 123456}, {"consent": "true"}, {"consent": 1}, {"screen": img_b},
           {"screen": "x" * 16 + ".png"}, {"channel": 5}, {"channel": True}, {"plot": 99}, {"plot": "abc"}, {"sign": "가나다라마바사아자"}]  # fmt: skip
    for i, patch in enumerate(bad):
        rec(f"submit bad {list(patch)[0]} {i}", sub({**base, **patch}, ip=f"10.0.2.{i}"))
    rec("submit array body", request(srv, "POST", "/api/submit", body=b"[1,2]", ck=A, ip="10.0.3.1"))
    rec("submit text/plain", request(srv, "POST", "/api/submit", body=jbody(base), ck=A, ip="10.0.3.2", ctype="text/plain"))
    rec("submit too big", request(srv, "POST", "/api/submit", body=jbody({**base, "x": "a" * 5000}), ck=A, ip="10.0.3.3"))
    rec("submit broken json", request(srv, "POST", "/api/submit", body=b"{", ck=A, ip="10.0.3.4"))
    r = rec("submit ok (image)", sub({**base, "screen": img_a, "channel": "2", "plot": 7}))
    code1 = srv.remember("code", json.loads(r[2])["code"])
    rec("submit slow", sub({**base, "url": "https://other.dev"}))
    rec("submit dup", sub({**base, "url": "https://p2b-parity.dev/x"}, ck=B, ip="10.0.1.2"))
    r = rec("submit ok 2", sub({**base, "name": "둘째", "url": "https://second.dev", "pin": "000000", "emailPublic": False,
                                "email": "two@example.com"}, ck=B, ip="10.0.1.2"))  # fmt: skip
    srv.remember("code", json.loads(r[2])["code"])
    r = rec("submit ok 3", sub({**base, "name": "셋째", "url": "https://third.dev", "pin": "111111", "sign": " "}, ck=C, ip="10.0.1.3"))
    srv.remember("code", json.loads(r[2])["code"])
    r4 = sub({**base, "url": "https://fourth.dev"}, ck=ticket("sid-D2"), ip="10.0.1.4")
    srv.remember("code", json.loads(r4[2])["code"])
    rec("submit ok 4", r4)

    rec("receipt", request(srv, "GET", f"/api/submit/{code1}", ctype=None, origin=None))
    rec("receipt HEAD", request(srv, "HEAD", f"/api/submit/{code1}", ctype=None, origin=None))
    rec("receipt none", request(srv, "GET", "/api/submit/" + "x" * 16, ctype=None, origin=None))
    rec("receipt short", request(srv, "GET", "/api/submit/abc", ctype=None, origin=None, extra=[("Accept", "text/html")]))

    m = lambda path, body, ck=A, ip="10.0.4.1": request(srv, "POST", f"/api/manage/{path}", body=jbody(body), ck=ck, ip=ip)  # noqa: E731
    rec("find ok", m("find", {"email": "DEV@example.com", "pin": "123456"}))
    rec("find wrong", m("find", {"email": "dev@example.com", "pin": "999999"}))
    rec("find none", m("find", {"email": "nobody@example.com", "pin": "123456"}))
    rec("find bad email", m("find", {"email": "x", "pin": "123456"}))
    rec("find number pin", m("find", {"email": "dev@example.com", "pin": 123456}))
    for i in range(6):
        rec(f"get wrong pin {i}", m("get", {"id": 2, "pin": "999999"}, ip="10.0.5.1"))
    rec("get locked right pin", m("get", {"id": 2, "pin": "000000"}, ip="10.0.5.1"))
    rec("get none", m("get", {"id": 999, "pin": "123456"}))
    rec("get id string", m("get", {"id": "1", "pin": "123456"}, ck=C))
    rec("img after grant", request(srv, "GET", f"/img/shrines/up/{img_a}", ck=C, ctype=None, origin=None))
    rec("save text", m("save", {"id": 1, "pin": "123456", "tagline": "  고친   한 줄 소개 ", "newPin": "567890", "sign": ""}))
    rec("save old pin", m("get", {"id": 1, "pin": "123456"}))
    rec("save want", m("save", {"id": 1, "pin": "567890", "plot": 3}))
    rec("save want taken?", m("save", {"id": 1, "pin": "567890", "channel": 3, "plot": None}))
    rec("save link", m("save", {"id": 3, "pin": "111111", "url": "https://third-2.dev", "category": "content"}, ck=C))
    rec("save dup", m("save", {"id": 3, "pin": "111111", "url": "https://second.dev"}, ck=C))
    rec("save image other", m("save", {"id": 3, "pin": "111111", "screen": img_b}, ck=C))
    rec("save image mine", m("save", {"id": 2, "pin": "000000", "screen": img_b}, ck=B, ip="10.0.5.2"))
    rec("save bad", m("save", {"id": 3, "pin": "111111", "email": "x"}, ck=C))
    rec("manage unknown", m("nope", {"id": 1}))
    rec("manage empty", m("", {"id": 1}))
    rec("manage no ticket", m("get", {"id": 1, "pin": "567890"}, ck=""))
    rec("withdraw 4", m("withdraw", {"id": 4, "pin": "123456"}, ck=ticket("sid-D2"), ip="10.0.1.4"))
    rec("withdrawn get", m("get", {"id": 4, "pin": "123456"}, ck=ticket("sid-D2"), ip="10.0.1.4"))
    rec("reject via cli", (0, [], srv.cli("reject", "3", "링크가", "열리지", "않아요").stdout.strip().encode()))
    rec("receipt rejected", request(srv, "GET", f"/api/submit/{list(srv.tokens)[list(srv.tokens.values()).index('<code3>')]}",
                                    ctype=None, origin=None))  # fmt: skip
    rec("resubmit rejected", m("save", {"id": 3, "pin": "111111", "tagline": "고쳐서 다시 냄"}, ck=C))
    return out


def flow_phase2(srv: Server) -> list:
    """승인 → 다시 띄움 → 공개 이미지 · 변경 검토 · 변경 승인."""
    out = []

    def cli(label, *args):
        r = srv.cli(*args)
        out.append((label, (r.returncode, [], re.sub(r"\d\d-\d\d \d\d:\d\d", "<when>", (r.stdout + r.stderr).strip()).encode())))

    img_a = next(k for k, v in srv.tokens.items() if v == "<up1>")
    cli("cli approve 1", "approve", "1")
    cli("cli approve 2 plot 3", "approve", "2", "3")
    cli("cli approve 3 taken", "approve", "3", "3")
    cli("cli approve 3 channel 4", "approve", "3", "-", "4")
    cli("cli approve bad", "approve", "x")
    cli("cli reject approved", "reject", "2")
    srv.restart()
    E = ticket("sid-E")
    r = request(srv, "GET", f"/img/shrines/up/{img_a}", ctype=None, origin=None)
    out.append(("public img", r))
    etag = dict((k.lower(), v) for k, v in r[1]).get("etag", "")
    out.append(("public img 304", request(srv, "GET", f"/img/shrines/up/{img_a}", ctype=None, origin=None, extra=[("If-None-Match", etag)])))
    out.append(("public img HEAD", request(srv, "HEAD", f"/img/shrines/up/{img_a}", ctype=None, origin=None)))
    m = lambda path, body, ck=E, ip="10.1.0.1": request(srv, "POST", f"/api/manage/{path}", body=jbody(body), ck=ck, ip=ip)  # noqa: E731
    out.append(("live save", m("save", {"id": 1, "pin": "567890", "name": "바뀐 이름", "url": "https://p2b-parity-2.dev",
                                        "emailPublic": False, "plot": 9})))  # fmt: skip
    out.append(("live save same", m("save", {"id": 1, "pin": "567890", "name": "바뀐 이름"})))
    code1 = next(k for k, v in srv.tokens.items() if v == "<code1>")
    out.append(("receipt live", request(srv, "GET", f"/api/submit/{code1}", ctype=None, origin=None)))
    out.append(("find live", m("find", {"email": "dev@example.com", "pin": "567890"})))
    cli("cli projects", "projects")
    cli("cli projects all", "projects", "all")
    cli("cli approve change", "approve", "1")
    out.append(("after change", m("get", {"id": 1, "pin": "567890"})))
    return out


def flow_retention(srv: Server, pg_url: str) -> list:
    """같은 데이터에 보관 기간 정리: 기본(아무것도 안 함) → 90일 지난 접수 만료 → RETENTION_DAYS=0 파기 → 바로 파기."""
    out = []
    old = int(time.time() * 1000) - 91 * 24 * 3600_000
    run_sql(srv, [("UPDATE projects SET review_at = ? WHERE id = ?", [old, 3])], pg_url)

    def hook(label, *args, extra=None):
        h = srv.hook(*args, extra=extra)
        last = h.stdout.strip().splitlines()[-1] if h.stdout.strip() else h.stderr.strip()[-200:]
        out.append((label, (h.returncode, [], last.encode())))

    hook("retention default", "retention")
    hook("retention 0", "retention", extra={"RETENTION_DAYS": "0"})
    hook("retention 0 again", "retention", extra={"RETENTION_DAYS": "0"})
    hook("erase-now 1", "erase-now", "1")
    hook("erase-now 2", "erase-now", "2")
    hook("erase-now none", "erase-now", "987654")
    rows = dump_projects(srv, pg_url)
    out.append(("projects after", (0, [], json.dumps(rows, ensure_ascii=False, sort_keys=True).encode())))
    out.append(("files left", (0, [], str(files_left(srv)).encode())))
    return out


COLS = ("id", "name", "tagline", "sign", "category", "github", "url", "email", "email_public", "nick", "status", "note", "slug",
        "pending_github", "pending_url", "repo_ok", "stars", "screen", "pending_screen", "want_plot", "want_channel",
        "pending_name", "pending_tagline", "pending_sign")  # fmt: skip
TIMES = ("at", "consent_at", "review_at", "closed_at", "purged_at")


def run_sql(srv: Server, stmts: list[tuple[str, list]], pg_url: str) -> None:
    if srv.kind == "node":
        script = (
            "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1] + '/shrine.db');"
            "for (const [s, p] of JSON.parse(process.argv[2])) db.prepare(s).run(...p); db.close()"
        )
        r = subprocess.run([NODE, "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script, srv.env["DATA_DIR"],
                            json.dumps(stmts)], capture_output=True, timeout=60)  # fmt: skip
        assert r.returncode == 0, r.stderr.decode("utf-8", "replace")
        return
    import asyncpg

    async def go():
        conn = await asyncpg.connect(pg_url.replace("postgresql+asyncpg", "postgresql"))
        for s, p in stmts:
            i = iter(range(1, 100))
            await conn.execute(re.sub(r"\?", lambda _m: f"${next(i)}", s), *p)
        await conn.close()

    asyncio.run(go())


def dump_projects(srv: Server, pg_url: str) -> list:
    sel = f"SELECT {', '.join(COLS + TIMES)} FROM projects ORDER BY id"
    if srv.kind == "node":
        script = (
            "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1] + '/shrine.db');"
            f"console.log(JSON.stringify(db.prepare({json.dumps(sel)}).all())); db.close()"
        )
        r = subprocess.run([NODE, "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script, srv.env["DATA_DIR"]],
                           capture_output=True, timeout=60)  # fmt: skip
        rows = json.loads(r.stdout)
    else:
        import asyncpg

        async def go():
            conn = await asyncpg.connect(pg_url.replace("postgresql+asyncpg", "postgresql"))
            rs = [dict(x) for x in await conn.fetch(sel)]
            await conn.close()
            return rs

        rows = asyncio.run(go())
    return [{**{c: r[c] for c in COLS}, **{t: r[t] is not None for t in TIMES}} for r in rows]


def files_left(srv: Server) -> int:
    return len(list(Path(srv.env["DATA_DIR"], "uploads").iterdir()))


def compare(node: Server, py: Server, a: list, b: list) -> None:
    assert [x[0] for x in a] == [x[0] for x in b]
    diffs = []
    for (label, ra), (_, rb) in zip(a, b):
        na, nb = normalize(node, ra) if isinstance(ra[2], bytes) else ra, normalize(py, rb) if isinstance(rb[2], bytes) else rb
        if na != nb:
            diffs.append((label, na, nb))
    assert not diffs, "\n\n".join(f"{lab}\n node: {x!r}\n   py: {y!r}" for lab, x, y in diffs[:5])


def test_registry_upload_retention_parity(pair):
    node, py = pair["node"], pair["py"]
    a = flow_phase1(node)
    b = flow_phase1(py)
    compare(node, py, a, b)
    # 비교가 헛돌지 않는지: 기준(Node) 쪽이 기대한 갈래를 지났는지 몇 개 확인
    got = {label: r for label, r in a}
    assert len(a) > 60
    assert got["submit ok (image)"][0] == 201 and got["upload declared 11MB"][0] == 413
    assert [got[f"get wrong pin {i}"][0] for i in range(6)] == [403, 403, 403, 403, 403, 429]
    assert got["img owner"][0] == 200 and got["img other"][0] == 404 and got["img after grant"][0] == 200
    a = flow_phase2(node)
    b = flow_phase2(py)
    compare(node, py, a, b)
    got = {label: r for label, r in a}
    assert got["public img"][0] == 200 and got["public img 304"][0] == 304 and b"#1" in got["cli projects"][2]
    assert got["cli approve 3 taken"][0] == 1 and "변경을 승인" in got["cli approve change"][2].decode()
    node.restart()
    py.restart()
    time.sleep(0.5)
    a = flow_retention(node, "")
    b = flow_retention(py, pair["db_url"])
    compare(node, py, a, b)
    got = {label: r for label, r in a}
    assert got["retention default"][2] == b'{"expired":1,"expiredChanges":0,"purged":0,"images":0,"posts":0,"reports":0}'
    assert b'"purged":2' in got["retention 0"][2] and b'"purged":0' in got["retention 0 again"][2]
    assert b'"images":1' in got["erase-now 1"][2] and b'"ok":false' in got["erase-now none"][2]
    time.sleep(1.5)
    hn = sorted(normalize(node, (0, [], t.encode()))[2] for t in _Hook.got.get("/node", []))
    hp = sorted(normalize(py, (0, [], t.encode()))[2] for t in _Hook.got.get("/py", []))
    assert hn and hn == hp, (hn, hp)
