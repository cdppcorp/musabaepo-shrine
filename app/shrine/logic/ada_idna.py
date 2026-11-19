"""Node 내장 URL 파서(Ada 3.4.2)의 IDNA ``to_ascii``와 NFC 정규화를 그대로 옮겼습니다.

왜 직접 옮겼나: WHATWG ``new URL()``의 호스트 처리(UTS #46 ToASCII)는 Python ``idna`` 패키지와 결과가 다릅니다.
``idna.encode``는 IDNA2008 규칙(이모지 · 기호 거절, 앞뒤 하이픈 거절, 길이 제한)을 쓰지만 WHATWG는 UTS #46
비전이 처리 + CheckHyphens=false + VerifyDnsLength=false입니다. 게다가 Ada 3.4.2 구현에는 명세와 다른
버릇이 있어서(아래), "명세대로" 짜면 Node와 어긋납니다. 그래서 Ada 코드와 표(_ada_tables.py, IDNA 17.0.0)를 옮겼습니다.

Ada 3.4.2의 버릇 (Node 24.14에서 실제로 이렇게 동작):

- 양방향 규칙: 라벨 안에 R · AL · AN 글자가 있을 때만 봅니다. 첫 글자가 L이면 LTR 검사를 하는데, 마지막 글자 바로 앞까지만
  봅니다 (``i < last``). 그래서 ``aא.com``은 통과합니다 (명세대로면 실패).
  첫 글자가 L이 아니면 RTL 검사를 하는데, 첫 글자가 R · AL인지는 보지 않습니다 (``1א.com`` 통과).
- ContextJ: ZWNJ(U+200C)를 만나면 앞 글자가 virama면 그 자리에서 라벨 전체를 통과시키고, 아니면 앞쪽 어딘가의 L/D와
  뒤쪽 어딘가의 R/D만 보고 결론을 냅니다 (T 투명 글자 규칙 없음, 뒤의 양방향 검사도 건너뜀). ZWJ는 앞 글자가 virama여야 통과.
- ASCII만 있는 도메인은 소문자로만 바꾸고, ``xn--`` 라벨만 풀어서 검사합니다.

TS · Ada 대응:

| 함수 | Ada 3.4.2 (singleheader/ada.cpp) |
|---|---|
| ``idna_map`` | ``ada::idna::map`` (mapping.cpp) |
| ``nfc`` | ``ada::idna::normalize`` (normalization.cpp: decompose_nfc + compose) |
| ``is_label_valid`` | ``ada::idna::is_label_valid`` (validity.cpp) |
| ``punycode_to_utf32`` · ``utf32_to_punycode`` | punycode.cpp |
| ``to_ascii`` | ``ada::idna::to_ascii`` · ``from_ascii_to_ascii`` (to_ascii.cpp) |

Ada의 정규화 표는 머리에 "IDNA 17.0.0"이라고 적혀 있지만 실제 정규화 자료는 유니코드 15.1 수준입니다 (16.0에서 생긴
정준 결합 20개 · 새 결합 문자 46개의 ccc가 없음). URL 호스트는 Ada 그대로(``nfc``)여야 하고, 채팅의 ``normalize('NFC')``는
V8(ICU 78, 유니코드 17)이므로 ``nfc(..., v8=True)`` · ``nfc_v8_str``이 그 차이(``_V8_*`` 표)를 보충합니다.
Python 3.13 ``unicodedata``(15.1)는 쓰지 않습니다. 보충 표는 Node에서 뽑았고, 시험이 코드 포인트 전체 · 무작위 결합 문자열로 확인합니다.
"""

from __future__ import annotations

from bisect import bisect_right

from . import _ada_tables as T

__all__ = ["idna_map", "is_label_valid", "nfc", "nfc_str", "nfc_v8_str", "punycode_to_utf32", "to_ascii", "utf32_to_punycode"]

# ── 매핑 (UTS #46 표) ─────────────────────────────────────────────────

_TABLE_START = T.table_start
_TABLE_DESC = T.table_desc
_MAPPINGS = T.mappings


def _find_range_index(key: int) -> int:
    i = bisect_right(_TABLE_START, key) - 1
    return 0 if i < 0 else i


