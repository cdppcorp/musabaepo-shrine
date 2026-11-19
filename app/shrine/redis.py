"""Redis: 요청 제한 · 잠금 · 신고처럼 Node가 프로세스 메모리에 두던 짧은 상태.

키 규칙
  · 모든 키는 `shrine:` 로 시작합니다 → `key('rl', 'req', ip_hash)` = `shrine:rl:req:<ip_hash>`
  · 첫 조각이 용도입니다: rl(요청 제한) · lock(잠금) · …  나중 단계는 이 아래에 새 조각을 붙입니다.
  · 모든 키에 만료(TTL)를 붙입니다. Redis는 디스크에 쓰지 않고(재시작하면 비어 있음 = Node의 메모리와 같음)
    메모리가 차면 만료가 붙은 키부터 버립니다 (deploy/docker-compose.py.yml).
  · IP는 원래 값을 넣지 않고 그날 IP 해시(web/net.py ip_hash)나 서버 키로 만든 값만 넣습니다.
"""

from __future__ import annotations

import logging
import time

import redis.asyncio as aioredis
from redis.exceptions import RedisError

log = logging.getLogger("shrine.redis")

KEY_PREFIX = "shrine:"


def key(*parts: str) -> str:
    """`shrine:` + 조각을 ':'로 이은 키."""
    if not parts or any(not p for p in parts) or ":" in parts[0]:
        raise ValueError(f"잘못된 Redis 키 조각: {parts!r}")
    return KEY_PREFIX + ":".join(parts)


def connect(url: str) -> aioredis.Redis:
    """클라이언트를 만듭니다 (연결은 처음 쓸 때). 값은 bytes로 돌려받습니다."""
    return aioredis.from_url(
        url,
        socket_connect_timeout=3,
        socket_timeout=3,
        health_check_interval=30,
        retry_on_timeout=False,
        client_name="musabaepo-shrine",
    )


# 창이 처음 열릴 때만 만료를 겁니다 (Node WindowLimiter: 첫 요청부터 windowMs 동안 limit번)
_WINDOW_LUA = """
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n
"""


class FixedWindowLimiter:
    """고정 창 요청 제한 (security.ts WindowLimiter와 같은 규칙).

    키마다 첫 요청 때 창이 열리고 window_ms 동안 limit번까지 허락합니다. 여러 요청이 동시에 와도
    Lua 스크립트 하나로 세므로 정확합니다.

    fail_open=True(기본): Redis가 답하지 않으면 허락합니다 (가용성 우선, 로그는 1분에 한 번).
    잠금처럼 막는 쪽이 안전한 곳은 fail_open=False로 만듭니다.
    """

    def __init__(self, client: aioredis.Redis, name: str, limit: int, window_ms: int, *, fail_open: bool = True):
        self.client = client
        self.name = name
        self.limit = limit
        self.window_ms = window_ms
        self.fail_open = fail_open
        self._script = client.register_script(_WINDOW_LUA)
        self._warned_at = 0.0

    async def hit(self, subject: str) -> int:
        """이번 요청을 세고 창 안의 개수를 돌려줍니다 (Redis 오류는 그대로 올림)."""
        return int(await self._script(keys=[key("rl", self.name, subject)], args=[self.window_ms]))

    async def allow(self, subject: str) -> bool:
        try:
            return await self.hit(subject) <= self.limit
        except (RedisError, OSError) as e:
            now = time.monotonic()
            if now - self._warned_at > 60:
                self._warned_at = now
                log.warning("[shrine] 요청 제한(%s)을 Redis에서 세지 못했습니다 (%s). %s", self.name, e,
                            "이번 요청은 통과시킵니다" if self.fail_open else "이번 요청은 막습니다")
            return self.fail_open
