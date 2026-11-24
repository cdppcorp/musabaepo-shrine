"""고사상 물건(gosa): 새로 연 사당(첫 주, isNew) 앞에 놓는 물건을 사당 주인이 등록소에서 고르고 운영자가 바꿉니다.

  · DB: Alembic 0002 — shrines.gosa(NOT NULL DEFAULT 'cake', CHECK ck_shrines_gosa) · projects.gosa(NULL = 기본)
  · 등록소: POST /api/submit · /api/manage/save가 gosa를 받고(틀리면 400 gosa), 맵에 있는 사당은 검토 없이 바로 바뀜
  · 승인: 작성자가 고른 것(없으면 cake)으로 사당을 세움
  · 운영자: 사당 추가 · 고치기(admin_log) · 목록, 접수 자세히 보기
  · 공개: /api/world 사당마다 맨 끝 키 gosa
  · 운영 명령: add <json>의 "gosa"

PostgreSQL · Redis가 없으면 건너뜁니다. Redis는 DB 15번을 씁니다 (다른 시험: 0 · 13 · 14, 적합성 시험: 1~12).
"""

from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from starlette.requests import Request

from _p2b_util import PG_ADMIN, TICKET_SECRET, fresh_ctx, ticket
from shrine import admin_api, ops, shrines
from shrine import registry as reg
from shrine.db.engine import Database, alembic_config
from shrine.logic import links as L
from shrine.logic.jsnum import json_stringify
from shrine.logic.util import kst_date
from shrine.web import registry as web_reg

APP_DIR = Path(__file__).resolve().parents[1]
REDIS_DB = 15
ADMIN_ENV = {"ADMIN_PASSWORD": "gosa-unit-admin-password-0123456789", "ADMIN_IPS": "198.51.100.10"}


@pytest.fixture
async def ctx(tmp_path: Path):
    async with fresh_ctx(tmp_path, redis_db=REDIS_DB, **ADMIN_ENV) as c:
        yield c


BASE = {
    "name": "고사 시험", "tagline": "고사상 시험용 프로젝트", "category": "devtools", "url": "https://gosa-demo.dev",
    "email": "owner@example.com", "emailPublic": False, "pin": "123456", "consent": True,
}  # fmt: skip
_n = 0


def _next() -> int:
    global _n
    _n += 1
    return _n


async def submit(ctx, **patch) -> dict:
    n = _next()
    return await reg.submit_project(ctx, {**BASE, "url": f"https://gosa-{n}.dev", **patch}, f"gosa-sid-{n}", f"gosa-ip-{n}", "닉")


async def one(ctx, sql: str, **p):
    async with ctx.db.session() as s:
        return (await s.execute(text(sql), p)).scalar_one()


# ── 공유 상수 ────────────────────────────────────────────────────────


def test_keys_and_validation():
    assert L.GOSA_KEYS == ("cake", "wreath", "siru", "bugeo") and L.GOSA_DEFAULT == "cake"
    assert "pig" not in L.GOSA_KEYS
    assert all(L.is_gosa_key(k) for k in L.GOSA_KEYS) and not L.is_gosa_key("pig") and not L.is_gosa_key(None)
    assert reg.read_gosa(None) == {"ok": True, "gosa": None} and reg.read_gosa("") == {"ok": True, "gosa": None}
    assert reg.read_gosa("siru") == {"ok": True, "gosa": "siru"}
    for bad in ("pig", "CAKE", " cake", 1, True, ["cake"], {"k": "cake"}):
        assert reg.read_gosa(bad) == {"ok": False, "status": 400, "reason": "gosa"}, bad
    # 사당 규칙: 없으면(None) 통과, 아는 키만
    s = {
        "slug": "a", "name": "n", "tagline": "t", "category": "etc", "domain": "example.com", "url": "https://example.com",
        "operator": "o", "keeper": False, "paid": False, "verifiedDomain": "2026-01-01", "verifiedBusiness": None,
        "joinedAt": "2026-01-01", "status": "live", "prayer": "deploy", "charm": None, "deco": [], "screens": ["a.png"],
        "capturedAt": "2026-01-01", "channel": 1, "plot": 0, "repo": "", "email": "", "emailPublic": False, "projectId": 0, "sign": "",
    }  # fmt: skip
    assert L.validate_shrine(s) == [] and L.validate_shrine({**s, "gosa": "bugeo"}) == []
    assert L.validate_shrine({**s, "gosa": "pig"}) == ["고사상"]
    # 공개 모양: 맨 끝 키, 없으면 기본
    assert list(L.public_shrine(s))[-2:] == ["isNew", "gosa"] and L.public_shrine(s)["gosa"] == "cake"
    assert L.public_shrine({**s, "gosa": "wreath"})["gosa"] == "wreath"
    assert L.from_row({"gosa": "siru", **_row()})["gosa"] == "siru" and L.from_row(_row())["gosa"] == "cake"