def idna_map(cps: list[int]) -> list[int] | None:
    """UTS #46 매핑. 금지 글자가 있으면 None (Ada는 빈 문자열을 돌려줍니다)."""
    out: list[int] = []
    for x in cps:
        desc = _TABLE_DESC[_find_range_index(x)]
        code = desc & 0xFF
        if code == 0:  # ignored
            continue
        if code == 1:  # valid
            out.append(x)
        elif code == 2:  # disallowed
            return None
        else:
            count = desc >> 24
            idx = (desc >> 8) & 0xFFFF
            out.extend(_MAPPINGS[idx : idx + count])
    return out


# ── NFC (Ada normalization.cpp) ──────────────────────────────────────

_S_BASE, _T_BASE, _V_BASE, _L_BASE = 0xAC00, 0x11A7, 0x1161, 0x1100
_L_COUNT, _V_COUNT, _T_COUNT = 19, 21, 28
_N_COUNT = _V_COUNT * _T_COUNT
_S_COUNT = _L_COUNT * _N_COUNT

_DECOMP_INDEX = T.decomposition_index
_DECOMP_BLOCK = T.decomposition_block
_DECOMP_DATA = T.decomposition_data
_CCC_INDEX = T.canonical_combining_class_index
_CCC_BLOCK = T.canonical_combining_class_block
_COMP_INDEX = T.composition_index
_COMP_BLOCK = T.composition_block
_COMP_DATA = T.composition_data

#: V8 보충 (유니코드 16 · 17): 새 결합 문자의 ccc
_V8_CCC: dict[int, int] = {
    0x0897: 230, 0x1ACF: 230, 0x1AD0: 230, 0x1AD1: 230, 0x1AD2: 230, 0x1AD3: 230, 0x1AD4: 230, 0x1AD5: 230,
    0x1AD6: 230, 0x1AD7: 230, 0x1AD8: 230, 0x1AD9: 230, 0x1ADA: 230, 0x1ADB: 230, 0x1ADC: 230, 0x1ADD: 220,
    0x1AE0: 230, 0x1AE1: 230, 0x1AE2: 230, 0x1AE3: 230, 0x1AE4: 230, 0x1AE5: 230, 0x1AE6: 220, 0x1AE7: 230,
    0x1AE8: 230, 0x1AE9: 230, 0x1AEA: 230, 0x1AEB: 234, 0x10D69: 230, 0x10D6A: 230, 0x10D6B: 230, 0x10D6C: 230,
    0x10D6D: 230, 0x10EFA: 220, 0x10EFB: 220, 0x113CE: 9, 0x113CF: 9, 0x113D0: 9, 0x1612F: 9, 0x1E5EE: 230,
    0x1E5EF: 220, 0x1E6E3: 230, 0x1E6E6: 230, 0x1E6EE: 230, 0x1E6EF: 230, 0x1E6F5: 230,
}
#: V8 보충: 유니코드 16의 새 정준 분해 (전체 분해)
_V8_DECOMP: dict[int, tuple[int, ...]] = {
    0x105C9: (0x105D2, 0x0307),
    0x105E4: (0x105DA, 0x0307),
    0x11383: (0x11382, 0x113C9),
    0x11385: (0x11384, 0x113BB),
    0x1138E: (0x1138B, 0x113C2),
    0x11391: (0x11390, 0x113C9),
    0x113C5: (0x113C2, 0x113C2),
    0x113C7: (0x113C2, 0x113B8),
    0x113C8: (0x113C2, 0x113C9),
    0x16121: (0x1611E, 0x1611E),
    0x16122: (0x1611E, 0x16129),
    0x16123: (0x1611E, 0x1611F),
    0x16124: (0x16129, 0x1611F),
    0x16125: (0x1611E, 0x16120),
    0x16126: (0x1611E, 0x1611E, 0x1611F),
    0x16127: (0x1611E, 0x16129, 0x1611F),
    0x16128: (0x1611E, 0x1611E, 0x16120),
    0x16D68: (0x16D67, 0x16D67),
    0x16D69: (0x16D63, 0x16D67),
    0x16D6A: (0x16D63, 0x16D67, 0x16D67),
}
#: V8 보충: 위 분해를 다시 합치는 짝 (앞 글자, 뒤 글자) → 결합 글자
_V8_COMP: dict[tuple[int, int], int] = {
    (0x105D2, 0x0307): 0x105C9,
    (0x105DA, 0x0307): 0x105E4,
    (0x11382, 0x113C9): 0x11383,
    (0x11384, 0x113BB): 0x11385,
    (0x1138B, 0x113C2): 0x1138E,
    (0x11390, 0x113C9): 0x11391,
    (0x113C2, 0x113C2): 0x113C5,
    (0x113C2, 0x113B8): 0x113C7,
    (0x113C2, 0x113C9): 0x113C8,
    (0x1611E, 0x1611E): 0x16121,
    (0x1611E, 0x16129): 0x16122,
    (0x1611E, 0x1611F): 0x16123,
    (0x16129, 0x1611F): 0x16124,
    (0x1611E, 0x16120): 0x16125,
    (0x16121, 0x1611F): 0x16126,
    (0x16122, 0x1611F): 0x16127,
    (0x16121, 0x16120): 0x16128,
    (0x16D67, 0x16D67): 0x16D68,
    (0x16D63, 0x16D67): 0x16D69,
    (0x16D69, 0x16D67): 0x16D6A,
}
_V8_COMP_FIRST = frozenset(a for a, _ in _V8_COMP)


