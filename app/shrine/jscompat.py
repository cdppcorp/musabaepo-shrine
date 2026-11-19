"""Node(JavaScript)와 결과가 같아야 하는 작은 도구 모음.

서버 뼈대(설정 검사 · HTTP)가 쓰는 것만 둡니다. 맵 수치 · 입력 거르기처럼 기능 쪽에서 쓰는 같은 성격의 함수는
shrine/logic/ 아래에 따로 있습니다 (나중에 겹치는 것은 한곳으로 모읍니다).
"""

from __future__ import annotations

import json
import math
import re

# JS String.prototype.trim이 지우는 글자 (WhiteSpace + LineTerminator).
# Python str.strip()은 \x1c-\x1f · \x85를 지우고 ﻿를 남겨서 결과가 다릅니다.
JS_WHITESPACE = (
    "\t\n\v\f\r              "
    "    　﻿"
)
# 정규식 문자 집합 안에 넣는 JS \s
JS_WS_CLASS = "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
# JS 정규식의 . (u 플래그 없음): 줄바꿈 4종만 빼고 모두
JS_DOT = "[^\\n\\r\\u2028\\u2029]"


def js_trim(s: str) -> str:
    return s.strip(JS_WHITESPACE)


def utf16_len(s: str) -> int:
    """JS의 string.length (UTF-16 코드 단위 수)."""
    return len(s) + sum(1 for c in s if ord(c) > 0xFFFF)


def utf16_units(s: str) -> str:
    """BMP 밖 글자를 서로게이트 두 글자로 펼칩니다. u 플래그 없는 JS 정규식을 그대로 흉내 낼 때 씁니다."""
    if all(ord(c) <= 0xFFFF for c in s):
        return s
    out = []
    for c in s:
        o = ord(c)
        if o > 0xFFFF:
            o -= 0x10000
            out.append(chr(0xD800 + (o >> 10)))
            out.append(chr(0xDC00 + (o & 0x3FF)))
        else:
            out.append(c)
    return "".join(out)


def js_round(x: float) -> int:
    """Math.round: .5는 위로 (Python round는 짝수 쪽으로)."""
    return math.floor(x + 0.5)


# ── net.isIP (Node lib/internal/net.js의 정규식 그대로) ──
_V4_SEG = r"(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])"
_V4_STR = rf"(?:{_V4_SEG}\.){{3}}{_V4_SEG}"
_V6_SEG = r"(?:[0-9a-fA-F]{1,4})"
_IPV4_RE = re.compile(_V4_STR)
_IPV6_RE = re.compile(
    "(?:"
    rf"(?:{_V6_SEG}:){{7}}(?:{_V6_SEG}|:)|"
    rf"(?:{_V6_SEG}:){{6}}(?:{_V4_STR}|:{_V6_SEG}|:)|"
    rf"(?:{_V6_SEG}:){{5}}(?::{_V4_STR}|(?::{_V6_SEG}){{1,2}}|:)|"
    rf"(?:{_V6_SEG}:){{4}}(?:(?::{_V6_SEG}){{0,1}}:{_V4_STR}|(?::{_V6_SEG}){{1,3}}|:)|"
    rf"(?:{_V6_SEG}:){{3}}(?:(?::{_V6_SEG}){{0,2}}:{_V4_STR}|(?::{_V6_SEG}){{1,4}}|:)|"
    rf"(?:{_V6_SEG}:){{2}}(?:(?::{_V6_SEG}){{0,3}}:{_V4_STR}|(?::{_V6_SEG}){{1,5}}|:)|"
    rf"(?:{_V6_SEG}:){{1}}(?:(?::{_V6_SEG}){{0,4}}:{_V4_STR}|(?::{_V6_SEG}){{1,6}}|:)|"
    rf"(?::(?:(?::{_V6_SEG}){{0,5}}:{_V4_STR}|(?::{_V6_SEG}){{1,7}}|:))"
    r")(?:%[0-9a-zA-Z\-.:]{1,})?"
)


def is_ip(s: str) -> int:
    """net.isIP: IPv4면 4, IPv6면 6, 아니면 0."""
    if _IPV4_RE.fullmatch(s):
        return 4
    if _IPV6_RE.fullmatch(s):
        return 6
    return 0


# ── JSON.stringify ──


def js_number(x: float | int) -> str:
    """Number.prototype.toString (10진). JSON.stringify의 숫자 모양과 같습니다 (NaN · 무한대는 null)."""
    if isinstance(x, bool):
        raise TypeError("bool")
    if isinstance(x, int):
        return str(x)
    if x != x or x in (math.inf, -math.inf):
        return "null"
    if x == 0:
        return "0"
    if x.is_integer() and abs(x) < 9007199254740992:  # 2**53 안에서는 정수 글자가 그대로 맞습니다
        return str(int(x))
    sign = "-" if x < 0 else ""
    # repr는 JS와 같은 '가장 짧게 되돌아오는' 자릿수를 줍니다. 모양(지수 표기 기준)만 JS 규칙으로 다시 씁니다
    mant, _, exp = repr(abs(x)).partition("e")
    ip, _, fp = mant.partition(".")
    raw = ip + fp
    lead = len(raw) - len(raw.lstrip("0"))
    digits = raw.lstrip("0").rstrip("0") or "0"
    n = len(ip) - lead + (int(exp) if exp else 0)  # 값 = 0.digits × 10^n
    k = len(digits)
    if k <= n <= 21:
        out = digits + "0" * (n - k)
    elif 0 < n <= 21:
        out = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        out = digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return sign + out


_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def _js_str(s: str) -> str:
    out = json.dumps(s, ensure_ascii=False)
    # Python str 안의 서로게이트는 늘 짝이 없는 것입니다. JSON.stringify는 \udxxx로 적습니다
    return _LONE_SURROGATE.sub(lambda m: "\\u%04x" % ord(m.group()), out)


def js_json(value) -> str:
    """JSON.stringify(value)와 같은 글자 (공백 없음, 한글 그대로). dict · list · str · int · float · bool · None만."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return js_number(value)
    if isinstance(value, str):
        return _js_str(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(js_json(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(_js_str(str(k)) + ":" + js_json(v) for k, v in value.items()) + "}"
    raise TypeError(f"JSON으로 바꿀 수 없는 값: {type(value).__name__}")
