"""WHATWG URL 파서 중 서버 뼈대에 필요한 부분만 (Node의 `new URL`과 같은 결과).

- `request_pathname(target)`: `new URL(req.url, 'http://local').pathname` (http.ts:374, main.ts:49)
- `parse_http_url(s)`: http(s) 절대 주소의 scheme · host · port (config.ts의 PUBLIC_ORIGIN · NOTIFY_WEBHOOK_URL 검사)

전체 WHATWG 파서가 아닙니다. 비 ASCII 호스트(IDNA)는 idna 라이브러리로 대신하므로 아주 드문 국제화 도메인에서
Node와 다를 수 있습니다. 사당 링크 정리(shrines.ts) 같은 기능 쪽 URL 처리는 shrine/logic이 맡습니다.
"""

from __future__ import annotations

import ipaddress
import re

import idna


class InvalidURL(ValueError):
    """`new URL`이 TypeError(ERR_INVALID_URL)를 던지는 경우."""


# C0 제어 문자와 공백 (앞뒤에서 잘라 냄)
_C0_SPACE = "".join(chr(i) for i in range(0x21))
_TAB_NEWLINE = re.compile("[\t\n\r]")

# 경로 퍼센트 인코딩 대상 (C0 · 0x7E 초과는 따로 봄). Node 24는 ^도 인코딩합니다
_PATH_ENCODE = frozenset(' "#<>?`{}^')

_SINGLE_DOT = frozenset({".", "%2e"})
_DOUBLE_DOT = frozenset({"..", ".%2e", "%2e.", "%2e%2e"})

# 호스트에 올 수 없는 글자 (forbidden domain code point)
_FORBIDDEN_HOST = frozenset("\x00\t\n\r #/:<>?@[\\]^|")
_FORBIDDEN_DOMAIN = _FORBIDDEN_HOST | frozenset(chr(i) for i in range(0x20)) | {"%", "\x7f"}


def _encode_segment(seg: str) -> str:
    if all(0x20 < ord(c) < 0x7F and c not in _PATH_ENCODE for c in seg):
        return seg
    out = []
    for c in seg:
        o = ord(c)
        if o <= 0x20 or o >= 0x7F or c in _PATH_ENCODE:
            out.append("".join(f"%{b:02X}" for b in c.encode("utf-8", "surrogatepass")))
        else:
            out.append(c)
    return "".join(out)


def _serialize_path(path_input: str) -> str:
    """'/' 또는 '\\'로 시작하는 경로 → pathname (점 조각 처리 + 퍼센트 인코딩)."""
    segments = re.split(r"[/\\]", path_input)[1:]
    out: list[str] = []
    last = len(segments) - 1
    for i, seg in enumerate(segments):
        low = seg.lower()
        if low in _DOUBLE_DOT:
            if out:
                out.pop()
            if i == last:
                out.append("")
        elif low in _SINGLE_DOT:
            if i == last:
                out.append("")
        else:
            out.append(_encode_segment(seg))
    return "/" + "/".join(out)


def _cut_query(s: str) -> str:
    for i, c in enumerate(s):
        if c in "?#":
            return s[:i]
    return s


def request_pathname(target: str) -> str:
    """`new URL(target, 'http://local').pathname`. 주소로 볼 수 없으면 InvalidURL (Node에서는 500이 됨).

    target은 요청 줄의 주소를 latin-1로 푼 글자입니다 (Node도 req.url을 latin-1로 받습니다).
    """
    s = target.strip(_C0_SPACE)
    s = _TAB_NEWLINE.sub("", s)
    if s[:1] in ("/", "\\") and s[1:2] in ("/", "\\"):
        # //host/path: 앞의 빗금을 모두 건너뛰고 호스트를 읽은 뒤 나머지가 경로
        i = 0
        while i < len(s) and s[i] in "/\\":
            i += 1
        j = i
        while j < len(s) and s[j] not in "/\\?#":
            j += 1
        _parse_authority(s[i:j], "http")
        rest = _cut_query(s[j:])
        return _serialize_path(rest) if rest else "/"
    if s[:1] in ("/", "\\"):
        return _serialize_path(_cut_query(s))
    if re.match(r"[A-Za-z][A-Za-z0-9+\-.]*:", s):
        # 절대 주소. 요청 줄이 절대 형식이면 uvicorn이 이미 경로만 떼어 주므로 여기 오는 일은 드뭅니다
        parsed = parse_http_url(s)
        if parsed is None:
            raise InvalidURL(s)
        return parsed.pathname
    # 상대 경로 (예: '*'): 기준 주소의 '/' 뒤에 붙습니다
    return _serialize_path("/" + _cut_query(s))


# ── 호스트 ──


def _ends_in_number(domain: str) -> bool:
    parts = domain.split(".")
    if parts[-1] == "":
        if len(parts) == 1:
            return False
        parts.pop()
    last = parts[-1]
    if last and all(c in "0123456789" for c in last):
        return True
    return re.fullmatch(r"0[xX][0-9a-fA-F]*", last) is not None


def _ipv4_number(part: str) -> int:
    if part == "":
        raise InvalidURL("ipv4")
    radix = 10
    if part[:2] in ("0x", "0X"):
        part, radix = part[2:], 16
    elif len(part) > 1 and part[0] == "0":
        part, radix = part[1:], 8
    if part == "":
        return 0
    digits = {10: "0123456789", 16: "0123456789abcdefABCDEF", 8: "01234567"}[radix]
    if any(c not in digits for c in part):
        raise InvalidURL("ipv4")
    return int(part, radix)


