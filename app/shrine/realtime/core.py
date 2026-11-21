"""실시간 상태 · 연결 받기 · 보내기 · 주기 작업 (server/realtime.ts). 메시지 하나하나의 처리는 handlers.py.

같은 채널(최대 20명) 사람들이 서로 걷는 모습을 봅니다. 위치는 화면이 보내고 서버가 검사합니다(속도 · 벽).
채널은 1~3번이 늘 있고, 1번에는 NPC 3명, 2번에는 2명이 거닙니다 (npc.py). NPC도 채널 인원에 셉니다.
메시지 하나를 처리하다 예외가 나도(DB 쓰기 실패 등) 그 메시지만 버리고 로그를 남깁니다. 같은 연결이 1분에 5번이면 1011.

닫는 코드 (화면 main.js가 보고 다르게 처리):
  1003 바이너리 · 1008 너무 빠름 · 1009 512바이트 넘음(uvicorn ws_max_size) · 1011 서버 오류 반복 · 1012 서버 재시작
  4001 다른 창에서 같은 표로 입장 · 4002 오래 자리 비움(정원 90% 이상일 때) · 4003 채널 꽉 참 · 4004 강퇴 · 4005 차단됨

Node와 같게 둔 것: 업그레이드 검사 순서와 거절 상태(503 · 403 · 401 · 429 · 4005 · 503 · 429 · 503), 메시지 칸 · 키 순서,
쿨다운 · 제한 수치, 100ms 묶음 전송, 5초 정리, 오류 로그 1분 20줄.
다른 점 (ASGI라서):
  · 거절은 ASGI WebSocket Denial Response(``websocket.http.response.*``)로 업그레이드 전에 HTTP 상태를 냅니다.
    uvicorn이 Date · Content-Type: text/plain 머리글을 덧붙입니다 (Node는 Connection · Content-Length만).
  · ping/pong(25초)은 uvicorn이 합니다 (ws_ping_interval=25, ws_ping_timeout=25: 답이 없으면 닫힘).
  · 1012는 lifecycle이 끝낼 때 stop()으로 'restart' 이유와 함께 보냅니다.
  · DB가 비동기라 메시지는 연결마다 차례로 처리합니다 (Node는 프로세스 전체가 차례). 검사와 기록 사이에 다른 연결이
    끼어들 수 있는 제한(IP당 초 · 게시판 글)은 기다리기 전에 미리 세고 실패하면 되돌립니다.
"""

from __future__ import annotations

import asyncio
import logging
import math
import random
import secrets
import traceback
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any
from urllib.parse import unquote_to_bytes

from .. import moderation
from ..logic.crypto import TICKET_COOKIE, b64url, parse_cookies, verify_ticket
from ..logic.jsnum import is_integer, js_round, json_stringify
from ..logic.util import now_ms
from ..logic.world import CHANNELS, SEATS, SPAWN, SPEED, blocked
from ..npc import NpcWorld, npc_snapshot
from ..web.api import origin_host
from ..web.net import client_ip, ip_hash, node_header
from .conn import OPEN, Conn
from .jsvalue import to_number

if TYPE_CHECKING:
    from ..context import AppContext

log = logging.getLogger("shrine.realtime")

#: 채널당 실제 접속자 수 (NPC는 세지 않음)
CHANNEL_MAX = 20
FIXED_CHANNELS = CHANNELS
CAPACITY = CHANNEL_MAX * FIXED_CHANNELS
MAX_CONNECTIONS = 900
#: IP당 새 연결 시도: 1분에 30번 (동시 연결 수는 WS_MAX_PER_IP)
CONNECTS_PER_MIN = 30
MSG_PER_SEC = 15
MSG_BURST = 30
#: 채널이 거의 찼을 때(90%) 이만큼 아무 입력이 없는 사람은 자리를 비워 줍니다
IDLE_MS = 10 * 60_000
#: 한 사람이 1분에 이만큼 서버 오류를 내면 그 연결만 끊습니다
ERRORS_PER_MIN = 5
TICK_S = 0.1
CLEANUP_S = 5.0


