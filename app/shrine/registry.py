"""내 프로젝트 등록소 (server/registry.ts): 접수 · 접수 코드 · 이메일+PIN 찾기 · 관리(보기/고치기/내리기) ·
운영자 승인/반려 · 보관 기간(만료 · 파기) · 운영자 화면 목록.

응답 모양 · 실패 까닭 · 검사 순서 · 메시지 글자는 Node와 같습니다. 달라진 것은 동시에 들어오는 요청을 다루는 방법뿐입니다:

  · Node는 DB 호출이 동기라 한 요청의 여러 문장 사이에 다른 요청이 끼지 않았습니다. 여기서는
    승인 · 반려 · 내리기 · 고치기(쓰기) · 파기 · 하루 PIN 잠금 증가를 모두 트랜잭션 하나로, 그 접수 행은 FOR UPDATE로 잡습니다.
  · 사당 자리는 UNIQUE(channel, plot), slug는 기본 키, 도메인은 UNIQUE로 막고, 같은 자리 · 같은 slug로 동시에 승인하면
    한쪽은 다시 고르거나(자동 자리 · slug) 실패합니다(운영자가 정한 자리: '이미 사당이 있는 자리입니다').
  · 같은 링크 중복 검사(dup)는 접수 · 링크 변경의 마지막 쓰기 직전에 advisory lock 안에서 한 번 더 봅니다
    (동시에 같은 저장소로 접수하면 하나만 들어감).
  · PIN 확인은 같은 IP · 같은 접수(또는 이메일)끼리 차례로 합니다 (Node는 scrypt가 동기라 전체가 차례로였음).
    그래서 동시에 여러 번 보내도 5번 · 30번 · 20번 한도를 넘지 못합니다. scrypt는 스레드에서 돕니다.

Node 메모리 → Redis (모두 만료가 붙음, IP는 그날 해시, 이메일은 서버 키로 만든 HMAC으로만):
  shrine:reg:last:<sid>                 접수 2분에 하나 (PX = 남은 시간)
  shrine:reg:ipday:<KST날짜>:<IP해시>    IP당 하루 접수 3개 (PX 26h)
  shrine:reg:pinfail:<접수번호>          HASH {n, until} 접수별 5번 틀리면 15분 잠금 (PX 1h · 잠금 15분)
  shrine:reg:mailfail:<HMAC(이메일)>      HASH {n, until} 이메일+PIN 찾기 5번 → 15분 (PX 1h · 잠금 15분)
  shrine:reg:pinip:<KST날짜>:<IP해시>    IP당 하루 PIN 틀림 30번 (PX 26h)
하루 20번 → 24시간 잠금은 DB(pin_locks)에 둡니다 (다시 띄워도 남음).
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import math
import re
import secrets
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from . import notify as notify_mod
from .github import check_github_for
from .logic.chat import clean_sign, clean_text
from .logic.crypto import hash_pin, pin_matches
from .logic.jsnum import is_integer, json_stringify, number_to_string
from .logic.jsstr import JS_WS, js_trim, slice_units, utf8_encode
from .logic.links import (
    CATEGORY_KEYS,
    clean_email,
    domain_of,
    normalize_service_url,
    parse_github,
    read_links,
    slugify,
    unique_slug,
    validate_shrine,
)
from .logic.util import kst_date, now_ms
from .logic.world import CHANNELS, PLOTS, is_channel
from .redis import key
from .shrines import free_plots_in, insert_shrine, invalidate_after_commit, plot_taken
from .uploads import grant_upload_view, owns_upload

log = logging.getLogger("shrine.registry")

NAME_MAX = 20
TAGLINE_MAX = 40
#: 새로 정하는 PIN · 확인할 때 받는 PIN: 숫자 4~12자리 (JS \d는 ASCII 숫자만)
NEW_PIN_RE = re.compile(r"[0-9]{4,12}")
PIN_RE = NEW_PIN_RE
CODE_RE = re.compile(r"[A-Za-z0-9_-]{16,32}")
SUBMIT_GAP_MS = 2 * 60_000
SUBMITS_PER_DAY = 3
PIN_TRIES = 5
PIN_LOCK_MS = 15 * 60_000
PIN_FAILS_PER_DAY = 30
PIN_FAILS_PER_PROJECT_DAY = 20
PIN_DAY_LOCK_MS = 24 * 3600_000
#: 틀린 횟수 기록의 수명 (Node는 1시간마다 잠금이 없는 기록을 지웠음)
FAIL_TTL_MS = 3600_000
DAY_KEY_TTL_MS = 26 * 3600_000
BIGINT_MAX = 2**63 - 1
#: 링크 중복 검사 + 쓰기를 한 줄로 세우는 advisory lock 번호 ('SHRL')
LINKS_LOCK_ID = 0x5348_524C

ALL_CHANNELS = list(range(1, CHANNELS + 1))

PROJECT_STATUSES = ("pending", "approved", "rejected", "withdrawn")


class RegistryError(Exception):
    """운영 도구 · 운영자 화면에 그대로 보여 주는 한국어 메시지 (Node의 throw new Error(…))."""


def fail(status: int, reason: str) -> dict[str, Any]:
    return {"ok": False, "status": status, "reason": reason}


def is_fail(v: Any) -> bool:
    return isinstance(v, dict) and v.get("ok") is False


# ── JS 값 변환 ──────────────────────────────────────────────────────

_DEC = re.compile(r"[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_HEX = re.compile(r"0[xX][0-9a-fA-F]+")
_OCT = re.compile(r"0[oO][0-7]+")
_BIN = re.compile(r"0[bB][01]+")


def _string_to_number(s: str) -> float:
    t = s.strip(JS_WS)
    if not t:
        return 0.0
    if t in ("Infinity", "+Infinity"):
        return math.inf
    if t == "-Infinity":
        return -math.inf
    if _HEX.fullmatch(t):
        return float(int(t[2:], 16))
    if _OCT.fullmatch(t):
        return float(int(t[2:], 8))
    if _BIN.fullmatch(t):
        return float(int(t[2:], 2))
    if _DEC.fullmatch(t):
        return float(t)
    return math.nan


def _js_to_string_for_number(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return number_to_string(v)
    if isinstance(v, list):
        return ",".join(_js_to_string_for_number(x) for x in v)
    return "[object Object]"


def js_to_number(v: Any) -> float | int:
    """JS ``Number(v)`` (JSON에서 온 값). None은 JSON null로 봅니다 (0)."""
    if v is None:
        return 0
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str):
        return _string_to_number(v)
    if isinstance(v, list):
        return _string_to_number(_js_to_string_for_number(v))
    return math.nan


def to_id(raw: Any) -> int | None:
    """``Number(raw)``가 양의 정수면 그 수 (PostgreSQL BIGINT를 넘으면 없는 번호로)."""
    n = js_to_number(raw)
    if not is_integer(n) or n <= 0 or n > BIGINT_MAX:
        return None
    return int(n)


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


# ── 접수 행 ─────────────────────────────────────────────────────────


def link_change(r: dict) -> bool:
    return r["pending_github"] is not None or r["pending_url"] is not None


def text_change(r: dict) -> bool:
    return r["pending_name"] is not None or r["pending_tagline"] is not None or r["pending_sign"] is not None


def has_change(r: dict) -> bool:
    """맵에 오른 사당에 검토를 기다리는 변경이 있는지."""
    return link_change(r) or text_change(r) or r["pending_screen"] is not None


def wish_channel(r: dict) -> int | None:
    """작성자가 고른 채널 (None = 아무 채널). 자리만 골라 둔 예전 접수는 1번 채널로."""
    if r.get("want_channel") is not None:
        return r["want_channel"]
    return 1 if r.get("want_plot") is not None else None


def _nz(v: Any, d: Any) -> Any:
    return d if v is None else v


def view(r: dict) -> dict[str, Any]:
    """지금 반영된 값 + 검토를 기다리는 값. PIN 해시 · 접수 코드 · 닉네임은 빼고."""
    return {
        "id": r["id"], "status": r["status"], "name": r["name"], "tagline": r["tagline"], "sign": _nz(r["sign"], ""),
        "category": r["category"], "github": r["github"], "url": r["url"], "email": r["email"],
        "emailPublic": r["email_public"] == 1, "slug": r["slug"],
        "pendingGithub": r["pending_github"], "pendingUrl": r["pending_url"],
        "pendingName": r["pending_name"], "pendingTagline": r["pending_tagline"], "pendingSign": r["pending_sign"],
        "note": r["note"], "screen": _nz(r["screen"], ""), "pendingScreen": r["pending_screen"], "wantPlot": r["want_plot"],
        "wantChannel": wish_channel(r),
    }  # fmt: skip


def owner_view(r: dict) -> dict[str, Any]:
    """작성자에게 돌려주는 모양: 고칠 칸에는 검토를 기다리는 값이 있으면 그 값 (키 자리는 view 그대로)."""
    out = view(r)
    links = link_change(r)
    out["name"] = _nz(r["pending_name"], r["name"])
    out["tagline"] = _nz(r["pending_tagline"], r["tagline"])
    out["sign"] = r["pending_sign"] if r["pending_sign"] is not None else _nz(r["sign"], "")
    out["github"] = _nz(r["pending_github"], "") if links else r["github"]
    out["url"] = _nz(r["pending_url"], "") if links else r["url"]
    return out


def change_kinds(r: dict) -> list[str]:
    kinds = []
    if text_change(r):
        kinds.append("글자")
    if r["pending_screen"] is not None:
        kinds.append("이미지")
    if link_change(r):
        kinds.append("링크")
    return kinds


async def _get_row(s: AsyncSession, pid: int, *, lock: bool = False) -> dict | None:
    sql = "SELECT * FROM projects WHERE id = :id" + (" FOR UPDATE" if lock else "")
    row = (await s.execute(text(sql), {"id": pid})).mappings().first()
    return dict(row) if row is not None else None


async def get_row(ctx, pid: int) -> dict | None:
    async with ctx.db.session() as s:
        return await _get_row(s, pid)


# ── 차례 세우기 (같은 IP · 같은 접수의 PIN 확인) ──────────────────────


class KeyedLocks:
    """이름별 asyncio 잠금. 아무도 쓰지 않으면 지웁니다 (프로세스 하나 = uvicorn 워커 1개)."""

    def __init__(self) -> None:
        self._locks: dict[str, list] = {}

    @asynccontextmanager
    async def hold(self, name: str) -> AsyncIterator[None]:
        entry = self._locks.get(name)
        if entry is None:
            entry = self._locks[name] = [asyncio.Lock(), 0]
        entry[1] += 1
        try:
            async with entry[0]:
                yield
        finally:
            entry[1] -= 1
            if entry[1] == 0 and self._locks.get(name) is entry:
                del self._locks[name]


_locks = KeyedLocks()


# ── Redis 키 ────────────────────────────────────────────────────────


def _last_key(sid: str) -> str:
    return key("reg", "last", sid or "-")


def _submit_ip_key(day: str, ip_key: str) -> str:
    return key("reg", "ipday", day, ip_key or "-")


def _pin_fail_key(pid: int) -> str:
    return key("reg", "pinfail", str(pid))


def _pin_ip_key(day: str, ip_key: str) -> str:
    return key("reg", "pinip", day, ip_key or "-")


def _mail_key(ctx, email: str) -> str:
    secret = ctx.config.ticket_secret
    mac = hmac.new(utf8_encode(secret), b"shrine-email\0" + utf8_encode(email), hashlib.sha256).digest()
    return key("reg", "mailfail", _b64url(mac)[:22])


async def _get_fail(r, k: str) -> tuple[int, int] | None:
    v = await r.hgetall(k)
    if not v:
        return None
    return int(v.get(b"n", 0)), int(v.get(b"until", 0))


async def _set_fail(r, k: str, n: int, until: int, now: int) -> None:
    ttl = until - now if until > now else FAIL_TTL_MS
    async with r.pipeline(transaction=True) as p:
        p.delete(k)
        p.hset(k, mapping={"n": n, "until": until})
        p.pexpire(k, max(1, ttl))
        await p.execute()


async def _incr_day(r, k: str) -> None:
    async with r.pipeline(transaction=True) as p:
        p.incr(k)
        p.pexpire(k, DAY_KEY_TTL_MS)
        await p.execute()


async def _count(r, k: str) -> int:
    v = await r.get(k)
    return int(v) if v is not None else 0


# ── PIN ─────────────────────────────────────────────────────────────


_dummy_hash: str | None = None


def _dummy_pin_hash() -> str:
    """없는 이메일도 같은 시간이 걸리게 대신 맞춰 보는 해시."""
    global _dummy_hash
    if _dummy_hash is None:
        _dummy_hash = hash_pin("000000")
    return _dummy_hash


async def _day_locked(s: AsyncSession, pid: int, now: int) -> bool:
    r = await s.execute(text("SELECT until FROM pin_locks WHERE project_id = :id"), {"id": pid})
    row = r.first()
    return row is not None and row[0] > now


async def _add_day_fail(ctx, pid: int, now: int) -> bool:
    """그날 틀린 횟수를 하나 올리고(한 문장 · 행 잠금), 20번이 되면 24시간 잠급니다. 잠갔으면 True."""
    day = kst_date(now)
    async with ctx.db.begin() as s:
        fails = (
            await s.execute(
                text(
                    """INSERT INTO pin_locks AS p (project_id, day, fails, until) VALUES (:id, :day, 1, 0)
                       ON CONFLICT (project_id) DO UPDATE
                         SET fails = CASE WHEN p.day = EXCLUDED.day THEN p.fails + 1 ELSE 1 END, day = EXCLUDED.day
                       RETURNING fails"""
                ),
                {"id": pid, "day": day},
            )
        ).scalar_one()
        lock = fails >= PIN_FAILS_PER_PROJECT_DAY
        if lock:
            await s.execute(
                text("UPDATE pin_locks SET fails = 0, until = :until WHERE project_id = :id"),
                {"id": pid, "until": now + PIN_DAY_LOCK_MS},
            )
    if lock:
        notify_mod.notify("관리 비밀번호 잠금 (하루 20번 틀림, 24시간)", {"접수": pid})
    return lock


def _pin_text(raw: Any) -> str:
    if isinstance(raw, str):
        return raw
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return number_to_string(raw).rjust(4, "0")
    return ""


async def authorize(ctx, id_raw: Any, pin_raw: Any, ip_key: str) -> dict:
    """접수 번호 + PIN 확인 → 접수 행 dict 또는 실패."""
    pid = to_id(id_raw)
    if pid is None:
        return fail(404, "none")
    async with _locks.hold(f"ip:{ip_key}"), _locks.hold(f"p:{pid}"):
        async with ctx.db.session() as s:
            row = await _get_row(s, pid)
            if row is None or row["status"] == "withdrawn" or row["purged_at"] is not None:
                return fail(404, "none")
            now = now_ms()
            day = kst_date(now)
            r = ctx.redis
            if await _count(r, _pin_ip_key(day, ip_key)) >= PIN_FAILS_PER_DAY:
                return fail(429, "locked")
            pf = await _get_fail(r, _pin_fail_key(pid))
            if pf is not None and pf[1] > now:
                return fail(429, "locked")
            if await _day_locked(s, pid, now):
                return fail(429, "locked")
        pin = _pin_text(pin_raw)
        ok = PIN_RE.fullmatch(pin) is not None and await asyncio.to_thread(pin_matches, pin, row["pin_hash"])
        if not ok:
            n = (pf[0] if pf is not None and pf[1] <= now else 0) + 1
            if n >= PIN_TRIES:
                await _set_fail(r, _pin_fail_key(pid), 0, now + PIN_LOCK_MS, now)
            else:
                await _set_fail(r, _pin_fail_key(pid), n, 0, now)
            await _incr_day(r, _pin_ip_key(day, ip_key))
            day_lock = await _add_day_fail(ctx, pid, now)
            return fail(403, "locked" if n >= PIN_TRIES or day_lock else "pin")
        await r.delete(_pin_fail_key(pid))
        return row


async def find_mine(ctx, body: dict, ip_key: str) -> dict:
    """이메일 + 관리 비밀번호로 내 접수 찾기 (없는 이메일도 비밀번호가 틀린 것과 똑같이 답함)."""
    email = clean_email(body.get("email"))
    if not email:
        return fail(400, "email")
    pin = body.get("pin") if isinstance(body.get("pin"), str) else ""
    if not PIN_RE.fullmatch(pin):
        return fail(400, "pin")
    ek = _mail_key(ctx, email)
    async with _locks.hold(f"ip:{ip_key}"), _locks.hold(f"m:{ek}"):
        now = now_ms()
        day = kst_date(now)
        r = ctx.redis
        if await _count(r, _pin_ip_key(day, ip_key)) >= PIN_FAILS_PER_DAY:
            return fail(429, "locked")
        ef = await _get_fail(r, ek)
        if ef is not None and ef[1] > now:
            return fail(429, "locked")
        async with ctx.db.session() as s:
            rows = [
                dict(x)
                for x in (
                    await s.execute(
                        text(
                            """SELECT * FROM projects WHERE email = :e AND status <> 'withdrawn' AND purged_at IS NULL
                               ORDER BY at DESC, id DESC LIMIT 20"""
                        ),
                        {"e": email},
                    )
                ).mappings()
            ]

        def check() -> list[dict]:
            if not rows:
                pin_matches(pin, _dummy_pin_hash())
            return [x for x in rows if pin_matches(pin, x["pin_hash"])]

        mine = await asyncio.to_thread(check)
        if not mine:
            n = (ef[0] if ef is not None and ef[1] <= now else 0) + 1
            if n >= PIN_TRIES:
                await _set_fail(r, ek, 0, now + PIN_LOCK_MS, now)
            else:
                await _set_fail(r, ek, n, 0, now)
            await _incr_day(r, _pin_ip_key(day, ip_key))
            return fail(403, "locked" if n >= PIN_TRIES else "pin")
        await r.delete(ek)
    return {
        "ok": True,
        "projects": [
            {
                "id": x["id"], "name": _nz(x["pending_name"], x["name"]), "status": x["status"], "note": x["note"],
                "slug": x["slug"], "at": x["at"], "linkReview": x["status"] == "approved" and has_change(x),
            }  # fmt: skip
            for x in mine
        ],
    }


# ── 입력 검사 (DB를 보는 것) ─────────────────────────────────────────


async def read_want(s: AsyncSession, plot_raw: Any, channel_raw: Any) -> dict:
    """고른 채널 · 자리 (registry.ts readWant). 없는 채널은 400 channel, 없는 자리 400 plot, 찬 자리 409 plot."""
    channel: int | None = None
    if channel_raw is not None and not (isinstance(channel_raw, str) and channel_raw == ""):
        if isinstance(channel_raw, (int, float)) and not isinstance(channel_raw, bool):
            c: Any = channel_raw
        elif isinstance(channel_raw, str) and re.fullmatch(r"[0-9]{1,2}", channel_raw):
            c = int(channel_raw)
        else:
            c = math.nan
        if not is_channel(c):
            return fail(400, "channel")
        channel = int(c)
    if plot_raw is None or (isinstance(plot_raw, str) and plot_raw == ""):
        return {"ok": True, "plot": None, "channel": channel}
    n = js_to_number(plot_raw)
    if not is_integer(n) or not 0 <= n < len(PLOTS):
        return fail(400, "plot")
    plot = int(n)
    ch = channel if channel is not None else 1
    if await plot_taken(s, ch, plot):
        return fail(409, "plot")
    return {"ok": True, "plot": plot, "channel": ch}


def _link_keys(links: dict) -> set[str]:
    keys: set[str] = set()
    if links["github"]:
        g = parse_github(links["github"])
        keys.add(g["key"] if g else "")
    if links["url"]:
        u = normalize_service_url(links["url"])
        keys.add(u["host"] if u else "")
    keys.discard("")
    return keys


async def is_duplicate(s: AsyncSession, links: dict, except_id: int) -> bool:
    """같은 GitHub 저장소나 같은 서비스 도메인이 이미 접수(검토 중 · 승인)됐거나 사당에 있는지."""
    keys = _link_keys(links)
    rows = await s.execute(
        text(
            """SELECT id, github, url, pending_github, pending_url FROM projects
               WHERE status IN ('pending', 'approved') AND id <> :id"""
        ),
        {"id": except_id},
    )
    for _id, github, url, pgithub, purl in rows:
        for g in (github, pgithub):
            if g:
                p = parse_github(g)
                if p and p["key"] in keys:
                    return True
        for u in (url, purl):
            if u:
                n = normalize_service_url(u)
                if n and n["host"] in keys:
                    return True
    for domain, repo, project_id in await s.execute(text("SELECT domain, repo, project_id FROM shrines")):
        if project_id == except_id and except_id > 0:
            continue
        if domain in keys:
            return True
        if repo:
            p = parse_github(repo)
            if p and p["key"] in keys:
                return True
    return False


async def _links_lock(s: AsyncSession) -> None:
    await s.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": LINKS_LOCK_ID})


# ── 접수 ────────────────────────────────────────────────────────────

_SUBMIT_RESERVE_LUA = """
if redis.call('EXISTS', KEYS[1]) == 1 then return 'slow' end
local n = tonumber(redis.call('GET', KEYS[2]) or '0')
if n >= tonumber(ARGV[3]) then return 'many' end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
return 'ok'
"""

_SUBMIT_RELEASE_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
local n = tonumber(redis.call('GET', KEYS[2]) or '0')
if n > 0 then redis.call('DECR', KEYS[2]) end
return 1
"""


