"""서명 · 해시: 입장 표, 그날 IP 해시, IP 차단 키, 운영자 세션, PIN. Node가 만든 값을 Python이 읽고, 그 반대도 됩니다.

| 함수 | 원본 |
|---|---|
| ``b64url`` | ``buf.toString('base64url')`` (패딩 없음) |
| ``node_base64_decode`` | ``Buffer.from(s, 'base64url')`` — 잘못된 글자는 건너뛰고 ``=``에서 멈추는 관대한 디코드 (nbytes Base64Decode) |
| ``parse_cookies`` | security.ts:75-82 ``parseCookies`` |
| ``TICKET_TTL_MS`` · ``TICKET_COOKIE`` · ``sign_ticket`` · ``verify_ticket`` | security.ts:47-73 |
| ``DailyIpHasher`` | security.ts:22-33 ``ipHash`` (소금은 KST 날짜가 바뀔 때 새로) |
| ``make_nick`` | security.ts:86-91 ``makeNick`` |
| ``ip_key_mac`` · ``normalize_ip`` · ``block_key`` · ``KEY_RE`` | moderation.ts:66-102 (+ ``KEY_RE`` 정의) |
| ``admin_keys`` · ``norm_admin_ip`` · ``admin_ip_hash`` | admin.ts:56-73, 214 |
| ``sign_session`` · ``read_session`` · ``new_session`` · ``SESSION_MS`` · ``ADMIN_COOKIE`` | admin.ts:40-41, 149-179, 249 |
| ``admin_password_ok`` | admin.ts:241-242 |
| ``is_loopback_host`` · ``session_cookie`` | admin.ts:181-189 |
| ``hash_pin`` · ``pin_matches`` | registry.ts:233-244 (scrypt N=16384 r=8 p=1, 32바이트, ``salt:hash`` base64url) |

문자열 → 바이트는 모두 ``jsstr.utf8_encode`` (짝 없는 서로게이트 → EF BF BD, Node와 같음)입니다.
비밀 값(TICKET_SECRET 등)도 Node처럼 UTF-8 바이트를 HMAC 키로 씁니다.

Node와 일부러 똑같이 둔 버릇 (고칠지는 연결하는 쪽이 정합니다):

- ``verify_ticket`` · ``read_session``의 서명 비교는 ``Buffer.from(sig, 'base64url')``이라 서명 뒤에 잘못된 글자 · ``=`` 뒤 글자가
  붙어도 통과합니다 (``…sig!!``, ``…sig=x``). 본문 쪽은 서명이 본문 글자 그대로에 걸려 있어 바꿀 수 없습니다.
- ``verify_ticket``은 ``.``으로 나눈 앞 두 조각만 봅니다 (``a.b.c``도 통과할 수 있음). ``read_session``은 정확히 두 조각.
- ``pin_matches``: 저장값의 해시 부분이 빈 바이트로 풀리면(``salt:!!``) scrypt 길이 0끼리 비교라 어떤 PIN이든 맞습니다.
  저장값은 서버만 만들므로(늘 32바이트) 실제로는 생기지 않습니다.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
from collections.abc import Callable, Collection, Mapping
from typing import Any

from .jsnum import JSONParseError, is_number, json_parse, json_stringify
from .jsstr import js_lower, js_trim, to_utf16_units, utf8_decode, utf8_encode, utf16_len
from .util import kst_date, now_ms
from .weburl import is_ip
from .world import is_valid_look

__all__ = [
    "ADMIN_COOKIE",
    "KEY_RE",
    "SESSION_MS",
    "TICKET_COOKIE",
    "TICKET_TTL_MS",
    "DailyIpHasher",
    "AdminKeys",
    "admin_ip_hash",
    "admin_keys",
    "admin_password_ok",
    "b64url",
    "block_key",
    "hash_pin",
    "ip_key_mac",
    "is_loopback_host",
    "make_nick",
    "new_session",
    "node_base64_decode",
    "norm_admin_ip",
    "normalize_ip",
    "parse_cookies",
    "pin_matches",
    "read_session",
    "session_cookie",
    "sign_session",
    "sign_ticket",
    "verify_ticket",
]


# ── base64url ────────────────────────────────────────────────────────


def b64url(data: bytes) -> str:
    """``buf.toString('base64url')``: URL 안전 알파벳, ``=`` 없음."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


_UNB64 = [-1] * 256
for _i, _ch in enumerate("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"):
    _UNB64[ord(_ch)] = _i
