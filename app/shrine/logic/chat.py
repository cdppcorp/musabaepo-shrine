"""직접 쓴 메시지 · 이름 · 소개 거르기: server/chat.ts (+ registry.ts · ops.ts의 같은 계열 함수)를 옮겼습니다.

| 함수 | 원본 |
|---|---|
| ``CHAT_MAX`` | chat.ts:4 |
| ``INVISIBLE`` · ``LINK`` · ``EMAIL`` · ``LONG_NUMBER`` · ``CONTACT_WORDS`` | chat.ts:11-16 |
| ``BAD_WORDS`` | chat.ts:22-26 |
| ``clean_chat`` | chat.ts:28-39 ``cleanChat`` |
| ``clean_text`` · ``clean_sign`` · ``SIGN_MAX`` | registry.ts:128-142 ``cleanText`` · ``cleanSign`` |
| ``clean_op_text`` · ``clean_note`` · ``OpError`` | ops.ts:25-37 ``cleanOpText`` · ``cleanNote`` |

JS 정규식과 같은 뜻이 되도록 맞춘 것:

- ``NFC``: V8 ``normalize('NFC')``는 ICU 78(유니코드 17)입니다. Python ``unicodedata``는 15.1이라 쓰지 않고,
  Ada 정규화 표 + 유니코드 16 · 17 보충(``ada_idna.nfc_v8_str``)을 씁니다 (코드 포인트 전체를 Node와 맞춰 본 시험이 있습니다).
- ``\\p{Cc}\\p{Cf}`` · ``\\p{P}\\p{S}`` (u 플래그): ``regex`` 모듈 (유니코드 17 표).
- 짝 없는 서로게이트(Cs): 보안 점검으로 Node와 일부러 다르게 NFC 전에 지웁니다 (``LONE_SURROGATE``).
  Node는 그대로 두었지만 PostgreSQL text에 넣을 수 없어 DB 오류(500)가 났습니다. NUL 같은 제어 문자(Cc)는 원래 지움.
- ``\\s`` · ``trim()``: JS 공백 목록(``jsstr.JS_WS``)을 그대로 씁니다 (Python ``\\s`` · ``strip()``과 다름).
- u 플래그 없는 ``i`` · ``\\b`` · ``\\w`` · ``\\d``: ``re.ASCII`` (``ſ`` · ``K``(켈빈) 같은 글자가 a-z로 접히지 않음,
  ``abc.com가``의 ``m|가``는 단어 경계).
- 길이: ``[...text].length`` → 코드 포인트 수 (이모지 1, 짝 없는 서로게이트 1).
- ``toLowerCase``: ``jsstr.js_lower`` (Python ``lower()`` + 유니코드 16 · 17 대문자 보충).

결과 모양은 JS와 같은 dict입니다: ``{"ok": True, "text": ...}`` 또는 ``{"ok": False, "reason": ...}``.
"""

from __future__ import annotations

import re
from typing import Any

import regex

from .ada_idna import nfc_v8_str
from .jsstr import JS_WS_CLASS, canonical, code_points, js_lower, js_trim

__all__ = [
    "BAD_WORDS",
    "CHAT_MAX",
    "LONE_SURROGATE",
    "OpError",
    "SIGN_MAX",
    "clean_chat",
    "clean_note",
    "clean_op_text",
    "clean_sign",
    "clean_text",
    "js_normalize_nfc",
]

CHAT_MAX = 40

INVISIBLE = regex.compile(r"[\p{Cc}\p{Cf}]")
#: 짝 없는 서로게이트 (canonical으로 짝을 맞춘 뒤에도 남은 것)
LONE_SURROGATE = re.compile("[\ud800-\udfff]")
_WS_RUN = re.compile("[" + JS_WS_CLASS + "]+")
LINK = re.compile(
    r"(https?:|www\.|[a-z0-9-]+\.(com|net|org|kr|io|co|me|ly|gg|xyz|app|dev|shop|site|link|to|be|ai|so|kakao)\b|t\.me|open\.kakao|닷컴|닷넷)",
    re.IGNORECASE | re.ASCII,
)
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+", re.ASCII)
LONG_NUMBER = re.compile(r"[0-9](?:[" + JS_WS_CLASS + r".-]*[0-9]){7,}")
CONTACT_WORDS = re.compile(r"(카톡|카카오톡|오픈채팅|오픈톡|텔레그램|라인아이디|디엠주세요|dm주세요|연락주세요|연락처)", re.IGNORECASE | re.ASCII)
#: ``regex`` 모듈 표는 유니코드 18, V8(ICU 78)은 17입니다. 18에서 새로 생긴 문장 부호 · 기호는 JS에서 아직 미할당(Cn)이라
#: ``[\s\p{P}\p{S}]``에 걸리지 않으므로 빼 둡니다. 코드 포인트 전체를 Node와 맞춰 보는 시험이 이 목록을 확인합니다
#: (``regex``나 Node를 올리면 그 시험이 알려 줍니다).
UNICODE18_PUNCT_SYMBOL: tuple[tuple[int, int], ...] = (
    (0x20C2, 0x20C4), (0x2E60, 0x2E63), (0x10EC9, 0x10ECA), (0x1CED2, 0x1CED4), (0x1CEDD, 0x1CEDF), (0x1CEF1, 0x1CEFD),
    (0x1D1EB, 0x1D1FF), (0x1D253, 0x1D25A), (0x1D25D, 0x1D25E), (0x1D260, 0x1D27F), (0x1DB00, 0x1DB1C), (0x1F1AE, 0x1F1AE),
    (0x1F6D9, 0x1F6D9), (0x1F7DA, 0x1F7DB), (0x1F7F1, 0x1F7FF), (0x1FA8B, 0x1FA8D), (0x1FACC, 0x1FACC), (0x1FADD, 0x1FADD),
    (0x1FAEB, 0x1FAEB), (0x1FAF9, 0x1FAFA),
)  # fmt: skip
_EXCLUDE = "".join(f"\\U{a:08x}-\\U{b:08x}" for a, b in UNICODE18_PUNCT_SYMBOL)
_SPACE_PUNCT_SYMBOL = regex.compile("(?V1)[[" + JS_WS_CLASS + r"\p{P}\p{S}]--[" + _EXCLUDE + "]]")
_DIGIT = re.compile(r"[0-9]")

