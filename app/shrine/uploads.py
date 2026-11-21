"""등록소 이미지 (server/uploads.ts).

  · 5MB까지, PNG · JPEG · WebP만 (파일 앞부분으로 형식 · 가로 · 세로를 읽음, 16~8000px)
  · 위치 정보(EXIF) · XMP · 글 메타데이터를 바이트 구조만 보고 지운 뒤 저장 (디코드 · 다시 인코딩 없음.
    PNG · WebP는 Node와 같은 바이트, JPEG는 SOS 뒤도 읽어 더 지움: _strip_jpeg)
  · DATA_DIR/uploads/<무작위 16자>.<png|jpg|webp>. 올린 뒤 1시간 안에 접수 · 수정에 붙여야 하고, 접수 · 사당 어디에도
    안 쓰인 채 1시간(+5분 여유)이 지난 파일은 15분마다 지움 (붙은 것 · 검토 대기인 것은 남김)
  · 누구나 받는 것은 맵에 떠 있는 사당의 이미지뿐. 검토 대기 이미지는 올린 사람(24시간) · 관리 비밀번호로 연 사람(3시간)
    · 운영자에게만 캐시하지 말라는 표시를 붙여 보냄

Node가 프로세스 메모리에 두던 것 → Redis (모두 만료가 붙음, IP는 그날 해시로만):
  shrine:up:sid:<sid>               ZSET  올린 시각(ms) — 1시간 10장 (PX 1h)
  shrine:up:ip:<KST날짜>:<IP해시>    STR   그날 올린 수 — 하루 30장 (PX 26h)
  shrine:up:ipbytes:<KST날짜>:<IP해시> STR  그날 저장한 바이트 — 하루 100MB (PX 26h)
  shrine:up:owner:<파일>             STR   {"sid","at"} 누가 올렸는지 (PX 24h): 접수에 붙이기 · 올린 사람 미리 보기
  shrine:up:grant:<sid>             SET   관리 비밀번호로 연 접수의 검토 대기 이미지 (PX 3h, 새로 허락하면 다시 3h)
  shrine:rl:upload-try:<IP해시>       STR   시도 횟수 — 10분 20번, 형식이 틀린 것도 셈 (FixedWindowLimiter)
동시 업로드 수 · 폴더 합계 · 80% 알림 표시는 이 프로세스의 UploadStore(storage.py)에.

보안 점검으로 Node와 일부러 다르게 둔 곳: 최대 10MB → 5MB, IP(/64)당 하루 100MB, 안 쓰인 파일 24시간 → 1시간,
JPEG 메타데이터 지우기(스캔 사이 APPn · COM, EOI 뒤 꼬리). 저장 공간(2GB)을 하루 만에 채우지 못하게.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import re
import secrets
import struct
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from typing import Any

from sqlalchemy import text

from . import notify as notify_mod
from .logic.jsnum import JSONParseError, json_parse, json_stringify
from .logic.util import kst_date, now_ms
from .redis import FixedWindowLimiter, key
from .shrines import all_shrines
from .storage import MIN_FREE, TOTAL_MAX

log = logging.getLogger("shrine.uploads")

UPLOAD_MAX = 5 * 1024 * 1024
#: 저장 이름: 무작위 16자 + 확장자
UPLOAD_NAME_RE = re.compile(r"[A-Za-z0-9_-]{16}\.(?:png|jpg|webp)")
TYPES = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}
PER_SID_HOUR = 10
PER_IP_DAY = 30
#: IP(/64)당 하루 저장 바이트 (메타데이터를 뺀 크기로 셈)
PER_IP_DAY_BYTES = 100 * 1024 * 1024
HOUR_MS = 3600_000
#: 올린 뒤 이 안에 접수 · 수정에 붙여야 합니다 (안 붙인 파일은 storage.ORPHAN_MS 뒤 지워짐)
ATTACH_MS = HOUR_MS
#: 누가 올렸는지 기록(owner)의 수명 · 올린 사람 미리 보기 (붙인 뒤 검토 대기 이미지를 올린 사람이 보는 시간)
OWNER_MS = 24 * HOUR_MS
GRANT_MS = 3 * 3600_000
DAY_KEY_TTL_MS = 26 * 3600_000
TRY_LIMIT = 20
TRY_WINDOW_MS = 10 * 60_000

#: 실패 까닭 → HTTP 상태 (http.ts UPLOAD_STATUS, 그 밖은 400)
UPLOAD_STATUS = {"size": 413, "slow": 429, "many": 429, "busy": 429, "full": 503}


def is_upload_name(v: Any) -> bool:
    return isinstance(v, str) and UPLOAD_NAME_RE.fullmatch(v) is not None


# ── 형식 · 크기 ─────────────────────────────────────────────────────


def _ascii(b: bytes, start: int, end: int) -> str:
    """Node buf.toString('ascii', a, b): 각 바이트의 맨 위 비트를 끄고 latin1로."""
    return bytes(x & 0x7F for x in b[start:end]).decode("latin-1")


def _latin1(b: bytes, start: int, end: int) -> str:
    return b[start:end].decode("latin-1")


def _u32be(b: bytes, i: int) -> int:
    return struct.unpack_from(">I", b, i)[0]


def _u16be(b: bytes, i: int) -> int:
    return struct.unpack_from(">H", b, i)[0]


def _u32le(b: bytes, i: int) -> int:
    return struct.unpack_from("<I", b, i)[0]


def _u16le(b: bytes, i: int) -> int:
    return struct.unpack_from("<H", b, i)[0]


def _u24le(b: bytes, i: int) -> int:
    if i + 3 > len(b):
        raise struct.error("범위 밖")
    return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)


def sniff_image(b: bytes) -> tuple[str, int, int] | None:
    """uploads.ts sniffImage: (확장자, 가로, 세로) 또는 None."""
    if len(b) > 24 and _u32be(b, 0) == 0x89504E47 and _u32be(b, 4) == 0x0D0A1A0A:
        return "png", _u32be(b, 16), _u32be(b, 20)
    if len(b) > 4 and b[0] == 0xFF and b[1] == 0xD8 and b[2] == 0xFF:
        i = 2
        while i + 9 < len(b):
            if b[i] != 0xFF:
                i += 1
                continue
            marker = b[i + 1]
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            length = _u16be(b, i + 2)
            # SOF0~SOF15 (DHT · JPG · DAC 빼고)에 크기가 있습니다
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                return "jpg", _u16be(b, i + 7), _u16be(b, i + 5)
            i += 2 + length
        return None
    if len(b) > 30 and _ascii(b, 0, 4) == "RIFF" and _ascii(b, 8, 12) == "WEBP":
        kind = _ascii(b, 12, 16)
        if kind == "VP8X":
            return "webp", 1 + _u24le(b, 24), 1 + _u24le(b, 27)
        if kind == "VP8L":
            bits = _u32le(b, 21)
            return "webp", 1 + (bits & 0x3FFF), 1 + ((bits >> 14) & 0x3FFF)
        if kind == "VP8 ":
            return "webp", _u16le(b, 26) & 0x3FFF, _u16le(b, 28) & 0x3FFF
    return None


# ── 메타데이터 지우기 (uploads.ts:88-174) ─────────────────────────────

#: PNG: 위치 · 시각 · 글 조각
PNG_DROP = frozenset({"eXIf", "tEXt", "iTXt", "zTXt", "tIME"})
_PNG_TYPE = re.compile(r"[A-Za-z]{4}")


def _strip_png(b: bytes) -> bytes | None:
    out = [b[0:8]]
    i = 8
    while i + 12 <= len(b):
        length = _u32be(b, i)
        typ = _latin1(b, i + 4, i + 8)
        end = i + 12 + length
        if not _PNG_TYPE.fullmatch(typ) or length > 0x7FFFFFFF or end > len(b):
            return None
        if typ not in PNG_DROP:
            out.append(b[i:end])
        i = end
        if typ == "IEND":
            return b"".join(out)
    return None


def _skip_scan(b: bytes, i: int) -> int | None:
    """SOS 뒤 압축 데이터의 끝 (다음 표지의 0xFF 자리). 0xFF 00(채움) · 0xFF D0~D7(RST)은 데이터로 봅니다.
    표지 앞의 0xFF 여러 개(채움)는 마지막 하나 자리를 돌려줍니다. 표지 없이 끝나면 None."""
    n = len(b)
    while True:
        k = b.find(b"\xff", i)
        if k < 0:
            return None
        m = k + 1
        while m < n and b[m] == 0xFF:
            m += 1
        if m >= n:
            return None
        code = b[m]
        if code == 0x00 or 0xD0 <= code <= 0xD7:
            i = m + 1
            continue
        return m - 1


def _strip_jpeg(b: bytes) -> bytes | None:
    """APP0(JFIF) · APP2(ICC) · APP14(Adobe)만 두고 다른 APPn(APP1 EXIF · XMP 포함) · 주석(COM)을 뺍니다.

    보안 점검 (Node와 일부러 다름): Node는 첫 SOS부터 끝까지 그대로 두어, 스캔 사이의 APPn · COM과 EOI 뒤에 붙은 것
    (MPF 두 번째 이미지 · 모션 포토 MP4 · 삼성 SEFT 꼬리 등)이 남았습니다. 여기서는 압축 데이터 뒤에도 표지를 계속 읽어
    첫 SOS 뒤의 APPn · COM은 모두 빼고, EOI에서 멈춰 그 뒤를 버립니다. EOI 없이 끝나거나 SOS 뒤 구조가 깨졌으면 None.
    """
    if len(b) < 2 or b[0] != 0xFF or b[1] != 0xD8:
        return None
    out = [b[0:2]]
    i = 2
    scanned = False
    while i + 1 < len(b):
        if b[i] != 0xFF:
            return None
        marker = b[i + 1]
        if marker == 0xFF:
            i += 1
            continue
        if marker == 0xD9:
            out.append(b"\xff\xd9")
            return b"".join(out)
        if marker == 0x01 or 0xD0 <= marker <= 0xD7:
            out.append(b[i : i + 2])
            i += 2
            continue
        if i + 4 > len(b):
            return None
        length = _u16be(b, i + 2)
        end = i + 2 + length
        if length < 2 or end > len(b):
            return None
        app = 0xE0 <= marker <= 0xEF
        if scanned:
            drop = app or marker == 0xFE
        else:
            drop = (app and marker not in (0xE0, 0xE2, 0xEE)) or marker == 0xFE
        if not drop:
            out.append(b[i:end])
        i = end
        if marker == 0xDA:
            scanned = True
            stop = _skip_scan(b, i)
            if stop is None:
                return None
            out.append(b[i:stop])
            i = stop
    return None


def _strip_webp(b: bytes) -> bytes | None:
    """EXIF · XMP 조각을 빼고 VP8X 표시 비트(0x0C)를 끄고 RIFF 크기를 다시 셉니다 (홀수 채움은 그대로)."""
    if len(b) < 20 or _ascii(b, 0, 4) != "RIFF" or _ascii(b, 8, 12) != "WEBP":
        return None
    riff_end = min(len(b), 8 + _u32le(b, 4))
    chunks: list[bytes] = []
    i = 12
    while i + 8 <= riff_end:
        fourcc = _latin1(b, i, i + 4)
        size = _u32le(b, i + 4)
        data_end = i + 8 + size
        if data_end > riff_end:
            return None
        end = min(riff_end, data_end + (size & 1))
        if fourcc not in ("EXIF", "XMP "):
            chunk = b[i:end]
            if fourcc == "VP8X" and len(chunk) > 8:
                c = bytearray(chunk)
                c[8] &= ~0x0C & 0xFF
                chunk = bytes(c)
            chunks.append(chunk)
        i = end
    if not chunks:
        return None
    body = b"".join(chunks)
    if 4 + len(body) > 0xFFFFFFFF:
        return None  # Node writeUInt32LE가 RangeError → null
    return b"RIFF" + struct.pack("<I", 4 + len(body)) + b"WEBP" + body


def strip_metadata(b: bytes, ext: str) -> bytes | None:
    """메타데이터를 뺀 사본. 구조가 깨진 파일이면 None."""
    try:
        if ext == "png":
            return _strip_png(b)
        if ext == "jpg":
            return _strip_jpeg(b)
        return _strip_webp(b)
    except (struct.error, IndexError, ValueError):
        return None


def clean_image(buf: bytes) -> tuple[str, bytes] | str:
    """검사 + 메타데이터 지우기: (확장자, 깨끗한 바이트) 또는 실패 까닭('bad' · 'type')."""
    if len(buf) == 0:
        return "bad"
    try:
        img = sniff_image(buf)
    except (struct.error, IndexError):
        img = None
    if img is None or img[1] < 16 or img[2] < 16 or img[1] > 8000 or img[2] > 8000:
        return "type"
    ext = img[0]
    clean = strip_metadata(buf, ext)
    if clean is None:
        return "type"
    try:
        again = sniff_image(clean)
    except (struct.error, IndexError):
        again = None
    if again is None or again[0] != ext:
        return "type"
    return ext, clean


# ── Redis 상태 ───────────────────────────────────────────────────────


def _owner_key(name: str) -> str:
    return key("up", "owner", name)


def _sid_key(sid: str) -> str:
    return key("up", "sid", sid or "-")


def _ip_key(day: str, ip_key: str) -> str:
    return key("up", "ip", day, ip_key or "-")


def _grant_key(sid: str) -> str:
    return key("up", "grant", sid)


def _ip_bytes_key(day: str, ip_key: str) -> str:
    return key("up", "ipbytes", day, ip_key or "-")


# 할당량 확인 + 기록을 한 번에 (동시 업로드 3개가 같이 와도 한도를 넘지 않게)
_RESERVE_LUA = """
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[5]))
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 'slow' end
local n = tonumber(redis.call('GET', KEYS[2]) or '0')
if n >= tonumber(ARGV[4]) then return 'many' end
local used = tonumber(redis.call('GET', KEYS[3]) or '0')
if used + tonumber(ARGV[7]) > tonumber(ARGV[8]) then return 'many' end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], ARGV[6])
redis.call('INCRBY', KEYS[3], ARGV[7])
redis.call('PEXPIRE', KEYS[3], ARGV[6])
return 'ok'
"""

_RELEASE_LUA = """
redis.call('ZREM', KEYS[1], ARGV[1])
local n = tonumber(redis.call('GET', KEYS[2]) or '0')
if n > 0 then redis.call('DECR', KEYS[2]) end
local used = tonumber(redis.call('GET', KEYS[3]) or '0')
if used > 0 then redis.call('DECRBY', KEYS[3], math.min(used, tonumber(ARGV[2]))) end
return 1
"""


@dataclass
class _State:
    try_limiter: FixedWindowLimiter
    reserve: Any
    release: Any
    reviewer: Callable[[Any], Awaitable[bool] | bool] | None = None


def _state(ctx) -> _State:
    st = getattr(ctx, "_p2b_uploads", None)
    if st is None or st.try_limiter.client is not ctx.redis:
        st = _State(
            try_limiter=FixedWindowLimiter(ctx.redis, "upload-try", TRY_LIMIT, TRY_WINDOW_MS),
            reserve=ctx.redis.register_script(_RESERVE_LUA),
            release=ctx.redis.register_script(_RELEASE_LUA),
            reviewer=st.reviewer if st is not None else None,
        )
        ctx._p2b_uploads = st
    return st


def set_reviewer_check(ctx, fn: Callable[[Any], Awaitable[bool] | bool]) -> None:
    """운영자 화면(P4)이 "이 요청은 로그인한 운영자(+허용 IP)"인지 알려 주는 함수를 넣습니다 (uploads.ts setReviewerCheck).
    넣으면 검토 대기 이미지를 운영자 화면에서도 볼 수 있습니다. fn(request) → bool (async 가능)."""
    _state(ctx).reviewer = fn


async def _quota_fail(ctx, sid: str, ip_key: str, now: int) -> str | None:
    r = ctx.redis
    recent = await r.zcount(_sid_key(sid), f"({now - HOUR_MS}", "+inf")
    if recent >= PER_SID_HOUR:
        return "slow"
    day = kst_date(now)
    n = await r.get(_ip_key(day, ip_key))
    if n is not None and int(n) >= PER_IP_DAY:
        return "many"
    used = await r.get(_ip_bytes_key(day, ip_key))
    if used is not None and int(used) >= PER_IP_DAY_BYTES:
        return "many"
    return None


def _mb(n: float) -> int:
    from .jscompat import js_round

    return js_round(n / 1024 / 1024)


def _warn_full(ctx) -> None:
    store = ctx.uploads
    now = now_ms()
    if now - store.full_warned_at < HOUR_MS:
        return
    store.full_warned_at = now
    free = store.free_bytes()
    notify_mod.notify(
        "이미지 업로드를 받지 못함 (용량)",
        {
            "업로드 폴더(MB)": _mb(store.total_bytes),
            "상한(MB)": _mb(TOTAL_MAX),
            "디스크 여유(MB)": _mb(free) if free != float("inf") else "알 수 없음",
        },
    )


def check_capacity(ctx) -> None:
    """80%를 넘으면 한 번 알리고, 70% 밑으로 내려가면 다시 알릴 수 있게 (uploads.ts checkCapacity)."""
    store = ctx.uploads
    if not store.cap_warned and store.total_bytes >= TOTAL_MAX * 0.8:
        store.cap_warned = True
        notify_mod.notify("이미지 업로드 폴더 80% 넘음", {"사용(MB)": _mb(store.total_bytes), "상한(MB)": _mb(TOTAL_MAX)})
    elif store.cap_warned and store.total_bytes < TOTAL_MAX * 0.7:
        store.cap_warned = False


class Slot:
    """beginUpload가 잡은 동시 업로드 자리. done()을 꼭 부릅니다 (두 번 불러도 한 번만 돌려줌)."""

    def __init__(self, store) -> None:
        self._store = store
        self._released = False

    def done(self) -> None:
        if not self._released:
            self._released = True
            self._store.end()


async def begin_upload(ctx, sid: str, ip_key: str) -> Slot | str:
    """본문을 읽기 전 확인 (uploads.ts beginUpload): 시도 횟수 → 할당량 → 용량 → 동시 업로드 수. 실패면 까닭."""
    st = _state(ctx)
    if not await st.try_limiter.allow(ip_key):
        return "slow"
    q = await _quota_fail(ctx, sid, ip_key, now_ms())
    if q:
        return q
    store = ctx.uploads
    if store.no_room(0):
        _warn_full(ctx)
        return "full"
    if not store.try_begin():
        return "busy"
    return Slot(store)


def new_upload_name(ext: str) -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(12)).decode("ascii").rstrip("=") + "." + ext


async def save_upload(ctx, buf: bytes | None, sid: str, ip_key: str, *, quotas: bool = True) -> dict[str, Any]:
    """uploads.ts saveUpload: {ok: True, id} 또는 {ok: False, reason}.

    quotas=False: 할당량을 세지도 기록하지도 않음 (운영 명령 upload — Node는 프로세스마다 새 메모리라 사실상 제한이 없었음).
    누가 올렸는지(owner)는 언제나 남깁니다.
    """
    if buf is None:
        return {"ok": False, "reason": "size"}
    checked = clean_image(buf)
    if isinstance(checked, str):
        return {"ok": False, "reason": checked}
    ext, clean = checked
    now = now_ms()
    r = ctx.redis
    st = _state(ctx) if quotas else None
    store = ctx.uploads
    if quotas:
        q = await _quota_fail(ctx, sid, ip_key, now)
        if q:
            return {"ok": False, "reason": q}
    if store.no_room(len(clean)):
        _warn_full(ctx)
        return {"ok": False, "reason": "full"}
    name = new_upload_name(ext)
    member = f"{now}:{name}"
    day = kst_date(now)
    sid_key, ip_day_key, ip_bytes_key = _sid_key(sid), _ip_key(day, ip_key), _ip_bytes_key(day, ip_key)
    if quotas:
        got = await st.reserve(
            keys=[sid_key, ip_day_key, ip_bytes_key],
            args=[now, member, PER_SID_HOUR, PER_IP_DAY, HOUR_MS, DAY_KEY_TTL_MS, len(clean), PER_IP_DAY_BYTES],
        )
        got = got.decode() if isinstance(got, bytes) else str(got)
        if got != "ok":
            return {"ok": False, "reason": got}
    try:
        await asyncio.to_thread(store.write_new, name, clean)
    except BaseException:
        if quotas:
            await st.release(keys=[sid_key, ip_day_key, ip_bytes_key], args=[member, len(clean)])
        raise
    check_capacity(ctx)
    if r is not None:
        await r.set(_owner_key(name), json_stringify({"sid": sid, "at": now}), px=OWNER_MS)
    return {"ok": True, "id": name}


async def _owner(ctx, name: str) -> dict[str, Any] | None:
    raw = await ctx.redis.get(_owner_key(name))
    if raw is None:
        return None
    try:
        v = json_parse(raw.decode("utf-8") if isinstance(raw, bytes) else raw)
    except (JSONParseError, UnicodeDecodeError):
        return None
    return v if isinstance(v, dict) else None


async def owns_upload(ctx, name: Any, sid: str) -> bool:
    """이 사람이 1시간 안에 올린 파일인가 (접수 · 수정에 붙일 수 있는지). 안 붙인 파일은 그 뒤 지워집니다."""
    if not is_upload_name(name):
        return False
    o = await _owner(ctx, name)
    return o is not None and o.get("sid") == sid and now_ms() - int(o.get("at") or 0) < ATTACH_MS


async def grant_upload_view(ctx, sid: str, names: Iterable[Any]) -> None:
    """관리 비밀번호로 접수를 연 사람(입장 표)에게 그 접수의 검토 대기 이미지를 3시간 보여 줍니다."""
    if not sid:
        return
    ids = [x for x in names if is_upload_name(x)]
    if not ids:
        return
    k = _grant_key(sid)
    async with ctx.redis.pipeline(transaction=True) as p:
        p.sadd(k, *ids)
        p.pexpire(k, GRANT_MS)
        await p.execute()


async def is_public_upload(ctx, name: str) -> bool:
    """맵에 떠 있는(검증 통과) 사당의 이미지인가."""
    want = f"up/{name}"
    for s in await all_shrines(ctx):
        if want in s.get("screens", ()):
            return True
    return False


async def can_see_private(ctx, request, name: str, sid: str | None) -> bool:
    now = now_ms()
    if sid:
        o = await _owner(ctx, name)
        if o is not None and o.get("sid") == sid and now - int(o.get("at") or 0) < OWNER_MS:
            return True
        if await ctx.redis.sismember(_grant_key(sid), name):
            return True
    fn = _state(ctx).reviewer
    if fn is None:
        return False
    try:
        v = fn(request)
        if asyncio.iscoroutine(v) or isinstance(v, Awaitable):
            v = await v
        return bool(v)
    except Exception:  # noqa: BLE001
        return False


# ── 정리 ─────────────────────────────────────────────────────────────


async def shrine_images(s) -> set[str]:
    """사당(맵에 있든 없든)이 쓰는 업로드 이미지 이름 (uploads.ts shrineImages)."""
    used: set[str] = set()
    for (screens,) in await s.execute(text("SELECT screens FROM shrines")):
        try:
            v = json_parse(screens)
        except (JSONParseError, TypeError):
            continue
        if isinstance(v, list):
            for f in v:
                if isinstance(f, str) and f.startswith("up/"):
                    used.add(f[3:])
    return used


async def remove_uploads(ctx, names: Iterable[Any]) -> int:
    """파기: 이 이미지들을 바로 지웁니다 (retention). 사당이나 다른 접수가 아직 쓰는 파일은 남깁니다.
    부르기 전에 그 접수의 screen · pending_screen을 먼저 비워 두세요(커밋까지). 지운 개수."""
    wanted = list(dict.fromkeys(names))
    if not wanted:
        return 0
    async with ctx.db.session() as s:
        in_shrine = await shrine_images(s)
        removable = []
        for name in wanted:
            if not is_upload_name(name) or name in in_shrine:
                continue
            r = await s.execute(
                text("SELECT 1 FROM projects WHERE screen = :n OR pending_screen = :n LIMIT 1"), {"n": name}
            )
            if r.first() is None:
                removable.append(name)
    n = 0
    for name in removable:
        # 지우기 전에 '누가 올렸는지'부터 지워서 그 사이에 다른 접수에 붙지 않게 합니다
        if ctx.redis is not None:
            try:
                await ctx.redis.delete(_owner_key(name))
            except Exception:  # noqa: BLE001
                log.warning("[shrine] 업로드 소유 기록을 지우지 못했습니다 (Redis)")
        if await asyncio.to_thread(ctx.uploads.remove, name):
            n += 1
    return n


def _is_operator(sid: Any) -> bool:
    """운영 명령(cli) · 운영자 화면(admin:<세션>)이 올린 것."""
    return isinstance(sid, str) and (sid == "cli" or sid.startswith("admin:"))


async def _operator_uploads(ctx, used: set[str]) -> set[str]:
    """운영자가 올린 지 24시간이 안 된 파일 (사당 JSON에 손으로 붙일 시간을 줍니다. 방문자 업로드만 1시간)."""
    if ctx.redis is None:
        return set()
    import os

    names = [n for n in await asyncio.to_thread(os.listdir, ctx.uploads.dir) if n not in used and is_upload_name(n)]
    keep: set[str] = set()
    now = now_ms()
    for i in range(0, len(names), 500):
        part = names[i : i + 500]
        for name, raw in zip(part, await ctx.redis.mget([_owner_key(n) for n in part]), strict=True):
            if raw is None:
                continue
            try:
                o = json_parse(raw.decode("utf-8") if isinstance(raw, bytes) else raw)
            except (JSONParseError, UnicodeDecodeError):
                continue
            if isinstance(o, dict) and _is_operator(o.get("sid")) and now - int(o.get("at") or 0) < OWNER_MS:
                keep.add(name)
    return keep


async def cleanup_uploads(ctx) -> int:
    """접수 · 사당 어디에도 안 쓰인 지 1시간(+5분) 넘은 파일 지우기 (시작할 때 + 15분 · 6시간마다). 지운 개수.
    운영자(운영 명령 · 운영자 화면)가 올린 것은 24시간까지 남깁니다 (_operator_uploads).
    반려 · 내린 접수의 이미지는 파기(30일) 때까지 남깁니다 (projects.screen에 남아 있으므로)."""
    async with ctx.db.session() as s:
        used = await shrine_images(s)
        for screen, pending in await s.execute(text("SELECT screen, pending_screen FROM projects")):
            if screen:
                used.add(screen)
            if pending:
                used.add(pending)
    used |= await _operator_uploads(ctx, used)
    n = await asyncio.to_thread(ctx.uploads.remove_orphans, used, now_ms())
    check_capacity(ctx)
    # 할당량 · 소유 · 보기 허락은 Redis 만료로 저절로 정리됩니다
    return n


__all__ = [
    "MIN_FREE",
    "PER_IP_DAY",
    "PER_IP_DAY_BYTES",
    "PER_SID_HOUR",
    "TYPES",
    "UPLOAD_MAX",
    "UPLOAD_NAME_RE",
    "UPLOAD_STATUS",
    "Slot",
    "begin_upload",
    "can_see_private",
    "check_capacity",
    "clean_image",
    "cleanup_uploads",
    "grant_upload_view",
    "is_public_upload",
    "is_upload_name",
    "owns_upload",
    "remove_uploads",
    "save_upload",
    "set_reviewer_check",
    "sniff_image",
    "strip_metadata",
]
