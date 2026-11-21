"""P3 부품 시험: JS Number() · ?ch= 읽기(Node와 비교), 초 · 연결 제한, 차단 · 강퇴 · 신고(moderation), 게시판 글쓰기 · 신고,
lock_timeout, 실시간 운영자 쪽 함수. PostgreSQL · Redis가 없으면 DB 시험은 건너뜁니다 (Redis DB 13, 시험이 비움).
"""

from __future__ import annotations

import asyncio
import json
import math

import pytest
from sqlalchemy import text

from _p2b_util import fresh_ctx
from shrine import moderation
from shrine.logic.crypto import block_key
from shrine.logic.jsnum import json_parse, number_to_string
from shrine.realtime import board
from shrine.realtime.core import CandleGuard, WindowLimiter, wanted_channel
from shrine.realtime.jsvalue import JSTypeError, to_number
from test_p3_npc import node_ref

# ── JS 값 ──

NUMBER_CASES = [
    "1", "-0", "1.5", "1e309", "null", "true", "false", '"1"', '" 12 "', '"0x1F"', '"0X1f"', '"-0x1"', '"0b101"', '"0o17"',
    '"0b2"', '"1e999"', '"-Infinity"', '"Infinity"', '"+Infinity"', '"infinity"', '""', '"   "', '"1_000"', '"1."', '".5"',
    '"."', '"+.5e2"', '"1e"', '"0x"', '"-0"', '"12abc"', '"\\ufeff5"', '"\\u00a012\\u2028"', '"\\u0663"', '"١"', "[]", "[5]",
    '["7"]', "[1,2]", "[[3]]", "[null]", "[true]", '[" 4 "]', "{}", '{"toString":1}', '{"valueOf":1}', '{"a":1}',
    '[{"toString":1}]', "[{}]", '{"__proto__":{"toString":1}}', '"0x' + "f" * 300 + '"', '"1' + "0" * 400 + '"',
]  # fmt: skip


def _py_number(c: str) -> dict:
    try:
        n = to_number(json_parse(c))
    except JSTypeError:
        return {"err": "TypeError"}
    if n == 0 and math.copysign(1, n) < 0:
        return {"n": "-0"}
    return {"n": number_to_string(n)}


def test_to_number_same_as_node():
    got = json.loads(node_ref({"op": "numbers", "cases": NUMBER_CASES}))
    assert [_py_number(c) for c in NUMBER_CASES] == got


CHANNEL_CASES = [
    "?ch=1", "?ch=2", "?ch=3", "?ch=4", "?ch=0", "?ch=-1", "?ch=2.0", "?ch=0x2", "?ch=%32", "?ch=+2", "?ch=%2B2", "?ch=1e0",
    "?ch=", "", "?", "?x=1&ch=3", "?ch=2&ch=3", "?CH=2", "?ch=2#x", "?ch=%", "?ch=1.5", "?ch=Infinity", "?c%68=2", "?ch=3&",
    "?&ch=1", "?ch=%E3%80%803", "?ch=0b11", "?ch=[2]",
]  # fmt: skip


def test_wanted_channel_same_as_node():
    got = json.loads(node_ref({"op": "channel", "cases": CHANNEL_CASES}))
    mine = [wanted_channel({"query_string": c[1:].encode("latin-1")}) for c in CHANNEL_CASES]
    assert mine == got


# ── 제한 ──


def test_candle_guard():
    g = CandleGuard(30 * 60_000)
    t = 10 * 3_600_000
    assert g.check(["s:a"], "x", t) == ("ok", 1_800_000)
    assert g.check(["s:a"], "x", t + 1000) == ("already", 1_799_000)
    assert g.check(["s:b"], "x", t + 1000)[0] == "ok"
    assert g.check(["s:a"], "y", t + 1000)[0] == "ok"
    assert g.check(["s:a"], "x", t + 1_800_000)[0] == "ok"
    busy = CandleGuard(1)
    verdicts = [busy.check([f"s:{i}"], "z", t + i)[0] for i in range(61)]
    assert verdicts[:60] == ["ok"] * 60 and verdicts[60] == "busy"
    assert busy.check(["s:new"], "z", t + 3_600_000)[0] == "ok"


def test_window_limiter():
    w = WindowLimiter(3, 60_000)
    assert [w.allow("k") for _ in range(4)] == [True, True, True, False]
    assert w.allow("other")


