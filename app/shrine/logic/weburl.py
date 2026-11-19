"""WHATWG URL 파서(특수 스킴, base 없음)와 Node ``net.isIP``.

shrines.ts의 링크 규칙은 ``new URL(text)``의 ``protocol`` · ``username`` · ``password`` · ``port`` · ``hostname`` ·
``pathname``만 봅니다 (shrines.ts:67-128). 그래서 여기서는 WHATWG URL Standard의 기본 파서 가운데
특수 스킴(``http`` · ``https`` · ``ws`` · ``wss`` · ``ftp``)에 base 없이 들어오는 경로만, 쿼리 · 조각 앞까지 옮겼습니다.
쿼리 · 조각 상태에서는 실패가 나지 않으므로 거기서 멈춰도 결과(성공/실패, 위 6개 값)는 같습니다.
``file:``과 특수하지 않은 스킴은 ``UnsupportedScheme``을 냅니다 (서버 규칙에서는 어차피 https만 통과합니다).

| 함수 | 원본 |
|---|---|
| ``parse_special_url`` | URL Standard "basic URL parser" (scheme start ~ path state), Node 24.14 = Ada 3.4.2 |
| ``parse_host`` | "host parser" — 도메인 → ASCII는 ``ada_idna.to_ascii`` (Ada 3.4.2 그대로) |
| ``parse_ipv4`` · ``parse_ipv6`` · ``serialize_ipv6`` | "IPv4 parser" · "IPv6 parser" · "IPv6 serializer" |
| ``is_ip`` · ``is_ipv4`` · ``is_ipv6`` | Node lib/internal/net.js (v24.14.0) 정규식 그대로 |

입력의 짝 없는 서로게이트는 ``new URL``처럼 먼저 U+FFFD로 바꿉니다 (USVString 변환).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .ada_idna import to_ascii
from .jsstr import usv

__all__ = [
    "InvalidURL",
    "ParsedURL",
    "UnsupportedScheme",
    "is_ip",
    "is_ipv4",
    "is_ipv6",
    "parse_host",
    "parse_ipv4",
    "parse_ipv6",
    "parse_special_url",
    "serialize_ipv6",
]


class InvalidURL(ValueError):
    """``new URL()``이 TypeError(Invalid URL)를 내는 입력."""


class UnsupportedScheme(InvalidURL):
    """파싱은 될 수도 있지만 여기서 다루지 않는 스킴 (특수하지 않은 스킴 · file). 서버 규칙에서는 늘 거절입니다."""

    def __init__(self, scheme: str) -> None:
        super().__init__(scheme)
        self.scheme = scheme


SPECIAL_PORTS: dict[str, int | None] = {"ftp": 21, "file": None, "http": 80, "https": 443, "ws": 80, "wss": 443}


@dataclass
class ParsedURL:
    scheme: str
    username: str = ""
    password: str = ""
    host: str = ""
    port: int | None = None
    path: list[str] = field(default_factory=list)

    @property
    def protocol(self) -> str:
        return self.scheme + ":"

    @property
    def hostname(self) -> str:
        return self.host

    @property
    def port_str(self) -> str:
        """JS ``u.port``: 기본 포트면 ''."""
        return "" if self.port is None else str(self.port)

    @property
    def pathname(self) -> str:
        return "".join("/" + seg for seg in self.path)

    @property
    def host_port(self) -> str:
        """JS ``u.host``: hostname + (기본 포트가 아니면 ``:port``)."""
        return self.host if self.port is None else f"{self.host}:{self.port}"

    @property
    def origin(self) -> str:
        """JS ``u.origin`` (특수 스킴): ``scheme://host[:port]``."""
        return f"{self.scheme}://{self.host_port}"


# ── 퍼센트 인코딩 ────────────────────────────────────────────────────


def _c0_set(b: int) -> bool:
    return b < 0x20 or b > 0x7E


_PATH_EXTRA = frozenset(b' "#<>?^`{}')
_USERINFO_EXTRA = frozenset(b' "#<>?^`{}/:;=@[\\]|')