def _scripts(ctx) -> tuple[Any, Any]:
    st = getattr(ctx, "_p2b_registry_scripts", None)
    if st is None or st[0] is not ctx.redis:
        st = (ctx.redis, ctx.redis.register_script(_SUBMIT_RESERVE_LUA), ctx.redis.register_script(_SUBMIT_RELEASE_LUA))
        ctx._p2b_registry_scripts = st
    return st[1], st[2]


class _Dup(Exception):
    pass


def _constraint(e: IntegrityError) -> str:
    orig = getattr(e, "orig", None)
    for obj in (orig, getattr(orig, "__cause__", None)):
        name = getattr(obj, "constraint_name", None)
        if name:
            return str(name)
    m = re.search(r'constraint "([^"]+)"', str(e))
    return m.group(1) if m else ""


INSERT_PROJECT = text(
    """INSERT INTO projects (code, at, name, tagline, sign, category, github, url, email, email_public, pin_hash, nick,
         repo_ok, stars, screen, want_plot, want_channel, consent_at, review_at)
       VALUES (:code, :at, :name, :tagline, :sign, :category, :github, :url, :email, :email_public, :pin_hash, :nick,
         :repo_ok, :stars, :screen, :want_plot, :want_channel, :consent_at, :review_at)
       RETURNING id"""
)


