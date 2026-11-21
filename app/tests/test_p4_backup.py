"""P4 백업 도구 시험 (python -m shrine.backup): 개발용 PostgreSQL 컨테이너의 pg_dump · pg_restore로 만들기 → 검사 → 되살리기를
처음부터 끝까지 돌려, 되살린 DB의 모든 행 · 시퀀스 · 이미지가 백업할 때와 같은지 봅니다. 시험 DB는 무작위 이름으로 만들고 지웁니다.

  · pg_dump · pg_restore는 개발용 컨테이너 안에서 돕니다 (PG_DUMP · PG_RESTORE = "docker exec -i <컨테이너> pg_dump …").
    운영 Docker 구성(deploy/README.md 13장)과 같은 방식입니다: 앱 쪽에는 pg 도구가 없고 덤프는 표준 입출력으로 오감.
  · 표준 입력으로 받는 길(--dump -)과 DB만 내보내는 길(--db-to -) · 이미지만(--uploads-only)도 봅니다.
  · 깨진 백업(이미지 한 바이트 · 끊긴 tar · Node 백업)과 서버가 붙어 있을 때 · 백업에 없는 표가 있을 때 되살리지 않는지.
docker · 개발용 컨테이너(musabaepo-dev-pg)가 없으면 건너뜁니다.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import secrets
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path

import pytest

from _p2b_util import PG_ADMIN

APP = Path(__file__).resolve().parents[1]
PG_CONTAINER = os.environ.get("SHRINE_TEST_PG_CONTAINER", "musabaepo-dev-pg")
PG_USER = "postgres"


def _docker_ok() -> bool:
    if shutil.which("docker") is None:
        return False
    try:
        r = subprocess.run(["docker", "exec", PG_CONTAINER, "pg_dump", "--version"], capture_output=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return r.returncode == 0


pytestmark = pytest.mark.skipif(not _docker_ok(), reason=f"docker · {PG_CONTAINER} 컨테이너가 없습니다")


# ── 시험 DB ──


async def _admin(sql: str) -> None:
    import asyncpg

    conn = await asyncpg.connect(PG_ADMIN, timeout=5)
    try:
        await conn.execute(sql)
    finally:
        await conn.close()


def _url(db: str) -> str:
    from sqlalchemy.engine import make_url

    return make_url(PG_ADMIN).set(database=db).render_as_string(hide_password=False)


async def _make_db(name: str, *, schema: bool = True) -> None:
    await _admin(f"CREATE DATABASE {name}")
    if schema:
        from shrine.db.engine import Database
        from sqlalchemy.engine import make_url

        db = Database(make_url(_url(name)).set(drivername="postgresql+asyncpg").render_as_string(hide_password=False), pool_size=1)
        try:
            await db.migrate()
        finally:
            await db.dispose()


async def _fetch(name: str, sql: str, *args):
    import asyncpg

    conn = await asyncpg.connect(_url(name), timeout=5)
    try:
        return await conn.fetch(sql, *args)
    finally:
        await conn.close()


async def _exec(name: str, sql: str, *args) -> None:
    import asyncpg

    conn = await asyncpg.connect(_url(name), timeout=5)
    try:
        await conn.execute(sql, *args)
    finally:
        await conn.close()


async def _snapshot(name: str) -> dict[str, list[str]]:
    """모든 표의 모든 행(JSON 글자, 정렬) + 시퀀스 값."""
    out: dict[str, list[str]] = {}
    tables = [r["tablename"] for r in await _fetch(name, "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")]
    for t in tables:
        rows = await _fetch(name, f'SELECT row_to_json(x)::text AS j FROM "{t}" x')
        out[t] = sorted(r["j"] for r in rows)
    seqs = await _fetch(name, "SELECT sequencename, last_value FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1")
    out["(sequences)"] = [f"{r['sequencename']}={r['last_value']}" for r in seqs]
    return out


SEED = """
INSERT INTO posts (at, topic, text, nick, hidden) VALUES
  (1700000000000, 'etc', E'탭\\t줄바꿈\\n역빗금\\\\ 끝', '새벽의 러버덕 1', 0),
  (1700000000001, 'gpt', '둘째 글 🙏', '고양이', 1),
  (1700000000002, 'claude', '\\.', '점 하나', 0);