def _row() -> dict:
    return {
        "slug": "a", "name": "n", "tagline": "t", "category": "etc", "domain": "example.com", "url": "https://example.com",
        "operator": "o", "keeper": 0, "paid": 0, "verified_domain": "", "verified_business": None, "joined_at": "2026-01-01",
        "status": "live", "prayer": "bug", "charm": None, "deco": "[]", "screens": "[]", "captured_at": "2026-01-01",
        "channel": 1, "plot": 2, "repo": "", "email": "", "email_public": 0, "project_id": 0, "sign": "",
    }  # fmt: skip


# ── 마이그레이션 ─────────────────────────────────────────────────────


@pytest.fixture
async def raw_db():
    import asyncpg

    try:
        admin = await asyncpg.connect(PG_ADMIN, timeout=3)
    except Exception:
        pytest.skip("PostgreSQL이 없어 마이그레이션을 시험하지 않습니다")
    name = f"shrine_gosa_{secrets.token_hex(4)}"
    await admin.execute(f"CREATE DATABASE {name}")
    url = make_url(PG_ADMIN).set(drivername="postgresql+asyncpg", database=name).render_as_string(hide_password=False)
    database = Database(url)
    try:
        yield database
    finally:
        await database.dispose()
        await admin.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")
        await admin.close()


async def _alembic(db: Database, cmd: str, rev: str) -> None:
    from alembic import command

    async with db.engine.begin() as conn:
        await conn.run_sync(lambda c: getattr(command, cmd)(alembic_config(c), rev))


async def _columns(db: Database, table: str) -> dict[str, tuple]:
    async with db.engine.connect() as conn:
        rows = (
            await conn.execute(
                text(
                    "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns "
                    "WHERE table_schema = 'public' AND table_name = :t ORDER BY ordinal_position"
                ),
                {"t": table},
            )
        ).all()
    return {r[0]: tuple(r[1:]) for r in rows}


LEGACY_SHRINE = (
    "INSERT INTO shrines (slug, name, tagline, category, domain, url, operator, verified_domain, joined_at, status, prayer, "
    "captured_at, channel, plot) VALUES ('old', '옛 사당', '옛 소개', 'etc', 'old.example.com', 'https://old.example.com', 'o', "
    "'2026-01-01', '2026-01-01', 'live', 'deploy', '2026-01-01', 1, 0)"
)
LEGACY_PROJECT = (
    "INSERT INTO projects (code, at, name, tagline, category, email, pin_hash, nick) "
    "VALUES ('legacycode000000', 1, '옛 접수', '옛 소개', 'etc', 'a@example.com', 'x:y', 'n')"
)


