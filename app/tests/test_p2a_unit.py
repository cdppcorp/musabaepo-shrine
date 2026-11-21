"""P2a 부품 시험: shrines.py (캐시 · 자리 · 넣기 · 초 · 클릭), posts.py, moderation.is_blocked, turnstile.verify_human,
입장 표 쿠키 모양. PostgreSQL이 없으면 DB 시험은 건너뜁니다 (SHRINE_TEST_PG, 기본 개발용 컨테이너 127.0.0.1:55432).
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from shrine import moderation, posts, shrines
from shrine.config import load_config
from shrine.context import AppContext
from shrine.db.engine import Database
from shrine.logic.crypto import block_key
from shrine.logic.util import kst_date, kst_week_days, now_ms
from shrine.turnstile import SITEVERIFY_URL, verify_human
from shrine.web.public import ticket_cookie

PG_ADMIN = os.environ.get("SHRINE_TEST_PG", "postgresql://postgres:dev@127.0.0.1:55432/postgres")
DB = "postgresql://u:p@127.0.0.1:5432/db"
SECRET = "unit-test-ticket-secret-0123456789abcdef"


def cfg(**env):
    return load_config({"DATABASE_URL": DB, "TICKET_SECRET": SECRET, **env}).config


@pytest.fixture
async def db():
    import asyncpg

    try:
        admin = await asyncpg.connect(PG_ADMIN, timeout=3)
    except Exception:
        pytest.skip("PostgreSQL이 없어 DB 시험을 하지 않습니다")
    name = f"shrine_p2a_unit_{secrets.token_hex(4)}"
    await admin.execute(f"CREATE DATABASE {name}")
    url = make_url(PG_ADMIN).set(drivername="postgresql+asyncpg", database=name).render_as_string(hide_password=False)
    database = Database(url)
    try:
        await database.migrate()
        yield database
    finally:
        await database.dispose()
        await admin.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")
        await admin.close()


def shrine(slug: str, channel: int = 1, plot: int = 0, **over) -> dict:
    s = {
        "slug": slug, "name": slug, "tagline": "시험 사당", "category": "devtools", "domain": f"{slug}.example.kr",
        "url": f"https://{slug}.example.kr", "operator": "OPS", "keeper": False, "paid": False, "verifiedDomain": "2026-11-01",
        "verifiedBusiness": None, "joinedAt": "2026-11-01", "status": "live", "prayer": "deploy", "charm": None, "deco": [],
        "screens": [f"{slug}.png"], "capturedAt": "2026-11-01", "channel": channel, "plot": plot, "sign": "", "repo": "",
        "email": "", "emailPublic": False, "projectId": 0,
    }  # fmt: skip
    s.update(over)
    return s


async def test_cache_insert_and_plots(db: Database):
    assert await shrines.all_shrines(db) == []
    await shrines.insert_shrine(db, shrine("b", 2, 4))
    await shrines.insert_shrine(db, shrine("a", 1, 3.0, deco=["duck"], keeper=1))
    got = await shrines.all_shrines(db)
    assert [s["slug"] for s in got] == ["a", "b"]  # channel, plot 순
    assert got[0]["deco"] == ["duck"] and got[0]["keeper"] is True and got[0]["plot"] == 3
    async with db.engine.connect() as conn:
        row = (await conn.execute(text("SELECT deco, screens, keeper, sign FROM shrines WHERE slug = 'a'"))).one()
    assert tuple(row) == ('["duck"]', '["a.png"]', 1, "")
    with pytest.raises(shrines.ShrineRuleError, match="입점 규칙에 맞지 않습니다: 카테고리"):
        await shrines.insert_shrine(db, shrine("c", category="x"))
    with pytest.raises(IntegrityError):
        await shrines.insert_shrine(db, shrine("d", 1, 3))  # 같은 채널 · 자리
    # 운영 도구처럼 캐시를 거치지 않고 넣은 사당: 30초 캐시 안에서는 안 보이고, 비우면 보임
    async with db.begin() as s:
        await s.execute(shrines.INSERT_SHRINE, shrines.shrine_params(shrine("e", 3, 0)))
        await s.execute(shrines.INSERT_SHRINE, shrines.shrine_params(shrine("hidden", 1, 5, category="nope")))
    assert [s["slug"] for s in await shrines.all_shrines(db)] == ["a", "b"]
    shrines.clear_shrine_cache(db)
    assert [s["slug"] for s in await shrines.all_shrines(db)] == ["a", "b", "e"]  # 규칙에 어긋난 사당은 숨김
    assert (await shrines.find_shrine(db, "e"))["channel"] == 3 and await shrines.find_shrine(db, "hidden") is None
    assert [s["slug"] for s in await shrines.shrines_in(db, 1)] == ["a"]
    # 자리는 숨긴 사당도 찬 것으로
    assert await shrines.taken_plots(db, 1) == {3, 5}
    assert await shrines.plot_taken(db, 1, 5) and not await shrines.plot_taken(db, 2, 5)
    free = await shrines.free_plots_by_channel(db)
    assert list(free) == [1, 2, 3] and 3 not in free[1] and 5 not in free[1] and free[2][:4] == [0, 1, 2, 3] and 4 not in free[2]
    assert json.loads(json.dumps({str(k): v for k, v in free.items()}))["3"][0] == 1


async def test_session_insert_invalidates_after_commit(db: Database):
    await shrines.all_shrines(db)  # 빈 목록이 캐시에 들어감
    async with db.begin() as s:
        await shrines.insert_shrine(s, shrine("tx", 1, 0))
        assert await shrines.plot_taken(s, 1, 0)  # 같은 트랜잭션 안에서는 보임
        # 커밋 전에 다른 요청이 캐시를 다시 채움 (아직 커밋 안 된 사당은 없음)
        assert await shrines.all_shrines(db) == []
    # 커밋 뒤에는 캐시를 다시 비워 바로 보임
    assert [s["slug"] for s in await shrines.all_shrines(db)] == ["tx"]


async def test_fill_started_before_clear_is_not_cached(db: Database):
    st = shrines._state(db)
    started = asyncio.Event()
    release = asyncio.Event()
    real_rows = shrines._rows

    async def slow_rows(target, sql, params=None):
        out = await real_rows(target, sql, params)
        started.set()
        await release.wait()
        return out

    shrines._rows = slow_rows
    try:
        task = asyncio.create_task(shrines.all_shrines(db))
        await started.wait()
        shrines.clear_shrine_cache(db)  # 읽는 중에 바뀜
        release.set()
        assert await task == []
    finally:
        shrines._rows = real_rows
    assert st.shrines is None  # 옛 결과를 30초 동안 붙잡지 않음


async def test_candles_and_clicks(db: Database):
    week = kst_week_days()
    async with db.begin() as s:
        for day, slug, prayer, n in [(week[0], "b", "deploy", 2), (week[-1], "a", "bug", 1), ("2000-01-01", "a", "bug", 50)]:
            await s.execute(text("INSERT INTO candles VALUES (:d, :s, :p, :n)"), {"d": day, "s": slug, "p": prayer, "n": n})
    v = await shrines.candle_summary(db)
    expect_today = 2 + (1 if week[-1] == week[0] else 0)
    assert v == {"week": {"a": 1, "b": 2}, "weekTotal": 3, "today": expect_today}
    assert list(v["week"]) == ["a", "b"]
    async with db.begin() as s:
        await s.execute(text("UPDATE candles SET n = 99"))
    assert await shrines.candle_summary(db) == v  # 15초 캐시
    await shrines.add_candle(db, "a", "deploy")  # 켜면 캐시를 비움
    v2 = await shrines.candle_summary(db)
    assert v2["week"]["a"] >= 99 and v2["today"] >= 100
    with pytest.raises(ValueError):
        await shrines.add_candle(db, "a", "nope")
    await shrines.add_click(db, "a")
    await shrines.add_click(db, "a")
    async with db.begin() as s:
        await shrines.add_click(s, "b")
    async with db.engine.connect() as conn:
        rows = (await conn.execute(text("SELECT day, slug, n FROM clicks ORDER BY slug"))).all()
    assert [tuple(r) for r in rows] == [(kst_date(), "a", 2), (kst_date(), "b", 1)]


async def test_posts_list_and_prune(db: Database):
    now = now_ms()
    async with db.begin() as s:
        for i, (at, hidden) in enumerate([(now - 1000, 0), (now - 1000, 0), (now - 5000, 1), (now - 8 * 86_400_000, 0)], 1):
            await s.execute(
                text("INSERT INTO posts (id, at, topic, text, nick, hidden) VALUES (:i, :at, 'gpt', :t, 'n', :h)"),
                {"i": i, "at": at, "t": f"글 {i}", "h": hidden},
            )
        await s.execute(text("INSERT INTO post_reports VALUES (4, 'r'), (99, 'r'), (1, 'r')"))
    got = await posts.list_posts(db)
    assert [p["id"] for p in got] == [2, 1] and list(got[0]) == ["id", "at", "topic", "text", "nick"]
    assert [p["id"] for p in await posts.list_posts(db, 1)] == [2]
    assert await posts.prune_posts(db) == {"posts": 1, "reports": 2}
    async with db.engine.connect() as conn:
        assert (await conn.execute(text("SELECT COUNT(*) FROM posts"))).scalar_one() == 3


async def test_is_blocked_reads_blocks_table(db: Database):
    ctx = AppContext(config=cfg())
    ctx.db = db
    now = now_ms()
    key = block_key("10.0.0.7", SECRET)
    async with db.begin() as s:
        await s.execute(
            text("INSERT INTO blocks (at, until, kind, ip_key, sid) VALUES (:at, :u, 'block', :k, ''), (:at, :u, 'kick', '', 'sid-1'), "
                 "(:at, :old, 'block', :k2, '')"),
            {"at": now, "u": now + 60_000, "old": now - 1, "k": key, "k2": block_key("10.0.0.8", SECRET)},
        )  # fmt: skip
    assert await moderation.is_blocked(ctx, "10.0.0.7")
    assert await moderation.is_blocked(ctx, "::ffff:10.0.0.7")  # 같은 IPv4
    assert await moderation.is_blocked(ctx, key)  # 차단 키 그대로
    assert await moderation.is_blocked(ctx, "10.0.0.9", "sid-1")
    assert not await moderation.is_blocked(ctx, "10.0.0.8")  # 만료
    assert not await moderation.is_blocked(ctx, "10.0.0.9", "sid-2")
    assert not await moderation.is_blocked(ctx, "unknown")
    broken = AppContext(config=cfg())  # DB가 없어도 예외 없이 '막히지 않음'
    broken.db = None
    assert not await moderation.is_blocked(broken, "10.0.0.7")


def test_ticket_cookie_attributes():
    assert ticket_cookie("v", "", False) == "shrine_ticket=v; Path=/; Max-Age=10800; HttpOnly; SameSite=Strict"
    assert ticket_cookie("v", "/shrine", True) == "shrine_ticket=v; Path=/shrine/; Max-Age=10800; HttpOnly; SameSite=Strict; Secure"


async def test_verify_human():
    seen = []

    def handler(answer):
        def h(request: httpx.Request) -> httpx.Response:
            seen.append((str(request.url), request.content.decode()))
            return answer() if callable(answer) else answer

        return httpx.MockTransport(h)

    prod = cfg(TURNSTILE_SECRET="0xsecret")
    assert prod.dev_skip_human_check is False
    token = "t" * 10
    ok = handler(httpx.Response(200, json={"success": True}))
    assert await verify_human(prod, token, "1.2.3.4", transport=ok)
    assert seen[-1] == (SITEVERIFY_URL, "secret=0xsecret&response=tttttttttt&remoteip=1.2.3.4")
    for answer in (
        httpx.Response(200, json={"success": False}), httpx.Response(200, json={"success": "true"}), httpx.Response(200, json=[True]),
        httpx.Response(200, text="not json"), httpx.Response(500, json={"success": 1}), httpx.Response(200, json=None),
    ):  # fmt: skip
        assert not await verify_human(prod, token, "1.2.3.4", transport=handler(answer))

    def boom() -> httpx.Response:
        raise httpx.ConnectError("down")

    assert not await verify_human(prod, token, "1.2.3.4", transport=handler(boom))
    n = len(seen)
    for bad in (None, 123, "t" * 9, "t" * 2049, ["t" * 10]):
        assert not await verify_human(prod, bad, "1.2.3.4", transport=ok)
    assert len(seen) == n  # 토큰 모양이 틀리면 묻지도 않음
    assert await verify_human(prod, "😀" * 1024, "1.2.3.4", transport=ok)  # UTF-16 2048단위
    assert not await verify_human(prod, "😀" * 1025, "1.2.3.4", transport=ok)
    dev = cfg()
    assert dev.dev_skip_human_check and await verify_human(dev, None, "1.2.3.4", transport=handler(boom))
