"""설정 검사: Node(server/config.ts)와 같은 메시지 · 같은 순서 · 같은 값인지, 그리고 새 서버에만 있는 값(DB · Redis).

Node 비교는 server/config.ts를 그 환경 변수로 직접 불러 stderr · 결과 값을 받아 봅니다 (node가 없으면 건너뜀).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from shrine.config import config_or_exit, is_placeholder_host, load_config, secret_weakness

REPO = Path(__file__).resolve().parents[2]
NODE = shutil.which("node")
DB = "postgresql://shrine:dev@127.0.0.1:5432/shrine"
STRONG = "f3a9c1e07b5d2846af19c3e5d7b02a6e"  # 무작위 16진 (시험용, 실제 비밀 아님)
PROD_OK = {
    "NODE_ENV": "production",
    "PUBLIC_ORIGIN": "https://shrine.musabaepo.kr",
    "SHRINE_DOMAIN": "shrine.musabaepo.kr",
    "TICKET_SECRET": STRONG,
    "TURNSTILE_SITE_KEY": "0x4AAAAAAAbcdEFghIJklmno",
    "TURNSTILE_SECRET": "0x4AAAAAAAzyXWvuTSrqPONm",
    "CONTACT_EMAIL": "ops@musabaepo.kr",
    "REDIS_URL": "redis://redis:6379/0",
}
PROD_DB = "postgresql://shrine:Zq8vK2mW9xR4tY7pL3nB6cH1@pg:5432/shrine"

# (이름, 환경 변수) — 앞의 것은 개발, 뒤는 운영
CASES: list[tuple[str, dict[str, str]]] = [
    ("빈 설정", {}),
    ("NODE_ENV 틀림", {"NODE_ENV": "staging"}),
    ("NODE_ENV test", {"NODE_ENV": "test"}),
    ("PORT 글자", {"PORT": "abc"}),
    ("PORT 0", {"PORT": "0"}),
    ("PORT 범위 밖", {"PORT": "65536"}),
    ("PORT 앞 0", {"PORT": "0080"}),
    ("PORT 소수", {"PORT": "80.5"}),
    ("PORT 아주 큼", {"PORT": "99999999999999999999"}),
    ("HOST 빈칸", {"HOST": "bad host"}),
    ("HOST IPv6 괄호", {"HOST": "[::1]"}),
    ("HOST IPv6", {"HOST": "::"}),
    ("HOST 이름", {"HOST": "Shrine.Local"}),
    ("BASE_PATH 끝 빗금", {"BASE_PATH": "/shrine/"}),
    ("BASE_PATH 대문자", {"BASE_PATH": "/Shrine"}),
    ("BASE_PATH 빗금 없음", {"BASE_PATH": "shrine"}),
    ("BASE_PATH 두 단계", {"BASE_PATH": "/a/b-1"}),
    ("BASE_PATH 빗금 둘", {"BASE_PATH": "/a//"}),
    ("PUBLIC_ORIGIN 경로", {"PUBLIC_ORIGIN": "https://shrine.example.com/x"}),
    ("PUBLIC_ORIGIN 끝 빗금", {"PUBLIC_ORIGIN": "https://Shrine.Example.com/"}),
    ("PUBLIC_ORIGIN 기본 포트", {"PUBLIC_ORIGIN": "https://shrine.example.com:443"}),
    ("PUBLIC_ORIGIN 다른 포트", {"PUBLIC_ORIGIN": "http://localhost:3300"}),
    ("PUBLIC_ORIGIN ftp", {"PUBLIC_ORIGIN": "ftp://shrine.example.com"}),
    ("PUBLIC_ORIGIN 스킴 없음", {"PUBLIC_ORIGIN": "shrine.example.com"}),
    ("PUBLIC_ORIGIN 계정", {"PUBLIC_ORIGIN": "https://u@shrine.example.com"}),
    ("SHRINE_DOMAIN 틀림", {"SHRINE_DOMAIN": "shrine_example.com"}),
    ("SHRINE_DOMAIN 대문자", {"SHRINE_DOMAIN": "Shrine.Example.COM"}),
    ("TICKET_SECRET 짧음", {"TICKET_SECRET": "abc"}),
    ("TICKET_SECRET 예시", {"TICKET_SECRET": "change-me-change-me-change-me-12345"}),
    ("TICKET_SECRET 종류 적음", {"TICKET_SECRET": "abababababababababababababababab"}),
    ("TICKET_SECRET 되풀이", {"TICKET_SECRET": "a1b2c3d4e5f6g7h8i9j0aaaaaaaaaaaa"}),
    ("TICKET_SECRET 묶음 되풀이", {"TICKET_SECRET": "k9m2k9m2k9m2k9m2qwzxcvbnpl0987ty"}),
    ("TICKET_SECRET 이모지", {"TICKET_SECRET": "😀" * 16 + "abc"}),
    ("TICKET_SECRET 좋음", {"TICKET_SECRET": STRONG}),
    ("TURNSTILE_SITE_KEY 틀림", {"TURNSTILE_SITE_KEY": "abc def"}),
    ("CONTACT_EMAIL 틀림", {"CONTACT_EMAIL": "not-an-email"}),
    ("CONTACT_EMAIL 김", {"CONTACT_EMAIL": "a" * 115 + "@b.com"}),
    ("CONTACT_EMAIL 좋음", {"CONTACT_EMAIL": "ops@musabaepo.kr"}),
    ("ADMIN_PASSWORD 짧음", {"ADMIN_PASSWORD": "short", "ADMIN_IPS": "1.2.3.4,nope"}),
    ("ADMIN_PASSWORD 약함", {"ADMIN_PASSWORD": "password-password-1234"}),
    ("ADMIN_PASSWORD 좋음 + IP", {"ADMIN_PASSWORD": "Zq8vK2mW9xR4tY7p", "ADMIN_IPS": " 1.2.3.4 , ::FFFF:5.6.7.8, 2001:DB8::1,"}),
    ("ADMIN_IPS 틀림", {"ADMIN_PASSWORD": "Zq8vK2mW9xR4tY7p", "ADMIN_IPS": "1.2.3.4, example.com, 5.6.7.8"}),
    ("NOTIFY 틀림", {"NOTIFY_WEBHOOK_URL": "hooks.slack.com/x"}),
    ("NOTIFY http", {"NOTIFY_WEBHOOK_URL": "http://hooks.example.com/x"}),
    ("GITHUB_CHECK 틀림", {"GITHUB_CHECK": "maybe"}),
    ("GITHUB_CHECK 대문자", {"GITHUB_CHECK": "OFF"}),
    ("BACKUP 범위", {"BACKUP_KEEP": "0", "BACKUP_MAX_DAYS": "10001"}),
    ("보관 기간", {"RETENTION_DAYS": "-1", "PENDING_DAYS": "1.5"}),
    ("보관 기간 글자", {"RETENTION_DAYS": "abc", "PENDING_DAYS": "1e3"}),
    ("GITHUB_TOKEN 빈칸", {"GITHUB_TOKEN": "ab cd"}),
    ("ACME_EMAIL 틀림", {"ACME_EMAIL": "acme"}),
    ("bool · on/off 틀림", {"TRUST_PROXY": "yes", "ALLOW_INDEXING": "TRUE", "FREE_CHAT": "maybe", "BOARD_OPEN": "ON"}),
    ("숫자 범위", {"CANDLE_COOLDOWN_MS": "0", "WS_MAX_PER_IP": "1001"}),
    ("앞뒤 빈칸", {"PORT": " 3301 ", "BASE_PATH": "  /shrine  ", "FREE_CHAT": "　off﻿"}),
    ("여러 문제 한꺼번에", {"PORT": "x", "BASE_PATH": "bad", "TRUST_PROXY": "1", "ADMIN_PASSWORD": "short", "ACME_EMAIL": "x"}),
    ("운영 빈 설정", {"NODE_ENV": "production"}),
    ("운영 좋음", {**PROD_OK}),
    ("운영 http 주소", {**PROD_OK, "PUBLIC_ORIGIN": "http://shrine.musabaepo.kr"}),
    ("운영 예시 주소", {**PROD_OK, "PUBLIC_ORIGIN": "https://shrine.example.com", "SHRINE_DOMAIN": "localhost"}),
    ("운영 도메인 다름", {**PROD_OK, "SHRINE_DOMAIN": "other.musabaepo.kr"}),
    ("운영 시험 키", {**PROD_OK, "TURNSTILE_SITE_KEY": "1x00000000000000000000AA", "TURNSTILE_SECRET": "2x0000000000000000000000000000000AA"}),
    ("운영 약한 키", {**PROD_OK, "TICKET_SECRET": "x" * 40}),
    ("운영 예시 메일", {**PROD_OK, "CONTACT_EMAIL": "ops@example.com"}),
    ("운영 약한 운영자 비밀번호", {**PROD_OK, "ADMIN_PASSWORD": "aaaaaaaaaaaaaaaaaaaa"}),
    ("운영 운영자 IP 틀림", {**PROD_OK, "ADMIN_PASSWORD": "Zq8vK2mW9xR4tY7p", "ADMIN_IPS": "nope"}),
    ("운영 알림 http", {**PROD_OK, "NOTIFY_WEBHOOK_URL": "http://hooks.musabaepo.kr/x"}),
    ("운영 알림 틀림", {**PROD_OK, "NOTIFY_WEBHOOK_URL": "nope"}),
]


def python_output(env: dict[str, str]) -> tuple[str, dict | None]:
    # 새 서버에만 있는 값은 늘 올바르게 채워 Node와 같은 메시지만 나오게 합니다
    full = {"DATABASE_URL": PROD_DB if env.get("NODE_ENV") == "production" else DB, "REDIS_URL": "redis://redis:6379/0", **env}
    r = load_config(full)
    if r.fatal:
        return r.report(), None
    c = r.config
    values = {
        "port": c.port, "host": c.host, "basePath": c.base_path, "publicOrigin": c.public_origin,
        "trustProxy": c.trust_proxy, "dataDir": c.data_dir, "turnstileSiteKey": c.turnstile_site_key,
        "turnstileSecret": c.turnstile_secret, "allowIndexing": c.allow_indexing, "freeChat": c.free_chat,
        "boardOpen": c.board_open, "contactEmail": c.contact_email, "candleCooldownMs": c.candle_cooldown_ms,
        "wsMaxPerIp": c.ws_max_per_ip, "adminPassword": c.admin_password, "adminIps": list(c.admin_ips),
        "isProd": c.is_prod, "devSkipHumanCheck": c.dev_skip_human_check,
    }
    if env.get("TICKET_SECRET"):
        values["ticketSecret"] = c.ticket_secret
    return "\n".join(f"[shrine] 설정 경고: {w}" for w in r.warnings), values


NODE_SCRIPT = """
const m = await import(process.argv[1]);
const c = m.config;
const out = { port: c.port, host: c.host, basePath: c.basePath, publicOrigin: c.publicOrigin, trustProxy: c.trustProxy,
  dataDir: c.dataDir, turnstileSiteKey: c.turnstileSiteKey, turnstileSecret: c.turnstileSecret,
  allowIndexing: c.allowIndexing, freeChat: c.freeChat, boardOpen: c.boardOpen, contactEmail: c.contactEmail,
  candleCooldownMs: c.candleCooldownMs, wsMaxPerIp: c.wsMaxPerIp, adminPassword: c.adminPassword, adminIps: c.adminIps,
  isProd: m.isProd, devSkipHumanCheck: m.devSkipHumanCheck };
