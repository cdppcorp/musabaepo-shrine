"""P4 운영 작업 라이브러리 시험 (PostgreSQL + Redis): 사당 넣기 · 고치기 · 옮기기 · 상태 · 내리기, 게시판 글, admin_log,
운영자 세션 · 로그인 잠금 · 출처 검사, 운영자 API의 작은 읽기 함수. PostgreSQL · Redis가 없으면 건너뜁니다.

HTTP 응답 모양 · 머리글은 test_p4_parity.py(Node와 비교)와 적합성 시험 admin 묶음이 봅니다.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import text

from _p2b_util import fresh_ctx
from shrine import admin_api, admin_auth, ops
from shrine import registry as reg
from shrine.logic.util import kst_date, now_ms


@pytest.fixture
async def ctx(tmp_path: Path):
    async with fresh_ctx(tmp_path, redis_db=0, ADMIN_PASSWORD="p4-unit-admin-password-0123456789", ADMIN_IPS="198.51.100.10") as c:
        yield c


SCREEN = ["up/AAAAAAAAAAAAAAAA.png"]
ADD = {"name": "운영 사당", "tagline": "운영자가 직접 세운 사당", "category": "productivity", "url": "https://ops-shrine.example.com"}


async def _count(ctx, sql: str, **p) -> int:
    async with ctx.db.session() as s:
        return int((await s.execute(text(sql), p)).scalar_one())


# ── 사당 ─────────────────────────────────────────────────────────────


async def test_add_shrine_defaults_and_key_order(ctx):
    sh = await ops.add_shrine(ctx, dict(ADD), SCREEN)
    assert list(sh) == [
        "slug", "name", "tagline", "category", "domain", "url", "operator", "keeper", "paid", "verifiedDomain",
        "verifiedBusiness", "joinedAt", "status", "prayer", "charm", "deco", "screens", "capturedAt", "channel", "plot", "repo",
        "email", "emailPublic", "projectId", "sign",
    ]  # fmt: skip
    assert sh["slug"] == "ops-shrine-example-com"  # GitHub가 없으면 이름(한글 → '') 다음 도메인으로
    assert (sh["channel"], sh["plot"], sh["operator"], sh["prayer"], sh["status"]) == (1, 0, "익명", "deploy", "live")
    assert sh["sign"] == "운영자가 직접"  # 지붕 소개: 한 줄 소개 앞 8글자 trim
    assert sh["verifiedDomain"] == kst_date() and sh["projectId"] == 0


async def test_add_shrine_errors(ctx):
    await ops.add_shrine(ctx, dict(ADD), SCREEN)

    async def err(**patch):
        with pytest.raises(ops.OpError) as e:
            await ops.add_shrine(ctx, {**ADD, "url": "https://other.example.com", **patch}, SCREEN)
        return e.value.status, str(e.value)

    assert await err(name="") == (400, "이름: 비어 있습니다")
    assert await err(name="가" * 21) == (400, "이름: 20자까지 쓸 수 있습니다")
    assert await err(name=5) == (400, "이름: 글자로 넣어 주세요")
    assert await err(category="nope") == (400, "분류를 골라 주세요")
    assert await err(url="http://127.0.0.1") == (400, ops.LINK_FAIL["url"])
    assert await err(url="", github="") == (400, ops.LINK_FAIL["link"])
    assert await err(prayer="x") == (400, "현판 기원을 골라 주세요")
    assert await err(channel=4) == (400, "없는 채널입니다 (1~3)")
    assert await err(channel="x") == (400, "없는 채널입니다 (1~3)")
    assert await err(plot=20) == (400, "없는 자리 번호입니다 (0~19)")
    assert await err(plot=True) == (400, "없는 자리 번호입니다 (0~19)")
    assert await err(plot=0) == (409, "이미 사당이 있는 자리입니다: 채널 1 · 0번")
    assert await err(status="closed") == (400, "상태는 live(운영 중) 또는 check(닫힘 · 점검 중)입니다")
    assert await err(status="") == (400, "상태는 live(운영 중) 또는 check(닫힘 · 점검 중)입니다")
    assert await err(email="nope") == (400, "이메일 형식이 올바르지 않습니다")
    assert await err(slug="Bad Slug!") == (400, "주소 이름(slug)은 영문 소문자 · 숫자 · 하이픈 1~40자입니다")
    assert await err(slug="ops-shrine-example-com") == (409, "이미 쓰는 주소 이름입니다: ops-shrine-example-com")
    assert await err(url="https://ops-shrine.example.com") == (409, "다른 사당(ops-shrine-example-com)이 같은 주소를 씁니다: ops-shrine.example.com")
    # 꽉 찬 채널
    for plot in range(1, 20):
        await ops.add_shrine(ctx, {**ADD, "url": f"https://fill-{plot}.example.com", "channel": 1, "plot": plot}, SCREEN)
    assert await err(channel=1) == (409, "채널 1에는 빈 사당 자리가 없습니다")
    sh = await ops.add_shrine(ctx, {**ADD, "url": "https://next.example.com"}, SCREEN)
    assert (sh["channel"], sh["plot"]) == (2, 0)  # 채널을 비우면 1번 채널부터 첫 빈 자리


async def test_add_github_only_email_and_string_numbers(ctx):
    sh = await ops.add_shrine(
        ctx,
        {"name": "GitHub만", "tagline": "저장소만 있는 사당", "category": "devtools", "github": "https://github.com/test-owner/only-repo",
         "plot": "3", "channel": "2", "email": " Dev@Example.COM ", "emailPublic": True, "keeper": True, "operator": " 기원소 "},
        SCREEN,
    )  # fmt: skip
    assert sh["slug"] == "only-repo" and sh["domain"] == "github.com/test-owner/only-repo"
    assert (sh["channel"], sh["plot"]) == (2, 3) and isinstance(sh["plot"], int)
    assert sh["email"] == "dev@example.com" and sh["emailPublic"] is True and sh["keeper"] is True and sh["operator"] == "기원소"
    # 같은 저장소 이름은 -2
    sh2 = await ops.add_shrine(
        ctx, {"name": "둘째", "tagline": "같은 저장소 이름", "category": "devtools", "github": "https://github.com/other/only-repo"}, SCREEN
    )
    assert sh2["slug"] == "only-repo-2" and sh2["emailPublic"] is False


async def test_update_move_status_remove(ctx):
    sh = await ops.add_shrine(ctx, dict(ADD), SCREEN)
    slug = sh["slug"]
    r = await ops.update_shrine(ctx, slug, {"name": "고친 사당", "tagline": "이름과 소개를 고쳤습니다", "sign": "고침", "status": "check"})
    assert r["changed"] == ["name", "tagline", "sign", "status"]
    r = await ops.update_shrine(ctx, slug, {"name": "고친 사당"})
    assert r["changed"] == [] and r["shrine"]["name"] == "고친 사당"
    r = await ops.update_shrine(ctx, slug, {"url": "https://moved-domain.example.com"})
    assert r["changed"] == ["domain", "url"] and r["shrine"]["domain"] == "moved-domain.example.com"
    r = await ops.update_shrine(ctx, slug, {"sign": ""})  # 비우면 한 줄 소개 앞 8글자
    assert r["shrine"]["sign"] == "이름과 소개를"
    with pytest.raises(ops.OpError) as e:
        await ops.update_shrine(ctx, "no-such", {"name": "x"})
    assert (e.value.status, str(e.value)) == (404, "없는 사당입니다: no-such")
    with pytest.raises(ops.OpError) as e:
        await ops.update_shrine(ctx, 5, {})
    assert str(e.value) == "없는 사당입니다: "

    m = await ops.move_shrine(ctx, slug, 12)
    assert ops.move_text(m) == "0 → 12" and m["shrine"]["plot"] == 12
    m = await ops.move_shrine(ctx, slug, "7", "2")
    assert ops.move_text(m) == "채널 1 · 12번 → 채널 2 · 7번"
    with pytest.raises(ops.OpError) as e:
        await ops.move_shrine(ctx, slug, 7)
    assert e.value.status == 409 and "이미 사당이 있는 자리" in str(e.value)
    with pytest.raises(ops.OpError) as e:
        await ops.move_shrine(ctx, slug, 99)
    assert e.value.status == 400

    st = await ops.set_shrine_status(ctx, slug, "live")
    assert st["status"] == "live"
    with pytest.raises(ops.OpError):
        await ops.set_shrine_status(ctx, slug, "closed")

    gone = await ops.remove_shrine(ctx, slug, "  시험   끝 ")
    assert gone["slug"] == slug
    assert await _count(ctx, "SELECT COUNT(*) FROM shrines") == 0
    with pytest.raises(ops.OpError) as e:
        await ops.remove_shrine(ctx, slug)
    assert e.value.status == 404
    with pytest.raises(ops.OpError) as e:
        await ops.remove_shrine(ctx, "x", "가" * 81)
    assert e.value.status == 404  # 사당을 먼저 봄 (Node 순서)


async def test_registry_shrine_edit_and_remove_touch_project(ctx):
    r = await reg.submit_project(
        ctx, {"name": "데모", "tagline": "등록소 사당", "category": "devtools", "url": "https://p4-demo.dev", "email": "d@example.com",
              "emailPublic": False, "pin": "123456", "consent": True}, "sid-a", "ip-a", "닉",
    )  # fmt: skip
    pid = r["id"]
    msg = await reg.approve_project(ctx, pid)
    assert "승인했습니다" in msg
    p = await reg.project_for_admin(ctx, pid)
    await ops.update_shrine(ctx, p["slug"], {"name": "운영자가 고친 이름"})
    assert (await reg.project_for_admin(ctx, pid))["name"] == "운영자가 고친 이름"
    await ops.remove_shrine(ctx, p["slug"], "규칙 위반")
    p = await reg.project_for_admin(ctx, pid)
    assert (p["status"], p["note"]) == ("rejected", "removed: 규칙 위반") and p["closedAt"] is not None


async def test_concurrent_moves_to_same_plot_one_wins(ctx):
    a = await ops.add_shrine(ctx, {**ADD, "url": "https://a.example.com"}, SCREEN)
    b = await ops.add_shrine(ctx, {**ADD, "url": "https://b.example.com"}, SCREEN)
    res = await asyncio.gather(ops.move_shrine(ctx, a["slug"], 9), ops.move_shrine(ctx, b["slug"], 9), return_exceptions=True)
    ok = [x for x in res if isinstance(x, dict)]
    bad = [x for x in res if not isinstance(x, dict)]
    assert len(ok) == 1 and len(bad) == 1  # 다른 쪽은 409 또는 UNIQUE 위반
    assert await _count(ctx, "SELECT COUNT(*) FROM shrines WHERE plot = 9") == 1


# ── 게시판 · 기록 ────────────────────────────────────────────────────


async def test_posts_admin(ctx):
    now = now_ms()
    async with ctx.db.begin() as s:
        ids = []
        for at, topic, txt in ((now - 60_000, "claude", "첫 글"), (now - 30_000, "gpt", "신고받은 글"), (now, "etc", "가장 새 글")):
            ids.append((await s.execute(text("INSERT INTO posts (at, topic, text, nick) VALUES (:a, :t, :x, 'n') RETURNING id"),
                                        {"a": at, "t": topic, "x": txt})).scalar_one())  # fmt: skip
        for r in ("r1", "r2"):
            await s.execute(text("INSERT INTO post_reports (post_id, reporter) VALUES (:p, :r)"), {"p": ids[1], "r": r})
    review = await ops.posts_for_review(ctx)
    assert [p["id"] for p in review] == [ids[1], ids[2], ids[0]] and review[0]["reports"] == 2
    assert list(review[0]) == ["id", "at", "topic", "text", "nick", "hidden", "reports"]
    assert [p["id"] for p in await ops.all_posts_for_admin(ctx)] == [ids[2], ids[1], ids[0]]
    assert await ops.post_counts(ctx) == {"reported": 1, "hidden": 0, "total": 3}
    assert await ops.set_post_hidden(ctx, ids[1], True) and (await ops.find_post(ctx, ids[1]))["hidden"] == 1
    assert await ops.delete_post(ctx, ids[1])
    assert await ops.find_post(ctx, ids[1]) is None and not await ops.delete_post(ctx, ids[1])
    assert await ops.post_counts(ctx) == {"reported": 0, "hidden": 0, "total": 2}
    assert not await ops.set_post_hidden(ctx, 2**70, True) and await ops.find_post(ctx, 1e300) is None


async def test_admin_log_and_read_log(ctx):
    await ops.admin_log(ctx, "shrine-move", "가" * 100, "abc", "내" * 300)
    await ops.admin_log(ctx, "project-approve", 5, "cli", "x")
    log = await ops.read_log(ctx, None)
    assert [x["action"] for x in log] == ["project-approve", "shrine-move"]
    assert list(log[0]) == ["id", "at", "action", "target", "ip", "detail"]
    assert log[0]["target"] == "5" and log[0]["ip"] == "cli"
    assert len(log[1]["target"]) == 80 and len(log[1]["detail"]) == 200
    assert len(await ops.read_log(ctx, "1")) == 1 and len(await ops.read_log(ctx, "0")) == 2 and len(await ops.read_log(ctx, "x")) == 2
    assert len(await ops.read_log(ctx, " 1e0 ")) == 1  # JS Number() 규칙
    # 로그인 실패는 최근 1000건만
    async with ctx.db.begin() as s:
        await s.execute(
            text("INSERT INTO admin_log (at, action, target, ip_hash, detail) SELECT 1, 'login-fail', '', 'h', '' FROM generate_series(1, 1005)")
        )
    await ops.admin_log(ctx, "login-fail", "", "h")
    assert await _count(ctx, "SELECT COUNT(*) FROM admin_log WHERE action = 'login-fail'") == 1000


# ── 운영자 세션 · 잠금 · 출처 ────────────────────────────────────────


def _req(headers: dict[str, str], ip: str = "198.51.100.10", query: bytes = b"") -> SimpleNamespace:
    raw = [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers.items()]
    return SimpleNamespace(scope={"headers": raw, "query_string": query}, state=SimpleNamespace(client_ip=ip), client=None)


async def test_session_sign_read_revoke(ctx):
    from shrine.logic.crypto import new_session, sign_session

    st = admin_auth.setup(ctx)
    assert st.enabled and st.ips == ["198.51.100.10"]
    s = new_session()
    cookie = sign_session(s, st.keys)
    req = _req({"Cookie": f"shrine_ticket=x; shrine_admin={cookie}"})
    assert await admin_auth.read_session(ctx, req) == s
    assert await admin_auth.read_session(ctx, _req({"Cookie": f"shrine_admin={cookie[:-2]}xx"})) is None
    await admin_auth.revoke(ctx, s)
    assert await admin_auth.read_session(ctx, req) is None
    ttl = await ctx.redis.pttl(f"shrine:admin:revoked:{s['sid']}")
    assert 0 < ttl <= 8 * 3600_000
    assert admin_auth.ip_allowed(st, _req({}, "::ffff:198.51.100.10")) and not admin_auth.ip_allowed(st, _req({}, "198.51.100.11"))
    assert admin_auth.log_ip(st, _req({}, "::FFFF:198.51.100.10")) == admin_auth.log_ip(st, _req({}, "198.51.100.10"))
    assert len(admin_auth.log_ip(st, _req({}))) == 16


async def test_same_origin_rules(ctx):
    so = lambda h: admin_auth.same_origin(ctx, _req(h))  # noqa: E731
    assert so({"Origin": "http://shrine.local:3000", "Host": "shrine.local:3000"})
    assert not so({"Origin": "http://evil.example", "Host": "shrine.local"})
    assert not so({"Host": "shrine.local"})  # Origin · Sec-Fetch-Site 둘 다 없음
    assert so({"Sec-Fetch-Site": "same-origin", "Host": "shrine.local"})
    assert not so({"Sec-Fetch-Site": "cross-site", "Origin": "http://shrine.local", "Host": "shrine.local"})
    assert not so({"Origin": "null", "Host": "shrine.local"})


async def test_login_lockout_windows(ctx):
    t0 = 1_000_000_000_000
    for i in range(5):
        assert not await admin_auth.login_locked(ctx, "ip-a", t0 + i)
        await admin_auth.add_login_fail(ctx, "ip-a", t0 + i)
    assert await admin_auth.login_locked(ctx, "ip-a", t0 + 10)
    assert not await admin_auth.login_locked(ctx, "ip-b", t0 + 10)
    # 첫 실패부터 15분이 지나면 IP 잠금이 풀리고, 전체 창도 이 시도 때부터 새로 (Node: 끝난 뒤 처음 시도한 때부터)
    t1 = t0 + 15 * 60_000
    assert not await admin_auth.login_locked(ctx, "ip-a", t1)
    await admin_auth.clear_ip_fails(ctx, "ip-a")
    for i in range(49):
        await admin_auth.add_login_fail(ctx, f"ip-{i}", t1 + 1)
    # 보안 점검: 전체 잠금은 ADMIN_IPS가 비었을 때만 (이 ctx는 ADMIN_IPS가 있어 잠깐 비워서 봄)
    st = admin_auth.setup(ctx)
    ips, st.ips = st.ips, []
    assert not await admin_auth.login_locked(ctx, "ip-new", t1 + 2)
    await admin_auth.add_login_fail(ctx, "ip-x", t1 + 3)
    assert await admin_auth.login_locked(ctx, "ip-new", t1 + 4)  # 전체 15분에 50번
    st.ips = ips
    assert not await admin_auth.login_locked(ctx, "ip-new", t1 + 4)  # ADMIN_IPS가 있으면 전체 잠금 없음
    st.ips = []
    assert not await admin_auth.login_locked(ctx, "ip-new", t1 + 15 * 60_000)
    st.ips = ips


# ── 운영자 API 작은 함수 ─────────────────────────────────────────────


def test_read_id_minutes_and_details():
    assert admin_api.read_id(5) == 5 and admin_api.read_id("123456789") == 123456789
    assert admin_api.read_id("1234567890") is None and admin_api.read_id("-1") is None and admin_api.read_id(0) is None
    assert admin_api.read_id(True) is None and admin_api.read_id(2.5) is None and admin_api.read_id(3.0) == 3
    assert admin_api.read_id(1e300) == 1e300  # Node처럼 숫자는 그대로 (DB 범위 밖은 '없는 번호'로)
    big = 90 * 24 * 3600_000
    assert admin_api.read_minutes(60, big) == 60 and admin_api.read_minutes("129600", big) == 129600
    assert admin_api.read_minutes(129601, big) is None and admin_api.read_minutes(0, big) is None
    assert admin_api.read_minutes("1234567", big) is None and admin_api.read_minutes(1.5, big) is None
    assert [admin_api.fmt_minutes(m) for m in (30, 60, 1440, 2880, 90)] == ["30분", "1시간", "1일", "2일", "90분"]
    b = {"nick": "", "byIp": True, "reason": "도배"}
    assert admin_api.block_detail(b, 60) == "- · 1시간 · IP · 입장 표 · 도배"
    assert admin_api.block_detail({"nick": "n", "byIp": False, "reason": ""}, None) == "n · 입장 표"
    assert admin_api._b64("aGk") == b"hi" and admin_api._b64("aGk=") == b"hi" and admin_api._b64("aGkx" + "Q") == b"hi1"
    req = _req({}, query=b"limit=5&limit=7&filter=")
    assert admin_api.query_first(req, "limit") == "5" and admin_api.query_first(req, "filter") == "" and admin_api.query_first(req, "x") is None


def test_error_reply_mapping():
    from shrine.logic.chat import OpError as ChatOpError

    assert admin_api.error_reply(ops.OpError("가", 409)).status == 409
    assert admin_api.error_reply(ChatOpError("사유: 80자까지 쓸 수 있습니다")).body == {"ok": False, "reason": "rule", "message": "사유: 80자까지 쓸 수 있습니다"}
    r = admin_api.error_reply(reg.RegistryError("UNIQUE constraint failed: shrines.slug"))
    assert (r.status, r.body["message"]) == (409, "같은 주소 · 자리 · 이름을 쓰는 사당이 이미 있습니다")
    assert admin_api.error_reply(reg.RegistryError("없는 접수입니다: 5")).status == 409
    assert admin_api.error_reply(ValueError("boom")) is None
