"""PostgreSQL 스키마: 빈 DB에 마이그레이션 → Node(SQLite v4)와 같은 표 · 칸 · 제약, 두 번 돌려도 그대로, 모델과 차이 없음.

PostgreSQL이 없으면 건너뜁니다 (SHRINE_TEST_PG, 기본 개발용 컨테이너 127.0.0.1:55432).
"""

from __future__ import annotations

import os
import secrets

import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url

from shrine.db.engine import Database

PG_ADMIN = os.environ.get("SHRINE_TEST_PG", "postgresql://postgres:dev@127.0.0.1:55432/postgres")

# Node SQLite 스키마 v4 (db.ts + registry.ts pin_locks)의 칸 순서
EXPECTED_COLUMNS = {
    "shrines": [
        "slug", "name", "tagline", "category", "domain", "url", "operator", "keeper", "paid", "verified_domain",
        "verified_business", "joined_at", "status", "prayer", "charm", "deco", "screens", "captured_at", "channel", "plot",
        "repo", "email", "email_public", "project_id", "sign",
    ],
    "projects": [
        "id", "code", "at", "name", "tagline", "category", "github", "url", "email", "email_public", "pin_hash", "nick",
        "status", "note", "slug", "pending_github", "pending_url", "repo_ok", "stars", "sign", "screen", "pending_screen",
        "want_plot", "pending_name", "pending_tagline", "pending_sign", "consent_at", "review_at", "closed_at", "purged_at",
        "want_channel",
    ],
    "candles": ["day", "slug", "prayer", "n"],
    "ai_prayers": ["day", "ai", "n"],
    "posts": ["id", "at", "topic", "text", "nick", "hidden"],
    "post_reports": ["post_id", "reporter"],
    "clicks": ["day", "slug", "n"],
    "admin_log": ["id", "at", "action", "target", "ip_hash", "detail"],
    "blocks": ["id", "at", "until", "kind", "ip_key", "sid", "nick", "reason"],
    "pin_locks": ["project_id", "day", "fails", "until"],
}


@pytest.fixture
async def db():
    import asyncpg

    try:
        admin = await asyncpg.connect(PG_ADMIN, timeout=3)
    except Exception:
        pytest.skip("PostgreSQL이 없어 스키마를 시험하지 않습니다")
    name = f"shrine_dbtest_{secrets.token_hex(4)}"
    await admin.execute(f"CREATE DATABASE {name}")
    url = make_url(PG_ADMIN).set(drivername="postgresql+asyncpg", database=name).render_as_string(hide_password=False)
    database = Database(url)
    try:
        yield database
    finally:
        await database.dispose()
        await admin.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")
        await admin.close()


async def test_schema_matches_node(db: Database):
    await db.migrate()
    await db.migrate()  # 두 번째는 아무것도 하지 않음
    async with db.engine.connect() as conn:
        rows = (
            await conn.execute(
                text(
                    "SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns "
                    "WHERE table_schema = 'public' AND table_name <> 'alembic_version' ORDER BY table_name, ordinal_position"
                )
            )
        ).all()
        cols: dict[str, list] = {}
        for t, c, typ, nullable, default in rows:
            cols.setdefault(t, []).append((c, typ, nullable, default))
        assert {t: [c[0] for c in v] for t, v in cols.items()} == EXPECTED_COLUMNS
        info = {(t, c[0]): c for t, v in cols.items() for c in v}
        # ms 시각은 BIGINT
        for t, c in [("posts", "at"), ("projects", "at"), ("projects", "closed_at"), ("blocks", "until"), ("pin_locks", "until"), ("admin_log", "at")]:
            assert info[(t, c)][1] == "bigint", (t, c)
        assert info[("shrines", "channel")][2:] == ("NO", "1")
        assert info[("projects", "want_channel")][1:3] == ("integer", "YES")
        assert info[("shrines", "deco")][3] == "'[]'::text"
        constraints = {
            r[0]
            for r in (
                await conn.execute(text("SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace"))
            ).all()
        }
        assert {"uq_shrines_channel_plot", "uq_shrines_domain", "uq_projects_code", "ck_shrines_status",
                "ck_projects_status", "ck_blocks_kind"} <= constraints
        indexes = {r[0] for r in (await conn.execute(text("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'"))).all()}
        assert {"posts_at", "blocks_until"} <= indexes


async def test_channel_plot_uniqueness_and_identity(db: Database):
    await db.migrate()
    shrine = (
        "INSERT INTO shrines (slug, name, tagline, category, domain, url, operator, verified_domain, joined_at, status, "
        "prayer, captured_at, channel, plot) VALUES (:slug, 'n', 't', 'c', :domain, 'https://x', 'o', '', '2026-11-19', "
        "'live', 'p', '2026-11-19', :ch, :plot)"
    )
    async with db.begin() as s:
        await s.execute(text(shrine), {"slug": "a", "domain": "a.kr", "ch": 1, "plot": 0})
        await s.execute(text(shrine), {"slug": "b", "domain": "b.kr", "ch": 2, "plot": 0})  # 다른 채널 같은 자리: 됨
    with pytest.raises(Exception, match="uq_shrines_channel_plot"):
        async with db.begin() as s:
            await s.execute(text(shrine), {"slug": "c", "domain": "c.kr", "ch": 1, "plot": 0})
    async with db.begin() as s:
        ids = [
            (await s.execute(text("INSERT INTO posts (at, topic, text, nick) VALUES (:at, 't', 'x', 'n') RETURNING id"), {"at": 1_795_000_000_000})).scalar_one()
            for _ in range(2)
        ]
        assert ids[1] == ids[0] + 1
        row = (await s.execute(text("SELECT channel, email_public, sign FROM shrines WHERE slug = 'a'"))).one()
        assert tuple(row) == (1, 0, "")
