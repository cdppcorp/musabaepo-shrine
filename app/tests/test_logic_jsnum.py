"""shrine.logic.jsnum · jsstr를 V8(Node)과 맞춰 봅니다: 숫자 글자, Math.round/hypot/max/min, JSON.stringify/parse, UTF-8 풀기.

기준값은 tests/data/golden의 Node 골든(git 기록 a2b1bf6까지의 Node 서버에서 뽑음)입니다.
"""

from __future__ import annotations

import json
import math
import random
import struct

import pytest
from golden import run

from shrine.logic.jsnum import (
    UNDEFINED,
    JSONParseError,
    is_integer,
    js_hypot,
    js_max,
    js_min,
    js_round,
    json_parse,
    json_stringify,
    number_to_string,
)
from shrine.logic.jsstr import canonical, code_points, js_trim, slice_units, to_utf16_units, usv, utf8_decode, utf8_encode, utf16_len


def bits(x: float) -> str:
    return struct.pack(">d", x).hex()


def from_bits(h: str) -> float:
    return struct.unpack(">d", bytes.fromhex(h))[0]


SPECIAL = [
    0.0, -0.0, 1.0, -1.0, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 197.5, 214.5, -214.5, 0.49999999999999994, -0.49999999999999994,
    4503599627370495.5, 4503599627370496.0, 9007199254740991.0, 9007199254740993.0, 1e21, 1e21 - 65536, 999999999999999900000.0,
    1e-6, 1e-7, 1.5e-7, 123e-20, 5e-324, 2.2250738585072014e-308, 1.7976931348623157e308, 0.1, 0.2, 0.1 + 0.2, 1 / 3, 100.0,
    123456789012345680000.0, 1.2345678901234567e21, 0.000001234, 1e100, -1e-100, 2**53, 2**63, 2**64, 1e16, 12345678.9,
    math.inf, -math.inf, math.nan, 3e-7, 0.1e-6, 1e300 * 1e10,
]  # fmt: skip


def random_doubles(n: int, seed: int) -> list[float]:
    rng = random.Random(seed)
    out = []
    for _ in range(n):
        kind = rng.random()
        if kind < 0.5:
            out.append(struct.unpack(">d", rng.getrandbits(64).to_bytes(8, "big"))[0])
        elif kind < 0.7:
            out.append(rng.uniform(-1e6, 1e6))
        elif kind < 0.85:
            out.append(round(rng.uniform(-1e4, 1e4), rng.randint(0, 6)))
        else:
            out.append(rng.randint(-(2**60), 2**60) / 2 ** rng.randint(0, 70))
    return out


def test_number_to_string_matches_v8() -> None:
    values = SPECIAL + random_doubles(20000, 1)
    node = run("numbersFromBits", bits=[bits(v) for v in values])
    for v, (s, j, arr) in zip(values, node, strict=True):
        assert number_to_string(v) == s, (v, s)
        assert json_stringify(v) == j, (v, j)
        assert json_stringify([v]) == arr


def test_math_functions_match_v8() -> None:
    rng = random.Random(2)
    rounds = SPECIAL + random_doubles(5000, 3) + [k + 0.5 for k in range(-50, 50)] + [rng.uniform(-1000, 1000) for _ in range(2000)]
    hypots = [[rng.uniform(-900, 900) for _ in range(rng.randint(1, 3))] for _ in range(3000)]
    hypots += [[0.0, 0.0], [-0.0], [3.0, 4.0], [math.inf, math.nan], [math.nan, 1.0], [1e308, 1e308], [5e-324, 5e-324], [1.0, 1e-17]]
    maxes = [[0.0, -0.0], [-0.0, 0.0], [-0.0, -0.0], [math.nan, 1.0], [1.0, math.nan], [], [1.0, 2.0, -3.0], [-math.inf], [-0.0]]
    maxes += [[rng.uniform(-5, 5) for _ in range(3)] for _ in range(300)]
    node = run(
        "numbers",
        values=[], rounds=[bits(v) for v in rounds], hypots=[[bits(v) for v in a] for a in hypots],
        maxes=[[bits(v) for v in a] for a in maxes], parses=[], structures=[],
    )  # fmt: skip
    for v, want in zip(rounds, node["round"], strict=True):
        r = js_round(v)
        got = "-0" if (r == 0 and math.copysign(1, r) < 0) else number_to_string(r)
        assert got == want, (v, got, want)
    for a, want in zip(hypots, node["hypot"], strict=True):
        assert bits(js_hypot(*a)) == want, a
    for a, mx, mn in zip(maxes, node["max"], node["min"], strict=True):
        vmax, vmin = js_max(*a), js_min(*a)
        assert number_to_string(vmax) + ("-" if vmax == 0 and math.copysign(1, vmax) < 0 else "") == mx, a
        assert number_to_string(vmin) + ("-" if vmin == 0 and math.copysign(1, vmin) < 0 else "") == mn, a