async def submit_project(ctx, body: dict, sid: str, ip_key: str, nick: str) -> dict:
    """접수 (registry.ts submitProject): {ok, id, code} 또는 실패."""
    now = now_ms()
    day = kst_date(now)
    r = ctx.redis
    if await r.exists(_last_key(sid)):
        return fail(429, "slow")
    if await _count(r, _submit_ip_key(day, ip_key)) >= SUBMITS_PER_DAY:
        return fail(429, "many")

    name = clean_text(body.get("name"), NAME_MAX, "name")
    if not name["ok"]:
        return name
    tagline = clean_text(body.get("tagline"), TAGLINE_MAX, "tagline")
    if not tagline["ok"]:
        return tagline
    sign = clean_sign(body.get("sign"), tagline["text"])
    if not sign["ok"]:
        return sign
    category = body.get("category")
    if not isinstance(category, str) or category not in CATEGORY_KEYS:
        return fail(400, "category")
    links = read_links(body.get("github"), body.get("url"))
    if not links["ok"]:
        return links
    lk = links["links"]
    email = clean_email(body.get("email"))
    if not email:
        return fail(400, "email")
    pin = body.get("pin") if isinstance(body.get("pin"), str) else ""
    if not NEW_PIN_RE.fullmatch(pin):
        return fail(400, "pin")
    # 개인정보(이메일) 수집 · 이용 동의: 화면의 체크 상자가 true를 보냅니다
    if body.get("consent") is not True:
        return fail(400, "consent")
    screen_raw = body.get("screen")
    if screen_raw is None or (isinstance(screen_raw, str) and screen_raw == ""):
        screen = ""
    elif await owns_upload(ctx, screen_raw, sid):
        screen = screen_raw
    else:
        return fail(400, "image")
    async with ctx.db.session() as s:
        want = await read_want(s, body.get("plot"), body.get("channel"))
        if not want["ok"]:
            return want
        if await is_duplicate(s, lk, 0):
            return fail(409, "dup")

    repo_ok = 0
    stars = 0
    if lk["github"]:
        exists, st = await check_github_for(ctx.config, lk["github"])
        if exists is False:
            return fail(400, "github")
        if exists:
            repo_ok, stars = 1, st
    pin_hash = await asyncio.to_thread(hash_pin, pin)

    # 2분 · 하루 3개를 여기서 한 번에 잡습니다 (같은 사람이 동시에 둘을 보내도 하나만)
    reserve, release = _scripts(ctx)
    last_key, ip_day_key = _last_key(sid), _submit_ip_key(day, ip_key)
    px = max(1, SUBMIT_GAP_MS - (now_ms() - now))
    got = await reserve(keys=[last_key, ip_day_key], args=[now, px, SUBMITS_PER_DAY, DAY_KEY_TTL_MS])
    got = got.decode() if isinstance(got, bytes) else str(got)
    if got != "ok":
        return fail(429, got)
    try:
        async with ctx.db.begin() as s:
            await _links_lock(s)
            if await is_duplicate(s, lk, 0):
                raise _Dup
            pid = code = None
            for _ in range(5):
                code = _b64url(secrets.token_bytes(12))
                try:
                    async with s.begin_nested():
                        pid = (
                            await s.execute(
                                INSERT_PROJECT,
                                {
                                    "code": code, "at": now, "name": name["text"], "tagline": tagline["text"], "sign": sign["text"],
                                    "category": category, "github": lk["github"], "url": lk["url"], "email": email,
                                    "email_public": 1 if body.get("emailPublic") is True else 0, "pin_hash": pin_hash,
                                    "nick": slice_units(nick, 0, 20), "repo_ok": repo_ok, "stars": stars, "screen": screen,
                                    "want_plot": want["plot"], "want_channel": want["channel"], "consent_at": now, "review_at": now,
                                },  # fmt: skip
                            )
                        ).scalar_one()
                    break
                except IntegrityError as e:
                    if _constraint(e) != "uq_projects_code":
                        raise
            if pid is None:
                raise RuntimeError("접수 코드를 만들지 못했습니다")
    except _Dup:
        await release(keys=[last_key, ip_day_key], args=[now])
        return fail(409, "dup")
    except BaseException:
        await release(keys=[last_key, ip_day_key], args=[now])
        raise
    notify_mod.notify(
        "새 접수",
        {"접수": pid, "이름": name["text"], "링크": lk["url"] or lk["github"], "이미지": "있음" if screen else "없음"},
    )
    return {"ok": True, "id": pid, "code": code}