class WindowLimiter:
    """고정 창 제한 (security.ts WindowLimiter): key마다 window_ms 동안 limit번까지. 메모리 (그날 IP 해시가 프로세스마다 다름)."""

    def __init__(self, limit: int, window_ms: int) -> None:
        self.limit = limit
        self.window_ms = window_ms
        self.hits: dict[str, list[int]] = {}

    def allow(self, key: str) -> bool:
        now = now_ms()
        h = self.hits.get(key)
        if h is None or now - h[0] >= self.window_ms:
            self.hits[key] = [now, 1]
            if len(self.hits) > 5000:
                self.hits = {k: v for k, v in self.hits.items() if now - v[0] < self.window_ms}
            return True
        if h[1] >= self.limit:
            return False
        h[1] += 1
        return True


class CandleGuard:
    """초 켜기 판정 (security.ts CandleGuard): 같은 사람 · 같은 사당 30분에 한 번, 사당마다 한 시간 60개. 확인과 기록을 한 번에."""

    def __init__(self, cooldown_ms: int) -> None:
        self.cooldown_ms = cooldown_ms
        self.last: dict[str, int] = {}
        self.hourly: dict[str, list[int]] = {}
        self.pruned_at = 0

    def check(self, keys: list[str], slug: str, now: int | None = None) -> tuple[str, int]:
        t = now_ms() if now is None else now
        self._prune(t)
        wait_ms = 0
        for k in keys:
            at = self.last.get(f"{k}|{slug}")
            if at is not None:
                wait_ms = max(wait_ms, min(self.cooldown_ms, at + self.cooldown_ms - t))
        if wait_ms > 0:
            return "already", wait_ms
        hour = t // 3_600_000
        h = self.hourly.get(slug)
        if h is not None and h[0] == hour and h[1] >= 60:
            return "busy", 0
        for k in keys:
            self.last[f"{k}|{slug}"] = t
        if h is not None and h[0] == hour:
            h[1] += 1
        else:
            self.hourly[slug] = [hour, 1]
        return "ok", self.cooldown_ms

    def _prune(self, now: int) -> None:
        if now - self.pruned_at < 60_000:
            return
        self.pruned_at = now
        self.last = {k: at for k, at in self.last.items() if now - at < self.cooldown_ms}
        hour = now // 3_600_000
        self.hourly = {s: h for s, h in self.hourly.items() if h[0] == hour}


class Channel:
    __slots__ = ("id", "players")

    def __init__(self, cid: int) -> None:
        self.id = cid
        self.players: dict[str, Player] = {}


class Player:
    __slots__ = (
        "alive", "ban_key", "budget", "channel", "chat_times", "conn", "d", "dirty", "error_times", "exp", "id", "ip_key",
        "last_ai_pray", "last_chat", "last_chat_at", "last_emote", "last_input_at", "last_move_at", "last_post_at",
        "last_report_at", "last_say", "look", "moving", "nick", "recent", "report_times", "seat", "sid", "since", "tokens",
        "tokens_at", "x", "y",
    )  # fmt: skip

    def __init__(self, pid: str, t: Mapping[str, Any], conn: Conn, ip_key: str, ban_key: str, x: float, y: float,
                 channel: Channel, now: int) -> None:  # fmt: skip
        self.id = pid
        self.sid: str = t["sid"]
        self.conn = conn
        #: 그날 IP 해시 (web.net.ip_hash)
        self.ip_key = ip_key
        #: 차단용 IP 키 (moderation, 메모리에만)
        self.ban_key = ban_key
        #: 입장 표가 끝나는 시각
        self.exp = t["exp"]
        self.look = t["look"]
        self.nick: str = t["nick"]
        self.x = x
        self.y = y
        self.d = 0
        self.moving = False
        self.channel = channel
        self.dirty = False
        #: 이동 허용량 (px). 시간이 지나면 차고, 움직이면 줄어듭니다
        self.budget: float = SPEED
        self.last_move_at = now
        self.tokens: float = MSG_BURST
        self.tokens_at = now
        self.last_say = 0
        self.last_emote = 0
        self.chat_times: list[int] = []
        self.last_chat = ""
        self.last_chat_at = 0
        #: 앉아 있는 자리 번호 (-1이면 서 있음)
        self.seat = -1
        self.last_post_at = 0
        self.last_ai_pray = 0
        self.alive = True
        self.since = now
        self.last_input_at = now
        #: 최근 직접 쓴 말풍선 (신고할 때만 씀, 메모리에만)
        self.recent: list[dict[str, Any]] = []
        self.last_report_at = 0
        self.report_times: list[int] = []
        self.error_times: list[int] = []

    def pt(self) -> dict[str, Any]:
        return {"x": self.x, "y": self.y}


