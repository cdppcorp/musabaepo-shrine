"""보안 점검으로 고친 곳 (HTTP 입구 · 등록소 PIN · 업로드 · 글자 검사 · 헬스 체크) 시험.

Node와 일부러 다르게 둔 곳들이라 Node와 맞춰 보지 않고 바라는 동작을 바로 확인합니다.
PostgreSQL · Redis가 필요한 시험은 없으면 건너뜁니다 (_p2b_util.fresh_ctx).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import struct
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import StatementError
from starlette.requests import Request

from _p2b_util import fresh_ctx, png, png_chunk, riff_chunk, seg, webp
from shrine import registry as reg
from shrine import storage, uploads
from shrine.config import load_config
from shrine.context import AppContext
from shrine.db.engine import Database
from shrine.logic.chat import clean_chat, clean_op_text, clean_sign, clean_text
from shrine.logic.links import clean_email
from shrine.logic.util import kst_date, now_ms
from shrine.storage import UploadStore
from shrine.web import front as front_mod
from shrine.web import health as health_mod
from shrine.web.front import BodyDeadline, FrontController
from shrine.web.net import MAX_HEADERS, ip_hash
from shrine.web.registry import read_limited

DB = "postgresql://u:p@127.0.0.1:5432/db"


@pytest.fixture
async def ctx(tmp_path: Path):
    async with fresh_ctx(tmp_path) as c:
        yield c


BASE = {
    "name": "보안 점검", "tagline": "보안 점검 시험용 프로젝트", "category": "devtools", "url": "https://sec-demo.dev",
    "email": "owner@example.com", "emailPublic": False, "pin": "123456", "consent": True,
}  # fmt: skip
_n = 0


async def submit(ctx, **patch) -> int:
    global _n
    _n += 1
    r = await reg.submit_project(ctx, {**BASE, **patch}, f"sec-sid-{_n}", f"sec-ip-{_n}", "닉네임")
    assert r["ok"], r
    return r["id"]


async def day_fails(ctx, pid: int) -> int:
    async with ctx.db.session() as s:
        v = (await s.execute(text("SELECT fails FROM pin_locks WHERE project_id = :id"), {"id": pid})).scalar()
    return int(v or 0)


# ── 4. IP 해시: IPv6 /64 · IPv4 매핑 주소로 묶기 ──────────────────────


def test_ip_hash_groups_ipv6_by_64_and_mapped_ipv4():
    assert ip_hash("2001:db8:1:2:aaaa::1") == ip_hash("2001:db8:1:2:bbbb:cccc:dddd:9")
    assert ip_hash("2001:db8:1:2::1") != ip_hash("2001:db8:1:3::1")
    assert ip_hash("::ffff:10.1.2.3") == ip_hash("10.1.2.3") != ip_hash("10.1.2.4")
    # 이미 /64로 묶은 값 · IP가 아닌 값도 같은 결과 (실시간이 먼저 묶어서 넘겨도 같음)
    assert ip_hash("2001:db8:1:2::/64") == ip_hash("2001:db8:1:2::9")
    assert ip_hash("unknown") == ip_hash("unknown")


# ── 3 · 2 · 6. HTTP 입구 (FrontController) ───────────────────────────


class _Limiter:
    def __init__(self) -> None:
        self.keys: list[str] = []

    async def allow(self, k: str) -> bool:
        self.keys.append(k)
        return True


def _front(tmp_path, inner, **env) -> tuple[FrontController, _Limiter]:
    ctx = AppContext(config=load_config({"DATABASE_URL": DB, "DATA_DIR": str(tmp_path), "TRUST_PROXY": "true", **env}).config)
    lim = _Limiter()
    ctx.request_limiter = lim
    return FrontController(inner, ctx), lim


async def _call(app, headers, parts=(b"",), *, method="POST", path="/api/x"):
    """parts: bytes(본문 조각) 또는 float(그만큼 기다림). 끝에 more_body=False 조각을 붙입니다."""
    scope = {
        "type": "http", "method": method, "path": path, "raw_path": path.encode(), "query_string": b"",
        "headers": [(k.encode(), v.encode()) for k, v in headers], "client": ("192.0.2.1", 1234),
        "http_version": "1.1", "scheme": "http", "server": ("t", 80), "root_path": "",
    }  # fmt: skip
    queue = list(parts)

    async def receive():
        while queue and isinstance(queue[0], float):
            await asyncio.sleep(queue.pop(0))
        if not queue:
            await asyncio.sleep(3600)
        chunk = queue.pop(0)
        return {"type": "http.request", "body": chunk, "more_body": bool(queue)}

    sent: list[dict] = []

    async def send(m):
        sent.append(m)

    await app(scope, receive, send)
    start = next(m for m in sent if m["type"] == "http.response.start")
    hdrs = {k.decode().lower(): v.decode() for k, v in start["headers"]}
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return start["status"], hdrs, body


async def _echo_len(scope, receive, send):
    buf = await read_limited(Request(scope, receive), 10_000)
    out = b"none" if buf is None else str(len(buf)).encode()
    await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/plain")]})
    await send({"type": "http.response.body", "body": out})


async def test_too_many_headers_rejected_with_431(tmp_path):
    app, lim = _front(tmp_path, _echo_len)
    fill = [(f"X-Fill-{i}", "1") for i in range(MAX_HEADERS)]
    status, hdrs, body = await _call(app, [*fill, ("X-Forwarded-For", "203.0.113.9")])
    assert status == 431 and hdrs["connection"] == "close" and "content-security-policy" in hdrs
    assert body == b"Request Header Fields Too Large" and lim.keys == []  # 앱 · 요청 제한까지 가지 않음
    status, _, body = await _call(app, [*fill[:-1], ("X-Forwarded-For", "203.0.113.9")], [b"abc"])
    assert status == 200 and body == b"3" and lim.keys == [ip_hash("203.0.113.9")]


async def test_slow_body_is_cut_and_connection_closed(tmp_path, monkeypatch):
    monkeypatch.setattr(front_mod, "BODY_IDLE_S", 0.2)
    app, _ = _front(tmp_path, _echo_len)
    # 조각 사이가 너무 김 → 끊긴 것으로 (read_limited None) + Connection: close
    status, hdrs, body = await _call(app, [], [b"ab", 1.0, b"cd"])
    assert status == 200 and body == b"none" and hdrs["connection"] == "close"
    # 제때 오면 그대로
    status, hdrs, body = await _call(app, [], [b"ab", 0.05, b"cd"])
    assert body == b"4" and "connection" not in hdrs
    # 전체 시간 한도
    monkeypatch.setattr(front_mod, "BODY_IDLE_S", 5.0)
    monkeypatch.setattr(front_mod, "BODY_TOTAL_S", 0.3)
    status, hdrs, body = await _call(app, [], [b"a", 0.15, b"b", 0.15, b"c", 0.15, b"d"])
    assert body == b"none" and hdrs["connection"] == "close"
    # 최소 속도 (유예가 지난 뒤 평균 초당 min_rate 아래)
    monkeypatch.setattr(front_mod, "BODY_TOTAL_S", 60.0)
    monkeypatch.setattr(front_mod, "BODY_RATE_GRACE_S", 0.1)
    monkeypatch.setattr(front_mod, "BODY_MIN_RATE", 1000.0)
    status, hdrs, body = await _call(app, [], [b"a", 0.15, b"b", 0.15, b"c"])
    assert body == b"none" and hdrs["connection"] == "close"


async def test_slow_body_without_catch_gets_408(tmp_path, monkeypatch):
    """본문을 읽다 끊긴 것을 따로 다루지 않는 곳(JSON 읽기 등)은 front가 408 + Connection: close로 답합니다."""
    monkeypatch.setattr(front_mod, "BODY_IDLE_S", 0.1)

    async def raw_stream(scope, receive, send):
        async for _ in Request(scope, receive).stream():
            pass
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    app, _ = _front(tmp_path, raw_stream)
    status, hdrs, body = await _call(app, [], [b"{", 0.5, b"}"])
    assert status == 408 and hdrs["connection"] == "close" and body == b"Request Timeout"


async def test_body_deadline_passthrough_after_body():
    """본문을 다 받은 뒤의 receive(응답 중 연결 끊김 감시)에는 한도를 걸지 않습니다."""
    msgs = [{"type": "http.request", "body": b"x", "more_body": False}, {"type": "http.disconnect"}]

    async def receive():
        return msgs.pop(0)

    d = BodyDeadline(receive)
    d.total = 0.0  # 본문 뒤라면 한도가 0이어도 원래 receive로
    d._done = True
    assert (await d.receive())["type"] == "http.request" and not d.timed_out


async def test_upload_slot_released_on_slow_body(ctx, monkeypatch):
    """업로드 본문이 느리면 408 timeout이고 동시 업로드 자리는 돌려줍니다 (자리 3개를 붙잡아 두지 못함)."""
    from shrine.logic.crypto import TICKET_COOKIE, sign_ticket
    from shrine.web import uploads as web_uploads

    monkeypatch.setattr(front_mod, "BODY_IDLE_S", 0.1)
    monkeypatch.setattr(web_uploads, "same_origin", lambda request: True)
    ticket = sign_ticket({"sid": "slow-sid", "look": [0] * 12, "nick": "n", "exp": now_ms() + 3600_000}, ctx.config.ticket_secret)
    from starlette.applications import Starlette

    inner = Starlette(routes=web_uploads.routes(""))
    inner.state.ctx = ctx
    app = FrontController(inner, ctx)
    from shrine.redis import FixedWindowLimiter

    ctx.request_limiter = FixedWindowLimiter(ctx.redis, "req", 1000, 60_000)
    hdr = [("Cookie", f"{TICKET_COOKIE}={ticket}"), ("Content-Type", "image/png")]
    for _ in range(4):  # 자리(3개)보다 많이: 돌려주지 않으면 4번째가 busy
        status, hdrs, body = await _call(app, hdr, [b"\x89PNG", 0.5, b"rest"], path="/api/upload")
        assert status == 408 and json.loads(body) == {"ok": False, "reason": "timeout"} and hdrs["connection"] == "close"
    assert ctx.uploads.active == 0


async def test_errors_logged_without_sql_parameters(tmp_path, caplog):
    secret = "owner" + "@secret.example"

    async def boom(scope, receive, send):
        params = {"email": secret, "pin_hash": "abc:" + "def"}
        raise StatementError("실패", "INSERT INTO projects (email) VALUES (:email)", params, ValueError("bad"))

    app, _ = _front(tmp_path, boom)
    with caplog.at_level(logging.ERROR, logger="shrine.http"):
        status, _, body = await _call(app, [], [b""], method="GET", path="/x")
    assert status == 500 and body == b""
    assert "요청 처리 실패" in caplog.text and secret not in caplog.text and "abc:def" not in caplog.text


def test_engine_hides_sql_parameters():
    db = Database("postgresql+asyncpg://u:p@127.0.0.1:1/x")
    assert db.engine.sync_engine.hide_parameters is True


# ── 10. /healthz 결과 2초 다시 쓰기 ───────────────────────────────────


async def test_healthz_cached_for_two_seconds(tmp_path):
    calls = {"db": 0, "count": 0}

    class _DB:
        async def ping(self, *a, **k):
            calls["db"] += 1
            await asyncio.sleep(0.01)

    class _R:
        async def ping(self):
            return True

    ctx = AppContext(config=load_config({"DATABASE_URL": DB, "DATA_DIR": str(tmp_path)}).config, db=_DB(), redis=_R())
    ctx.uploads = UploadStore(str(tmp_path))
    ctx.uploads.prepare()

    async def count(_c):
        calls["count"] += 1
        return 7

    ctx.count_shrines = count
    req = Request({"type": "http", "method": "GET", "headers": [], "path": "/healthz"})
    res = await asyncio.gather(*(health_mod.healthz(req, ctx) for _ in range(20)))
    assert {r.status_code for r in res} == {200} and calls == {"db": 1, "count": 1}
    assert json.loads(res[0].body)["shrines"] == 7 and dict((k.decode().lower(), v.decode()) for k, v in res[0].raw_headers)["cache-control"] == "no-store"
    # 2초가 지나면 다시 확인
    t, ok, body = ctx._health_cache
    ctx._health_cache = (t - health_mod.CACHE_S - 0.01, ok, body)
    await health_mod.healthz(req, ctx)
    assert calls == {"db": 2, "count": 2}


# ── 6. 글자 검사: NUL · 짝 없는 서로게이트 · 이메일 제어 문자 ───────────


def test_text_cleaners_drop_nul_and_lone_surrogates():
    assert clean_chat("가\x00나") == {"ok": True, "text": "가나"}
    assert clean_chat("가\ud800나\udfff") == {"ok": True, "text": "가나"}
    assert clean_chat("\U0001f600") == {"ok": True, "text": "\U0001f600"}  # 짝이 맞는 것은 그대로
    assert clean_chat("😀") == {"ok": True, "text": "\U0001f600"}
    assert clean_chat("시\ud800발")["reason"] == "word"  # 지운 뒤에 금칙어를 봅니다
    assert clean_text("이름\ud800", 20, "name") == {"ok": True, "text": "이름"}
    assert clean_text("\ud800\x00", 20, "name") == {"ok": False, "status": 400, "reason": "name"}
    assert clean_sign("\udc00", "소개") == {"ok": False, "status": 400, "reason": "sign"}
    assert clean_op_text("메모\ud800", 80, "메모") == "메모"
    # e + 서로게이트 + 결합 문자: 지운 뒤 NFC (é 한 글자)
    assert clean_chat("e\ud800́") == {"ok": True, "text": "é"}


def test_clean_email_rejects_control_and_lone_surrogates():
    assert clean_email(" Owner@Example.com ") == "owner@example.com"
    for bad in ("a\x00b@example.com", "a\x01@example.com", "a\x7f@example.com", "a\x85@example.com", "a\ud800@example.com"):
        assert clean_email(bad) is None, ascii(bad)


async def test_registry_rejects_nul_and_surrogates_without_500(ctx):
    r = await reg.submit_project(ctx, {**BASE, "email": "x\x00y@example.com"}, "sid-nul", "ip-nul", "n")
    assert r == {"ok": False, "status": 400, "reason": "email"}
    r = await reg.submit_project(ctx, {**BASE, "name": "\ud800", "url": "https://sur.dev"}, "sid-sur", "ip-sur", "n")
    assert r == {"ok": False, "status": 400, "reason": "name"}
    r = await reg.submit_project(ctx, {**BASE, "name": "좋은\ud800이름", "url": "https://sur2.dev"}, "sid-sur2", "ip-sur2", "n")
    assert r["ok"] and (await reg.get_row(ctx, r["id"]))["name"] == "좋은이름"
    assert (await reg.find_mine(ctx, {"email": "x\ud800@example.com", "pin": "123456"}, "ipZ"))["reason"] == "email"


# ── 7 · 1. PIN 잠금: (접수, IP)마다 20번 · 전체 200번 · 찾기도 셈 ──────


async def test_pin_day_lock_is_per_project_and_ip(ctx):
    pid = await submit(ctx)
    day = kst_date()
    await ctx.redis.set(reg._pin_project_ip_key(day, pid, "ipA"), reg.PIN_FAILS_PER_PROJECT_IP_DAY - 1)
    assert (await reg.manage_get(ctx, {"id": pid, "pin": "999999"}, "ipA", "s"))["reason"] == "locked"
    assert (await reg.manage_get(ctx, {"id": pid, "pin": "123456"}, "ipA", "s")) == {"ok": False, "status": 429, "reason": "locked"}
    # 다른 IP에서는 주인이 그대로 엽니다 (남이 20번 틀려도 접수 전체가 잠기지 않음)
    assert (await reg.manage_get(ctx, {"id": pid, "pin": "123456"}, "ipB", "s"))["ok"]
    assert await day_fails(ctx, pid) == 1
    # 모든 IP 합 200번째 → 24시간 잠금 (DB)
    async with ctx.db.begin() as s:
        await s.execute(text("UPDATE pin_locks SET fails = :n WHERE project_id = :id"), {"n": reg.PIN_FAILS_PER_PROJECT_DAY - 1, "id": pid})
    assert (await reg.manage_get(ctx, {"id": pid, "pin": "000000"}, "ipC", "s"))["reason"] == "locked"
    assert (await reg.manage_get(ctx, {"id": pid, "pin": "123456"}, "ipD", "s"))["reason"] == "locked"


async def test_find_failures_count_for_projects_and_email(ctx):
    email = "finder@example.com"
    p1 = await submit(ctx, email=email, url="https://find-1.dev")
    p2 = await submit(ctx, email=email, url="https://find-2.dev", pin="654321")
    day = kst_date()
    r = await reg.find_mine(ctx, {"email": email, "pin": "111111"}, "ipF")
    assert r == {"ok": False, "status": 403, "reason": "pin"}
    # 그 이메일의 접수마다 하루 횟수 (관리 화면 PIN 확인과 같은 길)
    assert await day_fails(ctx, p1) == 1 and await day_fails(ctx, p2) == 1
    assert int(await ctx.redis.get(reg._pin_project_ip_key(day, p1, "ipF"))) == 1
    # 이메일마다 하루 20번: Redis 키에는 이메일 원문이 없음
    keys = [k.decode() for k in await ctx.redis.keys("shrine:reg:mailday:*")]
    assert len(keys) == 1 and "finder" not in keys[0] and "example" not in keys[0]
    await ctx.redis.set(keys[0], reg.FIND_FAILS_PER_EMAIL_DAY - 1)
    await ctx.redis.delete(reg._mail_key(ctx, email))  # 15분 잠금(5번)과 따로 보려고
    assert (await reg.find_mine(ctx, {"email": email, "pin": "222222"}, "ipG"))["reason"] == "locked"
    # 한도에 닿으면 맞는 PIN도 그날은 찾기 불가 (다른 IP여도)
    assert (await reg.find_mine(ctx, {"email": email, "pin": "123456"}, "ipH")) == {"ok": False, "status": 429, "reason": "locked"}
    # 관리 화면은 접수 번호 + PIN으로 그대로 열림
    assert (await reg.manage_get(ctx, {"id": p1, "pin": "123456"}, "ipH", "s"))["ok"]


# ── 8. 업로드: 5MB · IP당 하루 100MB · 안 쓰인 파일 1시간 ─────────────


async def test_upload_limits(ctx):
    assert uploads.UPLOAD_MAX == 5 * 1024 * 1024 and uploads.PER_IP_DAY_BYTES == 100 * 1024 * 1024
    day = kst_date()
    k = uploads._ip_bytes_key(day, "ipBytes")
    r = await uploads.save_upload(ctx, png(32, 32), "B1", "ipBytes")
    assert r["ok"] and int(await ctx.redis.get(k)) == (ctx.uploads.dir / r["id"]).stat().st_size
    await ctx.redis.set(k, uploads.PER_IP_DAY_BYTES - 10)
    assert (await uploads.save_upload(ctx, png(32, 32), "B2", "ipBytes"))["reason"] == "many"
    await ctx.redis.set(k, uploads.PER_IP_DAY_BYTES)
    assert await uploads.begin_upload(ctx, "B3", "ipBytes") == "many"
    # 다른 IP는 따로
    assert (await uploads.save_upload(ctx, png(32, 32), "B4", "ipOther"))["ok"]


async def test_orphans_removed_after_an_hour_attached_kept(ctx):
    assert 60 * 60_000 < storage.ORPHAN_MS <= 70 * 60_000 and uploads.ATTACH_MS == 60 * 60_000
    a = (await uploads.save_upload(ctx, png(20, 20), "O1", "ipO1"))["id"]
    b = (await uploads.save_upload(ctx, png(21, 20), "O2", "ipO2"))["id"]
    pid = await submit(ctx, url="https://orphan.dev")
    async with ctx.db.begin() as s:
        await s.execute(text("UPDATE projects SET pending_screen = :n WHERE id = :id"), {"n": b, "id": pid})
    t = (now_ms() - 2 * 3600_000) / 1000
    for name in (a, b):
        os.utime(ctx.uploads.dir / name, (t, t))
    assert await uploads.cleanup_uploads(ctx) == 1
    assert not (ctx.uploads.dir / a).exists() and (ctx.uploads.dir / b).exists()
    # 운영자가 올린 것(운영 명령 · 운영자 화면)은 24시간까지 남김
    op_cli = (await uploads.save_upload(ctx, png(23, 20), "cli", "cli", quotas=False))["id"]
    op_admin = (await uploads.save_upload(ctx, png(24, 20), "admin:s1", "ipAdm"))["id"]
    for name in (op_cli, op_admin):
        os.utime(ctx.uploads.dir / name, (t, t))
    assert await uploads.cleanup_uploads(ctx) == 0
    assert (ctx.uploads.dir / op_cli).exists() and (ctx.uploads.dir / op_admin).exists()
    await ctx.redis.set(uploads._owner_key(op_cli), json.dumps({"sid": "cli", "at": now_ms() - 25 * 3600_000}))
    assert await uploads.cleanup_uploads(ctx) == 1 and not (ctx.uploads.dir / op_cli).exists()
    # 1시간이 지나면 새 접수에 붙일 수 없음 (곧 지워질 파일)
    c = (await uploads.save_upload(ctx, png(22, 20), "O3", "ipO3"))["id"]
    assert await uploads.owns_upload(ctx, c, "O3")
    await ctx.redis.set(uploads._owner_key(c), json.dumps({"sid": "O3", "at": now_ms() - 61 * 60_000}))
    assert not await uploads.owns_upload(ctx, c, "O3")


# ── 5. JPEG: 스캔 사이 APPn · COM, EOI 뒤 꼬리 ───────────────────────


def _jpeg_multi(tail: bytes = b"") -> bytes:
    sof = seg(0xC2, bytes([8]) + struct.pack(">HH", 40, 60) + bytes([1, 1, 0x11, 0]))
    sos = seg(0xDA, bytes([1, 1, 0, 0, 0x3F, 0]))
    scan1 = b"\x12\xff\x00\x34\xff\xd0\x56\x78"
    scan2 = b"\x9a\xff\x00\xbc"
    return (
        b"\xff\xd8" + seg(0xE0, b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0") + seg(0xE1, b"Exif\0\0HEAD-GPS-SECRET") + sof
        + seg(0xC4, b"\x00" + bytes(16)) + sos + scan1
        + seg(0xE1, b"http://ns.adobe.com/xap/1.0/\0BETWEEN-XMP-SECRET") + seg(0xFE, b"BETWEEN-COM-SECRET")
        + seg(0xE2, b"MPF\0BETWEEN-APP2-SECRET") + b"\xff\xff" + seg(0xC4, b"\x10" + bytes(16)) + sos + scan2
        + b"\xff\xd9" + tail
    )  # fmt: skip


def test_jpeg_strip_reads_past_sos_and_drops_trailer():
    second = b"\xff\xd8" + seg(0xE1, b"Exif\0\0MPF-SECOND-GPS-SECRET") + b"\xff\xd9"
    motion = b"\0\0\0\x18ftypmp42MOTION-MP4-SECRET" + b"SEFT-TRAILER-SECRET"
    got = uploads.clean_image(_jpeg_multi(second + motion))
    assert not isinstance(got, str), got
    ext, out = got
    assert ext == "jpg" and out.endswith(b"\xff\xd9") and out.count(b"\xff\xd9") == 1
    assert b"SECRET" not in out and b"JFIF" in out and out.count(b"\xff\xda") == 2
    assert b"\x12\xff\x00\x34\xff\xd0\x56\x78" in out and b"\x9a\xff\x00\xbc" in out
    assert uploads.sniff_image(out) == ("jpg", 60, 40)
    # 꼬리가 없어도 결과는 같음
    assert uploads.strip_metadata(_jpeg_multi(), "jpg") == out
    # EOI 없이 끝나거나 SOS 뒤 구조가 깨지면 받지 않음
    assert uploads.strip_metadata(_jpeg_multi()[:-2], "jpg") is None
    broken = _jpeg_multi().replace(b"\xff\xfe\x00\x14", b"\xff\xfe\x7f\xff")
    assert uploads.strip_metadata(broken, "jpg") is None
    assert uploads.clean_image(_jpeg_multi()[:-2]) == "type"


def test_png_and_webp_trailing_data_dropped():
    p = png(20, 20, tail=b"AFTER-IEND-SECRET")
    ext, out = uploads.clean_image(p)
    assert ext == "png" and b"SECRET" not in out and out.endswith(png_chunk("IEND", b""))
    w = webp(30, 30, [riff_chunk("VP8L", bytes([0x2F, 0, 0, 0, 0]))]) + b"AFTER-RIFF-SECRET"
    ext, out = uploads.clean_image(w)
    assert ext == "webp" and b"SECRET" not in out and struct.unpack("<I", out[4:8])[0] == len(out) - 8


# ── PIN 기록(Redis)이 쓰기를 거절할 때: 잠긴 것으로 (fail closed) ─────


@pytest.fixture
def pin_store_reset():
    reg._pin_store_down_until = 0.0
    yield
    reg._pin_store_down_until = 0.0


def _oom(*a, **k):
    from redis.exceptions import ResponseError

    raise ResponseError("OOM command not allowed when used memory > 'maxmemory'.")


async def test_pin_fails_closed_when_redis_rejects_writes(ctx, monkeypatch, pin_store_reset):
    pid = await submit(ctx, url="https://oom.dev")
    real_set, real_incr = reg._set_fail, reg._incr_day

    async def set_fail(*a, **k):
        _oom()

    monkeypatch.setattr(reg, "_set_fail", set_fail)
    # 틀린 PIN: 500이 아니라 locked, 하루 횟수(DB)는 먼저 올라감
    assert (await reg.manage_get(ctx, {"id": pid, "pin": "999999"}, "ipW", "s")) == {"ok": False, "status": 403, "reason": "locked"}
    assert await day_fails(ctx, pid) == 1
    # 그 뒤 잠시 맞는 PIN도 받지 않음 (틀린 횟수가 안 쌓이는 동안 맞춰 보지 못하게)
    assert (await reg.manage_get(ctx, {"id": pid, "pin": "123456"}, "ipW2", "s")) == {"ok": False, "status": 429, "reason": "locked"}
    assert (await reg.find_mine(ctx, {"email": BASE["email"], "pin": "123456"}, "ipW3")) == {"ok": False, "status": 429, "reason": "locked"}
    # Redis가 돌아오고 잠깐이 지나면 다시 됨
    monkeypatch.setattr(reg, "_set_fail", real_set)
    reg._pin_store_down_until = 0.0
    assert (await reg.manage_get(ctx, {"id": pid, "pin": "123456"}, "ipW2", "s"))["ok"]

    # 찾기: 쓰기 실패 → locked, 그 이메일의 접수 하루 횟수는 올라감
    async def incr_day(*a, **k):
        _oom()

    monkeypatch.setattr(reg, "_incr_day", incr_day)
    assert (await reg.find_mine(ctx, {"email": BASE["email"], "pin": "000000"}, "ipW4")) == {"ok": False, "status": 403, "reason": "locked"}
    assert await day_fails(ctx, pid) == 2
    assert (await reg.find_mine(ctx, {"email": BASE["email"], "pin": "123456"}, "ipW5"))["reason"] == "locked"
    monkeypatch.setattr(reg, "_incr_day", real_incr)


async def test_pin_fails_closed_when_redis_reads_fail(ctx, monkeypatch, pin_store_reset):
    pid = await submit(ctx, url="https://down.dev")

    async def count(*a, **k):
        raise ConnectionError("redis down")

    monkeypatch.setattr(reg, "_count", count)
    assert (await reg.manage_get(ctx, {"id": pid, "pin": "123456"}, "ipR", "s")) == {"ok": False, "status": 429, "reason": "locked"}
    assert (await reg.find_mine(ctx, {"email": BASE["email"], "pin": "123456"}, "ipR")) == {"ok": False, "status": 429, "reason": "locked"}
