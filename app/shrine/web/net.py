"""요청 머리글 · 방문자 IP · 그날 IP 해시 (security.ts clientIp · ipHash).

IP는 그날만 쓰는 무작위 값(소금)과 섞은 해시로만 다룹니다. 소금은 이 프로세스 메모리에만 있고(디스크 · Redis에
두지 않음) 한국 날짜가 바뀌면 새로 만듭니다. 그래서 Redis에 남는 요청 제한 키로 원래 IP를 되찾을 수 없고,
서버를 다시 띄우면 같은 IP도 다른 해시가 됩니다 (Node와 같음).
"""

from __future__ import annotations

import base64
import hashlib
import secrets
import time
from datetime import UTC, datetime

from ..jscompat import js_trim

KST_OFFSET_S = 9 * 3600

# Node가 같은 이름 머리글을 여러 번 받으면 버리고 첫 값만 두는 것 (그 밖은 ', '로 이음, cookie는 '; ')
_DISCARD_DUPLICATES = frozenset(
    {
        "age", "authorization", "content-length", "content-type", "etag", "expires", "from", "host",
        "if-modified-since", "if-unmodified-since", "last-modified", "location", "max-forwards",
        "proxy-authorization", "referer", "retry-after", "server", "user-agent",
    }
)

# Node http 서버 maxHeadersCount (main.ts:45): 이보다 많은 머리글은 버림
MAX_HEADERS = 50


def node_header(scope_headers: list[tuple[bytes, bytes]], name: str) -> str | None:
    """Node의 req.headers[name]과 같은 값 (latin-1 글자, 없으면 None)."""
    want = name.lower().encode("latin-1")
    values = [v.decode("latin-1") for k, v in scope_headers if k.lower() == want]
    if not values:
        return None
    if name in _DISCARD_DUPLICATES:
        return values[0]
    return ("; " if name == "cookie" else ", ").join(values)


def client_ip(scope: dict, trust_proxy: bool) -> str:
    """TRUST_PROXY면 X-Forwarded-For 첫 값, 아니면 연결한 주소."""
    if trust_proxy:
        xff = node_header(scope["headers"], "x-forwarded-for")
        if xff is not None:
            first = js_trim(xff.split(",")[0])
            if first:
                return first
    client = scope.get("client")
    return client[0] if client else "unknown"


def kst_date(now: float | None = None) -> str:
    """한국 시간 기준 YYYY-MM-DD (util.ts kstDate)."""
    t = time.time() if now is None else now
    return datetime.fromtimestamp(int(t) + KST_OFFSET_S, UTC).strftime("%Y-%m-%d")


class DailyIpHasher:
    """그날만 유효한 IP 해시: base64url(sha256(소금16 || ip)) 앞 22자."""

    def __init__(self) -> None:
        self._day = ""
        self._salt = secrets.token_bytes(16)

    def __call__(self, ip: str) -> str:
        day = kst_date()
        if day != self._day:
            self._day = day
            self._salt = secrets.token_bytes(16)
        digest = hashlib.sha256(self._salt + ip.encode("utf-8", "surrogatepass")).digest()
        return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")[:22]


#: 프로세스에 하나 (Node security.ts의 모듈 변수와 같음)
ip_hash = DailyIpHasher()
