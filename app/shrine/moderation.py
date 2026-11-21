"""차단 · 강퇴 확인 자리 (server/moderation.ts isBlocked). P3가 이 파일을 채웁니다.

    blocked = await moderation.is_blocked(ctx, ip, sid)     # ip: 원래 IP(request.state.client_ip), sid: 입장 표의 sid

Node isBlocked(ipKey, sid):
  · 10초마다 PRAGMA data_version으로 다른 프로세스(CLI)가 바꾼 차단을 다시 읽고, 메모리 사본 byIp / bySid로 판정
  · sid가 있으면 bySid[sid] > now → 막힘
  · ipKey는 'k:'+32자 차단 키면 그대로, IP면 blockKey(ip)(logic.crypto.block_key), 그 밖이면 오늘 본 그날 IP 해시 → 차단 키
  · 어떤 오류든 막지 않음(false)

P3 할 일: 메모리(또는 Redis) 사본 + 10초 갱신, 접속 중인 사람 4005로 끊기, 강퇴(kick), 그날 해시 → 차단 키 매핑.
지금은 그 전까지 쓰는 단순한 판정입니다: blocks 표를 요청마다 바로 봅니다 (캐시 없음, 오류면 '막히지 않음').
web/registry.py(P2b)의 is_blocked와 같은 규칙이라, 두 곳 모두 이 함수로 모으면 됩니다.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from sqlalchemy import text

from .logic.crypto import KEY_RE, block_key
from .logic.util import now_ms

if TYPE_CHECKING:
    from .context import AppContext

__all__ = ["is_blocked"]

log = logging.getLogger("shrine.moderation")

_CHECK = text(
    """SELECT 1 FROM blocks WHERE until > :now
         AND ((:sid <> '' AND sid = :sid) OR (:k <> '' AND ip_key = :k)) LIMIT 1"""
)


async def is_blocked(ctx: AppContext, ip: str, sid: str | None = None) -> bool:
    """그 IP(또는 차단 키)나 입장 표(sid)가 지금 차단 · 강퇴 중인지. 어떤 오류에도 False."""
    try:
        k = ip if KEY_RE.fullmatch(ip or "") else block_key(ip or "", ctx.config.ticket_secret)
        if not sid and not k:
            return False
        assert ctx.db is not None
        async with ctx.db.engine.connect() as conn:
            row = (await conn.execute(_CHECK, {"now": now_ms(), "sid": sid or "", "k": k})).first()
        return row is not None
    except Exception as e:  # noqa: BLE001
        log.warning("[shrine] 차단 확인 실패 (%s): 막지 않고 넘깁니다", type(e).__name__)
        return False