def snapshot(p: Player) -> dict[str, Any]:
    return {"id": p.id, "nick": p.nick, "look": p.look, "x": p.x, "y": p.y, "d": p.d, "m": p.moving, "s": p.seat}


def seat_at(i: Any) -> dict[str, Any] | None:
    """``SEATS[i]`` (JS: 범위 밖 · 음수면 undefined)."""
    return SEATS[i] if isinstance(i, int) and not isinstance(i, bool) and 0 <= i < len(SEATS) else None


def _form_decode(s: str) -> str:
    """application/x-www-form-urlencoded 한 조각 (URLSearchParams): + → 빈칸, 퍼센트 풀기, UTF-8."""
    return unquote_to_bytes(s.replace("+", " ")).decode("utf-8", "replace")


def wanted_channel(scope: Mapping[str, Any]) -> int:
    """``?ch=N`` (1~3)이면 N, 아니면 0 (자동 배정). ``Number(new URL(url).searchParams.get('ch')) || 0``."""
    try:
        qs = scope.get("query_string", b"").decode("latin-1").split("#", 1)[0]
        value: str | None = None
        for part in qs.split("&"):
            if not part:
                continue
            name, _, raw = part.partition("=")
            if _form_decode(name) == "ch":
                value = _form_decode(raw)
                break
        want = to_number(value)
    except Exception:  # noqa: BLE001 — 잘못된 주소면 자동 배정
        return 0
    if not is_integer(want) or want < 1 or want > FIXED_CHANNELS:
        return 0
    return int(want)


def describe_error(err: BaseException) -> str:
    """로그용 예외 (Node err.stack 자리). SQLAlchemy 예외는 SQL 문장 · 매개변수(글 내용 등) 없이 DB 드라이버의 글만."""
    orig = getattr(err, "orig", None)
    if orig is not None:
        head = f"{type(err).__name__} ({type(orig).__module__}.{type(orig).__name__}): {orig}"
        cause = getattr(orig, "__cause__", None)
        if cause is not None:
            head += f" [{type(cause).__module__}.{type(cause).__name__}]"
    else:
        head = f"{type(err).__name__}: {err}"
    stack = "".join(traceback.format_tb(err.__traceback__)).rstrip()
    return f"{head}\n{stack}" if stack else head


