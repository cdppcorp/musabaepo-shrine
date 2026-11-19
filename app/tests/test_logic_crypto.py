"""shrine.logic.crypto를 Node(security.ts · moderation.ts · admin.ts · registry.ts)와 양쪽으로 맞춰 봅니다.

Node가 서명 · 해시한 값을 Python이 검증하고, Python이 만든 값을 Node가 검증합니다 (고정 TICKET_SECRET · ADMIN_PASSWORD).
"""

from __future__ import annotations

import hmac
import random
import time

from node_ref.runner import ADMIN_PASSWORD, TICKET_SECRET, run

from shrine.logic import crypto as C
from shrine.logic.jsnum import json_stringify
from shrine.logic.jsstr import utf8_encode


def js(v: object) -> str | None:
    return json_stringify(v)


def test_lenient_base64url_decode_matches_node() -> None:
    rng = random.Random(51)
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_+/"
    junk = ["=", "==", " ", "\n", "\t", "!", ".", "é", "ÿ", "Ł", "Ľ", "Ā", "ī", "\U0001f600", "\x00", "%", "*"]
    inputs = ["", "=", "==", "a", "ab", "abc", "abcd", "abcde", "ab=", "ab==", "a=b", "YW=Jj", "YŁJj", "====", "a==", "ab\n=="]
    for _ in range(20000):
        n = rng.randint(0, 40)
        s = "".join(rng.choice(alphabet) if rng.random() < 0.85 else rng.choice(junk) for _ in range(n))
        inputs.append(s)
    for _ in range(2000):  # 올바른 값 뒤에 찌꺼기
        raw = bytes(rng.getrandbits(8) for _ in range(rng.randint(0, 40)))
        inputs.append(C.b64url(raw) + rng.choice(["", "!", "=", "==x", "A", " ", "Ł"]))
    node = run("base64", inputs=inputs)
    for s, want in zip(inputs, node, strict=True):
        assert C.node_base64_decode(s).hex() == want, ascii(s)


def make_ticket(**over: object) -> dict:
    t = {"sid": "6f1c2d1e-0a3b-4c5d-8e9f-0123456789ab", "look": [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3], "nick": "새벽의 러버덕 42",
         "exp": int(time.time() * 1000) + 3600_000}  # fmt: skip
    t.update(over)
    return t


def signed_body(text: str) -> str:
    """본문 글자를 그대로 base64url로 싸고 TICKET_SECRET으로 서명 (JSON이 아닌 본문도 만들 수 있게)."""
    body = C.b64url(utf8_encode(text))
    return body + "." + C.b64url(hmac.new(TICKET_SECRET.encode(), body.encode(), "sha256").digest())


def test_tickets_cross_sign_and_verify() -> None:
    now = int(time.time() * 1000)
    tickets = [make_ticket(), make_ticket(nick="🙏 무사한 고양이 10"), make_ticket(exp=now + 5), make_ticket(look=[5, 5, 5, 5, 15, 11, 8, 11, 4, 7, 5, 9])]
    node = run("tickets", sign=tickets, verify=[])
    py_signed = [C.sign_ticket(t, TICKET_SECRET) for t in tickets]
    assert node["signed"] == py_signed  # 같은 바이트
    good = py_signed[0]
    body, sig = good.split(".")
    variants: list[str | None] = [
        *py_signed, good + "!!", good + "=", good + "=x", good + "A", good + ".extra", body + "." + sig[:-1], body + "." + sig + sig,
        body[:-1] + "." + sig, "." + sig, body + ".", body, "", None, good + "x" * 600, "Ł" + good,
        signed_body(js(make_ticket(exp=now - 1000))), signed_body(js(make_ticket(look=[0] * 11))), signed_body(js(make_ticket(look=[6] + [0] * 11))),
        signed_body(js(make_ticket(look=[1.0] + [0] * 11))), signed_body('{"sid":"s","look":[0,0,0,0,0,0,0,0,0,0,0,0],"nick":"n","exp":1e400}'),
        signed_body('{"sid":"s","look":[0,0,0,0,0,0,0,0,0,0,0,true],"nick":"n","exp":9e15}'), signed_body("[1,2]"), signed_body("null"),
        signed_body('"str"'), signed_body("not json"), signed_body('{"sid":1,"look":[0,0,0,0,0,0,0,0,0,0,0,0],"nick":"n","exp":9e15}'),
        signed_body('{"sid":"s","look":[0,0,0,0,0,0,0,0,0,0,0,0],"nick":"n","exp":"9e15"}'),
        signed_body('{"sid":"s","look":[0,0,0,0,0,0,0,0,0,0,0,0],"nick":"n","exp":9e15,"extra":{"0":1,"b":2,"a":3}}'),
        signed_body('\ufeff{"sid":"s","look":[0,0,0,0,0,0,0,0,0,0,0,0],"nick":"n","exp":9e15}'),
        signed_body('{"sid":"s","look":[0,0,0,0,0,0,0,0,0,0,0,0],"nick":"\\ud800","exp":9e15}'),
        signed_body('{"sid":"s","look":[0,0,0,0,0,0,0,0,0,0,-0,0],"nick":"n","exp":9e15,"sid":"t"}'),
        C.sign_ticket(make_ticket(), "another-secret-of-thirty-two-chars!!"),
    ]  # fmt: skip
    cookies = ["shrine_ticket=" + (v or "") for v in variants[:5]] + [
        "a=1; shrine_ticket=x; b", " shrine_ticket = y ; shrine_ticket=z", "=v; k=", "__proto__=x; a=b", "a=b=c", ";;;", "\u3000a=b\u3000",
        "a\u0085=b", "",
    ]
    node = run("tickets", sign=[], verify=variants + cookies)
    for raw, want in zip(variants + cookies, node["verified"], strict=True):
        assert js(C.verify_ticket(raw, TICKET_SECRET)) == js(want), ascii(raw)
    for raw, want in zip(variants + cookies, node["cookies"], strict=True):
        assert C.parse_cookies(raw) == want, ascii(raw)


