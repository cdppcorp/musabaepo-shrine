"""NPC 방문자 (server/npc.ts를 그대로 옮김). 채널 1에는 늘 3명, 채널 2에는 늘 2명, 채널 3에는 없습니다.

화면에는 다른 방문객과 똑같이 보입니다 (스냅샷의 npc: True는 인원 계산용). NPC는 데이터를 남기지 않습니다 —
초 · AI 기도 · 게시판 · 직접 쓴 말 없이 걷기 · 앉기 · 고른 말풍선 · 행동만 합니다. 사당 구경은 자기 채널 사당만 갑니다.
서버가 직접 움직이며(길 찾기는 목적지가 바뀔 때만) 사람과 같은 모양의 메시지(join · st · sit · say · emo · leave)를 보냅니다.
NPC도 채널 인원(20명)에 세고, 사람이 들어오면 자리를 비켜 줍니다 (host.room).

npc.ts와 같은 것: 격자(8px, 112×84) · 칸 막힘 = blocked(cx+4, cy+4) · 8방향 BFS(대각선은 양옆이 비어야) · 3px 간격 직선 확인으로
길 줄이기 · 목적지 확률(자리 35 / 사당 15 / AI 12 / 신전 7 / 게시판 8 / 등록소 6 / 흡연 8 / 배포운 6 / 아무 데 3%) · 머무는 시간 ·
속도(SPEED × 0.5) · 말풍선 간격(채널 20초, NPC마다 90~210초) · 위치 0.1px 반올림(Math.round).
다른 점: ``blocked``는 world.blocked와 같은 판정을 칸 색인으로 빨리 합니다 (시험이 무작위 점으로 같은지 확인).
JS Math.random 대신 random.random, 아이디는 secrets (값의 분포만 같음).

host (realtime이 넘겨줌): send(channel, msg) · seat_taken(channel, seat) · room(channel) · shrines_in(channel) — 마지막은
Node의 shrinesIn(shrines.ts 캐시) 자리입니다. 여기서는 DB가 비동기라 실시간이 5초마다 채워 두는 사본을 동기로 돌려줍니다.

시험용 훅: ``python -m shrine.cli dev npc-goals <채널> <횟수>`` (dev_npc_goals) — lib/node-hooks.mjs와 같은 일.
"""

from __future__ import annotations

import math
import random
import secrets
import sys
from collections.abc import Mapping
from typing import Any, Protocol

from .logic.crypto import b64url, make_nick
from .logic.jsnum import js_hypot, js_round, json_stringify
from .logic.world import (
    AI_SHRINES, BUBBLE_COUNT, FORTUNE, LOOK_SIZES, MAP_H, MAP_W, PLOTS, REGISTRY_FRONT, SEATS, SIGH_COUNT, SMOKE_FRONT, SOLIDS,
    SPAWN, SPEED, TEMPLE_FRONT, TREND_FRONT, shrine_channel_of,
)  # fmt: skip
from .logic.world import blocked as world_blocked

__all__ = ["NPC_CHANNELS", "Npc", "NpcChannel", "NpcHost", "NpcWorld", "blocked", "dev_npc_goals", "find_path", "npc_snapshot"]

Point = dict[str, Any]

#: NPC가 사는 채널
NPC_CHANNELS = (1, 2)
#: 채널별 NPC 수 [최소, 최대]. 채널 1은 늘 3명, 채널 2는 늘 2명
NPC_RANGE: dict[int, tuple[int, int]] = {1: (3, 3), 2: (2, 2)}
#: 천천히 거닐 듯 (플레이어보다 한참 느리게)
NPC_SPEED = SPEED * 0.5
#: 한 채널에서 NPC 말풍선 사이 최소 간격
NPC_SAY_GAP = 20_000


def range_of(channel: int) -> tuple[int, int]:
    return NPC_RANGE.get(channel, (3, 10))


def rand(a: float, b: float) -> float:
    return a + random.random() * (b - a)