def _encode(c: str, extra: frozenset[int]) -> str:
    out = []
    for b in c.encode("utf-8"):
        if _c0_set(b) or b in extra:
            out.append(f"%{b:02X}")
        else:
            out.append(chr(b))
    return "".join(out)


def _percent_decode(s: str) -> bytes:
    data = s.encode("utf-8")
    out = bytearray()
    i = 0
    n = len(data)
    hexd = b"0123456789abcdefABCDEF"
    while i < n:
        b = data[i]
        if b == 0x25 and i + 2 < n and data[i + 1] in hexd and data[i + 2] in hexd:
            out.append(int(data[i + 1 : i + 3], 16))
            i += 3
        else:
            out.append(b)
            i += 1
    return bytes(out)


# ── 호스트 ───────────────────────────────────────────────────────────

_FORBIDDEN_DOMAIN = frozenset("\x00\t\n\r #/:<>?@[\\]^|%\x7f") | frozenset(chr(c) for c in range(0x20))


def _ipv4_number(part: str) -> int | None:
    if part == "":
        return None
    radix = 10
    if len(part) >= 2 and part[:2] in ("0x", "0X"):
        part = part[2:]
        radix = 16
    elif len(part) >= 2 and part[0] == "0":
        part = part[1:]
        radix = 8
    if part == "":
        return 0
    digits = {10: "0123456789", 16: "0123456789abcdefABCDEF", 8: "01234567"}[radix]
    if any(ch not in digits for ch in part):
        return None
    return int(part, radix)


def _ends_in_number(s: str) -> bool:
    parts = s.split(".")
    if parts[-1] == "":
        if len(parts) == 1:
            return False
        parts.pop()
    last = parts[-1]
    if last != "" and all("0" <= ch <= "9" for ch in last):
        return True
    return _ipv4_number(last) is not None


def parse_ipv4(s: str) -> int | None:
    """URL Standard IPv4 parser: 실패면 None, 아니면 32비트 정수 (``0x7f.1`` → 127.0.0.1)."""
    parts = s.split(".")
    if parts[-1] == "" and len(parts) > 1:
        parts.pop()
    if len(parts) > 4:
        return None
    numbers = []
    for p in parts:
        v = _ipv4_number(p)
        if v is None:
            return None
        numbers.append(v)
    if any(v > 255 for v in numbers[:-1]):
        return None
    if numbers[-1] >= 256 ** (5 - len(numbers)):
        return None
    ipv4 = numbers[-1]
    for i, v in enumerate(numbers[:-1]):
        ipv4 += v * 256 ** (3 - i)
    return ipv4


def _serialize_ipv4(v: int) -> str:
    return ".".join(str((v >> s) & 0xFF) for s in (24, 16, 8, 0))


_HEX = "0123456789abcdefABCDEF"


def parse_ipv6(s: str) -> list[int] | None:
    """URL Standard IPv6 parser (괄호 안 글자). 실패면 None, 아니면 16비트 조각 8개."""
    address = [0] * 8
    piece = 0
    compress: int | None = None
    p = 0
    n = len(s)

    def c(i: int) -> str:
        return s[i] if i < n else ""

    if c(p) == ":":
        if c(p + 1) != ":":
            return None
        p += 2
        piece += 1
        compress = piece
    while c(p) != "":
        if piece == 8:
            return None
        if c(p) == ":":
            if compress is not None:
                return None
            p += 1
            piece += 1
            compress = piece
            continue
        value = length = 0
        while length < 4 and c(p) != "" and c(p) in _HEX:
            value = value * 0x10 + int(c(p), 16)
            p += 1
            length += 1
        if c(p) == ".":
            if length == 0:
                return None
            p -= length
            if piece > 6:
                return None
            seen = 0
            while c(p) != "":
                v4: int | None = None
                if seen > 0:
                    if c(p) == "." and seen < 4:
                        p += 1
                    else:
                        return None
                if not ("0" <= c(p) <= "9") or c(p) == "":
                    return None
                while c(p) != "" and "0" <= c(p) <= "9":
                    num = int(c(p))
                    if v4 is None:
                        v4 = num
                    elif v4 == 0:
                        return None
                    else:
                        v4 = v4 * 10 + num
                    if v4 > 255:
                        return None
                    p += 1
                address[piece] = address[piece] * 0x100 + (v4 or 0)
                seen += 1
                if seen in (2, 4):
                    piece += 1
            if seen != 4:
                return None
            break
        elif c(p) == ":":
            p += 1
            if c(p) == "":
                return None
        elif c(p) != "":
            return None
        address[piece] = value
        piece += 1
    if compress is not None:
        swaps = piece - compress
        piece = 7
        while piece != 0 and swaps > 0:
            j = compress + swaps - 1
            address[piece], address[j] = address[j], address[piece]
            piece -= 1
            swaps -= 1
    elif piece != 8:
        return None
    return address


