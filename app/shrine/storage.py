"""업로드 폴더(DATA_DIR/uploads)의 파일 · 용량 · 디스크 여유 · 동시 업로드 수 (uploads.ts의 파일 부분).

이 프로세스가 직접 아는 것만 둡니다 (Node도 프로세스 메모리):
  · total_bytes: 폴더 합계. 시작할 때와 정리할 때(6시간마다) 다시 세고, 그 사이에는 더하고 빼기만 합니다.
    운영 명령(다른 프로세스)이 지운 파일은 다음 정리 때 맞춰집니다.
  · active: 지금 받는 중인 업로드 수 (본문을 메모리에 5MB까지 올리므로 서버 전체 3개까지).
    본문 읽기에는 시간 한도가 있어(web/front.py BodyDeadline: 전체 60초) 느린 본문이 자리를 오래 붙잡지 못합니다.
  · cap_warned · full_warned_at: 80% 알림 · '꽉 참' 알림 (시간당 한 번)을 한 번만 보내기 위한 표시.
누가 올렸는지 · 할당량 · 보기 허락은 Redis에 둡니다 (uploads.py).
파일 쓰기 · 지우기 · 폴더 훑기는 디스크를 기다리므로 부르는 쪽이 스레드에서 돌립니다 (asyncio.to_thread).
"""

from __future__ import annotations

import math
import os
import shutil
import time
from collections.abc import Container
from pathlib import Path

from .jscompat import js_round

TOTAL_MAX = 2 * 1024 * 1024 * 1024
"""업로드 폴더 합계 상한 (2GB)"""
MIN_FREE = 1024 * 1024 * 1024
"""디스크 여유가 이보다 적으면 받지 않습니다 (1GB)"""
MAX_ACTIVE = 3
"""서버 전체에서 동시에 받는 업로드 수"""
ORPHAN_MS = 65 * 60_000
"""접수 · 사당에 안 쓰인 파일을 지우기까지 (1시간 + 5분 여유: 붙일 수 있는 시간 uploads.ATTACH_MS가 1시간).
보안 점검: Node는 24시간이라 하루 만에 저장 공간(2GB)을 채울 수 있었습니다."""


def mtime_ms(st: os.stat_result) -> float:
    """Node stats.mtimeMs와 같은 계산."""
    sec, nsec = divmod(st.st_mtime_ns, 10**9)
    return sec * 1e3 + nsec / 1e6


class UploadStore:
    def __init__(self, data_dir: str):
        self.dir = Path(data_dir) / "uploads"
        #: 폴더 합계. 시작할 때와 정리할 때 다시 세고, 그 사이에는 더하고 빼기만 합니다
        self.total_bytes = 0
        self._free_at = 0.0
        self._free = math.inf
        self.active = 0
        self.cap_warned = False
        self.full_warned_at = 0.0

    def prepare(self) -> None:
        """폴더를 만들고 합계를 셉니다 (시작할 때 한 번)."""
        self.dir.mkdir(parents=True, exist_ok=True)
        self.total_bytes = self.dir_bytes()

    def dir_bytes(self) -> int:
        n = 0
        for entry in os.scandir(self.dir):
            try:
                n += entry.stat().st_size
            except OSError:
                pass  # 지워진 파일
        return n

    def free_bytes(self) -> float:
        """디스크 여유 (1분 캐시). 알 수 없으면 무한대."""
        now = time.monotonic()
        if now - self._free_at < 60 and self._free_at:
            return self._free
        try:
            self._free = shutil.disk_usage(self.dir).free
        except OSError:
            self._free = math.inf
        self._free_at = now
        return self._free

    def writable(self) -> bool:
        return os.access(self.dir, os.W_OK)

    def stats(self) -> dict:
        return {
            "usedPct": js_round(self.total_bytes / TOTAL_MAX * 100),
            "lowDisk": self.free_bytes() < MIN_FREE,
            "writable": self.writable(),
        }

    # ── 받기 ──

    def no_room(self, extra: int) -> bool:
        """용량 · 디스크 여유가 모자라면 True (uploads.ts noRoom)."""
        return self.total_bytes + extra > TOTAL_MAX or self.free_bytes() < MIN_FREE + extra

    def try_begin(self) -> bool:
        """동시 업로드 자리 하나를 잡습니다. 다 찼으면 False."""
        if self.active >= MAX_ACTIVE:
            return False
        self.active += 1
        return True

    def end(self) -> None:
        self.active = max(0, self.active - 1)

    def path_of(self, name: str) -> Path:
        return self.dir / name

    def write_new(self, name: str, data: bytes) -> None:
        """새 파일로만 씁니다 (있으면 FileExistsError, Node writeFileSync flag 'wx'). 합계에 더합니다."""
        with open(self.dir / name, "xb") as f:
            f.write(data)
        self.total_bytes += len(data)

    def remove(self, name: str) -> bool:
        """지우고 합계에서 뺍니다. 이미 없으면 False."""
        path = self.dir / name
        try:
            size = path.stat().st_size
            path.unlink()
        except OSError:
            return False
        self.total_bytes = max(0, self.total_bytes - size)
        return True

    def remove_orphans(self, used: Container[str], now_ms: float) -> int:
        """used에 없고 고친 지 ORPHAN_MS가 지난 파일을 지운 뒤 합계를 다시 셉니다. 지운 개수."""
        n = 0
        for entry in os.scandir(self.dir):
            if entry.name in used:
                continue
            try:
                if now_ms - mtime_ms(entry.stat()) > ORPHAN_MS:
                    os.unlink(entry.path)
                    n += 1
            except OSError:
                pass
        self.total_bytes = self.dir_bytes()
        return n
