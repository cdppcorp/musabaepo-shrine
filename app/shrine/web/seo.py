"""검색 · 보안 안내 (http.ts 323-341): /robots.txt (모든 메서드) · /.well-known/security.txt (GET/HEAD).

둘 다 BASE_PATH와 상관없이 도메인 루트에만 있습니다. front.py가 요청 제한 바로 뒤에서 부릅니다.
사이트맵(${BASE}/sitemap.xml)은 pages.py에 있습니다.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime

from ..config import Config


def robots(config: Config) -> str:
    if not config.allow_indexing:
        return "User-agent: *\nDisallow: /\n"
    base = config.base_path
    lines = ["User-agent: *", f"Disallow: {base}/go/", f"Disallow: {base}/api/"]
    if config.public_origin:
        lines += ["", f"Sitemap: {config.public_origin}{base}/sitemap.xml"]
    return "\n".join(lines) + "\n"


def security_txt(config: Config, now: float | None = None) -> str:
    """RFC 9116 security.txt. 연락처(CONTACT_EMAIL)가 있을 때만 부릅니다."""
    t = time.time() if now is None else now
    expires_ms = int(t * 1000) + 365 * 24 * 3600_000
    expires = datetime.fromtimestamp(expires_ms // 1000, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines = [f"Contact: mailto:{config.contact_email}", f"Expires: {expires}", "Preferred-Languages: ko, en"]
    if config.public_origin:
        lines.append(f"Canonical: {config.public_origin}/.well-known/security.txt")
    return "\n".join(lines) + "\n"