def serialize_ipv6(address: list[int]) -> str:
    """URL Standard IPv6 serializer (첫 번째로 가장 긴 0 두 개 이상 묶음을 ``::``로)."""
    best_start, best_len = -1, 1
    i = 0
    while i < 8:
        if address[i] == 0:
            j = i
            while j < 8 and address[j] == 0:
                j += 1
            if j - i > best_len:
                best_start, best_len = i, j - i
            i = j
        else:
            i += 1
    out = []
    ignore0 = False
    for idx in range(8):
        if ignore0 and address[idx] == 0:
            continue
        ignore0 = False
        if idx == best_start:
            out.append("::" if idx == 0 else ":")
            ignore0 = True
            continue
        out.append(f"{address[idx]:x}")
        if idx != 7:
            out.append(":")
    return "".join(out)


def parse_host(text: str) -> str:
    """특수 스킴의 호스트를 WHATWG 모양 문자열로 (IPv6는 ``[...]``). 실패하면 ``InvalidURL``."""
    if text.startswith("["):
        if not text.endswith("]"):
            raise InvalidURL("ipv6")
        addr = parse_ipv6(text[1:-1])
        if addr is None:
            raise InvalidURL("ipv6")
        return "[" + serialize_ipv6(addr) + "]"
    raw = _percent_decode(text)
    try:
        domain = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise InvalidURL("utf8") from None
    ascii_domain = to_ascii(domain)
    if not ascii_domain or any(ch in _FORBIDDEN_DOMAIN or ord(ch) >= 0x80 for ch in ascii_domain):
        raise InvalidURL("domain")
    if _ends_in_number(ascii_domain):
        v4 = parse_ipv4(ascii_domain)
        if v4 is None:
            raise InvalidURL("ipv4")
        return _serialize_ipv4(v4)
    return ascii_domain


# ── 기본 파서 (특수 스킴만) ──────────────────────────────────────────

_TAB_NL = str.maketrans("", "", "\t\n\r")


def _is_alpha(ch: str) -> bool:
    return ("a" <= ch <= "z") or ("A" <= ch <= "Z")


def _is_double_dot(seg: str) -> bool:
    return seg.lower() in ("..", ".%2e", "%2e.", "%2e%2e")


def _is_single_dot(seg: str) -> bool:
    return seg.lower() in (".", "%2e")


