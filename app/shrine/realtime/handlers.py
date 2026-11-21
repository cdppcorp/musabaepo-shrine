"""클라이언트 → 서버 메시지 처리 (server/realtime.ts onMessage · dispatch · on*). 검사 순서 · 답 모양 · 키 순서를 Node와 같게.

공통: 바이너리 → 1003, 토큰 버킷(초당 15, 최대 30)이 모자라면 1008 (잘못된 JSON도 토큰 하나), 객체가 아니면 무시,
마지막 입력 시각 갱신, 처리 중 예외는 로그 + 1분에 5번이면 1011. 숫자 칸은 JS ``Number()`` 기준 (jsvalue.to_number).

| t | 답 |
|---|---|
| mv | (통과) st 묶음에 실림 / fix {x, y} |
| say | say {id, k} (채널) |
| emo | emo {id, k[, i]} (채널) / emoNo {k, reason:'zone'} |
| chat | chat {id, s} (채널) / chatNo {reason} |
| sit | sit {id, s, x, y, d} (채널) / sitNo {reason} |
| aipray | aipray {a, by} (채널) / aiNo {a, reason:'far'} |
| post | postOk {id} + post {post} (모두) / postNo {reason} |
| report | reported {id} (+ postHide {id} 모두) / reportNo {id, reason:'closed'} |
| reportUser | reportUserOk {id, again} / reportUserNo {id, reason} |
| light | lit {s, ok:true, p, wait} + candle {…} (모두) / lit {s, ok:false, reason[, wait]} |
| chans | chans {list} |
"""

from __future__ import annotations

import math
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from .. import moderation
from ..logic.chat import clean_chat
from ..logic.jsnum import UNDEFINED, JSONParseError, is_integer, js_hypot, js_round, json_parse
from ..logic.jsstr import slice_units
from ..logic.links import is_prayer_key
from ..logic.util import kst_date, now_ms
from ..logic.world import (
    AI_SHRINES, BUBBLE_COUNT, EMOTES, MAP_H, MAP_W, PLOTS, REACH_SERVER, SIGH_COUNT, SMOKE_ZONE, SPEED, TREND_RECT, blocked,
    near, near_box, shrine_channel_of,
)  # fmt: skip
from .board import POST_MAX, add_post, is_post_topic, report_post
from .conn import OPEN
from .core import MSG_BURST, MSG_PER_SEC, seat_at
from .jsvalue import to_number

if TYPE_CHECKING:
    from .core import Player, Realtime

SAY_COOLDOWN_MS = 1500
EMOTE_COOLDOWN_MS = 1000
#: 직접 쓴 메시지: 1분에 12개까지, 같은 말은 15초 안에 다시 못 보냄
CHAT_PER_MIN = 12
CHAT_REPEAT_MS = 15_000
#: 신고할 때 함께 올리는 그 사람의 최근 말풍선 수 (메모리에만)
RECENT_LINES = 5
#: 사람 신고: 한 사람 15초에 하나, 1시간에 10개
REPORT_GAP_MS = 15_000
REPORTS_PER_HOUR = 10
#: 같은 IP에서 같은 사당에 켤 수 있는 초: 1시간에 10개 (사무실 · 통신사 IP를 같이 쓰는 사람들 몫)
IP_CANDLES_PER_HOUR = 10
#: AI 기도는 몇 번이든 되지만 너무 잦으면 무시합니다 (ms)
AI_PRAY_GAP_MS = 1200
#: 게시판 글: 한 사람 30초에 하나, IP당 하루 20개
POST_GAP_MS = 30_000
POSTS_PER_DAY = 20


def _get(m: dict[str, Any], k: str) -> Any:
    """``m.k`` (칸이 없으면 undefined)."""
    return m.get(k, UNDEFINED)


def take_token(p: Player) -> bool:
    """초당 메시지 수 제한 (토큰 버킷). 넘으면 연결을 끊습니다."""
    now = now_ms()
    p.tokens = min(MSG_BURST, p.tokens + ((now - p.tokens_at) / 1000) * MSG_PER_SEC)
    p.tokens_at = now
    if p.tokens < 1:
        return False
    p.tokens -= 1
    return True