async def test_migration_from_0001_keeps_rows_and_adds_columns(raw_db: Database):
    db = raw_db
    await _alembic(db, "upgrade", "0001")
    assert "gosa" not in await _columns(db, "shrines")
    async with db.begin() as s:
        await s.execute(text(LEGACY_SHRINE))
        await s.execute(text(LEGACY_PROJECT))
    await db.migrate()  # 서버 시작과 같은 길 (advisory lock + upgrade head)
    await db.migrate()  # 두 번째는 그대로
    async with db.engine.connect() as conn:
        assert (await conn.execute(text("SELECT version_num FROM alembic_version"))).scalar_one() == "0002"
        assert (await conn.execute(text("SELECT gosa FROM shrines WHERE slug = 'old'"))).scalar_one() == "cake"
        assert (await conn.execute(text("SELECT gosa FROM projects"))).scalar_one() is None
        ck = (
            await conn.execute(text("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_shrines_gosa'"))
        ).scalar_one()
    assert all(f"'{k}'" in ck for k in L.GOSA_KEYS) and "pig" not in ck, ck
    sh, pr = await _columns(db, "shrines"), await _columns(db, "projects")
    assert list(sh)[-1] == "gosa" and sh["gosa"] == ("text", "NO", "'cake'::text")
    assert list(pr)[-1] == "gosa" and pr["gosa"] == ("text", "YES", None)
    # 새 행은 기본 'cake', 모르는 키는 CHECK가 막음
    async with db.begin() as s:
        await s.execute(text(LEGACY_SHRINE.replace("'old'", "'new'").replace("old.example", "new.example").replace(", 1, 0)", ", 1, 1)")))
        assert (await s.execute(text("SELECT gosa FROM shrines WHERE slug = 'new'"))).scalar_one() == "cake"
        await s.execute(text("UPDATE shrines SET gosa = 'bugeo' WHERE slug = 'new'"))
    with pytest.raises(IntegrityError, match="ck_shrines_gosa"):
        async with db.begin() as s:
            await s.execute(text("UPDATE shrines SET gosa = 'pig' WHERE slug = 'old'"))
    with pytest.raises(IntegrityError):
        async with db.begin() as s:
            await s.execute(text("UPDATE shrines SET gosa = NULL WHERE slug = 'old'"))
    # 되돌리기 → 다시 올리기 (downgrade도 깨끗이 돎)
    await _alembic(db, "downgrade", "0001")
    assert "gosa" not in await _columns(db, "shrines") and "gosa" not in await _columns(db, "projects")
    await db.migrate()
    async with db.engine.connect() as conn:
        rows = (await conn.execute(text("SELECT slug, gosa FROM shrines ORDER BY slug"))).all()
    assert [tuple(r) for r in rows] == [("new", "cake"), ("old", "cake")]


async def test_migration_on_empty_db_matches_models(raw_db: Database):
    from alembic.autogenerate import compare_metadata
    from alembic.runtime.migration import MigrationContext

    from shrine.db.models import Base

    await raw_db.migrate()
    async with raw_db.engine.connect() as conn:
        diff = await conn.run_sync(
            lambda c: compare_metadata(MigrationContext.configure(c, opts={"compare_type": True}), Base.metadata)
        )
    assert [d for d in diff if "gosa" in repr(d)] == []
    assert diff == [], diff  # 모델(db/models.py)과 마이그레이션이 같은 모양


# ── 등록소 ───────────────────────────────────────────────────────────


async def test_submit_and_manage_get(ctx):
    r = await submit(ctx, gosa="wreath")
    assert r["ok"], r
    assert await one(ctx, "SELECT gosa FROM projects WHERE id = :i", i=r["id"]) == "wreath"
    g = await reg.manage_get(ctx, {"id": r["id"], "pin": "123456"}, "ipx")
    assert g["ok"] and g["project"]["gosa"] == "wreath" and list(g["project"])[-1] == "gosa"
    # 안 고르면 NULL (사당은 기본 cake), 빈 글자도 안 고른 것
    for patch in ({}, {"gosa": None}, {"gosa": ""}):
        r2 = await submit(ctx, **patch)
        assert r2["ok"], (patch, r2)
        assert (await reg.manage_get(ctx, {"id": r2["id"], "pin": "123456"}, "ipx"))["project"]["gosa"] is None
    # 틀린 값 → 400 gosa, 아무것도 안 들어감
    before = await one(ctx, "SELECT COUNT(*) FROM projects")
    for bad in ("pig", 3, ["cake"]):
        assert await submit(ctx, gosa=bad) == {"ok": False, "status": 400, "reason": "gosa"}
    assert await one(ctx, "SELECT COUNT(*) FROM projects") == before
    # 운영자 접수 자세히 보기 · 목록에도
    assert (await reg.project_for_admin(ctx, r["id"]))["gosa"] == "wreath"
    assert {p["id"]: p["gosa"] for p in await reg.projects_by_filter(ctx, "all")}[r["id"]] == "wreath"


