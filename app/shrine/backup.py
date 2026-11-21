"""백업 · 복구 도구 (server/backup.ts의 PostgreSQL판).

  · 백업 하나는 tar 파일 하나입니다: db.dump(pg_dump 사용자 지정 형식, -Fc) + uploads/(등록소 이미지) +
    manifest.json(표별 행 수 · 이미지 수 · 파일별 SHA-256).
  · 표별 행 수는 db.dump 안의 데이터를 직접 풀어 셉니다 (pg_dump가 뜬 그 시점의 수). 그래서 verify는 pg_restore 없이도
    db.dump가 끝까지 읽히는지(압축 · 구조), 행 수 · 이미지 수 · SHA-256이 만들 때와 같은지 봅니다.
  · BACKUP_DIR에 shrine-YYYYMMDD-HHMMSSZ.tar(UTC) 이름으로 둡니다. 만들 때마다 오래된 것을 지웁니다 (먼저 걸리는 쪽):
      - 최근 BACKUP_KEEP개(기본 14)까지만
      - 만든 지 BACKUP_MAX_DAYS - 1일(기본 13일)이 지난 것. 매일 돌리면 어떤 백업도 BACKUP_MAX_DAYS일(기본 14일)을
        넘겨 남지 않습니다. 개인정보 처리방침에 적은 보관 기간이므로 늘리려면 처리방침도 같이 고칩니다.
  · 백업에는 이메일 같은 개인정보가 들어 있어서 파일은 만든 사용자만 읽을 수 있게(600) 만듭니다.
  · (선택, 보안 점검) BACKUP_SIGNING_KEY가 있으면 manifest.json의 HMAC-SHA256을 manifest.sig로 같이 넣고, verify ·
    restore는 그 키로 서명을 확인합니다 (없거나 틀리면 멈춤). manifest의 SHA-256은 백업 안에서만 맞춰 보는 값이라,
    앱이 뚫려 백업 폴더에 가짜 백업을 넣는 경우를 막으려면 이 키를 앱 .env가 아니라 운영자만 아는 곳에 둡니다.

    python -m shrine.backup [--env-file ../.env] [명령]
    create [--dump <파일>|-]           지금 백업 하나 (기본 명령). --dump: pg_dump -Fc 결과를 파일 · 표준 입력에서 받음
                                       (없으면 PG_DUMP 명령 또는 pg_dump --format=custom DATABASE_URL을 직접 돌림)
    list                               백업 목록 (만든 때 · 지난 날수)
    prune                              만들지 않고 정리만
    verify <파일>                       백업 검사
    restore <파일> [폴더] [--force]      되살리기: 서버를 멈춘 뒤에만. 지금 DB(pg_dump)와 이미지는 지우지 않고
                                       폴더(기본 DATA_DIR)의 pre-restore-<시각>Z/로 옮긴 뒤 pg_restore --clean으로 바꿔 넣음
          --db-to <파일>|-              DB만: 검사한 db.dump를 파일 · 표준 출력으로 내보냄 (pg_restore는 부르는 쪽이, Docker용)
          --uploads-only               이미지만 되살림 (Docker에서 DB를 따로 되살린 뒤)

Docker(deploy/docker-compose.py.yml)에서는 앱 컨테이너에 pg_dump가 없어서 postgres 컨테이너의 pg_dump와 파이프로 잇습니다
(결정 D8: 호스트 cron + pg_dump). 명령은 deploy/README.md의 'Python 서버(이전 후)'에 있습니다.

설정: DATA_DIR(기본 ./data) · BACKUP_DIR(기본 ./backups) · BACKUP_KEEP(14) · BACKUP_MAX_DAYS(14) · DATABASE_URL ·
PG_DUMP · PG_RESTORE(명령을 통째로 바꿈, 예: "docker exec -i pg pg_dump -U shrine -d shrine -Fc").
config.py는 불러오지 않습니다 (Node와 같이: 운영 설정이 비어 있거나 틀렸을 때도 백업 · 복구는 돌아야 함).
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import json
import os
import platform
import re
import secrets
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import zlib
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import IO, Any, BinaryIO

DUMP_NAME = "db.dump"
UPLOADS = "uploads"
MANIFEST = "manifest.json"
#: BACKUP_SIGNING_KEY가 있을 때만: "hmac-sha256:<16진>" (manifest.json 바이트 그대로의 HMAC)
SIG_NAME = "manifest.sig"
FORMAT = "musabaepo-shrine-backup"
#: 1 = Node(SQLite) 서버의 백업, 2 = 이 도구 (PostgreSQL pg_dump)
VERSION = 2
NAME_RE = re.compile(r"shrine-([0-9]{8}-[0-9]{6})Z(?:-([0-9]+))?\.tar")
SAFE_NAME_RE = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}")
STALE_RE = re.compile(r"\.(work-|verify-|shrine-.*\.partial$)")
PRE_RESTORE_RE = re.compile(r"pre-restore-[0-9]{8}-[0-9]{6}Z\.dump")
DISK_RESERVE = 256 * 1024 * 1024
STALE_MS = 6 * 3600_000
DAY_MS = 24 * 3600_000
BLOCK = 512
CHUNK = 1 << 20
#: 서버(python -m shrine)와 운영 명령이 DB 연결에 붙이는 이름 (db/engine.py)
SERVER_APP_NAME = "musabaepo-shrine"


class BackupError(Exception):
    pass


@dataclass
class Settings:
    data_dir: Path
    backup_dir: Path
    keep: int
    max_days: int


def _positive_int(name: str, fallback: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    try:
        n = int(raw) if raw else fallback
    except ValueError:
        n = 0
    if not 1 <= n <= 2**53 - 1:
        raise BackupError(f"{name}는 1 이상의 정수여야 합니다")
    return n


def settings() -> Settings:
    return Settings(
        data_dir=Path(os.environ.get("DATA_DIR") or "./data").resolve(),
        backup_dir=Path((os.environ.get("BACKUP_DIR") or "").strip() or "./backups").resolve(),
        keep=_positive_int("BACKUP_KEEP", 14),
        max_days=_positive_int("BACKUP_MAX_DAYS", 14),
    )


def signing_key() -> bytes | None:
    """BACKUP_SIGNING_KEY (없으면 None). 짧으면 멈춥니다."""
    raw = (os.environ.get("BACKUP_SIGNING_KEY") or "").strip()
    if not raw:
        return None
    if len(raw) < 32:
        raise BackupError("BACKUP_SIGNING_KEY는 32자 이상 무작위 값이어야 합니다 (예: openssl rand -hex 32)")
    return raw.encode("utf-8")


def sign_manifest(key: bytes, manifest_raw: bytes) -> str:
    return "hmac-sha256:" + hmac.new(key, manifest_raw, hashlib.sha256).hexdigest()


# ── 작은 도움 함수 ───────────────────────────────────────────────────


def _to_fixed(x: float, digits: int) -> str:
    """JS ``x.toFixed(digits)`` (반올림은 크기 쪽으로 · 같은 거리면 큰 쪽)."""
    return str(Decimal(x).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP))


def size(n: int) -> str:
    if n < 1024 * 1024:
        return f"{max(1, int(Decimal(n / 1024).quantize(Decimal(1), rounding=ROUND_HALF_UP)))}KB"
    return f"{_to_fixed(n / 1024 / 1024, 1)}MB"


def stamp(d: datetime | None = None) -> str:
    """20261117-031500 (UTC)"""
    return (d or datetime.now(UTC)).strftime("%Y%m%d-%H%M%S")


def _iso(d: datetime) -> str:
    """Date.prototype.toISOString (밀리초 3자리 + Z)."""
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"


def _is_inside(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def table_line(tables: dict[str, int]) -> str:
    return " · ".join(f"{k} {v}" for k, v in tables.items()) or "(표 없음)"


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


# ── pg_dump 사용자 지정 형식(-Fc) 읽기 ───────────────────────────────
#
# pg_backup_archiver.c ReadHead · ReadToc와 pg_backup_custom.c를 따라 읽습니다 (보관 형식 1.12 ~ 1.16 = PostgreSQL 10 ~ 17).
# 데이터 블록: [종류 1바이트][dumpId] 뒤에 (길이, 바이트) 조각이 길이 0까지. gzip(zlib) 압축 또는 압축 없음만 셉니다.

K_VERS = {(1, v) for v in range(12, 17)}
BLK_DATA, BLK_BLOBS = 1, 3


@dataclass
class DumpInfo:
    archive: str
    compression: str
    database: str
    server: str
    client: str
    tables: dict[str, int] = field(default_factory=dict)
    #: 덤프가 만드는 표 이름 (TABLE 목차)
    schema_tables: set[str] = field(default_factory=set)


class _Reader:
    def __init__(self, f: BinaryIO) -> None:
        self.f = f
        self.int_size = 4
        self.off_size = 8

    def bytes(self, n: int) -> bytes:
        b = self.f.read(n)
        if len(b) != n:
            raise BackupError("db.dump가 중간에 끊겼습니다")
        return b

    def byte(self) -> int:
        return self.bytes(1)[0]

    def int(self) -> int:
        sign = self.byte()
        raw = self.bytes(self.int_size)
        v = int.from_bytes(raw, "little")
        return -v if sign else v

    def str(self) -> str | None:
        n = self.int()
        if n < 0:
            return None
        if n > 64 * 1024 * 1024:
            raise BackupError("db.dump 구조가 이상합니다 (너무 긴 글자)")
        return self.bytes(n).decode("utf-8", "replace")


def _count_rows(chunks: Iterator[bytes], compressed: bool) -> int:
    """COPY 글자 데이터의 행 수 (끝 표시 '\\.' 줄 앞까지). 한 행 = 한 줄 (줄바꿈은 \\n으로 적혀 있음)."""
    d = zlib.decompressobj() if compressed else None
    rows = 0
    carry = b""
    done = False
    for c in chunks:
        data = d.decompress(c) if d is not None else c
        if done or not data:
            continue
        buf = carry + data
        lines = buf.split(b"\n")
        carry = lines.pop()
        for line in lines:
            if line == b"\\.":
                done = True
                break
            rows += 1
    if d is not None:
        tail = d.flush()
        if not done and tail:
            for line in (carry + tail).split(b"\n")[:-1]:
                if line == b"\\.":
                    done = True
                    break
                rows += 1
        if not d.eof:
            raise BackupError("db.dump의 압축 데이터가 끝까지 풀리지 않습니다 (파일 손상)")
    return rows


def read_dump(f: BinaryIO) -> DumpInfo:
    """db.dump를 앞에서부터 끝까지 읽어 표별 행 수를 셉니다. 형식이 틀리거나 끊겼으면 BackupError."""
    r = _Reader(f)
    if r.f.read(5) != b"PGDMP":
        raise BackupError("db.dump가 pg_dump 사용자 지정 형식(-Fc)이 아닙니다")
    vmaj, vmin, vrev = r.byte(), r.byte(), r.byte()
    if (vmaj, vmin) not in K_VERS:
        raise BackupError(f"이 도구가 모르는 pg_dump 보관 형식입니다 ({vmaj}.{vmin}.{vrev}). PostgreSQL 10~17의 pg_dump로 떠 주세요")
    r.int_size = r.byte()
    r.off_size = r.byte()
    if r.int_size not in (4, 8) or r.off_size not in (4, 8):
        raise BackupError("db.dump 구조가 이상합니다 (정수 크기)")
    fmt = r.byte()
    if fmt != 1:
        raise BackupError("db.dump가 사용자 지정 형식(-Fc)이 아닙니다 (디렉터리 · tar 형식은 받지 않음)")
    if vmin >= 15:
        algo = r.byte()
        compression = {0: "none", 1: "gzip", 2: "lz4", 3: "zstd"}.get(algo, f"#{algo}")
    else:
        compression = "gzip" if r.int() != 0 else "none"
    if compression not in ("none", "gzip"):
        raise BackupError(f"db.dump 압축({compression})은 검사할 수 없습니다. pg_dump -Fc 기본(gzip)으로 떠 주세요")
    for _ in range(7):
        r.int()  # 만든 시각 (초 · 분 · 시 · 일 · 월 · 년 · 서머타임)
    database = r.str() or ""
    server = r.str() or ""
    client = r.str() or ""
    count = r.int()
    if not 0 <= count <= 1_000_000:
        raise BackupError("db.dump 구조가 이상합니다 (목차 수)")
    data_tables: dict[int, str] = {}
    schema_tables: set[str] = set()
    for _ in range(count):
        dump_id = r.int()
        r.int()  # hadDumper
        r.str()  # tableoid
        r.str()  # oid
        tag = r.str() or ""
        desc = r.str() or ""
        r.int()  # section
        for _ in range(3):
            r.str()  # defn · dropStmt · copyStmt
        namespace = r.str() or ""
        r.str()  # tablespace
        if vmin >= 14:
            r.str()  # tableam
        if vmin >= 16:
            r.int()  # relkind
        r.str()  # owner
        r.str()  # 'false' (WITH OIDS)
        while r.str() is not None:  # 의존하는 목차 번호들
            pass
        flag = r.byte()
        if flag not in (1, 2, 3):
            raise BackupError("db.dump 구조가 이상합니다 (데이터 위치 표시)")
        r.bytes(r.off_size)
        full = tag if namespace in ("", "public") else f"{namespace}.{tag}"
        if desc == "TABLE DATA":
            data_tables[dump_id] = full
        elif desc == "TABLE":
            schema_tables.add(full)
    tables: dict[str, int] = {}
    while True:
        head = r.f.read(1)
        if not head:
            break
        kind = head[0]
        dump_id = r.int()

        def chunks() -> Iterator[bytes]:
            while True:
                n = r.int()
                if n == 0:
                    return
                if n < 0 or n > 1 << 31:
                    raise BackupError("db.dump 구조가 이상합니다 (데이터 조각 길이)")
                left = n
                while left:
                    b = r.bytes(min(left, CHUNK))
                    left -= len(b)
                    yield b

        if kind == BLK_DATA:
            rows = _count_rows(chunks(), compression == "gzip")
            if dump_id in data_tables:
                tables[data_tables[dump_id]] = rows
        elif kind == BLK_BLOBS:
            while r.int() != 0:  # 큰 객체: 번호마다 데이터 (이 앱은 쓰지 않음, 읽고 넘김)
                for _ in chunks():
                    pass
        else:
            raise BackupError(f"db.dump 구조가 이상합니다 (데이터 블록 종류 {kind})")
    missing = [name for i, name in data_tables.items() if name not in tables]
    if missing:
        raise BackupError(f"db.dump에 표 데이터가 빠졌습니다: {', '.join(sorted(missing))}")
    return DumpInfo(
        archive=f"{vmaj}.{vmin}", compression=compression, database=database, server=server, client=client,
        tables=dict(sorted(tables.items())), schema_tables=schema_tables,
    )  # fmt: skip


# ── tar (ustar) 쓰기 ─────────────────────────────────────────────────


def _octal(n: int, width: int) -> bytes:
    return (f"{int(n):o}".rjust(width - 1, "0") + "\0").encode("ascii")


class TarWriter:
    """backup.ts TarWriter와 같은 모양: ustar, 파일별 SHA-256, 읽는 사이 줄어든 파일은 0으로 채움."""

    def __init__(self, path: Path) -> None:
        # 이미 있으면 덮어쓰지 않음, 600: 만든 사용자만 읽기
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
        self.f: IO[bytes] = os.fdopen(fd, "wb")
        uid = os.getuid() if hasattr(os, "getuid") else 0
        gid = os.getgid() if hasattr(os, "getgid") else 0
        self.uid = uid if uid < 0o7777777 else 0
        self.gid = gid if gid < 0o7777777 else 0
        self.hashes: dict[str, str] = {}

    def _header(self, name: str, n: int, typ: bytes, mtime_ms: float, mode: int) -> None:
        raw = name.encode("utf-8")
        if len(raw) > 100:
            raise BackupError(f"tar에 넣을 이름이 너무 깁니다: {name}")
        if n >= 8**11:
            raise BackupError(f"파일이 너무 큽니다: {name}")
        h = bytearray(BLOCK)
        h[0 : len(raw)] = raw
        h[100:108] = _octal(mode, 8)
        h[108:116] = _octal(self.uid, 8)
        h[116:124] = _octal(self.gid, 8)
        h[124:136] = _octal(n, 12)
        h[136:148] = _octal(mtime_ms // 1000, 12)
        h[148:156] = b" " * 8
        h[156:157] = typ
        h[257:263] = b"ustar\0"
        h[263:265] = b"00"
        h[148:156] = f"{sum(h):o}".rjust(6, "0").encode("ascii") + b"\0 "
        self.f.write(h)

    def _pad(self, n: int) -> None:
        self.f.write(b"\0" * ((BLOCK - n % BLOCK) % BLOCK))

    def dir(self, name: str, mtime_ms: float) -> None:
        self._header(name if name.endswith("/") else f"{name}/", 0, b"5", mtime_ms, 0o755)

    def data(self, name: str, body: bytes, mtime_ms: float) -> None:
        self._header(name, len(body), b"0", mtime_ms, 0o644)
        self.f.write(body)
        self._pad(len(body))

    def file(self, name: str, path: Path, mode: int = 0o644) -> int | None:
        """파일을 그대로 넣습니다. 그새 지워졌으면 None."""
        try:
            src = open(path, "rb")  # noqa: SIM115
        except FileNotFoundError:
            return None
        with src:
            st = os.fstat(src.fileno())
            if not stat.S_ISREG(st.st_mode):
                return None
            self._header(name, st.st_size, b"0", st.st_mtime_ns / 1e6, mode)
            h = hashlib.sha256()
            left = st.st_size
            while left > 0:
                b = src.read(min(CHUNK, left))
                if not b:
                    break
                self.f.write(b)
                h.update(b)
                left -= len(b)
            # 읽는 사이 파일이 줄었으면 0으로 채워 tar 모양을 지킵니다 (이미지는 한 번 쓰면 바뀌지 않음)
            if left > 0:
                z = b"\0" * left
                h.update(z)
                self.f.write(z)
            self.hashes[name] = h.hexdigest()
            self._pad(st.st_size)
            return st.st_size

    def finish(self) -> None:
        self.f.write(b"\0" * (BLOCK * 2))
        self.f.flush()
        os.fsync(self.f.fileno())
        self.f.close()

    def abort(self) -> None:
        with contextlib.suppress(OSError):
            self.f.close()


# ── tar 읽기 · 풀기 ──────────────────────────────────────────────────


@dataclass
class Extracted:
    manifest: dict[str, Any] | None = None
    manifest_raw: bytes | None = None
    sig: str | None = None
    dump: Path | None = None
    uploads: int = 0
    upload_bytes: int = 0
    sha256: dict[str, str] = field(default_factory=dict)
    skipped: list[str] = field(default_factory=list)


def _copy_hashed(src: IO[bytes], dst: IO[bytes] | None) -> str:
    h = hashlib.sha256()
    while True:
        b = src.read(CHUNK)
        if not b:
            break
        h.update(b)
        if dst is not None:
            dst.write(b)
    return h.hexdigest()


def extract(file: Path, dest: Path, with_uploads: bool) -> Extracted:
    """백업에서 쓸 것만 dest에 풉니다: db.dump, manifest, uploads/<이름>. with_uploads=False면 이미지는 세기만 합니다."""
    out = Extracted()
    try:
        tf = tarfile.open(file, "r:")  # noqa: SIM115
    except tarfile.ReadError as e:
        raise BackupError(f"tar 파일로 읽을 수 없습니다 ({e}). 백업 파일이 깨졌거나 복사가 덜 됐습니다") from e
    try:
        with tf:
            for m in tf:
                name = m.name[2:] if m.name.startswith("./") else m.name
                if m.isdir():
                    if name.rstrip("/") == UPLOADS:
                        if with_uploads:
                            (dest / UPLOADS).mkdir(parents=True, exist_ok=True)
                    else:
                        out.skipped.append(name)
                    continue
                if not m.isreg():
                    out.skipped.append(name)
                    continue
                src = tf.extractfile(m)
                assert src is not None
                if name == MANIFEST and m.size <= 1024 * 1024:
                    raw = src.read()
                    try:
                        v = json.loads(raw.decode("utf-8"))
                    except (UnicodeDecodeError, ValueError) as e:
                        raise BackupError("manifest.json을 읽을 수 없습니다") from e
                    out.manifest = v if isinstance(v, dict) else None
                    out.manifest_raw = raw
                    continue
                if name == SIG_NAME and m.size <= 1024:
                    out.sig = src.read().decode("utf-8", "replace").strip()
                    continue
                if name == DUMP_NAME:
                    if out.dump is not None:
                        raise BackupError("백업 안에 db.dump가 두 개 있습니다")
                    out.dump = dest / DUMP_NAME
                    fd = os.open(out.dump, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
                    with os.fdopen(fd, "wb") as dst:
                        out.sha256[name] = _copy_hashed(src, dst)
                    continue
                mm = re.fullmatch(r"uploads/([^/]+)", name)
                if mm and SAFE_NAME_RE.fullmatch(mm.group(1)):
                    out.uploads += 1
                    out.upload_bytes += m.size
                    if not with_uploads:
                        out.sha256[name] = _copy_hashed(src, None)
                        continue
                    (dest / UPLOADS).mkdir(parents=True, exist_ok=True)
                    with open(dest / UPLOADS / mm.group(1), "xb") as dst:
                        out.sha256[name] = _copy_hashed(src, dst)
                    continue
                out.skipped.append(name)
            end = tf.offset
    except tarfile.TarError as e:
        raise BackupError(f"백업 파일이 중간에 끊겼거나 깨졌습니다 ({e})") from e
    except OSError as e:
        if isinstance(e, FileExistsError):
            raise BackupError(f"백업 안에 같은 이름이 두 번 있습니다: {e.filename}") from e
        raise
    # tarfile은 끊기거나 깨진 머리를 만나면 조용히 끝으로 봅니다. 끝 표시(0으로 찬 블록 두 개)가 그 자리에 있어야 합니다
    with open(file, "rb") as f:
        f.seek(end)
        tail = f.read(BLOCK * 2)
    if len(tail) < BLOCK * 2:
        raise BackupError("백업 파일이 중간에 끊겼습니다 (복사가 덜 됐는지 확인하세요)")
    if tail.count(0) != len(tail):
        raise BackupError(f"tar 머리 검사값이 맞지 않습니다 (위치 {end}). 백업 파일이 깨졌을 수 있습니다")
    return out


def compare(x: Extracted, tables: dict[str, int]) -> list[str]:
    """백업 당시 기록(manifest)과 되살린 내용이 같은지. 다르면 이유 목록."""
    key = signing_key()
    if key is not None:
        # 보안 점검: 키가 있으면 서명이 꼭 있어야 하고 맞아야 합니다 (manifest 없는 백업도 받지 않음)
        if x.manifest_raw is None:
            return ["manifest.json이 없어 서명(BACKUP_SIGNING_KEY)을 확인할 수 없습니다"]
        if not x.sig:
            return ["서명(manifest.sig)이 없습니다. BACKUP_SIGNING_KEY로 만든 백업이 아닙니다"]
        if not hmac.compare_digest(x.sig, sign_manifest(key, x.manifest_raw)):
            return ["서명(manifest.sig)이 맞지 않습니다. 백업이 바뀌었거나 다른 BACKUP_SIGNING_KEY로 만들었습니다"]
    m = x.manifest
    if not m:
        return []
    problems: list[str] = []
    if m.get("format") != FORMAT:
        problems.append(f"이 도구가 만든 백업이 아닙니다 (format: {m.get('format')})")
    elif m.get("version") == 1:
        problems.append("Node(SQLite) 서버가 만든 백업입니다 (version 1). Python 서버에는 되살릴 수 없습니다")
    elif m.get("version") != VERSION:
        problems.append(f"이 도구가 모르는 백업 형식입니다 (version: {m.get('version')})")
    for t, n in (m.get("tables") or {}).items():
        if tables.get(t) != n:
            problems.append(f"{t}: 백업 당시 {n}행, 지금 {tables[t] if t in tables else '없음'}")
    if m.get("uploads") != x.uploads:
        problems.append(f"이미지: 백업 당시 {m.get('uploads')}개, 지금 {x.uploads}개")
    if m.get("uploadBytes") != x.upload_bytes:
        problems.append(f"이미지 용량: 백업 당시 {m.get('uploadBytes')}B, 지금 {x.upload_bytes}B")
    broken = [name for name, s in (m.get("sha256") or {}).items() if x.sha256.get(name) != s]
    if broken:
        more = f" 외 {len(broken) - 10}개" if len(broken) > 10 else ""
        problems.append(f"내용이 백업 당시와 다릅니다 (파일 손상): {', '.join(broken[:10])}{more}")
    return problems


# ── 백업 폴더 ────────────────────────────────────────────────────────


def ensure_writable_dir(d: Path) -> None:
    try:
        d.mkdir(parents=True, exist_ok=True, mode=0o700)
        probe = d / f".probe-{secrets.token_hex(4)}"
        probe.write_bytes(b"")
        probe.unlink()
    except PermissionError as e:
        raise BackupError(
            f"백업 폴더에 쓸 수 없습니다: {d}\n  Docker라면 호스트에서 deploy/backups 폴더 주인을 컨테이너 사용자로 바꿔 주세요: "
            "sudo chown 1000:1000 backups"
        ) from e
    except OSError as e:
        if e.errno in (13, 30):
            raise BackupError(f"백업 폴더에 쓸 수 없습니다: {d}") from e
        raise


def clean_stale(d: Path) -> None:
    """중간에 멈춘 백업 · 검사가 남긴 임시 파일 정리."""
    now = _now_ms()
    for p in d.iterdir():
        if not STALE_RE.match(p.name):
            continue
        with contextlib.suppress(OSError):
            if now - p.stat().st_mtime * 1000 > STALE_MS:
                if p.is_dir():
                    shutil.rmtree(p, ignore_errors=True)
                else:
                    p.unlink()


def created_ms_of(name: str) -> int:
    m = NAME_RE.fullmatch(name)
    if not m:
        return 0
    try:
        return int(datetime.strptime(m.group(1), "%Y%m%d-%H%M%S").replace(tzinfo=UTC).timestamp() * 1000)
    except ValueError:
        return 0


@dataclass
class BackupFile:
    name: str
    path: Path
    bytes: int
    created_ms: int


def list_backups(d: Path) -> list[BackupFile]:
    """이 도구가 만든 백업 파일, 새것부터."""
    if not d.exists():
        return []

    def key(n: str) -> str:
        m = NAME_RE.fullmatch(n)
        return f"{m.group(1) if m else ''}-{(m.group(2) if m and m.group(2) else '1').rjust(6, '0')}"

    names = sorted((n for n in os.listdir(d) if NAME_RE.fullmatch(n)), key=key, reverse=True)
    return [BackupFile(n, d / n, (d / n).stat().st_size, created_ms_of(n)) for n in names]


def prune_backups(s: Settings, protect: Path | None = None) -> list[str]:
    """최근 keep개 밖이거나, 만든 지 max_days - 1일이 지난 것을 지웁니다 (protect는 빼고)."""
    cutoff = _now_ms() - (s.max_days - 1) * DAY_MS
    removed: list[str] = []
    for i, b in enumerate(list_backups(s.backup_dir)):
        if protect is not None and b.path == protect:
            continue
        if i < s.keep and b.created_ms >= cutoff:
            continue
        b.path.unlink()
        removed.append(b.name)
    # 되살리기 전에 뜬 DB 사본(BACKUP_DIR/pre-restore-*.dump, README의 복구 순서)도 개인정보가 든 DB 전체 사본이라 같은 기한을
    # 지킵니다 (Node는 DATA_DIR/pre-migrate/를 이렇게 지움)
    if s.backup_dir.is_dir():
        for p in s.backup_dir.iterdir():
            if not PRE_RESTORE_RE.fullmatch(p.name):
                continue
            with contextlib.suppress(OSError):
                if p.stat().st_mtime * 1000 >= cutoff:
                    continue
                p.unlink()
                removed.append(p.name)
    return removed


# ── PostgreSQL 명령 ──────────────────────────────────────────────────


def _libpq(url: str) -> tuple[str, dict[str, str]]:
    """DATABASE_URL → (비밀번호를 뺀 postgresql:// 주소, {PGPASSWORD}). 비밀번호를 명령 줄에 두지 않습니다."""
    from sqlalchemy.engine import make_url

    u = make_url(url)
    env = {"PGPASSWORD": u.password} if u.password else {}
    plain = u.set(drivername="postgresql", password=None).render_as_string(hide_password=False)
    return plain, env


def _database_url() -> str:
    url = (os.environ.get("DATABASE_URL") or "").strip()
    if not url:
        raise BackupError("DATABASE_URL이 비어 있습니다 (또는 PG_DUMP · PG_RESTORE로 명령을 정하거나 --dump · --db-to를 쓰세요)")
    return url


def pg_command(kind: str) -> tuple[list[str], dict[str, str]]:
    """PG_DUMP / PG_RESTORE가 있으면 그 명령 그대로, 없으면 DATABASE_URL로 기본 명령."""
    custom = (os.environ.get(f"PG_{kind.upper()}") or "").strip()
    if custom:
        return shlex.split(custom, posix=os.name != "nt"), {}
    url, env = _libpq(_database_url())
    if kind == "dump":
        return ["pg_dump", "--format=custom", f"--dbname={url}"], env
    return [
        "pg_restore", "--clean", "--if-exists", "--no-owner", "--no-privileges", "--single-transaction", "--exit-on-error",
        f"--dbname={url}",
    ], env  # fmt: skip


def run_pg_dump(out: Path) -> None:
    cmd, env = pg_command("dump")
    try:
        with open(out, "wb") as f:
            r = subprocess.run(cmd, stdout=f, stderr=subprocess.PIPE, env={**os.environ, **env}, check=False)
    except FileNotFoundError as e:
        raise BackupError(f"pg_dump를 찾지 못했습니다 ({cmd[0]}). PG_DUMP로 명령을 정하거나 --dump로 덤프를 넘겨 주세요") from e
    if r.returncode != 0:
        raise BackupError(f"pg_dump가 실패했습니다 (종료 코드 {r.returncode}): {r.stderr.decode('utf-8', 'replace').strip()[:500]}")


def run_pg_restore(dump: Path) -> None:
    cmd, env = pg_command("restore")
    try:
        with open(dump, "rb") as f:
            r = subprocess.run(cmd, stdin=f, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={**os.environ, **env}, check=False)
    except FileNotFoundError as e:
        raise BackupError(f"pg_restore를 찾지 못했습니다 ({cmd[0]}). PG_RESTORE로 명령을 정하거나 --db-to로 덤프만 꺼내 주세요") from e
    if r.returncode != 0:
        raise BackupError(
            f"pg_restore가 실패했습니다 (종료 코드 {r.returncode}). --single-transaction이라 DB는 바뀌지 않았습니다: "
            f"{r.stderr.decode('utf-8', 'replace').strip()[:500]}"
        )


async def _db_state(url: str) -> tuple[int, set[str]]:
    """(서버 · 운영 명령의 연결 수, public 표 이름들)."""
    import asyncpg

    plain, env = _libpq(url)
    conn = await asyncpg.connect(
        plain, password=env.get("PGPASSWORD"), timeout=5, server_settings={"application_name": "musabaepo-shrine-backup"}
    )
    try:
        n = await conn.fetchval(
            """SELECT count(*) FROM pg_stat_activity
                 WHERE datname = current_database() AND application_name = $1 AND pid <> pg_backend_pid()""",
            SERVER_APP_NAME,
        )
        rows = await conn.fetch("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
        return int(n), {r["tablename"] for r in rows}
    finally:
        await conn.close()


def check_db(say: Callable[[str], None], dump_tables: set[str] | None, force: bool) -> None:
    """서버(또는 운영 명령)가 DB에 붙어 있으면 되살리지 않습니다. DB에 백업에 없는 표가 있어도 멈춥니다
    (pg_restore --clean은 덤프에 있는 표만 지우므로, 더 새 서버가 만든 표가 남아 다음 시작 때 구조 올리기가 깨짐).
    DB에 닿지 않으면 경고만."""
    url = (os.environ.get("DATABASE_URL") or "").strip()
    if not url:
        say("  (DATABASE_URL이 없어 서버가 멈췄는지 확인하지 못했습니다. 서버를 멈춘 뒤에 되살려 주세요)")
        return
    try:
        n, live_tables = asyncio.run(_db_state(url))
    except Exception as e:  # noqa: BLE001 — 확인을 못 하면 알리고 계속 (pg_restore가 어차피 실패함)
        say(f"  (DB에 닿지 않아 서버가 멈췄는지 확인하지 못했습니다: {type(e).__name__})")
        return
    if n and not force:
        raise BackupError(
            f"서버(또는 운영 명령)가 아직 DB에 붙어 있습니다 (연결 {n}개). 서버를 멈춘 뒤 다시 해 주세요 "
            "(Docker: docker compose stop api). 다른 프로그램이 같은 이름으로 붙은 것이 확실하면 --force"
        )
    extra = sorted(live_tables - dump_tables) if dump_tables is not None else []
    if extra and not force:
        raise BackupError(
            f"DB에 이 백업에 없는 표가 있습니다 ({', '.join(extra)}). 더 새 서버가 만든 DB에 옛 백업을 되살리려면 "
            "빈 DB를 만들어 DATABASE_URL을 그쪽으로 두고 되살려 주세요 (확실하면 --force)"
        )


# ── 백업 만들기 ──────────────────────────────────────────────────────


@dataclass
class BackupResult:
    file: Path
    bytes: int
    tables: dict[str, int]
    uploads: int
    upload_bytes: int
    removed: list[str]


def _spool(src: BinaryIO, out: Path) -> None:
    with open(out, "wb") as f:
        shutil.copyfileobj(src, f, CHUNK)


def create_backup(s: Settings, dump_from: str | None = None, *, stdin: BinaryIO | None = None) -> BackupResult:
    uploads_dir = s.data_dir / UPLOADS
    if _is_inside(s.backup_dir, uploads_dir):
        raise BackupError("BACKUP_DIR을 이미지 폴더(uploads) 안에 둘 수 없습니다")
    if dump_from and dump_from != "-" and not Path(dump_from).is_file():
        raise BackupError(f"덤프 파일이 없습니다: {Path(dump_from).resolve()}")
    key = signing_key()
    ensure_writable_dir(s.backup_dir)
    clean_stale(s.backup_dir)
    # 기한이 지난 백업은 이번 백업이 실패하더라도 먼저 지웁니다 (보관 기간 약속 · 디스크 여유)
    removed = prune_backups(s)

    upload_bytes = 0
    upload_names: list[str] = []
    if uploads_dir.is_dir():
        for e in os.scandir(uploads_dir):
            if not e.is_file(follow_symlinks=False) or not SAFE_NAME_RE.fullmatch(e.name):
                continue
            upload_names.append(e.name)
            with contextlib.suppress(OSError):
                upload_bytes += e.stat().st_size
    upload_names.sort()

    def room(need: int) -> None:
        try:
            free = shutil.disk_usage(s.backup_dir).free
        except OSError:
            return
        if free < need + DISK_RESERVE:
            raise BackupError(
                f"백업 폴더의 디스크 여유가 부족합니다 (남은 {size(free)}, 필요 {size(need)} + 여유 {size(DISK_RESERVE)}). "
                "오래된 백업을 서버 밖으로 옮기거나 BACKUP_KEEP을 줄이세요"
            )

    room(upload_bytes)
    created = datetime.now(UTC)
    sec = stamp(created)
    last = 0
    for n in os.listdir(s.backup_dir):
        m = NAME_RE.fullmatch(re.sub(r"^\.(.*)\.partial$", r"\1", n))
        if m and m.group(1) == sec:
            last = max(last, int(m.group(2) or 1))
    base = f"shrine-{sec}Z-{last + 1}" if last else f"shrine-{sec}Z"
    final = s.backup_dir / f"{base}.tar"
    partial = s.backup_dir / f".{base}.tar.partial"
    work = Path(tempfile.mkdtemp(prefix=".work-", dir=s.backup_dir))
    tar: TarWriter | None = None
    try:
        # 1) DB 덤프: 표준 입력 · 파일 · pg_dump. 먼저 다 받은 뒤 이미지를 넣으므로 덤프가 가리키는 이미지는 모두 이미 다 써진 파일입니다
        if dump_from == "-":
            dump = work / DUMP_NAME
            _spool(stdin if stdin is not None else sys.stdin.buffer, dump)
        elif dump_from:
            dump = Path(dump_from).resolve()
        else:
            dump = work / DUMP_NAME
            run_pg_dump(dump)
        if dump.stat().st_size == 0:
            raise BackupError("DB 덤프가 비어 있습니다 (pg_dump가 실패했는지 확인하세요)")
        room(dump.stat().st_size + upload_bytes)
        with open(dump, "rb", buffering=CHUNK) as f:
            info = read_dump(f)

        # 2) tar: db.dump → 이미지 → manifest
        at = created.timestamp() * 1000
        tar = TarWriter(partial)
        tar.file(DUMP_NAME, dump, 0o600)
        tar.dir(UPLOADS, at)
        uploads = 0
        packed = 0
        for name in upload_names:
            n = tar.file(f"{UPLOADS}/{name}", uploads_dir / name)
            if n is None:
                continue
            uploads += 1
            packed += n
        manifest = {
            "format": FORMAT, "version": VERSION, "createdAt": _iso(created), "engine": "postgresql", "dump": DUMP_NAME,
            "pgDump": {"archive": info.archive, "compression": info.compression, "database": info.database,
                       "server": info.server, "client": info.client},
            "tables": info.tables, "uploads": uploads, "uploadBytes": packed, "python": platform.python_version(),
            "sha256": tar.hashes,
        }  # fmt: skip
        manifest_raw = (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
        tar.data(MANIFEST, manifest_raw, at)
        if key is not None:
            tar.data(SIG_NAME, (sign_manifest(key, manifest_raw) + "\n").encode("ascii"), at)
        tar.finish()
        tar = None
        os.replace(partial, final)
        with contextlib.suppress(OSError, AttributeError):
            dfd = os.open(s.backup_dir, os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        # 3) 새것까지 넣어 다시 정리 (keep개 넘친 것)
        removed += prune_backups(s, final)
        return BackupResult(final, final.stat().st_size, info.tables, uploads, packed, removed)
    except BaseException:
        if tar is not None:
            tar.abort()
        with contextlib.suppress(OSError):
            partial.unlink()
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ── 검사 ─────────────────────────────────────────────────────────────


@dataclass
class VerifyResult:
    manifest: dict[str, Any] | None
    tables: dict[str, int]
    uploads: int
    upload_bytes: int


def _inspect_info(x: Extracted) -> DumpInfo:
    if x.manifest and x.manifest.get("format") == FORMAT and x.manifest.get("version") == 1:
        raise BackupError("Node(SQLite) 서버가 만든 백업입니다 (version 1). 이 서버에는 되살릴 수 없습니다 (Node 서버는 git 기록의 커밋 a2b1bf6까지)")
    if x.dump is None:
        raise BackupError("백업 안에 db.dump가 없습니다")
    with open(x.dump, "rb", buffering=CHUNK) as f:
        return read_dump(f)


def _inspect(x: Extracted) -> dict[str, int]:
    return _inspect_info(x).tables


def verify_backup(file: str | Path) -> VerifyResult:
    src = Path(file).resolve()
    if not src.is_file():
        raise BackupError(f"백업 파일이 없습니다: {src}")
    # DB 덤프만 잠깐 풉니다. 백업 파일 옆(같은 디스크)에, 안 되면 임시 폴더에
    try:
        tmp = Path(tempfile.mkdtemp(prefix=".verify-", dir=src.parent))
    except OSError:
        tmp = Path(tempfile.mkdtemp(prefix="shrine-verify-"))
    try:
        x = extract(src, tmp, False)
        tables = _inspect(x)
        problems = compare(x, tables)
        if problems:
            raise BackupError("백업 당시 기록과 다릅니다:\n  " + "\n  ".join(problems))
        return VerifyResult(x.manifest, tables, x.uploads, x.upload_bytes)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ── 되살리기 ─────────────────────────────────────────────────────────


@dataclass
class RestoreResult:
    dest: Path
    tables: dict[str, int]
    uploads: int
    aside: Path | None
    skipped: list[str]
    db: str


def restore_backup(
    file: str | Path, target: str | Path | None, *, db_to: str | None = None, uploads_only: bool = False, force: bool = False,
    say: Callable[[str], None] = print, stdout: BinaryIO | None = None,
) -> RestoreResult:  # fmt: skip
    """서버를 멈춘 뒤에만 부릅니다. 먼저 옆 폴더에 풀어 검사하고, 통과하면 원래 것을 옮기고 바꿔 넣습니다.

    db_to: DB는 되살리지 않고 검사한 db.dump를 그 파일('-'면 stdout)로 (이미지는 건드리지 않음).
    uploads_only: 이미지만 되살림 (DB는 그대로).
    """
    src = Path(file).resolve()
    if not src.is_file():
        raise BackupError(f"백업 파일이 없습니다: {src}")
    dest = Path(target).resolve() if target else settings().data_dir
    dest.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".restore-", dir=dest))
    try:
        x = extract(src, stage, db_to is None)
        info = _inspect_info(x)
        tables = info.tables
        problems = compare(x, tables)
        if problems:
            raise BackupError("백업 당시 기록과 달라 되살리지 않았습니다:\n  " + "\n  ".join(problems))
        assert x.dump is not None
        # 서버가 멈췄는지 (+ DB를 바꿀 때는 DB에 백업에 없는 표가 없는지)
        check_db(say, None if uploads_only else info.schema_tables, force)
        if db_to is not None:
            if db_to == "-":
                out = stdout if stdout is not None else sys.stdout.buffer
                with open(x.dump, "rb") as f:
                    shutil.copyfileobj(f, out, CHUNK)
                out.flush()
            else:
                shutil.copyfile(x.dump, db_to)
            return RestoreResult(dest, tables, x.uploads, None, x.skipped, "stdout" if db_to == "-" else str(Path(db_to).resolve()))
        if not (stage / UPLOADS).exists():
            (stage / UPLOADS).mkdir()

        # 지금 있는 DB와 이미지는 지우지 않고 옆으로
        aside = dest / f"pre-restore-{stamp()}Z"
        db_note = "그대로 (--uploads-only)"
        if not uploads_only:
            aside.mkdir(parents=True, exist_ok=True)
            run_pg_dump(aside / DUMP_NAME)
            run_pg_restore(x.dump)
            db_note = "pg_restore --clean으로 바꿔 넣음"
        moved: list[str] = []
        try:
            if (dest / UPLOADS).exists():
                aside.mkdir(parents=True, exist_ok=True)
                os.replace(dest / UPLOADS, aside / UPLOADS)
                moved.append(UPLOADS)
            os.replace(stage / UPLOADS, dest / UPLOADS)
        except BaseException:
            # 반쯤 바뀐 채로 두지 않게 되돌립니다
            if UPLOADS in moved and not (dest / UPLOADS).exists():
                with contextlib.suppress(OSError):
                    os.replace(aside / UPLOADS, dest / UPLOADS)
            raise
        has_aside = aside.exists() and any(aside.iterdir())
        return RestoreResult(dest, tables, x.uploads, aside if has_aside else None, x.skipped, db_note)
    finally:
        shutil.rmtree(stage, ignore_errors=True)


# ── 명령 ─────────────────────────────────────────────────────────────

USAGE = """사용법:
  python -m shrine.backup [create] [--dump <파일>|-]     지금 백업 하나 만들기 (--dump: pg_dump -Fc 결과를 받음)
  python -m shrine.backup list                          백업 목록
  python -m shrine.backup prune                         만들지 않고 오래된 백업만 정리
  python -m shrine.backup verify <파일>                  백업 검사
  python -m shrine.backup restore <파일> [폴더] [--force] [--db-to <파일>|- | --uploads-only]
                                                        되살리기 (기본 DATA_DIR · DATABASE_URL, 서버를 멈춘 뒤에만)
Docker: deploy/README.md 'Python 서버(이전 후)'의 백업 · 복구"""


def _opts(args: list[str], flags: set[str], valued: set[str]) -> tuple[list[str], dict[str, Any]]:
    pos: list[str] = []
    opt: dict[str, Any] = {}
    i = 0
    while i < len(args):
        a = args[i]
        if a in flags:
            opt[a] = True
        elif a in valued:
            if i + 1 >= len(args):
                raise BackupError(USAGE)
            opt[a] = args[i + 1]
            i += 1
        elif a.startswith("--") and a != "-":
            raise BackupError(USAGE)
        else:
            pos.append(a)
        i += 1
    return pos, opt


def main(argv: list[str] | None = None) -> int:
    from .cli import load_env_file

    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")
    args = load_env_file(list(sys.argv[1:] if argv is None else argv))
    cmd = args[0] if args and not args[0].startswith("--") else "create"
    rest = args[1:] if args and not args[0].startswith("--") else args
    try:
        if cmd == "create":
            pos, opt = _opts(rest, set(), {"--dump"})
            if pos:
                raise BackupError(USAGE)
            s = settings()
            r = create_backup(s, opt.get("--dump"))
            print(f"[backup] 만들었습니다: {r.file} ({size(r.bytes)})")
            print(f"  표: {table_line(r.tables)}")
            print(f"  이미지 {r.uploads}개 ({size(r.upload_bytes)})")
            if r.removed:
                print(f"  오래된 백업 {len(r.removed)}개를 지웠습니다 (최근 {s.keep}개 · {s.max_days}일 안): {', '.join(r.removed)}")
        elif cmd == "list":
            s = settings()
            items = list_backups(s.backup_dir)
            if not items:
                print(f"(백업 없음: {s.backup_dir})")
            now = _now_ms()
            for b in items:
                print(f"{b.name}  {size(b.bytes).rjust(8)}  {_to_fixed((now - b.created_ms) / DAY_MS, 1)}일 전")
        elif cmd == "prune":
            removed = prune_backups(settings())
            print(f"[backup] {len(removed)}개를 지웠습니다: {', '.join(removed)}" if removed else "[backup] 지울 백업이 없습니다")
        elif cmd == "verify":
            pos, _ = _opts(rest, set(), set())
            if len(pos) != 1:
                raise BackupError(USAGE)
            r = verify_backup(pos[0])
            print(f"[backup] 이상 없습니다: {Path(pos[0]).resolve()}")
            if signing_key() is not None:
                print("  서명: BACKUP_SIGNING_KEY로 확인함")
            print(f"  만든 때: {(r.manifest or {}).get('createdAt', '(manifest 없음)')}")
            print(f"  표: {table_line(r.tables)}")
            print(f"  이미지 {r.uploads}개 ({size(r.upload_bytes)})")
        elif cmd == "restore":
            pos, opt = _opts(rest, {"--force", "--uploads-only"}, {"--db-to"})
            if not 1 <= len(pos) <= 2 or ("--db-to" in opt and "--uploads-only" in opt):
                raise BackupError(USAGE)
            # 덤프를 표준 출력으로 내보낼 때는 안내 글을 표준 오류로
            to_stdout = opt.get("--db-to") == "-"

            def say(msg: str) -> None:
                print(msg, file=sys.stderr if to_stdout else sys.stdout, flush=True)

            r = restore_backup(
                pos[0], pos[1] if len(pos) > 1 else None, db_to=opt.get("--db-to"), uploads_only=bool(opt.get("--uploads-only")),
                force=bool(opt.get("--force")), say=say,
            )  # fmt: skip
            if opt.get("--db-to") is not None:
                say(f"[backup] 검사한 DB 덤프를 내보냈습니다: {r.db} (이미지는 그대로)")
                say(f"  표: {table_line(r.tables)}")
            else:
                say(f"[backup] 되살렸습니다: {r.dest}")
                say(f"  DB: {r.db}")
                say(f"  표: {table_line(r.tables)}")
                say(f"  이미지 {r.uploads}개")
                if r.skipped:
                    say(f"  모르는 항목은 건너뜀: {', '.join(r.skipped)}")
                if r.aside:
                    say(f"  원래 있던 파일은 {r.aside} 로 옮겨 두었습니다. 서버를 띄워 확인한 뒤 지워도 됩니다.")
        elif cmd in ("help", "-h", "--help"):
            print(USAGE)
        else:
            raise BackupError(USAGE)
    except BackupError as e:
        print(f"[backup] {e}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