async def status_by_code(ctx, code: str) -> dict | None:
    """접수 코드로 진행 상황 (PIN 없이: 상태 · 번호 · 이름 · 사당 주소 · 메모 정도)."""
    if not CODE_RE.fullmatch(code):
        return None
    async with ctx.db.session() as s:
        row = (await s.execute(text("SELECT * FROM projects WHERE code = :c"), {"c": code})).mappings().first()
    if row is None:
        return None
    out: dict[str, Any] = {"status": row["status"], "id": row["id"], "name": row["name"]}
    if row["slug"]:
        out["slug"] = row["slug"]
    if row["note"]:
        out["note"] = row["note"]
    out["linkReview"] = row["status"] == "approved" and has_change(dict(row))
    return out


# ── 관리 (PIN) ──────────────────────────────────────────────────────


async def manage_get(ctx, body: dict, ip_key: str, sid: str = "") -> dict:
    a = await authorize(ctx, body.get("id"), body.get("pin"), ip_key)
    if is_fail(a):
        return a
    # 검토를 기다리는 이미지는 공개 주소로 나가지 않으므로, 비밀번호로 연 이 사람에게만 잠시 보여 줍니다
    await grant_upload_view(ctx, sid, [a["screen"], a["pending_screen"]])
    return {"ok": True, "project": owner_view(a)}


GithubCheck = Callable[[str], Awaitable[tuple[bool | None, int]]]


