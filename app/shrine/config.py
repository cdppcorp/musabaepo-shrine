"""환경 변수에서 설정을 읽고 검사합니다 (server/config.ts와 같은 이름 · 기본값 · 한국어 메시지).

  · 형식이 틀린 값(숫자 칸에 글자, true/false 칸에 다른 말 등)은 운영 · 개발 모두 시작하지 않습니다.
  · 운영(NODE_ENV=production)에서는 빠졌거나 약하거나 예시 그대로인 값도 시작하지 않습니다.
  · 개발에서는 안전한 기본값을 쓰고, 문제 있는 선택 값은 경고만 하고 그 기능을 끕니다.
문제는 한 번에 모두 모아서 보여 줍니다. 메시지 순서도 Node와 같습니다 (새 값 DATABASE_URL · REDIS_URL · PUBLIC_DIR은 맨 뒤).

Node와 다른 점 (일부러):
  · GITHUB_CHECK: Node는 검사는 대소문자 무시(on/off), 실제 사용(registry.ts)은 정확히 'off'만 봤습니다.
    여기서는 검사한 값(github_check)을 한곳에서 쓰므로 'OFF' · ' off '도 꺼짐입니다.
  · RETENTION_DAYS · PENDING_DAYS · BACKUP_*: Node는 다른 파일이 다시 읽었지만 여기서는 검사한 값을 그대로 둡니다.
"""

from __future__ import annotations

import os
import re
import secrets
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from .jscompat import JS_DOT, JS_WS_CLASS, is_ip, js_trim, utf16_len, utf16_units
from .whatwg import parse_http_url

MAX_SAFE_INTEGER = 9007199254740991

# 저장소 루트의 public/ (Docker 이미지도 같은 모양으로 둡니다: app/ 옆에 public/)
DEFAULT_PUBLIC_DIR = Path(__file__).resolve().parents[2] / "public"

# 예시로 흔히 넣는 글자. 무작위 16진 · base64 값에는 나오지 않는 말만 둡니다
EXAMPLE_WORDS = [
    "change", "example", "secret", "password", "passwd", "sample", "dummy", "replace", "your", "test", "todo",
    "xxxx", "qwer", "admin",
]

_REPEAT_ONE = re.compile(f"({JS_DOT})\\1{{5,}}")
_REPEAT_GROUP = re.compile(f"({JS_DOT}{{2,8}})\\1{{3,}}")
_EMAIL_RE = re.compile(f'[^{JS_WS_CLASS}@<>"]+@[^{JS_WS_CLASS}@<>"]+\\.[^{JS_WS_CLASS}@<>"]+')
_JS_WS_RE = re.compile(f"[{JS_WS_CLASS}]")


def secret_weakness(v: str, min_distinct: int = 10) -> str | None:
    """비밀 값이 약하면 이유, 괜찮으면 None (config.ts secretWeakness)."""
    low = v.lower()
    word = next((w for w in EXAMPLE_WORDS if w in low), None)
    if word:
        return f"예시 글자('{word}')가 들어 있습니다"
    if len(set(v)) < min_distinct:  # new Set(v): 코드 포인트 단위
        return "쓰인 글자 종류가 너무 적습니다"
    units = utf16_units(v)  # JS 정규식(u 플래그 없음)은 UTF-16 단위로 봅니다
    if _REPEAT_ONE.search(units) or _REPEAT_GROUP.search(units):
        return "같은 글자나 묶음이 되풀이됩니다"
    return None


def is_placeholder_host(host: str) -> bool:
    """예시 · 로컬 주소 (운영에 넣으면 안 되는 도메인)."""
    h = re.sub(r"^\[|\]\Z", "", host.lower())
    h = re.sub(r"\.\Z", "", h)
    if not h or is_ip(h):
        return not h or h.startswith("127.") or h == "::1" or h == "0.0.0.0"
    return bool(
        re.search(r"(^|\.)example\.(com|net|org)\Z", h) or re.search(r"(^|\.)(localhost|test|example|invalid|local)\Z", h)
    )


