"""shrine.logic.links · weburl · ada_idna를 Node(``new URL`` · shrines.ts · registry.ts · net.isIP)와 맞춰 봅니다.

- tests/data/url_corpus.json: 까다로운 주소 331개 (GitHub · 서비스 · 백슬래시 · 계정 · 포트 · IPv4 숫자 꼴 · IPv6 · IDN ·
  퍼센트 · 점 경로 · 제어 문자 · 서로게이트), 허용 도메인 짝 26개, 이메일 43개, IP 28개, slug 17개
- 무작위 조합 주소 6000개, 무작위 IDN 라벨 6000개, xn-- 라벨 3000개
- 코드 포인트 전체: ``https://a<글자>b.com``의 hostname (Ada 3.4.2 표를 그대로 옮겼는지)
"""

from __future__ import annotations

import json
import random
from pathlib import Path

import pytest
from node_ref.runner import node_versions, run

from shrine.logic import links as L
from shrine.logic.ada_idna import utf32_to_punycode
from shrine.logic.jsnum import json_stringify
from shrine.logic.util import kst_date
from shrine.logic.weburl import InvalidURL, is_ip, parse_special_url

DATA = json.loads((Path(__file__).parent / "data" / "url_corpus.json").read_text(encoding="ascii"))


def url_parts(x: str) -> dict | None:
    try:
        u = parse_special_url(x)
    except InvalidURL:
        # 특수하지 않은 스킴(javascript: 등)은 Node에서 파싱돼도 여기서는 다루지 않습니다 (규칙에서는 늘 거절)
        return None
    return {"protocol": u.protocol, "username": u.username, "password": u.password, "hostname": u.hostname, "port": u.port_str,
            "pathname": u.pathname, "host": u.host_port, "origin": u.origin}  # fmt: skip


SPECIAL = ("http:", "https:", "ws:", "wss:", "ftp:")


def compare(inputs: list[str], pairs: list[list[str]], emails: list[str], slugs: list[str], ips: list[str]) -> None:
    node = run("links", inputs=inputs, allowed=pairs, emails=emails, slugs=slugs, ips=ips)
    bad = []
    for x, nu, ng, ns in zip(inputs, node["url"], node["github"], node["service"], strict=True):
        if nu is None or nu["protocol"] in SPECIAL:
            if url_parts(x) != nu:
                bad.append(("url", x, url_parts(x), nu))
        if L.parse_github(x) != ng:
            bad.append(("github", x, L.parse_github(x), ng))
        if L.normalize_service_url(x) != ns:
            bad.append(("service", x, L.normalize_service_url(x), ns))
    for (u, d), want in zip(pairs, node["allowed"], strict=True):
        if L.is_allowed_service_url(u, d) is not want:
            bad.append(("allowed", u, d, want))
    for e, want in zip(emails, node["email"], strict=True):
        if L.is_valid_email(e) is not want:
            bad.append(("email", e, want))
    for ip, want in zip(ips, node["isIP"], strict=True):
        if is_ip(ip) != want:
            bad.append(("isIP", ip, want))
    for t, want in zip(slugs, node["slugify"], strict=True):
        if L.slugify(t) != want:
            bad.append(("slugify", t, L.slugify(t), want))
    assert not bad, [tuple(map(ascii, b)) for b in bad[:10]]


def test_corpus_matches_node() -> None:
    assert len(DATA["urls"]) >= 200
    compare(DATA["urls"], DATA["pairs"], DATA["emails"], DATA["slugs"], DATA["ips"])


URL_PIECES = [
    "https://", "http://", "https:", "HTTPS://", "//", "/", "\\", "github.com", "GitHub.com", "www.", "example.com", "a", "b", "-", ".",
    "..", "%2e", "%2E", "%41", "%", "@", ":", "443", "8080", "user", "?", "#", "[::1]", "[", "]", "1.2.3.4", "0x7f", "xn--", "bj0bj06e",
    "한글", "é", "\u200d", "\u00ad", "。", "．", " ", "\t", "\n", "\x00", "\x7f", "\ud800", "😀", "git", ".git", "owner", "repo",
    "א", "١", "\u094d", "\u0301", "ß", "ﬁ", "^", "|", "<", "{", "~", "_", "*", "'", "\"", "`",
]  # fmt: skip