IPS = [
    "1.2.3.4", " 1.2.3.4 ", "001.2.3.4", "1.2.3", "256.1.1.1", "::ffff:1.2.3.4", "::FFFF:1.2.3.4", "[::ffff:1.2.3.4]", "::ffff:256.1.1.1",
    "::ffff:1.2.3", "::1", "[::1]", " [::1] ", "::", "1::", "::1:2", "2001:db8::1", "2001:DB8:0:0:8:800:200C:417A", "2001:db8:1:2:3:4:5:6",
    "2001:0db8:0001:0002::", "fe80::1%eth0", "fe80::1%25eth0", "%eth0", "fe80::1%", "64:ff9b::1.2.3.4", "1:2:3:4:5:6:1.2.3.4",
    "::1.2.3.4", "1::2:3:4:5:6:7", "1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8:9", "abcd::12345", "x", "", "unknown", "1.2.3.4\n", "::1\n",
    "İ.1.1.1", "K::1", "２.２.２.２", "1.2.3.4%x", "[1.2.3.4]", "[::1", "::1]", "0000:0000::0001", "1:0:0:0:0:0:0:1",
    "a:b:c:d:e:f:1.2.3.4", "::ffff:0:1.2.3.4", "\ud800", "😀",
]  # fmt: skip


def test_daily_ip_hash_with_fixed_salt_matches_node() -> None:
    salt = bytes(range(16))
    node = run("ipHash", salt=salt.hex(), ips=IPS)
    hasher = C.DailyIpHasher(salt_for_day=lambda day: salt)
    assert [hasher(ip) for ip in IPS] == node
    assert [C.ip_hash_with_salt(salt, ip) for ip in IPS] == node


def test_block_keys_match_node() -> None:
    node = run("blockKeys", ips=IPS)
    km = C.ip_key_mac(TICKET_SECRET)
    for ip, want in zip(IPS, node, strict=True):
        assert C.normalize_ip(ip) == want["n"], ascii(ip)
        assert C.block_key(ip, key_mac=km) == want["k"], ascii(ip)
        assert C.block_key(ip, TICKET_SECRET) == want["k"]
        if want["k"]:
            assert C.KEY_RE.fullmatch(want["k"])