def _parse_ipv4(domain: str) -> int:
    parts = domain.split(".")
    if parts[-1] == "" and len(parts) > 1:
        parts.pop()
    if len(parts) > 4:
        raise InvalidURL("ipv4")
    numbers = [_ipv4_number(p) for p in parts]
    if any(n > 255 for n in numbers[:-1]):
        raise InvalidURL("ipv4")
    if numbers[-1] >= 256 ** (5 - len(numbers)):
        raise InvalidURL("ipv4")
    ipv4 = numbers[-1]
    for i, n in enumerate(numbers[:-1]):
        ipv4 += n * 256 ** (3 - i)
    return ipv4


def _serialize_ipv6(addr: ipaddress.IPv6Address) -> str:
    pieces = [int.from_bytes(addr.packed[i : i + 2], "big") for i in range(0, 16, 2)]
    # 가장 긴(같으면 앞쪽) 0 묶음(2개 이상)을 ::로
    best_start, best_len, i = -1, 1, 0
    while i < 8:
        if pieces[i] == 0:
            j = i
            while j < 8 and pieces[j] == 0:
                j += 1
            if j - i > best_len:
                best_start, best_len = i, j - i
            i = j
        else:
            i += 1
    out, i = "", 0
    while i < 8:
        if i == best_start:
            out += "::" if i == 0 else ":"
            i += best_len
            continue
        out += format(pieces[i], "x") + (":" if i < 7 else "")
        i += 1
    return out


def _parse_host(raw: str) -> str:
    """host 칸 → 정규화한 글자 (도메인은 소문자 ASCII, IPv4는 점 네 칸, IPv6는 [압축형])."""
    if raw.startswith("["):
        if not raw.endswith("]"):
            raise InvalidURL("ipv6")
        inner = raw[1:-1]
        if "%" in inner or not inner:
            raise InvalidURL("ipv6")
        try:
            addr = ipaddress.IPv6Address(inner)
        except ValueError as e:
            raise InvalidURL("ipv6") from e
        return f"[{_serialize_ipv6(addr)}]"
    # 퍼센트 디코드 → UTF-8 (잘못된 바이트는 U+FFFD)
    decoded = re.sub(
        rb"%([0-9A-Fa-f]{2})", lambda m: bytes([int(m.group(1), 16)]), raw.encode("utf-8", "surrogatepass")
    ).decode("utf-8", "replace")
    if decoded.isascii() and not any(lbl.lower().startswith("xn--") for lbl in decoded.split(".")):
        ascii_domain = decoded.lower()
    else:
        try:
            mapped = idna.uts46_remap(decoded, std3_rules=False, transitional=False)
            ascii_domain = ".".join(
                lbl if lbl.isascii() and not lbl.startswith("xn--") else idna.encode(lbl, uts46=False).decode("ascii")
                for lbl in mapped.split(".")
            )
        except (idna.IDNAError, UnicodeError, ValueError) as e:
            raise InvalidURL("idna") from e
    if ascii_domain == "" or any(c in _FORBIDDEN_DOMAIN for c in ascii_domain):
        raise InvalidURL("host")
    if _ends_in_number(ascii_domain):
        return str(ipaddress.IPv4Address(_parse_ipv4(ascii_domain)))
    return ascii_domain


def _parse_authority(authority: str, scheme: str) -> tuple[str, int | None]:
    """'user:pass@host:port' → (host, port 또는 None(기본 포트)). 잘못되면 InvalidURL."""
    if "@" in authority:
        authority = authority[authority.rindex("@") + 1 :]
        if authority == "":
            raise InvalidURL("host-missing")
    if authority.startswith("["):
        close = authority.find("]")
        if close == -1:
            raise InvalidURL("ipv6")
        host_raw, rest = authority[: close + 1], authority[close + 1 :]
        if rest and not rest.startswith(":"):
            raise InvalidURL("host")
        port_raw = rest[1:] if rest else None
    else:
        host_raw, sep, port_raw = authority.partition(":")
        if not sep:
            port_raw = None
    if host_raw == "":
        raise InvalidURL("host-missing")
    host = _parse_host(host_raw)
    port: int | None = None
    if port_raw:
        if not all(c in "0123456789" for c in port_raw):
            raise InvalidURL("port")
        port = int(port_raw)
        if port > 65535:
            raise InvalidURL("port")
        if port == {"http": 80, "https": 443}.get(scheme):
            port = None
    return host, port


class HttpURL:
    __slots__ = ("scheme", "hostname", "port", "pathname")

    def __init__(self, scheme: str, hostname: str, port: int | None, pathname: str):
        self.scheme = scheme
        self.hostname = hostname
        self.port = port
        self.pathname = pathname

    @property
    def protocol(self) -> str:
        return self.scheme + ":"

    @property
    def host(self) -> str:
        return self.hostname if self.port is None else f"{self.hostname}:{self.port}"

    @property
    def origin(self) -> str:
        return f"{self.scheme}://{self.host}"


def parse_http_url(s: str) -> HttpURL | None:
    """http · https 절대 주소면 HttpURL, 주소가 아니거나 다른 scheme이면 None."""
    s = _TAB_NEWLINE.sub("", s.strip(_C0_SPACE))
    m = re.match(r"([A-Za-z][A-Za-z0-9+\-.]*):", s)
    if not m:
        return None
    scheme = m.group(1).lower()
    if scheme not in ("http", "https"):
        return None
    rest = s[m.end() :]
    i = 0
    while i < len(rest) and rest[i] in "/\\":
        i += 1
    j = i
    while j < len(rest) and rest[j] not in "/\\?#":
        j += 1
    try:
        host, port = _parse_authority(rest[i:j], scheme)
        tail = _cut_query(rest[j:])
        pathname = _serialize_path(tail) if tail else "/"
    except InvalidURL:
        return None
    return HttpURL(scheme, host, port, pathname)