async def _plan_save(ctx, s: AsyncSession, row: dict, body: dict, sid: str, github: GithubCheck, memo: dict) -> dict:
    """고치기 계산 (registry.ts manageSave의 검사 · 다음 값). 실패 dict 또는 {ok, next, clear_live_screen, links_changed}."""
    live = row["status"] == "approved"
    nxt = dict(row)

    # 글자: 맵에 있는 사당이면 검토를 기다리는 칸에, 아니면 바로
    name = _nz(row["pending_name"], row["name"])
    tagline = _nz(row["pending_tagline"], row["tagline"])
    sign = row["pending_sign"] if row["pending_sign"] is not None else _nz(row["sign"], "")
    if "name" in body:
        v = clean_text(body["name"], NAME_MAX, "name")
        if not v["ok"]:
            return v
        name = v["text"]
    if "tagline" in body:
        v = clean_text(body["tagline"], TAGLINE_MAX, "tagline")
        if not v["ok"]:
            return v
        tagline = v["text"]
    if "sign" in body:
        v = clean_sign(body["sign"], tagline)
        if not v["ok"]:
            return v
        sign = v["text"]
    if live:
        nxt["pending_name"] = name if name != row["name"] else None
        nxt["pending_tagline"] = tagline if tagline != row["tagline"] else None
        nxt["pending_sign"] = sign if sign != _nz(row["sign"], "") else None
    else:
        nxt.update(name=name, tagline=tagline, sign=sign, pending_name=None, pending_tagline=None, pending_sign=None)
    if "category" in body:
        c = body["category"]
        if not isinstance(c, str) or c not in CATEGORY_KEYS:
            return fail(400, "category")
        nxt["category"] = c
    # 채널 · 자리는 맵에 오르기 전에만. 한쪽만 보내면 다른 쪽은 지금 값으로 봅니다
    if ("plot" in body or "channel" in body) and not live:
        v = await read_want(
            s, body["plot"] if "plot" in body else row["want_plot"], body["channel"] if "channel" in body else wish_channel(row)
        )
        if not v["ok"]:
            return v
        nxt["want_plot"] = v["plot"]
        nxt["want_channel"] = v["channel"]
    if "email" in body:
        e = clean_email(body["email"])
        if not e:
            return fail(400, "email")
        nxt["email"] = e
    if "emailPublic" in body:
        nxt["email_public"] = 1 if body["emailPublic"] is True else 0
    if "newPin" in body:
        p = body["newPin"] if isinstance(body["newPin"], str) else ""
        if not NEW_PIN_RE.fullmatch(p):
            return fail(400, "pin")
        if p not in memo:
            memo[p] = await asyncio.to_thread(hash_pin, p)
        nxt["pin_hash"] = memo[p]

    links_changed = False
    if "github" in body or "url" in body:
        if live and link_change(row):
            base = {"github": _nz(row["pending_github"], ""), "url": _nz(row["pending_url"], "")}
        else:
            base = {"github": row["github"], "url": row["url"]}
        links = read_links(
            body["github"] if "github" in body else base["github"], body["url"] if "url" in body else base["url"]
        )
        if not links["ok"]:
            return links
        lk = links["links"]
        if not (lk["github"] == row["github"] and lk["url"] == row["url"]):
            if await is_duplicate(s, lk, row["id"]):
                return fail(409, "dup")
            if lk["github"] and lk["github"] != row["github"]:
                exists, stars = await github(lk["github"])
                if exists is False:
                    return fail(400, "github")
                nxt["repo_ok"] = 1 if exists else 0
                if exists:
                    nxt["stars"] = stars
            if live:
                # 이미 맵에 있는 사당의 링크는 운영자가 다시 볼 때까지 그대로 둡니다
                nxt["pending_github"] = lk["github"]
                nxt["pending_url"] = lk["url"]
            else:
                nxt["github"] = lk["github"]
                nxt["url"] = lk["url"]
            links_changed = True
        elif live:
            # 바꾸려던 링크를 원래대로 되돌림 → 검토할 것 없음
            nxt["pending_github"] = None
            nxt["pending_url"] = None
    # 이미지: 지우기는 바로, 새 이미지는 맵에 있으면 다시 확인 뒤 (본인이 방금 올린 파일만)
    clear_live_screen = False
    if "screen" in body:
        sc = body["screen"]
        if sc is None or (isinstance(sc, str) and sc == ""):
            nxt["screen"] = ""
            nxt["pending_screen"] = None
            clear_live_screen = live
        elif isinstance(sc, str) and sc == row["screen"]:
            nxt["pending_screen"] = None
        elif not (isinstance(sc, str) and sc == row["pending_screen"]):
            if not await owns_upload(ctx, sc, sid):
                return fail(400, "image")
            if live:
                nxt["pending_screen"] = sc
            else:
                nxt["screen"] = sc

    now = now_ms()
    if live:
        was = has_change(row)
        is_ = has_change(nxt)
        if is_:
            nxt["note"] = "link-review"
        elif nxt["note"] == "link-review":
            nxt["note"] = ""
        if is_ and not was:
            nxt["review_at"] = now
        if not is_:
            nxt["review_at"] = None
    # 반려된 접수를 고치면 다시 검토 대기로 (파기 시계도 멈춥니다)
    if row["status"] == "rejected":
        nxt.update(status="pending", note="", closed_at=None, review_at=now)
    return {"ok": True, "next": nxt, "clear_live_screen": clear_live_screen, "links_changed": links_changed}


UPDATE_PROJECT = text(
    """UPDATE projects SET name = :name, tagline = :tagline, sign = :sign, category = :category, email = :email,
         email_public = :email_public, pin_hash = :pin_hash, github = :github, url = :url, pending_github = :pending_github,
         pending_url = :pending_url, note = :note, status = :status, repo_ok = :repo_ok, stars = :stars, screen = :screen,
         pending_screen = :pending_screen, want_plot = :want_plot, want_channel = :want_channel, pending_name = :pending_name,
         pending_tagline = :pending_tagline, pending_sign = :pending_sign, review_at = :review_at, closed_at = :closed_at
       WHERE id = :id"""
)

_SAVE_COLUMNS = (
    "name", "tagline", "sign", "category", "email", "email_public", "pin_hash", "github", "url", "pending_github",
    "pending_url", "note", "status", "repo_ok", "stars", "screen", "pending_screen", "want_plot", "want_channel",
    "pending_name", "pending_tagline", "pending_sign", "review_at", "closed_at",
)  # fmt: skip


def _pending_key(r: dict) -> tuple:
    return (r["pending_name"], r["pending_tagline"], r["pending_sign"], r["pending_github"], r["pending_url"], r["pending_screen"])


async def manage_save(ctx, body: dict, ip_key: str, sid: str = "") -> dict:
    """고치기 (registry.ts manageSave): {ok, project, linkReview} 또는 실패."""
    a = await authorize(ctx, body.get("id"), body.get("pin"), ip_key)
    if is_fail(a):
        return a
    row0 = a
    checked: dict[str, tuple[bool | None, int]] = {}
    memo: dict[str, str] = {}

    async def github_live(url: str) -> tuple[bool | None, int]:
        if url not in checked:
            checked[url] = await check_github_for(ctx.config, url)
        return checked[url]

    async def github_cached(url: str) -> tuple[bool | None, int]:
        return checked.get(url, (None, 0))

    # 1) 검사 · GitHub 확인 (트랜잭션 밖: 바깥 호출이 3초까지 걸릴 수 있음)
    async with ctx.db.session() as s:
        plan = await _plan_save(ctx, s, row0, body, sid, github_live, memo)
    if is_fail(plan):
        return plan
    # 2) 쓰기: 행을 잡고, 그 사이 다른 요청이 바꿨으면 지금 행으로 다시 계산 (GitHub는 1의 결과만)
    async with ctx.db.begin() as s:
        if plan["links_changed"]:
            await _links_lock(s)
        row = await _get_row(s, row0["id"], lock=True)
        if row is None or row["status"] == "withdrawn" or row["purged_at"] is not None:
            return fail(404, "none")
        if row != row0:
            plan = await _plan_save(ctx, s, row, body, sid, github_cached, memo)
            if is_fail(plan):
                return plan
        elif plan["links_changed"]:
            lk = {"github": plan["next"]["pending_github" if row["status"] == "approved" else "github"] or "",
                  "url": plan["next"]["pending_url" if row["status"] == "approved" else "url"] or ""}  # fmt: skip
            if await is_duplicate(s, lk, row["id"]):
                return fail(409, "dup")
        nxt = plan["next"]
        live = row["status"] == "approved"
        if plan["clear_live_screen"]:
            await s.execute(text("UPDATE shrines SET screens = '[]' WHERE project_id = :id"), {"id": row["id"]})
        await s.execute(UPDATE_PROJECT, {**{c: nxt[c] for c in _SAVE_COLUMNS}, "id": row["id"]})
        if live:
            # 분류 · 이메일 · 공개 여부는 맵의 사당에도 바로. 이름 · 소개 · 지붕 글자는 검토 뒤에
            await s.execute(
                text("UPDATE shrines SET category = :c, email = :e, email_public = :p WHERE project_id = :id"),
                {"c": nxt["category"], "e": nxt["email"], "p": nxt["email_public"], "id": row["id"]},
            )
        if live:
            invalidate_after_commit(s, ctx)
        saved = await _get_row(s, row["id"]) or nxt
    await grant_upload_view(ctx, sid, [saved["screen"], saved["pending_screen"]])

    # 운영자에게: 맵에 있는 사당의 새 변경 요청, 반려됐다가 다시 낸 접수
    if live and has_change(saved) and _pending_key(saved) != _pending_key(row):
        notify_mod.notify(
            "사당 변경 검토 요청",
            {"접수": row["id"], "사당": row["slug"] or "-", "이름": row["name"], "바뀐 것": ", ".join(change_kinds(saved))},
        )
    elif row["status"] == "rejected":
        notify_mod.notify("반려된 접수를 고쳐 다시 냄", {"접수": row["id"], "이름": saved["name"], "링크": saved["url"] or saved["github"]})
    return {"ok": True, "project": owner_view(saved), "linkReview": live and has_change(saved)}


