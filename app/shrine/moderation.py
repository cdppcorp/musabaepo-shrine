"""차단 · 강퇴 · 사람 신고 (server/moderation.ts를 옮김). 운영자 API · 운영 명령(P4)과 실시간(realtime)이 같이 씁니다.

차단(block): 입장 표(sid)나 IP 키로 겁니다. 기간이 있고(1분 ~ 90일), 기간이 끝나면 기록을 지웁니다.
  · IP 키 = 'k:' + HMAC(서버 키, 정규화한 IP) 앞 32자 (logic.crypto.block_key). IPv6는 /64로 묶습니다.
    원래 IP는 어디에도 두지 않고, 키도 차단한 사람 것만 차단 기간 동안 DB(blocks)에 둡니다.
  · 서버 키는 TICKET_SECRET에서 만듭니다. TICKET_SECRET을 바꾸면 IP 차단은 모두 풀립니다.
강퇴(kick): 지금 연결을 끊고 그 입장 표를 끝날 때까지 무효로 합니다 (sid 차단, 최대 3시간).
사람 신고: 메모리에만 둡니다 (최대 200건, 24시간). PostgreSQL · Redis에 쓰지 않습니다 (Node와 같음: 다시 띄우면 비어 있음).

차단 목록 사본 (이 프로세스 메모리, ctx마다 하나):
  · 시작할 때 한 번 읽고(start), 10초마다 다시 읽어(refresh_blocks) 바뀌었으면 on_blocks_changed 함수들을 부릅니다.
    Node는 PRAGMA data_version으로 '다른 프로세스가 썼는지'를 봤고, 여기서는 지금 걸린 차단 행 전체(작음)를 읽어 견줍니다.
  · add_block · remove_block은 Redis 채널 ``shrine:pub:blocks:<DB 이름>``에 알립니다. 서버는 다른 프로세스(운영 명령)의
    알림을 받자마자 다시 읽습니다 (Redis가 없거나 끊겨도 10초 갱신으로 반영). 채널은 값을 저장하지 않습니다 (키 · TTL 없음).
  · DB에 못 쓴 차단은 이번 실행 동안만 메모리에 둡니다 (Node memOnly와 같음).

함수 (모두 첫 인자로 ctx = AppContext. config.ticket_secret · db · redis(없어도 됨)를 씀):

| 이름 | 동기/비동기 | 메모 |
|---|---|---|
| ``ModerationError`` · ``BLOCK_MIN_MS`` · ``BLOCK_MAX_MS`` · ``KICK_MAX_MS`` | - | |
| ``normalize_ip(raw)`` | sync | ctx 없음 (logic.crypto) |
| ``block_key(ctx, ip)`` | sync | IP가 아니면 '' |
| ``remember_visitor(ctx, daily_hash, key)`` | sync | 그날 IP 해시 → IP 키 (예비 경로) |
| ``on_blocks_changed(ctx, fn)`` | sync | fn()은 동기 함수 |
| ``refresh_blocks(ctx, force=False) -> bool`` | async | DB |
| ``is_blocked(ctx, ip_key, sid=None) -> bool`` | async | 10초마다 refresh 뒤 메모리 사본. 어떤 오류에도 False |
| ``is_blocked_now(ctx, ip_key, sid=None) -> bool`` | sync | 메모리 사본만 (실시간이 씀) |
| ``add_block(ctx, b) -> dict`` | async | b = {kind?, ipKey?, sid?, ms, nick?, reason?} (Node NewBlock 그대로, 키워드도 받음) |
| ``remove_block(ctx, id) -> dict | None`` | async | |
| ``list_blocks(ctx, limit=500) -> list[dict]`` | async | |
| ``block_counts(ctx) -> {blocks, kicks}`` | async | |
| ``REPORT_REASONS`` · ``is_report_reason(v)`` | - / sync | |
| ``add_user_report(ctx, target, reporter_key, reason, lines)`` | sync | → {id, count, again}. 알림은 보내고 기다리지 않음 |
| ``list_user_reports(ctx, online)`` | sync | online: ``realtime.is_online``(ctx, sid) 또는 (sid) 함수 |
| ``open_report_count(ctx)`` · ``open_reports_for(ctx, sid)`` | sync | |
| ``find_user_report(ctx, id)`` · ``close_user_report(ctx, id, state)`` · ``close_reports_for(ctx, sid, state)`` | sync | |
| ``start(ctx)`` · ``stop(ctx)`` | async | 서버만: 처음 읽기 + Redis 알림 받기 (web/ws.py install이 겁니다) |

차단 한 줄(BlockView) = {id, at, until, kind, byIp, bySid, tag, nick, reason} (Node와 같은 키 순서. IP 키 원문 없음).
신고 대상(ReportTarget) = {pid, sid, ipKey, nick, channel, exp}. sid · ipKey는 운영자 화면에도 내보내지 않습니다.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import math
import re
import secrets
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from sqlalchemy import text

from . import notify as notify_mod
from .logic.crypto import KEY_RE, ip_key_mac
from .logic.crypto import block_key as _block_key
from .logic.crypto import normalize_ip as _normalize_ip
from .logic.jsnum import is_number, js_round, number_to_string
from .logic.jsstr import canonical, js_trim, slice_units
from .logic.util import kst_date, now_ms

if TYPE_CHECKING:
    from .context import AppContext

__all__ = [
    "BLOCK_MAX_MS", "BLOCK_MIN_MS", "KICK_MAX_MS", "REPORT_REASONS", "ModerationError", "add_block", "add_user_report",
    "block_counts", "block_key", "close_reports_for", "close_user_report", "find_user_report", "is_blocked",
    "is_blocked_now", "is_report_reason", "list_blocks", "list_user_reports", "normalize_ip", "on_blocks_changed",
    "open_report_count", "open_reports_for", "refresh_blocks", "remember_visitor", "remove_block", "start", "stop",
]  # fmt: skip

log = logging.getLogger("shrine.moderation")

BLOCK_MIN_MS = 60_000
BLOCK_MAX_MS = 90 * 24 * 3600_000
#: 입장 표 수명(3시간)과 같음. 강퇴는 이보다 길 필요가 없습니다
KICK_MAX_MS = 3 * 3600_000
REASON_MAX = 80
REFRESH_MS = 10_000
PRUNE_MS = 3600_000
SID_RE = re.compile(r"[A-Za-z0-9_:-]{8,64}")
_CONTROL = re.compile("[\u0000-\u001f\u007f]")


class ModerationError(Exception):
    """대상이 없거나 기간 · IP 형식이 틀린 차단 (운영자 API는 400 rule, 운영 명령은 1로 끝냄)."""


# ── IP 키 ────────────────────────────────────────────────────────────


def normalize_ip(raw: str) -> str | None:
    """비교용 IP 모양: IPv4는 그대로, IPv6에 담긴 IPv4는 IPv4로, IPv6는 /64 대역으로. IP가 아니면 None."""
    return _normalize_ip(raw)


def block_key(ctx: AppContext, ip: str) -> str:
    """차단용 IP 키 ('k:' + 32자). IP가 아니면 ''."""
    return _block_key(ip, key_mac=_state(ctx).key_mac)


# ── 상태 (ctx마다) ───────────────────────────────────────────────────


@dataclass
class _Report:
    id: int
    at: int
    last: int
    target: dict[str, Any]
    reporters: set[str] = field(default_factory=set)
    #: 사유 → 신고 수 (넣은 순서대로, Node Map과 같음)
    reasons: dict[str, int] = field(default_factory=dict)
    lines: list[dict[str, Any]] = field(default_factory=list)
    state: str = "open"


class _State:
    def __init__(self, ctx: AppContext) -> None:
        self.key_mac = ip_key_mac(ctx.config.ticket_secret)
        self.by_ip: dict[str, int] = {}
        self.by_sid: dict[str, int] = {}
        #: DB에 못 쓴 차단 (이번 실행 동안만)
        self.mem_only: list[dict[str, Any]] = []
        self.loaded = False
        #: 지난번에 읽은 행들 (Node seenVersion 자리: 바뀌었는지 견줌)
        self.seen: frozenset[tuple[Any, ...]] | None = None
        self.checked_at = 0
        self.pruned_at = 0
        self.listeners: list[Callable[[], None]] = []
        #: 읽기 · 쓰기가 서로 끼어들지 않게 (Node는 DB가 동기라 저절로 그랬음)
        self.lock = asyncio.Lock()
        self.daily_keys: dict[str, str] = {}
        self.daily_day = ""
        self.reports: list[_Report] = []
        self.report_seq = 0
        #: Redis 알림 (서버만 받음)
        self.channel = _pub_channel(ctx)
        self.token = secrets.token_hex(8)
        self.listener: asyncio.Task | None = None
        self.warned_at = 0.0


def _state(ctx: AppContext) -> _State:
    st = ctx.__dict__.get("_moderation")
    if st is None:
        st = _State(ctx)
        ctx.__dict__["_moderation"] = st
    return st


def _pub_channel(ctx: AppContext) -> str:
    """같은 DB를 쓰는 서버 · 운영 명령끼리만 알림을 주고받는 Redis 채널 이름 (Redis pub/sub은 DB 번호와 상관없이 하나)."""
    name = "-"
    try:
        from sqlalchemy.engine import make_url

        name = make_url(ctx.config.database_url).database or "-"
    except Exception:  # noqa: BLE001
        pass
    return f"shrine:pub:blocks:{name}"


# ── 그날 해시 → IP 키 (예비 경로, 메모리에만) ───────────────────────


def remember_visitor(ctx: AppContext, daily_hash: str, key: str) -> None:
    """실시간이 WebSocket 업그레이드 때 알려 줍니다 (그날 해시와 IP 키를 같이 아는 곳)."""
    if not daily_hash or not key:
        return
    st = _state(ctx)
    day = kst_date()
    if day != st.daily_day or len(st.daily_keys) > 20_000:
        st.daily_keys.clear()
        st.daily_day = day
    st.daily_keys[daily_hash] = key


def _to_key(ctx: AppContext, v: Any) -> str:
    """넘겨받은 값을 IP 키로: IP 키면 그대로, 원래 IP면 바꾸고, 그날 해시면 오늘 본 것만."""
    if not v:
        return ""
    if not isinstance(v, str):
        # Node는 글자가 아니면 normalizeIp에서 TypeError (운영자 API 500). 여기서는 형식 오류로
        raise ModerationError("IP 주소 형식이 아닙니다")
    if KEY_RE.fullmatch(v):
        return v
    from_ip = block_key(ctx, v)
    if from_ip:
        return from_ip
    st = _state(ctx)
    return st.daily_keys.get(v, "") if st.daily_day == kst_date() else ""


# ── 차단 목록 (메모리 사본 + DB) ─────────────────────────────────────


def on_blocks_changed(ctx: AppContext, fn: Callable[[], None]) -> None:
    """차단이 바뀌면(이 서버에서든 운영 명령에서든) fn()을 부릅니다. 실시간이 접속 중인 사람을 다시 봅니다."""
    _state(ctx).listeners.append(fn)


def _changed(st: _State) -> None:
    for fn in list(st.listeners):
        try:
            fn()
        except Exception:  # noqa: BLE001
            log.exception("[shrine] 차단 반영 실패:")


def _put(m: dict[str, int], key: str, until: int) -> None:
    if key and until > m.get(key, 0):
        m[key] = until


def _signature(rows: list[Mapping[str, Any]]) -> frozenset[tuple[Any, ...]]:
    return frozenset((int(r["id"]), r["ip_key"], r["sid"], int(r["until"])) for r in rows)


def _load(st: _State, rows: list[Mapping[str, Any]], now: int) -> None:
    st.by_ip.clear()
    st.by_sid.clear()
    for r in rows:
        _put(st.by_ip, r["ip_key"], int(r["until"]))
        _put(st.by_sid, r["sid"], int(r["until"]))
    st.mem_only = [m for m in st.mem_only if m["until"] > now]
    for m in st.mem_only:
        _put(st.by_ip, m["ip_key"], m["until"])
        _put(st.by_sid, m["sid"], m["until"])
    st.loaded = True


_ACTIVE = text("SELECT id, ip_key, sid, until FROM blocks WHERE until > :now")
_PRUNE = text("DELETE FROM blocks WHERE until <= :now")


async def refresh_blocks(ctx: AppContext, force: bool = False) -> bool:
    """DB에서 지금 걸린 차단을 다시 읽습니다. 10초에 한 번만 봅니다 (force면 바로). 바뀌었으면 True + 알림.

    DB가 안 되면 지금 메모리 사본을 그대로 씁니다 (로그 한 줄).
    """
    st = _state(ctx)
    now = now_ms()
    if not force and now - st.checked_at < REFRESH_MS:
        return False
    st.checked_at = now
    try:
        if ctx.db is None:
            raise RuntimeError("DB가 없습니다")
        async with st.lock:
            async with ctx.db.engine.begin() as conn:
                if now - st.pruned_at >= PRUNE_MS:
                    st.pruned_at = now
                    await conn.execute(_PRUNE, {"now": now})
                rows = list((await conn.execute(_ACTIVE, {"now": now})).mappings().all())
            seen = _signature(rows)
            if not force and st.loaded and seen == st.seen:
                return False
            st.seen = seen
            _load(st, rows, now)
    except Exception as e:  # noqa: BLE001
        log.error("[shrine] 차단 목록을 다시 읽지 못했습니다 (지금 목록을 계속 씁니다): %s", short_error(e))
        return False
    _changed(st)
    return True


def is_blocked_now(ctx: AppContext, ip_key: str | None, sid: str | None = None) -> bool:
    """메모리 사본만 보고 판정 (DB를 보지 않음). ip_key: 원래 IP · 차단 키 · (예비로) 그날 해시."""
    try:
        st = _state(ctx)
        now = now_ms()
        if sid and st.by_sid.get(sid, 0) > now:
            return True
        key = _to_key(ctx, ip_key)
        return bool(key) and st.by_ip.get(key, 0) > now
    except Exception:  # noqa: BLE001
        return False


async def is_blocked(ctx: AppContext, ip_key: str | None, sid: str | None = None) -> bool:
    """막힌 사람인지 (moderation.ts isBlocked). 요청마다 불러도 됩니다. 어떤 경우에도 예외를 올리지 않습니다."""
    try:
        await refresh_blocks(ctx)
    except Exception:  # noqa: BLE001
        return False
    return is_blocked_now(ctx, ip_key, sid)


def _clean_reason(raw: Any) -> str:
    """제어 문자 → 빈칸, 앞뒤 공백 빼고, 코드 포인트 80개까지 ([...s].slice(0, 80))."""
    if not isinstance(raw, str):
        return ""
    return canonical(js_trim(_CONTROL.sub(" ", raw)))[:REASON_MAX]


def _tag_of(ip_key: str, sid: str) -> str:
    if ip_key:
        return f"ip {ip_key[2:8]}"
    if sid:
        return f"표 {slice_units(sid, 0, 8)}"
    return "-"


def _view(r: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": int(r["id"]), "at": int(r["at"]), "until": int(r["until"]), "kind": r["kind"], "byIp": bool(r["ip_key"]),
        "bySid": bool(r["sid"]), "tag": _tag_of(r["ip_key"], r["sid"]), "nick": r["nick"], "reason": r["reason"],
    }  # fmt: skip


_INSERT = text(
    """INSERT INTO blocks (at, until, kind, ip_key, sid, nick, reason)
       VALUES (:at, :until, :kind, :ip_key, :sid, :nick, :reason) RETURNING id"""
)


async def add_block(ctx: AppContext, b: Mapping[str, Any] | None = None, /, **kw: Any) -> dict[str, Any]:
    """차단 · 강퇴 기록 (moderation.ts addBlock). b = {kind?, ipKey?, sid?, ms, nick?, reason?} (키워드 ip_key=도 받음).

    대상이 없거나 기간이 틀리면 ModerationError. DB에 못 쓰면 이번 실행 동안만 막습니다 (id 0).
    """
    spec: dict[str, Any] = dict(b or {})
    if "ip_key" in kw:
        kw["ipKey"] = kw.pop("ip_key")
    spec.update(kw)
    st = _state(ctx)
    kind = "kick" if spec.get("kind") == "kick" else "block"
    raw_ip = spec.get("ipKey")
    ip_key = "" if kind == "kick" else _to_key(ctx, raw_ip)
    if raw_ip and kind == "block" and not ip_key:
        raise ModerationError("IP 주소 형식이 아닙니다")
    raw_sid = spec.get("sid")
    sid = raw_sid if isinstance(raw_sid, str) and SID_RE.fullmatch(raw_sid) else ""
    if not ip_key and not sid:
        raise ModerationError("막을 대상(IP나 입장 표)이 없습니다")
    limit = KICK_MAX_MS if kind == "kick" else BLOCK_MAX_MS
    ms = spec.get("ms")
    if not is_number(ms) or not math.isfinite(ms) or ms < BLOCK_MIN_MS or ms > limit:
        raise ModerationError(f"기간은 1분부터 {'3시간' if kind == 'kick' else '90일'}까지입니다")
    at = now_ms()
    until = at + int(js_round(ms))
    nick = slice_units(_clean_reason(spec.get("nick")), 0, 40)
    reason = _clean_reason(spec.get("reason"))
    new_id = 0
    async with st.lock:
        _put(st.by_ip, ip_key, until)
        _put(st.by_sid, sid, until)
        try:
            if ctx.db is None:
                raise RuntimeError("DB가 없습니다")
            async with ctx.db.engine.begin() as conn:
                row = await conn.execute(
                    _INSERT, {"at": at, "until": until, "kind": kind, "ip_key": ip_key, "sid": sid, "nick": nick, "reason": reason}
                )
                new_id = int(row.scalar_one())
        except Exception as e:  # noqa: BLE001
            st.mem_only.append({"ip_key": ip_key, "sid": sid, "until": until})
            log.error("[shrine] 차단을 DB에 남기지 못했습니다 (서버를 다시 띄우기 전까지만 막습니다): %s", short_error(e))
    _changed(st)
    await _publish(ctx)
    return _view({"id": new_id, "at": at, "until": until, "kind": kind, "ip_key": ip_key, "sid": sid, "nick": nick, "reason": reason})


async def remove_block(ctx: AppContext, block_id: int) -> dict[str, Any] | None:
    """차단 풀기. 없으면 None (DB 오류는 그대로 올림)."""
    st = _state(ctx)
    assert ctx.db is not None
    async with st.lock:
        async with ctx.db.engine.begin() as conn:
            row = (await conn.execute(text("SELECT * FROM blocks WHERE id = :id"), {"id": block_id})).mappings().first()
            if row is None:
                return None
            await conn.execute(text("DELETE FROM blocks WHERE id = :id"), {"id": block_id})
            now = now_ms()
            rows = list((await conn.execute(_ACTIVE, {"now": now})).mappings().all())
        st.seen = _signature(rows)
        _load(st, rows, now)
        view = _view(row)
    _changed(st)
    await _publish(ctx)
    return view


async def list_blocks(ctx: AppContext, limit: int = 500) -> list[dict[str, Any]]:
    """지금 걸려 있는 차단 · 강퇴 (새것부터)."""
    assert ctx.db is not None
    async with ctx.db.engine.connect() as conn:
        rows = (
            await conn.execute(
                text("SELECT * FROM blocks WHERE until > :now ORDER BY id DESC LIMIT :limit"), {"now": now_ms(), "limit": limit}
            )
        ).mappings().all()
    return [_view(r) for r in rows]


async def block_counts(ctx: AppContext) -> dict[str, int]:
    """운영자 화면 요약 {blocks, kicks}."""
    assert ctx.db is not None
    async with ctx.db.engine.connect() as conn:
        r = (
            await conn.execute(
                text(
                    """SELECT COALESCE(SUM(CASE WHEN kind = 'block' THEN 1 ELSE 0 END), 0) AS block,
                              COALESCE(SUM(CASE WHEN kind = 'kick' THEN 1 ELSE 0 END), 0) AS kick
                         FROM blocks WHERE until > :now"""
                ),
                {"now": now_ms()},
            )
        ).one()
    return {"blocks": int(r.block), "kicks": int(r.kick)}


# ── 다른 프로세스와 알림 (Redis 채널) ────────────────────────────────


async def _publish(ctx: AppContext) -> None:
    """차단이 바뀌었다고 같은 DB를 쓰는 서버에 알립니다 (실패해도 10초 갱신이 있으니 로그만)."""
    client = getattr(ctx, "redis", None)
    if client is None:
        return
    st = _state(ctx)
    try:
        await asyncio.wait_for(client.publish(st.channel, st.token), 3)
    except Exception as e:  # noqa: BLE001
        _warn(st, f"[shrine] 차단 바뀜을 Redis로 알리지 못했습니다 (10초 안에 반영됩니다): {short_error(e)}")


async def _listen(ctx: AppContext) -> None:
    st = _state(ctx)
    while True:
        ps = None
        try:
            assert ctx.redis is not None
            ps = ctx.redis.pubsub(ignore_subscribe_messages=True)
            await ps.subscribe(st.channel)
            while True:
                msg = await ps.get_message(ignore_subscribe_messages=True, timeout=5.0)
                if msg is None or msg.get("type") != "message":
                    continue
                data = msg.get("data")
                if isinstance(data, bytes):
                    data = data.decode("latin-1")
                if data != st.token:
                    await refresh_blocks(ctx, force=True)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            _warn(st, f"[shrine] 차단 알림(Redis)을 받지 못하고 있습니다 (10초 갱신으로 반영): {short_error(e)}")
            await asyncio.sleep(5)
        finally:
            if ps is not None:
                try:
                    await ps.aclose()
                except Exception:  # noqa: BLE001
                    pass


async def start(ctx: AppContext) -> None:
    """서버 시작 때: 차단 목록을 한 번 읽고(moderation.ts 맨 끝 refreshBlocks(true)) Redis 알림을 받기 시작합니다."""
    st = _state(ctx)
    await refresh_blocks(ctx, force=True)
    if ctx.redis is not None and st.listener is None:
        st.listener = asyncio.create_task(_listen(ctx), name="shrine:blocks-listen")


async def stop(ctx: AppContext) -> None:
    st = _state(ctx)
    task, st.listener = st.listener, None
    if task is not None:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


def _warn(st: _State, msg: str) -> None:
    now = time.monotonic()
    if now - st.warned_at > 60:
        st.warned_at = now
        log.warning("%s", msg)


def short_error(e: BaseException) -> str:
    """예외 한 줄 (SQLAlchemy 예외면 SQL 문장 · 매개변수는 빼고 DB 드라이버의 글만)."""
    orig = getattr(e, "orig", None)
    if orig is not None:
        return f"{type(e).__name__} ({type(orig).__name__}): {orig}".split("\n", 1)[0]
    return f"{type(e).__name__}: {e}".split("\n", 1)[0]


# ── 사람 신고 (메모리에만) ───────────────────────────────────────────

REPORT_REASONS: dict[str, str] = {
    "abuse": "욕설 · 괴롭힘",
    "spam": "도배 · 광고",
    "lewd": "음란 · 불쾌한 말",
    "other": "기타",
}
REPORT_KEEP_MS = 24 * 3600_000
REPORT_MAX = 200
LINES_MAX = 8
#: 서로 다른 사람이 이만큼 신고하면 한 번 더 알립니다
REPORT_ALERT_AT = 3


def is_report_reason(v: Any) -> bool:
    return isinstance(v, str) and v in REPORT_REASONS


def _prune_reports(st: _State, now: int) -> None:
    st.reports = [r for r in st.reports if now - r.last <= REPORT_KEEP_MS]
    if len(st.reports) > REPORT_MAX:
        del st.reports[: len(st.reports) - REPORT_MAX]


def add_user_report(
    ctx: AppContext, target: Mapping[str, Any], reporter_key: str, reason: str, lines: list[Mapping[str, Any]]
) -> dict[str, Any]:
    """사람 신고 받기. 같은 대상(입장 표)의 열린 신고에 합칩니다. reporter_key는 신고한 사람 구분용 (그날 IP 해시)."""
    st = _state(ctx)
    now = now_ms()
    _prune_reports(st, now)
    r = next((x for x in st.reports if x.state == "open" and x.target["sid"] == target["sid"]), None)
    if r is None:
        st.report_seq += 1
        r = _Report(id=st.report_seq, at=now, last=now, target=dict(target))
        st.reports.append(r)
    again = reporter_key in r.reporters
    r.last = now
    r.target = dict(target)
    for line in lines:
        if not any(x["at"] == line["at"] and x["s"] == line["s"] for x in r.lines):
            r.lines.append({"at": line["at"], "s": line["s"]})
    r.lines.sort(key=lambda x: x["at"])
    if len(r.lines) > LINES_MAX:
        del r.lines[: len(r.lines) - LINES_MAX]
    if not again:
        r.reporters.add(reporter_key)
        r.reasons[reason] = r.reasons.get(reason, 0) + 1
        count = len(r.reporters)
        if count in (1, REPORT_ALERT_AT):
            # 말풍선 내용 · IP · 입장 표는 넣지 않습니다
            notify_mod.notify(
                "접속자 신고" if count == 1 else "접속자 신고 누적",
                {"대상": target["nick"], "채널": f"{_js(target['channel'])}번", "사유": REPORT_REASONS[reason],
                 "신고한_사람": f"{count}명", "신고_번호": f"#{r.id}"},
            )  # fmt: skip
    return {"id": r.id, "count": len(r.reporters), "again": again}


def _call_online(ctx: AppContext, online: Callable[..., Any], sid: str) -> bool:
    try:
        params = list(inspect.signature(online).parameters)
    except (TypeError, ValueError):
        params = []
    return bool(online(ctx, sid) if params and params[0] == "ctx" else online(sid))


def list_user_reports(ctx: AppContext, online: Callable[..., Any]) -> list[dict[str, Any]]:
    """운영자 화면용 신고 목록 (열린 것 먼저, 새것부터). online은 sid로 접속 중인지 (realtime.is_online)."""
    st = _state(ctx)
    _prune_reports(st, now_ms())
    ordered = sorted(st.reports, key=lambda r: (r.state != "open", -r.last))
    return [
        {
            "id": r.id, "at": r.at, "last": r.last, "state": r.state,
            "nick": r.target["nick"], "channel": r.target["channel"], "pid": r.target["pid"],
            "online": _call_online(ctx, online, r.target["sid"]),
            "count": len(r.reporters),
            "reasons": [{"key": k, "label": REPORT_REASONS[k], "n": n} for k, n in r.reasons.items()],
            "lines": [{"at": x["at"], "s": x["s"]} for x in r.lines],
        }
        for r in ordered
    ]  # fmt: skip


def open_report_count(ctx: AppContext) -> int:
    return sum(1 for r in _state(ctx).reports if r.state == "open")


def open_reports_for(ctx: AppContext, sid: str) -> int:
    """같은 입장 표에 열린 신고 수 (접속자 목록 표시용)."""
    r = next((x for x in _state(ctx).reports if x.state == "open" and x.target["sid"] == sid), None)
    return len(r.reporters) if r is not None else 0


def find_user_report(ctx: AppContext, report_id: Any) -> dict[str, Any] | None:
    """신고 하나 {target, state} (운영자가 차단할 때 대상 정보를 씀). 없으면 None."""
    r = next((x for x in _state(ctx).reports if x.id == report_id), None)
    return {"target": dict(r.target), "state": r.state} if r is not None else None


def close_user_report(ctx: AppContext, report_id: Any, state: str) -> bool:
    """신고 닫기 (dismissed · kicked · blocked). 없으면 False."""
    r = next((x for x in _state(ctx).reports if x.id == report_id), None)
    if r is None:
        return False
    r.state = state
    return True


def close_reports_for(ctx: AppContext, sid: str, state: str) -> None:
    """같은 입장 표의 열린 신고를 모두 닫습니다 (운영자가 접속자 목록에서 강퇴 · 차단했을 때)."""
    for r in _state(ctx).reports:
        if r.state == "open" and r.target["sid"] == sid:
            r.state = state


def _js(v: Any) -> str:
    return number_to_string(v) if is_number(v) else str(v)