async def on_message(rt: Realtime, p: Player, msg: dict[str, Any]) -> None:
    data = msg.get("text")
    if data is None:
        p.conn.close(1003, "binary")
        return
    if not take_token(p):
        p.conn.close(1008, "rate")
        return
    try:
        m = json_parse(data)
    except JSONParseError:
        return
    if not isinstance(m, dict):
        return
    t = m.get("t")
    kind = slice_units(t, 0, 12) if isinstance(t, str) else "?"
    p.last_input_at = now_ms()
    handler = HANDLERS.get(t) if isinstance(t, str) else None
    if handler is None:
        return
    before = (p.x, p.y)
    try:
        await handler(rt, p, m)
    except Exception as e:  # noqa: BLE001
        rt.on_handler_error(p, kind, e)
    # 자리 비움 판정 (보안 점검): 같은 자리 mv를 되풀이하는 것은 '한 일'로 세지 않습니다
    if t in ACTIVE_KINDS or (t == "mv" and (p.x, p.y) != before):
        p.last_active_at = now_ms()


async def on_move(rt: Realtime, p: Player, m: dict[str, Any]) -> None:
    x = to_number(_get(m, "x"))
    y = to_number(_get(m, "y"))
    if not math.isfinite(x) or not math.isfinite(y):
        return
    # 앉은 채로 움직이면 먼저 일으켜 세웁니다 (화면은 보통 일어나기를 먼저 보냄)
    if p.seat >= 0:
        stand_up(rt, p)
    now = now_ms()
    p.budget = min(SPEED * 1.2, p.budget + (SPEED * 1.5 * (now - p.last_move_at)) / 1000)
    p.last_move_at = now
    dist = js_hypot(x - p.x, y - p.y)
    if dist > p.budget + 6 or x < 0 or y < 0 or x > MAP_W or y > MAP_H or blocked(x, y):
        rt.send(p, {"t": "fix", "x": p.x, "y": p.y})
        return
    p.budget -= dist
    p.x = js_round(x * 10) / 10
    p.y = js_round(y * 10) / 10
    d = to_number(_get(m, "d"))
    if is_integer(d) and 0 <= d <= 3:
        p.d = int(d)
    p.moving = m.get("m") is True
    p.dirty = True


async def on_say(rt: Realtime, p: Player, m: dict[str, Any]) -> None:
    k = to_number(_get(m, "k"))
    now = now_ms()
    if not is_integer(k) or k < 0 or k >= BUBBLE_COUNT or now - p.last_say < SAY_COOLDOWN_MS:
        return
    p.last_say = now
    rt.broadcast(p.channel, {"t": "say", "id": p.id, "k": int(k)})


async def on_ai_pray(rt: Realtime, p: Player, m: dict[str, Any]) -> None:
    """AI 신당 기도: 그 신당 앞 · 뒤 · 옆 어디든 근처면. 몇 번이든 되고 어디에도 기록하지 않습니다 (빛나는 연출만)."""
    a = _get(m, "a")
    shrine = next((s for s in AI_SHRINES if isinstance(a, str) and s["key"] == a), None)
    if shrine is None:
        return
    if not near_box(p.pt(), shrine["box"], REACH_SERVER):
        rt.send(p, {"t": "aiNo", "a": shrine["key"], "reason": "far"})
        return
    now = now_ms()
    if now - p.last_ai_pray < AI_PRAY_GAP_MS:
        return
    p.last_ai_pray = now
    rt.broadcast(p.channel, {"t": "aipray", "a": shrine["key"], "by": p.id})


