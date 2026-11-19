"""shrine.whatwg · shrine.jscompat를 Node(`new URL` · net.isIP · JSON.stringify)와 맞춰 봅니다. node가 없으면 건너뜁니다."""

from __future__ import annotations

import json
import shutil
import subprocess

import pytest

from shrine.jscompat import is_ip, js_json
from shrine.whatwg import InvalidURL, parse_http_url, request_pathname

NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="node가 없어 Node 결과와 맞춰 볼 수 없습니다")


def run_node(script: str, data) -> list:
    out = subprocess.run(
        [NODE, "-e", script],
        input=json.dumps(data).encode("utf-8"),
        capture_output=True,
        check=True,
        timeout=30,
    )
    return json.loads(out.stdout.decode("utf-8"))


READ_STDIN = "const inp = JSON.parse(require('fs').readFileSync(0, 'utf8'));"

PATHS = [
    "/", "/a/../b", "/%2e%2e/x", "/a/%2E%2e/b", "/a/.%2e", "/a/.", "/a/./b", "/a\\b", "\\x/y", "//evil.com/x",
    "//evil.com", "///", "//", "/a b", "/a^b", "/a`b", "/a{b}", '/a"b', "/a<b>", "/a|b", "/a'b",
    "/\u00c3\u00a9", "/%zz", "/a//b", "/..", "/../..", "/a/..", "//u:p@h:80/x", "//h:99999/x", "//h:abc/x",
    "//a b/x", "//[::1]/x", "//h%41/x", "*", "abc", "/a\tb", "/a\x7fb", "/a\x01b", "//h/x/../y",
    "//xn--a/x", "//h%2fx/y", "//1.2.3.4.5/x", "//0x7f.1/x", "//h:/x", "/js/%2e%2e/style.css",
    "/shrine//evil.com", "/shrine/\\evil.com", "/img/a/.png", "/%2E/x", "/a/%2e", " /x ", "/x\x00y",
    "//@h/x", "//u@/x", "//[::ffff:1.2.3.4]/x", "//[0::1]/x", "//[1::2::3]/x", "//h:65535/x", "//h:65536/x",
    "/\u00ff\u0080", "/a?b/../c", "/a#b", "//h?x/y", "/api/%77orld", "/.well-known/security.txt",
    "//EXAMPLE.com/X", "//a..b/x", "//.a/x", "//a_b/x", "//a*b/x", "//09/x", "//08.1/x", "//4294967295/x",
    "//4294967296/x", "//1.2.3/x", "//[::1]x/y", "//[::1/x",
]


def test_request_pathname_matches_node():
    script = READ_STDIN + """
const out = inp.map(i => { try { return new URL(i, 'http://local').pathname } catch (e) { return null } });
process.stdout.write(JSON.stringify(out));
"""
    expected = run_node(script, PATHS)
    got = []
    for p in PATHS:
        try:
            got.append(request_pathname(p))
        except InvalidURL:
            got.append(None)
    diffs = [(p, e, g) for p, e, g in zip(PATHS, expected, got) if e != g]
    assert not diffs


ORIGINS = [
    "https://shrine.example.com", "http://localhost:3300", "https://EXAMPLE.com", "https://example.com:443",
    "https://example.com:8443", "https://example.com/", "https://example.com/x", "https://u@example.com",
    "ftp://example.com", "example.com", "https://", "https://[::1]", "https://[0::1]", "https://1.2.3.4",
    "https://01.2.3.4", "https://1.2.3", "https://a..b", "https://a_b.com", "https://xn--a.com",
    "https://xn--bcher-kva.example", "https://bücher.example", "https://foo.123", "https://example.com.",
    "http:example.com", "https://example.com:0443", "https://example.com:", "HTTPS://Example.COM",
    "https://ex%41mple.com", "https://a b.com", "https:\\\\example.com", "https://example.com?x",
    "https://example.com#x", "https://[::ffff:1.2.3.4]", "https://0x7f.1", "https://exa\tmple.com",
]


def test_parse_http_url_matches_node():
    script = READ_STDIN + """
const out = inp.map(i => {
  try {
    const u = new URL(i)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return [u.origin, u.hostname, u.host, u.pathname]
  } catch (e) { return null }
});
process.stdout.write(JSON.stringify(out));
"""
    expected = run_node(script, ORIGINS)
    got = []
    for o in ORIGINS:
        u = parse_http_url(o)
        got.append(None if u is None else [u.origin, u.hostname, u.host, u.pathname])
    diffs = [(o, e, g) for o, e, g in zip(ORIGINS, expected, got) if e != g]
    assert not diffs


IPS = [
    "1.2.3.4", "1.2.3.04", "256.1.1.1", "::1", "::", "::ffff:1.2.3.4", "fe80::1%eth0", "fe80::1%", "1::2::3",
    "1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8:9", "abc", "", " 1.2.3.4", "1.2.3.4 ", "[::1]", "2001:db8::", "::1.2.3.4",
    "1:2:3:4:5:6:1.2.3.4", "FFFF::", "0.0.0.0", "127.0.0.1", "1.2.3", "a:b:c:d::/64",
]


def test_is_ip_matches_node():
    script = READ_STDIN + "process.stdout.write(JSON.stringify(inp.map(i => require('net').isIP(i))));"
    expected = run_node(script, IPS)
    got = [is_ip(i) for i in IPS]
    assert [(i, e, g) for i, e, g in zip(IPS, expected, got) if e != g] == []


def test_js_json_matches_node():
    values = [
        {"ok": True, "db": "ok", "uptime": 12, "shrines": None, "uploads": {"usedPct": 0, "lowDisk": False}},
        [0.1 + 0.2, 1e21, 1e-7, 123456789012345680000.0, 2.0**60, 1.5e-6, -0.0, 100.0, 4.35],
        ["한글", "\u2028", "\x01", '"\\', "\U0001F600", "\udc00x"],
    ]
    script = READ_STDIN + "process.stdout.write(JSON.stringify(inp.map(v => JSON.stringify(v))));"
    expected = run_node(script, values)
    assert [js_json(v) for v in values] == expected