async def manage_withdraw(ctx, body: dict, ip_key: str) -> dict:
    """내리기: 접수를 거두고 맵의 사당도 뺍니다 (개인정보는 30일 뒤 보관 기간 정리가 파기)."""
    a = await authorize(ctx, body.get("id"), body.get("pin"), ip_key)
    if is_fail(a):
        return a
    async with ctx.db.begin() as s:
        row = await _get_row(s, a["id"], lock=True)
        if row is None or row["status"] == "withdrawn" or row["purged_at"] is not None:
            return fail(404, "none")
        await s.execute(
            text(
                """UPDATE projects SET status = 'withdrawn', pending_github = NULL, pending_url = NULL, pending_screen = NULL,
                     pending_name = NULL, pending_tagline = NULL, pending_sign = NULL, note = 'withdrawn', review_at = NULL,
                     closed_at = :now
                   WHERE id = :id"""
            ),
            {"now": now_ms(), "id": row["id"]},
        )
        await s.execute(text("DELETE FROM shrines WHERE project_id = :id"), {"id": row["id"]})
        invalidate_after_commit(s, ctx)
    notify_mod.notify("작성자가 프로젝트를 내림", {"접수": row["id"], "이름": row["name"], "전 상태": row["status"]})
    return {"ok": True}


# ── 운영 (승인 · 반려) ──────────────────────────────────────────────

CHANGES_SQL = """(pending_github IS NOT NULL OR pending_url IS NOT NULL OR pending_screen IS NOT NULL
  OR pending_name IS NOT NULL OR pending_tagline IS NOT NULL OR pending_sign IS NOT NULL)"""