def test_random_urls_match_node() -> None:
    rng = random.Random(21)
    inputs = ["".join(rng.choice(URL_PIECES) for _ in range(rng.randint(1, 10))) for _ in range(6000)]
    pairs = [[rng.choice(inputs), rng.choice(["example.com", "github.com", "a", "1.2.3.4", "xn--bj0bj06e.com", ""])] for _ in range(500)]
    emails = ["".join(rng.choice(["a", "B", "@", ".", "-", "_", "😀", " ", "가", "x" * 30, "com", "\u3000", "\ud800"]) for _ in range(6))
              for _ in range(1000)]  # fmt: skip
    ips = ["".join(rng.choice(["1", "25", "255", "256", ".", ":", "::", "ff", "ffff", "%", "eth0", "0", "a"]) for _ in range(rng.randint(1, 9)))
           for _ in range(2000)]  # fmt: skip
    slugs = ["".join(rng.choice(["A", "b", " ", "-", "가", "😀", "İ", "_", "9"]) for _ in range(rng.randint(0, 50))) for _ in range(500)]
    compare(inputs, pairs, emails, slugs, ips)


LABEL_PIECES = [
    "a", "z", "0", "-", "ß", "é", "e\u0301", "한", "글", "א", "ב", "ا", "١", "۱", "1", "\u0300", "\u094d", "क",
    "\u200c", "\u200d", "ب", "ي", "م", "ꡲ", "\u00ad", "\ufeff", "❤", "😀", "\u2028", "ﬁ", "Ⅷ", "Ⅷ", "İ",
    "İ", "ς", "Σ", "。", "．", "%41", "%c3%a9", "%ff", "\ufffd", "ᄀ", "ᅡ", "ᆨ", "\u0e31", "\u0f71",
    "\U0001d7ce", "①", "Ａ", "ǅ", "\u0345", "\u0e38", "\u17d2", "\U00010d69", "\U00016d67", "\U000113c2",
]  # fmt: skip


def test_random_idn_labels_match_node() -> None:
    rng = random.Random(31)
    hosts = []
    for _ in range(6000):
        labels = ["".join(rng.choice(LABEL_PIECES) for _ in range(rng.randint(1, 5))) for _ in range(rng.randint(1, 3))]
        hosts.append(".".join(labels) + rng.choice([".com", ".kr", "", ".", ".xn--bj0bj06e"]))
    # xn-- 라벨: 올바른 퓨니코드(무작위 유니코드를 인코딩) + 망가뜨린 것
    for _ in range(3000):
        cps = [ord(rng.choice(LABEL_PIECES)[0]) for _ in range(rng.randint(1, 6))]
        p = utf32_to_punycode(cps) or "x"
        if rng.random() < 0.3:
            p = p[: rng.randint(0, len(p))] + rng.choice(["", "-", "a", "9", "zz", "A"])
        hosts.append("xn--" + p + rng.choice([".com", ""]))
    node = run("urlHosts", inputs=hosts)
    bad = []
    for h, want in zip(hosts, node, strict=True):
        got = url_parts("https://" + h + "/")
        got_host = None if got is None else got["hostname"]
        if got_host != want:
            bad.append((ascii(h), got_host, want))
    assert not bad, bad[:10]


def test_every_code_point_in_a_domain_label_matches_node() -> None:
    """``https://a<글자>b.com``의 hostname을 코드 포인트 1,114,112개 전부 (약 20초). Ada 판이 다르면 건너뜁니다."""
    ada = node_versions().get("ada")
    if ada != "3.4.2":
        pytest.skip(f"Node 내장 Ada가 {ada}입니다 (표는 3.4.2에서 뽑음: tests/node_ref/gen_ada_tables.py로 다시 만드세요)")
    node = run("idnaSweep", timeout=600, **{"from": 0, "to": 0x10FFFF, "step": 1})
    bad = []
    for cp in range(0x110000):
        got = ""
        if not (0xD800 <= cp <= 0xDFFF):
            try:
                got = parse_special_url("https://a" + chr(cp) + "b.com/").hostname
            except InvalidURL:
                got = ""
        if got != node[cp]:
            bad.append((hex(cp), got, node[cp]))
    assert not bad, bad[:10]


def test_registry_read_links_domain_and_email_match_node() -> None:
    rng = random.Random(41)
    pool = DATA["urls"] + DATA["emails"] + [None, ""]
    pairs = [[rng.choice(pool), rng.choice(pool)] for _ in range(1500)]
    pairs += [[None, None], [5, None], [None, ["x"]], ["github.com/a/b", "github.com/c/d"], ["", "www.github.com/a/b"], [None, "github.com/a/b"]]
    pairs += [[" A@B.CO ", None], ["a@b.co", "example.com"], ["github.com/a/b", "example.com/x/"], ["github.com/a", "example.com"]]
    node = run("registryLinks", pairs=pairs)
    for (g, u), want in zip(pairs, node, strict=True):
        r = L.read_links(g, u)
        assert r == want["r"], (g, u, r, want["r"])
        assert (L.domain_of(r["links"]) if r["ok"] else None) == want["domain"], (g, u)
        assert L.clean_email(g) == want["email"], g