# ── 차단 · 강퇴 (DB) ──


async def test_blocks_db(tmp_path):
    async with fresh_ctx(tmp_path, redis_db=13) as ctx:
        seen = []
        moderation.on_blocks_changed(ctx, lambda: seen.append(1))
        await moderation.start(ctx)
        sec = ctx.config.ticket_secret
        with pytest.raises(moderation.ModerationError, match="IP 주소 형식이 아닙니다"):
            await moderation.add_block(ctx, {"kind": "block", "ipKey": "not-an-ip", "ms": 60_000})
        with pytest.raises(moderation.ModerationError, match="막을 대상"):
            await moderation.add_block(ctx, {"kind": "block", "ms": 60_000})
        with pytest.raises(moderation.ModerationError, match="1분부터 90일"):
            await moderation.add_block(ctx, {"kind": "block", "ipKey": "10.0.0.1", "ms": 59_999})
        with pytest.raises(moderation.ModerationError, match="1분부터 3시간"):
            await moderation.add_block(ctx, {"kind": "kick", "sid": "sid-12345678", "ms": 3 * 3600_000 + 1})
        b = await moderation.add_block(ctx, {"kind": "block", "ipKey": "2001:db8:1:2::5", "ms": 30 * 60_000, "reason": " 도배\n로그 "})
        assert list(b) == ["id", "at", "until", "kind", "byIp", "bySid", "tag", "nick", "reason"]
        assert b["byIp"] and not b["bySid"] and b["reason"] == "도배 로그" and b["tag"].startswith("ip ") and b["until"] - b["at"] == 1_800_000
        k = await moderation.add_block(ctx, kind="kick", sid="sid-12345678", ip_key="10.9.9.9", ms=120_000.4, nick="닉" * 50)
        assert k["kind"] == "kick" and not k["byIp"] and k["tag"] == "표 sid-1234" and k["nick"] == "닉" * 40
        assert seen and len(seen) >= 2
        assert await moderation.is_blocked(ctx, "2001:db8:1:2:ffff::9")
        assert not await moderation.is_blocked(ctx, "2001:db8:1:3::1")
        assert await moderation.is_blocked(ctx, block_key("2001:db8:1:2::1", sec))
        assert not await moderation.is_blocked(ctx, "10.9.9.9")  # 강퇴는 IP를 막지 않음
        assert await moderation.is_blocked(ctx, "10.9.9.9", "sid-12345678")
        assert moderation.is_blocked_now(ctx, "x", "sid-12345678")
        await moderation.add_block(ctx, {"ipKey": "::ffff:203.0.113.77", "ms": 60_000})
        assert await moderation.is_blocked(ctx, "203.0.113.77")
        assert await moderation.block_counts(ctx) == {"blocks": 2, "kicks": 1}
        rows = await moderation.list_blocks(ctx)
        assert [r["kind"] for r in rows] == ["block", "kick", "block"]
        assert "203.0.113" not in json.dumps(rows) and "k:" not in json.dumps(rows)
        assert await moderation.remove_block(ctx, rows[0]["id"]) is not None
        assert await moderation.remove_block(ctx, 999_999) is None
        assert not await moderation.is_blocked(ctx, "203.0.113.77")
        # 다른 프로세스(운영 명령)가 바로 넣은 행: 10초 갱신 전에는 모르고, 다시 읽으면 앎
        async with ctx.db.engine.begin() as conn:
            await conn.execute(
                text("INSERT INTO blocks (at, until, kind, ip_key, sid, nick, reason) VALUES (1, :u, 'block', :k, '', '', '')"),
                {"u": 2**50, "k": block_key("198.51.100.77", sec)},
            )
        assert not moderation.is_blocked_now(ctx, "198.51.100.77")
        before = len(seen)
        assert await moderation.refresh_blocks(ctx, force=True)
        assert moderation.is_blocked_now(ctx, "198.51.100.77") and len(seen) == before + 1
        assert not await moderation.refresh_blocks(ctx, force=False)  # 10초 안: 다시 읽지 않음
        # 그날 해시 → 차단 키 (예비 경로)
        moderation.remember_visitor(ctx, "dailyhash123", block_key("198.51.100.77", sec))
        assert moderation.is_blocked_now(ctx, "dailyhash123")
        await moderation.stop(ctx)


