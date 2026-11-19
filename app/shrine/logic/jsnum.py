"""JavaScript(V8) 숫자 · JSON 동작을 Python에서 똑같이 냅니다.

Node 서버가 기대는 JS 내장 동작 가운데 Python 기본 동작과 다른 것만 모았습니다.

| 함수 | JS 원본 | Python 기본과 다른 점 |
|---|---|---|
| ``js_round`` | ``Math.round`` | ``round()``는 .5를 짝수 쪽으로 보냄 (214.5 → 214). JS는 +∞ 쪽 (215, -2.5 → -2) |
| ``js_hypot`` | ``Math.hypot`` (V8 math.tq: 최댓값으로 나눈 뒤 Kahan 합) | ``math.hypot``은 계산 순서가 달라 마지막 자리가 다를 수 있음 |
| ``js_max`` / ``js_min`` | ``Math.max`` / ``Math.min`` | ``max()``는 NaN 위치에 따라 결과가 바뀜, -0/+0 구분 없음 |
| ``is_integer`` | ``Number.isInteger`` | bool을 숫자로 보지 않음, 1.0은 정수 |
| ``number_to_string`` | ``Number.prototype.toString()`` / JSON 숫자 | ``repr``은 ``1e+22`` · ``1.0`` · ``1e-07`` 모양이 다름 |
| ``json_stringify`` | ``JSON.stringify`` (공백 없음) | 키 순서(배열 인덱스 키 먼저), ``ensure_ascii`` 없음, 제어 문자 · 외톨이 서로게이트 이스케이프 모양 |
| ``json_parse`` | ``JSON.parse`` | Python은 NaN · Infinity를 받고 큰 정수를 정확히 둠. JS는 거절 / double로 반올림 |

서버 어디서 쓰나: world.ts의 ``Math.round`` · ``Math.hypot`` (world.ts:130-134, 258-276, 281-299),
security.ts의 ``JSON.stringify(ticket)`` (security.ts:52-55), admin.ts의 세션 본문 (admin.ts:154-157),
http.ts의 ``JSON.stringify(body)`` 응답 전체 (http.ts:85, 369).

``UNDEFINED``는 JS ``undefined`` 자리입니다. 객체 안에서는 키를 빼고, 배열 안에서는 ``null``이 됩니다.
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping
from typing import Any

__all__ = [
    "UNDEFINED",
    "JSONParseError",
    "is_array_index",
    "is_integer",
    "js_hypot",
    "js_max",
    "js_min",
    "js_round",
    "json_parse",
    "json_stringify",
    "number_to_string",
    "quote_json_string",
]


class _Undefined:
    __slots__ = ()

    def __repr__(self) -> str:
        return "UNDEFINED"

    def __bool__(self) -> bool:
        return False


UNDEFINED: Any = _Undefined()


# ── Math ──────────────────────────────────────────────────────────────


def js_round(x: float) -> float:
    """``Math.round``: 가장 가까운 정수, 딱 가운데면 +∞ 쪽 (-2.5 → -2, 214.5 → 215).

    -0.4 · -0.5처럼 0으로 가는 음수는 JS처럼 -0.0을 돌려줍니다 (JSON에서는 0).
    0.49999999999999994처럼 x+0.5가 반올림으로 1이 되는 값도 JS처럼 0입니다.
    """
    x = float(x)
    if math.isnan(x) or math.isinf(x) or x == math.floor(x):
        return x
    f = math.floor(x)
    # x - f는 |x| < 2**52에서 정확합니다 (f가 x에 가장 가까운 아래 정수라 뺄셈에 반올림이 없음)
    r = f + 1.0 if x - f >= 0.5 else f
    if r == 0 and x < 0:
        return -0.0
    return r


def js_hypot(*values: float) -> float:
    """V8 ``Math.hypot`` (src/builtins/math.tq MathHypot): 최댓값으로 나눠 Kahan 합을 낸 뒤 sqrt × 최댓값."""
    absvals = []
    max_v = 0.0
    one_nan = False
    for v in values:
        a = abs(float(v))
        if math.isnan(a):
            one_nan = True
        elif a > max_v:
            max_v = a
        absvals.append(a)
    if math.isinf(max_v):
        return math.inf
    if one_nan:
        return math.nan
    if max_v == 0:
        return 0.0
    total = 0.0
    compensation = 0.0
    for a in absvals:
        n = a / max_v
        summand = n * n - compensation
        preliminary = total + summand
        compensation = (preliminary - total) - summand
        total = preliminary
    return math.sqrt(total) * max_v


def js_max(*values: float) -> float:
    """``Math.max``: 하나라도 NaN이면 NaN, +0이 -0보다 큼, 인자가 없으면 -Infinity."""
    out = -math.inf
    for v in values:
        v = float(v)
        if math.isnan(v):
            return math.nan
        if v > out or (v == 0 and out == 0 and math.copysign(1, out) < 0):
            out = v
    return out


def js_min(*values: float) -> float:
    """``Math.min``: 하나라도 NaN이면 NaN, -0이 +0보다 작음, 인자가 없으면 Infinity."""
    out = math.inf
    for v in values:
        v = float(v)
        if math.isnan(v):
            return math.nan
        if v < out or (v == 0 and out == 0 and math.copysign(1, v) < 0):
            out = v
    return out


def is_number(v: object) -> bool:
    """JS ``typeof v === 'number'`` (bool 제외)."""
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def is_integer(v: object) -> bool:
    """``Number.isInteger``: 숫자이고 유한하며 소수부가 없음. bool은 아님, 1.0 · -0.0은 정수."""
    if isinstance(v, bool):
        return False
    if isinstance(v, int):
        return True
    if isinstance(v, float):
        return math.isfinite(v) and v == math.floor(v)
    return False


# ── Number → 문자열 (ECMA-262 Number::toString, radix 10) ─────────────


def _to_double(x: float | int) -> float:
    if isinstance(x, bool):
        raise TypeError("bool은 숫자가 아닙니다")
    try:
        return float(x)
    except OverflowError:  # 2**1024 이상의 Python int → JS에서는 Infinity
        return math.inf if x > 0 else -math.inf


def number_to_string(x: float | int) -> str:
    """JS ``String(x)``와 같은 글자. 정수는 ``.0`` 없이, 1e21 이상 · 1e-7 미만은 지수 표기 (``1e+21``, ``1.5e-7``)."""
    v = _to_double(x)
    if math.isnan(v):
        return "NaN"
    if v == 0:
        return "0"
    if math.isinf(v):
        return "Infinity" if v > 0 else "-Infinity"
    if v < 0:
        return "-" + number_to_string(-v)
    # repr은 가장 짧게 되돌아오는 자릿수를 냅니다 (V8과 같은 최단 · 최근접 자릿수)
    r = repr(v)
    if "e" in r:
        mant, exp_s = r.split("e")
        exp = int(exp_s)
    else:
        mant, exp = r, 0
    if "." in mant:
        ip, fp = mant.split(".")
    else:
        ip, fp = mant, ""
    digits = ip + fp
    n = len(ip) + exp
    stripped = digits.lstrip("0")
    n -= len(digits) - len(stripped)
    digits = stripped.rstrip("0")
    k = len(digits)
    if k <= n <= 21:
        return digits + "0" * (n - k)
    if 0 < n <= 21:
        return digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + digits
    e = n - 1
    sign = "+" if e >= 0 else "-"
    if k == 1:
        return f"{digits}e{sign}{abs(e)}"
    return f"{digits[0]}.{digits[1:]}e{sign}{abs(e)}"


# ── JSON.stringify ────────────────────────────────────────────────────

_ESCAPES = {
    0x08: "\\b",
    0x09: "\\t",
    0x0A: "\\n",
    0x0C: "\\f",
    0x0D: "\\r",
    0x22: '\\"',
    0x5C: "\\\\",
}


def quote_json_string(s: str) -> str:
    """V8 ``JSON.stringify(string)`` (ES2019 well-formed): ``" \\ \\b \\t \\n \\f \\r``는 짧은 이스케이프,
    나머지 U+0000~U+001F와 짝 없는 서로게이트는 ``\\u00xx`` · ``\\udxxx`` (소문자 16진). U+2028/2029 · U+007F · 그 밖은 그대로.

    Python 문자열에 서로게이트 쌍이 두 글자로 따로 들어 있으면(UTF-16 단위를 그대로 옮긴 경우) 한 글자로 봅니다 (JS와 같음).
    """
    out: list[str] = ['"']
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        o = ord(c)
        if o < 0x20 or o == 0x22 or o == 0x5C:
            out.append(_ESCAPES.get(o) or f"\\u{o:04x}")
        elif 0xD800 <= o <= 0xDBFF:
            if i + 1 < n and 0xDC00 <= ord(s[i + 1]) <= 0xDFFF:
                out.append(c + s[i + 1])
                i += 1
            else:
                out.append(f"\\u{o:04x}")
        elif 0xDC00 <= o <= 0xDFFF:
            out.append(f"\\u{o:04x}")
        else:
            out.append(c)
        i += 1
    out.append('"')
    return "".join(out)


def is_array_index(key: str) -> bool:
    """V8가 객체 키를 정수 순서로 먼저 늘어놓는 '배열 인덱스' 키인지: 0 ≤ n < 2**32 - 1, 앞자리 0 없는 십진수."""
    if not key or len(key) > 10 or not key.isascii() or not key.isdigit():
        return False
    if len(key) > 1 and key[0] == "0":
        return False
    return int(key) < 4294967295


def _key_str(k: object) -> str:
    if isinstance(k, str):
        return k
    if isinstance(k, bool) or k is None:
        return "true" if k is True else "false" if k is False else "null"
    if isinstance(k, (int, float)):
        return number_to_string(k)
    raise TypeError(f"JSON 객체 키로 쓸 수 없는 값: {k!r}")


def ordered_items(obj: Mapping[Any, Any]) -> list[tuple[str, Any]]:
    """JS 객체의 키 나열 순서 (OrdinaryOwnPropertyKeys): 배열 인덱스 키를 숫자 오름차순으로 먼저, 나머지는 넣은 순서.

    같은 키가 두 번 나오면(예: 1과 '1') JS처럼 처음 자리 · 나중 값.
    """
    seen: dict[str, Any] = {}
    for k, v in obj.items():
        seen[_key_str(k)] = v
    idx = sorted((k for k in seen if is_array_index(k)), key=int)
    rest = [k for k in seen if not is_array_index(k)]
    return [(k, seen[k]) for k in idx + rest]


def _stringify(v: Any, stack: list[int]) -> str | None:
    if v is UNDEFINED:
        return None
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, str):
        return quote_json_string(v)
    if isinstance(v, (int, float)):
        d = _to_double(v)
        return number_to_string(d) if math.isfinite(d) else "null"
    if isinstance(v, Mapping):
        if id(v) in stack:
            raise ValueError("순환 구조는 JSON으로 만들 수 없습니다")
        stack.append(id(v))
        parts = []
        for k, item in ordered_items(v):
            s = _stringify(item, stack)
            if s is not None:
                parts.append(quote_json_string(k) + ":" + s)
        stack.pop()
        return "{" + ",".join(parts) + "}"
    if isinstance(v, (list, tuple)):
        if id(v) in stack:
            raise ValueError("순환 구조는 JSON으로 만들 수 없습니다")
        stack.append(id(v))
        parts = []
        for item in v:
            s = _stringify(item, stack)
            parts.append("null" if s is None else s)
        stack.pop()
        return "[" + ",".join(parts) + "]"
    raise TypeError(f"JSON으로 만들 수 없는 값: {type(v).__name__}")


def json_stringify(value: Any) -> str | None:
    """``JSON.stringify(value)`` (replacer · space 없이). 최상위가 ``UNDEFINED``면 None (JS undefined)."""
    return _stringify(value, [])


# ── JSON.parse ────────────────────────────────────────────────────────


class JSONParseError(ValueError):
    """``JSON.parse``가 SyntaxError를 내는 입력."""


def _reject_constant(name: str) -> Any:
    raise JSONParseError(f"JSON.parse는 {name}를 받지 않습니다")


def _parse_int(s: str) -> int | float:
    # JS 숫자는 double입니다. 2**53을 넘는 정수는 가장 가까운 double로 (Python int 그대로 두면 값이 달라짐)
    if s == "-0":
        return -0.0
    v = int(s)
    if -(2**53) <= v <= 2**53:
        return v
    f = float(s)
    return int(f) if math.isfinite(f) else f


def json_parse(text: str) -> Any:
    """``JSON.parse(text)``: NaN · Infinity 글자 거절, 정수는 double 정밀도로, 실패는 ``JSONParseError``.

    객체는 dict (같은 키는 나중 값), 배열은 list, 실수는 float입니다. 정수 모양 숫자는 int로 돌려줍니다
    (``1.0``은 float 1.0 — ``is_integer``로 보면 JS처럼 정수입니다).
    """
    if not isinstance(text, str):
        raise TypeError("문자열만 받습니다")
    try:
        return json.loads(text, parse_constant=_reject_constant, parse_int=_parse_int)
    except JSONParseError:
        raise
    except (ValueError, RecursionError) as e:
        raise JSONParseError(str(e)) from None