@dataclass(frozen=True)
class Config:
    node_env: str
    is_prod: bool
    port: int
    host: str
    #: 주소 앞부분. 기본은 도메인 루트(''). 다른 사이트 아래 /shrine 같은 경로로 붙일 때만
    base_path: str
    public_origin: str
    shrine_domain: str
    trust_proxy: bool
    data_dir: str
    ticket_secret: str
    turnstile_site_key: str
    turnstile_secret: str
    allow_indexing: bool
    #: 직접 쓰는 메시지. FREE_CHAT=off면 고르는 말풍선만
    free_chat: bool
    #: AI 트렌드 게시판 글쓰기 · 글 신고 (기본 꺼짐)
    board_open: bool
    contact_email: str
    candle_cooldown_ms: int
    ws_max_per_ip: int
    #: 운영자 화면 비밀번호 ('' = 운영자 화면 꺼짐)
    admin_password: str
    #: 운영자 화면을 열 수 있는 IP (비면 제한 없음)
    admin_ips: tuple[str, ...]
    #: 운영자 알림 웹훅 ('' = 보내지 않음. 개발에서 모양이 틀리면 '')
    notify_webhook_url: str
    #: GitHub 저장소 확인 (GITHUB_CHECK, 대소문자 무시)
    github_check: bool
    github_token: str
    retention_days: float
    pending_days: float
    backup_dir: str
    backup_keep: int
    backup_max_days: int
    acme_email: str
    #: postgresql+asyncpg://… (postgres:// · postgresql://도 받아서 바꿉니다)
    database_url: str
    redis_url: str
    public_dir: str

    @property
    def dev_skip_human_check(self) -> bool:
        """개발에서 Turnstile 키가 없으면 사람 확인을 건너뜁니다. 운영에서는 절대 켜지지 않습니다."""
        return not self.is_prod and not self.turnstile_secret


@dataclass
class ConfigResult:
    config: Config
    errors: list[str] = field(default_factory=list)
    prod_errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def fatal(self) -> list[str]:
        return [*self.errors, *self.prod_errors]

    def report(self) -> str:
        return "\n".join(
            [
                f"[shrine] 설정에 문제가 있어 시작하지 않습니다{' (운영 모드)' if self.config.is_prod else ''}:",
                *(f"  - {s}" for s in self.fatal),
                "  .env.example을 참고해 .env를 고친 뒤 다시 시작해 주세요.",
            ]
        )