async def test_manage_save_pending_and_approve_uses_owner_choice(ctx):
    r = await submit(ctx)
    pid = r["id"]
    auth = {"id": pid, "pin": "123456"}
    assert await reg.manage_save(ctx, {**auth, "gosa": "pig"}, "ipx") == {"ok": False, "status": 400, "reason": "gosa"}
    assert await one(ctx, "SELECT gosa FROM projects WHERE id = :i", i=pid) is None
    s = await reg.manage_save(ctx, {**auth, "gosa": "siru"}, "ipx")
    assert s["ok"] and s["project"]["gosa"] == "siru" and s["linkReview"] is False
    assert await one(ctx, "SELECT COUNT(*) FROM shrines") == 0
    msg = await reg.approve_project(ctx, pid)
    assert "승인했습니다" in msg
    slug = await one(ctx, "SELECT slug FROM projects WHERE id = :i", i=pid)
    assert await one(ctx, "SELECT gosa FROM shrines WHERE slug = :s", s=slug) == "siru"
    # 안 고른 접수는 cake
    r2 = await submit(ctx)
    await reg.approve_project(ctx, r2["id"])
    slug2 = await one(ctx, "SELECT slug FROM projects WHERE id = :i", i=r2["id"])
    assert await one(ctx, "SELECT gosa FROM shrines WHERE slug = :s", s=slug2) == "cake"
    pub = {x["slug"]: x for x in await shrines.public_shrines(ctx)}
    assert pub[slug]["gosa"] == "siru" and pub[slug2]["gosa"] == "cake" and pub[slug]["isNew"] is True


async def test_manage_save_live_updates_shrine_now_and_clears_cache(ctx):
    r = await submit(ctx, gosa="wreath")
    pid = r["id"]
    auth = {"id": pid, "pin": "123456"}
    await reg.approve_project(ctx, pid)
    slug = await one(ctx, "SELECT slug FROM projects WHERE id = :i", i=pid)
    assert (await shrines.find_shrine(ctx, slug))["gosa"] == "wreath"  # 캐시를 채워 둠 (30초)
    s = await reg.manage_save(ctx, {**auth, "gosa": "bugeo"}, "ipx")
    assert s["ok"] and s["project"]["gosa"] == "bugeo"
    # 검토 없이: 변경 검토 표시 없음, 맵 사당 · 공개 모양에 바로 (캐시가 비워져서)
    assert s["linkReview"] is False and s["project"]["note"] == ""
    assert await one(ctx, "SELECT review_at FROM projects WHERE id = :i", i=pid) is None
    assert await one(ctx, "SELECT gosa FROM shrines WHERE slug = :s", s=slug) == "bugeo"
    assert (await shrines.find_shrine(ctx, slug))["gosa"] == "bugeo"
    assert {x["slug"]: x["gosa"] for x in await shrines.public_shrines(ctx)}[slug] == "bugeo"
    # 틀린 값이면 아무것도 안 바뀜
    assert await reg.manage_save(ctx, {**auth, "gosa": "pig", "name": "새 이름"}, "ipx") == {"ok": False, "status": 400, "reason": "gosa"}
    assert await one(ctx, "SELECT gosa FROM shrines WHERE slug = :s", s=slug) == "bugeo"
    assert await one(ctx, "SELECT pending_name FROM projects WHERE id = :i", i=pid) is None
    # 운영자가 바꾼 값은 작성자가 다른 칸만 고칠 때 덮이지 않음
    await ops.update_shrine(ctx, slug, {"gosa": "siru"})
    assert await one(ctx, "SELECT gosa FROM projects WHERE id = :i", i=pid) == "siru"
    s = await reg.manage_save(ctx, {**auth, "category": "life"}, "ipx")
    assert s["ok"] and s["project"]["gosa"] == "siru"
    assert await one(ctx, "SELECT gosa FROM shrines WHERE slug = :s", s=slug) == "siru"
    # 글자 변경(검토 대기)과 함께 보내도 고사상은 바로
    s = await reg.manage_save(ctx, {**auth, "gosa": "cake", "name": "검토할 이름"}, "ipx")
    assert s["ok"] and s["linkReview"] is True and s["project"]["gosa"] == "cake"
    assert await one(ctx, "SELECT gosa FROM shrines WHERE slug = :s", s=slug) == "cake"
    assert await one(ctx, "SELECT name FROM shrines WHERE slug = :s", s=slug) == "고사 시험"  # 이름은 검토 뒤
    # null = 기본으로 되돌림 (접수는 NULL, 사당은 cake)
    s = await reg.manage_save(ctx, {**auth, "gosa": None}, "ipx")
    assert s["ok"] and s["project"]["gosa"] is None
    assert await one(ctx, "SELECT gosa FROM shrines WHERE slug = :s", s=slug) == "cake"


