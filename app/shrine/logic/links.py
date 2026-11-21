"""사당 링크 · 입점 규칙: server/shrines.ts:51-160 · 214-275와 registry.ts의 링크 · 이메일 · slug 함수를 옮겼습니다.

| 함수 · 상수 | 원본 |
|---|---|
| ``PRAYER_KEYS`` · ``CHARM_KEYS`` · ``DECO_KEYS`` · ``CATEGORY_KEYS`` · ``is_prayer_key`` | shrines.ts:10-17 |
| ``SLUG_RE`` · ``DOMAIN_RE`` · ``DATE_RE`` · ``SCREEN_RE`` · ``UPLOAD_SCREEN_RE`` | shrines.ts:54-59 |
| ``chars`` · ``GITHUB_OWNER`` · ``GITHUB_REPO`` · ``EMAIL_RE`` | shrines.ts:61-64 |
| ``parse_github`` | shrines.ts:67-85 ``parseGithub`` |
| ``normalize_service_url`` | shrines.ts:88-103 ``normalizeServiceUrl`` |
| ``is_valid_email`` | shrines.ts:105 ``isValidEmail`` |
| ``is_github_domain`` | shrines.ts:108 |
| ``is_safe_shrine_url`` · ``is_allowed_service_url`` | shrines.ts:111-128 |
| ``validate_shrine`` | shrines.ts:131-160 ``validateShrine`` |
| ``from_row`` | shrines.ts:214-231 ``fromRow`` |
| ``public_shrine`` | shrines.ts:266-275 ``publicShrine`` |
| ``read_links`` · ``domain_of`` · ``clean_email`` | registry.ts:144-182 |
| ``slugify`` · ``unique_slug`` | registry.ts:630-645 (``uniqueSlug``는 DB에서 읽은 slug 집합을 받는 꼴로) |
| ``free_plots`` | shrines.ts:172-175 ``freePlotsIn`` (DB에서 읽은 찬 자리 집합을 받는 꼴로) |

``new URL()``은 ``weburl.parse_special_url``(WHATWG, Node 24 = Ada 3.4.2와 같은 결과)로 대신합니다.
JS 정규식 ``^…$``는 ``fullmatch``로 (Python ``$``는 끝 줄바꿈 앞에서도 맞아 버림), u 플래그 없는 ``i``는 ``re.ASCII``로,
``EMAIL_RE``의 ``{1,64}``는 UTF-16 코드 단위를 세므로 ``to_utf16_units``로 바꾼 문자열에 겁니다.
Shrine은 TS ``Shrine`` 인터페이스와 같은 camelCase 키의 dict입니다.
"""

from __future__ import annotations

import math
import re
import secrets
from collections.abc import Container, Mapping
from typing import Any

from .jsnum import JSONParseError, is_integer, json_parse
from .jsstr import JS_WS_CLASS, canonical, code_points, js_lower, js_trim, to_utf16_units, utf16_len
from .util import days_since
from .weburl import InvalidURL, is_ip, parse_special_url
from .world import CHANNELS, PLOTS, is_channel

__all__ = [
    "CATEGORY_KEYS",
    "CHARM_KEYS",
    "DECO_KEYS",
    "PRAYER_KEYS",
    "chars",
    "clean_email",
    "domain_of",
    "from_row",
    "is_allowed_service_url",
    "is_github_domain",
    "is_prayer_key",
    "is_safe_shrine_url",
    "is_valid_email",
    "normalize_service_url",
    "parse_github",
    "public_shrine",
    "read_links",
    "free_plots",
    "slugify",
    "unique_slug",
    "validate_shrine",
]

PRAYER_KEYS: tuple[str, ...] = ("deploy", "security", "success", "bug", "payment", "uptime")
CHARM_KEYS: tuple[str, ...] = ("zero-downtime", "no-rollback", "no-cve", "no-friday", "prod-db", "no-404")
DECO_KEYS: tuple[str, ...] = ("duck", "coffee", "makgeolli", "cat", "cactus")
CATEGORY_KEYS: tuple[str, ...] = ("business", "productivity", "commerce", "education", "devtools", "content", "life", "etc")


def is_prayer_key(v: object) -> bool:
    return isinstance(v, str) and v in PRAYER_KEYS


SLUG_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?")
DOMAIN_RE = re.compile(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}")
DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
SCREEN_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,60}\.(?:jpg|jpeg|png|webp)")
UPLOAD_SCREEN_RE = re.compile(r"up/[A-Za-z0-9_-]{16}\.(?:png|jpg|webp)")
GITHUB_OWNER = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})")
GITHUB_REPO = re.compile(r"[A-Za-z0-9._-]{1,100}")
EMAIL_RE = re.compile(
    r"[^" + JS_WS_CLASS + r"@<>()\"',;:]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+",
    re.IGNORECASE | re.ASCII,
)
_HTTP_PREFIX = re.compile(r"https?://", re.IGNORECASE | re.ASCII)
_ANY_SCHEME = re.compile(r"[a-z][a-z0-9+.-]*:", re.IGNORECASE | re.ASCII)
_DOT_GIT = re.compile(r"\.git\Z", re.IGNORECASE | re.ASCII)
_GITHUB_DOMAIN = re.compile(r"github\.com/[a-z0-9-]+/[a-z0-9._-]+")


