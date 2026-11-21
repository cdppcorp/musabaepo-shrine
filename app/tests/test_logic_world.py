"""shrine.logic.world를 server/world.ts와 맞춰 봅니다: WORLD_JSON 바이트(sha256), 삼각함수 비트, blocked · near · nearBox 격자.

기준값은 tests/data/golden의 Node 골든(git 기록 a2b1bf6까지의 Node 서버에서 뽑음)입니다.
"""

from __future__ import annotations

import hashlib
import math
import random
import struct

from golden import run

from shrine.logic import world as w
from shrine.logic.jsnum import json_stringify


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def test_world_json_bytes_equal_node() -> None:
    node = run("world")
    assert w.WORLD_JSON_TEXT == node["text"]
    assert sha(w.WORLD_JSON_TEXT) == sha(node["text"])
    # 고정해 둔 값: 채널 기능이 들어간 지금 판 (Node 24.14 실측). world.ts가 바뀌면 위 비교가 먼저 실패합니다
    assert sha(w.WORLD_JSON_TEXT) == w.WORLD_JSON_SHA256
    assert len(w.WORLD_JSON_TEXT.encode("utf-8")) == 11183


def test_world_json_matches_pinned_hash_without_node() -> None:
    """node가 없어도 도는 고정값 확인: 지금 world.ts(채널 3개) 기준 11,183바이트, sha256 4b4b7cef…"""
    assert sha(w.WORLD_JSON_TEXT) == w.WORLD_JSON_SHA256 == "4b4b7cef836a9425ce4b902559753f139eaa69b354502f75e9a4766aae818520"
    assert w.SEATS[16]["x"] == 198 and w.SEATS[17]["x"] == 215


def test_world_json_without_channels_matches_pinned_inventory_hash() -> None:
    """인벤토리(§10)에 적힌 채널 기능 전 sha256 5b38fae…: channels 키만 빼면 그대로 나와야 합니다."""
    before = {k: v for k, v in w.WORLD_JSON.items() if k != "channels"}
    assert sha(json_stringify(before)) == w.WORLD_JSON_SHA256_BEFORE_CHANNELS
    assert w.WORLD_JSON_SHA256_BEFORE_CHANNELS.startswith("5b38faeacc93ef47")


def test_ring_trig_is_bit_identical_to_v8() -> None:
    node = run("world")
    for i, (c, s) in enumerate(node["trig"]):
        a = (i / 6) * math.pi * 2
        assert struct.pack(">d", math.cos(a)).hex() == c
        assert struct.pack(">d", math.sin(a)).hex() == s


def test_constants_match_node() -> None:
    node = run("world")
    assert list(w.LOOK_SIZES) == node["lookSizes"]
    assert w.CHANNELS == node["channels"] and w.REACH == node["reach"] and w.REACH_SERVER == node["reachServer"]
    assert w.NEAR == node["near"] and w.BUBBLE_COUNT == node["bubbles"] and w.SIGH_COUNT == node["sighs"]
    assert list(w.EMOTES) == node["emotes"] and list(w.AI_KEYS) == node["aiKeys"]
    assert json_stringify(
        {"temple": w.TEMPLE_RECT, "trend": w.TREND_RECT, "registry": w.REGISTRY_RECT, "fortune": w.FORTUNE_RECT}
    ) == json_stringify(node["boxes"])
    # 인벤토리 §10에 적힌 실측: 자리 16 x=198 (197.5에서), 자리 17 x=215 (214.5에서)
    assert w.SEATS[16]["x"] == 198 and w.SEATS[17]["x"] == 215
    assert len(w.PLOTS) == 20 and len(w.SOLIDS) == 86 and len(w.SEATS) == 22 and len(w.PROPS) == 62


def test_blocked_near_nearbox_grid() -> None:
    rng = random.Random(7)
    points: list[list[float]] = [[x, y] for x in range(-8, w.MAP_W + 9, 3) for y in range(-8, w.MAP_H + 9, 3)]
    points += [[rng.uniform(-10, w.MAP_W + 10), rng.uniform(-10, w.MAP_H + 10)] for _ in range(20000)]
    points += [[x + 0.5, y + 0.5] for x, y in [(4, 4), (891.5, 669.5), (100, 160), (448, 548)]]
    points += [[3.9999999999999996, 100], [892.0000000000001, 100], [100, 670.0000000000001], [4, 4], [892, 670]]
    box_points: list[list[float | None]] = []
    for _ in range(6000):
        r = rng.choice([None, None, 0, 12.5, 18, 26, 40])
        box_points.append([rng.uniform(300, 760), rng.uniform(150, 520), rng.uniform(300, 760), rng.uniform(150, 520), r])
    # 경계: 정확히 r만큼 떨어진 점 (3-4-5, 상자 모서리)
    box_points += [[0, 0, 3, 4, 5], [0, 0, 15.6, 20.8, 26], [398, 14, 398, 14, None], [380, 14, 398, 14, None]]
    box_points += [[w.TEMPLE_RECT["x"] - 18, w.TEMPLE_RECT["y"], 0, 0, None], [w.TEMPLE_RECT["x"] - 18.000000000000004, 30, 0, 0, None]]
    values = [
        [0] * 12, [5, 5, 5, 5, 15, 11, 8, 11, 4, 7, 5, 9], [6] + [0] * 11, [0] * 11, [0] * 13, [1.0] + [0] * 11, [True] + [0] * 11,
        [-0.0] + [0] * 11, [0.5] + [0] * 11, ["0"] + [0] * 11, None, "x", 1, 2, 3, 4, 0, 1.0, 3.0000000000000004, -1, True,
        "gpt", "claude", "grok", "GPT", "", [None] * 12,
    ]  # fmt: skip
    node = run("worldChecks", points=points, boxPoints=box_points, values=values)
    for (x, y), want in zip(points, node["blocked"], strict=True):
        assert w.blocked(x, y) is want, (x, y)
    rects = [w.TEMPLE_RECT, w.TREND_RECT, w.REGISTRY_RECT, w.FORTUNE_RECT]
    for (ax, ay, bx, by, r), n_want, box_want, srv_want in zip(
        box_points, node["near"], node["nearBox"], node["nearBoxServer"], strict=True
    ):
        a, b = {"x": ax, "y": ay}, {"x": bx, "y": by}
        assert (w.near(a, b) if r is None else w.near(a, b, r)) is n_want
        assert [w.near_box(a, rect) if r is None else w.near_box(a, rect, r) for rect in rects] == box_want
        assert [w.near_box(a, rect, w.REACH_SERVER) for rect in rects] == srv_want
    for v, look, ch, sco, ai in zip(
        values, node["isValidLook"], node["isChannel"], node["shrineChannelOf"], node["isAiKey"], strict=True
    ):
        assert w.is_valid_look(v) is look, v
        assert w.is_channel(v) is ch, v
        if sco is not None:
            assert w.shrine_channel_of(v) == sco, v
        assert w.is_ai_key(v) is ai, v
