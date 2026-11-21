"""업로드 형식 판별 · 메타데이터 지우기 · 알림 글자를 Node(server/uploads.ts · notify.ts)와 바이트까지 맞춰 봅니다.

같은 입력(만든 이미지 + 깨진 변형 + 무작위 변형, 시드 고정)을 예전 tests/p2b_ref.mjs(골든)와 shrine.uploads에 넣어
sniffImage 결과 · 세 형식별 stripMetadata 결과 · saveUpload 검사(까닭 또는 깨끗한 바이트)가 모두 같아야 합니다.
기준값은 tests/data/golden의 Node 골든(git 기록 a2b1bf6까지의 Node 서버에서 뽑음)입니다.
"""

from __future__ import annotations

import json
import random
import struct


from golden import golden

from _p2b_util import jpeg, png, png_chunk, riff_chunk, seg, webp
from shrine import notify, uploads
from shrine.logic.jsstr import canonical

def node_ref(payload: dict):
    """예전 tests/p2b_ref.mjs(server/uploads.ts · notify.ts)의 결과."""
    return golden("p2b", payload)


def corpus() -> list[bytes]:
    rnd = random.Random(20261119)
    base = [
        png(64, 36),
        png(40, 30, [png_chunk("tEXt", b"Comment\0PNG-TEXT-SECRET"), png_chunk("eXIf", b"MM\0*PNG-EXIF-SECRET")]),
        png(20, 20, [png_chunk("iTXt", b"x"), png_chunk("zTXt", b"y"), png_chunk("tIME", b"\x07\xe8\x01\x01\0\0\0"),
                     png_chunk("gAMA", b"\0\0\xb1\x8f")], tail=b"TRAILING-AFTER-IEND"),  # fmt: skip
        png(16, 16, [png_chunk("t3Xt", b"bad type")]),
        png(8000, 8000)[:40] + png_chunk("IEND", b""),
        png(8001, 20)[:33] + png_chunk("IEND", b""),
        png(15, 15),
        jpeg(64, 48),
        jpeg(32, 32, [seg(0xE0, b"JFIF\0"), seg(0xE2, b"ICC_PROFILE\0"), seg(0xED, b"Photoshop 3.0\0IPTC"), seg(0xEE, b"Adobe"),
                      seg(0xE1, b"http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>"), seg(0xFE, b"c")]),  # fmt: skip
        jpeg(100, 20, sof=0xC2),
        jpeg(100, 20, sof=0xC4),
        b"\xff\xd8\xff\xff\xff" + jpeg(48, 48)[2:],
        jpeg(48, 48)[:2] + b"\xff\xd0" + jpeg(48, 48)[2:],
        jpeg(48, 48)[:2] + bytes([0xFF, 0xE5, 0x00, 0x01]) + jpeg(48, 48)[2:],
        jpeg(48, 48)[:60],
        b"\xff\xd8" + seg(0xE0, b"JFIF") + seg(0xC0, bytes([8]) + struct.pack(">HH", 20, 20) + bytes([1, 1, 0x11, 0])),
        jpeg(20, 9000),
        webp(50, 40),
        webp(50, 40, [riff_chunk("VP8L", bytes([0x2F, 0, 0, 0, 0])), riff_chunk("XMP ", b"<x/>"), riff_chunk("EXIF", b"odd")], flags=0x0C),
        webp(16, 16, [riff_chunk("ALPH", b"\x01\x02\x03"), riff_chunk("VP8 ", bytes(10))]),
        b"RIFF" + struct.pack("<I", 4 + 8 + 5) + b"WEBP" + riff_chunk("VP8L", bytes([0x2F, 0x3F, 0x00, 0x00, 0x00])),
        b"RIFF" + struct.pack("<I", 4 + 18) + b"WEBP" + b"VP8 " + struct.pack("<I", 10) + bytes([0, 0, 0, 0x9D, 1, 0x2A, 64, 0, 48, 0]),
        b"RIFF" + struct.pack("<I", 9999) + b"WEBP" + riff_chunk("VP8L", bytes([0x2F, 0, 0, 0, 0])) + b"junk" * 6,
        b"RIFF" + struct.pack("<I", 4 + 8) + b"WEBP" + riff_chunk("VP8X", bytes(4)) + bytes(20),
        bytes(x | 0x80 for x in b"RIFF") + webp(30, 30)[4:8] + bytes(x | 0x80 for x in b"WEBP") + webp(30, 30)[12:],
        webp(30, 30)[:8] + b"WEBP" + riff_chunk("EXIF", b"only exif") + bytes(20),
        b"", b"\x89PNG", b"GIF89a" + bytes(40), b"<svg xmlns='http://www.w3.org/2000/svg'></svg>", bytes(64),
    ]
    out = list(base)
    for b in base:
        if not b:
            continue
        for _ in range(12):
            m = bytearray(b)
            op = rnd.randrange(4)
            if op == 0:
                for _ in range(rnd.randrange(1, 4)):
                    m[rnd.randrange(len(m))] = rnd.randrange(256)
            elif op == 1:
                m = m[: rnd.randrange(len(m))]
            elif op == 2:
                i = rnd.randrange(len(m) + 1)
                m[i:i] = bytes(rnd.randrange(256) for _ in range(rnd.randrange(1, 9)))
            else:
                i = rnd.randrange(len(m))
                m[i : i + 4] = struct.pack(">I", rnd.choice([0, 1, 0x7FFFFFFF, 0x80000000, 0xFFFFFFFF, len(m)]))
            out.append(bytes(m))
    for _ in range(60):
        out.append(bytes(rnd.randrange(256) for _ in range(rnd.randrange(0, 80))))
    return out