async def test_blocks_from_other_process_via_redis(tmp_path):
    """운영 명령(같은 DB · Redis를 쓰는 다른 ctx)이 차단하면 서버 ctx가 Redis 알림으로 곧바로 다시 읽음."""
    from shrine import redis as shrine_redis
    from shrine.context import AppContext
    from shrine.db.engine import Database

    async with fresh_ctx(tmp_path, redis_db=13) as server:
        changed = asyncio.Event()
        moderation.on_blocks_changed(server, changed.set)
        await moderation.start(server)
        await asyncio.sleep(0.3)  # 구독이 붙을 때까지
        changed.clear()
        cli = AppContext(config=server.config)
        cli.db = Database(server.config.database_url, pool_size=1, max_overflow=0)
        cli.redis = shrine_redis.connect(server.config.redis_url)
        try:
            await moderation.add_block(cli, {"ipKey": "198.51.100.30", "ms": 30 * 60_000, "reason": "운영 도구"})
            await asyncio.wait_for(changed.wait(), 5)
            assert moderation.is_blocked_now(server, "198.51.100.30")
            changed.clear()
            rows = await moderation.list_blocks(cli)
            await moderation.remove_block(cli, rows[0]["id"])
            await asyncio.wait_for(changed.wait(), 5)
            assert not moderation.is_blocked_now(server, "198.51.100.30")
        finally:
            await cli.redis.aclose()
            await cli.db.dispose()
            await moderation.stop(server)


async def test_block_without_db_is_memory_only():
    from shrine.config import load_config
    from shrine.context import AppContext

    ctx = AppContext(config=load_config({"DATABASE_URL": "postgresql://u:p@127.0.0.1:5432/db", "TICKET_SECRET": "t" * 40}).config)
    b = await moderation.add_block(ctx, {"ipKey": "10.1.1.1", "ms": 60_000})
    assert b["id"] == 0 and moderation.is_blocked_now(ctx, "10.1.1.1")
    assert not await moderation.is_blocked(ctx, "10.1.1.2")


# ── 사람 신고 (메모리) ──


def test_user_reports(monkeypatch):
    from shrine.config import load_config
    from shrine.context import AppContext

    ctx = AppContext(config=load_config({"DATABASE_URL": "postgresql://u:p@127.0.0.1:5432/db", "TICKET_SECRET": "t" * 40}).config)
    sent = []
    monkeypatch.setattr(moderation.notify_mod, "notify", lambda ev, f: sent.append((ev, dict(f))))
    clock = [1_000_000]
    monkeypatch.setattr(moderation, "now_ms", lambda: clock[0])
    target = {"pid": "p1", "sid": "sid-aaaaaaaa", "ipKey": "k:x", "nick": "새벽의 고양이 12", "channel": 2, "exp": 9}
    lines = [{"at": 5, "s": "둘"}, {"at": 3, "s": "하나"}]
    r1 = moderation.add_user_report(ctx, target, "rep-a", "abuse", lines)
    assert r1 == {"id": 1, "count": 1, "again": False}
    assert sent == [("접속자 신고", {"대상": "새벽의 고양이 12", "채널": "2번", "사유": "욕설 · 괴롭힘", "신고한_사람": "1명", "신고_번호": "#1"})]
    assert moderation.add_user_report(ctx, target, "rep-a", "spam", lines)["again"] is True
    moderation.add_user_report(ctx, target, "rep-b", "spam", [{"at": i, "s": f"{i}"} for i in range(10, 20)])
    moderation.add_user_report(ctx, target, "rep-c", "spam", [])
    assert [e for e, _ in sent] == ["접속자 신고", "접속자 신고 누적"]
    clock[0] += 10
    moderation.add_user_report(ctx, {**target, "sid": "sid-bbbbbbbb", "pid": "p2"}, "rep-a", "other", [])
    rep = moderation.list_user_reports(ctx, lambda sid: sid == "sid-aaaaaaaa")
    assert [r["id"] for r in rep] == [2, 1]
    one = rep[1]
    assert list(one) == ["id", "at", "last", "state", "nick", "channel", "pid", "online", "count", "reasons", "lines"]
    assert one["count"] == 3 and one["online"] is True and len(one["lines"]) == 8 and one["lines"][0]["s"] == "12"
    assert one["reasons"] == [{"key": "abuse", "label": "욕설 · 괴롭힘", "n": 1}, {"key": "spam", "label": "도배 · 광고", "n": 2}]
    assert moderation.open_report_count(ctx) == 2 and moderation.open_reports_for(ctx, "sid-aaaaaaaa") == 3
    # realtime.is_online(ctx, sid) 모양의 함수도 받음
    from shrine.realtime import is_online

    assert moderation.list_user_reports(ctx, is_online)[0]["online"] is False
    assert moderation.find_user_report(ctx, 1)["target"]["pid"] == "p1"
    assert moderation.close_user_report(ctx, 1, "kicked") and not moderation.close_user_report(ctx, 99, "kicked")
    moderation.close_reports_for(ctx, "sid-bbbbbbbb", "blocked")
    assert moderation.open_report_count(ctx) == 0
    assert [r["state"] for r in moderation.list_user_reports(ctx, lambda s: False)] == ["blocked", "kicked"]
    clock[0] += 24 * 3600_000 + 11
    assert moderation.list_user_reports(ctx, lambda s: False) == []
    assert moderation.is_report_reason("lewd") and not moderation.is_report_reason("toString")