def _full(rx: re.Pattern[str], s: object) -> bool:
    return isinstance(s, str) and rx.fullmatch(s) is not None


def chars(s: str) -> int:
    """shrines.ts:61 ``Array.from(s).length`` (코드 포인트 수)."""
    return code_points(s)


def _strip_brackets(host: str) -> str:
    """``host.replace(/^\\[|\\]$/g, '')``"""
    if host.startswith("["):
        host = host[1:]
    if host.endswith("]"):
        host = host[:-1]
    return host


def _url(text: str):  # noqa: ANN202
    try:
        return parse_special_url(text)
    except InvalidURL:  # UnsupportedScheme 포함: protocol이 https가 아니라 어차피 거절
        return None


def parse_github(raw: str) -> dict[str, str] | None:
    """shrines.ts ``parseGithub``: ``{url, key, owner, repo}`` (key는 소문자 ``github.com/owner/repo``) 또는 None."""
    text = js_trim(raw)
    if not text:
        return None
    if not _HTTP_PREFIX.match(text):
        text = f"https://{text}"
    u = _url(text)
    if u is None or u.scheme != "https" or u.username or u.password or u.port_str:
        return None
    host = u.hostname.lower()
    if host not in ("github.com", "www.github.com"):
        return None
    parts = [p for p in u.pathname.rstrip("/").split("/") if p]
    if len(parts) != 2:
        return None
    owner = parts[0]
    repo = _DOT_GIT.sub("", parts[1], count=1)
    if not _full(GITHUB_OWNER, owner) or not _full(GITHUB_REPO, repo) or repo in (".", ".."):
        return None
    return {"url": f"https://github.com/{owner}/{repo}", "key": f"github.com/{owner}/{repo}".lower(), "owner": owner, "repo": repo}


def normalize_service_url(raw: str) -> dict[str, str] | None:
    """shrines.ts ``normalizeServiceUrl``: ``{url: 'https://host/path', host}`` 또는 None."""
    text = js_trim(raw)
    if not text or utf16_len(text) > 200:
        return None
    if not _ANY_SCHEME.match(text):
        text = f"https://{text}"
    u = _url(text)
    if u is None or u.scheme != "https" or u.username or u.password or u.port_str:
        return None
    host = js_lower(u.hostname)
    if is_ip(_strip_brackets(host)) != 0 or not _full(DOMAIN_RE, host) or host == "localhost" or host.endswith(".localhost"):
        return None
    path = "" if u.pathname == "/" else u.pathname.rstrip("/")
    return {"url": f"https://{host}{path}", "host": host}


def is_valid_email(v: str) -> bool:
    """shrines.ts:105: 80 코드 단위 이하 + EMAIL_RE (지역 부분 1~64 코드 단위)."""
    return isinstance(v, str) and utf16_len(v) <= 80 and EMAIL_RE.fullmatch(to_utf16_units(v)) is not None


def is_github_domain(domain: str) -> bool:
    return _full(_GITHUB_DOMAIN, domain)


def is_allowed_service_url(raw: str, domain: str) -> bool:
    """shrines.ts ``isAllowedServiceUrl``: https, 계정 · 포트 없음, IP 아님, host가 domain이거나 그 하위 도메인."""
    u = _url(raw)
    if u is None or u.scheme != "https" or u.username or u.password or u.port_str:
        return False
    host = js_lower(u.hostname)
    if is_ip(_strip_brackets(host)) != 0:
        return False
    return host == domain or host.endswith(f".{domain}")


def is_safe_shrine_url(s: Mapping[str, Any]) -> bool:
    """shrines.ts ``isSafeShrineUrl``: GitHub 전용 사당이면 url의 key가 domain과 같아야, 아니면 ``is_allowed_service_url``."""
    if is_github_domain(s["domain"]):
        g = parse_github(s["url"])
        return g is not None and g["key"] == s["domain"]
    return is_allowed_service_url(s["url"], s["domain"])