async def on_post(rt: Realtime, p: Player, m: dict[str, Any]) -> None:
    """AI 트렌드 게시판 글쓰기: 게시판 앞에서만. 거르는 규칙은 채팅과 같고 길이만 80자."""
    # 게시판은 BOARD_OPEN=on일 때만 엽니다 (기본은 '준비 중')
    if not rt.config.board_open:
        return rt.send(p, {"t": "postNo", "reason": "closed"})
    if not rt.free_chat:
        return rt.send(p, {"t": "postNo", "reason": "off"})
    if not near_box(p.pt(), TREND_RECT, REACH_SERVER):
        return rt.send(p, {"t": "postNo", "reason": "far"})
    topic = _get(m, "a")
    if not is_post_topic(topic):
        return rt.send(p, {"t": "postNo", "reason": "topic"})
    now = now_ms()
    if now - p.last_post_at < POST_GAP_MS:
        return rt.send(p, {"t": "postNo", "reason": "slow"})
    day = kst_date(now)
    used = rt.posts_by_ip.get(p.ip_key)
    if used is not None and used["day"] == day and used["n"] >= POSTS_PER_DAY:
        return rt.send(p, {"t": "postNo", "reason": "many"})
    v = clean_chat(_get(m, "s"), POST_MAX)
    if not v["ok"]:
        return rt.send(p, {"t": "postNo", "reason": v["reason"]})
    # 저장을 기다리는 동안 같은 IP의 다른 연결이 끼지 않게 먼저 셉니다 (실패하면 되돌림)
    slot = {"day": day, "n": used["n"] + 1 if used is not None and used["day"] == day else 1}
    rt.posts_by_ip[p.ip_key] = slot
    try:
        post = await add_post(rt.ctx, topic, v["text"], p.nick)
    except Exception as e:  # noqa: BLE001
        cur = rt.posts_by_ip.get(p.ip_key)
        if cur is not None and cur["day"] == day:
            cur["n"] -= 1
            if cur["n"] <= 0:
                rt.posts_by_ip.pop(p.ip_key, None)
        rt.log_error("게시판 글 저장", e)
        return rt.send(p, {"t": "postNo", "reason": "error"})
    p.last_post_at = now
    rt.send(p, {"t": "postOk", "id": post["id"]})
    rt.broadcast_all({"t": "post", "post": post})


async def on_report(rt: Realtime, p: Player, m: dict[str, Any]) -> None:
    """게시판 글 신고: 서로 다른 사람(IP /64 해시 · 입장 표 둘 다 다름) 3명이면 숨기고 모두에게 알립니다."""
    pid = to_number(_get(m, "id"))
    if not rt.config.board_open:
        return rt.send(p, {"t": "reportNo", "id": pid if is_integer(pid) else 0, "reason": "closed"})
    if not is_integer(pid) or pid <= 0:
        return None
    r = await report_post(rt.ctx, pid, p.ip_key, p.sid)
    if r == "none":
        return None
    rt.send(p, {"t": "reported", "id": pid})
    if r == "hidden":
        rt.broadcast_all({"t": "postHide", "id": pid})
    return None


async def on_report_user(rt: Realtime, p: Player, m: dict[str, Any]) -> None:
    """사람 신고 {id, r}: 같은 채널의 실제 사람만. 그 사람의 최근 말풍선 몇 개와 함께 운영자 화면에 올립니다."""
    raw = _get(m, "id")
    pid = slice_units(raw, 0, 16) if isinstance(raw, str) else ""
    target = p.channel.players.get(pid) if pid else None
    if target is None:
        return rt.send(p, {"t": "reportUserNo", "id": pid, "reason": "none"})
    if target is p:
        return rt.send(p, {"t": "reportUserNo", "id": pid, "reason": "self"})
    now = now_ms()
    p.report_times = [t for t in p.report_times if now - t < 3600_000]
    if now - p.last_report_at < REPORT_GAP_MS or len(p.report_times) >= REPORTS_PER_HOUR:
        return rt.send(p, {"t": "reportUserNo", "id": pid, "reason": "slow"})
    p.last_report_at = now
    p.report_times.append(now)
    reason = _get(m, "r")
    r = moderation.add_user_report(
        rt.ctx, rt.target_of(target), p.ip_key, reason if moderation.is_report_reason(reason) else "other", target.recent
    )
    rt.send(p, {"t": "reportUserOk", "id": pid, "again": r["again"]})
    return None