def test_admin_keys_sessions_and_cookies_cross_check() -> None:
    keys = C.admin_keys(TICKET_SECRET, ADMIN_PASSWORD)
    now = int(time.time() * 1000)
    sid = "AbCdEfGhIjKlMnOpQrStUvWx"
    sessions = [{"sid": sid, "iat": now, "exp": now + C.SESSION_MS}, C.new_session(now), {"sid": sid, "iat": 1, "exp": 2}]
    node0 = run("admin", sessions=sessions, raws=[], ips=[], passwords=[], hosts=[])
    assert node0["enabled"] is True
    assert node0["keys"] == {"pw": keys.pw_digest.hex(), "session": keys.session_key.hex(), "log": keys.log_key.hex()}
    assert node0["signed"] == [C.sign_session(s, keys) for s in sessions]

    def raw_session(obj: dict | str) -> str:
        text = obj if isinstance(obj, str) else js(obj)
        body = C.b64url(utf8_encode(text))
        return body + "." + C.b64url(hmac.new(keys.session_key, body.encode(), "sha256").digest())

    good = C.sign_session(sessions[0], keys)
    raws: list[str | None] = [
        good, C.sign_session(sessions[1], keys), C.sign_session(sessions[2], keys), good + "!", good + "=x", good + ".x", "x" * 401, None, "",
        raw_session({"k": "admin", "sid": sid, "iat": now, "exp": now + C.SESSION_MS + 1}),
        raw_session({"k": "admin", "sid": sid, "iat": now + 61_000, "exp": now + 70_000}),
        raw_session({"k": "admin", "sid": sid, "iat": now + 59_000, "exp": now + 70_000}),
        raw_session({"k": "admin", "sid": sid, "iat": now, "exp": now}), raw_session({"k": "user", "sid": sid, "iat": now, "exp": now + 1000}),
        raw_session({"k": "admin", "sid": sid + "x", "iat": now, "exp": now + 1000}), raw_session({"k": "admin", "sid": sid, "iat": "1", "exp": now + 1000}),
        raw_session({"k": "admin", "sid": "abc+defghijklmnopqrstuvw", "iat": now, "exp": now + 1000}), raw_session("[]"), raw_session("nope"),
        raw_session('{"k":"admin","sid":"AbCdEfGhIjKlMnOpQrStUvWx","iat":1e400,"exp":1e400}'),
        raw_session('{"k":"admin","sid":"AbCdEfGhIjKlMnOpQrStUvWx","iat":-1e400,"exp":1e400}'),
        C.sign_session(sessions[0], C.admin_keys(TICKET_SECRET, ADMIN_PASSWORD + "x")),
    ]  # fmt: skip
    passwords = [ADMIN_PASSWORD, ADMIN_PASSWORD + " ", "", None, 5, "x" * 1025, ADMIN_PASSWORD.upper()]
    hosts = ["localhost", "localhost:3300", "LOCALHOST", "a.localhost", "127.0.0.1", "127.0.0.1:80", "[::1]", "[::1]:443", "::1", "example.com",
             "localhost.", "127.0.0.2", None, "", "xlocalhost"]  # fmt: skip
    node = run("admin", sessions=[], raws=raws, ips=IPS, passwords=passwords, hosts=hosts)
    for raw, want in zip(raws, node["read"], strict=True):
        assert js(C.read_session(raw, keys)) == js(want), ascii(raw)
    for ip, h, n in zip(IPS, node["ipHash"], node["normIp"], strict=True):
        assert C.norm_admin_ip(ip) == n and C.admin_ip_hash(ip, keys) == h, ascii(ip)
    for pw, want in zip(passwords, node["password"], strict=True):
        assert C.admin_password_ok(pw, keys) is want, pw
    for h, cookie, loop in zip(hosts, node["cookie"], node["loopback"], strict=True):
        assert C.session_cookie(h, "v", 28800) == cookie and C.is_loopback_host(h) is loop, h
    # 로그아웃 목록
    assert C.read_session(good, keys, revoked={sid}) is None


def test_pin_hash_cross_check() -> None:
    py_hash = C.hash_pin("1234")
    node = run("pins", hash=["1234", "000000", "999999999999"], check=[["1234", py_hash], ["1235", py_hash]])
    assert node["matches"] == [True, False]
    n1234, n000000, n12 = node["hashed"]
    assert C.pin_matches("1234", n1234) and not C.pin_matches("12345", n1234)
    assert C.pin_matches("000000", n000000) and C.pin_matches("999999999999", n12)
    salt_text = n1234.split(":")[0]
    odd = [n1234 + ":extra", n1234 + "!!", salt_text + ":!!", ":" + n1234.split(":")[1], salt_text + ":", "nocolon", "", salt_text + ":AAAA"]
    node2 = run("pins", hash=[], check=[["1234", s] for s in odd])
    assert [C.pin_matches("1234", s) for s in odd] == node2["matches"]
    # 저장 모양: base64url(salt16) ':' base64url(32바이트)
    salt, h = py_hash.split(":")
    assert len(salt) == 22 and len(h) == 43
    assert C.hash_pin("1234", bytes(16)) == C.hash_pin("1234", bytes(16))
