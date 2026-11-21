"""uv run python -m shrine [--env-file 경로]

--env-file: 그 파일의 값을 환경 변수로 읽습니다 (이미 있는 환경 변수가 이깁니다. 파일이 없으면 건너뜀).
Docker에서는 compose의 env_file이 넣어 주므로 쓰지 않습니다.
"""

from __future__ import annotations

import argparse
import os
import sys

from .config import config_or_exit
from .main import run


def main() -> None:
    # Windows에서 출력을 파일 · 파이프로 넘기면 기본 인코딩(cp949)으로 써서 한국어 기록이 깨집니다: 늘 UTF-8로 씁니다
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(prog="python -m shrine", description="무사배포 기원소 서버")
    parser.add_argument("--env-file", help="환경 변수 파일 (예: ../.env). 없으면 건너뜁니다")
    args = parser.parse_args()
    if args.env_file and os.path.isfile(args.env_file):
        from dotenv import load_dotenv

        load_dotenv(args.env_file, override=False, encoding="utf-8")
    run(config_or_exit())


if __name__ == "__main__":
    main()