if (process.env.TICKET_SECRET) out.ticketSecret = c.ticketSecret;
process.stdout.write(JSON.stringify(out));
"""


def node_output(env: dict[str, str]) -> tuple[str, dict | None]:
    base = {k: v for k, v in os.environ.items() if k.upper() in ("PATH", "SYSTEMROOT", "SYSTEMDRIVE", "TEMP", "TMP", "HOME", "USERPROFILE")}
    url = (REPO / "server" / "config.ts").as_uri()
    p = subprocess.run(
        [NODE, "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", NODE_SCRIPT, url],
        env={**base, **env},
        capture_output=True,
        timeout=30,
    )
    err = p.stderr.decode("utf-8").rstrip("\n")
    if p.returncode != 0:
        return err, None
    return err, json.loads(p.stdout.decode("utf-8"))


@pytest.mark.skipif(NODE is None, reason="node가 없어 Node 설정 검사와 맞춰 볼 수 없습니다")
@pytest.mark.parametrize(("name", "env"), CASES, ids=[c[0] for c in CASES])
def test_matches_node(name: str, env: dict[str, str]):
    node_err, node_values = node_output(env)
    py_err, py_values = python_output(env)
    # 보안 점검: WS_MAX_PER_IP 기본값을 Python만 12 → 4로 낮췄습니다 (값을 넣은 경우는 Node와 같음)
    if node_values is not None and not env.get("WS_MAX_PER_IP", "").strip():
        node_values["wsMaxPerIp"] = 4
    assert py_err == node_err
    assert py_values == node_values


# ── Node 없이도 도는 검사 ──


def test_dev_defaults():
    r = load_config({"DATABASE_URL": DB})
    assert not r.fatal and not r.warnings
    c = r.config
    assert (c.port, c.host, c.base_path, c.data_dir) == (3300, "127.0.0.1", "", "./data")
    assert c.free_chat and not c.board_open and not c.allow_indexing and not c.trust_proxy
    assert c.candle_cooldown_ms == 1_800_000 and c.ws_max_per_ip == 4  # 보안 점검: 12 → 4
    assert c.github_check and c.retention_days == 30 and c.pending_days == 90
    assert c.backup_dir == "./backups" and c.backup_keep == 14 and c.backup_max_days == 14
    assert len(c.ticket_secret) == 64  # 개발: 시작할 때마다 무작위
    assert c.dev_skip_human_check
    assert c.redis_url == "redis://127.0.0.1:6379/0"
    assert c.database_url == "postgresql+asyncpg://shrine:dev@127.0.0.1:5432/shrine"


def test_github_check_is_normalized_once():
    assert load_config({"DATABASE_URL": DB, "GITHUB_CHECK": " OFF "}).config.github_check is False
    assert load_config({"DATABASE_URL": DB, "GITHUB_CHECK": "On"}).config.github_check is True


def test_errors_are_collected_in_order():
    r = load_config({"DATABASE_URL": DB, "PORT": "x", "BASE_PATH": "bad", "TRUST_PROXY": "1", "ACME_EMAIL": "x"})
    assert r.errors == [
        'PORT는 1~65535 사이 정수입니다. 지금 값: "x"',
        "BASE_PATH는 비우거나 /shrine 같은 모양입니다 (영문 소문자 · 숫자 · -)",
        'ACME_EMAIL이 메일 주소 모양이 아닙니다. 지금 값: "x"',
        'TRUST_PROXY는 true 또는 false입니다. 지금 값: "1"',
    ]
    assert r.report().splitlines()[0] == "[shrine] 설정에 문제가 있어 시작하지 않습니다:"
    assert r.report().splitlines()[-1] == "  .env.example을 참고해 .env를 고친 뒤 다시 시작해 주세요."


def test_database_url():
    assert load_config({}).errors == [
        "DATABASE_URL이 비어 있습니다 (예: postgresql://shrine:비밀번호@127.0.0.1:5432/shrine)"
    ]
    assert load_config({"DATABASE_URL": "postgres://u:p@h/db"}).config.database_url == "postgresql+asyncpg://u:p@h/db"
    assert load_config({"DATABASE_URL": "postgresql+asyncpg://u:p@h:5/db"}).config.database_url == (
        "postgresql+asyncpg://u:p@h:5/db"
    )
    bad = load_config({"DATABASE_URL": "mysql://u:p@h/db"})
    assert bad.errors == ["DATABASE_URL은 postgresql://로 시작합니다 (예: postgresql://shrine:비밀번호@127.0.0.1:5432/shrine)"]
    assert "p@h" not in bad.report()  # 비밀번호가 든 값은 메시지에 넣지 않습니다
    assert load_config({"DATABASE_URL": "postgresql://u:p@h"}).errors == [
        "DATABASE_URL에 데이터베이스 이름이 없습니다 (예: postgresql://shrine:비밀번호@127.0.0.1:5432/shrine)"
    ]


def test_production_database_and_redis():
    weak = load_config({**PROD_OK, "DATABASE_URL": "postgresql://shrine:dev@pg/shrine"})
    assert weak.prod_errors == ["DATABASE_URL의 비밀번호가 약합니다: 쓰인 글자 종류가 너무 적습니다. 무작위 값으로 바꿔 주세요"]
    nopass = load_config({**PROD_OK, "DATABASE_URL": "postgresql://shrine@pg/shrine"})
    assert nopass.prod_errors == ["DATABASE_URL에 비밀번호가 없습니다"]
    env = {**PROD_OK, "DATABASE_URL": PROD_DB}
    del env["REDIS_URL"]
    assert load_config(env).prod_errors == ["REDIS_URL이 비어 있습니다 (예: redis://redis:6379/0)"]
    assert load_config({**env, "REDIS_URL": "http://x"}).errors == ["REDIS_URL은 redis://호스트:6379/0 모양입니다"]
    assert not load_config({**PROD_OK, "DATABASE_URL": PROD_DB}).fatal


def test_public_dir(tmp_path):
    r = load_config({"DATABASE_URL": DB, "PUBLIC_DIR": str(tmp_path)})
    assert r.errors == [f'PUBLIC_DIR에 index.html이 없습니다. 지금 값: "{tmp_path}"']
    (tmp_path / "index.html").write_text("x")
    assert load_config({"DATABASE_URL": DB, "PUBLIC_DIR": str(tmp_path)}).config.public_dir == str(tmp_path.resolve())


def test_config_or_exit(capsys):
    with pytest.raises(SystemExit) as e:
        config_or_exit({"DATABASE_URL": DB, "PORT": "x"})
    assert e.value.code == 1
    assert 'PORT는 1~65535 사이 정수입니다. 지금 값: "x"' in capsys.readouterr().err
    config_or_exit({"DATABASE_URL": DB, "ADMIN_PASSWORD": "short"})
    assert capsys.readouterr().err == (
        "[shrine] 설정 경고: ADMIN_PASSWORD는 16~256자여야 합니다 (지금 5자). 운영자 화면을 켜지 않습니다\n"
    )


def test_helpers():
    assert secret_weakness("z" * 40) == "쓰인 글자 종류가 너무 적습니다"
    assert secret_weakness("x" * 40) == "예시 글자('xxxx')가 들어 있습니다"
    assert secret_weakness("MyPassword-is-long-enough") == "예시 글자('password')가 들어 있습니다"
    assert secret_weakness(STRONG) is None
    assert is_placeholder_host("[::1]") and is_placeholder_host("127.0.0.2") and is_placeholder_host("a.example.org.")
    assert is_placeholder_host("") and is_placeholder_host("x.localhost") and not is_placeholder_host("musabaepo.kr")
    assert not is_placeholder_host("10.0.0.1")