def base_shrine(**over: object) -> dict:
    s = {
        "slug": "my-svc", "name": "내 서비스", "tagline": "무사배포를 기원하는 서비스입니다", "category": "devtools", "domain": "example.com",
        "url": "https://example.com/app", "operator": "운영자", "keeper": False, "paid": False, "verifiedDomain": "2026-01-02",
        "verifiedBusiness": None, "joinedAt": kst_date(), "status": "live", "prayer": "deploy", "charm": None, "deco": ["duck"],
        "screens": ["shot-1.png"], "capturedAt": "2026-01-02", "channel": 1, "plot": 3, "sign": "", "repo": "", "email": "",
        "emailPublic": False, "projectId": 0,
    }  # fmt: skip
    s.update(over)
    return s


def test_validate_and_public_shrine_match_node() -> None:
    variants = [
        {}, {"slug": "-bad"}, {"slug": "a" * 41}, {"slug": "ok-1"}, {"name": ""}, {"name": "가" * 21}, {"name": "😀" * 20},
        {"tagline": "x" * 41}, {"sign": "아홉 글자 입니다요"}, {"sign": "여덟글자입니다"}, {"category": "nope"},
        {"domain": "1.2.3.4", "url": "https://1.2.3.4"}, {"domain": "Example.com"}, {"url": "https://www.example.com/x"},
        {"url": "https://evil.com"}, {"url": "http://example.com"}, {"url": "https://example.com:8443"},
        {"domain": "github.com/owner/repo", "url": "https://github.com/Owner/Repo"}, {"domain": "github.com/owner/repo", "url": "https://github.com/x/y"},
        {"repo": "github.com/a/b"}, {"repo": "nope"}, {"email": "a@b.co", "emailPublic": True}, {"email": "a@b.co"}, {"email": "bad"},
        {"operator": "  "}, {"operator": "가" * 21}, {"verifiedDomain": "2026-1-2"}, {"verifiedDomain": "", "projectId": 5},
        {"verifiedDomain": ""}, {"verifiedBusiness": "2026-02-03"}, {"verifiedBusiness": "x"}, {"joinedAt": "2026/01/02"},
        {"status": "dead"}, {"prayer": "money"}, {"charm": "no-cve"}, {"charm": "x"}, {"deco": ["duck", "cat", "coffee", "cactus"]},
        {"deco": ["bad"]}, {"screens": []}, {"screens": [], "projectId": 2}, {"screens": ["up/ABCDEFGHIJKLMNOP.webp"]},
        {"screens": ["a.gif"]}, {"screens": ["a.png"] * 4}, {"channel": 0}, {"channel": 3}, {"channel": 4}, {"channel": 2.0},
        {"plot": 19}, {"plot": 20}, {"plot": -1}, {"plot": 1.5}, {"plot": 0}, {"joinedAt": "2020-01-01"}, {"joinedAt": "2999-01-01"},
        {"joinedAt": "2026-02-30"}, {"tagline": "e\u0301" * 9, "sign": ""}, {"tagline": "  앞 공백 소개  ", "sign": ""},
    ]  # fmt: skip
    items = [base_shrine(**v) for v in variants]
    node = run("shrines", items=items)
    for s, want in zip(items, node, strict=True):
        assert L.validate_shrine(s) == want["errors"], s
        assert json_stringify(L.public_shrine(s)) == want["pub"], s


def test_from_row_matches_node() -> None:
    row = {
        "slug": "a", "name": "n", "tagline": "t", "category": "etc", "domain": "example.com", "url": "https://example.com", "operator": "o",
        "keeper": 1, "paid": 0, "verified_domain": "", "verified_business": None, "joined_at": "2026-01-01", "status": "live",
        "prayer": "bug", "charm": None, "deco": '["duck",1,null,"cat"]', "screens": "not json", "captured_at": "2026-01-01",
        "channel": None, "plot": 2, "repo": None, "email": None, "email_public": 1, "project_id": None, "sign": None,
    }  # fmt: skip
    rows = [row, {**row, "deco": "{}", "screens": '["a.png"]', "channel": 2, "repo": "r", "project_id": 9, "sign": "s", "email_public": 0}]
    node = run("fromRow", rows=rows)
    for r, want in zip(rows, node, strict=True):
        assert json_stringify(L.from_row(r)) == want


def test_unique_slug_and_free_plots() -> None:
    assert L.unique_slug("abc", set()) == "abc"
    assert L.unique_slug("abc", {"abc", "abc-2"}) == "abc-3"
    long = "x" * 40
    assert L.unique_slug(long, {long}) == "x" * 36 + "-2"
    taken = {"a"} | {f"a-{i}" for i in range(2, 1000)}
    s = L.unique_slug("a", taken)
    assert s.startswith("a-") and len(s) == 8 and s not in taken
    assert L.free_plots({0, 3, 19}) == [i for i in range(20) if i not in (0, 3, 19)]