def rand_int(a: int, b: int) -> int:
    return math.floor(rand(a, b + 1))


def pick(items: list[Any] | tuple[Any, ...]) -> Any:
    """``list[Math.floor(Math.random() * list.length)]`` (빈 목록이면 undefined → None)."""
    if not items:
        random.random()
        return None
    return items[math.floor(random.random() * len(items))]


# ── 막힌 곳 (world.blocked와 같은 판정, 칸 색인으로) ──────────────────

_BUCKET = 32


def _build_index() -> dict[tuple[int, int], list[Mapping[str, Any]]]:
    index: dict[tuple[int, int], list[Mapping[str, Any]]] = {}
    for s in SOLIDS:
        for bx in range(math.floor(s["x"] / _BUCKET), math.floor((s["x"] + s["w"]) / _BUCKET) + 1):
            for by in range(math.floor(s["y"] / _BUCKET), math.floor((s["y"] + s["h"]) / _BUCKET) + 1):
                index.setdefault((bx, by), []).append(s)
    return index


_SOLID_INDEX = _build_index()


def blocked(x: float, y: float) -> bool:
    """world.ts blocked: 발밑 상자(8×4)가 벽 · 사당 · 소품에 걸리거나 맵 밖이면 True.

    겹치는 상자는 반드시 같은 색인 칸에 들어 있으므로 결과는 world.blocked와 같습니다 (NaN은 원래 함수로).
    """
    if x != x or y != y:
        return world_blocked(x, y)
    if x < 4 or y < 4 or x > MAP_W - 4 or y > MAP_H - 2:
        return True
    fx = x - 4
    fy = y - 3
    fx2 = fx + 8
    fy2 = fy + 4
    seen: list[Mapping[str, Any]] = []
    for bx in range(math.floor(fx / _BUCKET), math.floor(fx2 / _BUCKET) + 1):
        for by in range(math.floor(fy / _BUCKET), math.floor(fy2 / _BUCKET) + 1):
            for s in _SOLID_INDEX.get((bx, by), ()):
                if s in seen:
                    continue
                seen.append(s)
                if fx < s["x"] + s["w"] and fx2 > s["x"] and fy < s["y"] + s["h"] and fy2 > s["y"]:
                    return True
    return False


#: 입구 문 바로 안쪽: 여기로 들어오고 여기로 나갑니다
GATE: Point = {**SPAWN} if blocked(448, 604) else {"x": 448, "y": 604}

# ── 길 찾기: 8px 칸, 8방향, 막힌 칸은 맵 그대로 (처음 한 번만 만듭니다) ──

CELL = 8
GW = math.ceil(MAP_W / CELL)
GH = math.ceil(MAP_H / CELL)
_grid: bytearray | None = None
#: 입구에서 걸어갈 수 있는 칸 목록 (아무 데나 거닐 곳 고르기용)
_reachable: list[int] = []

DIRS: tuple[tuple[int, int], ...] = ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1))


def cell_of(p: Mapping[str, Any]) -> int:
    return min(GH - 1, max(0, math.floor(p["y"] / CELL))) * GW + min(GW - 1, max(0, math.floor(p["x"] / CELL)))


