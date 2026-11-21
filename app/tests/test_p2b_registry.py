"""등록소 · 업로드 · 보관 기간 라이브러리 시험 (PostgreSQL + Redis): Node 흐름 그대로 + 동시에 들어올 때 한쪽만 이기는지.

Node는 DB 호출이 동기라 겹치는 일이 없었고, 여기서는 트랜잭션 · 행 잠금 · UNIQUE 제약 · advisory lock · Redis Lua ·
PIN 차례 세우기로 같은 결과를 냅니다. PostgreSQL · Redis가 없으면 건너뜁니다.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from sqlalchemy import text

from _p2b_util import fresh_ctx, jpeg, png
from shrine import registry as reg
from shrine import retention, uploads
from shrine.logic.util import DAY_MS, kst_date, now_ms


@pytest.fixture
async def ctx(tmp_path: Path):
    async with fresh_ctx(tmp_path) as c:
        yield c


BASE = {
    "name": "데모 프로젝트", "tagline": "등록소 시험용 프로젝트", "category": "devtools", "url": "https://p2b-demo.dev",
    "email": "Dev@Example.com", "emailPublic": True, "pin": "123456", "consent": True,
}  # fmt: skip

_n = 0


async def submit(ctx, sid: str | None = None, ip: str | None = None, **patch):
    global _n
    _n += 1
    body = {**BASE, **patch}
    return await reg.submit_project(ctx, body, sid or f"sid-{_n}", ip or f"ip-{_n}", "새벽의 러버덕 42")


async def add_shrine(ctx, slug: str, channel: int, plot: int) -> None:
    from shrine.shrines import insert_shrine

    today = kst_date()
    await insert_shrine(
        ctx,
        {
            "slug": slug, "name": slug, "tagline": "채우기", "category": "etc", "domain": f"{slug}.example.com",
            "url": f"https://{slug}.example.com", "operator": "op", "keeper": False, "paid": False, "verifiedDomain": today,
            "verifiedBusiness": None, "joinedAt": today, "status": "live", "prayer": "deploy", "charm": None, "deco": [],
            "screens": ["x.png"], "capturedAt": today, "channel": channel, "plot": plot, "repo": "", "email": "",
            "emailPublic": False, "projectId": 0, "sign": "",
        },
    )  # fmt: skip


async def row(ctx, pid: int) -> dict:
    return await reg.get_row(ctx, pid)


# ── 접수 · 관리 ─────────────────────────────────────────────────────


async def test_submit_status_find_manage(ctx):
    r = await submit(ctx, sid="A", ip="ipA")
    assert r["ok"] and len(r["code"]) == 16 and r["id"] == 1
    assert (await submit(ctx, sid="A", ip="ipA", url="https://other.dev")) == {"ok": False, "status": 429, "reason": "slow"}
    st = await reg.status_by_code(ctx, r["code"])
    assert st == {"status": "pending", "id": 1, "name": "데모 프로젝트", "linkReview": False}
    found = await reg.find_mine(ctx, {"email": "DEV@example.com", "pin": "123456"}, "ipA")
    assert found["ok"] and [p["id"] for p in found["projects"]] == [1]
    assert list(found["projects"][0]) == ["id", "name", "status", "note", "slug", "at", "linkReview"]
    g = await reg.manage_get(ctx, {"id": 1, "pin": "123456"}, "ipA", "A")
    assert g["ok"] and g["project"]["email"] == "dev@example.com" and g["project"]["wantChannel"] is None
    assert list(g["project"]) == [
        "id", "status", "name", "tagline", "sign", "category", "github", "url", "email", "emailPublic", "slug",
        "pendingGithub", "pendingUrl", "pendingName", "pendingTagline", "pendingSign", "note", "screen", "pendingScreen",
        "wantPlot", "wantChannel",
    ]  # fmt: skip
    # 숫자로 온 PIN은 4자리 0채움
    s = await submit(ctx, url="https://pin-num.dev", pin="0042")
    assert (await reg.manage_get(ctx, {"id": s["id"], "pin": 42}, "ipZ"))["ok"]
    # 글자 '1e0' 번호도 Number()로 1
    assert (await reg.manage_get(ctx, {"id": "1e0", "pin": "123456"}, "ipA"))["ok"]
    assert (await reg.manage_get(ctx, {"id": 10**30, "pin": "123456"}, "ipA"))["reason"] == "none"


async def test_pin_lock_sequence_and_concurrency(ctx):
    r = await submit(ctx)
    pid = r["id"]
    got = [await reg.manage_get(ctx, {"id": pid, "pin": "999999"}, "ipX") for _ in range(5)]
    assert [(g["status"], g["reason"]) for g in got] == [(403, "pin")] * 4 + [(403, "locked")]
    assert (await reg.manage_get(ctx, {"id": pid, "pin": "123456"}, "ipX"))["status"] == 429

    # 동시에 10번 틀려도 5번까지만 셉니다 (PIN 확인을 접수마다 차례로)
    r2 = await submit(ctx, url="https://p2b-conc.dev")
    pid2 = r2["id"]
    res = await asyncio.gather(*(reg.manage_get(ctx, {"id": pid2, "pin": "000000"}, f"ip{i}") for i in range(10)))
    kinds = sorted((x["status"], x["reason"]) for x in res)
    assert kinds == sorted([(403, "pin")] * 4 + [(403, "locked")] + [(429, "locked")] * 5)
    async with ctx.db.session() as s:
        fails = (await s.execute(text("SELECT fails FROM pin_locks WHERE project_id = :id"), {"id": pid2})).scalar_one()
    assert fails == 5


async def test_day_lock_persists_and_is_atomic(ctx):
    r = await submit(ctx)
    pid = r["id"]
    locks = await asyncio.gather(*(reg._add_day_fail(ctx, pid, now_ms()) for _ in range(25)))
    assert locks.count(True) == 1
    async with ctx.db.session() as s:
        fails, until = (await s.execute(text("SELECT fails, until FROM pin_locks WHERE project_id = :id"), {"id": pid})).one()
    assert fails == 5 and until > now_ms() + 23 * 3600_000
    assert (await reg.manage_get(ctx, {"id": pid, "pin": "123456"}, "ipQ"))["reason"] == "locked"
    # 하루 30번(IP) 잠금
    r3 = await submit(ctx, url="https://p2b-ipday.dev")
    await ctx.redis.set(reg._pin_ip_key(kst_date(), "ipD"), 30)
    assert (await reg.manage_get(ctx, {"id": r3["id"], "pin": "123456"}, "ipD")) == {"ok": False, "status": 429, "reason": "locked"}


async def test_find_mine_lock_and_dummy(ctx):
    await submit(ctx, email="find@example.com", pin="246810")
    for i in range(4):
        assert (await reg.find_mine(ctx, {"email": "nobody@example.com", "pin": "246810"}, "ipF"))["reason"] == "pin"
    assert (await reg.find_mine(ctx, {"email": "nobody@example.com", "pin": "246810"}, "ipF"))["reason"] == "locked"
    assert (await reg.find_mine(ctx, {"email": "nobody@example.com", "pin": "246810"}, "ipF"))["status"] == 429
    assert (await reg.find_mine(ctx, {"email": "find@example.com", "pin": 246810}, "ipF"))["reason"] == "pin"  # 숫자 PIN은 안 받음
    assert (await reg.find_mine(ctx, {"email": "find@example.com", "pin": "246810"}, "ipF"))["ok"]
    keys = [k.decode() for k in await ctx.redis.keys("shrine:reg:mailfail:*")]
    assert keys and all("@" not in k and "nobody" not in k for k in keys)


async def test_submit_concurrency_one_wins(ctx):
    # 같은 링크를 동시에: 하나만 들어가고 나머지는 dup
    res = await asyncio.gather(*(submit(ctx, url="https://same-link.dev") for _ in range(4)))
    assert sorted(x.get("reason", "ok") for x in res) == ["dup", "dup", "dup", "ok"]
    # 같은 사람(입장 표)이 동시에: 하나만 (2분에 하나)
    res = await asyncio.gather(*(submit(ctx, sid="same-sid", url=f"https://sid-{i}.dev") for i in range(3)))
    assert sorted(x.get("reason", "ok") for x in res) == ["ok", "slow", "slow"]
    # 같은 IP 하루 3개: 동시에 5개를 보내도 3개만
    res = await asyncio.gather(*(submit(ctx, ip="same-ip", url=f"https://ip-{i}.dev") for i in range(5)))
    assert sorted(x.get("reason", "ok") for x in res) == ["many", "many", "ok", "ok", "ok"]
    async with ctx.db.session() as s:
        n = (await s.execute(text("SELECT COUNT(*) FROM projects"))).scalar_one()
    assert n == 1 + 1 + 3
    # 검사에서 떨어진 접수는 2분 기록을 남기지 않음 (Node와 같음)
    assert (await submit(ctx, sid="fresh", name=""))["reason"] == "name"
    assert (await submit(ctx, sid="fresh", url="https://fresh.dev"))["ok"]


async def test_want_channel_plot(ctx):
    await add_shrine(ctx, "filled", 2, 19)
    assert (await submit(ctx, channel=2, plot=19))["reason"] == "plot"
    assert (await submit(ctx, channel=5))["reason"] == "channel"
    assert (await submit(ctx, channel=True))["reason"] == "channel"
    assert (await submit(ctx, plot=20))["reason"] == "plot"
    assert (await submit(ctx, plot="0x3", url="https://hex-plot.dev"))["ok"]  # Number('0x3') = 3
    r = await submit(ctx, channel="3", plot=19, url="https://ch3.dev")
    assert r["ok"]
    p = await row(ctx, r["id"])
    assert (p["want_channel"], p["want_plot"]) == (3, 19)
    r = await submit(ctx, plot=4, url="https://plot-only.dev")
    p = await row(ctx, r["id"])
    assert (p["want_channel"], p["want_plot"]) == (1, 4)


# ── 승인 자리 정하기 ─────────────────────────────────────────────────


async def test_placement_order(ctx):
    await add_shrine(ctx, "c2-5", 2, 5)
    a = await submit(ctx, channel=2, plot=7, url="https://wish-free.dev")
    assert "(채널 2 · 자리 7)" in await reg.approve_project(ctx, a["id"])
    b = await submit(ctx, channel=2, plot=8, url="https://wish-taken.dev")
    await add_shrine(ctx, "c2-8", 2, 8)
    assert "(채널 2 · 자리 0)" in await reg.approve_project(ctx, b["id"])  # 원한 자리가 찼으면 그 채널의 첫 빈 자리
    c = await submit(ctx, url="https://any.dev")
    assert "(채널 1 · 자리 0)" in await reg.approve_project(ctx, c["id"])  # 아무 채널 → 1번부터
    # 운영자가 채널을 정하면: 작성자가 고른 채널이 아니면 원한 자리는 안 봄, 그 채널 안에서만
    d = await submit(ctx, channel=2, plot=9, url="https://op-channel.dev")
    assert "(채널 3 · 자리 0)" in await reg.approve_project(ctx, d["id"], channel=3)
    for plot in range(1, 20):
        await add_shrine(ctx, f"c3-{plot}", 3, plot)
    e = await submit(ctx, url="https://full-ch3.dev")
    with pytest.raises(reg.RegistryError, match="채널 3에는 빈 사당 자리가 없습니다"):
        await reg.approve_project(ctx, e["id"], channel=3)
    # 작성자가 고른 채널 3이 꽉 찼고 운영자가 안 정함 → 1번 채널부터
    f = await submit(ctx, channel=3, url="https://wish-full.dev")
    assert "(채널 1 · 자리 1)" in await reg.approve_project(ctx, f["id"])
    with pytest.raises(reg.RegistryError, match=r"없는 채널입니다: 4 \(1~3\)"):
        await reg.approve_project(ctx, e["id"], channel=4)
    with pytest.raises(reg.RegistryError, match=r"없는 자리 번호입니다: 20 \(0~19\)"):
        await reg.approve_project(ctx, e["id"], plot=20)
    with pytest.raises(reg.RegistryError, match="이미 사당이 있는 자리입니다: 채널 1 · 0번"):
        await reg.approve_project(ctx, e["id"], plot=0)
    with pytest.raises(reg.RegistryError, match="검토 대기 상태가 아닙니다 \\(approved\\): 1"):
        await reg.approve_project(ctx, a["id"])
    with pytest.raises(reg.RegistryError, match="없는 접수입니다: 999"):
        await reg.approve_project(ctx, 999)


async def test_concurrent_approvals(ctx):
    # 운영자가 같은 자리를 동시에 정함 → 하나만, 나머지는 '이미 사당이 있는 자리'
    a = await submit(ctx, url="https://race-a.dev")
    b = await submit(ctx, url="https://race-b.dev")
    res = await asyncio.gather(
        reg.approve_project(ctx, a["id"], plot=3, channel=1), reg.approve_project(ctx, b["id"], plot=3, channel=1),
        return_exceptions=True,
    )
    oks = [x for x in res if isinstance(x, str)]
    errs = [x for x in res if isinstance(x, reg.RegistryError)]
    assert len(oks) == 1 and len(errs) == 1 and "이미 사당이 있는 자리입니다: 채널 1 · 3번" in str(errs[0])
    # 같은 자리를 원한 두 접수를 동시에 자동 승인 → 둘 다 서고 하나는 그 채널의 첫 빈 자리로
    c = await submit(ctx, channel=2, plot=5, url="https://wish-c.dev")
    d = await submit(ctx, channel=2, plot=5, url="https://wish-d.dev")
    res = await asyncio.gather(reg.approve_project(ctx, c["id"]), reg.approve_project(ctx, d["id"]))
    spots = sorted(m.rsplit("(", 1)[1] for m in res)
    assert spots == ["채널 2 · 자리 0)", "채널 2 · 자리 5)"]
    # 같은 이름(slug)도 겹치지 않음
    async with ctx.db.session() as s:
        slugs = [x for (x,) in await s.execute(text("SELECT slug FROM shrines ORDER BY slug"))]
    assert len(slugs) == len(set(slugs)) == 3
    # 같은 접수를 동시에 승인 → 사당 하나, 나머지는 '검토 대기 상태가 아닙니다'
    e = await submit(ctx, url="https://twice.dev")
    res = await asyncio.gather(*(reg.approve_project(ctx, e["id"]) for _ in range(3)), return_exceptions=True)
    assert sum(isinstance(x, str) for x in res) == 1
    async with ctx.db.session() as s:
        n = (await s.execute(text("SELECT COUNT(*) FROM shrines WHERE project_id = :id"), {"id": e["id"]})).scalar_one()
    assert n == 1


async def test_change_review_and_reject(ctx):
    a = await submit(ctx, sid="S", url="https://change.dev")
    await reg.approve_project(ctx, a["id"])
    sv = await reg.manage_save(ctx, {"id": a["id"], "pin": "123456", "name": "바뀐 이름", "category": "content"}, "ipS", "S")
    assert sv["ok"] and sv["linkReview"] is True and sv["project"]["pendingName"] == "바뀐 이름"
    async with ctx.db.session() as s:
        name, cat = (await s.execute(text("SELECT name, category FROM shrines WHERE project_id = :id"), {"id": a["id"]})).one()
    assert (name, cat) == ("데모 프로젝트", "content")
    assert await reg.reject_project(ctx, a["id"], "  사칭   의심 ") == "변경을 반려했습니다: 데모 프로젝트 (사당은 원래 글자 · 링크 · 이미지 그대로)"
    assert (await row(ctx, a["id"]))["note"] == "link-rejected: 사칭   의심"
    sv = await reg.manage_save(ctx, {"id": a["id"], "pin": "123456", "url": "https://change-2.dev", "sign": "새지붕"}, "ipS", "S")
    assert sv["linkReview"] and sv["project"]["pendingUrl"] == "https://change-2.dev"
    msg = await reg.approve_project(ctx, a["id"])
    assert msg == "글자 · 링크 변경을 승인했습니다: 데모 프로젝트 (https://change-2.dev)"
    async with ctx.db.session() as s:
        dom, sign = (await s.execute(text("SELECT domain, sign FROM shrines WHERE project_id = :id"), {"id": a["id"]})).one()
    assert (dom, sign) == ("change-2.dev", "새지붕")
    p = await submit(ctx, url="https://to-reject.dev")
    assert await reg.reject_project(ctx, p["id"], "") == "반려했습니다: 데모 프로젝트"
    assert (await row(ctx, p["id"]))["note"] == "rejected"
    # 반려된 접수를 고치면 다시 대기
    sv = await reg.manage_save(ctx, {"id": p["id"], "pin": "123456", "tagline": "고쳐서 다시 냄"}, "ipP", "P")
    r = await row(ctx, p["id"])
    assert sv["ok"] and r["status"] == "pending" and r["closed_at"] is None and r["review_at"] is not None


async def test_withdraw_retention_purge(ctx):
    img = await uploads.save_upload(ctx, png(40, 30), "W", "ipW")
    assert img["ok"]
    a = await submit(ctx, sid="W", url="https://withdraw.dev", screen=img["id"])
    await reg.approve_project(ctx, a["id"])
    assert await uploads.is_public_upload(ctx, img["id"])
    assert (await reg.manage_withdraw(ctx, {"id": a["id"], "pin": "123456"}, "ipW")) == {"ok": True}
    async with ctx.db.session() as s:
        assert (await s.execute(text("SELECT COUNT(*) FROM shrines"))).scalar_one() == 0
    assert not await uploads.is_public_upload(ctx, img["id"])
    assert (await reg.manage_get(ctx, {"id": a["id"], "pin": "123456"}, "ipW"))["reason"] == "none"
    # 90일 지난 검토 · 30일 지난 파기
    old = await submit(ctx, url="https://old.dev")
    async with ctx.db.begin() as s:
        await s.execute(text("UPDATE projects SET review_at = :t WHERE id = :id"), {"t": now_ms() - 91 * DAY_MS, "id": old["id"]})
        await s.execute(text("INSERT INTO pin_locks (project_id, day, fails, until) VALUES (:id, 'x', 3, 0)"), {"id": a["id"]})
    r = await retention.run_retention(ctx)
    assert r == {"expired": 1, "expiredChanges": 0, "purged": 0, "images": 0, "posts": 0, "reports": 0}
    assert (ctx.uploads.dir / img["id"]).exists()
    async with fresh_retention(ctx, 0):
        r = await retention.run_retention(ctx)
    assert r["purged"] == 2 and r["images"] == 1
    assert not (ctx.uploads.dir / img["id"]).exists()
    p = await row(ctx, a["id"])
    assert (p["email"], p["pin_hash"], p["url"], p["name"], p["screen"], p["slug"]) == ("", "", "", "(파기됨)", "", "")
    async with ctx.db.session() as s:
        assert (await s.execute(text("SELECT COUNT(*) FROM pin_locks"))).scalar_one() == 0
    async with fresh_retention(ctx, 0):
        assert (await retention.run_retention(ctx))["purged"] == 0
    # 바로 파기 (맵에 있는 접수)
    b = await submit(ctx, url="https://erase.dev")
    await reg.approve_project(ctx, b["id"])
    d = await retention.destroy_project_now(ctx, b["id"])
    assert d == {"ok": True, "images": 0, "message": f"접수 #{b['id']}의 개인정보를 파기했습니다 (이미지 0개)"}
    assert (await row(ctx, b["id"]))["note"] == "erased"
    assert (await retention.destroy_project_now(ctx, 987654)) == {"ok": False, "images": 0, "message": "없는 접수입니다: 987654"}
    assert (await retention.destroy_project_now(ctx, b["id"]))["images"] == 0  # 이미 파기: 빈 목록


class fresh_retention:
    """config는 고정(frozen)이라 시험에서만 retention_days를 잠깐 바꿉니다."""

    def __init__(self, ctx, days: float):
        self.ctx, self.days = ctx, days

    async def __aenter__(self):
        import dataclasses

        self.old = self.ctx.config
        self.ctx.config = dataclasses.replace(self.old, retention_days=self.days)

    async def __aexit__(self, *exc):
        self.ctx.config = self.old


# ── 업로드 ───────────────────────────────────────────────────────────


async def test_upload_quota_and_owner(ctx):
    res = await asyncio.gather(*(uploads.save_upload(ctx, png(20 + i, 20), "Q", f"ipq{i}") for i in range(12)))
    assert sorted(x.get("reason", "ok") for x in res) == ["ok"] * 10 + ["slow", "slow"]
    ids = [x["id"] for x in res if x["ok"]]
    assert await uploads.owns_upload(ctx, ids[0], "Q") and not await uploads.owns_upload(ctx, ids[0], "R")
    assert len(list(ctx.uploads.dir.iterdir())) == 10
    # 하루 30장 (IP)
    await ctx.redis.set(uploads._ip_key(kst_date(), "ipFull"), 30)
    assert (await uploads.save_upload(ctx, png(30, 30), "Z", "ipFull"))["reason"] == "many"
    # 동시 업로드 3개
    slots = [await uploads.begin_upload(ctx, f"s{i}", f"i{i}") for i in range(4)]
    assert [isinstance(s, uploads.Slot) for s in slots] == [True, True, True, False] and slots[3] == "busy"
    for s in slots[:3]:
        s.done()
        s.done()
    assert ctx.uploads.active == 0
    # 시도 20번 (10분)
    for _ in range(20):
        s = await uploads.begin_upload(ctx, "T", "ipT")
        assert isinstance(s, uploads.Slot)
        s.done()
    assert await uploads.begin_upload(ctx, "T", "ipT") == "slow"
    # 보기 허락 (3시간)
    await uploads.grant_upload_view(ctx, "G", [ids[1], "../x", None])
    assert await uploads.can_see_private(ctx, None, ids[1], "G")
    assert not await uploads.can_see_private(ctx, None, ids[2], "G")
    ttl = await ctx.redis.pttl("shrine:up:grant:G")
    assert 3 * 3600_000 - 5000 < ttl <= 3 * 3600_000
    # 정리: 안 쓰인 지 하루 지난 파일만
    import os

    old = ctx.uploads.dir / ids[3]
    t = (now_ms() - 25 * 3600_000) / 1000
    os.utime(old, (t, t))
    assert await uploads.cleanup_uploads(ctx) == 1 and not old.exists()


async def test_metadata_stripped_on_disk(ctx):
    r = await uploads.save_upload(ctx, jpeg(64, 48), "J", "ipJ")
    data = (ctx.uploads.dir / r["id"]).read_bytes()
    assert r["id"].endswith(".jpg") and b"GPS-LAT" not in data and b"COMMENT-SECRET" not in data and b"JFIF" in data
    assert (await uploads.save_upload(ctx, b"", "J", "ipJ"))["reason"] == "bad"
    assert (await uploads.save_upload(ctx, png(15, 40), "J", "ipJ"))["reason"] == "type"
    assert (await uploads.save_upload(ctx, None, "J", "ipJ"))["reason"] == "size"