_UNB64[ord("-")] = 62
_UNB64[ord("_")] = 63


def _unb(c: int) -> int:
    # Node 24.14: 0xFF를 넘는 코드 단위는 아래 8비트로 잘라 표를 봅니다 ('Ł'(U+0141) → 'A')
    v = _UNB64[c & 0xFF]
    return 255 if v < 0 else v


def node_base64_decode(s: str) -> bytes:
    """``Buffer.from(s, 'base64url')`` (Node 24.14, 1024자 미만 문자열).

    base64 · base64url 두 알파벳을 다 받고, 그 밖의 글자(공백 포함)는 건너뛰며, 묶음 중간의 ``=``에서 멈춥니다.
    마지막 조각의 남는 비트는 버립니다. 1글자만 남은 조각은 버립니다. U+00FF를 넘는 코드 단위는 아래 8비트로 봅니다
    (Node 그대로: ``Ł``(U+0141)은 ``A``, 이모지의 앞 서로게이트 U+D83D는 ``=``라서 거기서 멈춤). 쿠키 값은 latin-1이라 실제로는 해당 없음.
    """
    src = [ord(c) for c in to_utf16_units(s)]
    srclen = len(src)
    # nbytes Base64DecodedSize (끝의 '=' 두 개까지 빼고 계산)
    size = srclen
    if size < 2:
        decoded_size = 0
    else:
        if src[size - 1] == 0x3D:
            size -= 1
            if src[size - 1] == 0x3D:
                size -= 1
        decoded_size = (size // 4) * 3 + (size % 4 + 1) // 2 if size > 1 else 0
    # buffer.js fromStringFast: 짧은 문자열은 글자 수 × 4 크기로 잡고 씁니다
    dstlen = srclen * 4
    dst = bytearray()
    available = min(dstlen, decoded_size)
    max_k = available // 3 * 3
    max_i = srclen // 4 * 4
    i = 0

    def slow(i: int) -> tuple[bool, int]:
        hi = 0
        for step in range(4):
            while True:
                c = src[i] & 0xFF  # Node 24.14(nbytes): 코드 단위를 8비트로 자른 뒤 '='와 비교 (U+D83D → '=')
                lo = _unb(c)
                i += 1
                if lo < 64:
                    break
                if c == 0x3D or i >= srclen:
                    return False, i
            if step == 1:
                dst.append(((hi & 0x3F) << 2) | ((lo & 0x30) >> 4))
            elif step == 2:
                dst.append(((hi & 0x0F) << 4) | ((lo & 0x3C) >> 2))
            elif step == 3:
                dst.append(((hi & 0x03) << 6) | (lo & 0x3F))
            if i >= srclen:
                return False, i
            if len(dst) >= dstlen:
                return False, i
            hi = lo
        return True, i

    while i < max_i and len(dst) < max_k:
        txt = [_unb(src[i + j]) for j in range(4)]
        if any(t >= 64 for t in txt):
            ok, i = slow(i)
            if not ok:
                return bytes(dst)
            max_i = i + (srclen - i) // 4 * 4
        else:
            v = (txt[0] << 18) | (txt[1] << 12) | (txt[2] << 6) | txt[3]
            dst += bytes(((v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF))
            i += 4
    if i < srclen and len(dst) < dstlen:
        slow(i)
    return bytes(dst)


def _hmac(key: bytes, *parts: bytes) -> bytes:
    h = hmac.new(key, digestmod=hashlib.sha256)
    for p in parts:
        h.update(p)
    return h.digest()


def _secret_bytes(secret: str | bytes) -> bytes:
    return secret if isinstance(secret, bytes) else utf8_encode(secret)


# ── 쿠키 ─────────────────────────────────────────────────────────────


def parse_cookies(header: str | None) -> dict[str, str]:
    """security.ts ``parseCookies``: ``;``로 나누고 첫 ``=``에서 잘라 양쪽 trim. URL 디코드 없음. 같은 이름은 뒤의 값.

    JS 객체에 ``__proto__``라는 이름으로 문자열을 넣으면 무시되므로 그 이름은 뺍니다.
    """
    out: dict[str, str] = {}
    for part in (header or "").split(";"):
        i = part.find("=")
        if i > 0:
            k = js_trim(part[:i])
            if k == "__proto__":
                continue
            out[k] = js_trim(part[i + 1 :])
    return out


# ── 입장 표 ──────────────────────────────────────────────────────────

TICKET_TTL_MS = 3 * 60 * 60 * 1000
TICKET_COOKIE = "shrine_ticket"


def _mac(secret: str | bytes, body: str) -> bytes:
    return _hmac(_secret_bytes(secret), utf8_encode(body))


def sign_ticket(ticket: Mapping[str, Any], secret: str | bytes) -> str:
    """security.ts ``signTicket``: ``base64url(JSON.stringify(t))`` + ``.`` + ``base64url(HMAC(secret, 앞부분))``.

    키 순서는 넘긴 dict 순서 그대로입니다. Node(http.ts:179)는 ``{sid, look, nick, exp}``.
    """
    body = b64url(utf8_encode(json_stringify(ticket) or ""))
    return f"{body}.{b64url(_mac(secret, body))}"


def _check_signed(body: str, sig: str, key_mac: Callable[[str], bytes]) -> Any:
    expected = key_mac(body)
    got = node_base64_decode(sig)
    if len(got) != len(expected) or not hmac.compare_digest(got, expected):
        return None
    try:
        v = json_parse(utf8_decode(node_base64_decode(body)))
    except JSONParseError:
        return None
    return v if isinstance(v, dict) else None


def verify_ticket(raw: str | None, secret: str | bytes, now: int | None = None) -> dict[str, Any] | None:
    """security.ts ``verifyTicket``: 통과하면 표(dict, 받은 그대로), 아니면 None."""
    if not raw or utf16_len(raw) > 600:
        return None
    parts = raw.split(".")
    body = parts[0]
    sig = parts[1] if len(parts) > 1 else ""
    if not body or not sig:
        return None
    t = _check_signed(body, sig, lambda b: _mac(secret, b))
    if t is None:
        return None
    if not isinstance(t.get("sid"), str) or not isinstance(t.get("nick"), str) or not is_number(t.get("exp")):
        return None
    if not is_valid_look(t.get("look")):
        return None
    if t["exp"] < (now_ms() if now is None else now):
        return None
    return t


# ── 그날 IP 해시 ─────────────────────────────────────────────────────


class DailyIpHasher:
    """security.ts ``ipHash``: ``sha256(salt16 || ip)``의 base64url 앞 22자. 소금은 KST 날짜가 바뀌면 새 무작위.

    Node는 프로세스 메모리에 소금을 둡니다. 워커가 여럿이면 소금을 공유해야(예: Redis에 날짜별로) 같은 IP가 같은 값이 됩니다.
    ``salt_for_day``를 넘기면 그 함수로 소금을 얻습니다 (기본은 이 객체 안의 무작위).
    """

    def __init__(
        self,
        salt_for_day: Callable[[str], bytes] | None = None,
        clock: Callable[[], int] = now_ms,
    ) -> None:
        self._salt_for_day = salt_for_day
        self._clock = clock
        self._day = ""
        self._salt = secrets.token_bytes(16)

    def salt(self) -> bytes:
        day = kst_date(self._clock())
        if day != self._day:
            self._day = day
            self._salt = self._salt_for_day(day) if self._salt_for_day else secrets.token_bytes(16)
        return self._salt

    def __call__(self, ip: str) -> str:
        return ip_hash_with_salt(self.salt(), ip)


def ip_hash_with_salt(salt: bytes, ip: str) -> str:
    return b64url(hashlib.sha256(salt + utf8_encode(ip)).digest())[:22]


# ── 자동 닉네임 ──────────────────────────────────────────────────────

NICK_A = ("새벽의", "배포 중인", "커밋하는", "리뷰하는", "야근하는", "무사한", "테스트하는", "디버깅하는", "캐시 비운", "롤백 없는")
NICK_B = ("러버덕", "고양이", "개발자", "사장님", "서버", "선인장", "막걸리", "부적")


def make_nick() -> str:
    """security.ts ``makeNick``: ``'<A> <B> <10~99>'`` (crypto.randomInt와 같은 고른 분포)."""
    return f"{secrets.choice(NICK_A)} {secrets.choice(NICK_B)} {10 + secrets.randbelow(90)}"


# ── IP 차단 키 (moderation.ts) ───────────────────────────────────────

#: moderation.ts KEY_RE: 'k:' + base64url 32자
KEY_RE = re.compile(r"k:[A-Za-z0-9_-]{32}")


def ip_key_mac(secret: str | bytes) -> bytes:
    """moderation.ts:66 ``ipKeyMac = HMAC(TICKET_SECRET, 'shrine-block-ip\\0')``."""
    return _hmac(_secret_bytes(secret), b"shrine-block-ip\x00")


_V4_TAIL = re.compile(r"(.*:)([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)", re.DOTALL)


def _ipv6_prefix64(v: str) -> str:
    """moderation.ts:69-82 ``ipv6Prefix64``: 앞 64비트를 ``a:b:c:d::/64``로."""
    s = v
    m = _V4_TAIL.fullmatch(s)
    if m and "\n" not in s and "\r" not in s and "\u2028" not in s and "\u2029" not in s:
        a, b, c, d = (int(m.group(k)) for k in (2, 3, 4, 5))
        s = f"{m.group(1)}{((a << 8) | b):x}:{((c << 8) | d):x}"
    parts = s.split("::")
    head = parts[0].split(":") if parts[0] else []
    tail = parts[1].split(":") if len(parts) > 1 and parts[1] else []
    if len(parts) > 1:
        groups = [*head, *(["0"] * max(0, 8 - len(head) - len(tail))), *tail]
    else:
        groups = head
    return ":".join(f"{int(g or '0', 16):x}" for g in groups[:4]) + "::/64"


def normalize_ip(raw: str) -> str | None:
    """moderation.ts:85-95 ``normalizeIp``: IPv4는 그대로, ``::ffff:a.b.c.d``는 IPv4로, IPv6는 /64. IP가 아니면 None."""
    v = js_lower(js_trim(raw))
    if v.startswith("[") and v.endswith("]"):
        v = v[1:-1]
    zone = v.find("%")
    if zone > 0:
        v = v[:zone]
    if v.startswith("::ffff:") and is_ip(v[7:]) == 4:
        v = v[7:]
    family = is_ip(v)
    if family == 4:
        return v
    if family == 6:
        return _ipv6_prefix64(v)
    return None


def block_key(ip: str, secret: str | bytes | None = None, *, key_mac: bytes | None = None) -> str:
    """moderation.ts:98-102 ``blockKey``: ``'k:' + base64url(HMAC(ipKeyMac, normalizeIp(ip)))[:32]``. IP가 아니면 ''."""
    n = normalize_ip(ip)
    if not n:
        return ""
    if key_mac is None:
        if secret is None:
            raise TypeError("secret 또는 key_mac이 필요합니다")
        key_mac = ip_key_mac(secret)
    return "k:" + b64url(_hmac(key_mac, utf8_encode(n)))[:32]


# ── 운영자 세션 (admin.ts) ───────────────────────────────────────────

ADMIN_COOKIE = "shrine_admin"
SESSION_MS = 8 * 3600_000
PASSWORD_MAX = 256
SID_RE = re.compile(r"[A-Za-z0-9_-]{24}")


class AdminKeys:
    """admin.ts:63-73 ``setup()``의 키 묶음."""

    __slots__ = ("log_key", "pw_digest", "session_key")

    def __init__(self, pw_digest: bytes, session_key: bytes, log_key: bytes) -> None:
        self.pw_digest = pw_digest
        self.session_key = session_key
        self.log_key = log_key


def admin_keys(ticket_secret: str | bytes, admin_password: str) -> AdminKeys:
    """pwDigest = sha256(password), sessionKey = HMAC(TICKET_SECRET, 'shrine-admin-session\\0' || pwDigest),
    logKey = HMAC(TICKET_SECRET, 'shrine-admin-ip\\0')."""
    secret = _secret_bytes(ticket_secret)
    pw_digest = hashlib.sha256(utf8_encode(admin_password)).digest()
    session_key = _hmac(secret, b"shrine-admin-session\x00", pw_digest)
    log_key = _hmac(secret, b"shrine-admin-ip\x00")
    return AdminKeys(pw_digest, session_key, log_key)


def norm_admin_ip(raw: str) -> str:
    """admin.ts:56-59 ``normIp``: trim · 소문자, ``::ffff:a.b.c.d``는 IPv4로 (그 밖은 그대로)."""
    v = js_lower(js_trim(raw))
    return v[7:] if v.startswith("::ffff:") and is_ip(v[7:]) == 4 else v


def admin_ip_hash(ip: str, keys: AdminKeys) -> str:
    """admin.ts:214 ``adminIpHash``: HMAC(logKey, normIp(ip))의 base64url 앞 16자."""
    return b64url(_hmac(keys.log_key, utf8_encode(norm_admin_ip(ip))))[:16]


def admin_password_ok(pw: Any, keys: AdminKeys) -> bool:
    """admin.ts:241-242: 문자열 1~1024 코드 단위, sha256끼리 상수 시간 비교."""
    return (
        isinstance(pw, str)
        and 0 < utf16_len(pw) <= PASSWORD_MAX * 4
        and hmac.compare_digest(hashlib.sha256(utf8_encode(pw)).digest(), keys.pw_digest)
    )


def sign_session(s: Mapping[str, Any], keys: AdminKeys) -> str:
    """admin.ts:154-157 ``signSession``: 본문 ``JSON.stringify({k: 'admin', ...s})``."""
    body = b64url(utf8_encode(json_stringify({"k": "admin", **s}) or ""))
    return f"{body}.{b64url(_hmac(keys.session_key, utf8_encode(body)))}"


def new_session(now: int | None = None) -> dict[str, Any]:
    """admin.ts:249: ``{sid: randomBytes(18) base64url(24자), iat: now, exp: now + 8h}``."""
    n = now_ms() if now is None else now
    return {"sid": b64url(secrets.token_bytes(18)), "iat": n, "exp": n + SESSION_MS}


def read_session(
    raw: str | None, keys: AdminKeys, now: int | None = None, revoked: Collection[str] = ()
) -> dict[str, Any] | None:
    """admin.ts:159-179 ``readSession`` (쿠키 값만 받음): 통과하면 ``{sid, iat, exp}``."""
    if not raw or utf16_len(raw) > 400:
        return None
    parts = raw.split(".")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return None
    v = _check_signed(parts[0], parts[1], lambda b: _hmac(keys.session_key, utf8_encode(b)))
    if v is None:
        return None
    sid = v.get("sid")
    if v.get("k") != "admin" or not isinstance(sid, str) or not SID_RE.fullmatch(sid):
        return None
    iat, exp = v.get("iat"), v.get("exp")
    if not is_number(iat) or not is_number(exp):
        return None
    n = now_ms() if now is None else now
    if exp <= n or exp - iat > SESSION_MS or iat > n + 60_000:
        return None
    if sid in revoked:
        return None
    return {"sid": sid, "iat": iat, "exp": exp}


def is_loopback_host(host: str | None) -> bool:
    """admin.ts:181-184: localhost · *.localhost · 127.0.0.1 · ::1 (포트 · 괄호 떼고)."""
    h = re.sub(r"^\[|\]$", "", re.sub(r":[0-9]+$", "", js_lower(host or "")))
    return h == "localhost" or h.endswith(".localhost") or h == "127.0.0.1" or h == "::1"


def session_cookie(host: str | None, value: str, max_age_sec: int, base: str = "") -> str:
    """admin.ts:186-189 ``sessionCookie``: 루프백 호스트가 아니면 Secure."""
    secure = "" if is_loopback_host(host) else "; Secure"
    return f"{ADMIN_COOKIE}={value}; Path={base}/; Max-Age={max_age_sec}; HttpOnly; SameSite=Strict{secure}"


# ── PIN (registry.ts) ────────────────────────────────────────────────

_SCRYPT = {"n": 16384, "r": 8, "p": 1, "maxmem": 64 * 1024 * 1024}


def _scrypt(pin: str, salt: bytes, length: int) -> bytes:
    if length == 0:
        return b""  # Node scryptSync(…, 0)은 빈 Buffer
    return hashlib.scrypt(utf8_encode(pin), salt=salt, dklen=length, **_SCRYPT)


def hash_pin(pin: str, salt: bytes | None = None) -> str:
    """registry.ts:233-236 ``hashPin``: ``base64url(salt16) + ':' + base64url(scrypt(pin, salt, 32))``."""
    salt = secrets.token_bytes(16) if salt is None else salt
    return f"{b64url(salt)}:{b64url(_scrypt(pin, salt, 32))}"


def pin_matches(pin: str, stored: str) -> bool:
    """registry.ts:238-244 ``pinMatches``: 저장값을 관대한 base64url로 풀어 같은 길이로 scrypt, 상수 시간 비교."""
    parts = stored.split(":")
    salt_text = parts[0]
    hash_text = parts[1] if len(parts) > 1 else ""
    if not salt_text or not hash_text:
        return False
    want = node_base64_decode(hash_text)
    got = _scrypt(pin, node_base64_decode(salt_text), len(want))
    return len(got) == len(want) and hmac.compare_digest(got, want)
