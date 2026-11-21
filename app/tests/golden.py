"""Node 기준값 골든: 예전 Node 서버(git 기록 a2b1bf6까지의 server/*.ts · Node 24 내장 V8 · Ada)에서 뽑아 둔 결과.

Python 포팅을 Node와 바이트까지 맞춰 보던 시험이 이제 node 없이 이 파일들(tests/data/golden/*.json.gz)과 맞춰 봅니다.
요청(소스 이름 + 입력 JSON)의 sha256으로 결과를 찾으므로, 시험 입력을 바꾸면 "골든에 없음"으로 실패합니다 (건너뛰지 않음).
입력을 바꿔야 하면 a2b1bf6을 꺼내 node로 다시 뽑아야 합니다 (그 커밋의 tests/node_ref/ref.mjs · p2b_ref.mjs · p3_ref.mjs).
"""

from __future__ import annotations

import copy
import functools
import gzip
import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

GOLDEN_DIR = Path(__file__).resolve().parent / "data" / "golden"

#: 골든을 뽑을 때 Node config.ts가 읽은 고정 값 (시험 전용, 운영 값 아님)
TICKET_SECRET = "f3Q9-zK1pX7_mR2vB8nL4cH6jW0tY5sD"
ADMIN_PASSWORD = "Vq7#nL2$wR9!kT4@zM8^"


def request_key(source: str, payload: Any) -> str:
    text = json.dumps([source, payload], ensure_ascii=True, separators=(",", ":"), allow_nan=True)
    return hashlib.sha256(text.encode("ascii")).hexdigest()


@functools.cache
def _store(source: str) -> dict[str, Any]:
    path = GOLDEN_DIR / f"{source}.json.gz"
    if not path.is_file():
        pytest.fail(f"골든 파일이 없습니다: {path.name}")
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return json.load(f)


def golden(source: str, payload: Any) -> Any:
    """``source``(ref · p2b · p3 · whatwg · config)에서 ``payload`` 요청의 Node 결과를 돌려줍니다."""
    store = _store(source)
    key = request_key(source, payload)
    if key not in store:
        pytest.fail(f"골든 {source}에 이 입력이 없습니다 (시험 입력이 바뀜 — a2b1bf6의 Node 기준값 도구로 다시 뽑아야 합니다)")
    return copy.deepcopy(store[key])


def run(op: str, timeout: float = 0, **args: Any) -> Any:  # noqa: ARG001 — 예전 node_ref.runner.run과 같은 모양
    """예전 tests/node_ref/ref.mjs에 ``{"op": op, **args}``를 넘겼을 때의 결과."""
    return golden("ref", {"op": op, **args})
