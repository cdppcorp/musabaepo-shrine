"""실시간 (WebSocket ``${BASE}/ws``) — server/realtime.ts. 상태는 ctx마다 하나 (ctx.realtime, uvicorn 워커 1개 전제).

  core.py      채널 · 접속자 · 업그레이드 검사 · 보내기 · 100ms 묶음 전송 · 5초 정리 · 운영자 쪽 함수
  handlers.py  메시지마다 검사 · 답 (mv · say · emo · chat · sit · aipray · post · report · reportUser · light · chans)
  conn.py      연결 하나의 보낼 줄 (256KB 넘으면 끊음) · 닫기 · 끊기
  board.py     게시판 글쓰기 · 글 신고 (DB)
  jsvalue.py   JS Number() (메시지 칸)
  lifecycle.py 끝내기 · 잡히지 않은 예외 · SHRINE_TEST_STDIN 시험 훅 · uvicorn 설정 · PostgreSQL lock_timeout
NPC는 shrine/npc.py, 차단 · 신고는 shrine/moderation.py, 라우트 등록은 web/ws.py.

운영자 API · 운영 명령(P4)이 부르는 함수 (모두 첫 인자 ctx):

| 이름 | 동기/비동기 | 돌려주는 값 |
|---|---|---|
| ``players_for_admin(ctx)`` | sync | [{id, npc, players: [{id, nick, since, idleSec, seated, sameIp, reports}]}] |
| ``is_online(ctx, sid)`` | sync | bool |
| ``kick_player(ctx, id, reason)`` | async | {nick, block} 또는 None (없는 사람) |
| ``block_target(ctx, target, ms, by_ip, reason)`` | async | block (ModerationError 가능) |
| ``block_player(ctx, id, ms, by_ip, reason)`` | async | {nick, block} 또는 None |
| ``set_free_chat(ctx, on)`` · ``free_chat(ctx)`` | sync | - / bool (지금 값. ctx.config.free_chat은 .env 값 그대로) |
| ``realtime_stats(ctx)`` · ``channel_stats(ctx)`` | sync | {connections, channels, npcs} · {connections, channels:[{id,n,npc}]} |
| ``start_realtime(ctx)`` · ``stop_realtime(ctx, timeout_s=3)`` | async | 서버 시작 · 끝 (web/ws.py install이 겁니다) |
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..context import AppContext
    from .core import Realtime

__all__ = [
    "block_player", "block_target", "channel_stats", "free_chat", "is_online", "kick_player", "players_for_admin",
    "realtime_of", "realtime_stats", "set_free_chat", "start_realtime", "stop_realtime",
]  # fmt: skip


def realtime_of(ctx: AppContext) -> Realtime:
    """이 ctx의 실시간 상태 (처음 부르면 만듦)."""
    rt = ctx.__dict__.get("realtime")
    if rt is None:
        from .core import Realtime

        rt = Realtime(ctx)
        ctx.__dict__["realtime"] = rt
    return rt


def players_for_admin(ctx: AppContext) -> list[dict[str, Any]]:
    return realtime_of(ctx).players_for_admin()


def is_online(ctx: AppContext, sid: str) -> bool:
    return sid in realtime_of(ctx).by_sid


async def kick_player(ctx: AppContext, pid: Any, reason: Any = None) -> dict[str, Any] | None:
    return await realtime_of(ctx).kick_player(pid, reason)


async def block_target(ctx: AppContext, target: Mapping[str, Any], ms: Any, by_ip: bool, reason: Any = None) -> dict[str, Any]:
    t = target if isinstance(target, Mapping) else {k: getattr(target, k, None) for k in ("pid", "sid", "ipKey", "nick", "channel", "exp")}
    return await realtime_of(ctx).block_target(t, ms, by_ip, reason)


async def block_player(ctx: AppContext, pid: Any, ms: Any, by_ip: bool, reason: Any = None) -> dict[str, Any] | None:
    return await realtime_of(ctx).block_player(pid, ms, by_ip, reason)


def set_free_chat(ctx: AppContext, on: bool) -> None:
    realtime_of(ctx).set_free_chat(on)


def free_chat(ctx: AppContext) -> bool:
    """지금 직접 쓰는 채팅이 켜져 있는지 (Node config.freeChat — 운영자 화면에서 바꾸면 다시 띄울 때까지 그 값)."""
    rt = ctx.__dict__.get("realtime")
    return bool(rt.free_chat) if rt is not None else bool(ctx.config.free_chat)


def realtime_stats(ctx: AppContext) -> dict[str, Any]:
    return realtime_of(ctx).realtime_stats()


def channel_stats(ctx: AppContext) -> dict[str, Any]:
    return realtime_of(ctx).channel_stats()


async def start_realtime(ctx: AppContext) -> None:
    await realtime_of(ctx).start()


async def stop_realtime(ctx: AppContext, timeout_s: float = 3.0) -> None:
    await realtime_of(ctx).stop(timeout_s)
