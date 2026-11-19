"""업로드 폴더(DATA_DIR/uploads)의 용량 · 디스크 여유 · 쓰기 가능 여부 (uploads.ts의 용량 부분).

지금은 /healthz가 읽는 상태만 있습니다. 올리기 · 정리 · 공개 판단(P2)은 이 클래스에 덧붙입니다.
"""

from __future__ import annotations

import math
import os
import shutil
import time
from pathlib import Path

from .jscompat import js_round

TOTAL_MAX = 2 * 1024 * 1024 * 1024
"""업로드 폴더 합계 상한 (2GB)"""
MIN_FREE = 1024 * 1024 * 1024
"""디스크 여유가 이보다 적으면 받지 않습니다 (1GB)"""


class UploadStore:
    def __init__(self, data_dir: str):
        self.dir = Path(data_dir) / "uploads"
        #: 폴더 합계. 시작할 때와 정리할 때 다시 세고, 그 사이에는 더하고 빼기만 합니다
        self.total_bytes = 0
        self._free_at = 0.0
        self._free = math.inf

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
