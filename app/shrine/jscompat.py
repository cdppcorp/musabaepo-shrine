"""Node(JavaScript)와 결과가 같아야 하는 작은 도구 — 예전 이름을 지키는 얇은 다시 내보내기.

실제 구현은 shrine/logic/ 한곳에 있습니다 (Node와 차분 시험으로 맞춰 둔 것):
  · 문자열(UTF-16 · trim · 공백)        → logic/jsstr.py
  · 숫자 · JSON.stringify · Math.round   → logic/jsnum.py
  · net.isIP                            → logic/weburl.py
새 코드는 logic 모듈을 바로 쓰세요. 여기에는 뼈대(설정 검사)가 쓰던 이름만 남깁니다.
"""

from __future__ import annotations

import math
from typing import Any

from .logic import jsnum as _jsnum
from .logic.jsstr import JS_WS as JS_WHITESPACE
from .logic.jsstr import JS_WS_CLASS, js_trim, utf16_len
from .logic.jsstr import to_utf16_units as utf16_units
from .logic.weburl import is_ip

__all__ = [
    "JS_DOT", "JS_WHITESPACE", "JS_WS_CLASS", "is_ip", "js_json", "js_number", "js_round", "js_trim", "utf16_len", "utf16_units",
]  # fmt: skip

# JS 정규식의 . (u 플래그 없음): 줄바꿈 4종만 빼고 모두
JS_DOT = "[^\\n\\r\\u2028\\u2029]"


def js_round(x: float) -> int | float:
    """``Math.round`` (logic.jsnum.js_round). 유한한 값은 int로 돌려줍니다 (JSON 글자는 같음)."""
    r = _jsnum.js_round(x)
    return int(r) if math.isfinite(r) else r


def js_number(x: float | int) -> str:
    """JSON.stringify의 숫자 모양 (NaN · 무한대는 null)."""
    return _jsnum.json_stringify(x)  # type: ignore[return-value]


def js_json(value: Any) -> str:
    """``JSON.stringify(value)`` (logic.jsnum.json_stringify). 최상위가 undefined면 TypeError."""
    out = _jsnum.json_stringify(value)
    if out is None:
        raise TypeError("JSON으로 바꿀 수 없는 값: undefined")
    return out