# ── HTTP 모양 (web/registry.py registry_api를 바로 부름) ──────────────


async def _post(ctx, path: str, body: dict) -> tuple[int, dict]:
    n = _next()
    raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
    headers = [
        (b"host", b"shrine.test"), (b"content-type", b"application/json"), (b"content-length", str(len(raw)).encode()),
        (b"cookie", f"shrine_ticket={ticket(f'gosa-http-{n}', secret=TICKET_SECRET)}".encode()),
    ]  # fmt: skip
    scope = {
        "type": "http", "method": "POST", "path": path, "raw_path": path.encode(), "headers": headers, "query_string": b"",
        "app": SimpleNamespace(state=SimpleNamespace(ctx=ctx)), "state": {"client_ip": "198.51.100.77", "ip_hash": f"gosa-http-ip-{n}"},
    }  # fmt: skip
    done = False

    async def receive():
        nonlocal done
        if done:
            return {"type": "http.disconnect"}
        done = True
        return {"type": "http.request", "body": raw, "more_body": False}

    resp = await web_reg.registry_api(Request(scope, receive))
    return resp.status_code, json.loads(resp.body)


async def test_http_shapes(ctx):
    st, body = await _post(ctx, "/api/submit", {**BASE, "url": "https://gosa-http.dev", "gosa": "pig"})
    assert (st, body) == (400, {"ok": False, "reason": "gosa"})
    st, body = await _post(ctx, "/api/submit", {**BASE, "url": "https://gosa-http.dev", "gosa": "siru"})
    assert st == 201 and body["ok"], body
    pid = body["id"]
    st, body = await _post(ctx, "/api/manage/get", {"id": pid, "pin": "123456"})
    assert st == 200 and body["project"]["gosa"] == "siru"
    st, body = await _post(ctx, "/api/manage/save", {"id": pid, "pin": "123456", "gosa": "x"})
    assert (st, body) == (400, {"ok": False, "reason": "gosa"})
    st, body = await _post(ctx, "/api/manage/save", {"id": pid, "pin": "123456", "gosa": "bugeo"})
    assert st == 200 and body["ok"] and body["project"]["gosa"] == "bugeo"


# ── 운영자 ───────────────────────────────────────────────────────────

ADD = {"name": "운영 사당", "tagline": "운영자가 세운 사당", "category": "productivity", "url": "https://gosa-ops.example.com"}
SCREEN = ["up/AAAAAAAAAAAAAAAA.png"]


def _req(query: bytes = b"") -> SimpleNamespace:
    return SimpleNamespace(scope={"headers": [], "query_string": query}, state=SimpleNamespace(client_ip="198.51.100.10"), client=None)


async def test_admin_add_update_list_and_log(ctx):
    sh = await ops.add_shrine(ctx, dict(ADD), SCREEN)
    assert sh["gosa"] == "cake" and list(sh)[-1] == "gosa"
    sh2 = await ops.add_shrine(ctx, {**ADD, "url": "https://gosa-ops2.example.com", "gosa": "wreath"}, SCREEN)
    assert await one(ctx, "SELECT gosa FROM shrines WHERE slug = :s", s=sh2["slug"]) == "wreath"
    with pytest.raises(ops.OpError) as e:
        await ops.add_shrine(ctx, {**ADD, "url": "https://gosa-ops3.example.com", "gosa": "pig"}, SCREEN)
    assert e.value.status == 400 and "고사상" in str(e.value)

    s = {"sid": "admin-sid", "exp": 0}
    r = await admin_api.writes(ctx, _req(), s, "shrine/update", {"slug": sh["slug"], "gosa": "siru"})
    assert r.status == 200 and r.body["changed"] == ["gosa"] and r.body["shrine"]["gosa"] == "siru"
    assert await one(ctx, "SELECT gosa FROM shrines WHERE slug = :s", s=sh["slug"]) == "siru"
    log = await ops.read_log(ctx, "5")
    assert (log[0]["action"], log[0]["target"], log[0]["detail"]) == ("shrine-update", sh["slug"], "gosa")
    # 같은 값이면 바뀐 것 없음 · 틀린 값은 400 rule
    r = await admin_api.writes(ctx, _req(), s, "shrine/update", {"slug": sh["slug"], "gosa": "siru"})
    assert r.body["changed"] == []
    with pytest.raises(ops.OpError) as e:
        await admin_api.writes(ctx, _req(), s, "shrine/update", {"slug": sh["slug"], "gosa": "pig"})
    assert admin_api.error_reply(e.value).body == {"ok": False, "reason": "rule", "message": str(e.value)}
    # 목록 (규칙에 맞음)
    r = await admin_api.reads(ctx, _req(), s, "shrines")
    rows = {x["slug"]: x for x in r.body["shrines"]}
    assert rows[sh["slug"]]["gosa"] == "siru" and rows[sh2["slug"]]["gosa"] == "wreath" and rows[sh["slug"]]["errors"] == []
    # 접수 자세히 보기에 작성자가 고른 것
    p = await submit(ctx, gosa="bugeo")
    r = await admin_api.reads(ctx, _req(f"id={p['id']}".encode()), s, "project")
    assert r.body["project"]["gosa"] == "bugeo"
    # 공개: 모든 사당 맨 끝 키
    pub = await shrines.public_shrines(ctx)
    assert pub and all(list(x)[-1] == "gosa" and x["gosa"] in L.GOSA_KEYS for x in pub)
    assert '"isNew":true,"gosa":"siru"}' in json_stringify([x for x in pub if x["slug"] == sh["slug"]])