def center_of(c: int) -> Point:
    return {"x": (c % GW) * CELL + 4, "y": (c // GW) * CELL + 4}


def ensure_grid() -> bytearray:
    global _grid, _reachable
    if _grid is not None:
        return _grid
    g = bytearray(GW * GH)
    for y in range(GH):
        for x in range(GW):
            g[y * GW + x] = 1 if blocked(x * CELL + 4, y * CELL + 4) else 0
    _grid = g
    seen = _flood(g, cell_of(GATE))
    _reachable = [i for i in range(len(seen)) if seen[i] and not g[i]]
    return g


def reachable() -> list[int]:
    ensure_grid()
    return _reachable


def _flood(g: bytearray, start: int) -> bytearray:
    seen = bytearray(GW * GH)
    q = [start]
    seen[start] = 1
    i = 0
    while i < len(q):
        c = q[i]
        i += 1
        cx = c % GW
        cy = (c - cx) // GW
        for dx, dy in DIRS[:4]:
            nx = cx + dx
            ny = cy + dy
            if nx < 0 or ny < 0 or nx >= GW or ny >= GH:
                continue
            n = ny * GW + nx
            if seen[n] or g[n]:
                continue
            seen[n] = 1
            q.append(n)
    return seen


def open_cell(c: int) -> int:
    """막힌 칸이면 가까운 빈 칸으로."""
    g = ensure_grid()
    if not g[c]:
        return c
    cx = c % GW
    cy = (c - cx) // GW
    for r in range(1, 4):
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                nx = cx + dx
                ny = cy + dy
                if nx < 0 or ny < 0 or nx >= GW or ny >= GH:
                    continue
                n = ny * GW + nx
                if not g[n]:
                    return n
    return c


def clear_line(a: Mapping[str, Any], b: Mapping[str, Any]) -> bool:
    """두 점 사이를 막힘 없이 곧게 걸을 수 있는지 (3px 간격으로 확인)."""
    ax = a["x"]
    ay = a["y"]
    ddx = b["x"] - ax
    ddy = b["y"] - ay
    n = max(1, math.ceil(js_hypot(ddx, ddy) / 3))
    for i in range(1, n + 1):
        s = i / n
        if blocked(ax + ddx * s, ay + ddy * s):
            return False
    return True


def find_path(frm: Mapping[str, Any], to: Mapping[str, Any]) -> list[Point] | None:
    """출발점에서 목적지까지 길 (곧게 걸을 수 있는 구간은 줄여서). 못 가면 None."""
    g = ensure_grid()
    start = open_cell(cell_of(frm))
    goal = open_cell(cell_of(to))
    prev = [-1] * (GW * GH)
    prev[start] = start
    q = [start]
    i = 0
    while i < len(q) and prev[goal] == -1:
        c = q[i]
        i += 1
        cx = c % GW
        cy = (c - cx) // GW
        for dx, dy in DIRS:
            nx = cx + dx
            ny = cy + dy
            if nx < 0 or ny < 0 or nx >= GW or ny >= GH:
                continue
            n = ny * GW + nx
            if prev[n] != -1 or g[n]:
                continue
            # 대각선은 양옆이 모두 비어 있을 때만 (모서리 끼임 방지)
            if dx and dy and (g[cy * GW + nx] or g[ny * GW + cx]):
                continue
            prev[n] = c
            q.append(n)
    if prev[goal] == -1:
        return None
    cells: list[int] = []
    c = goal
    while c != start:
        cells.append(c)
        c = prev[c]
    cells.reverse()
    raw = [center_of(c) for c in cells]
    if not blocked(to["x"], to["y"]):
        raw.append({"x": to["x"], "y": to["y"]})
    # 줄이기: 지금 자리에서 곧게 보이는 가장 먼 점으로 건너뜁니다
    out: list[Point] = []
    cur: Mapping[str, Any] = frm
    i = 0
    while i < len(raw):
        j = len(raw) - 1
        while j > i and not clear_line(cur, raw[j]):
            j -= 1
        p = raw[j]
        out.append(p)
        cur = p
        i = j + 1
    return out


# ── NPC 세계 ─────────────────────────────────────────────────────────


def random_look() -> list[int]:
    return [math.floor(random.random() * n) for n in LOOK_SIZES]


def dir_of(dx: float, dy: float) -> int:
    if abs(dx) > abs(dy):
        return 2 if dx < 0 else 3
    return 1 if dy < 0 else 0


def jitter(p: Mapping[str, Any], r: float) -> Point:
    for _ in range(6):
        q = {"x": js_round(p["x"] + rand(-r, r)), "y": js_round(p["y"] + rand(-r / 2, r / 2))}
        if not blocked(q["x"], q["y"]):
            return q
    return {**p}


def _seat(i: Any) -> dict[str, Any] | None:
    """``SEATS[i]`` (JS는 범위 밖 · 음수면 undefined)."""
    return SEATS[i] if isinstance(i, int) and 0 <= i < len(SEATS) else None


class Npc:
    __slots__ = ("d", "dirty", "goal", "id", "leaving", "look", "moving", "next_chatter", "nick", "path", "seat", "state",
                 "until", "x", "y")  # fmt: skip

    def __init__(self, nid: str, nick: str, look: list[int], x: float, y: float, d: int, until: float, next_chatter: float):
        self.id = nid
        self.nick = nick
        self.look = look
        self.x = x
        self.y = y
        self.d = d
        self.moving = False
        self.seat = -1
        self.dirty = False
        #: 'walk' · 'idle' · 'sit'
        self.state = "idle"
        self.goal: dict[str, Any] | None = None
        self.path: list[Point] = []
        self.until = until
        self.next_chatter = next_chatter
        self.leaving = False


def npc_snapshot(n: Npc) -> dict[str, Any]:
    return {"id": n.id, "nick": n.nick, "look": n.look, "x": n.x, "y": n.y, "d": n.d, "m": n.moving, "s": n.seat, "npc": True}


class NpcHost(Protocol):
    def send(self, channel: int, msg: dict[str, Any]) -> None: ...
    def seat_taken(self, channel: int, seat: int) -> bool: ...
    def room(self, channel: int) -> int: ...
    def shrines_in(self, channel: Any) -> list[Mapping[str, Any]]: ...


class NpcChannel:
    __slots__ = ("id", "last_say", "next_drift", "next_spawn", "npcs", "target")

    def __init__(self, cid: int, target: int, next_drift: float) -> None:
        self.id = cid
        self.target = target
        self.next_drift = next_drift
        self.next_spawn: float = 0
        #: 이 채널에서 NPC가 마지막으로 말풍선을 띄운 때 (채널 전체가 시끄럽지 않게)
        self.last_say: float = 0
        self.npcs: dict[str, Npc] = {}


class NpcWorld:
    def __init__(self, host: NpcHost, now: float | None = None) -> None:
        from .logic.util import now_ms

        self.host = host
        ensure_grid()
        t = now_ms() if now is None else now
        self.chans: dict[int, NpcChannel] = {}
        for cid in NPC_CHANNELS:
            ch = NpcChannel(cid, rand_int(*range_of(cid)), t + rand(120_000, 300_000))
            self.chans[cid] = ch
            # 처음부터 맵 곳곳에 흩어져 있게 (서버가 막 떴을 때도 채널이 비어 보이지 않게)
            for _ in range(ch.target):
                self._spawn(ch, t, False)

    def list(self, channel: int) -> list[Npc]:
        ch = self.chans.get(channel)
        return list(ch.npcs.values()) if ch else []

    def count(self, channel: int) -> int:
        ch = self.chans.get(channel)
        return len(ch.npcs) if ch else 0

    def seat_taken(self, channel: int, seat: int) -> bool:
        ch = self.chans.get(channel)
        return any(n.seat == seat for n in ch.npcs.values()) if ch else False

    def take_dirty(self, channel: int) -> list[Npc]:
        """위치가 바뀐 NPC (이번 묶음 전송에 실을 것). 꺼내면서 표시를 지웁니다."""
        ch = self.chans.get(channel)
        if ch is None:
            return []
        out = []
        for n in ch.npcs.values():
            if not n.dirty:
                continue
            n.dirty = False
            out.append(n)
        return out

    def tick(self, now: float, dt: float) -> None:
        """100ms마다."""
        for ch in self.chans.values():
            if now >= ch.next_drift:
                lo, hi = range_of(ch.id)
                ch.target = max(lo, min(hi, ch.target + rand_int(-3, 3)))
                ch.next_drift = now + rand(120_000, 300_000)
            staying = [n for n in ch.npcs.values() if not n.leaving]
            # NPC도 채널 인원(정원 20)에 셉니다: 실제 사람이 늘면 그만큼 NPC가 줄어 자리를 비켜 줍니다
            room = max(0, self.host.room(ch.id))
            want = min(ch.target, room)
            # 정원을 넘으면(사람이 막 들어옴) 기다리지 않고 바로 한 명씩 내보냅니다
            over = len(ch.npcs) > room
            if len(staying) < want and now >= ch.next_spawn:
                self._spawn(ch, now, True)
                ch.next_spawn = now + rand(3000, 8000)
            elif len(staying) > want and (over or now >= ch.next_spawn):
                # 앉아 있지 않은 NPC부터 집에 보냅니다
                n = next((s for s in staying if s.seat < 0), staying[0] if staying else None)
                if n is not None:
                    self._send_home(ch, n, now)
                ch.next_spawn = now + (0 if over else rand(4000, 9000))
            for n in list(ch.npcs.values()):
                self._step(ch, n, now, dt)

    def _spawn(self, ch: NpcChannel, now: float, from_gate: bool) -> None:
        ensure_grid()
        at: Point = {**GATE}
        if not from_gate:
            c = pick(_reachable)
            if c is not None:
                at = jitter(center_of(c), 2)
        nid = f"npc_{b64url(secrets.token_bytes(5))}"
        nick = make_nick()
        look = random_look()
        d = 1 if from_gate else rand_int(0, 3)
        until = now + (rand(1000, 3000) if from_gate else rand(2000, 15_000))
        n = Npc(nid, nick, look, at["x"], at["y"], d, until, now + rand(30_000, 120_000))
        ch.npcs[n.id] = n
        if from_gate:
            self.host.send(ch.id, {"t": "join", "p": npc_snapshot(n)})

    def _send_home(self, ch: NpcChannel, n: Npc, now: float) -> None:
        n.leaving = True
        if n.seat >= 0:
            self._stand(ch, n)
        self._walk_to(n, {"kind": "gate", "at": GATE}, now)

    def _walk_to(self, n: Npc, goal: dict[str, Any], now: float) -> bool:
        path = find_path({"x": n.x, "y": n.y}, goal["at"])
        if path is None:
            n.state = "idle"
            n.until = now + rand(1500, 4000)
            return False
        n.goal = goal
        n.path = path
        n.state = "walk"
        return True

    def choose_goal(self, ch: NpcChannel) -> dict[str, Any]:
        """다음 목적지 고르기."""
        # 이 채널에 서 있는 사당만 (다른 채널 사당 자리는 이 채널에서 빈 자리입니다)
        live = [
            PLOTS[s["plot"]]["front"]
            for s in self.host.shrines_in(shrine_channel_of(ch.id))
            if s["status"] == "live" and isinstance(s["plot"], int) and 0 <= s["plot"] < len(PLOTS)
        ]
        free_seats = [s for s in SEATS if not self.seat_taken(ch.id, s["id"]) and not self.host.seat_taken(ch.id, s["id"])]
        fortune = {"x": FORTUNE["x"] + FORTUNE["w"] + 9, "y": FORTUNE["y"] + FORTUNE["h"] - 2}
        roll = random.random()
        if roll < 0.35 and free_seats:
            s = pick(free_seats)
            if s is not None:
                return {"kind": "seat", "at": s["stand"], "seat": s["id"]}
        if roll < 0.5 and live:
            return {"kind": "shrine", "at": jitter(pick(live), 6)}
        if roll < 0.62:
            ai = pick(AI_SHRINES) or AI_SHRINES[0]
            return {"kind": "ai", "at": jitter(ai["front"], 4)}
        if roll < 0.69:
            return {"kind": "temple", "at": jitter(TEMPLE_FRONT, 6)}
        if roll < 0.77:
            return {"kind": "trend", "at": jitter(TREND_FRONT, 10)}
        if roll < 0.83:
            return {"kind": "registry", "at": jitter(REGISTRY_FRONT, 8)}
        if roll < 0.91:
            return {"kind": "smoke", "at": jitter(SMOKE_FRONT, 8)}
        if roll < 0.97:
            return {"kind": "fortune", "at": fortune}
        c = pick(_reachable)
        return {"kind": "wander", "at": jitter(center_of(c), 2) if c is not None else {**GATE}}

    def _arrive(self, ch: NpcChannel, n: Npc, now: float) -> None:
        g = n.goal
        n.goal = None
        n.moving = False
        n.dirty = True
        if n.leaving:
            ch.npcs.pop(n.id, None)
            self.host.send(ch.id, {"t": "leave", "id": n.id})
            return
        n.state = "idle"
        n.until = now + rand(12_000, 30_000)
        kind = g["kind"] if g else None
        if kind == "seat":
            seat = _seat(g.get("seat")) if g else None
            if seat is not None and not self.seat_taken(ch.id, seat["id"]) and not self.host.seat_taken(ch.id, seat["id"]):
                n.seat = seat["id"]
                n.x = seat["x"]
                n.y = seat["y"]
                n.d = seat["d"]
                n.state = "sit"
                n.until = now + rand(45_000, 120_000)
                n.dirty = False
                self.host.send(ch.id, {"t": "sit", "id": n.id, "s": seat["id"], "x": n.x, "y": n.y, "d": n.d})
        elif kind in ("shrine", "ai", "temple"):
            n.d = 1
            if random.random() < 0.4:
                self._emote(ch, n, "bow", now)
            n.until = now + rand(12_000, 28_000)
        elif kind in ("trend", "registry"):
            n.d = 1
            n.until = now + rand(15_000, 32_000)
        elif kind == "smoke":
            d = pick([0, 2, 3])
            n.d = 0 if d is None else d
            # 한숨 말풍선은 가끔만 (채널 말풍선 간격도 지킴). i가 없으면 담배만 피우고 말은 안 함
            if random.random() < 0.35 and now - ch.last_say >= NPC_SAY_GAP:
                ch.last_say = now
                self.host.send(ch.id, {"t": "emo", "id": n.id, "k": "smoke", "i": rand_int(0, SIGH_COUNT - 1)})
            else:
                self.host.send(ch.id, {"t": "emo", "id": n.id, "k": "smoke"})
            n.next_chatter = max(n.next_chatter, now + 7000)
            n.until = now + rand(15_000, 27_000)
        elif kind == "fortune":
            n.d = 2
            if random.random() < 0.35:
                self._emote(ch, n, "wave", now)
            n.until = now + rand(8000, 16_000)

    def _stand(self, ch: NpcChannel, n: Npc) -> None:
        seat = _seat(n.seat)
        n.seat = -1
        if seat is None:
            return
        n.x = seat["stand"]["x"]
        n.y = seat["stand"]["y"]
        self.host.send(ch.id, {"t": "sit", "id": n.id, "s": -1, "x": n.x, "y": n.y, "d": n.d})

    def _emote(self, ch: NpcChannel, n: Npc, k: str, now: float) -> None:
        self.host.send(ch.id, {"t": "emo", "id": n.id, "k": k})
        n.next_chatter = max(n.next_chatter, now + 4000)

    def _chatter(self, ch: NpcChannel, n: Npc, now: float) -> None:
        """가끔(한 사람당 1.5~3.5분에 한 번) 고른 말풍선을 띄우거나 손을 흔듭니다. 말풍선은 채널 전체에서 20초에 한 번까지만."""
        n.next_chatter = now + rand(90_000, 210_000)
        if random.random() < 0.35:
            if now - ch.last_say < NPC_SAY_GAP:
                return
            ch.last_say = now
            self.host.send(ch.id, {"t": "say", "id": n.id, "k": rand_int(0, BUBBLE_COUNT - 1)})
        else:
            k = pick(["wave", "kiss"]) if n.seat >= 0 else pick(["wave", "jump", "kiss"])
            if k:
                self.host.send(ch.id, {"t": "emo", "id": n.id, "k": k})

    def _step(self, ch: NpcChannel, n: Npc, now: float, dt: float) -> None:
        if now >= n.next_chatter and n.state != "walk":
            self._chatter(ch, n, now)
        if n.state == "sit":
            if now >= n.until:
                self._stand(ch, n)
                n.state = "idle"
                n.until = now + rand(6000, 15_000)
            return
        if n.state == "idle":
            if now < n.until:
                return
            if n.leaving:
                self._walk_to(n, {"kind": "gate", "at": GATE}, now)
                return
            self._walk_to(n, self.choose_goal(ch), now)
            return
        # 걷기
        left = NPC_SPEED * dt
        while left > 0 and n.path:
            t = n.path[0]
            dx = t["x"] - n.x
            dy = t["y"] - n.y
            ln = js_hypot(dx, dy)
            if ln <= left:
                n.x = t["x"]
                n.y = t["y"]
                left -= ln
                n.path.pop(0)
                if ln > 0.01:
                    n.d = dir_of(dx, dy)
            else:
                n.x += (dx / ln) * left
                n.y += (dy / ln) * left
                n.d = dir_of(dx, dy)
                left = 0
        n.x = js_round(n.x * 10) / 10
        n.y = js_round(n.y * 10) / 10
        n.moving = len(n.path) > 0
        n.dirty = True
        if not n.path:
            self._arrive(ch, n, now)

    def stats(self) -> list[dict[str, Any]]:
        return [{"id": c.id, "npc": len(c.npcs), "target": c.target} for c in self.chans.values()]


# ── 시험용 훅: dev npc-goals <채널> <횟수> ───────────────────────────


class _GoalsHost:
    """lib/node-hooks.mjs의 host: 자리는 모두 찬 것으로, 방은 20, 메시지는 버림. 사당은 DB에서 읽은 목록."""

    def __init__(self, shrines: list[Mapping[str, Any]]) -> None:
        self._shrines = shrines

    def send(self, channel: int, msg: dict[str, Any]) -> None:
        pass

    def seat_taken(self, channel: int, seat: int) -> bool:
        return True

    def room(self, channel: int) -> int:
        return 20

    def shrines_in(self, channel: Any) -> list[Mapping[str, Any]]:
        return [s for s in self._shrines if s["channel"] == channel]


async def dev_npc_goals(args: list[str]) -> int:
    """NPC 목적지를 n번 뽑아 [{kind, at}] JSON 한 줄 (NPC가 없는 채널은 빈 채널 상태로). 성공 0."""
    from .config import config_or_exit
    from .db.engine import Database, MigrationError
    from .realtime.jsvalue import to_number
    from .shrines import all_shrines

    config = config_or_exit()
    channel = to_number(args[0] if args else None)
    n = to_number(args[1] if len(args) > 1 else None)
    db = Database(config.database_url, pool_size=1, max_overflow=0)
    try:
        await db.migrate()
        shrines = list(await all_shrines(db))
    except MigrationError as e:
        print(f"[shrine] {e}", file=sys.stderr)
        return 1
    finally:
        await db.dispose()
    world = NpcWorld(_GoalsHost(shrines))
    ch = world.chans.get(channel) if isinstance(channel, int) or (isinstance(channel, float) and channel.is_integer()) else None
    if ch is None:
        ch = NpcChannel(channel, 0, 0)  # type: ignore[arg-type]
    goals = []
    i = 0
    while i < n:
        g = world.choose_goal(ch)
        goals.append({"kind": g["kind"], "at": g["at"]})
        i += 1
    print(json_stringify(goals), flush=True)
    return 0
