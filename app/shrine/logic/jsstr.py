"""JavaScript 문자열(UTF-16) 동작을 Python 문자열에서 똑같이 냅니다.

JS 문자열은 UTF-16 코드 단위의 나열이고, Python ``str``은 코드 포인트의 나열입니다. ``json.loads``는
``"\\ud83d\\ude00"`` 같은 서로게이트 쌍을 한 글자(U+1F600)로 합치고, 짝 없는 서로게이트(``"\\ud800"``)는
그대로 둡니다. 그래서 Node가 ``JSON.parse``로 받은 문자열과 Python이 ``json.loads``로 받은 문자열은
이 모듈의 함수로 서로 바꿔 볼 수 있습니다.

| 함수 | JS 원본 | 쓰는 곳 |
|---|---|---|
| ``canonical`` | (JS 문자열 자체) | 서로게이트 쌍이 두 글자로 따로 든 Python 문자열을 한 글자로 |
| ``utf16_len`` | ``s.length`` | shrines.ts:90 (200자), security.ts:58 (600자), admin.ts:161 · 241 |
| ``code_points`` | ``[...s].length`` · ``Array.from(s).length`` | chat.ts:32, shrines.ts:61, registry.ts:132 |
| ``to_utf16_units`` | (u 플래그 없는 정규식이 보는 문자열) | shrines.ts:64 EMAIL_RE의 ``{1,64}``가 코드 단위를 셈 |
| ``usv`` | WebIDL USVString 변환 (``new URL``, ``TextEncoder``) | 짝 없는 서로게이트 → U+FFFD |
| ``utf8_encode`` | ``Buffer.from(s)`` · ``hash.update(s)`` | 짝 없는 서로게이트는 EF BF BD |
| ``js_trim`` | ``s.trim()`` | chat.ts:30, shrines.ts:68 · 89, moderation.ts:86 |
| ``JS_WS`` | 정규식 ``\\s`` · ``trim``이 보는 공백 | chat.ts:15 · 30 · 34 |
| ``slice_units`` | ``s.slice(a, b)`` (코드 단위) | admin.ts:214, security.ts:32 (base64url이라 ASCII) |
| ``js_lower`` | ``s.toLowerCase()`` (유니코드 17) | chat.ts:34, moderation.ts:86, admin.ts:57, registry.ts:146 · 631 |
"""

from __future__ import annotations

__all__ = [
    "JS_WS",
    "JS_WS_CLASS",
    "canonical",
    "code_points",
    "js_lower",
    "js_trim",
    "slice_units",
    "to_utf16_units",
    "usv",
    "utf16_len",
    "utf8_decode",
    "utf8_encode",
]

#: ECMAScript WhiteSpace + LineTerminator (정규식 ``\s``, ``String.prototype.trim``).
#: Zs 글자는 유니코드 17 기준 U+0020 · U+00A0 · U+1680 · U+2000-200A · U+202F · U+205F · U+3000.
JS_WS = "\t\n\x0b\x0c\r \xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
#: 정규식 문자 클래스 안에 넣는 모양 (re · regex 공용)
JS_WS_CLASS = r"\t\n\x0b\x0c\r \xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def canonical(s: str) -> str:
    """서로게이트 쌍(높은 것 + 낮은 것)이 두 글자로 들어 있으면 한 글자로 합칩니다. 짝 없는 서로게이트는 그대로.

    JS에서는 두 표기가 같은 문자열이므로, JS 결과와 비교하기 전에 이 모양으로 맞춥니다.
    """
    if not any(0xD800 <= ord(c) <= 0xDFFF for c in s):
        return s
    return s.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")


def to_utf16_units(s: str) -> str:
    """U+10000 이상 글자를 서로게이트 두 글자로 나눈 문자열. u 플래그 없는 JS 정규식이 보는 그대로입니다."""
    if all(ord(c) < 0x10000 for c in s):
        return s
    out = []
    for c in s:
        o = ord(c)
        if o >= 0x10000:
            o -= 0x10000
            out.append(chr(0xD800 + (o >> 10)))
            out.append(chr(0xDC00 + (o & 0x3FF)))
        else:
            out.append(c)
    return "".join(out)


def utf16_len(s: str) -> int:
    """JS ``s.length`` (UTF-16 코드 단위 수)."""
    return len(s) + sum(1 for c in s if ord(c) >= 0x10000)


def code_points(s: str) -> int:
    """JS ``[...s].length``: 코드 포인트 수. 짝 없는 서로게이트도 하나로 셉니다."""
    return len(canonical(s))


def slice_units(s: str, start: int, end: int | None = None) -> str:
    """JS ``s.slice(start, end)``: 코드 단위로 자릅니다. 서로게이트 쌍 가운데를 자르면 짝 없는 서로게이트가 남습니다."""
    return canonical(to_utf16_units(s)[start:end])


def usv(s: str) -> str:
    """WebIDL USVString 변환: 짝 없는 서로게이트를 U+FFFD로 (``new URL(s)``가 맨 먼저 하는 일)."""
    s = canonical(s)
    if not any(0xD800 <= ord(c) <= 0xDFFF for c in s):
        return s
    return "".join("\ufffd" if 0xD800 <= ord(c) <= 0xDFFF else c for c in s)


def utf8_encode(s: str) -> bytes:
    """Node ``Buffer.from(s, 'utf8')`` · ``hash.update(s)``: 짝 없는 서로게이트는 U+FFFD(EF BF BD)로."""
    return usv(s).encode("utf-8")


def utf8_decode(b: bytes) -> str:
    """Node ``buf.toString('utf8')``: 잘못된 바이트는 U+FFFD (최대 부분열마다 하나), BOM은 떼지 않습니다."""
    return b.decode("utf-8", "replace")


def js_trim(s: str) -> str:
    """JS ``s.trim()``: 앞뒤의 JS 공백(``JS_WS``)만 지웁니다. Python ``strip()``과 달리 U+001C~001F · U+0085는 남깁니다."""
    return s.strip(JS_WS)


#: V8(ICU 78, 유니코드 17)에는 있고 Python 3.13(유니코드 15.1)에는 없는 소문자 매핑 (16.0 · 17.0에서 생긴 대문자).
#: (시작, 끝, 더할 값). 코드 포인트 전체를 Node와 맞춰 보는 시험(test_logic_chat.py)이 확인합니다.
_V8_LOWER_RANGES: tuple[tuple[int, int, int], ...] = (
    (0x1C89, 0x1C89, 1), (0xA7CB, 0xA7CB, -42343), (0xA7CC, 0xA7CC, 1), (0xA7CE, 0xA7CE, 1), (0xA7D2, 0xA7D2, 1),
    (0xA7D4, 0xA7D4, 1), (0xA7DA, 0xA7DA, 1), (0xA7DC, 0xA7DC, -42561), (0x10D50, 0x10D65, 32), (0x16EA0, 0x16EB8, 27),
)
_V8_LOWER = {cp: cp + off for a, b, off in _V8_LOWER_RANGES for cp in range(a, b + 1)}


def js_lower(s: str) -> str:
    """JS ``s.toLowerCase()``: Python ``str.lower()``(전체 매핑 · 끝 시그마) + 유니코드 16 · 17 대문자 55개 보충.

    남는 차이: 끝 시그마(Σ → ς) 판단에서 15.1에 없는 글자를 '대소문자 있는 글자'로 보지 못하는 것뿐입니다 (그리스 문자 옆에 새 문자가 올 때).
    """
    if not s.isascii():
        s = s.translate(_V8_LOWER)
    return s.lower()
