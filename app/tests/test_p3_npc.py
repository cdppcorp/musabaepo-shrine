"""P3 NPC 엔진 시험: 빠른 blocked가 world.blocked와 같은지, NPC 세계의 규칙 (Node 비교는 적합성 시험 npc 묶음이 맡음).

  · blocked: 칸 색인으로 빨리 하는 판정이 world.blocked와 같은지 (격자 · 무작위 실수 점 · 경계)
  · 세계: 채널 1에 3명 · 2에 2명 · 3에는 없음, 사람이 들어오면 비켜 줌, 메시지는 사람이 있을 때만(core._Host),
          목적지는 자기 채널 사당만 · 확률 · 위치 0.1 반올림
node_ref는 test_p3_unit이 JS Number() · ?ch= 비교에 씁니다 (node가 없으면 그 시험만 건너뜀).
"""

from __future__ import annotations

import json
import math
import os
import random
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from shrine import npc
from shrine.logic.jsnum import json_stringify
from shrine.logic.world import AI_SHRINES, MAP_H, MAP_W, PLOTS, REGISTRY_FRONT, SEATS, SMOKE_FRONT, TEMPLE_FRONT, TREND_FRONT
from shrine.logic.world import blocked as world_blocked

HERE = Path(__file__).resolve().parent
REF = HERE / "p3_ref.mjs"
NODE = shutil.which("node")


def node_ref(payload: dict) -> str:
    if NODE is None or os.environ.get("SHRINE_NO_NODE"):
        pytest.skip("node가 없어 Node 기준값과 맞춰 볼 수 없습니다")
    with tempfile.TemporaryDirectory(prefix="shrine-p3-ref-") as data:
        env = {k: v for k, v in os.environ.items() if k.upper() in ("PATH", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "HOME")}
        env.update(DATA_DIR=data, NODE_ENV="development", GITHUB_CHECK="off")
        r = subprocess.run(
            [NODE, "--disable-warning=ExperimentalWarning", str(REF)], input=json.dumps(payload).encode(),
            capture_output=True, env=env, timeout=300,
        )  # fmt: skip
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode("utf-8", "replace"))
    return r.stdout.decode("utf-8")


# ── blocked ──


def _points() -> list[list[float]]:
    rnd = random.Random(20261121)
    pts: list[list[float]] = [[x * 8 + 4, y * 8 + 4] for y in range(0, 84, 3) for x in range(0, 112, 3)]
    pts += [[rnd.uniform(-10, MAP_W + 10), rnd.uniform(-10, MAP_H + 10)] for _ in range(3000)]
    pts += [[rnd.randint(0, MAP_W), rnd.randint(0, MAP_H)] for _ in range(2000)]
    pts += [[4, 4], [3.999, 4], [MAP_W - 4, MAP_H - 2], [MAP_W - 3.999, 10], [10, MAP_H - 1.999]]
    return pts


def test_fast_blocked_same_as_world():
    for x, y in _points():
        assert npc.blocked(x, y) == world_blocked(x, y), (x, y)
    assert npc.blocked(math.nan, 5) == world_blocked(math.nan, 5)


# ── NPC 세계 ──


class Host:
    def __init__(self, shrines=None, people: dict[int, int] | None = None):
        self.sent: list[tuple[int, dict]] = []
        self.shrines = shrines or []
        self.people = people or {}
        self.seats: set[tuple[int, int]] = set()

    def send(self, channel, msg):
        self.sent.append((channel, msg))

    def seat_taken(self, channel, seat):
        return (channel, seat) in self.seats

    def room(self, channel):
        return 20 - self.people.get(channel, 0)

    def shrines_in(self, channel):
        return [s for s in self.shrines if s["channel"] == channel]


def test_world_population_and_spawn():
    w = npc.NpcWorld(Host(), now=1_000_000)
    assert [w.count(1), w.count(2), w.count(3)] == [3, 2, 0]
    assert sorted(w.chans) == [1, 2]
    for n in w.list(1) + w.list(2):
        assert n.id.startswith("npc_") and len(n.id) == 11
        assert not npc.blocked(n.x, n.y)
        assert len(n.look) == 12 and n.seat == -1
        snap = npc.npc_snapshot(n)
        assert list(snap) == ["id", "nick", "look", "x", "y", "d", "m", "s", "npc"] and snap["npc"] is True
    assert w.stats() == [{"id": 1, "npc": 3, "target": 3}, {"id": 2, "npc": 2, "target": 2}]


