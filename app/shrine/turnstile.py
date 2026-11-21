"""사람 확인 (Cloudflare Turnstile) — security.ts verifyHuman.

  · 개발 모드이고 TURNSTILE_SECRET이 없으면 건너뜀 (config.dev_skip_human_check, 운영에서는 절대 켜지지 않음)
  · 토큰은 10~2048자(UTF-16 코드 단위) 문자열이어야 함
  · POST https://challenges.cloudflare.com/turnstile/v0/siteverify (form: secret, response, remoteip), 전체 5초, 재시도 없음
  · 답의 JSON에서 success가 정확히 true일 때만 통과. 그 밖(시간 초과 · 연결 실패 · JSON 아님 · 객체 아님)은 모두 실패
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from .config import Config
from .logic.jsnum import json_parse
from .logic.jsstr import utf16_len

__all__ = ["SITEVERIFY_URL", "TIMEOUT_S", "verify_human"]

SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
TIMEOUT_S = 5.0


async def _siteverify(secret: str, token: str, ip: str, transport: httpx.AsyncBaseTransport | None) -> Any:
    async with httpx.AsyncClient(timeout=TIMEOUT_S, follow_redirects=True, transport=transport) as client:
        res = await client.post(SITEVERIFY_URL, data={"secret": secret, "response": token, "remoteip": ip})
        return json_parse(res.content.decode("utf-8", "replace"))


async def verify_human(config: Config, token: Any, ip: str, *, transport: httpx.AsyncBaseTransport | None = None) -> bool:
    """통과하면 True. transport는 시험용 (httpx.MockTransport)."""
    if config.dev_skip_human_check:
        return True
    if not isinstance(token, str) or utf16_len(token) < 10 or utf16_len(token) > 2048:
        return False
    try:
        data = await asyncio.wait_for(_siteverify(config.turnstile_secret, token, ip, transport), TIMEOUT_S)
    except Exception:  # noqa: BLE001 — Node: catch { return false }
        return False
    return isinstance(data, dict) and data.get("success") is True