class Realtime:
    def __init__(self, ctx: AppContext) -> None:
        self.ctx = ctx
        self.config = ctx.config
        self.channels: dict[int, Channel] = {cid: Channel(cid) for cid in range(1, FIXED_CHANNELS + 1)}
        self.by_sid: dict[str, Player] = {}
        self.ip_connections: dict[str, int] = {}
        self.connect_limiter = WindowLimiter(CONNECTS_PER_MIN, 60_000)
        self.candle_guard = CandleGuard(self.config.candle_cooldown_ms)
        #: '<그날 IP 해시>|<사당>' → {hour, n}
        self.ip_candles: dict[str, dict[str, int]] = {}
        #: 그날 IP 해시 → {day, n}
        self.posts_by_ip: dict[str, dict[str, Any]] = {}
        self.total = 0
        self.npcs: NpcWorld | None = None
        self.timers: list[asyncio.Task[None]] = []
        self.stopping = False
        self.started = False
        #: 직접 쓰는 채팅 (운영자 화면에서 바꿈. 다시 띄우면 FREE_CHAT 값)
        self.free_chat: bool = self.config.free_chat
        #: 받은 모든 연결 (1012로 닫을 때)
        self.conns: set[Conn] = set()
        self.last_candles: dict[str, Any] | None = None
        #: 이 채널 사당 목록 사본 (NPC 목적지 고르기는 동기라서. 5초마다 사당 캐시(30초)에서 채움)
        self.shrine_list: list[Mapping[str, Any]] = []
        self.pruned_at = now_ms()
        self.err_window = 0
        self.err_logged = 0
        self.err_skipped = 0

    # ── 오류 기록 (1분에 20줄까지. 채팅 내용 같은 메시지 본문은 남기지 않습니다) ──

    def log_error(self, where: str, err: BaseException) -> None:
        now = now_ms()
        if now - self.err_window >= 60_000:
            if self.err_skipped:
                log.error("[shrine] 실시간 오류 로그 %d건을 건너뛰었습니다 (1분에 20줄까지)", self.err_skipped)
            self.err_window = now
            self.err_logged = 0
            self.err_skipped = 0
        if self.err_logged >= 20:
            self.err_skipped += 1
            return
        self.err_logged += 1
        log.error("[shrine] 실시간 %s 실패: %s", where, describe_error(err))

    # ── 초 요약 (DB를 못 읽으면 마지막으로 읽은 값) ──

    async def candles_now(self) -> dict[str, Any] | None:
        from ..shrines import candle_summary

        try:
            self.last_candles = await candle_summary(self.ctx)
        except Exception as e:  # noqa: BLE001
            self.log_error("초 요약 읽기", e)
        return self.last_candles

    # ── 보내기 ──

    def chan_list(self) -> list[dict[str, Any]]:
        npcs = self.npcs
        return [
            {"id": ch.id, "n": len(ch.players), "npc": npcs.count(ch.id) if npcs else 0}
            for ch in sorted(self.channels.values(), key=lambda c: c.id)
        ]

    def send(self, p: Player, msg: Mapping[str, Any]) -> None:
        if p.conn.state != OPEN:
            return
        data = json_stringify(msg) or ""
        p.conn.push(data, len(data.encode("utf-8", "surrogatepass")))

    def broadcast(self, ch: Channel, msg: Mapping[str, Any], except_: Player | None = None) -> None:
        data = json_stringify(msg) or ""
        size = len(data.encode("utf-8", "surrogatepass"))
        for p in list(ch.players.values()):
            if p is except_ or p.conn.state != OPEN:
                continue
            p.conn.push(data, size)

    def broadcast_all(self, msg: Mapping[str, Any]) -> None:
        for ch in list(self.channels.values()):
            self.broadcast(ch, msg)

    def pick_channel(self, want: int = 0) -> Channel | None:
        """고른 채널에 자리가 있으면 그곳, 아니면 1번부터 빈 곳. 세 채널이 모두 차면 None."""
        wanted = self.channels.get(want)
        if wanted is not None and want <= FIXED_CHANNELS and len(wanted.players) < CHANNEL_MAX:
            return wanted
        for cid in range(1, FIXED_CHANNELS + 1):
            ch = self.channels.get(cid)
            if ch is not None and len(ch.players) < CHANNEL_MAX:
                return ch
        return None

    # ── 연결 받기 ──

    def origin_allowed(self, headers: list[tuple[bytes, bytes]]) -> bool:
        origin = node_header(headers, "origin")
        if not origin:
            return False
        if self.config.public_origin:
            return origin == self.config.public_origin
        host = origin_host(origin)
        return host is not None and host == node_header(headers, "host")

    async def admit(self, scope: Mapping[str, Any]) -> tuple[Any, ...]:
        """업그레이드 검사 (realtime.ts handleUpgrade). ('deny', 상태) · ('blocked',) · ('ok', 표, ip해시, 차단키, 채널, 초요약).

        'ok'면 연결 수(total · ip_connections)를 이미 하나 셌습니다 (release로 되돌림). 기다리는 곳(차단 확인 · 초 요약)은
        모두 앞쪽에 두고, 정원 검사부터 세기까지는 기다리지 않고 한 번에 합니다 (그 사이에 다른 연결이 끼지 않게).
        """
        ctx = self.ctx
        if self.stopping or ctx.stopping:
            return ("deny", 503)
        headers = scope["headers"]
        if not self.origin_allowed(headers):
            return ("deny", 403)
        ticket = verify_ticket(parse_cookies(node_header(headers, "cookie")).get(TICKET_COOKIE), self.config.ticket_secret)
        if not ticket:
            return ("deny", 401)
        ip = client_ip(dict(scope), self.config.trust_proxy)
        ip_key = ip_hash(ip)
        ban_key = moderation.block_key(ctx, ip)
        moderation.remember_visitor(ctx, ip_key, ban_key)
        # 같은 IP의 연결 폭주는 막되, 동시 연결 수는 넉넉히 (여러 사람이 IP 하나를 같이 쓰는 경우)
        if not self.connect_limiter.allow(ip_key):
            return ("deny", 429)
        # 막힌 사람은 연결을 받은 뒤 4005로 닫아서 화면이 이유를 알 수 있게 합니다
        if await moderation.is_blocked(ctx, ban_key, ticket["sid"]):
            return ("blocked",)
        candles = await self.candles_now()
        if self.stopping or ctx.stopping:
            return ("deny", 503)
        if self.total >= MAX_CONNECTIONS:
            return ("deny", 503)
        if self.ip_connections.get(ip_key, 0) >= self.config.ws_max_per_ip:
            return ("deny", 429)
        want = wanted_channel(scope)
        # 세 채널이 모두 차면 받지 않습니다
        if self.pick_channel(want) is None:
            return ("deny", 503)
        self.total += 1
        self.ip_connections[ip_key] = self.ip_connections.get(ip_key, 0) + 1
        return ("ok", ticket, ip_key, ban_key, want, candles)

    def release(self, ip_key: str) -> None:
        self.total -= 1
        n = self.ip_connections.get(ip_key, 1) - 1
        if n > 0:
            self.ip_connections[ip_key] = n
        else:
            self.ip_connections.pop(ip_key, None)

    @staticmethod
    def spawn_point() -> dict[str, Any]:
        for _ in range(20):
            x = SPAWN["x"] + int(js_round((random.random() - 0.5) * 60))
            y = SPAWN["y"] + int(js_round((random.random() - 0.5) * 24))
            if not blocked(x, y):
                return {"x": x, "y": y}
        return {**SPAWN}

    def on_connect(self, conn: Conn, t: Mapping[str, Any], ip_key: str, ban_key: str, want: int) -> Player | None:
        """받은 연결을 채널에 넣습니다 (그 뒤 바로 greet). 채널이 없으면 4003 + 센 것 되돌림."""
        old = self.by_sid.get(t["sid"])
        if old is not None:
            old.conn.close(4001, "replaced")
        channel = self.pick_channel(want)
        if channel is None:
            conn.close(4003, "full")
            self.release(ip_key)
            return None
        now = now_ms()
        at = self.spawn_point()
        p = Player(b64url(secrets.token_bytes(6)), t, conn, ip_key, ban_key, at["x"], at["y"], channel, now)
        channel.players[p.id] = p
        self.by_sid[p.sid] = p
        return p

    def greet(self, p: Player, candles: dict[str, Any] | None) -> None:
        """hello(본인) · join(채널의 다른 사람). on_connect와 기다리는 곳 없이 이어서 불러 hello가 맨 먼저 갑니다."""
        channel = p.channel
        others = [snapshot(o) for o in channel.players.values() if o is not p]
        npc_list = [npc_snapshot(n) for n in self.npcs.list(channel.id)] if self.npcs else []
        self.send(
            p,
            {
                "t": "hello", "id": p.id, "channel": channel.id, "max": CHANNEL_MAX, "me": snapshot(p),
                "players": [*others, *npc_list], "candles": candles, "channels": self.chan_list(),
                "chat": {"free": self.free_chat},
            },
        )  # fmt: skip
        self.broadcast(channel, {"t": "join", "p": snapshot(p)}, p)

    def on_close(self, p: Player) -> None:
        # 같은 연결에서 두 번 오지 않게
        if p.channel.players.get(p.id) is not p:
            return
        self.release(p.ip_key)
        if self.by_sid.get(p.sid) is p:
            del self.by_sid[p.sid]
        del p.channel.players[p.id]
        self.broadcast(p.channel, {"t": "leave", "id": p.id})
        if not p.channel.players and p.channel.id > FIXED_CHANNELS:
            self.channels.pop(p.channel.id, None)

    def on_handler_error(self, p: Player, kind: str, err: BaseException) -> None:
        """메시지 처리 중 예외: 로그만 남기고, 같은 사람이 계속 내면 그 연결만 끊습니다."""
        self.log_error(f"메시지 처리({kind})", err)
        now = now_ms()
        p.error_times = [t for t in p.error_times if now - t < 60_000]
        p.error_times.append(now)
        if len(p.error_times) >= ERRORS_PER_MIN and p.conn.state == OPEN:
            p.conn.close(1011, "error")

    # ── 운영자 화면 · 차단 ──

    def all_players(self) -> list[Player]:
        return [p for ch in self.channels.values() for p in ch.players.values()]

    def find_player(self, pid: Any) -> Player | None:
        if not isinstance(pid, str):
            return None
        return next((p for p in self.all_players() if p.id == pid), None)

    def enforce_blocks(self) -> None:
        """차단 목록이 바뀌면 접속 중인 사람 중 막힌 사람을 내보냅니다 (4005)."""
        for p in self.all_players():
            if p.conn.state == OPEN and moderation.is_blocked_now(self.ctx, p.ban_key, p.sid):
                p.conn.close(4005, "blocked")

    # ── 주기 작업 ──

    async def start(self) -> None:
        """위치 묶음 전송(초당 10번) · 차단 · 자리 비움 · 메모리 정리(5초마다). ping은 uvicorn이 25초마다."""
        if self.started:
            return
        self.started = True
        await self._refresh_shrines()
        self.npcs = NpcWorld(_Host(self))
        moderation.on_blocks_changed(self.ctx, self.enforce_blocks)
        self.timers.append(asyncio.create_task(self._tick_loop(), name="shrine:realtime-tick"))
        self.timers.append(asyncio.create_task(self._cleanup_loop(), name="shrine:realtime-cleanup"))

    async def _refresh_shrines(self) -> None:
        from ..shrines import all_shrines

        try:
            self.shrine_list = list(await all_shrines(self.ctx))
        except Exception as e:  # noqa: BLE001
            self.log_error("사당 목록 읽기", e)

    def tick(self, now: int, dt: float) -> None:
        """100ms마다: NPC를 움직이고, 채널마다 움직인 사람 + NPC를 st 하나로 (그 채널에 사람이 있을 때만)."""
        if self.npcs is not None:
            self.npcs.tick(now, dt)
        for ch in list(self.channels.values()):
            moved = [p for p in ch.players.values() if p.dirty]
            for p in moved:
                p.dirty = False
            moved_npc = self.npcs.take_dirty(ch.id) if self.npcs else []
            if (not moved and not moved_npc) or not ch.players:
                continue
            self.broadcast(
                ch,
                {"t": "st", "ps": [[q.id, q.x, q.y, q.d, 1 if q.moving else 0] for q in [*moved, *moved_npc]]},
            )

    async def _tick_loop(self) -> None:
        loop = asyncio.get_running_loop()
        last = now_ms()
        due = loop.time()
        while True:
            due += TICK_S
            delay = due - loop.time()
            if delay < 0:
                due = loop.time()
                delay = 0
            await asyncio.sleep(delay)
            try:
                now = now_ms()
                self.tick(now, min(0.25, (now - last) / 1000))
                last = now
            except Exception as e:  # noqa: BLE001
                self.log_error("위치 전송", e)

    async def _cleanup_loop(self) -> None:
        while True:
            await asyncio.sleep(CLEANUP_S)
            try:
                await self.cleanup()
            except Exception as e:  # noqa: BLE001
                self.log_error("정리 작업", e)

    async def cleanup(self) -> None:
        now = now_ms()
        # 운영 명령(다른 프로세스)이 바꾼 차단을 읽어 오면 on_blocks_changed → enforce_blocks
        await moderation.refresh_blocks(self.ctx)
        # 채널이 거의 찼을 때만, 오래 아무것도 안 한 사람의 자리를 비웁니다
        if self.total >= math.ceil(CAPACITY * 0.9):
            for p in self.all_players():
                if now - p.last_input_at > IDLE_MS and p.conn.state == OPEN:
                    p.conn.close(4002, "idle")
        if now - self.pruned_at >= 3600_000:
            from ..logic.util import kst_date

            self.pruned_at = now
            hour = now // 3_600_000
            self.ip_candles = {k: v for k, v in self.ip_candles.items() if v["hour"] == hour}
            day = kst_date(now)
            self.posts_by_ip = {k: v for k, v in self.posts_by_ip.items() if v["day"] == day}
        # NPC가 가 볼 사당 (사당 캐시가 30초라 DB는 그때만 읽음)
        await self._refresh_shrines()

    async def stop(self, timeout_s: float = 3.0) -> None:
        """새 연결을 받지 않고, 모든 연결에 1012(서버 재시작)를 보낸 뒤 처리가 끝날 때까지 기다립니다 (넘으면 끊음)."""
        self.stopping = True
        timers, self.timers = self.timers, []
        for t in timers:
            t.cancel()
        await asyncio.gather(*timers, return_exceptions=True)
        conns = list(self.conns)
        for c in conns:
            c.close(1012, "restart")
        pending = [c.done.wait() for c in conns if not c.done.is_set()]
        if pending:
            try:
                await asyncio.wait_for(asyncio.gather(*pending), timeout_s)
            except TimeoutError:
                for c in conns:
                    c.terminate()

    # ── 받는 쪽 (ASGI 앱 하나 = 연결 하나) ──

    async def serve(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        first = await receive()
        if first.get("type") != "websocket.connect":
            return
        try:
            verdict = await self.admit(scope)
        except Exception:  # noqa: BLE001
            log.exception("[shrine] WebSocket 연결 처리 실패")
            verdict = ("deny", 500)
        if verdict[0] == "deny":
            await self._deny(scope, send, verdict[1])
            return
        if verdict[0] == "blocked":
            await send({"type": "websocket.accept"})
            await send({"type": "websocket.close", "code": 4005, "reason": "blocked"})
            return
        _, ticket, ip_key, ban_key, want, candles = verdict
        conn = Conn(send)
        try:
            await send({"type": "websocket.accept"})
        except Exception:  # noqa: BLE001 — 받기 전에 끊김
            self.release(ip_key)
            return
        self.conns.add(conn)
        conn.start()
        p: Player | None = None
        try:
            try:
                p = self.on_connect(conn, ticket, ip_key, ban_key, want)
            except Exception as e:  # noqa: BLE001
                self.log_error("입장 처리", e)
                self.release(ip_key)
                conn.terminate()
            else:
                if p is not None:
                    try:
                        self.greet(p, candles)
                    except Exception as e:  # noqa: BLE001
                        self.log_error("입장 처리", e)
                        conn.terminate()
            await self._read(conn, p, receive)
        finally:
            if p is not None:
                try:
                    self.on_close(p)
                except Exception as e:  # noqa: BLE001
                    self.log_error("연결 정리", e)
            await conn.stop()
            self.conns.discard(conn)
            conn.done.set()

    async def _deny(self, scope: Mapping[str, Any], send: Any, status: int) -> None:
        """업그레이드 전에 HTTP 상태로 거절 (Node: 'HTTP/1.1 <코드> …' + Connection: close + Content-Length: 0)."""
        if "websocket.http.response" in (scope.get("extensions") or {}):
            await send({"type": "websocket.http.response.start", "status": status, "headers": []})
            await send({"type": "websocket.http.response.body", "body": b""})
        else:
            # 이 확장이 없는 서버: 받기 전에 닫기 → 403
            await send({"type": "websocket.close", "code": 1008})

    async def _read(self, conn: Conn, p: Player | None, receive: Any) -> None:
        from .handlers import on_message

        while True:
            if conn.kill.done():
                return
            rx = asyncio.ensure_future(receive())
            try:
                await asyncio.wait((rx, conn.kill), return_when=asyncio.FIRST_COMPLETED)
            except asyncio.CancelledError:
                rx.cancel()
                raise
            if not rx.done():
                # terminate: 닫기 프레임 없이 끝냄 → uvicorn이 TCP를 닫음
                rx.cancel()
                return
            msg = rx.result()
            kind = msg.get("type")
            if kind == "websocket.disconnect":
                return
            if kind != "websocket.receive" or p is None or conn.state != OPEN:
                continue
            try:
                await on_message(self, p, msg)
            except Exception as e:  # noqa: BLE001
                self.on_handler_error(p, "?", e)

    # ── 운영자 쪽 함수 (realtime/__init__.py가 내보냄) ──

    def players_for_admin(self) -> list[dict[str, Any]]:
        """채널별 접속자 (닉네임 · 들어온 시각 · 마지막 입력 · 같은 IP 연결 수 · 열린 신고 수). IP · sid는 내보내지 않습니다."""
        now = now_ms()
        npcs = self.npcs
        return [
            {
                "id": ch.id,
                "npc": npcs.count(ch.id) if npcs else 0,
                "players": [
                    {
                        "id": p.id, "nick": p.nick, "since": p.since, "idleSec": int(js_round((now - p.last_input_at) / 1000)),
                        "seated": p.seat >= 0, "sameIp": self.ip_connections.get(p.ip_key, 1),
                        "reports": moderation.open_reports_for(self.ctx, p.sid),
                    }
                    for p in sorted(ch.players.values(), key=lambda q: q.since)
                ],
            }
            for ch in sorted(self.channels.values(), key=lambda c: c.id)
        ]  # fmt: skip

    @staticmethod
    def target_of(p: Player) -> dict[str, Any]:
        """신고 대상 정보 (운영자 화면 · 차단에 씀. 화면에는 sid · IP 키를 내보내지 않습니다)."""
        return {"pid": p.id, "sid": p.sid, "ipKey": p.ban_key, "nick": p.nick, "channel": p.channel.id, "exp": p.exp}

    async def kick_player(self, pid: Any, reason: Any) -> dict[str, Any] | None:
        """강퇴: 지금 끊고(4004) 그 입장 표를 끝날 때까지 무효로. 없는 사람이면 None."""
        p = self.find_player(pid)
        if p is None:
            return None
        if p.conn.state == OPEN:
            p.conn.close(4004, "kicked")
        ms = max(moderation.BLOCK_MIN_MS, min(p.exp - now_ms(), 3 * 3600_000))
        block = await moderation.add_block(self.ctx, {"kind": "kick", "sid": p.sid, "ms": ms, "nick": p.nick, "reason": reason})
        moderation.close_reports_for(self.ctx, p.sid, "kicked")
        return {"nick": p.nick, "block": block}

    async def block_target(self, t: Mapping[str, Any], ms: Any, by_ip: bool, reason: Any) -> dict[str, Any]:
        """차단 (입장 표, 원하면 IP까지). 걸리는 사람은 바로 4005로 끊깁니다."""
        block = await moderation.add_block(
            self.ctx, {"kind": "block", "ipKey": t.get("ipKey") if by_ip else None, "sid": t.get("sid"), "ms": ms,
                       "nick": t.get("nick"), "reason": reason}
        )  # fmt: skip
        moderation.close_reports_for(self.ctx, t.get("sid"), "blocked")
        return block

    async def block_player(self, pid: Any, ms: Any, by_ip: bool, reason: Any) -> dict[str, Any] | None:
        p = self.find_player(pid)
        if p is None:
            return None
        return {"nick": p.nick, "block": await self.block_target(self.target_of(p), ms, by_ip, reason)}

    def set_free_chat(self, on: bool) -> None:
        """직접 쓰는 채팅 켜고 끄기 (다시 띄우면 FREE_CHAT 값). 접속 중인 화면에 알립니다."""
        self.free_chat = bool(on)
        self.broadcast_all({"t": "chatMode", "free": self.free_chat})

    def realtime_stats(self) -> dict[str, Any]:
        return {"connections": self.total, "channels": len(self.channels), "npcs": self.npcs.stats() if self.npcs else []}

    def channel_stats(self) -> dict[str, Any]:
        return {"connections": self.total, "channels": self.chan_list()}


class _Host:
    """NPC 세계가 실시간에 바라는 것 (realtime.ts startRealtime의 host)."""

    def __init__(self, rt: Realtime) -> None:
        self.rt = rt

    def send(self, channel: int, msg: dict[str, Any]) -> None:
        # NPC 메시지는 그 채널에 사람이 있을 때만
        ch = self.rt.channels.get(channel)
        if ch is not None and ch.players:
            self.rt.broadcast(ch, msg)

    def seat_taken(self, channel: int, seat: int) -> bool:
        ch = self.rt.channels.get(channel)
        return ch is not None and any(o.seat == seat for o in ch.players.values())

    def room(self, channel: int) -> int:
        ch = self.rt.channels.get(channel)
        return CHANNEL_MAX - (len(ch.players) if ch else 0)

    def shrines_in(self, channel: Any) -> list[Mapping[str, Any]]:
        return [s for s in self.rt.shrine_list if s["channel"] == channel]