def test_world_makes_room_for_people():
    host = Host(people={1: 18})
    w = npc.NpcWorld(host, now=0)
    t = 0
    left = []
    for _ in range(3000):
        t += 100
        w.tick(t, 0.1)
        left += [m for _, m in host.sent if m["t"] == "leave"]
        host.sent.clear()
        if w.count(1) <= 2:
            break
    assert w.count(1) == 2 and len(left) == 1
    # 사람이 나가면 다시 3명 (입구에서 join)
    host.people[1] = 0
    joined = []
    for _ in range(200):
        t += 100
        w.tick(t, 0.1)
        joined += [m for _, m in host.sent if m["t"] == "join"]
        host.sent.clear()
    assert w.count(1) == 3 and len(joined) == 1
    assert joined[0]["p"]["x"] == npc.GATE["x"] and joined[0]["p"]["d"] == 1


def test_world_walks_rounds_and_messages():
    shrines = [{"slug": "a", "channel": 1, "plot": 0, "status": "live"}, {"slug": "b", "channel": 2, "plot": 5, "status": "live"}]
    host = Host(shrines=shrines)
    random.seed(3)
    w = npc.NpcWorld(host, now=0)
    kinds = set()
    t = 0
    for _ in range(6000):  # 10분
        t += 100
        w.tick(t, 0.1)
        for n in w.list(1) + w.list(2):
            assert round(n.x * 10) == pytest.approx(n.x * 10) and round(n.y * 10) == pytest.approx(n.y * 10)
        for _, m in host.sent:
            kinds.add(m["t"])
            if m["t"] == "say":
                assert 0 <= m["k"] < 10
        host.sent.clear()
        w.take_dirty(1)
        w.take_dirty(2)
    assert {"emo", "sit"} <= kinds
    assert kinds <= {"emo", "sit", "say", "join", "leave"}


def test_choose_goal_own_channel_and_odds():
    shrines = [
        {"slug": "a", "channel": 1, "plot": 0, "status": "live"},
        {"slug": "b", "channel": 2, "plot": 12, "status": "live"},
        {"slug": "c", "channel": 1, "plot": 7, "status": "check"},
    ]
    host = Host(shrines=shrines)
    random.seed(11)
    w = npc.NpcWorld(host, now=0)
    counts: dict[str, int] = {}
    n = 20000
    for _ in range(n):
        g = w.choose_goal(w.chans[1])
        counts[g["kind"]] = counts.get(g["kind"], 0) + 1
        if g["kind"] == "shrine":
            f = PLOTS[0]["front"]
            assert abs(g["at"]["x"] - f["x"]) <= 6 and abs(g["at"]["y"] - f["y"]) <= 3
    expect = {"seat": 0.35, "shrine": 0.15, "ai": 0.12, "temple": 0.07, "trend": 0.08, "registry": 0.06, "smoke": 0.08,
              "fortune": 0.06, "wander": 0.03}  # fmt: skip
    for k, p in expect.items():
        assert abs(counts.get(k, 0) / n - p) < 0.015, (k, counts.get(k, 0) / n)
    # 자리가 모두 차고 사당이 없는 채널(3): 사당 · 자리를 고르지 않음
    host.seats = {(3, s["id"]) for s in SEATS}
    ch3 = npc.NpcChannel(3, 0, 0)
    kinds = {w.choose_goal(ch3)["kind"] for _ in range(3000)}
    assert "shrine" not in kinds and "seat" not in kinds


def test_realtime_host_sends_only_when_people():
    from shrine.config import load_config
    from shrine.context import AppContext
    from shrine.realtime.core import Realtime, _Host

    cfg = load_config({"DATABASE_URL": "postgresql://u:p@127.0.0.1:5432/db", "TICKET_SECRET": "x" * 40}).config
    rt = Realtime(AppContext(config=cfg))
    host = _Host(rt)
    sent = []
    rt.broadcast = lambda ch, msg, except_=None: sent.append((ch.id, msg))  # type: ignore[method-assign]
    host.send(1, {"t": "say", "id": "npc_x", "k": 1})
    assert sent == []
    rt.channels[1].players["p"] = object()  # type: ignore[assignment]
    host.send(1, {"t": "say", "id": "npc_x", "k": 1})
    assert sent == [(1, {"t": "say", "id": "npc_x", "k": 1})]
    assert host.room(1) == 19 and host.room(2) == 20