INSERT INTO post_reports (post_id, reporter) VALUES (1, 'r1'), (1, 'r2');
INSERT INTO clicks (day, slug, n) VALUES ('2026-01-01', 'x', 3), ('2026-01-02', 'y', 4);
INSERT INTO candles (day, slug, prayer, n) VALUES ('2026-01-01', 'x', 'deploy', 7);
INSERT INTO admin_log (at, action, target, ip_hash, detail) VALUES (1, 'login', '', 'abcdefghijklmnop', ''), (2, 'shrine-add', 'x', 'cli', '이름 · 채널 1 · 0번');
INSERT INTO blocks (at, until, kind, ip_key, sid, nick, reason) VALUES (1, 9999999999999, 'block', 'k:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '', '', '시험');
INSERT INTO shrines (slug, name, tagline, category, domain, url, operator, keeper, paid, verified_domain, verified_business, joined_at,
  status, prayer, charm, deco, screens, captured_at, channel, plot, repo, email, email_public, project_id, sign)
  VALUES ('seed-one', '씨앗 하나', '시험용 사당', 'devtools', 'seed-one.example.com', 'https://seed-one.example.com', '익명', 0, 0,
  '2026-01-01', NULL, '2026-01-01', 'live', 'deploy', NULL, '[]', '["up/AAAAAAAAAAAAAAAA.png"]', '2026-01-01', 1, 0, '', '', 0, 0, '씨앗');
"""


@pytest.fixture
def env(tmp_path: Path):
    """원본 DB(시험 데이터) · 업로드 2개 · 백업 폴더. 끝나면 DB를 지웁니다."""
    name = f"shrine_p4bk_{secrets.token_hex(4)}"
    extra: list[str] = []
    asyncio.run(_make_db(name))
    asyncio.run(_exec(name, SEED))
    data = tmp_path / "data"
    (data / "uploads").mkdir(parents=True)
    (data / "uploads" / "AAAAAAAAAAAAAAAA.png").write_bytes(b"\x89PNG-one" * 100)
    (data / "uploads" / "BBBBBBBBBBBBBBBB.jpg").write_bytes(b"\xff\xd8jpeg-two" * 50)
    e = {
        **{k: v for k, v in os.environ.items() if k.upper() in ("PATH", "SYSTEMROOT", "SYSTEMDRIVE", "TEMP", "TMP", "HOME", "USERPROFILE", "PATHEXT", "WINDIR", "COMSPEC")},
        "PYTHONIOENCODING": "utf-8", "DATA_DIR": str(data), "BACKUP_DIR": str(tmp_path / "backups"), "DATABASE_URL": _url(name),
        "PG_DUMP": f"docker exec -i {PG_CONTAINER} pg_dump -U {PG_USER} -d {name} --format=custom",
        "PG_RESTORE": f"docker exec -i {PG_CONTAINER} pg_restore -U {PG_USER} -d {name} --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error",
    }  # fmt: skip

    def new_db(schema: bool = False) -> str:
        n = f"shrine_p4bk_{secrets.token_hex(4)}"
        asyncio.run(_make_db(n, schema=schema))
        extra.append(n)
        return n

    try:
        yield {"env": e, "db": name, "data": data, "backups": tmp_path / "backups", "tmp": tmp_path, "new_db": new_db}
    finally:
        for n in [name, *extra]:
            asyncio.run(_admin(f"DROP DATABASE IF EXISTS {n} WITH (FORCE)"))


def tool(e: dict, *args: str, input: bytes | None = None, env_patch: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "shrine.backup", *args], cwd=APP, env={**e, **(env_patch or {})}, input=input, capture_output=True, timeout=180
    )


def out(r: subprocess.CompletedProcess) -> str:
    return r.stdout.decode("utf-8", "replace") + r.stderr.decode("utf-8", "replace")


def only_tar(d: Path) -> Path:
    tars = sorted(d.glob("shrine-*.tar"))
    assert len(tars) == 1, tars
    return tars[0]


# ── 처음부터 끝까지 ──


def test_round_trip_create_verify_restore(env):
    e = env["env"]
    before = asyncio.run(_snapshot(env["db"]))
    assert len(before["posts"]) == 3 and before["(sequences)"]

    r = tool(e, "create")
    assert r.returncode == 0, out(r)
    text = out(r)
    assert "[backup] 만들었습니다:" in text and "posts 3" in text and "shrines 1" in text and "이미지 2개" in text
    f = only_tar(env["backups"])
    with tarfile.open(f) as tf:
        names = tf.getnames()
        man = json.loads(tf.extractfile("manifest.json").read())
        assert tf.getmember("db.dump").mode == 0o600
    assert names == ["db.dump", "uploads", "uploads/AAAAAAAAAAAAAAAA.png", "uploads/BBBBBBBBBBBBBBBB.jpg", "manifest.json"]
    assert man["format"] == "musabaepo-shrine-backup" and man["version"] == 2 and man["engine"] == "postgresql"
    assert man["tables"]["posts"] == 3 and man["tables"]["post_reports"] == 2 and man["tables"]["alembic_version"] == 1
    assert man["uploads"] == 2 and set(man["sha256"]) == {"db.dump", "uploads/AAAAAAAAAAAAAAAA.png", "uploads/BBBBBBBBBBBBBBBB.jpg"}
    assert man["pgDump"]["compression"] == "gzip"

    r = tool(e, "verify", str(f))
    assert r.returncode == 0 and "[backup] 이상 없습니다" in out(r) and "posts 3" in out(r), out(r)
    r = tool(e, "list")
    assert r.returncode == 0 and f.name in out(r) and "0.0일 전" in out(r)

    # 백업 뒤에 바뀐 것: 행 지우고 더하기 · 시퀀스 늘리기 · 이미지 바꾸기
    asyncio.run(_exec(env["db"], "DELETE FROM posts WHERE id = 1; INSERT INTO posts (at, topic, text, nick) VALUES (5, 'etc', 'new', 'n'); "
                                  "UPDATE shrines SET name = '바뀐 이름'; DELETE FROM clicks"))  # fmt: skip
    up = env["data"] / "uploads"
    (up / "AAAAAAAAAAAAAAAA.png").unlink()
    (up / "CCCCCCCCCCCCCCCC.webp").write_bytes(b"RIFF-new")
    assert asyncio.run(_snapshot(env["db"])) != before

    r = tool(e, "restore", str(f))
    assert r.returncode == 0, out(r)
    assert "[backup] 되살렸습니다:" in out(r) and "pre-restore-" in out(r)
    assert asyncio.run(_snapshot(env["db"])) == before
    assert sorted(p.name for p in up.iterdir()) == ["AAAAAAAAAAAAAAAA.png", "BBBBBBBBBBBBBBBB.jpg"]
    assert (up / "AAAAAAAAAAAAAAAA.png").read_bytes() == b"\x89PNG-one" * 100
    aside = [p for p in env["data"].iterdir() if p.name.startswith("pre-restore-")]
    assert len(aside) == 1
    assert sorted(p.name for p in (aside[0] / "uploads").iterdir()) == ["BBBBBBBBBBBBBBBB.jpg", "CCCCCCCCCCCCCCCC.webp"]
    assert (aside[0] / "db.dump").read_bytes()[:5] == b"PGDMP"  # 되살리기 전 DB 사본
    assert not [p for p in env["data"].iterdir() if p.name.startswith(".restore-")]


def test_pipe_mode_like_docker(env):
    """운영 Docker와 같은 길: pg_dump → create --dump - (표준 입력), restore --db-to - → pg_restore, restore --uploads-only."""
    e = {k: v for k, v in env["env"].items() if k != "PG_DUMP"}
    dump = subprocess.run(
        ["docker", "exec", "-i", PG_CONTAINER, "pg_dump", "-U", PG_USER, "-d", env["db"], "--format=custom"], capture_output=True, timeout=120
    ).stdout
    r = tool(e, "create", "--dump", "-", input=dump)
    assert r.returncode == 0, out(r)
    f = only_tar(env["backups"])
    before = asyncio.run(_snapshot(env["db"]))

    # 빈 DB에 DB만 되살리기 (pg_restore는 부르는 쪽이)
    target = env["new_db"](schema=False)
    r = tool({**e, "DATABASE_URL": _url(target)}, "restore", str(f), "--db-to", "-")
    assert r.returncode == 0, r.stderr.decode("utf-8", "replace")
    assert r.stdout[:5] == b"PGDMP" and "검사한 DB 덤프를 내보냈습니다" in r.stderr.decode("utf-8")
    rr = subprocess.run(
        ["docker", "exec", "-i", PG_CONTAINER, "pg_restore", "-U", PG_USER, "-d", target, "--no-owner", "--no-privileges",
         "--single-transaction", "--exit-on-error"], input=r.stdout, capture_output=True, timeout=120,
    )  # fmt: skip
    assert rr.returncode == 0, rr.stderr
    assert asyncio.run(_snapshot(target)) == before

    # 이미지만 다른 DATA_DIR로
    other = env["tmp"] / "other-data"
    r = tool(e, "restore", str(f), str(other), "--uploads-only")
    assert r.returncode == 0, out(r)
    assert sorted(p.name for p in (other / "uploads").iterdir()) == ["AAAAAAAAAAAAAAAA.png", "BBBBBBBBBBBBBBBB.jpg"]
    assert "DB: 그대로 (--uploads-only)" in out(r)

    # 빈 덤프 · 깨진 덤프는 아무것도 남기지 않고 1
    for bad in (b"", dump[: len(dump) // 2], b"not a dump at all"):
        r = tool(e, "create", "--dump", "-", input=bad)
        assert r.returncode == 1 and "[backup]" in out(r), out(r)
    assert len(list(env["backups"].glob("shrine-*.tar"))) == 1
    assert not [p for p in env["backups"].iterdir() if p.name.startswith(".")]


def test_refuses_when_server_connected_or_extra_table(env):
    e = env["env"]
    assert tool(e, "create").returncode == 0
    f = only_tar(env["backups"])

    async def hold():
        import asyncpg

        conn = await asyncpg.connect(_url(env["db"]), server_settings={"application_name": "musabaepo-shrine"})
        try:
            await asyncio.sleep(0.2)
            return await asyncio.to_thread(tool, e, "restore", str(f))
        finally:
            await conn.close()

    r = asyncio.run(hold())
    assert r.returncode == 1 and "서버(또는 운영 명령)가 아직 DB에 붙어 있습니다" in out(r), out(r)

    asyncio.run(_exec(env["db"], "CREATE TABLE newer_table (x int)"))
    r = tool(e, "restore", str(f))
    assert r.returncode == 1 and "newer_table" in out(r), out(r)
    r = tool(e, "restore", str(f), "--force")
    assert r.returncode == 0, out(r)


def _rewrite_tar(src: Path, dst: Path, change) -> None:
    """tar 항목을 그대로 옮기되 change(name, bytes) → bytes | None(빼기)."""
    with tarfile.open(src) as a, tarfile.open(dst, "w", format=tarfile.USTAR_FORMAT) as b:
        for m in a:
            data = a.extractfile(m).read() if m.isreg() else None
            if data is not None:
                data = change(m.name, data)
                if data is None:
                    continue
                m.size = len(data)
                b.addfile(m, io.BytesIO(data))
            else:
                b.addfile(m)


def test_verify_catches_damage(env):
    e = env["env"]
    assert tool(e, "create").returncode == 0
    f = only_tar(env["backups"])
    d = env["tmp"]

    flipped = d / "flipped.tar"
    _rewrite_tar(f, flipped, lambda n, b: (b[:-1] + bytes([b[-1] ^ 1])) if n.endswith(".png") else b)
    r = tool(e, "verify", str(flipped))
    assert r.returncode == 1 and "파일 손상" in out(r) and "uploads/AAAAAAAAAAAAAAAA.png" in out(r), out(r)

    dropped = d / "dropped.tar"
    _rewrite_tar(f, dropped, lambda n, b: None if n.endswith(".jpg") else b)
    r = tool(e, "verify", str(dropped))
    assert r.returncode == 1 and "이미지: 백업 당시 2개, 지금 1개" in out(r), out(r)

    raw = f.read_bytes()
    for cut in (len(raw) // 2, len(raw) - 1024, 700):
        part = d / f"cut-{cut}.tar"
        part.write_bytes(raw[:cut])
        r = tool(e, "verify", str(part))
        assert r.returncode == 1 and "[backup]" in out(r), (cut, out(r))

    node = d / "node.tar"
    with tarfile.open(node, "w", format=tarfile.USTAR_FORMAT) as t:
        body = json.dumps({"format": "musabaepo-shrine-backup", "version": 1, "tables": {}, "uploads": 0, "uploadBytes": 0}).encode()
        for name, data in (("shrine.db", b"SQLite format 3\0"), ("manifest.json", body)):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
    r = tool(e, "verify", str(node))
    assert r.returncode == 1 and "Node(SQLite) 서버가 만든 백업" in out(r), out(r)
    r = tool(e, "restore", str(node))
    assert r.returncode == 1 and "Node(SQLite)" in out(r)
    assert tool(e, "verify", str(d / "nope.tar")).returncode == 1


def test_prune_keep_and_age(env):
    from shrine import backup as bk

    d = env["backups"]
    d.mkdir()
    now = time.time()
    names = []
    for days in (0, 1, 2, 12.9, 13.1, 20):
        t = time.gmtime(now - days * 86400)
        n = f"shrine-{time.strftime('%Y%m%d-%H%M%S', t)}Z.tar"
        (d / n).write_bytes(b"x")
        names.append(n)
    old_dump = d / "pre-restore-20200101-000000Z.dump"
    old_dump.write_bytes(b"PGDMP")
    os.utime(old_dump, (now - 20 * 86400, now - 20 * 86400))
    new_dump = d / "pre-restore-20991231-000000Z.dump"
    new_dump.write_bytes(b"PGDMP")
    (d / "notes.txt").write_text("남겨 둠")
    s = bk.Settings(data_dir=env["data"], backup_dir=d, keep=3, max_days=14)
    removed = bk.prune_backups(s)
    left = sorted(p.name for p in d.glob("shrine-*.tar"))
    assert left == sorted(names[:3])  # keep 3 (12.9일짜리는 4번째라 빠짐)
    assert set(removed) == {names[3], names[4], names[5], old_dump.name}
    assert new_dump.exists() and (d / "notes.txt").exists()
    # 같은 초에 두 번 만들면 -2
    e = env["env"]
    assert tool(e, "create").returncode == 0
    assert tool(e, "create").returncode == 0
    got = sorted(p.name for p in d.glob("shrine-*.tar"))
    assert any(n.endswith("Z-2.tar") for n in got) or len(got) >= 4


def test_size_and_to_fixed():
    from shrine import backup as bk

    assert bk.size(4) == "1KB" and bk.size(1536) == "2KB" and bk.size(512) == "1KB" and bk.size(1024 * 1024 * 3 // 2) == "1.5MB"
    assert bk._to_fixed(0.25, 1) == "0.3" and bk._to_fixed(0.04, 1) == "0.0" and bk._to_fixed(13.95, 1) == "13.9" and bk._to_fixed(1.005, 2) == "1.00"  # node로 확인한 값
    assert bk.table_line({}) == "(표 없음)" and bk.table_line({"a": 1, "b": 2}) == "a 1 · b 2"
    assert bk.created_ms_of("shrine-20261117-031500Z-2.tar") == 1794885300000