def load_config(env: Mapping[str, str] | None = None) -> ConfigResult:
    """설정을 읽고 문제를 모읍니다 (출력 · 종료는 하지 않음)."""
    env = os.environ if env is None else env

    def get(name: str) -> str:
        return js_trim(env.get(name) or "")

    node_env = get("NODE_ENV")
    is_prod = node_env == "production"
    errors: list[str] = []
    prod_errors: list[str] = []
    warnings: list[str] = []

    def prod_only(msg: str) -> None:
        (prod_errors if is_prod else warnings).append(msg)

    if node_env and node_env not in ("production", "development", "test"):
        errors.append(f'NODE_ENV는 production(운영) 또는 development(개발)입니다. 지금 값: "{node_env}"')

    def boolean(name: str, fallback: bool) -> bool:
        v = get(name).lower()
        if not v:
            return fallback
        if v == "true":
            return True
        if v == "false":
            return False
        errors.append(f'{name}는 true 또는 false입니다. 지금 값: "{get(name)}"')
        return fallback

    def on_off(name: str, fallback: bool) -> bool:
        v = get(name).lower()
        if not v:
            return fallback
        if v == "on":
            return True
        if v == "off":
            return False
        errors.append(f'{name}는 on 또는 off입니다. 지금 값: "{get(name)}"')
        return fallback

    def integer(name: str, fallback: int, lo: int = 1, hi: int = MAX_SAFE_INTEGER) -> int:
        raw = get(name)
        if not raw:
            return fallback
        if not re.fullmatch(r"[0-9]+", raw) or int(raw) > MAX_SAFE_INTEGER or not lo <= int(raw) <= hi:
            rng = f"{lo} 이상의" if hi == MAX_SAFE_INTEGER else f"{lo}~{hi} 사이"
            errors.append(f'{name}는 {rng} 정수입니다. 지금 값: "{raw}"')
            return fallback
        return int(raw)

    # ── 서버 ──
    port = integer("PORT", 3300, 1, 65535)
    host = get("HOST") or "127.0.0.1"
    if not is_ip(re.sub(r"^\[|\]\Z", "", host)) and not re.fullmatch(r"[a-z0-9.-]+", host, re.IGNORECASE | re.ASCII):
        errors.append(f'HOST는 IP 주소나 호스트 이름입니다. 지금 값: "{host}"')

    base_path = re.sub(r"/\Z", "", get("BASE_PATH"))
    if not re.fullmatch(r"(/[a-z0-9-]+)*", base_path):
        errors.append("BASE_PATH는 비우거나 /shrine 같은 모양입니다 (영문 소문자 · 숫자 · -)")

    # ── 공개 주소 ──
    public_origin = re.sub(r"/\Z", "", get("PUBLIC_ORIGIN"))
    shrine_domain = get("SHRINE_DOMAIN").lower()
    if public_origin:
        u = parse_http_url(public_origin)
        if u is None or u.origin != public_origin.lower():
            errors.append(
                f'PUBLIC_ORIGIN은 https://shrine.my-domain.com 처럼 경로 없이 주소 앞부분만 넣습니다. 지금 값: "{public_origin}"'
            )
        else:
            public_origin = u.origin
            if is_prod and u.protocol != "https:":
                prod_errors.append("PUBLIC_ORIGIN은 운영에서 https://로 시작해야 합니다")
            if is_prod and is_placeholder_host(u.hostname):
                prod_errors.append(f"PUBLIC_ORIGIN이 예시 · 로컬 주소({u.hostname})입니다. 실제 운영 도메인을 넣어 주세요")
            if is_prod and shrine_domain and shrine_domain != u.host:
                prod_errors.append(f"PUBLIC_ORIGIN의 도메인({u.host})과 SHRINE_DOMAIN({shrine_domain})이 다릅니다")
    elif is_prod:
        prod_errors.append(
            "PUBLIC_ORIGIN이 비어 있습니다 (예: https://shrine.my-domain.com). WebSocket · 입장 요청의 출처 확인에 씁니다"
        )
    if shrine_domain:
        if not re.fullmatch(r"[a-z0-9.-]+", shrine_domain):
            errors.append(f'SHRINE_DOMAIN은 shrine.my-domain.com 같은 도메인 이름만 넣습니다. 지금 값: "{shrine_domain}"')
        elif is_prod and is_placeholder_host(shrine_domain):
            prod_errors.append(f"SHRINE_DOMAIN이 예시 · 로컬 주소({shrine_domain})입니다")

    # ── 입장 표 서명 키 ──
    ticket_secret_raw = get("TICKET_SECRET")
    if not ticket_secret_raw:
        if is_prod:
            prod_errors.append("TICKET_SECRET이 비어 있습니다 (32자 이상 무작위 값, .env.example의 만드는 법 참고)")
    elif utf16_len(ticket_secret_raw) < 32:
        prod_only(f"TICKET_SECRET은 32자 이상이어야 합니다 (지금 {utf16_len(ticket_secret_raw)}자)")
    else:
        weak = secret_weakness(ticket_secret_raw)
        if weak:
            prod_only(f"TICKET_SECRET이 약합니다: {weak}. 무작위 값으로 바꿔 주세요")
    ticket_secret = ticket_secret_raw or secrets.token_hex(32)

    # ── Cloudflare Turnstile ──
    turnstile_site_key = get("TURNSTILE_SITE_KEY")
    turnstile_secret = get("TURNSTILE_SECRET")
    if not re.fullmatch(r"[A-Za-z0-9_-]*", turnstile_site_key):
        errors.append("TURNSTILE_SITE_KEY 형식이 올바르지 않습니다 (영문 · 숫자 · _ · -만)")
    if is_prod:
        if not turnstile_site_key:
            prod_errors.append("TURNSTILE_SITE_KEY가 비어 있습니다 (Cloudflare 대시보드 → Turnstile에서 운영 도메인으로 발급)")
        if not turnstile_secret:
            prod_errors.append("TURNSTILE_SECRET이 비어 있습니다")
        # Cloudflare 공개 시험 키(1x0000…, 2x0000…, 3x0000…)는 사람 확인을 늘 통과시키거나 늘 막습니다
        if re.match(r"[123][xX]0{8,}", turnstile_site_key):
            prod_errors.append("TURNSTILE_SITE_KEY가 Cloudflare 시험용 키입니다. 운영 도메인으로 발급한 키를 넣어 주세요")
        if re.match(r"[123][xX]0{8,}", turnstile_secret):
            prod_errors.append("TURNSTILE_SECRET이 Cloudflare 시험용 키입니다 (봇 차단이 꺼집니다)")

    # ── 운영 연락처 ──
    contact_email = get("CONTACT_EMAIL")
    if contact_email:
        at = contact_email.rfind("@")
        if utf16_len(contact_email) > 120 or not _EMAIL_RE.fullmatch(contact_email):
            errors.append(f'CONTACT_EMAIL이 메일 주소 모양이 아닙니다. 지금 값: "{contact_email}"')
        elif is_prod and is_placeholder_host(contact_email[at + 1 :]):
            prod_errors.append("CONTACT_EMAIL이 예시 주소입니다. 실제로 받는 운영 메일을 넣어 주세요")
    elif is_prod:
        prod_errors.append("CONTACT_EMAIL이 비어 있습니다. 화면 아래 · 개인정보 처리방침에 보이는 운영 연락처입니다")

    # ── 운영자 화면 ──
    password_min, password_max = 16, 256
    admin_password = get("ADMIN_PASSWORD")
    admin_ips: list[str] = []
    if admin_password:
        n = len(admin_password)  # [...s].length: 코드 포인트
        if n < password_min or n > password_max:
            prod_only(f"ADMIN_PASSWORD는 {password_min}~{password_max}자여야 합니다 (지금 {n}자). 운영자 화면을 켜지 않습니다")
            admin_password = ""
        else:
            weak = secret_weakness(admin_password, 8)
            if weak and is_prod:
                prod_errors.append(f"ADMIN_PASSWORD가 약합니다: {weak}. 무작위 값으로 바꿔 주세요")
            elif weak:
                warnings.append(f"ADMIN_PASSWORD가 약합니다: {weak} (개발이라 그대로 켭니다. 운영에서는 시작하지 않습니다)")
        # Node와 같이 비밀번호 길이가 틀려도 IP 목록은 마저 검사합니다
        for raw in get("ADMIN_IPS").split(","):
            ip = js_trim(raw).lower()
            if not ip:
                continue
            if ip.startswith("::ffff:") and is_ip(ip[7:]) == 4:
                ip = ip[7:]
            if not is_ip(ip):
                prod_only(
                    f'ADMIN_IPS에 IP 주소가 아닌 값("{js_trim(raw)}")이 있습니다 (쉼표로 나눈 IP만). 운영자 화면을 켜지 않습니다'
                )
                admin_password = ""
                break
            admin_ips.append(ip)

    # ── 운영자 알림 ──
    notify_url = get("NOTIFY_WEBHOOK_URL")
    if notify_url:
        u = parse_http_url(notify_url)
        if u is None:
            prod_only("NOTIFY_WEBHOOK_URL이 웹 주소(https://…) 모양이 아닙니다. 알림을 보내지 않습니다")
            notify_url = ""
        elif is_prod and u.protocol != "https:":
            prod_errors.append("NOTIFY_WEBHOOK_URL은 운영에서 https://여야 합니다 (웹훅 주소 자체가 비밀입니다)")

    # ── 그 밖의 선택 값 ──
    github_check = on_off("GITHUB_CHECK", True)
    backup_keep = integer("BACKUP_KEEP", 14, 1, 10_000)
    backup_max_days = integer("BACKUP_MAX_DAYS", 14, 1, 10_000)
    day_values: dict[str, float] = {"RETENTION_DAYS": 30.0, "PENDING_DAYS": 90.0}
    for name in ("RETENTION_DAYS", "PENDING_DAYS"):
        raw = get(name)
        if raw and not re.fullmatch(r"[0-9]+(\.[0-9]+)?", raw):
            errors.append(f'{name}는 0 이상의 숫자(일)입니다. 지금 값: "{raw}"')
        elif raw:
            day_values[name] = float(raw)
    github_token = get("GITHUB_TOKEN")
    if _JS_WS_RE.search(github_token):
        errors.append("GITHUB_TOKEN에 빈칸이 들어 있습니다")
    acme_email = get("ACME_EMAIL")
    if acme_email and not _EMAIL_RE.fullmatch(acme_email):
        errors.append(f'ACME_EMAIL이 메일 주소 모양이 아닙니다. 지금 값: "{acme_email}"')

    # config 객체를 만들 때 읽는 값 (Node도 이 순서로 검사합니다)
    trust_proxy = boolean("TRUST_PROXY", False)
    data_dir = get("DATA_DIR") or "./data"
    allow_indexing = boolean("ALLOW_INDEXING", False)
    free_chat = on_off("FREE_CHAT", True)
    board_open = on_off("BOARD_OPEN", False)
    candle_cooldown_ms = integer("CANDLE_COOLDOWN_MS", 30 * 60_000)
    ws_max_per_ip = integer("WS_MAX_PER_IP", 12, 1, 1000)

    # ── 새 서버에만 있는 값 ──
    database_url = _database_url(get("DATABASE_URL"), is_prod, errors, prod_errors)
    redis_url = get("REDIS_URL")
    if not redis_url:
        if is_prod:
            prod_errors.append("REDIS_URL이 비어 있습니다 (예: redis://redis:6379/0)")
        redis_url = "redis://127.0.0.1:6379/0"
    elif not re.match(r"(redis|rediss|unix)://", redis_url, re.IGNORECASE):
        errors.append("REDIS_URL은 redis://호스트:6379/0 모양입니다")
    public_dir = get("PUBLIC_DIR") or str(DEFAULT_PUBLIC_DIR)
    if not (Path(public_dir) / "index.html").is_file():
        errors.append(f'PUBLIC_DIR에 index.html이 없습니다. 지금 값: "{public_dir}"')

    config = Config(
        node_env=node_env,
        is_prod=is_prod,
        port=port,
        host=host,
        base_path=base_path,
        public_origin=public_origin,
        shrine_domain=shrine_domain,
        trust_proxy=trust_proxy,
        data_dir=data_dir,
        ticket_secret=ticket_secret,
        turnstile_site_key=turnstile_site_key,
        turnstile_secret=turnstile_secret,
        allow_indexing=allow_indexing,
        free_chat=free_chat,
        board_open=board_open,
        contact_email=contact_email,
        candle_cooldown_ms=candle_cooldown_ms,
        ws_max_per_ip=ws_max_per_ip,
        admin_password=admin_password,
        admin_ips=tuple(admin_ips),
        notify_webhook_url=notify_url,
        github_check=github_check,
        github_token=github_token,
        retention_days=day_values["RETENTION_DAYS"],
        pending_days=day_values["PENDING_DAYS"],
        backup_dir=get("BACKUP_DIR") or "./backups",
        backup_keep=backup_keep,
        backup_max_days=backup_max_days,
        acme_email=acme_email,
        database_url=database_url,
        redis_url=redis_url,
        public_dir=str(Path(public_dir).resolve()),
    )
    return ConfigResult(config, errors, prod_errors, warnings)


