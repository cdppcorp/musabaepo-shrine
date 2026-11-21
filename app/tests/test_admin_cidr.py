"""ADMIN_IPS 대역(CIDR) 허용: 사무실 내부망 전체 등 (사용자 요청)."""
from types import SimpleNamespace

from shrine import admin_auth
from shrine.config import load_config

PROD = {
    "NODE_ENV": "production",
    "TICKET_SECRET": "k" * 8 + "Qz7Lm2Vx9Rt4Wp6Yb1Nc3Hd5Fg8Js0Ae",
    "TURNSTILE_SITE_KEY": "0x4AAAAAAAreal-site-key",
    "TURNSTILE_SECRET": "0x4AAAAAAAreal-secret-key-value",
    "PUBLIC_ORIGIN": "https://shrine.example.org",
    "SHRINE_DOMAIN": "shrine.example.org",
    "CONTACT_EMAIL": "ops@example.org",
    "ADMIN_PASSWORD": "Zq8vK2mW9xR4tY7pLm3N",
}


def test_config_accepts_cidr_and_normalizes():
    r = load_config({"ADMIN_PASSWORD": "Zq8vK2mW9xR4tY7p", "ADMIN_IPS": "192.168.123.7/24, 203.0.113.9, 2001:DB8::/48"})
    assert not any("ADMIN_IPS" in m for m in r.fatal)
    assert r.config.admin_ips == ("192.168.123.0/24", "203.0.113.9", "2001:db8::/48")
    assert r.config.admin_password


def test_config_rejects_too_broad_or_bad_cidr():
    for bad in ("0.0.0.0/0", "10.0.0.0/7", "::/0", "2001:db8::/31", "192.168.1.0/33", "nope/24"):
        r = load_config({"ADMIN_PASSWORD": "Zq8vK2mW9xR4tY7p", "ADMIN_IPS": bad})
        # 개발 모드: 운영자 화면만 꺼짐 (Node와 같은 처리)
        assert r.config.admin_password == "", bad


def _req(ip):
    return SimpleNamespace(state=SimpleNamespace(client_ip=ip), client=None)


def test_ip_allowed_matches_range_and_exact():
    st = admin_auth.AdminSetup(enabled=True, ips=["192.168.123.0/24", "203.0.113.9"])
    import ipaddress

    st.nets = [ipaddress.ip_network("192.168.123.0/24")]
    assert admin_auth.ip_allowed(st, _req("192.168.123.57"))
    assert admin_auth.ip_allowed(st, _req("::ffff:192.168.123.200"))
    assert admin_auth.ip_allowed(st, _req("203.0.113.9"))
    assert not admin_auth.ip_allowed(st, _req("192.168.124.1"))
    assert not admin_auth.ip_allowed(st, _req("118.235.7.12"))
    assert not admin_auth.ip_allowed(st, _req("2001:db8::1"))
