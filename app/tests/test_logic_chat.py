"""shrine.logic.chat를 예전 Node server/chat.ts(+ registry.ts · ops.ts)와 맞춰 봅니다. 기준값은 tests/data/golden의 Node 골든(git 기록 a2b1bf6까지의 Node 서버에서 뽑음)입니다.

- tests/data/chat_corpus.json (손으로 고른 384개: 한글 · 자모 · 이모지 · ZWJ · 보이지 않는 글자 · 방향 글자 · 제어 문자 · 링크 ·
  이메일 · 전화번호 · 금칙어 · 길이 · 서로게이트 · 문자열이 아닌 값)
- 무작위 조합 4000개
- 코드 포인트 전체: ``[\\p{Cc}\\p{Cf}]`` · ``[\\s\\p{P}\\p{S}]`` 집합, 한 글자 NFC, 결합 문자 섞인 문자열 NFC
"""

from __future__ import annotations

import json
import random
from pathlib import Path

import pytest
from golden import run

from shrine.logic.ada_idna import _V8_CCC
from shrine.logic.chat import (
    _SPACE_PUNCT_SYMBOL,
    CHAT_MAX,
    INVISIBLE,
    LONE_SURROGATE,
    OpError,
    clean_chat,
    clean_op_text,
    clean_sign,
    clean_text,
    js_normalize_nfc,
)
from shrine.logic.jsstr import canonical, js_lower

CORPUS = json.loads((Path(__file__).parent / "data" / "chat_corpus.json").read_text(encoding="ascii"))


def _node_comparable(v) -> bool:  # noqa: ANN001
    """보안 점검: 짝 없는 서로게이트는 일부러 Node와 다르게 지웁니다 (logic/chat.py LONE_SURROGATE).
    Node와 맞춰 볼 때는 빼고 test_sec_http.py에서 따로 봅니다."""
    return not (isinstance(v, str) and LONE_SURROGATE.search(canonical(v)))


def check(inputs: list[list]) -> None:
    inputs = [x for x in inputs if _node_comparable(x[0])]
    node = run("chat", inputs=inputs)
    assert node["max"] == CHAT_MAX
    bad = []
    for (v, mx), want in zip(inputs, node["out"], strict=True):
        got = clean_chat(v) if mx is None else clean_chat(v, mx)
        if got != want:
            bad.append((v, mx, got, want))
    assert not bad, bad[:10]


def test_corpus_matches_node() -> None:
    assert len(CORPUS) >= 300
    check(CORPUS)


PIECES = [
    "가", "나", "시", "발", "ㅅ", "ㅂ", "a", "B", "f", "u", "c", "k", "s", "e", "x", "1", "0", " ", "  ", ".", "-", "_", "@", "!", "?",
    "com", "net", "kr", "io", "www", "http", "https:", ":", "/", "닷컴", "카톡", "연락", "처", "dm", "주세요", "😀", "👨\u200d👩\u200d👧",
    "\u200b", "\u200d", "\u00ad", "\u202e", "\ufeff", "\u3000", "\u00a0", "\u2028", "\t", "\n", "\x00", "\x1c", "\x85", "\u0301",
    "ᄀ", "ᅡ", "ᆨ", "\ud800", "\udc00", "\U0001f3fb", "\ufe0f", "\u20c1", "\U0001cc00", "ſ", "K",
    "fuck", "sex", "porn", "병신", "바카라", "010", "1234", "5678", "．", "。",
]  # fmt: skip


def test_random_combinations_match_node() -> None:
    rng = random.Random(11)
    inputs: list[list] = []
    for _ in range(4000):
        s = "".join(rng.choice(PIECES) for _ in range(rng.randint(1, 12)))
        inputs.append([s, rng.choice([None, None, None, 8, 20, 3])])
    check(inputs)


@pytest.fixture(scope="module")
def sweep() -> dict:
    return run("chatSweep", timeout=600)


def _cps(pred) -> list[int]:  # noqa: ANN001
    return [cp for cp in range(0x110000) if pred(chr(cp))]


def test_invisible_set_equals_v8(sweep: dict) -> None:
    assert _cps(lambda c: INVISIBLE.fullmatch(c) is not None) == sweep["invisible"]


def test_space_punct_symbol_set_equals_v8(sweep: dict) -> None:
    assert _cps(lambda c: _SPACE_PUNCT_SYMBOL.fullmatch(c) is not None) == sweep["spaceSymbol"]


def test_single_code_point_nfc_equals_v8(sweep: dict) -> None:
    node = dict((cp, s) for cp, s in sweep["nfc"])
    mine = {}
    for cp in range(0x110000):
        if 0xD800 <= cp <= 0xDFFF:
            continue
        n = js_normalize_nfc(chr(cp))
        if n != chr(cp):
            mine[cp] = n
    assert mine == node


def test_single_code_point_lowercase_equals_v8(sweep: dict) -> None:
    """``js_lower``(Python lower + 유니코드 16 · 17 보충)가 V8 ``toLowerCase``와 코드 포인트 전체에서 같아야 합니다."""
    node = dict((cp, low) for cp, low in sweep["lower"])
    bad = [hex(cp) for cp in range(0x110000) if not (0xD800 <= cp <= 0xDFFF) and js_lower(chr(cp)) != node.get(cp, chr(cp))]
    assert not bad, bad[:20]


