"""AI 트렌드 게시판 글쓰기 · 글 신고 (server/ai.ts addPost · reportPost). 읽기 · 정리는 posts.py(P2a)에 있습니다.

  · 글에는 자동 닉네임만 남기고 IP 같은 정보는 저장하지 않습니다.
  · 신고한 사람은 "그날 IP 해시 + 글 번호"를 한 번 더 해시한 값으로만 구분합니다 (글끼리 묶어 볼 수 없음).
  · 서로 다른 3명이 신고하면 숨기고 운영자에게 알립니다 (첫 신고 때도 한 번).
  · 보안 점검: '서로 다른 사람'은 IP(IPv6는 /64)와 입장 표(sid) 둘 다 다른 사람입니다. 둘 중 하나라도 이미 신고한
    사람과 같으면 다시 세지 않습니다. 한 행에 '<IP 쪽 해시>.<sid 쪽 해시>'로 둡니다 (예전 행은 IP 쪽 해시만).
    그래서 행 수 = 센 신고 수입니다 (운영자 화면의 신고 수도 그대로). 같은 글 신고는 글 행을 잠가 차례로 셉니다.
Node는 문장마다 따로 썼고, 여기서는 한 트랜잭션으로 묶습니다 (중간에 다른 요청이 끼어도 숫자가 맞게). 다른 연결이 표를
잠그면 lock_timeout(약 3초) 뒤 예외가 그대로 올라갑니다 (실시간이 로그를 남기고 그 사람에게만 실패로 답함).
"""

from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING, Any

from sqlalchemy import text

from .. import notify as notify_mod
from ..logic.crypto import b64url
from ..logic.jsnum import number_to_string
from ..logic.util import now_ms
from ..logic.world import AI_KEYS
from ..posts import POST_MAX, REPORT_HIDE, prune_posts

if TYPE_CHECKING:
    from ..context import AppContext

__all__ = ["BIGINT_MAX", "POST_MAX", "POST_TOPICS", "add_post", "is_post_topic", "report_post"]

#: 글 주제: AI 다섯 + 기타
POST_TOPICS: tuple[str, ...] = (*AI_KEYS, "etc")
BIGINT_MAX = 2**63 - 1


def is_post_topic(v: Any) -> bool:
    return isinstance(v, str) and v in POST_TOPICS


async def add_post(ctx: AppContext, topic: str, body: str, nick: str) -> dict[str, Any]:
    """7일 지난 글을 지우고 새 글을 넣습니다 → {id, at, topic, text, nick}."""
    at = now_ms()
    assert ctx.db is not None
    async with ctx.db.engine.begin() as conn:
        await prune_posts(conn, at)
        pid = (
            await conn.execute(
                text("INSERT INTO posts (at, topic, text, nick) VALUES (:at, :topic, :text, :nick) RETURNING id"),
                {"at": at, "topic": topic, "text": body, "nick": nick},
            )
        ).scalar_one()
    return {"id": int(pid), "at": at, "topic": topic, "text": body, "nick": nick}


def reporter_key(post_id: Any, reporter: str) -> str:
    """``sha256('post-report:<id>:<그날 IP 해시>')`` base64url 앞 22자."""
    return b64url(hashlib.sha256(f"post-report:{number_to_string(post_id)}:{reporter}".encode()).digest())[:22]


async def report_post(ctx: AppContext, post_id: Any, reporter: str, sid: str | None = None) -> str:
    """신고 → 'none'(없는 글) · 'ok' · 'hidden'(이번 신고로 숨김). reporter: 그날 IP 해시(/64), sid: 입장 표."""
    if not isinstance(post_id, (int, float)) or post_id <= 0 or post_id > BIGINT_MAX:
        return "none"
    pid = int(post_id)
    assert ctx.db is not None
    async with ctx.db.engine.begin() as conn:
        # FOR UPDATE: 같은 글의 신고를 차례로 (IP · sid 둘 다 보고 넣는 사이에 다른 신고가 끼지 않게)
        row = (
            await conn.execute(text("SELECT hidden, topic FROM posts WHERE id = :id FOR UPDATE"), {"id": pid})
        ).mappings().first()
        if row is None:
            return "none"
        ip_part = reporter_key(post_id, reporter)
        sid_part = reporter_key(post_id, f"sid:{sid}") if sid else ""
        seen = (
            await conn.execute(
                text(
                    """SELECT 1 FROM post_reports WHERE post_id = :id
                       AND (split_part(reporter, '.', 1) = :ip OR (:sid <> '' AND split_part(reporter, '.', 2) = :sid))
                       LIMIT 1"""
                ),
                {"id": pid, "ip": ip_part, "sid": sid_part},
            )
        ).first() is not None
        added = not seen and (
            await conn.execute(
                text("INSERT INTO post_reports (post_id, reporter) VALUES (:id, :r) ON CONFLICT DO NOTHING"),
                {"id": pid, "r": f"{ip_part}.{sid_part}" if sid_part else ip_part},
            )
        ).rowcount > 0
        n = int((await conn.execute(text("SELECT COUNT(*) FROM post_reports WHERE post_id = :id"), {"id": pid})).scalar_one())
        hide = not row["hidden"] and n >= REPORT_HIDE
        if hide:
            await conn.execute(text("UPDATE posts SET hidden = 1 WHERE id = :id"), {"id": pid})
    if hide:
        notify_mod.notify("게시판 글을 신고로 숨김", {"글": pid, "주제": row["topic"], "신고": n})
        return "hidden"
    # 운영자에게는 첫 신고 때 한 번 (글 내용은 알림에 넣지 않습니다)
    if added and n == 1:
        notify_mod.notify("게시판 글 신고", {"글": pid, "주제": row["topic"], "신고": n})
    return "ok"


__all__ += ["reporter_key"]
_ = POST_MAX