async def on_sit(rt: Realtime, p: Player, m: dict[str, Any]) -> None:
    """앉기 · 일어나기. 의자 가까이에서만, 다른 사람(NPC 포함)이 앉은 자리는 안 됩니다."""
    s = to_number(_get(m, "s"))
    if s == -1:
        return stand_up(rt, p)
    seat = seat_at(int(s)) if is_integer(s) else None
    if seat is None or p.seat == s:
        return None
    if not near(p.pt(), seat, 26):
        return rt.send(p, {"t": "sitNo", "reason": "far"})
    for o in p.channel.players.values():
        if o is not p and o.seat == s:
            return rt.send(p, {"t": "sitNo", "reason": "taken"})
    if rt.npcs is not None and rt.npcs.seat_taken(p.channel.id, seat["id"]):
        return rt.send(p, {"t": "sitNo", "reason": "taken"})
    p.seat = seat["id"]
    p.x = seat["x"]
    p.y = seat["y"]
    p.d = seat["d"]
    p.moving = False
    p.budget = 0
    rt.broadcast(p.channel, {"t": "sit", "id": p.id, "s": p.seat, "x": p.x, "y": p.y, "d": p.d})
    return None


def stand_up(rt: Realtime, p: Player) -> None:
    seat = seat_at(p.seat)
    if seat is None:
        return
    p.seat = -1
    p.x = seat["stand"]["x"]
    p.y = seat["stand"]["y"]
    p.moving = False
    p.last_move_at = now_ms()
    rt.broadcast(p.channel, {"t": "sit", "id": p.id, "s": -1, "x": p.x, "y": p.y, "d": p.d})


async def on_chat(rt: Realtime, p: Player, m: dict[str, Any]) -> None:
    """직접 쓴 메시지: 검사를 통과하면 같은 채널에 말풍선으로만 뿌리고 저장하지 않습니다 (신고용으로 최근 몇 개만 메모리에)."""
    if not rt.free_chat:
        return rt.send(p, {"t": "chatNo", "reason": "off"})
    now = now_ms()
    p.chat_times = [t for t in p.chat_times if now - t < 60_000]
    if now - p.last_say < SAY_COOLDOWN_MS or len(p.chat_times) >= CHAT_PER_MIN:
        return rt.send(p, {"t": "chatNo", "reason": "slow"})
    v = clean_chat(_get(m, "s"))
    if not v["ok"]:
        return rt.send(p, {"t": "chatNo", "reason": v["reason"]})
    text = v["text"]
    if text == p.last_chat and now - p.last_chat_at < CHAT_REPEAT_MS:
        return rt.send(p, {"t": "chatNo", "reason": "same"})
    p.last_say = now
    p.last_chat = text
    p.last_chat_at = now
    p.chat_times.append(now)
    p.recent.append({"at": now, "s": text})
    if len(p.recent) > RECENT_LINES:
        p.recent.pop(0)
    rt.broadcast(p.channel, {"t": "chat", "id": p.id, "s": text})
    return None


async def on_emote(rt: Realtime, p: Player, m: dict[str, Any]) -> None:
    k = _get(m, "k")
    now = now_ms()
    if not isinstance(k, str) or k not in EMOTES or now - p.last_emote < EMOTE_COOLDOWN_MS:
        return None
    if k == "smoke":
        # 흡연은 '고뇌와 번뇌의 공간' 안에서만
        if not near(p.pt(), SMOKE_ZONE, SMOKE_ZONE["r"]):
            return rt.send(p, {"t": "emoNo", "k": k, "reason": "zone"})
        i = to_number(_get(m, "i"))
        p.last_emote = now
        rt.broadcast(p.channel, {"t": "emo", "id": p.id, "k": k, "i": int(i) if is_integer(i) and 0 <= i < SIGH_COUNT else 0})
        return None
    p.last_emote = now
    rt.broadcast(p.channel, {"t": "emo", "id": p.id, "k": k})
    return None