def validate_shrine(s: Mapping[str, Any]) -> list[str]:
    """shrines.ts ``validateShrine``: 어긋난 이유 목록 (빈 목록 = 통과). 메시지 글자도 같습니다."""
    e: list[str] = []
    if not _full(SLUG_RE, s["slug"]):
        e.append("slug 형식")
    if chars(s["name"]) < 1 or chars(s["name"]) > 20:
        e.append("서비스명 1~20자")
    if chars(s["tagline"]) < 1 or chars(s["tagline"]) > 40:
        e.append("한 줄 소개 1~40자")
    if chars(s.get("sign") or "") > 8:
        e.append("사당 소개는 공백 포함 8자까지")
    if s["category"] not in CATEGORY_KEYS:
        e.append("카테고리")
    github = is_github_domain(s["domain"])
    if not github and (not _full(DOMAIN_RE, s["domain"]) or is_ip(s["domain"]) != 0):
        e.append("도메인 형식 (IP 주소 불가)")
    if not is_safe_shrine_url(s):
        e.append("대표 링크는 그 GitHub 저장소 주소" if github else "대표 링크는 https + 그 도메인 안")
    if s["repo"] and not parse_github(s["repo"]):
        e.append("GitHub 저장소 주소 형식")
    if s["email"] and not is_valid_email(s["email"]):
        e.append("이메일 형식")
    if not js_trim(s["operator"]) or chars(s["operator"]) > 20:
        e.append("운영자 표시명")
    if s["verifiedDomain"] and not _full(DATE_RE, s["verifiedDomain"]):
        e.append("도메인 확인 날짜 형식")
    if not s["verifiedDomain"] and not s["projectId"]:
        e.append("도메인 확인 날짜 (직접 넣는 사당)")
    if s["verifiedBusiness"] and not _full(DATE_RE, s["verifiedBusiness"]):
        e.append("사업자 확인 날짜 형식")
    if not _full(DATE_RE, s["joinedAt"]) or not _full(DATE_RE, s["capturedAt"]):
        e.append("날짜 형식")
    if s["status"] not in ("live", "check"):
        e.append("상태")
    if not is_prayer_key(s["prayer"]):
        e.append("현판 기원")
    if s["charm"] and s["charm"] not in CHARM_KEYS:
        e.append("부적")
    if len(s["deco"]) > 3 or any(d not in DECO_KEYS for d in s["deco"]):
        e.append("소품 최대 3개")

    def ok_screen(f: str) -> bool:
        return _full(SCREEN_RE, f) or _full(UPLOAD_SCREEN_RE, f)

    screens = s["screens"]
    if len(screens) < (0 if s["projectId"] else 1) or len(screens) > 3 or any(not ok_screen(f) for f in screens):
        e.append("실제 화면 1~3장")
    if not is_channel(s["channel"]):
        e.append(f"채널 (1~{CHANNELS})")
    plot = s["plot"]
    if not is_integer(plot) or not (0 <= plot < len(PLOTS)):
        e.append("자리 번호")
    return e


def _list(raw: Any) -> list[str]:
    try:
        v = json_parse(raw) if isinstance(raw, str) else None
    except JSONParseError:
        return []
    return [x for x in v if isinstance(x, str)] if isinstance(v, list) else []


def from_row(r: Mapping[str, Any]) -> dict[str, Any]:
    """shrines.ts ``fromRow``: DB 행(snake_case) → Shrine(camelCase). deco · screens는 JSON 글자."""

    def nz(k: str, d: Any) -> Any:
        v = r.get(k)
        return d if v is None else v

    return {
        "slug": r["slug"], "name": r["name"], "tagline": r["tagline"], "category": r["category"], "domain": r["domain"], "url": r["url"],
        "operator": r["operator"], "keeper": r["keeper"] == 1, "paid": r["paid"] == 1, "verifiedDomain": r["verified_domain"],
        "verifiedBusiness": r["verified_business"], "joinedAt": r["joined_at"], "status": r["status"], "prayer": r["prayer"],
        "charm": r["charm"], "deco": _list(r["deco"]), "screens": _list(r["screens"]), "capturedAt": r["captured_at"],
        "channel": nz("channel", 1), "plot": r["plot"],
        "repo": nz("repo", ""), "email": nz("email", ""), "emailPublic": r.get("email_public") == 1, "projectId": nz("project_id", 0),
        "sign": nz("sign", ""),
    }  # fmt: skip


def public_shrine(s: Mapping[str, Any], now: int | None = None) -> dict[str, Any]:
    """shrines.ts ``publicShrine``: 화면으로 보내는 모양 (url · paid 빼고, email은 공개일 때만). 키 순서도 같습니다."""
    days = days_since(s["joinedAt"], now)
    out: dict[str, Any] = {
        "repo": s["repo"],
        "fromProject": s["projectId"] > 0,
        "sign": s["sign"] or js_trim("".join(list(canonical(s["tagline"]))[:8])),
    }
    if s["emailPublic"] and s["email"]:
        out["email"] = s["email"]
    out.update({
        "slug": s["slug"], "name": s["name"], "tagline": s["tagline"], "category": s["category"], "domain": s["domain"],
        "operator": s["operator"], "keeper": s["keeper"], "business": bool(s["verifiedBusiness"]), "verifiedDomain": s["verifiedDomain"],
        "verifiedBusiness": s["verifiedBusiness"], "joinedAt": s["joinedAt"], "status": s["status"], "prayer": s["prayer"],
        "charm": s["charm"], "deco": s["deco"], "screens": s["screens"], "capturedAt": s["capturedAt"], "channel": s["channel"],
        "plot": s["plot"],
        "isNew": (not math.isnan(days)) and 0 <= days < 7,
    })  # fmt: skip
    return out


