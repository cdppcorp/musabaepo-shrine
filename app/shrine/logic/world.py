"""맵 정의: server/world.ts를 그대로 옮겼습니다. ``WORLD_JSON``을 ``json_stringify``한 바이트가 Node와 같아야 합니다.

화면(public/js/main.js)은 ``/api/world``의 ``world``로 충돌 · 앉기 · 근처를 판정하고, 서버도 같은 값으로
위치를 고칩니다 (realtime.ts ``fix`` · ``far``). 그래서 수치 하나, 키 순서 하나까지 같아야 합니다.

TS 원본 줄 (server/world.ts, 채널 3개 판 기준):

| 이름 | world.ts |
|---|---|
| ``TILE`` · ``MAP_W`` · ``MAP_H`` · ``SPEED`` · ``NEAR`` | 13-20 |
| ``LOOK_SIZES`` · ``is_valid_look`` | 25-30 |
| ``BUBBLE_COUNT`` · ``EMOTES`` · ``SIGH_COUNT`` | 32-36 |
| ``WALL_TOP`` · ``WALL_SIDE`` · ``FENCE_Y`` · ``mirror`` | 43-46 |
| ``SPOTS`` | 49-57 |
| ``CHANNELS`` · ``is_channel`` · ``shrine_channel_of`` | 63-70 |
| ``PLOTS`` (0~9번 몸체는 뒤 담에 붙은 폭 56) | 72-78 |
| ``FORTUNE`` · ``TEMPLE`` · ``TEMPLE_FRONT`` | 81-84 |
| ``AIS`` · ``AI_SHRINES`` · ``is_ai_key`` | 90-103 |
| ``REGISTRY_FRONT`` · ``SMOKE_ZONE`` · ``SMOKE_FRONT`` · ``TREND_FRONT`` · ``SPAWN`` | 106-118 |
| ``ring`` (``Math.round(cx + cos·rx)``) | 130-134 |
| ``PROPS`` (순서가 자리 번호를 정함) | 136-176 |
| ``solids_of`` | 179-200 |
| ``STRINGS`` | 203-213 |
| ``GROUND`` | 219-240 |
| ``SOLIDS`` | 242-250 |
| ``SEATS`` (``away`` · ``facing``, 돗자리 ``Math.round(x ± w/4)``) | 258-276 |
| ``blocked`` | 278-285 |
| ``near`` | 287 |
| ``REACH`` · ``REACH_SERVER`` · ``near_box`` | 293-299 |
| ``TEMPLE_RECT`` · ``TREND_RECT`` · ``REGISTRY_RECT`` · ``FORTUNE_RECT`` | 301-304 |
| ``WORLD_JSON`` | 308-337 |

JS와 다르게 계산될 수 있는 곳은 모두 jsnum의 함수를 씁니다: ``Math.round``(.5 올림) → ``js_round``,
``Math.hypot`` → ``js_hypot``, ``Math.max`` → ``js_max``. ``Math.cos`` · ``Math.sin``은 ``math``를 그대로 쓰는데,
ring()이 쓰는 여섯 각도에서 V8(fdlibm)과 비트까지 같다는 것을 시험이 확인합니다 (tests/test_logic_world.py).

좌표 · 상자는 JS 객체와 같은 키 순서의 dict입니다 (Point = ``{"x","y"}``, Rect = ``{"x","y","w","h"}``).
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any

from .jsnum import is_integer, js_hypot, js_max, js_round, json_stringify

Point = dict[str, Any]
Rect = dict[str, Any]

TILE = 16
MAP_W = 56 * TILE  # 896
MAP_H = 42 * TILE  # 672
SPEED = 70
NEAR = 26
LOOK_SIZES: tuple[int, ...] = (6, 6, 6, 6, 16, 12, 9, 12, 5, 8, 6, 10)


def is_valid_look(v: object) -> bool:
    """world.ts:27-30 ``isValidLook``: 길이 12 배열, 칸마다 0 ≤ n < LOOK_SIZES[i]인 정수 (1.0도 정수, bool은 아님)."""
    if not isinstance(v, list) or len(v) != len(LOOK_SIZES):
        return False
    return all(is_integer(n) and n >= 0 and n < LOOK_SIZES[i] for i, n in enumerate(v))


BUBBLE_COUNT = 10
EMOTES: tuple[str, ...] = ("bow", "wave", "jump", "spin", "kiss", "smoke")
SIGH_COUNT = 10

WALL_TOP = 24
WALL_SIDE = 8
FENCE_Y = 612


def mirror(x: int) -> int:
    return MAP_W - x


SPOTS: tuple[tuple[int, int], ...] = (
    (40, 40), (96, 32), (152, 28), (208, 32), (264, 42),
    (584, 42), (640, 32), (696, 28), (752, 32), (808, 40),
    (40, 236), (92, 208), (148, 198), (204, 208), (256, 236),
    (96, 404), (152, 420), (208, 436), (264, 452), (320, 468),
)  # fmt: skip

CHANNELS = 3


def is_channel(v: object) -> bool:
    """world.ts:64 ``isChannel``: 1~CHANNELS 정수 (number 타입만)."""
    return is_integer(v) and 1 <= v <= CHANNELS  # type: ignore[operator]


def shrine_channel_of(channel: object) -> object:
    """world.ts:70 ``shrineChannelOf``: 1~3이면 그대로, 아니면 1."""
    return channel if is_channel(channel) else 1


def _rect(x: Any, y: Any, w: Any, h: Any) -> Rect:
    return {"x": x, "y": y, "w": w, "h": h}


def _pt(x: Any, y: Any) -> Point:
    return {"x": x, "y": y}


PLOTS: list[dict[str, Any]] = [
    {
        "id": i,
        "x": x,
        "y": y,
        "body": _rect(x - 4, WALL_TOP, 56, y + 40 - WALL_TOP) if i < 10 else _rect(x + 4, y, 40, 40),
        "front": _pt(x + 24, y + 52),
        "box": _rect(x, y - 4, 48, 48),
    }
    for i, (x, y) in enumerate(SPOTS)
]

FORTUNE: Rect = _rect(334, 270, 24, 18)
TEMPLE = _pt(448, 108)
TEMPLE_FRONT: Point = _pt(TEMPLE["x"] - 20, TEMPLE["y"] + 32)

AIS: tuple[dict[str, str], ...] = (
    {"key": "gpt", "name": "ChatGPT", "color": "#19c37d"},
    {"key": "gemini", "name": "Gemini", "color": "#a07cf2"},
    {"key": "claude", "name": "Claude", "color": "#d97757"},
    {"key": "deepseek", "name": "DeepSeek", "color": "#3d7bff"},
    {"key": "grok", "name": "Grok", "color": "#c8ccd6"},
)
AI_SPOTS: tuple[tuple[int, int], ...] = ((640, 300), (692, 284), (744, 278), (796, 284), (848, 300))
AI_SHRINES: list[dict[str, Any]] = [
    {**ai, "x": x, "y": y, "front": _pt(x, y + 14), "box": _rect(x - 16, y - 44, 32, 44)}
    for ai, (x, y) in zip(AIS, AI_SPOTS, strict=True)
]
AI_KEYS: tuple[str, ...] = tuple(a["key"] for a in AIS)


def is_ai_key(v: object) -> bool:
    """world.ts:103 ``isAiKey``."""
    return isinstance(v, str) and v in AI_KEYS


REGISTRY = _pt(516, 212)
REGISTRY_FRONT: Point = _pt(REGISTRY["x"], REGISTRY["y"] + 14)
SMOKE_ZONE: dict[str, int] = {"x": 60, "y": 548, "r": 52}
SMOKE_FRONT: Point = _pt(80, 556)
TREND = _pt(700, 470)
TREND_FRONT: Point = _pt(TREND["x"], TREND["y"] + 20)
SPAWN: Point = _pt(448, 548)


def _pole(x: int, y: int) -> dict[str, Any]:
    return {"k": "pole", "x": x, "y": y}


POLE_TOP = 29


def _num(v: float) -> int | float:
    """JS 숫자를 JSON에 같은 글자로 나가게: 정수 값이면 int, -0은 0 (JSON.stringify(-0) === '0')."""
    if is_integer(v):
        return int(v)
    return v


def ring(cx: int, cy: int, rx: int, ry: int, n: int, k: str) -> list[dict[str, Any]]:
    """world.ts:130-134. 각도 (i / n) · π · 2를 JS와 같은 순서로 계산합니다."""
    out = []
    for i in range(n):
        a = (i / n) * math.pi * 2
        out.append({"k": k, "x": _num(js_round(cx + math.cos(a) * rx)), "y": _num(js_round(cy + math.sin(a) * ry))})
    return out


PLAZA: dict[str, int] = {"x": 448, "y": 300, "r": 74}
_plaza_poles = [_pole(384, 240), _pole(512, 240), _pole(384, 360), _pole(512, 360)]
_north_poles = [_pole(422, 168), _pole(474, 168)]
_gate_poles = [_pole(422, 500), _pole(474, 500)]
_west_poles = [_pole(52, 352), _pole(300, 352)]
_east_poles = [_pole(mirror(300), 352), _pole(mirror(52), 352)]

PROPS: list[dict[str, Any]] = [
    *({"k": "ai", "x": a["x"], "y": a["y"], "a": a["key"]} for a in AI_SHRINES),
    {"k": "temple", "x": TEMPLE["x"], "y": TEMPLE["y"]}, {"k": "censer", "x": TEMPLE["x"], "y": TEMPLE["y"] + 14},
    {"k": "stone", "x": TEMPLE["x"] - 60, "y": TEMPLE["y"] + 18}, {"k": "stone", "x": TEMPLE["x"] + 60, "y": TEMPLE["y"] + 18},
    {"k": "registry", "x": REGISTRY["x"], "y": REGISTRY["y"]},
    {"k": "ashtray", "x": SMOKE_ZONE["x"], "y": SMOKE_ZONE["y"] - 2}, {"k": "sign", "x": 26, "y": 534},
    {"k": "bench", "x": SMOKE_ZONE["x"], "y": 590}, _pole(100, 530),
    {"k": "trend", "x": TREND["x"], "y": TREND["y"]},
    {"k": "table", "x": 632, "y": 556}, {"k": "stool", "x": 614, "y": 556}, {"k": "stool", "x": 650, "y": 556}, {"k": "stool", "x": 632, "y": 568},
    {"k": "table", "x": 776, "y": 540}, {"k": "stool", "x": 758, "y": 540}, {"k": "stool", "x": 794, "y": 540}, {"k": "stool", "x": 776, "y": 552},
    {"k": "fire", "x": PLAZA["x"], "y": PLAZA["y"]},
    *ring(PLAZA["x"], PLAZA["y"], 32, 22, 6, "stump"),
    *_plaza_poles, *_north_poles, *_gate_poles,
    {"k": "mat", "x": 130, "y": 312, "w": 40, "h": 22, "v": 0}, {"k": "mat", "x": 206, "y": 330, "w": 34, "h": 20, "v": 1},
    *_west_poles,
    *_east_poles,
    {"k": "bench", "x": 162, "y": 172}, {"k": "bench", "x": mirror(162), "y": 172},
    {"k": "tree", "x": 100, "y": 164}, {"k": "tree", "x": 236, "y": 152, "v": 1}, {"k": "tree", "x": 350, "y": 182},
    {"k": "tree", "x": mirror(100), "y": 164, "v": 1}, {"k": "tree", "x": mirror(236), "y": 152}, {"k": "tree", "x": 572, "y": 188, "v": 1},
    {"k": "tree", "x": 176, "y": 560}, {"k": "tree", "x": mirror(40), "y": 572}, {"k": "tree", "x": mirror(176), "y": 560, "v": 1},
    {"k": "bush", "x": 300, "y": 596}, {"k": "bush", "x": 112, "y": 596}, {"k": "bush", "x": mirror(300), "y": 596}, {"k": "bush", "x": mirror(112), "y": 596},
    {"k": "bush", "x": 330, "y": 404}, {"k": "bush", "x": mirror(330), "y": 404},
    {"k": "gate", "x": 448, "y": FENCE_Y},
]  # fmt: skip

_SOLID_BOX: dict[str, tuple[int, int, int, int]] = {
    # 종류: (x 빼기, y 빼기, w, h) → { x: p.x - dx, y: p.y - dy, w, h }
    "temple": (44, 30, 88, 30),
    "censer": (6, 4, 12, 5),
    "ai": (13, 12, 26, 12),
    "trend": (36, 6, 72, 6),
    "registry": (22, 14, 44, 14),
    "ashtray": (3, 3, 6, 4),
    "sign": (2, 3, 4, 4),
    "tree": (3, 3, 6, 4),
    "bush": (6, 3, 12, 4),
    "fire": (8, 4, 16, 7),
    "stump": (4, 2, 8, 4),
    "pole": (2, 2, 4, 3),
    "stone": (5, 3, 10, 4),
    "table": (9, 4, 18, 7),
    "stool": (3, 2, 6, 3),
    "bench": (13, 4, 26, 4),
}


def solids_of(p: Mapping[str, Any]) -> list[Rect]:
    """world.ts:179-200 ``solidsOf``. 돗자리(mat)는 밟고 지나갑니다 (빈 목록)."""
    k = p["k"]
    if k == "gate":
        return [_rect(p["x"] - 45, p["y"] - 8, 10, 8), _rect(p["x"] + 35, p["y"] - 8, 10, 8)]
    box = _SOLID_BOX.get(k)
    if box is None:
        return []
    dx, dy, w, h = box
    return [_rect(p["x"] - dx, p["y"] - dy, w, h)]


def _top(p: Mapping[str, Any] | None) -> list[int]:
    return [p["x"] if p else 0, (p["y"] if p else 0) - POLE_TOP]


STRINGS: list[list[list[int]]] = [
    [_top(_plaza_poles[0]), _top(_plaza_poles[1])],
    [_top(_plaza_poles[2]), _top(_plaza_poles[3])],
    [_top(_plaza_poles[0]), _top(_plaza_poles[3])],
    [_top(_plaza_poles[1]), _top(_plaza_poles[2])],
    [_top(_north_poles[0]), _top(_north_poles[1])],
    [_top(_gate_poles[0]), _top(_gate_poles[1])],
    [_top(_west_poles[0]), _top(_west_poles[1])],
    [_top(_east_poles[0]), _top(_east_poles[1])],
]


def _flip_line(pts: list[list[int]]) -> list[list[int]]:
    return [[mirror(x), y] for x, y in pts]


def _line(t: str, r: int, pts: list[list[int]]) -> dict[str, Any]:
    return {"t": t, "k": "line", "r": r, "pts": pts}


def _ellipse(t: str, x: int, y: int, rx: int, ry: int) -> dict[str, Any]:
    return {"t": t, "k": "ellipse", "x": x, "y": y, "rx": rx, "ry": ry}


def _circle(t: str, x: int, y: int, r: int) -> dict[str, Any]:
    return {"t": t, "k": "circle", "x": x, "y": y, "r": r}


_north_lane = [[12, 102], [64, 98], [120, 90], [176, 86], [232, 90], [288, 100], [352, 112], [400, 116]]
_west_trail = [[24, 104], [22, 200], [44, 286]]
_west_slope = [[60, 350], [58, 436], [84, 458], [120, 462], [176, 478], [232, 494], [288, 510], [344, 526], [396, 556], [440, 596]]
GROUND: list[dict[str, Any]] = [
    _line("dirt", 14, [[448, MAP_H], [448, 120]]),
    _line("dirt", 13, _north_lane), _line("dirt", 13, _flip_line(_north_lane)),
    _line("dirt", 10, _west_trail), _line("dirt", 10, [[872, 104], [874, 200], [874, 318]]),
    _ellipse("dirt", 172, 300, 136, 62), _ellipse("stone", 744, 322, 118, 48),
    _line("dirt", 12, [[300, 300], [380, 300]]), _line("dirt", 12, [[mirror(300), 300], [mirror(380), 300]]),
    _line("dirt", 12, _west_slope), _line("dirt", 12, _flip_line(_west_slope)),
    _circle("stone", PLAZA["x"], PLAZA["y"], PLAZA["r"]),
    _ellipse("stone", 448, 112, 82, 38),
    _circle("stone", 448, 618, 40),
    _ellipse("stone", 62, 556, 46, 32),
    _line("dirt", 8, [[74, 462], [70, 500], [64, 530]]),
]  # fmt: skip

SOLIDS: list[Rect] = [
    _rect(0, 0, MAP_W, WALL_TOP),
    _rect(0, FENCE_Y, MAP_W, MAP_H - FENCE_Y),
    _rect(0, 0, WALL_SIDE, MAP_H),
    _rect(MAP_W - WALL_SIDE, 0, WALL_SIDE, MAP_H),
    *(p["body"] for p in PLOTS),
    FORTUNE,
    *(r for p in PROPS for r in solids_of(p)),
]


def _facing(dx: float, dy: float) -> int:
    """world.ts:258. 0 아래 · 1 위 · 2 왼쪽 · 3 오른쪽."""
    if abs(dx) > abs(dy):
        return 2 if dx < 0 else 3
    return 1 if dy < 0 else 0


def _seats_of(p: dict[str, Any]) -> list[dict[str, Any]]:
    def away(cx: float, cy: float, by: float) -> Point:
        length = js_hypot(p["x"] - cx, p["y"] - cy) or 1
        return _pt(
            _num(js_round(p["x"] + ((p["x"] - cx) / length) * by)),
            _num(js_round(p["y"] + ((p["y"] - cy) / length) * by)),
        )

    k = p["k"]
    if k == "stump":
        return [{"x": p["x"], "y": p["y"] + 1, "d": _facing(PLAZA["x"] - p["x"], PLAZA["y"] - p["y"]), "h": 5,
                 "stand": away(PLAZA["x"], PLAZA["y"], 11)}]  # fmt: skip
    if k == "bench":
        return [{"x": p["x"] + dx, "y": p["y"] + 1, "d": 0, "h": 5, "stand": _pt(p["x"] + dx, p["y"] + 8)} for dx in (-7, 7)]
    if k == "stool":
        tables = [q for q in PROPS if q["k"] == "table"]
        # JS Array.prototype.sort는 안정 정렬 (같은 거리면 먼저 나온 탁자)
        tables.sort(key=lambda q: js_hypot(q["x"] - p["x"], q["y"] - p["y"]))
        if not tables:
            return []
        t = tables[0]
        return [{"x": p["x"], "y": p["y"] + 1, "d": _facing(t["x"] - p["x"], t["y"] - p["y"]), "h": 4,
                 "stand": away(t["x"], t["y"], 9)}]  # fmt: skip
    if k == "mat":
        out = []
        for side in (-1, 1):
            # JS: Math.round(p.x + side * (p.w ?? 20) / 4) → (side * w) / 4
            at = _pt(_num(js_round(p["x"] + side * p.get("w", 20) / 4)), p["y"] + 3)
            out.append({**at, "d": 0, "h": 0, "stand": at})
        return out
    return []


SEATS: list[dict[str, Any]] = [{"id": i, **s} for i, s in enumerate(s for p in PROPS for s in _seats_of(p))]


def _overlap(a: Mapping[str, float], b: Mapping[str, float]) -> bool:
    return a["x"] < b["x"] + b["w"] and a["x"] + a["w"] > b["x"] and a["y"] < b["y"] + b["h"] and a["y"] + a["h"] > b["y"]


def blocked(x: float, y: float) -> bool:
    """world.ts:281-285: 발밑 상자(8×4)가 벽 · 사당 · 소품에 걸리거나 맵 밖이면 True.

    NaN은 JS처럼 어떤 비교도 참이 아니라서 False가 됩니다 (호출하는 쪽에서 숫자인지 먼저 봐야 합니다).
    """
    if x < 4 or y < 4 or x > MAP_W - 4 or y > MAP_H - 2:
        return True
    feet = {"x": x - 4, "y": y - 3, "w": 8, "h": 4}
    return any(_overlap(feet, s) for s in SOLIDS)


def near(a: Mapping[str, float], b: Mapping[str, float], r: float = NEAR) -> bool:
    """world.ts:287: 두 점 거리 ≤ r (``Math.hypot``)."""
    return js_hypot(a["x"] - b["x"], a["y"] - b["y"]) <= r


REACH = 18
REACH_SERVER = 26


def near_box(a: Mapping[str, float], b: Mapping[str, float], r: float = REACH) -> bool:
    """world.ts:295-299: 점 a가 상자 b에서 r 안인지 (``Math.max`` · ``Math.hypot``)."""
    dx = js_max(b["x"] - a["x"], 0, a["x"] - (b["x"] + b["w"]))
    dy = js_max(b["y"] - a["y"], 0, a["y"] - (b["y"] + b["h"]))
    return js_hypot(dx, dy) <= r


TEMPLE_RECT: Rect = _rect(TEMPLE["x"] - 50, TEMPLE["y"] - 94, 100, 112)
TREND_RECT: Rect = _rect(TREND["x"] - 40, TREND["y"] - 52, 80, 54)
REGISTRY_RECT: Rect = _rect(REGISTRY["x"] - 26, REGISTRY["y"] - 46, 52, 48)
FORTUNE_RECT: Rect = _rect(FORTUNE["x"], FORTUNE["y"] - 12, FORTUNE["w"], FORTUNE["h"] + 12)

WORLD_JSON: dict[str, Any] = {
    "tile": TILE,
    "w": MAP_W,
    "h": MAP_H,
    "wallTop": WALL_TOP,
    "wallSide": WALL_SIDE,
    "fenceY": FENCE_Y,
    "speed": SPEED,
    "near": NEAR,
    "plots": PLOTS,
    "channels": CHANNELS,
    "solids": SOLIDS,
    "fortune": FORTUNE,
    "spawn": SPAWN,
    "templeFront": TEMPLE_FRONT,
    "ais": AI_SHRINES,
    "registryFront": REGISTRY_FRONT,
    "smokeZone": SMOKE_ZONE,
    "smokeFront": SMOKE_FRONT,
    "sighs": SIGH_COUNT,
    "trendFront": TREND_FRONT,
    "reach": REACH,
    "boxes": {"temple": TEMPLE_RECT, "trend": TREND_RECT, "registry": REGISTRY_RECT, "fortune": FORTUNE_RECT},
    "seats": SEATS,
    "props": PROPS,
    "strings": STRINGS,
    "ground": GROUND,
    "lookSizes": list(LOOK_SIZES),
    "bubbles": BUBBLE_COUNT,
}

#: ``JSON.stringify(WORLD_JSON)``와 같은 글자. /api/world 응답은 이 글자를 ``"world":`` 자리에 그대로 넣으면 됩니다.
WORLD_JSON_TEXT: str = json_stringify(WORLD_JSON)  # type: ignore[assignment]
#: 채널 기능(``channels`` 키) 전 판의 sha256 — 인벤토리 §10에 적힌 값. 시험에서 channels를 뺀 판이 이 값과 같은지 봅니다.
WORLD_JSON_SHA256_BEFORE_CHANNELS = "5b38faeacc93ef4756acdb632d961153b0bdd74c4cef91ab71a73a191537f2c8"
#: 지금 world.ts(channels: 3 포함)의 sha256 (2026-11-18 Node 24.14 실측)
WORLD_JSON_SHA256 = "4b4b7cef836a9425ce4b902559753f139eaa69b354502f75e9a4766aae818520"

__all__ = [
    "AIS", "AI_KEYS", "AI_SHRINES", "BUBBLE_COUNT", "CHANNELS", "EMOTES", "FENCE_Y", "FORTUNE", "FORTUNE_RECT", "GROUND",
    "LOOK_SIZES", "MAP_H", "MAP_W", "NEAR", "PLAZA", "PLOTS", "PROPS", "REACH", "REACH_SERVER", "REGISTRY_FRONT",
    "REGISTRY_RECT", "SEATS", "SIGH_COUNT", "SMOKE_FRONT", "SMOKE_ZONE", "SOLIDS", "SPAWN", "SPEED", "STRINGS",
    "TEMPLE_FRONT", "TEMPLE_RECT", "TILE", "TREND_FRONT", "TREND_RECT", "WALL_SIDE", "WALL_TOP", "WORLD_JSON",
    "WORLD_JSON_SHA256", "WORLD_JSON_SHA256_BEFORE_CHANNELS", "WORLD_JSON_TEXT", "blocked", "is_ai_key", "is_channel",
    "is_valid_look", "near", "near_box", "ring", "shrine_channel_of", "solids_of",
]  # fmt: skip
