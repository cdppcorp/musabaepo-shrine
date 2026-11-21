"""요청 주소 · 설정 주소를 Node의 `new URL`처럼 읽기 — logic/weburl.py(WHATWG 파서, Ada 3.4.2와 같은 결과) 위의 얇은 층.

- `request_pathname(target)`: `new URL(req.url, 'http://local').pathname` (http.ts:374, main.ts:49)
- `parse_http_url(s)`: http(s) 절대 주소의 scheme · host · port (config.ts의 PUBLIC_ORIGIN · NOTIFY_WEBHOOK_URL 검사)

weburl.parse_special_url은 base 없는 절대 주소만 읽으므로, 요청 줄의 상대 주소는 기준 주소 'http://local'을
WHATWG 규칙대로 붙여서 넘깁니다 (`//host/…`는 scheme만, `/…`는 호스트까지, 그 밖은 경로 '/' 뒤에).
"""

from __future__ import annotations

import re

from .logic.weburl import InvalidURL, ParsedURL, UnsupportedScheme, parse_special_url

__all__ = ["HttpURL", "InvalidURL", "parse_http_url", "request_pathname"]

# 앞뒤 C0 제어 문자와 공백 (잘라 냄), 탭 · 줄바꿈 (어디서든 지움)
_C0_SPACE = "".join(chr(i) for i in range(0x21))
_TAB_NEWLINE = str.maketrans("", "", "\t\n\r")
_SCHEME = re.compile(r"[A-Za-z][A-Za-z0-9+\-.]*:")
_BASE = "http://local"


def _relative(rest: str) -> ParsedURL:
    """기준 주소 http://local에 붙는 상대 주소 (scheme 뒤 부분)."""
    if rest[:1] in ("/", "\\") and rest[1:2] in ("/", "\\"):
        return parse_special_url("http:" + rest)  # //host/path: 호스트부터 새로
    if rest[:1] in ("/", "\\"):
        return parse_special_url(_BASE + rest)  # /path: 기준 호스트 + 새 경로
    return parse_special_url(_BASE + "/" + rest)  # path: 기준 경로 '/' 뒤에


def request_pathname(target: str) -> str:
    """`new URL(target, 'http://local').pathname`. 주소로 볼 수 없으면 InvalidURL (Node에서는 500이 됨).

    target은 요청 줄의 주소를 latin-1로 푼 글자입니다 (Node도 req.url을 latin-1로 받습니다).
    """
    s = target.strip(_C0_SPACE).translate(_TAB_NEWLINE)
    m = _SCHEME.match(s)
    if m:
        scheme = m.group()[:-1].lower()
        if scheme == "http":
            # 기준 주소와 같은 특수 scheme: 'http:' 뒤가 빗금 둘이 아니면 기준 주소에 붙는 상대 주소입니다
            return _relative(s[m.end() :]).pathname
        try:
            return parse_special_url(s).pathname
        except UnsupportedScheme as e:
            # 특수하지 않은 scheme(불투명 경로)은 다루지 않습니다. 요청 줄에 오는 일이 없어 500으로 둡니다
            raise InvalidURL(s) from e
    return _relative(s).pathname


class HttpURL:
    """config.py가 보는 칸만: scheme · hostname · port · pathname, 그리고 JS URL의 protocol · host · origin."""

    __slots__ = ("hostname", "pathname", "port", "scheme")

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
    try:
        u = parse_special_url(s)
    except InvalidURL:
        return None
    if u.scheme not in ("http", "https"):
        return None
    return HttpURL(u.scheme, u.hostname, u.port, u.pathname)