async def on_light(rt: Realtime, p: Player, m: dict[str, Any]) -> None:
    from ..shrines import add_candle, find_shrine

    raw = _get(m, "s")
    slug = slice_units(raw, 0, 40) if isinstance(raw, str) else ""
    shrine = await find_shrine(rt.ctx, slug)
    # 다른 채널의 사당은 이 채널에 없는 것과 같습니다 (사당은 자기 채널에서만 보임)
    if shrine is not None and shrine["channel"] != shrine_channel_of(p.channel.id):
        return rt.send(p, {"t": "lit", "s": slug, "ok": False, "reason": "channel"})
    if shrine is None or shrine["status"] != "live":
        return rt.send(p, {"t": "lit", "s": slug, "ok": False, "reason": "closed"})
    prayer = _get(m, "p")
    if not is_prayer_key(prayer):
        return rt.send(p, {"t": "lit", "s": slug, "ok": False, "reason": "prayer"})
    plot_no = shrine["plot"]
    plot = PLOTS[plot_no] if isinstance(plot_no, int) and 0 <= plot_no < len(PLOTS) else None
    if plot is None or not near_box(p.pt(), plot["box"], REACH_SERVER):
        return rt.send(p, {"t": "lit", "s": slug, "ok": False, "reason": "far"})
    # 같은 IP(사무실 · 통신사)에서 같은 사당은 시간당 상한만 둡니다
    hour = now_ms() // 3_600_000
    ip_slot = f"{p.ip_key}|{slug}"
    used = rt.ip_candles.get(ip_slot)
    if used is not None and used["hour"] == hour and used["n"] >= IP_CANDLES_PER_HOUR:
        return rt.send(p, {"t": "lit", "s": slug, "ok": False, "reason": "busy"})
    # 같은 사당은 한 사람(입장 표) 30분에 한 번. wait = 이 사당에 다시 켤 수 있을 때까지 남은 초 (켰을 때 · 이미 켰을 때)
    verdict, wait_ms = rt.candle_guard.check([f"s:{p.sid}"], slug)
    wait = math.ceil(wait_ms / 1000)
    if verdict == "already":
        return rt.send(p, {"t": "lit", "s": slug, "ok": False, "reason": verdict, "wait": wait})
    if verdict != "ok":
        return rt.send(p, {"t": "lit", "s": slug, "ok": False, "reason": verdict})
    # 쓰기를 기다리는 동안 같은 IP의 다른 연결이 끼지 않게 먼저 셉니다 (실패하면 되돌림)
    rt.ip_candles[ip_slot] = {"hour": hour, "n": used["n"] + 1 if used is not None and used["hour"] == hour else 1}
    try:
        await add_candle(rt.ctx, slug, prayer)
    except Exception as e:  # noqa: BLE001
        cur = rt.ip_candles.get(ip_slot)
        if cur is not None and cur["hour"] == hour:
            cur["n"] -= 1
            if cur["n"] <= 0:
                rt.ip_candles.pop(ip_slot, None)
        # 디스크가 차거나 잠긴 경우. 이 사람만 실패를 알리고 서버는 계속 돕니다
        rt.log_error("초 기록", e)
        return rt.send(p, {"t": "lit", "s": slug, "ok": False, "reason": "error"})
    total = await rt.candles_now()
    rt.send(p, {"t": "lit", "s": slug, "ok": True, "p": prayer, "wait": wait})
    if total:
        rt.broadcast_all(
            {"t": "candle", "s": slug, "n": total["week"].get(slug, 0), "weekTotal": total["weekTotal"],
             "today": total["today"], "by": p.id, "p": prayer}
        )  # fmt: skip
    return None


async def on_chans(rt: Realtime, p: Player, m: dict[str, Any]) -> None:
    rt.send(p, {"t": "chans", "list": rt.chan_list()})


#: 자리 비움(4002)을 미루는 메시지 (mv는 위치가 실제로 바뀐 때만, chans는 세지 않음)
ACTIVE_KINDS = frozenset({"say", "emo", "chat", "sit", "aipray", "post", "report", "reportUser", "light"})

HANDLERS: dict[str, Callable[[Realtime, Player, dict[str, Any]], Awaitable[None]]] = {
    "mv": on_move, "say": on_say, "emo": on_emote, "chat": on_chat, "sit": on_sit, "aipray": on_ai_pray, "post": on_post,
    "report": on_report, "reportUser": on_report_user, "light": on_light, "chans": on_chans,
}  # fmt: skip

__all__ = ["ACTIVE_KINDS", "HANDLERS", "on_message", "stand_up", "take_token"]
_ = OPEN