def test_nfc_of_mixed_sequences_equals_v8(sweep: dict) -> None:
    rng = random.Random(5)
    marks = [cp for cp in range(0x300, 0x370)] + [0x1DC0, 0x20D0, 0x302A, 0x3099, 0x309A, 0x05B0, 0x0E38, 0x0F71, 0x0F72, 0x0F74]
    marks += [0x16D67, 0x16D68, 0x1611E, 0x1611F, 0x11367, 0x113B8, 0x113C2, 0x113C9, 0x0B3E, 0x0CD5, 0x0D3E, 0x0DCF, 0x1D165, 0x1D16E]
    marks += sorted(_V8_CCC)
    starters = sorted({cp for cp, _ in sweep["nfc"]} | {ord(c) for c in "AEIOUaeiouCNSZ가각"} | {0x1100, 0x1161, 0x11A8, 0xAC00, 0xAC01})
    starters = [cp for cp in starters if cp < 0x10000 or rng.random() < 0.5]
    pool = marks * 3 + starters + [0x1112, 0x1161, 0x11AB, 0x11A7, 0x11C2, 0x11C3, 0x0B47, 0x0B56, 0x0BC6, 0x0BD7, 0x16D63, 0x16121]
    inputs = ["".join(chr(rng.choice(pool)) for _ in range(rng.randint(1, 8))) for _ in range(20000)]
    node = run("normalize", inputs=inputs)
    bad = [(s, js_normalize_nfc(s), want) for s, want in zip(inputs, node, strict=True) if js_normalize_nfc(s) != want]
    assert not bad, [(ascii(a), ascii(b), ascii(c)) for a, b, c in bad[:5]]


def test_registry_text_and_sign_match_node() -> None:
    rng = random.Random(13)
    inputs = []
    for v, _mx in CORPUS[:200]:
        inputs.append([v, rng.choice([8, 20, 40]), rng.choice(["name", "tagline", "sign"]), rng.choice(["한 줄 소개입니다 길어요", " 짧음 ", "😀😀😀😀😀😀😀😀😀😀", "a b c d e f g h i"])])
    inputs += [[None, 8, "sign", "가나다라마바사아자차"], ["   ", 8, "sign", "  앞뒤 공백 있는 소개  "], ["", 8, "sign", "e\u0301" * 10]]
    inputs = [x for x in inputs if _node_comparable(x[0])]  # 보안 점검: 서로게이트 (위 _node_comparable)
    node = run("regText", inputs=inputs)
    for (raw, mx, field, tagline), want in zip(inputs, node, strict=True):
        assert clean_text(raw, mx, field) == want["text"], (raw, mx, field)
        assert clean_sign(raw, tagline) == want["sign"], (raw, tagline)


def test_op_text_matches_node() -> None:
    inputs = [[v, mx, "사유", opt] for v, _ in CORPUS[::3] for mx, opt in ((80, True), (8, False))]
    inputs += [[None, 5, "이름", False], [None, 5, "이름", True], [5, 5, "x", True], ["  ", 3, "메모", True], ["abcd", 3.5, "메모", True]]
    inputs = [x for x in inputs if _node_comparable(x[0])]  # 보안 점검: 서로게이트 (위 _node_comparable)
    node = run("opText", inputs=inputs)
    for (raw, mx, label, opt), want in zip(inputs, node, strict=True):
        try:
            got = {"ok": True, "text": clean_op_text(raw, mx, label, opt)}
        except OpError as e:
            got = {"ok": False, "message": str(e)}
        assert got == want, (raw, mx, label, opt)


def test_combining_class_order_of_every_mark_equals_v8() -> None:
    """모든 결합 문자(\\p{M})를 ccc가 다른 기준 문자 30개 앞뒤에 붙여 NFC: 정렬 순서(ccc)가 V8과 같아야 합니다."""
    import regex

    refs = [0x0334, 0x093C, 0x094D, 0x05B0, 0x05B1, 0x05B9, 0x05BC, 0x064B, 0x0670, 0x0711, 0x0C55, 0x0E38, 0x0E48, 0x0EB8, 0x0F71,
            0x0F72, 0x0F74, 0x0321, 0x0327, 0x031B, 0x0316, 0x0301, 0x035C, 0x035D, 0x0345, 0x1DCE, 0x1DFA, 0x302A, 0x302E, 0x3099]  # fmt: skip
    is_mark = regex.compile(r"\p{M}")
    marks = [cp for cp in range(0x110000) if not (0xD800 <= cp <= 0xDFFF) and is_mark.match(chr(cp))]
    inputs = [f"a{chr(r)}{chr(m)}" for m in marks for r in refs] + [f"a{chr(m)}{chr(r)}" for m in marks for r in refs[::3]]
    node = run("normalize", inputs=inputs, timeout=600)
    bad = [ascii(s) for s, want in zip(inputs, node, strict=True) if js_normalize_nfc(s) != want]
    assert not bad, bad[:10]
