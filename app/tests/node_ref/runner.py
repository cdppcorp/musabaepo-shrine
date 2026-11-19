"""tests/node_ref/ref.mjs를 띄워 Node 기준값을 받습니다. node가 없거나 server/가 없으면 시험을 건너뜁니다 (pytest.skip).

``SHRINE_NO_NODE=1``이면 node가 있어도 없는 것처럼 건너뜁니다 (건너뛰기 확인용).
"""

from __future__ import annotations

import atexit
import functools
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import pytest

HERE = Path(__file__).resolve().parent
REF = HERE / "ref.mjs"
SERVER = HERE.parent.parent.parent / "server"

#: Node 쪽 config.ts가 읽는 고정 값 (시험 전용, 운영 값 아님)
TICKET_SECRET = "f3Q9-zK1pX7_mR2vB8nL4cH6jW0tY5sD"
ADMIN_PASSWORD = "Vq7#nL2$wR9!kT4@zM8^"

# config.ts가 읽는 환경 변수: 개발자 셸에 무엇이 있든 Node 기준값이 흔들리지 않게 비웁니다
_CONFIG_VARS = (
    "NODE_ENV", "PORT", "HOST", "BASE_PATH", "PUBLIC_ORIGIN", "SHRINE_DOMAIN", "TICKET_SECRET", "TURNSTILE_SITE_KEY",
    "TURNSTILE_SECRET", "CONTACT_EMAIL", "ADMIN_PASSWORD", "ADMIN_IPS", "NOTIFY_WEBHOOK_URL", "GITHUB_CHECK", "GITHUB_TOKEN",
    "BACKUP_KEEP", "BACKUP_MAX_DAYS", "RETENTION_DAYS", "PENDING_DAYS", "ACME_EMAIL", "TRUST_PROXY", "DATA_DIR", "FREE_CHAT",
    "BOARD_OPEN", "ALLOW_INDEXING", "CANDLE_COOLDOWN_MS", "WS_MAX_PER_IP",
)  # fmt: skip


@functools.cache
def node_path() -> str | None:
    return shutil.which("node")


@functools.cache
def _data_dir() -> str:
    path = tempfile.mkdtemp(prefix="shrine-node-ref-")
    atexit.register(shutil.rmtree, path, ignore_errors=True)
    return path


def require_node() -> str:
    node = node_path()
    if node is None or os.environ.get("SHRINE_NO_NODE"):
        pytest.skip("node가 없어 Node 기준값과 맞춰 볼 수 없습니다")
    if not SERVER.is_dir():
        pytest.skip("server/ 폴더가 없습니다")
    return node


def run(op: str, timeout: float = 300, **args: Any) -> Any:
    """ref.mjs에 ``{"op": op, **args}``를 넘기고 JSON 결과를 돌려줍니다."""
    node = require_node()
    env = {k: v for k, v in os.environ.items() if k not in _CONFIG_VARS}
    env.update(
        TICKET_SECRET=TICKET_SECRET,
        ADMIN_PASSWORD=ADMIN_PASSWORD,
        DATA_DIR=_data_dir(),
        GITHUB_CHECK="off",
        TZ="UTC",
    )
    proc = subprocess.run(
        [node, "--disable-warning=ExperimentalWarning", str(REF)],
        input=json.dumps({"op": op, **args}, ensure_ascii=True).encode("ascii"),
        capture_output=True,
        timeout=timeout,
        env=env,
        cwd=str(HERE),
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ref.mjs {op} 실패:\n{proc.stderr.decode('utf-8', 'replace')}")
    return json.loads(proc.stdout.decode("utf-8"))


@functools.cache
def node_versions() -> dict[str, str]:
    node = require_node()
    out = subprocess.run([node, "-p", "JSON.stringify(process.versions)"], capture_output=True, check=True, timeout=30)
    return json.loads(out.stdout)