def _jpeg_intended(py: dict, node: dict) -> bool:
    """보안 점검: JPEG 지우기만 Node와 일부러 다릅니다 (uploads._strip_jpeg). Node는 첫 SOS부터 끝까지 그대로 두고,
    Python은 그 뒤의 APPn · COM과 EOI 뒤 꼬리를 더 빼거나(첫 SOS까지는 같은 바이트, 더 짧고 EOI로 끝남)
    SOS 뒤 구조가 깨졌거나 EOI가 없으면 받지 않습니다(None → 'type'). 그 밖(PNG · WebP · 형식 판별)은 같아야 합니다."""
    if py["sniff"] != node["sniff"]:
        return False
    if any(py["strip"][k] != node["strip"][k] for k in ("png", "webp")):
        return False
    p, w = py["strip"]["jpg"], node["strip"]["jpg"]
    if p != w:
        if w is None:
            return False
        if p is not None:
            pb, wb = bytes.fromhex(p), bytes.fromhex(w)
            k = max(wb.find(b"\xff\xda"), 2)
            if pb[:k] != wb[:k] or len(pb) >= len(wb) or not pb.endswith(b"\xff\xd9"):
                return False
    pc, wc = py["clean"], node["clean"]
    if pc == wc:
        return True
    if not (isinstance(wc, dict) and wc["ext"] == "jpg"):
        return False
    return pc == "type" if p is None else pc == {"ext": "jpg", "hex": p}


def py_side(b: bytes) -> dict:
    try:
        s = uploads.sniff_image(b)
        sniff = None if s is None else {"ext": s[0], "w": s[1], "h": s[2]}
    except Exception:  # noqa: BLE001
        sniff = "throw"
    strip = {}
    for ext in ("png", "jpg", "webp"):
        c = uploads.strip_metadata(b, ext)
        strip[ext] = None if c is None else c.hex()
    c = uploads.clean_image(b)
    clean = c if isinstance(c, str) else {"ext": c[0], "hex": c[1].hex()}
    return {"sniff": sniff, "strip": strip, "clean": clean}


def test_images_byte_identical_with_node():
    cases = corpus()
    want = node_ref({"op": "images", "cases": [b.hex() for b in cases]})
    assert len(want) == len(cases)
    mismatches = [
        (i, cases[i][:24].hex(), py_side(b), w)
        for i, (b, w) in enumerate(zip(cases, want))
        if py_side(b) != w and not _jpeg_intended(py_side(b), w)
    ]
    assert not mismatches, mismatches[:3]
    # 시험이 정말 여러 갈래를 지나는지
    kinds = {json.dumps(w["clean"], sort_keys=True)[:12] for w in want}
    assert any(isinstance(w["clean"], dict) for w in want) and {"bad", "type"} <= {w["clean"] for w in want if isinstance(w["clean"], str)}
    assert len(kinds) > 3


def test_notify_text_identical_with_node():
    long_value = "가" * 250 + "😀" * 3
    cases = [
        ["새 접수", {"접수": 3, "이름": "데모", "링크": "https://x.dev", "이미지": "있음"}, 0],
        ["시험 @everyone", {"email": "x@y.com", "pin": "999999", "ipKey": "abc", "메모": "연락 a.b@c.org <!channel> @here", "수": 3}, 2],
        ["e" * 70, {"Ip_Hash": "h", "sid": "s", "SID": "s2", "ip": 1, "pinKey": 2, "ticketX": 3, "PASSWORD": 4, "e-mail": 5,
                    "ſecret": "long s stays", "Key": "kelvin", "긴 값": long_value, "줄\n바꿈\x01": "제어\x00문자\u007f",
                    "2": "숫자 키", "1": 1.5, "big": 1e21, "small": 1.5e-7, "bool": True, "none": None, "list": [1, None, "a"]}, 0],  # fmt: skip
        ["많이", {f"키{i}": "값" * 199 + "😀" for i in range(12)}, 0],
    ]
    want = node_ref({"op": "notify", "cases": cases})
    got = [notify.build_text(e, f, s) for e, f, s in cases]
    assert [canonical(x) for x in got] == [canonical(x) for x in want]


async def test_notifier_cap_and_drain():
    """분당 20개: 넘으면 버리고 다음 알림에 개수를 붙임. 주소가 없으면 아무것도 안 함. 닿지 않는 주소도 예외 없이 끝남."""
    n = notify.Notifier("")
    n.notify("꺼짐", {"a": 1})
    assert not n._pending
    sent: list[bytes] = []

    async def fake_send(url, body):
        sent.append(body)

    n = notify.Notifier("http://127.0.0.1:1/x")
    n._send = fake_send  # type: ignore[method-assign]
    for i in range(23):
        n.notify(f"e{i}", {"i": i})
    await n.drain()
    assert len(sent) == 20
    n._window_start -= 61_000
    n.notify("다음", {})
    await n.drain()
    assert "(앞서 알림 3건을 상한 때문에 건너뜀)" in json.loads(sent[-1])["text"]
    real = notify.Notifier("http://127.0.0.1:1/x")
    real.notify("닿지 않음", {"a": 1})
    await real.drain()