def parse_special_url(raw: str) -> ParsedURL:
    """``new URL(raw)`` (base 없음). 특수 스킴이면 ``ParsedURL``, 실패면 ``InvalidURL``, 그 밖의 스킴은 ``UnsupportedScheme``."""
    s = usv(raw)
    # 앞뒤 C0 제어 문자 · 공백(≤ U+0020)을 떼고, 탭 · 줄바꿈은 어디서든 지웁니다
    i, j = 0, len(s)
    while i < j and s[i] <= " ":
        i += 1
    while j > i and s[j - 1] <= " ":
        j -= 1
    s = s[i:j].translate(_TAB_NL)

    # scheme start / scheme
    if not s or not _is_alpha(s[0]):
        raise InvalidURL("scheme")
    k = 1
    while k < len(s) and (s[k].isascii() and (s[k].isalnum() or s[k] in "+-.")):
        k += 1
    if k >= len(s) or s[k] != ":":
        raise InvalidURL("scheme")
    scheme = s[:k].lower()
    if scheme not in SPECIAL_PORTS or scheme == "file":
        raise UnsupportedScheme(scheme)
    url = ParsedURL(scheme=scheme)
    p = k + 1
    n = len(s)

    # special authority slashes → special authority ignore slashes
    while p < n and s[p] in "/\\":
        p += 1

    # authority
    start = p
    at_seen = False
    password_seen = False
    buf: list[str] = []
    while True:
        c = s[p] if p < n else ""
        if c == "@":
            if at_seen:
                buf.insert(0, "%40")
            at_seen = True
            for ch in buf:
                if ch == ":" and not password_seen:
                    password_seen = True
                    continue
                enc = ch if ch == "%40" else _encode(ch, _USERINFO_EXTRA)
                if password_seen:
                    url.password += enc
                else:
                    url.username += enc
            buf = []
            start = p + 1
        elif c in ("", "/", "?", "#", "\\"):
            if at_seen and not buf:
                raise InvalidURL("host-missing")
            p = start
            break
        else:
            buf.append(c)
        p += 1

    # host
    inside = False
    hbuf: list[str] = []
    while True:
        c = s[p] if p < n else ""
        if c == ":" and not inside:
            if not hbuf:
                raise InvalidURL("host-missing")
            url.host = parse_host("".join(hbuf))
            p += 1
            # port
            pbuf = []
            while True:
                c = s[p] if p < n else ""
                if c != "" and "0" <= c <= "9":
                    pbuf.append(c)
                    p += 1
                elif c in ("", "/", "?", "#", "\\"):
                    if pbuf:
                        port = int("".join(pbuf))
                        if port > 65535:
                            raise InvalidURL("port")
                        url.port = None if port == SPECIAL_PORTS[scheme] else port
                    break
                else:
                    raise InvalidURL("port")
            break
        if c in ("", "/", "?", "#", "\\"):
            if not hbuf:
                raise InvalidURL("host-missing")
            url.host = parse_host("".join(hbuf))
            break
        if c == "[":
            inside = True
        elif c == "]":
            inside = False
        hbuf.append(c)
        p += 1

    # path start: '/' 또는 '\' 하나를 먹습니다
    if p < n and s[p] in "/\\":
        p += 1
    seg: list[str] = []
    while True:
        c = s[p] if p < n else ""
        if c in ("", "/", "\\", "?", "#"):
            b = "".join(seg)
            slash = c in ("/", "\\")
            if _is_double_dot(b):
                if url.path:
                    url.path.pop()
                if not slash:
                    url.path.append("")
            elif _is_single_dot(b):
                if not slash:
                    url.path.append("")
            else:
                url.path.append(b)
            seg = []
            if not slash:
                break  # EOF · 쿼리 · 조각: 경로는 여기서 끝
        else:
            seg.append(_encode(c, _PATH_EXTRA))
        p += 1
    return url


# ── Node net.isIP ────────────────────────────────────────────────────

_V4_SEG = "(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])"
_V4_STR = rf"(?:{_V4_SEG}\.){{3}}{_V4_SEG}"
_V6_SEG = "(?:[0-9a-fA-F]{1,4})"
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
    r")(?:%[0-9a-zA-Z.:\-]{1,})?"
)


def is_ipv4(s: str) -> bool:
    """Node ``net.isIPv4`` (lib/internal/net.js IPv4Reg)."""
    return isinstance(s, str) and _IPV4_RE.fullmatch(s) is not None


def is_ipv6(s: str) -> bool:
    """Node ``net.isIPv6`` (lib/internal/net.js IPv6Reg, ``%zone`` 허용)."""
    return isinstance(s, str) and _IPV6_RE.fullmatch(s) is not None


def is_ip(s: str) -> int:
    """Node ``net.isIP``: 4 · 6 · 0."""
    if is_ipv4(s):
        return 4
    if is_ipv6(s):
        return 6
    return 0