def get_ccc(c: int) -> int:
    if c >= 0x110000:
        return 0
    return _CCC_BLOCK[_CCC_INDEX[c >> 8] * 256 + (c & 0xFF)]


def get_ccc_v8(c: int) -> int:
    v = _V8_CCC.get(c)
    return get_ccc(c) if v is None else v


def _decompose(cps: list[int], v8: bool = False) -> list[int]:
    out: list[int] = []
    for c in cps:
        if v8 and c in _V8_DECOMP:
            out.extend(_V8_DECOMP[c])
        elif _S_BASE <= c < _S_BASE + _S_COUNT:
            s = c - _S_BASE
            out.append(_L_BASE + s // _N_COUNT)
            out.append(_V_BASE + (s % _N_COUNT) // _T_COUNT)
            if s % _T_COUNT:
                out.append(_T_BASE + s % _T_COUNT)
        elif c < 0x110000:
            base = _DECOMP_INDEX[c >> 8] * 257 + (c & 0xFF)
            d0 = _DECOMP_BLOCK[base]
            d1 = _DECOMP_BLOCK[base + 1]
            length = (d1 >> 2) - (d0 >> 2)
            if length > 0 and (d0 & 1):  # 호환 분해는 NFC에서 쓰지 않음
                length = 0
            if length > 0:
                start = d0 >> 2
                out.extend(_DECOMP_DATA[start : start + length])
            else:
                out.append(c)
        else:
            out.append(c)
    return out


def _sort_marks(a: list[int], ccc_of=get_ccc) -> None:  # noqa: ANN001
    for idx in range(1, len(a)):
        ccc = ccc_of(a[idx])
        if ccc == 0:
            continue
        cur = a[idx]
        back = idx
        while back != 0 and ccc_of(a[back - 1]) > ccc:
            a[back] = a[back - 1]
            back -= 1
        a[back] = cur


def _comp_range(c: int) -> tuple[int, int]:
    base = _COMP_INDEX[c >> 8] * 257 + (c & 0xFF)
    return _COMP_BLOCK[base], _COMP_BLOCK[base + 1]


def _compose(a: list[int], v8: bool = False) -> list[int]:
    ccc_of = get_ccc_v8 if v8 else get_ccc
    n = len(a)
    ic = 0
    cc = 0
    while ic < n:
        a[cc] = a[ic]
        c = a[ic]
        if _L_BASE <= c < _L_BASE + _L_COUNT:
            if ic + 1 < n and _V_BASE <= a[ic + 1] < _V_BASE + _V_COUNT:
                a[cc] = _S_BASE + ((c - _L_BASE) * _V_COUNT + a[ic + 1] - _V_BASE) * _T_COUNT
                ic += 1
                if ic + 1 < n and _T_BASE < a[ic + 1] < _T_BASE + _T_COUNT:
                    ic += 1
                    a[cc] += a[ic] - _T_BASE
        elif _S_BASE <= c < _S_BASE + _S_COUNT:
            # Ada 그대로 (분해 뒤라 여기에 오는 일은 없습니다)
            if (c - _S_BASE) % _T_COUNT and ic + 1 < n and _T_BASE < a[ic + 1] < _T_BASE + _T_COUNT:
                ic += 1
                a[cc] += a[ic] - _T_BASE
        elif c < 0x110000:
            comp0, comp1 = _comp_range(c)
            initial = cc
            previous_ccc = -1
            while ic + 1 < n:
                nxt = a[ic + 1]
                ccc = ccc_of(nxt)
                if v8 and previous_ccc < ccc and a[initial] in _V8_COMP_FIRST and (a[initial], nxt) in _V8_COMP:
                    composite = _V8_COMP[(a[initial], nxt)]
                    a[initial] = composite
                    comp0, comp1 = _comp_range(composite)
                    ic += 1
                    continue
                if comp1 != comp0 and previous_ccc < ccc:
                    left, right = comp0, comp1
                    while left + 2 < right:
                        middle = left + (((right - left) >> 1) & ~1)
                        if _COMP_DATA[middle] <= nxt:
                            left = middle
                        if _COMP_DATA[middle] >= nxt:
                            right = middle
                    if _COMP_DATA[left] == nxt:
                        composite = _COMP_DATA[left + 1]
                        a[initial] = composite
                        comp0, comp1 = _comp_range(composite)
                        ic += 1
                        continue
                if ccc == 0:
                    break
                previous_ccc = ccc
                cc += 1
                a[cc] = nxt
                ic += 1
        ic += 1
        cc += 1
    return a[:cc]


def nfc(cps: list[int], v8: bool = False) -> list[int]:
    """Ada ``normalize``: 정준 분해 → 결합 문자 정렬 → 결합. ``v8=True``면 유니코드 16 · 17 보충 (V8 ``normalize``와 같게)."""
    a = _decompose(cps, v8)
    _sort_marks(a, get_ccc_v8 if v8 else get_ccc)
    return _compose(a, v8)


def nfc_str(s: str) -> str:
    """Ada(URL 파서)와 같은 NFC. ASCII는 그대로."""
    if s.isascii():
        return s
    return "".join(map(chr, nfc([ord(c) for c in s])))


def nfc_v8_str(s: str) -> str:
    """V8 ``s.normalize('NFC')``와 같은 NFC (유니코드 17). ASCII는 그대로."""
    if s.isascii():
        return s
    return "".join(map(chr, nfc([ord(c) for c in s], v8=True)))


# ── 라벨 검사 (Ada 3.4.2 validity.cpp, 버릇 포함) ─────────────────────

_DIR = {name: i for i, name in enumerate(T.DIRECTIONS)}
_D_L, _D_R, _D_AL, _D_AN, _D_EN, _D_NSM = _DIR["L"], _DIR["R"], _DIR["AL"], _DIR["AN"], _DIR["EN"], _DIR["NSM"]
_LTR_OK = frozenset(_DIR[k] for k in ("L", "EN", "ES", "CS", "ET", "ON", "BN", "NSM"))
_RTL_OK = frozenset(_DIR[k] for k in ("R", "AL", "AN", "EN", "ES", "CS", "ET", "ON", "BN", "NSM"))
_RTL_END = frozenset((_D_R, _D_AL, _D_AN, _D_EN))
_DIR_START = T.dir_start
_DIR_FINAL = T.dir_final
_DIR_VALUE = T.dir_value
_COMBINING = frozenset(T.combining)
_VIRAMA = frozenset(T.virama)
_JOIN_L_OR_D = frozenset(T.join_L) | frozenset(T.join_D)
_JOIN_R_OR_D = frozenset(T.join_R) | frozenset(T.join_D)


def _direction(c: int) -> int:
    # lower_bound(final >= c) 다음 start <= c 확인
    lo, hi = 0, len(_DIR_FINAL)
    while lo < hi:
        mid = (lo + hi) // 2
        if _DIR_FINAL[mid] < c:
            lo = mid + 1
        else:
            hi = mid
    if lo == len(_DIR_FINAL):
        return 0
    return _DIR_VALUE[lo] if c >= _DIR_START[lo] else 0


def is_label_valid(label: list[int]) -> bool:
    """Ada 3.4.2 ``is_label_valid`` (CheckHyphens=false, CheckJoiners · CheckBidi는 Ada 방식)."""
    if not label:
        return True
    if label[0] in _COMBINING:
        return False
    for i, c in enumerate(label):
        if c == 0x200C:
            if i > 0 and label[i - 1] in _VIRAMA:
                return True
            if i == 0 or i + 1 >= len(label):
                return False
            return any(x in _JOIN_L_OR_D for x in label[:i]) and any(x in _JOIN_R_OR_D for x in label[i + 1 :])
        if c == 0x200D:
            return i > 0 and label[i - 1] in _VIRAMA
    dirs = [_direction(c) for c in label]
    last = -1
    for i in range(len(dirs) - 1, -1, -1):
        if dirs[i] != _D_NSM:
            last = i
            break
    if last < 0:
        return False
    if not any(d in (_D_R, _D_AL, _D_AN) for d in dirs):
        return True
    if dirs[0] == _D_L:
        # Ada: i < last_non_nsm_char (마지막 글자는 보지 않음)
        return all(dirs[i] in _LTR_OK for i in range(last))
    has_an = has_en = False
    for i in range(last + 1):
        d = dirs[i]
        if d == _D_EN:
            has_en = True
            if has_an:
                return False
        elif d == _D_AN:
            has_an = True
            if has_en:
                return False
        if d not in _RTL_OK:
            return False
        if i == last and d not in _RTL_END:
            return False
    return True


# ── 퓨니코드 (Ada punycode.cpp) ───────────────────────────────────────

_BASE, _TMIN, _TMAX, _SKEW, _DAMP, _INITIAL_BIAS, _INITIAL_N = 36, 1, 26, 38, 700, 72, 128
_I32 = 0x7FFFFFFF


def _adapt(d: int, n: int, first: bool) -> int:
    d = d // _DAMP if first else d // 2
    d += d // n
    k = 0
    while d > ((_BASE - _TMIN) * _TMAX) // 2:
        d //= _BASE - _TMIN
        k += _BASE
    return k + (((_BASE - _TMIN + 1) * d) // (d + _SKEW))


def _digit(ch: str) -> int:
    if "a" <= ch <= "z":
        return ord(ch) - 97
    if "0" <= ch <= "9":
        return ord(ch) - 48 + 26
    return -1


def punycode_to_utf32(text: str) -> list[int] | None:
    """퓨니코드 풀기 (``xn--`` 뒤). 실패하면 None. 대문자 숫자 글자는 받지 않습니다 (매핑 뒤라 소문자)."""
    if text.startswith("xn--"):
        return None
    out: list[int] = []
    n = _INITIAL_N
    i = 0
    bias = _INITIAL_BIAS
    end = text.rfind("-")
    if end >= 0:
        for ch in text[:end]:
            if ord(ch) >= 0x80:
                return None
            out.append(ord(ch))
        text = text[end + 1 :]
    pos = 0
    while pos < len(text):
        oldi = i
        w = 1
        k = _BASE
        while True:
            if pos >= len(text):
                return None
            digit = _digit(text[pos])
            pos += 1
            if digit < 0:
                return None
            if digit > (_I32 - i) // w:
                return None
            i = i + digit * w
            t = _TMIN if k <= bias else _TMAX if k >= bias + _TMAX else k - bias
            if digit < t:
                break
            if w > _I32 // (_BASE - t):
                return None
            w = w * (_BASE - t)
            k += _BASE
        written = len(out)
        bias = _adapt(i - oldi, written + 1, oldi == 0)
        if i // (written + 1) > _I32 - n:
            return None
        n = n + i // (written + 1)
        i = i % (written + 1)
        if n < 0x80:
            return None
        out.insert(i, n)
        i += 1
    return out


def _digit_char(d: int) -> str:
    return chr(d + 97) if d < 26 else chr(d + 22)


def utf32_to_punycode(cps: list[int]) -> str | None:
    """퓨니코드 만들기 (``xn--`` 빼고). 서로게이트 · 0x10FFFF 초과는 None."""
    out: list[str] = []
    n = _INITIAL_N
    d = 0
    bias = _INITIAL_BIAS
    h = 0
    for c in cps:
        if c < 0x80:
            h += 1
            out.append(chr(c))
        if c > 0x10FFFF or 0xD800 <= c < 0xE000:
            return None
    b = h
    if b > 0:
        out.append("-")
    while h < len(cps):
        m = 0x10FFFF
        for c in cps:
            if n <= c < m:
                m = c
        if (m - n) > (_I32 - d) // (h + 1):
            return None
        d = d + (m - n) * (h + 1)
        n = m
        for c in cps:
            if c < n:
                if d == _I32:
                    return None
                d += 1
            if c == n:
                q = d
                k = _BASE
                while True:
                    t = _TMIN if k <= bias else _TMAX if k >= bias + _TMAX else k - bias
                    if q < t:
                        break
                    out.append(_digit_char(t + ((q - t) % (_BASE - t))))
                    q = (q - t) // (_BASE - t)
                    k += _BASE
                out.append(_digit_char(q))
                bias = _adapt(d, h + 1, h == b)
                d = 0
                h += 1
        d += 1
        n += 1
    return "".join(out)


# ── to_ascii ─────────────────────────────────────────────────────────


def _ascii_lower(s: str) -> str:
    return s.translate(_ASCII_LOWER)


_ASCII_LOWER = {c: c + 32 for c in range(65, 91)}


def _check_ace_label(puny: str) -> bool:
    """``xn--`` 라벨: 풀리고, ASCII만은 아니고, 매핑 · NFC로 바뀌지 않고, 라벨 규칙을 통과해야 합니다."""
    tmp = punycode_to_utf32(puny)
    if tmp is None:
        return False
    if all(c < 0x80 for c in tmp):
        return False
    post = idna_map(tmp)
    if post is None or post != tmp:
        return False
    if nfc(list(post)) != post:
        return False
    if not post:
        return False
    return is_label_valid(post)


def _from_ascii_to_ascii(s: str) -> str | None:
    mapped = _ascii_lower(s)
    for label in mapped.split("."):
        if label.startswith("xn--") and not _check_ace_label(label[4:]):
            return None
    return mapped


def to_ascii(domain: str) -> str | None:
    """Ada ``to_ascii``: 실패면 None (Ada는 빈 문자열). ``domain``은 퍼센트를 푼 뒤의 문자열입니다.

    짝 없는 서로게이트는 UTF-8로 바꿀 수 없어 Ada 입력에 올 수 없으므로 None으로 봅니다
    (WHATWG에서는 그 전에 U+FFFD가 되고, U+FFFD는 금지 글자라 결과가 같습니다).
    """
    if domain.isascii():
        out = _from_ascii_to_ascii(domain)
        return out if out else None
    cps = [ord(c) for c in domain]
    if not cps or any(0xD800 <= c <= 0xDFFF for c in cps):
        return None
    mapped = idna_map(cps)
    if not mapped:
        return None
    mapped = nfc(mapped)
    labels: list[list[int]] = [[]]
    for c in mapped:
        if c == 0x2E:
            labels.append([])
        else:
            labels[-1].append(c)
    # Ada는 끝이 '.'이면 마지막 빈 라벨을 따로 만들지 않고 그 '.'만 남깁니다 (결과 글자는 같음)
    parts: list[str] = []
    for label in labels:
        if not label:
            parts.append("")
        elif label[:4] == [0x78, 0x6E, 0x2D, 0x2D]:  # "xn--"
            if any(c >= 0x80 for c in label):
                return None
            text = "".join(map(chr, label))
            if not _check_ace_label(text[4:]):
                return None
            parts.append(text)
        elif all(c < 0x80 for c in label):
            parts.append("".join(map(chr, label)))
        else:
            if not is_label_valid(label):
                return None
            p = utf32_to_punycode(label)
            if p is None:
                return None
            parts.append("xn--" + p)
    out = ".".join(parts)
    return out if out else None