BAD_WORDS: tuple[str, ...] = (
    "시발", "씨발", "씨빨", "시빨", "씨팔", "시팔", "ㅅㅂ", "ㅆㅂ", "ㅄ", "병신", "븅신", "ㅂㅅ", "개새", "개색", "개세끼",
    "새끼", "ㅅㄲ", "좆", "존나", "ㅈㄴ", "지랄", "ㅈㄹ", "미친놈", "미친년", "니미", "느금", "엠창", "염병", "닥쳐",
    "애미", "애비", "창녀", "보지", "자지", "섹스", "fuck", "shit", "bitch", "sex", "porn", "야동", "바카라",
)  # fmt: skip


def js_normalize_nfc(s: str) -> str:
    """JS ``s.normalize('NFC')`` (유니코드 17)."""
    return nfc_v8_str(canonical(s))


def _squash(raw: str) -> str:
    """``raw.normalize('NFC').replace(INVISIBLE, '').replace(/\\s+/g, ' ').trim()`` (+ NFC 전에 짝 없는 서로게이트를 지움)"""
    text = INVISIBLE.sub("", js_normalize_nfc(LONE_SURROGATE.sub("", canonical(raw))))
    return js_trim(_WS_RUN.sub(" ", text))


def clean_chat(raw: Any, max_len: float = CHAT_MAX) -> dict[str, Any]:
    """chat.ts ``cleanChat``: 통과하면 ``{"ok": True, "text"}``, 아니면 reason이 empty · long · link · contact · word."""
    if not isinstance(raw, str):
        return {"ok": False, "reason": "empty"}
    text = _squash(raw)
    if not text:
        return {"ok": False, "reason": "empty"}
    if code_points(text) > max_len:
        return {"ok": False, "reason": "long"}
    if LINK.search(text) or EMAIL.search(text):
        return {"ok": False, "reason": "link"}
    compact_all = _SPACE_PUNCT_SYMBOL.sub("", js_lower(text))
    if LONG_NUMBER.search(text) or CONTACT_WORDS.search(compact_all):
        return {"ok": False, "reason": "contact"}
    compact = _DIGIT.sub("", compact_all)
    if any(w in compact for w in BAD_WORDS):
        return {"ok": False, "reason": "word"}
    return {"ok": True, "text": text}


# ── registry.ts: 이름 · 한 줄 소개 · 지붕 글자 ───────────────────────

SIGN_MAX = 8


def _fail(status: int, reason: str) -> dict[str, Any]:
    return {"ok": False, "status": status, "reason": reason}


def clean_text(raw: Any, max_len: float, field: str) -> dict[str, Any]:
    """registry.ts:136-142 ``cleanText``: 욕설 · 연락처는 그 까닭, 빈칸 · 길이 · 링크는 칸 이름(name · tagline · sign)으로 400."""
    v = clean_chat(raw, max_len)
    if v["ok"]:
        return v
    if v["reason"] in ("word", "contact"):
        return _fail(400, v["reason"])
    return _fail(400, field)


def clean_sign(raw: Any, tagline: str) -> dict[str, Any]:
    """registry.ts:131-134 ``cleanSign``: 비어 있으면 한 줄 소개 앞 8글자(코드 포인트)를 trim."""
    if raw is None or (isinstance(raw, str) and not js_trim(raw)):
        return {"ok": True, "text": js_trim("".join(list(canonical(tagline))[:SIGN_MAX]))}
    return clean_text(raw, SIGN_MAX, "sign")


# ── ops.ts: 운영자가 쓰는 글 ─────────────────────────────────────────


class OpError(ValueError):
    """ops.ts ``OpError``: 운영자에게 그대로 보여 주는 한국어 메시지."""


def clean_op_text(raw: Any, max_len: float, label: str, optional: bool = False) -> str:
    """ops.ts:28-34 ``cleanOpText``: 보이지 않는 문자를 빼고 공백은 하나로. 비어 있으면 optional일 때만 ''."""
    if raw is not None and not isinstance(raw, str):
        raise OpError(f"{label}: 글자로 넣어 주세요")
    text = _squash(raw if raw is not None else "")
    if not text and not optional:
        raise OpError(f"{label}: 비어 있습니다")
    if code_points(text) > max_len:
        raise OpError(f"{label}: {_num(max_len)}자까지 쓸 수 있습니다")
    return text


def _num(v: float) -> str:
    from .jsnum import number_to_string

    return number_to_string(v)


NOTE_MAX = 80


def clean_note(raw: Any) -> str:
    """ops.ts:37 ``cleanNote``: 사유 · 메모 (없어도 됨, 80자까지)."""
    return clean_op_text(raw, NOTE_MAX, "사유", True)