async def test_admin_update_registry_shrine_syncs_project(ctx):
    r = await submit(ctx)
    await reg.approve_project(ctx, r["id"])
    slug = await one(ctx, "SELECT slug FROM projects WHERE id = :i", i=r["id"])
    # 다른 칸만 고치면 접수의 gosa(NULL)는 그대로
    await ops.update_shrine(ctx, slug, {"operator": "새 운영자"})
    assert await one(ctx, "SELECT gosa FROM projects WHERE id = :i", i=r["id"]) is None
    await ops.update_shrine(ctx, slug, {"gosa": "wreath"})
    assert await one(ctx, "SELECT gosa FROM projects WHERE id = :i", i=r["id"]) == "wreath"
    g = await reg.manage_get(ctx, {"id": r["id"], "pin": "123456"}, "ipx")
    assert g["project"]["gosa"] == "wreath"


# ── 운영 명령 ────────────────────────────────────────────────────────


async def test_cli_add_gosa(ctx, tmp_path: Path):
    name = ctx.db.engine.url.database
    env = {
        **os.environ, "DATABASE_URL": make_url(PG_ADMIN).set(database=name).render_as_string(hide_password=False),
        "REDIS_URL": f"redis://127.0.0.1:56379/{REDIS_DB}", "DATA_DIR": str(tmp_path), "TICKET_SECRET": TICKET_SECRET,
        "PYTHONIOENCODING": "utf-8",
    }  # fmt: skip
    for k in ("NODE_ENV", "BASE_PATH", "PUBLIC_ORIGIN", "ADMIN_PASSWORD", "ADMIN_IPS"):
        env.pop(k, None)
    today = kst_date()

    def shrine(slug: str, plot: int, **over) -> str:
        return json.dumps({
            "slug": slug, "name": slug, "tagline": "운영 명령 사당", "category": "etc", "domain": f"{slug}.example.com",
            "url": f"https://{slug}.example.com", "operator": "op", "keeper": False, "paid": False, "verifiedDomain": today,
            "verifiedBusiness": None, "joinedAt": today, "status": "live", "prayer": "deploy", "charm": None, "deco": [],
            "screens": ["x.png"], "capturedAt": today, "plot": plot, "sign": "", **over,
        })  # fmt: skip

    def cli(data: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "-m", "shrine.cli", "add", "-"], input=data.encode("utf-8"), cwd=APP_DIR, env=env,
            capture_output=True, timeout=60,
        )  # fmt: skip

    ok = cli(shrine("cli-siru", 5, gosa="siru"))
    assert ok.returncode == 0, ok.stderr.decode("utf-8", "replace")
    plain = cli(shrine("cli-plain", 6))
    assert plain.returncode == 0, plain.stderr.decode("utf-8", "replace")
    bad = cli(shrine("cli-bad", 7, gosa="pig"))
    assert bad.returncode == 1 and "고사상" in bad.stderr.decode("utf-8", "replace")
    async with ctx.db.session() as s:
        rows = dict((await s.execute(text("SELECT slug, gosa FROM shrines ORDER BY slug"))).all())
    assert rows == {"cli-plain": "cake", "cli-siru": "siru"}