# ── 게시판 (DB) ──


async def test_board_post_and_report(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(board.notify_mod, "notify", lambda ev, f: sent.append((ev, dict(f))))
    async with fresh_ctx(tmp_path, redis_db=13) as ctx:
        post = await board.add_post(ctx, "claude", "좋아요", "새벽의 러버덕 11")
        assert list(post) == ["id", "at", "topic", "text", "nick"] and post["topic"] == "claude"
        assert await board.report_post(ctx, post["id"], "ipA") == "ok"
        assert await board.report_post(ctx, post["id"], "ipA") == "ok"
        assert await board.report_post(ctx, post["id"], "ipB") == "ok"
        assert await board.report_post(ctx, float(post["id"]), "ipC") == "hidden"
        assert await board.report_post(ctx, post["id"], "ipD") == "ok"
        assert await board.report_post(ctx, 999, "ipA") == "none"
        assert await board.report_post(ctx, 1e300, "ipA") == "none"
        assert [e for e, _ in sent] == ["게시판 글 신고", "게시판 글을 신고로 숨김"]
        async with ctx.db.engine.connect() as conn:
            keys = [r[0] for r in await conn.execute(text("SELECT reporter FROM post_reports ORDER BY reporter"))]
        assert len(keys) == 4 and all(len(k) == 22 for k in keys) and "ipA" not in keys
        assert board.reporter_key(1, "abc") == board.reporter_key(1.0, "abc")
        assert board.is_post_topic("etc") and not board.is_post_topic("ETC")


async def test_lock_timeout(tmp_path):
    from shrine.db.engine import Database
    from shrine.realtime.lifecycle import set_lock_timeout

    async with fresh_ctx(tmp_path, redis_db=13) as ctx:
        db = Database(ctx.config.database_url, pool_size=1, max_overflow=0)
        set_lock_timeout(db)
        try:
            async with db.engine.connect() as conn:
                assert (await conn.execute(text("SHOW lock_timeout"))).scalar_one() == "3s"
        finally:
            await db.dispose()


# ── 실시간 운영자 쪽 ──


def test_realtime_admin_functions_without_players():
    from shrine import realtime
    from shrine.config import load_config
    from shrine.context import AppContext

    ctx = AppContext(config=load_config({"DATABASE_URL": "postgresql://u:p@127.0.0.1:5432/db", "TICKET_SECRET": "t" * 40}).config)
    assert realtime.free_chat(ctx) is True
    realtime.set_free_chat(ctx, False)
    assert realtime.free_chat(ctx) is False and ctx.config.free_chat is True
    assert realtime.channel_stats(ctx) == {"connections": 0, "channels": [{"id": i, "n": 0, "npc": 0} for i in (1, 2, 3)]}
    assert realtime.realtime_stats(ctx) == {"connections": 0, "channels": 3, "npcs": []}
    assert realtime.players_for_admin(ctx) == [{"id": i, "npc": 0, "players": []} for i in (1, 2, 3)]
    assert not realtime.is_online(ctx, "sid")
    assert asyncio.run(realtime.kick_player(ctx, "nobody", "x")) is None
    assert asyncio.run(realtime.block_player(ctx, "nobody", 60_000, True, "x")) is None
