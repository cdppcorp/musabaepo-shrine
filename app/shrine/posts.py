"""AI 트렌드 게시판 글 읽기 (server/ai.ts listPosts · prunePosts). 글쓰기 · 신고는 실시간(WebSocket, P3)에서 덧붙입니다.

글은 7일 보여 주고 지웁니다. 글에는 자동 닉네임만 있고 IP 같은 정보는 없습니다.
부르는 쪽(``target``)은 ``ctx`` · ``Database`` · ``AsyncSession`` · ``AsyncConnection`` (shrines.py와 같은 규칙).
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession

from .logic.util import now_ms
from .shrines import _database, _rows

__all__ = ["KEEP_MS", "POST_KEEP_DAYS", "POST_MAX", "REPORT_HIDE", "list_posts", "prune_posts"]

POST_MAX = 80
POST_KEEP_DAYS = 7
REPORT_HIDE = 3
KEEP_MS = POST_KEEP_DAYS * 24 * 3600_000

# SQLite는 posts_at 색인을 거꾸로 훑어 같은 시각이면 나중 글(id 큰 것)이 먼저 나옵니다. 같은 순서를 적어 둡니다
LIST_POSTS = text(
    """SELECT id, at, topic, text, nick FROM posts WHERE hidden = 0 AND at >= :since
       ORDER BY at DESC, id DESC LIMIT :limit"""
)


async def list_posts(target: Any, limit: int = 60, now: int | None = None) -> list[dict[str, Any]]:
    """보이는 글 (최근 7일, 숨기지 않은 것), 새 글부터: [{id, at, topic, text, nick}]."""
    n = now_ms() if now is None else now
    rows = await _rows(target, LIST_POSTS, {"since": n - KEEP_MS, "limit": limit})
    return [{"id": r["id"], "at": r["at"], "topic": r["topic"], "text": r["text"], "nick": r["nick"]} for r in rows]


async def prune_posts(target: Any, now: int | None = None) -> dict[str, int]:
    """7일 지난 글과 그 신고 기록(글이 없어진 신고 기록 포함)을 지웁니다. {posts, reports}: 지운 수."""
    n = now_ms() if now is None else now

    async def run(conn: AsyncSession | AsyncConnection) -> dict[str, int]:
        posts = (await conn.execute(text("DELETE FROM posts WHERE at < :cut"), {"cut": n - KEEP_MS})).rowcount
        reports = (
            await conn.execute(text("DELETE FROM post_reports WHERE post_id NOT IN (SELECT id FROM posts)"))
        ).rowcount
        return {"posts": int(posts or 0), "reports": int(reports or 0)}

    if isinstance(target, (AsyncSession, AsyncConnection)):
        return await run(target)
    async with _database(target).engine.begin() as conn:
        return await run(conn)
