"""uv run python -m shrine [--env-file 경로]

--env-file: 그 파일의 값을 환경 변수로 읽습니다 (이미 있는 환경 변수가 이깁니다. Node --env-file-if-exists와 같음).
Docker에서는 compose의 env_file이 넣어 주므로 쓰지 않습니다.
"""

from __future__ import annotations

import argparse
import os

from .config import config_or_exit
from .main import run


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m shrine", description="무사배포 기원소 서버")
    parser.add_argument("--env-file", help="환경 변수 파일 (예: ../.env). 없으면 건너뜁니다")
    args = parser.parse_args()
    if args.env_file and os.path.isfile(args.env_file):
        from dotenv import load_dotenv

        load_dotenv(args.env_file, override=False, encoding="utf-8")
    run(config_or_exit())


if __name__ == "__main__":
    main()
