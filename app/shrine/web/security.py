"""모든 응답에 붙이는 보안 머리글 (http.ts securityHeaders).

운영자 화면처럼 다른 값이 필요한 응답은 같은 이름의 머리글을 직접 적으면 그 값으로 바뀝니다 (front.merge_headers).
"""

from __future__ import annotations

import re

from ..config import Config

_HOST_JUNK = re.compile(r"[^a-z0-9.:-]", re.IGNORECASE | re.ASCII)


def security_headers(config: Config, host_header: str | None) -> list[tuple[str, str]]:
    host = _HOST_JUNK.sub("", host_header or "")
    ws_origin = re.sub(r"^http", "ws", config.public_origin) if config.public_origin else f"ws://{host}"
    csp = "; ".join(
        [
            "default-src 'self'",
            "script-src 'self' https://challenges.cloudflare.com",
            "frame-src https://challenges.cloudflare.com",
            f"connect-src 'self' {ws_origin}",
            "img-src 'self' data: blob:",
            "style-src 'self'",
            "font-src 'self'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ]
    )
    headers = [
        ("Content-Security-Policy", csp),
        ("X-Content-Type-Options", "nosniff"),
        ("Referrer-Policy", "strict-origin-when-cross-origin"),
        ("X-Frame-Options", "DENY"),
        ("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()"),
        ("Cross-Origin-Opener-Policy", "same-origin"),
    ]
    if config.is_prod:
        headers.append(("Strict-Transport-Security", "max-age=31536000"))
    if not config.allow_indexing:
        headers.append(("X-Robots-Tag", "noindex, nofollow"))
    return headers


def merge_headers(base: list[tuple[bytes, bytes]], extra: list[tuple[bytes, bytes]]) -> list[tuple[bytes, bytes]]:
    """Node의 setHeader(먼저) + writeHead(나중)와 같게: 보안 머리글과 같은 이름이면 그 자리의 값을 바꾸고,
    나머지는 적은 순서대로 뒤에 붙입니다 (Set-Cookie처럼 같은 이름이 여러 줄이어도 그대로)."""
    out = list(base)
    index = {k.lower(): i for i, (k, _) in enumerate(out)}
    for k, v in extra:
        i = index.pop(k.lower(), None)
        if i is None:
            out.append((k, v))
        else:
            out[i] = (out[i][0], v)
    return out
