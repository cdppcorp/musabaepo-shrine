"""보안 점검 (실시간 · 게시판 신고 · 운영자 잠금 · 설정 경고 · 백업 서명).

  · B-1 IP당 동시 연결은 IPv6 /64로 묶어 세고 기본 4. 자리 비움은 '실제로 한 일'(위치가 바뀐 이동 · 채팅 · 감정 …)로 봄
  · B-2 게시판 글 신고: IP(/64) 해시나 입장 표(sid) 중 하나라도 같으면 같은 사람
  · B-3 ADMIN_IPS가 있으면 서버 전체 로그인 잠금을 쓰지 않음, 운영에서 ADMIN_IPS가 비면 설정 경고
  · B-4 BACKUP_SIGNING_KEY가 있으면 manifest 서명을 넣고 확인
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy import text

from _p2b_util import fresh_ctx
from shrine import admin_auth, backup, moderation
from shrine.config import load_config
from shrine.context import AppContext
from shrine.logic.crypto import TICKET_COOKIE, normalize_ip, sign_ticket
from shrine.logic.util import now_ms
from shrine.logic.world import SPAWN, blocked
from shrine.realtime import board, core, handlers
from shrine.web.net import ip_hash

SECRET = "f3a9c1e07b5d2846af19c3e5d7b02a6e"
DB = "postgresql://shrine:dev@127.0.0.1:5432/shrine"


# ── 설정 ──


def test_ws_default_and_admin_ips_warning():
    assert load_config({"DATABASE_URL": DB}).config.ws_max_per_ip == 4
    assert load_config({"DATABASE_URL": DB, "WS_MAX_PER_IP": "12"}).config.ws_max_per_ip == 12
    prod = {
        "NODE_ENV": "production", "PUBLIC_ORIGIN": "https://shrine.musabaepo.kr", "SHRINE_DOMAIN": "shrine.musabaepo.kr",
        "TICKET_SECRET": SECRET, "TURNSTILE_SITE_KEY": "0x4AAAAAAAbcdEFghIJklmno", "TURNSTILE_SECRET": "0x4AAAAAAAzyXWvuTSrqPONm",
        "CONTACT_EMAIL": "ops@musabaepo.kr", "REDIS_URL": "redis://redis:6379/0",
        "DATABASE_URL": "postgresql://shrine_app:Zq8vK2mW9xR4tY7pL3nB6cH1@pg:5432/shrine", "ADMIN_PASSWORD": "Zq8vK2mW9xR4tY7p",
    }  # fmt: skip
    r = load_config(prod)
    assert not r.fatal and len(r.warnings) == 1 and r.warnings[0].startswith("ADMIN_IPS가 비어 있습니다")
    assert not load_config({**prod, "ADMIN_IPS": "203.0.113.7"}).warnings
    # 운영자 화면이 꺼져 있거나 개발이면 경고하지 않음
    assert not load_config({k: v for k, v in prod.items() if k != "ADMIN_PASSWORD"}).warnings
    assert not load_config({**prod, "NODE_ENV": "development"}).warnings


# ── 운영자 로그인 잠금 ──


async def test_global_lockout_only_without_admin_ips():
    t = 1_000_000_000_000
    for ips, locked in (((), True), (("198.51.100.10",), False)):
        cfg = SimpleNamespace(admin_password="Zq8vK2mW9xR4tY7p", admin_ips=ips, ticket_secret=SECRET)
        ctx = SimpleNamespace(config=cfg)
        # 전체 창은 창이 끝난 뒤 처음 로그인을 시도한 때부터 (web/admin.py는 잠금을 먼저 봄)
        assert not await admin_auth.login_locked(ctx, "ip-0", t)
        for i in range(admin_auth.FAILS_TOTAL):
            await admin_auth.add_login_fail(ctx, f"ip-{i // 5}", t + i)
        assert await admin_auth.login_locked(ctx, "ip-new", t + 100) is locked
        # IP별 잠금(15분 5번)은 ADMIN_IPS와 상관없이 그대로
        assert await admin_auth.login_locked(ctx, "ip-0", t + 100)


# ── 실시간: IP당 연결 (/64) ──


def _rt(monkeypatch) -> core.Realtime:
    cfg = load_config({"DATABASE_URL": DB, "TICKET_SECRET": SECRET}).config
    rt = core.Realtime(AppContext(config=cfg))

    async def not_blocked(*a, **k):
        return False

    async def no_candles():
        return None

    monkeypatch.setattr(moderation, "is_blocked", not_blocked)
    monkeypatch.setattr(rt, "candles_now", no_candles)
    return rt


def _scope(ip: str) -> dict:
    ticket = sign_ticket({"sid": f"s-{ip}", "look": [0] * 12, "nick": "새벽의 러버덕 11", "exp": now_ms() + 3600_000}, SECRET)
    headers = [(b"host", b"shrine.local"), (b"origin", b"http://shrine.local"), (b"cookie", f"{TICKET_COOKIE}={ticket}".encode())]
    return {"headers": headers, "client": (ip, 40000), "query_string": b""}


async def test_ws_per_ip_counts_ipv6_64(monkeypatch):
    rt = _rt(monkeypatch)
    assert rt.config.ws_max_per_ip == 4
    verdicts = [(await rt.admit(_scope(f"2001:db8:1:2::{i:x}")))[0] for i in range(1, 6)]
    assert verdicts == ["ok"] * 4 + ["deny"]
    assert await rt.admit(_scope("2001:db8:1:2:ffff::9")) == ("deny", 429)  # 같은 /64
    assert (await rt.admit(_scope("2001:db8:1:3::1")))[0] == "ok"  # 다른 /64
    assert [(await rt.admit(_scope("192.0.2.7")))[0] for _ in range(5)] == ["ok"] * 4 + ["deny"]
    v6 = ip_hash(normalize_ip("2001:db8:1:2::1") or "")
    assert rt.ip_connections[v6] == 4 and rt.ip_connections[ip_hash("192.0.2.7")] == 4
    # 하나를 놓으면 다시 받음
    rt.release(ip_hash("192.0.2.7"))
    assert (await rt.admit(_scope("192.0.2.7")))[0] == "ok"


# ── 실시간: 자리 비움은 실제로 한 일로 ──


def _free_spot() -> tuple[int, int]:
    for dy in range(0, 60, 2):
        for dx in range(-40, 40, 2):
            x, y = SPAWN["x"] + dx, SPAWN["y"] + dy
            if not blocked(x, y) and not blocked(x + 5, y):
                return x, y
    raise AssertionError("빈자리가 없습니다")


async def test_idle_needs_real_activity():
    assert core.IDLE_MS == 3 * 60_000
    x, y = _free_spot()
    ch = core.Channel(1)
    conn = SimpleNamespace(state=core.OPEN, close=lambda *a: None)
    t = {"sid": "s1", "exp": now_ms() + 3600_000, "look": [0] * 12, "nick": "n"}
    p = core.Player("p1", t, conn, "ipk", "k:x", x, y, ch, now_ms() - 10 * 60_000)  # type: ignore[arg-type]
    ch.players[p.id] = p
    rt = SimpleNamespace(send=lambda p, m: None, broadcast=lambda *a, **k: None, on_handler_error=lambda *a: None)
    old = p.last_active_at

    async def msg(raw: str) -> None:
        await handlers.on_message(rt, p, {"text": raw})  # type: ignore[arg-type]

    # 같은 자리 mv를 되풀이: 입력 시각은 바뀌어도 '한 일'은 아님
    for _ in range(3):
        await msg(f'{{"t":"mv","x":{x},"y":{y},"d":1}}')
    assert p.last_active_at == old and p.last_input_at > old
    # 위치가 바뀌면 한 일
    await msg(f'{{"t":"mv","x":{x + 5},"y":{y},"d":1}}')
    assert p.x == x + 5 and p.last_active_at > old
    # 말풍선 · 감정 · 채팅 같은 것도 한 일. 채널 목록 요청(chans)은 아님
    p.last_active_at = old
    await msg('{"t":"say","k":1}')
    assert p.last_active_at > old
    p.last_active_at = old
    await msg('{"t":"chans"}')
    assert p.last_active_at == old
    assert {"say", "emo", "chat"} <= handlers.ACTIVE_KINDS and "mv" not in handlers.ACTIVE_KINDS


# ── 게시판 글 신고: IP · sid ──


async def test_post_report_counts_ip_or_sid_once(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(board.notify_mod, "notify", lambda ev, f: sent.append(ev))
    async with fresh_ctx(tmp_path, redis_db=13) as ctx:
        post = await board.add_post(ctx, "etc", "글", "새벽의 러버덕 11")
        pid = post["id"]
        assert await board.report_post(ctx, pid, "ipA", "s1") == "ok"  # 1명
        assert await board.report_post(ctx, pid, "ipA", "s2") == "ok"  # 같은 IP: 다시 세지 않음
        assert await board.report_post(ctx, pid, "ipB", "s1") == "ok"  # 같은 표: 다시 세지 않음
        assert await board.report_post(ctx, pid, "ipB", "s2") == "ok"  # 둘 다 처음 → 2명
        assert await board.report_post(ctx, pid, "ipC", None) == "hidden"  # sid 없이(예전 방식) → 3명
        async with ctx.db.engine.connect() as conn:
            rows = [r[0] for r in await conn.execute(text("SELECT reporter FROM post_reports WHERE post_id = :id"), {"id": pid})]
        assert sorted(len(r) for r in rows) == [22, 45, 45]
        assert sent == ["게시판 글 신고", "게시판 글을 신고로 숨김"]
        # 예전 행(IP 쪽 해시만)도 같은 IP로 봅니다
        other = await board.add_post(ctx, "etc", "글2", "n")
        async with ctx.db.engine.begin() as conn:
            await conn.execute(
                text("INSERT INTO post_reports (post_id, reporter) VALUES (:id, :r)"),
                {"id": other["id"], "r": board.reporter_key(other["id"], "ipA")},
            )
        assert await board.report_post(ctx, other["id"], "ipA", "s9") == "ok"
        async with ctx.db.engine.connect() as conn:
            n = (await conn.execute(text("SELECT COUNT(*) FROM post_reports WHERE post_id = :id"), {"id": other["id"]})).scalar_one()
        assert n == 1


# ── 백업 서명 ──


def _tar(d, key: bytes | None, raw: bytes) -> backup.Extracted:
    d.mkdir()
    p = d / "x.tar"
    t = backup.TarWriter(p)
    t.data(backup.MANIFEST, raw, 0)
    if key is not None:
        t.data(backup.SIG_NAME, (backup.sign_manifest(key, raw) + "\n").encode(), 0)
    t.finish()
    (d / "out").mkdir()
    return backup.extract(p, d / "out", False)


def test_backup_manifest_signature(tmp_path, monkeypatch):
    raw = b'{"format": "musabaepo-shrine-backup", "version": 2, "uploads": 0, "uploadBytes": 0, "sha256": {}}\n'
    key = b"k" * 40
    signed = _tar(tmp_path / "a", key, raw)
    unsigned = _tar(tmp_path / "b", None, raw)
    assert signed.manifest_raw == raw and signed.sig and signed.sig.startswith("hmac-sha256:") and not signed.skipped
    monkeypatch.delenv("BACKUP_SIGNING_KEY", raising=False)
    assert backup.compare(signed, {}) == [] and backup.compare(unsigned, {}) == []
    monkeypatch.setenv("BACKUP_SIGNING_KEY", key.decode())
    assert backup.compare(signed, {}) == []
    assert "서명(manifest.sig)이 없습니다" in backup.compare(unsigned, {})[0]
    monkeypatch.setenv("BACKUP_SIGNING_KEY", "z" * 40)
    assert "맞지 않습니다" in backup.compare(signed, {})[0]
    monkeypatch.setenv("BACKUP_SIGNING_KEY", "short")
    with pytest.raises(backup.BackupError):
        backup.compare(signed, {})
