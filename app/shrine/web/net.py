"""요청 머리글 · 방문자 IP · 그날 IP 해시 (security.ts clientIp · ipHash).

IP는 그날만 쓰는 무작위 값(소금)과 섞은 해시로만 다룹니다. 소금은 이 프로세스 메모리에만 있고(디스크 · Redis에
두지 않음) 한국 날짜가 바뀌면 새로 만듭니다. 그래서 Redis에 남는 요청 제한 키로 원래 IP를 되찾을 수 없고,
서버를 다시 띄우면 같은 IP도 다른 해시가 됩니다 (Node와 같음).
"""

from __future__ import annotations

from ..logic.crypto import DailyIpHasher, normalize_ip
from ..logic.jsstr import js_trim

# Node가 같은 이름 머리글을 여러 번 받으면 버리고 첫 값만 두는 것 (그 밖은 ', '로 이음, cookie는 '; ')
_DISCARD_DUPLICATES = frozenset(
    {
        "age", "authorization", "content-length", "content-type", "etag", "expires", "from", "host",
        "if-modified-since", "if-unmodified-since", "last-modified", "location", "max-forwards",
        "proxy-authorization", "referer", "retry-after", "server", "user-agent",
    }
)

# Node http 서버 maxHeadersCount (main.ts:45). Node는 넘는 머리글을 버리지만, 여기서는 431로 거절합니다
# (보안 점검: 버리면 X-Forwarded-For가 빠져 IP별 제한 · 차단을 비켜 갈 수 있었음. web/front.py)
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


class _LimitIpHasher(DailyIpHasher):
    """요청 제한 키용: IPv6는 /64, ::ffff:a.b.c.d는 IPv4로 묶은 뒤 해시합니다 (차단 키 block_key와 같은 단위).

    보안 점검: Node는 IPv6 주소 전체(/128)를 해시해서, /64 하나를 가진 사람이 주소만 바꿔 가며 IP별 제한
    (요청 · 입장 · 접수 · PIN · 업로드 하루 한도 등)을 새로 받을 수 있었습니다. IP가 아닌 값은 그대로 해시합니다.
    """

    def __call__(self, ip: str) -> str:
        return super().__call__(normalize_ip(ip) or ip)


#: 그날만 유효한 IP 해시: base64url(sha256(소금16 || IPv4 또는 IPv6 /64)) 앞 22자 (logic.crypto.DailyIpHasher).
#: 프로세스에 하나 (Node security.ts의 모듈 변수와 같음). 실시간(realtime/core.py)도 이것을 씁니다
ip_hash = _LimitIpHasher()