def _database_url(raw: str, is_prod: bool, errors: list[str], prod_errors: list[str]) -> str:
    """postgres:// · postgresql:// · postgresql+asyncpg:// → postgresql+asyncpg://. 비밀번호가 들어 있어 값은 메시지에 넣지 않습니다."""
    example = "postgresql://shrine:비밀번호@127.0.0.1:5432/shrine"
    if not raw:
        errors.append(f"DATABASE_URL이 비어 있습니다 (예: {example})")
        return ""
    from sqlalchemy.engine import make_url
    from sqlalchemy.exc import ArgumentError

    try:
        url = make_url(raw)
    except (ArgumentError, ValueError):
        errors.append(f"DATABASE_URL이 PostgreSQL 주소 모양이 아닙니다 (예: {example})")
        return ""
    if url.drivername not in ("postgres", "postgresql", "postgresql+asyncpg"):
        errors.append(f"DATABASE_URL은 postgresql://로 시작합니다 (예: {example})")
        return ""
    if not url.database:
        errors.append(f"DATABASE_URL에 데이터베이스 이름이 없습니다 (예: {example})")
    if is_prod:
        if not url.password:
            prod_errors.append("DATABASE_URL에 비밀번호가 없습니다")
        else:
            weak = secret_weakness(url.password)
            if weak:
                prod_errors.append(f"DATABASE_URL의 비밀번호가 약합니다: {weak}. 무작위 값으로 바꿔 주세요")
    return url.set(drivername="postgresql+asyncpg").render_as_string(hide_password=False)


def config_or_exit(env: Mapping[str, str] | None = None) -> Config:
    """검사 결과를 출력하고, 시작할 수 없으면 1로 끝냅니다 (config.ts 맨 아래와 같음)."""
    result = load_config(env)
    if result.fatal:
        print(result.report(), file=sys.stderr, flush=True)
        sys.exit(1)
    for w in result.warnings:
        print(f"[shrine] 설정 경고: {w}", file=sys.stderr, flush=True)
    return result.config
