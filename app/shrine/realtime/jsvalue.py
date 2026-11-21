"""WebSocket 메시지 칸을 JS처럼 읽기 (realtime.ts가 쓰는 ``Number(v)``).

메시지는 ``JSON.parse`` 결과라서 값은 undefined(칸 없음) · null · 참거짓 · 숫자 · 글자 · 배열 · 객체뿐입니다.
  · ``Number(undefined)`` = NaN, ``Number(null)`` = 0 → 칸이 없는 것(UNDEFINED)과 null(None)을 구분합니다.
  · 글자는 ECMA-262 StringToNumber (앞뒤 JS 공백 무시, 빈 글자 0, 0x · 0o · 0b, Infinity, 1e999 → Infinity, 그 밖 NaN).
  · 배열은 ``join(',')`` 뒤 글자로 (``[5]`` → 5, ``[]`` → 0, ``[1,2]`` → NaN).
  · 객체는 ToPrimitive: 자기 칸 ``toString``이 있으면(JSON 값은 함수가 아니라 부를 수 없음) JS는 TypeError를 냅니다
    (예: ``{"t":"mv","x":{"toString":1}}``). 그 메시지는 처리 중 예외로 셉니다 (1분에 5번이면 1011). 없으면 NaN.
"""

from __future__ import annotations

import math
import re
from typing import Any

from ..logic.jsnum import UNDEFINED, number_to_string
from ..logic.jsstr import JS_WS

__all__ = ["JSTypeError", "string_to_number", "to_number"]


class JSTypeError(TypeError):
    """JS TypeError: Cannot convert object to primitive value."""


_DEC = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_RADIX = {"x": (16, re.compile(r"[0-9a-fA-F]+")), "o": (8, re.compile(r"[0-7]+")), "b": (2, re.compile(r"[01]+"))}


def string_to_number(s: str) -> float:
    t = s.strip(JS_WS)
    if not t:
        return 0.0
    if t in ("Infinity", "+Infinity"):
        return math.inf
    if t == "-Infinity":
        return -math.inf
    if len(t) > 2 and t[0] == "0" and t[1] in "xXoObB":
        radix, digits = _RADIX[t[1].lower()]
        if not digits.fullmatch(t[2:]):
            return math.nan
        try:
            return float(int(t[2:], radix))
        except OverflowError:
            return math.inf
    if _DEC.fullmatch(t):
        return float(t)
    return math.nan


def _to_string(v: Any) -> str:
    """배열 원소의 ToString (null · undefined는 빈 글자)."""
    if v is None or v is UNDEFINED:
        return ""
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, str):
        return v
    if isinstance(v, (int, float)):
        return number_to_string(v)
    if isinstance(v, list):
        return ",".join(_to_string(x) for x in v)
    if isinstance(v, dict):
        if "toString" in v:
            raise JSTypeError("Cannot convert object to primitive value")
        return "[object Object]"
    return str(v)


def to_number(v: Any) -> float | int:
    """JS ``Number(v)``. 숫자는 그대로(int면 int), 나머지는 float. 바꿀 수 없는 객체면 JSTypeError."""
    if v is UNDEFINED:
        return math.nan
    if v is None:
        return 0
    if v is True:
        return 1
    if v is False:
        return 0
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str):
        return string_to_number(v)
    if isinstance(v, list):
        return string_to_number(_to_string(v))
    if isinstance(v, dict):
        if "toString" in v:
            raise JSTypeError("Cannot convert object to primitive value")
        return math.nan
    return math.nan