def _num(v: Any) -> str:
    return number_to_string(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else str(v)


async def _taken_slugs(s: AsyncSession) -> set[str]:
    taken = {x for (x,) in await s.execute(text("SELECT slug FROM shrines"))}
    taken |= {x for (x,) in await s.execute(text("SELECT slug FROM projects WHERE slug <> ''"))}
    return taken


async def _auto_place(s: AsyncSession, row: dict, channel_arg: int | None) -> tuple[int, int] | None:
    """자리를 정하지 않고 승인할 때 세울 곳 (registry.ts autoPlace).
    작성자가 고른 채널 · 자리가 비어 있으면 그곳 (운영자가 채널을 정했으면 그 채널이 작성자가 고른 채널일 때만)
    → 그 채널(운영자 → 작성자 순)의 첫 빈 자리 → (운영자가 채널을 정하지 않았으면) 1번 채널부터 첫 빈 자리."""
    wish = wish_channel(row)
    first = channel_arg if channel_arg is not None else wish
    wp = row["want_plot"]
    if first is not None and first == wish and wp is not None and 0 <= wp < len(PLOTS) and not await plot_taken(s, first, wp):
        return first, wp
    if first is None:
        order = ALL_CHANNELS
    elif channel_arg is not None:
        order = [first]
    else:
        order = [first, *(c for c in ALL_CHANNELS if c != first)]
    for ch in order:
        free = await free_plots_in(s, ch)
        if free:
            return ch, free[0]
    return None


async def _apply_pending_text(s: AsyncSession, row: dict) -> str:
    name = _nz(row["pending_name"], row["name"])
    tagline = _nz(row["pending_tagline"], row["tagline"])
    sign = row["pending_sign"] if row["pending_sign"] is not None else _nz(row["sign"], "")
    p = {"n": name, "t": tagline, "s": sign, "id": row["id"]}
    await s.execute(text("UPDATE shrines SET name = :n, tagline = :t, sign = :s WHERE project_id = :id"), p)
    await s.execute(
        text(
            """UPDATE projects SET name = :n, tagline = :t, sign = :s, pending_name = NULL, pending_tagline = NULL,
                 pending_sign = NULL WHERE id = :id"""
        ),
        p,
    )
    return name


async def _apply_pending_screen(s: AsyncSession, row: dict) -> None:
    img = _nz(row["pending_screen"], "")
    screens = json_stringify([f"up/{img}"] if img else [])
    await s.execute(text("UPDATE shrines SET screens = :sc WHERE project_id = :id"), {"sc": screens, "id": row["id"]})
    await s.execute(text("UPDATE projects SET screen = :img, pending_screen = NULL WHERE id = :id"), {"img": img, "id": row["id"]})


async def approve_project(ctx, pid: int, plot: int | None = None, channel: int | None = None) -> str:
    """승인 (registry.ts approveProject). 검토 중이면 빈 자리에 사당을 세우고, 맵에 있는 사당의 변경(글자 · 이미지 · 링크)이면
    사당에 반영합니다. plot · channel: 운영자가 정한 자리 · 채널 (자리만 정하면 채널은 작성자가 고른 채널, 없으면 1번).
    운영자가 채널을 정하면 다른 채널로 넘치지 않습니다. 실패하면 RegistryError(한국어 메시지)."""
    try:
        async with ctx.db.begin() as s:
            invalidate_after_commit(s, ctx)
            msg = await _approve(s, pid, plot, channel)
    except IntegrityError as e:
        c = _constraint(e)
        col = {"uq_shrines_domain": "domain", "uq_shrines_channel_plot": "channel, shrines.plot", "pk_shrines": "slug"}.get(c, c)
        raise RegistryError(f"UNIQUE constraint failed: shrines.{col}") from e
    return msg


async def _approve(s: AsyncSession, pid: int, plot_arg: int | None, channel_arg: int | None) -> str:
    row = await _get_row(s, pid, lock=True)
    if row is None:
        raise RegistryError(f"없는 접수입니다: {_num(pid)}")

    if row["status"] == "approved" and has_change(row):
        kinds = change_kinds(row)
        links = {"github": _nz(row["pending_github"], ""), "url": _nz(row["pending_url"], "")}
        domain = domain_of(links) if link_change(row) else ""
        if link_change(row):
            clash = (
                await s.execute(
                    text("SELECT slug FROM shrines WHERE domain = :d AND project_id <> :id"), {"d": domain, "id": pid}
                )
            ).first()
            if clash is not None:
                raise RegistryError(f"다른 사당({clash[0]})이 같은 주소를 씁니다: {domain}")
        name = row["name"]
        if text_change(row):
            name = await _apply_pending_text(s, row)
        if row["pending_screen"] is not None:
            await _apply_pending_screen(s, row)
        if link_change(row):
            await s.execute(
                text("UPDATE shrines SET domain = :d, url = :u, repo = :r WHERE project_id = :id"),
                {"d": domain, "u": links["url"] or links["github"], "r": links["github"], "id": pid},
            )
            await s.execute(
                text("UPDATE projects SET github = :g, url = :u, pending_github = NULL, pending_url = NULL WHERE id = :id"),
                {"g": links["github"], "u": links["url"], "id": pid},
            )
        await s.execute(text("UPDATE projects SET note = '', review_at = NULL WHERE id = :id"), {"id": pid})
        tail = f" ({links['github'] or links['url']})" if link_change(row) else ""
        return f"{' · '.join(kinds)} 변경을 승인했습니다: {name}{tail}"
    if row["status"] != "pending":
        raise RegistryError(f"검토 대기 상태가 아닙니다 ({row['status']}): {_num(pid)}")

    if channel_arg is not None and not is_channel(channel_arg):
        raise RegistryError(f"없는 채널입니다: {_num(channel_arg)} (1~{CHANNELS})")
    if plot_arg is not None:
        ch = int(channel_arg if channel_arg is not None else (wish_channel(row) or 1))
        if not is_integer(plot_arg) or not 0 <= plot_arg < len(PLOTS):
            raise RegistryError(f"없는 자리 번호입니다: {_num(plot_arg)} (0~{len(PLOTS) - 1})")
        pl = int(plot_arg)
        if await plot_taken(s, ch, pl):
            raise RegistryError(f"이미 사당이 있는 자리입니다: 채널 {ch} · {pl}번")
    else:
        spot = await _auto_place(s, row, int(channel_arg) if channel_arg is not None else None)
        if spot is None:
            raise RegistryError(f"채널 {_num(channel_arg)}에는 빈 사당 자리가 없습니다" if channel_arg is not None else "빈 사당 자리가 없습니다")
        ch, pl = spot

    links = {"github": row["github"], "url": row["url"]}
    g = parse_github(row["github"]) if row["github"] else None
    base = slugify(g["repo"] if g else "") or slugify(row["name"]) or f"project-{row['id']}"
    today = kst_date()
    for _ in range(10):
        slug = unique_slug(base, await _taken_slugs(s))
        shrine = {
            "slug": slug, "name": row["name"], "tagline": row["tagline"], "category": row["category"], "domain": domain_of(links),
            "url": links["url"] or links["github"], "operator": slice_units(row["nick"], 0, 20) or "익명", "keeper": False,
            "paid": False, "verifiedDomain": "", "verifiedBusiness": None, "joinedAt": today, "status": "live",
            "prayer": "deploy", "charm": None, "deco": [], "screens": [f"up/{row['screen']}"] if row["screen"] else [],
            "capturedAt": today, "channel": ch, "plot": pl, "repo": links["github"], "email": row["email"],
            "emailPublic": row["email_public"] == 1, "projectId": row["id"], "sign": _nz(row["sign"], ""),
        }  # fmt: skip
        errors = validate_shrine(shrine)
        if errors:
            raise RegistryError(f"사당 규칙에 맞지 않습니다: {' / '.join(errors)}")
        try:
            async with s.begin_nested():
                await insert_shrine(s, shrine)
            break
        except IntegrityError as e:
            c = _constraint(e)
            if c == "pk_shrines":
                continue  # 같은 slug를 다른 승인이 먼저 씀 → 다시 고름
            if c == "uq_shrines_channel_plot":
                # 같은 자리를 다른 승인이 먼저 차지함
                if plot_arg is not None:
                    raise RegistryError(f"이미 사당이 있는 자리입니다: 채널 {ch} · {pl}번") from e
                spot = await _auto_place(s, row, int(channel_arg) if channel_arg is not None else None)
                if spot is None:
                    raise RegistryError(
                        f"채널 {_num(channel_arg)}에는 빈 사당 자리가 없습니다" if channel_arg is not None else "빈 사당 자리가 없습니다"
                    ) from e
                ch, pl = spot
                continue
            raise
    else:
        raise RegistryError("사당을 세우지 못했습니다 (동시에 승인이 몰림). 다시 해 주세요")
    await s.execute(
        text("UPDATE projects SET status = 'approved', slug = :slug, note = '', review_at = NULL, closed_at = NULL WHERE id = :id"),
        {"slug": slug, "id": pid},
    )
    return f"승인했습니다: {row['name']} → 사당 '{slug}' (채널 {ch} · 자리 {pl})"


async def reject_project(ctx, pid: int, reason: str = "") -> str:
    """반려 (registry.ts rejectProject): 검토 중이면 접수 반려(30일 뒤 파기), 맵에 있는 사당의 변경이면 바꾸려던 것만 버림."""
    async with ctx.db.begin() as s:
        row = await _get_row(s, pid, lock=True)
        if row is None:
            raise RegistryError(f"없는 접수입니다: {_num(pid)}")
        why = slice_units(js_trim(reason), 0, 80)
        if row["status"] == "approved" and has_change(row):
            await s.execute(
                text(
                    """UPDATE projects SET pending_github = NULL, pending_url = NULL, pending_screen = NULL,
                         pending_name = NULL, pending_tagline = NULL, pending_sign = NULL, note = :note, review_at = NULL
                       WHERE id = :id"""
                ),
                {"note": f"link-rejected: {why}" if why else "link-rejected", "id": pid},
            )
            return f"변경을 반려했습니다: {row['name']} (사당은 원래 글자 · 링크 · 이미지 그대로)"
        if row["status"] != "pending":
            raise RegistryError(f"검토 대기 상태가 아닙니다 ({row['status']}): {_num(pid)}")
        await s.execute(
            text("UPDATE projects SET status = 'rejected', note = :note, review_at = NULL, closed_at = :now WHERE id = :id"),
            {"note": why or "rejected", "now": now_ms(), "id": pid},
        )
    return f"반려했습니다: {row['name']}{f' ({why})' if why else ''}"


# ── 보관 기간 (retention.py가 부릅니다) ──────────────────────────────


async def expire_stale_reviews(ctx, cutoff: float, now: int | None = None) -> dict[str, int]:
    """review_at(없으면 접수 시각)이 cutoff보다 오래된 새 접수 → 반려(expired), 맵에 있는 사당의 변경 요청 → 버림(link-expired).
    시각이 비어 있는 변경 요청은 지금부터 셉니다. 한 트랜잭션."""
    now = now_ms() if now is None else now
    async with ctx.db.begin() as s:
        await s.execute(
            text(f"UPDATE projects SET review_at = :now WHERE status = 'approved' AND review_at IS NULL AND {CHANGES_SQL}"),
            {"now": now},
        )
        registrations = (
            await s.execute(
                text(
                    """UPDATE projects SET status = 'rejected', note = 'expired', review_at = NULL, closed_at = :now
                       WHERE status = 'pending' AND COALESCE(review_at, at) < CAST(:cutoff AS double precision)"""
                ),
                {"now": now, "cutoff": float(cutoff)},
            )
        ).rowcount
        changes = (
            await s.execute(
                text(
                    f"""UPDATE projects SET pending_github = NULL, pending_url = NULL, pending_screen = NULL,
                          pending_name = NULL, pending_tagline = NULL, pending_sign = NULL, note = 'link-expired', review_at = NULL
                        WHERE status = 'approved' AND review_at < CAST(:cutoff AS double precision) AND {CHANGES_SQL}"""
                ),
                {"cutoff": float(cutoff)},
            )
        ).rowcount
    return {"registrations": int(registrations), "changes": int(changes)}


async def closed_before(ctx, cutoff: float, now: int | None = None) -> list[int]:
    """반려 · 내린 시각이 비어 있는 접수는 지금부터 셉니다. 파기할 접수 번호들."""
    now = now_ms() if now is None else now
    async with ctx.db.begin() as s:
        await s.execute(
            text(
                """UPDATE projects SET closed_at = :now
                   WHERE status IN ('rejected', 'withdrawn') AND closed_at IS NULL AND purged_at IS NULL"""
            ),
            {"now": now},
        )
        rows = await s.execute(
            text(
                """SELECT id FROM projects WHERE status IN ('rejected', 'withdrawn') AND purged_at IS NULL
                     AND closed_at <= CAST(:cutoff AS double precision) ORDER BY id"""
            ),
            {"cutoff": float(cutoff)},
        )
        return [int(x) for (x,) in rows]


PURGE_SQL = text(
    """UPDATE projects SET name = '(파기됨)', tagline = '', sign = '', github = '', url = '', email = '', email_public = 0,
         pin_hash = '', slug = '', screen = '', pending_screen = NULL, pending_github = NULL, pending_url = NULL,
         pending_name = NULL, pending_tagline = NULL, pending_sign = NULL, want_plot = NULL, want_channel = NULL,
         review_at = NULL, closed_at = COALESCE(closed_at, :now), purged_at = :now
       WHERE id = :id"""
)


async def _purge(s: AsyncSession, row: dict, now: int) -> list[str]:
    await s.execute(PURGE_SQL, {"now": now, "id": row["id"]})
    await s.execute(text("DELETE FROM pin_locks WHERE project_id = :id"), {"id": row["id"]})
    return [x for x in (row["screen"], row["pending_screen"]) if x]


async def _forget_pin_fails(ctx, pid: int) -> None:
    if ctx.redis is None:
        return
    try:
        await ctx.redis.delete(_pin_fail_key(pid))
    except Exception:  # noqa: BLE001
        log.warning("[shrine] PIN 틀린 기록을 지우지 못했습니다 (Redis)")


async def purge_project(ctx, pid: int, now: int | None = None) -> list[str] | None:
    """접수의 개인정보 파기 (registry.ts purgeProject): 이메일 · PIN 해시 · 링크 · 이름 · 소개 · 이미지 칸을 비우고 파기 시각.
    맵의 사당은 건드리지 않습니다 (맵에 있으면 erase_project). 지울 이미지 이름들 (파일은 uploads.remove_uploads로),
    없는 접수면 None."""
    now = now_ms() if now is None else now
    async with ctx.db.begin() as s:
        row = await _get_row(s, pid, lock=True)
        if row is None:
            return None
        files = await _purge(s, row, now)
    await _forget_pin_fails(ctx, pid)
    return files


async def erase_project(ctx, pid: int, now: int | None = None) -> list[str] | None:
    """작성자가 요청하면 바로 파기 (registry.ts eraseProject): 맵에 있으면 사당을 빼고 내린 것으로 바꾼 뒤 파기.
    한 트랜잭션. 지울 이미지 이름들, 없는 접수면 None, 이미 파기했으면 []."""
    now = now_ms() if now is None else now
    async with ctx.db.begin() as s:
        row = await _get_row(s, pid, lock=True)
        if row is None:
            return None
        if row["purged_at"] is not None:
            return []
        if row["status"] in ("pending", "approved"):
            await s.execute(
                text("UPDATE projects SET status = 'withdrawn', note = 'erased', closed_at = :now WHERE id = :id"),
                {"now": now, "id": pid},
            )
            await s.execute(text("DELETE FROM shrines WHERE project_id = :id"), {"id": pid})
            invalidate_after_commit(s, ctx)
            row["closed_at"] = now
        files = await _purge(s, row, now)
    await _forget_pin_fails(ctx, pid)
    return files


async def prune_pin_locks(ctx) -> int:
    """1시간마다: 풀린 지난날 잠금 기록을 지웁니다 (registry.ts 끝의 setInterval)."""
    now = now_ms()
    async with ctx.db.begin() as s:
        r = await s.execute(text("DELETE FROM pin_locks WHERE until <= :now AND day <> :day"), {"now": now, "day": kst_date(now)})
        return int(r.rowcount)


# ── 운영자 화면 · 운영 도구 ─────────────────────────────────────────

PROJECT_FILTERS = ("review", "pending", "changes", "approved", "rejected", "withdrawn", "all")


def is_project_filter(v: Any) -> bool:
    return isinstance(v, str) and v in PROJECT_FILTERS


FILTER_SQL = {
    "review": f"status = 'pending' OR (status = 'approved' AND {CHANGES_SQL})",
    "pending": "status = 'pending'",
    "changes": f"status = 'approved' AND {CHANGES_SQL}",
    "approved": "status = 'approved'",
    "rejected": "status = 'rejected'",
    "withdrawn": "status = 'withdrawn'",
    "all": "1 = 1",
}


def admin_view(r: dict) -> dict[str, Any]:
    """운영자에게 보이는 모양: 지금 값 + 검토 대기 값 + 접수 시각 · 닉네임 · 저장소 확인 · 동의 · 파기. PIN 해시 · 접수 코드 빼고."""
    out = view(r)
    out.update(
        at=r["at"], nick=r["nick"], repoOk=r["repo_ok"] == 1, stars=r["stars"],
        changes=r["status"] == "approved" and has_change(r),
        consentAt=r["consent_at"], reviewAt=r["review_at"], closedAt=r["closed_at"], purgedAt=r["purged_at"],
    )  # fmt: skip
    return out


async def projects_for_admin(ctx, all_: bool = False) -> list[dict]:
    """운영 도구 projects: 검토할 것(또는 전부)의 접수 행 그대로 (최근 200개)."""
    where = "" if all_ else f"WHERE status = 'pending' OR (status = 'approved' AND {CHANGES_SQL})"
    async with ctx.db.session() as s:
        rows = await s.execute(text(f"SELECT * FROM projects {where} ORDER BY at DESC, id DESC LIMIT 200"))
        return [dict(x) for x in rows.mappings()]


async def projects_by_filter(ctx, filter_: str, limit: int = 200) -> list[dict]:
    """목록에는 이메일을 넣지 않습니다 (자세히 보기에서만)."""
    async with ctx.db.session() as s:
        rows = await s.execute(
            text(f"SELECT * FROM projects WHERE {FILTER_SQL[filter_]} ORDER BY at DESC, id DESC LIMIT :n"), {"n": limit}
        )
        out = []
        for x in rows.mappings():
            v = admin_view(dict(x))
            v.pop("email")
            out.append(v)
        return out


async def project_for_admin(ctx, pid: Any) -> dict | None:
    if not is_integer(pid) or pid <= 0 or pid > BIGINT_MAX:
        return None
    row = await get_row(ctx, int(pid))
    return admin_view(row) if row is not None else None


async def project_counts(ctx) -> dict[str, int]:
    async with ctx.db.session() as s:

        async def n(sql: str) -> int:
            return int((await s.execute(text(f"SELECT COUNT(*) FROM projects WHERE {sql}"))).scalar_one())

        return {"pending": await n(FILTER_SQL["pending"]), "changes": await n(FILTER_SQL["changes"]), "approved": await n(FILTER_SQL["approved"])}
