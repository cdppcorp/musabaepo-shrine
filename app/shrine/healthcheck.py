"""Docker HEALTHCHECK: GET http://127.0.0.1:${PORT}${BASE_PATH}/healthz 가 200이면 0, 아니면 1.

이미지에 wget · curl이 없어서 Python 표준 라이브러리로 봅니다 (python -m shrine.healthcheck).
설정 전체를 검사하지 않고 PORT · BASE_PATH만 읽습니다 (DB 주소 같은 비밀 값을 건드리지 않게).
"""

from __future__ import annotations

import os
import sys
import urllib.error
import urllib.request


def main() -> int:
    port = (os.environ.get("PORT") or "3300").strip()
    base = (os.environ.get("BASE_PATH") or "").strip().rstrip("/")
    url = f"http://127.0.0.1:{port}{base}/healthz"
    try:
        with urllib.request.urlopen(url, timeout=4) as res:  # noqa: S310 (고정된 로컬 주소)
            return 0 if res.status == 200 else 1
    except (urllib.error.URLError, OSError, ValueError):
        return 1


if __name__ == "__main__":
    sys.exit(main())