PARSES = [
    "0", "-0", "1.0", "1e400", "-1e400", "NaN", "Infinity", "-Infinity", "12345678901234567890", "9007199254740993",
    "-9007199254740993", "1e-400", "01", "1.", ".5", "+1", "0x10", '"\\ud800"', '"\\ud83d\\ude00"', '"\\udc00\\ud800"',
    '"\\u0000\\u001f\\u2028\\u2029\\u007f"', '"a\tb"', '"\\x41"', '{"a":1,"a":2}', '{"b":1,"a":2,"1":3,"0":4}', "[1,]", "{,}",
    "{\"a\":1,}", "\ufeff{}", " \t\r\n{} \n", "\u00a0{}", "true", "null", '"\\/"', "[[[[[]]]]]", '{"__proto__":1}',
    "1E5", "1e+5", "-", "--1", '"', "[1 2]", "/*x*/1", "1 // c", '"\\uD800\\uDC00"', "1.5e308", "2e308", "-0.0", "0e5",
    '{"look":[1.0,2,3e0]}', '"é"', "", " ", "[" * 50 + "]" * 50,
]  # fmt: skip
STRUCTURES = [
    '{"b":1,"a":[1,2,{"z":null,"y":true}],"c":"x\\u2028y"}',
    '{"10":1,"9":2,"a":3,"01":4,"4294967294":5,"4294967295":6,"-1":7,"1.5":8}',
    '[1e21,1e-7,-0,0.1,123456789012345678,5e-324]',
    '{"sid":"abc","look":[0,1,2,3,4,5,6,7,0,1,2,3],"nick":"새벽의 고양이 12","exp":1763000000000}',
    '{"emoji":"\\ud83d\\ude00\\u200d\\ud83d\\udc68","lone":"\\udfff","ctrl":"\\u0001\\b\\f\\n\\r\\t\\"\\\\"}',
]


def test_json_parse_and_stringify_match_v8() -> None:
    node = run("numbers", values=[], rounds=[], hypots=[], maxes=[], parses=PARSES, structures=STRUCTURES)
    for text, want in zip(PARSES, node["parse"], strict=True):
        try:
            got = json_stringify(json_parse(text))
        except JSONParseError:
            got = None
        assert got == want, (text, got, want)
    for text, want in zip(STRUCTURES, node["stringify"], strict=True):
        assert json_stringify(json_parse(text)) == want


def test_json_stringify_every_bmp_code_unit() -> None:
    node = run("jsonStrings")
    for c, want in enumerate(node):
        assert json_stringify(chr(c)) == want, hex(c)


def test_object_key_order_like_v8() -> None:
    keys = ["b", "10", "a", "2", "01", "0", "4294967294", "4294967295", "-1", "1.5", "", "__x", "1e3", " 1", "99999999999"]
    want = run("objectKeys", keys=keys)
    assert json_stringify({k: i for i, k in enumerate(keys)}) == want


def test_utf8_decode_matches_node() -> None:
    rng = random.Random(4)
    samples = [b"", b"\xef\xbb\xbfa", b"\xf0\x80\x80", b"\xe2\x82", b"\xed\xa0\x80", b"\xc0\xaf", b"\xf4\x90\x80\x80", b"\xff\xfe"]
    pieces = [b"a", b"\x80", b"\xc3", b"\xa9", b"\xe2\x82\xac", b"\xf0\x9f\x98\x80", b"\xed", b"\xf0", b"\xff", b"\xe0\xa0", b"\xf4\x8f"]
    samples += [b"".join(rng.choice(pieces) for _ in range(rng.randint(1, 8))) for _ in range(3000)]
    samples += [bytes(rng.getrandbits(8) for _ in range(rng.randint(1, 12))) for _ in range(3000)]
    node = run("utf8", hexes=[s.hex() for s in samples])
    for s, want in zip(samples, node, strict=True):
        assert utf8_decode(s) == want, s


def test_string_helpers() -> None:
    assert utf16_len("a😀") == 3 and code_points("a😀") == 2 and code_points("\ud800") == 1
    assert canonical("\ud83d\ude00") == "\U0001f600" and to_utf16_units("\U0001f600") == "\ud83d\ude00"
    assert slice_units("😀a", 0, 1) == "\ud83d"
    assert usv("a\ud800b") == "a\ufffdb" and utf8_encode("\udc00") == b"\xef\xbf\xbd"
    assert js_trim("\ufeff\u3000 a\u0085 \u200b") == "a\u0085 \u200b"
    assert js_trim("\x1c a \x1f") == "\x1c a \x1f"
    assert json_stringify({"a": UNDEFINED, "b": [UNDEFINED]}) == '{"b":[null]}'
    assert json_stringify(UNDEFINED) is None
    assert is_integer(1.0) and is_integer(-0.0) and not is_integer(True) and not is_integer(math.inf)
    assert json.loads(json_stringify({"x": "\u2028"})) == {"x": "\u2028"}
    with pytest.raises(JSONParseError):
        json_parse("NaN")