# ── registry.ts ──────────────────────────────────────────────────────


#: 이메일에 받지 않는 글자: 제어 문자(Cc, NUL 포함) · 짝 없는 서로게이트(Cs)
_EMAIL_BAD = re.compile("[\x00-\x1f\x7f-\x9f\ud800-\udfff]")


def clean_email(raw: Any) -> str | None:
    """registry.ts:144-148 ``cleanEmail``: trim · 소문자 뒤 ``is_valid_email``.

    보안 점검 (Node와 일부러 다름): ``EMAIL_RE``는 지역 부분에 제어 문자 · 짝 없는 서로게이트도 받아서
    DB 오류(500)가 났습니다. 그런 글자가 있으면 None (``is_valid_email``은 Node와 같게 둠)."""
    if not isinstance(raw, str):
        return None
    e = js_lower(js_trim(raw))
    if _EMAIL_BAD.search(canonical(e)):
        return None
    return e if is_valid_email(e) else None


def _fail(status: int, reason: str) -> dict[str, Any]:
    return {"ok": False, "status": status, "reason": reason}


def read_links(github_raw: Any, url_raw: Any) -> dict[str, Any]:
    """registry.ts:153-176 ``readLinks``: ``{ok: True, links: {github, url}}`` 또는 실패 dict (reason link · github · url).

    서비스 주소 칸에 GitHub 주소를 넣으면 GitHub로 봅니다. JS ``null`` · ``undefined``는 None으로 넘기세요.
    """
    g_text = js_trim(github_raw) if isinstance(github_raw, str) else ""
    u_text = js_trim(url_raw) if isinstance(url_raw, str) else ""
    if (github_raw is not None and not isinstance(github_raw, str)) or (url_raw is not None and not isinstance(url_raw, str)):
        return _fail(400, "link")
    github = ""
    url = ""
    if g_text:
        g = parse_github(g_text)
        if not g:
            return _fail(400, "github")
        github = g["url"]
    if u_text:
        as_github = parse_github(u_text)
        if as_github and not github:
            github = as_github["url"]
        else:
            u = normalize_service_url(u_text)
            if not u:
                return _fail(400, "url")
            if u["host"] in ("github.com", "www.github.com"):
                return _fail(400, "url")
            url = u["url"]
    if not github and not url:
        return _fail(400, "link")
    return {"ok": True, "links": {"github": github, "url": url}}


def domain_of(links: Mapping[str, str]) -> str:
    """registry.ts:179-182 ``domainOf``: 서비스 주소가 있으면 그 호스트, 없으면 ``github.com/owner/repo``."""
    if links["url"]:
        u = normalize_service_url(links["url"])
        return u["host"] if u else ""
    g = parse_github(links["github"])
    return g["key"] if g else ""


_NOT_SLUG = re.compile(r"[^a-z0-9]+")


def slugify(text: str) -> str:
    """registry.ts:630-632 ``slugify``: 소문자 → a-z0-9 아닌 묶음은 '-' → 앞뒤 '-' 떼고 40자 → 끝 '-' 떼기."""
    s = _NOT_SLUG.sub("-", js_lower(text))
    s = s.strip("-")[:40]
    return s.rstrip("-")


def unique_slug(base: str, taken: Container[str]) -> str:
    """registry.ts:634-645 ``uniqueSlug``: 겹치면 ``<앞 36자>-2`` … ``-999``, 그래도 겹치면 ``<앞 30자>-<무작위 6자 16진>``.

    ``taken``은 shrines.slug ∪ projects.slug(빈 값 제외). Node는 동기 DB라 읽고 쓰는 사이가 안전했지만, 비동기 DB에서는
    INSERT를 UNIQUE 제약 + 재시도로 감싸야 합니다.
    """
    if base not in taken:
        return base
    for i in range(2, 1000):
        s = f"{base[:36]}-{i}"
        if s not in taken:
            return s
    return f"{base[:30]}-{secrets.token_hex(3)}"


def free_plots(used: Container[int]) -> list[int]:
    """shrines.ts:172-175 ``freePlotsIn``: 그 채널의 빈 자리 번호 (작은 번호부터). ``used``는 그 채널의 찬 자리."""
    return [p["id"] for p in PLOTS if p["id"] not in used]
