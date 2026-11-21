"""P2b 시험 도구: 시험마다 새 PostgreSQL DB + 비운 Redis DB 번호 + 임시 DATA_DIR로 AppContext를 만듭니다.

PostgreSQL · Redis가 없으면 건너뜁니다 (SHRINE_TEST_PG, SHRINE_TEST_REDIS_BASE — 기본 개발용 컨테이너, Redis는 DB 14번 (P2b HTTP 비교 시험과 같은 번호, 같은 pytest에서 차례로 돎):
적합성 시험은 1~12, app pytest의 다른 시험은 13, P2a 비교 시험은 15).
"""

from __future__ import annotations

import base64
import os
import secrets
import struct
import zlib
from contextlib import asynccontextmanager
from pathlib import Path

import pytest

PG_ADMIN = os.environ.get("SHRINE_TEST_PG", "postgresql://postgres:dev@127.0.0.1:55432/postgres")
REDIS_BASE = os.environ.get("SHRINE_TEST_REDIS_BASE", "redis://127.0.0.1:56379")
TICKET_SECRET = "p2b-test-secret-9f2c71e04ab8d35c6e19f0a7b42d8c53"


@asynccontextmanager
async def fresh_ctx(tmp: Path, redis_db: int = 14, **env: str):
    import asyncpg
    from sqlalchemy.engine import make_url

    from shrine import redis as shrine_redis
    from shrine.config import load_config
    from shrine.context import AppContext
    from shrine.db.engine import Database
    from shrine.storage import UploadStore

    try:
        admin = await asyncpg.connect(PG_ADMIN, timeout=3)
    except Exception:
        pytest.skip("PostgreSQL이 없어 건너뜁니다")
    name = f"shrine_p2b_{secrets.token_hex(4)}"
    await admin.execute(f"CREATE DATABASE {name}")
    url = make_url(PG_ADMIN).set(drivername="postgresql+asyncpg", database=name).render_as_string(hide_password=False)
    redis_url = f"{REDIS_BASE}/{redis_db}"
    result = load_config(
        {"DATABASE_URL": url, "REDIS_URL": redis_url, "DATA_DIR": str(tmp), "GITHUB_CHECK": "off",
         "TICKET_SECRET": TICKET_SECRET, **env}
    )  # fmt: skip
    assert not result.fatal, result.fatal
    ctx = AppContext(config=result.config)
    ctx.uploads = UploadStore(str(tmp))
    ctx.uploads.prepare()
    ctx.db = Database(url)
    ctx.redis = shrine_redis.connect(redis_url)
    try:
        try:
            await ctx.redis.ping()
        except Exception:
            pytest.skip("Redis가 없어 건너뜁니다")
        await ctx.redis.flushdb()
        await ctx.db.migrate()
        yield ctx
    finally:
        try:
            await ctx.redis.flushdb()
        except Exception:
            pass
        await ctx.redis.aclose()
        await ctx.db.dispose()
        await admin.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")
        await admin.close()


# ── 이미지 만들기 (s2.test.mjs와 같은 모양) ──


def png_chunk(typ: str, data: bytes) -> bytes:
    td = typ.encode("latin-1") + data
    return struct.pack(">I", len(data)) + td + struct.pack(">I", zlib.crc32(td) & 0xFFFFFFFF)


def png(w: int, h: int, extra: list[bytes] = (), tail: bytes = b"") -> bytes:
    ihdr = struct.pack(">II", w, h) + bytes([8, 2, 0, 0, 0])
    raw = bytes((w * 3 + 1) * h)
    return (
        b"\x89PNG\r\n\x1a\n" + png_chunk("IHDR", ihdr) + b"".join(extra) + png_chunk("IDAT", zlib.compress(raw))
        + png_chunk("IEND", b"") + tail
    )  # fmt: skip


def seg(marker: int, data: bytes) -> bytes:
    return bytes([0xFF, marker]) + struct.pack(">H", len(data) + 2) + data


def jpeg(w: int, h: int, segments: list[bytes] | None = None, *, sof: int = 0xC0, tail: bytes = b"") -> bytes:
    sofd = bytes([8]) + struct.pack(">HH", h, w) + bytes([1, 1, 0x11, 0])
    if segments is None:
        segments = [
            seg(0xE0, b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0"),
            seg(0xE1, b"Exif\0\0GPS-LAT-37.5665-SECRET"),
            seg(0xFE, b"COMMENT-SECRET"),
        ]
    return (
        b"\xff\xd8" + b"".join(segments) + seg(sof, sofd) + seg(0xDA, bytes([1, 1, 0, 0, 0x3F, 0])) + b"\x12\x34\x56\xff\xd9" + tail
    )


def riff_chunk(cc: str, d: bytes) -> bytes:
    return cc.encode("latin-1") + struct.pack("<I", len(d)) + d + (b"\0" if len(d) & 1 else b"")


def webp(w: int, h: int, chunks: list[bytes] | None = None, flags: int = 0x08) -> bytes:
    vp8x = bytes([flags, 0, 0, 0]) + (w - 1).to_bytes(3, "little") + (h - 1).to_bytes(3, "little")
    if chunks is None:
        chunks = [riff_chunk("VP8L", bytes([0x2F, 0, 0, 0, 0])), riff_chunk("EXIF", b"GPS-WEBP-SECRET")]
    body = riff_chunk("VP8X", vp8x) + b"".join(chunks)
    return b"RIFF" + struct.pack("<I", 4 + len(body)) + b"WEBP" + body


def ticket(sid: str, nick: str = "새벽의 러버덕 42", secret: str = TICKET_SECRET, exp: int | None = None) -> str:
    from shrine.logic.crypto import sign_ticket
    from shrine.logic.util import now_ms

    t = {"sid": sid, "look": [0, 1, 0, 0, 1, 1, 1, 2, 0, 0, 0, 0], "nick": nick, "exp": exp or now_ms() + 3 * 3600_000}
    return sign_ticket(t, secret)


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()
