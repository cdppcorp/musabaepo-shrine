"""뼈대 부품 단위 시험 (Node · DB 없이 도는 것 + Redis가 있으면 요청 제한 실제 동작)."""

from __future__ import annotations

import json
import os
import uuid

import pytest
from starlette.requests import Request

from shrine.config import load_config
from shrine.context import AppContext
from shrine.redis import FixedWindowLimiter, connect, key
from shrine.storage import UploadStore
from shrine.web.front import legacy_target
from shrine.web.health import healthz
from shrine.web.net import client_ip, node_header
from shrine.web.security import merge_headers, security_headers

DB = "postgresql://u:p@127.0.0.1:5432/db"
REDIS_URL = os.environ.get("SHRINE_TEST_REDIS", "redis://127.0.0.1:56379/13")


def cfg(**env):
    return load_config({"DATABASE_URL": DB, **env}).config


def test_security_headers():
    dev = dict(security_headers(cfg(), 'Shrine.Local:3300"<x>'))
    assert "connect-src 'self' ws://Shrine.Local:3300x;" in dev["Content-Security-Policy"]
    assert dev["X-Robots-Tag"] == "noindex, nofollow" and "Strict-Transport-Security" not in dev
    prod_env = {
        "NODE_ENV": "production", "PUBLIC_ORIGIN": "https://shrine.musabaepo.kr", "ALLOW_INDEXING": "true",
    }
    prod = dict(security_headers(load_config({"DATABASE_URL": DB, **prod_env}).config, "evil"))
    assert "connect-src 'self' wss://shrine.musabaepo.kr;" in prod["Content-Security-Policy"]
    assert prod["Strict-Transport-Security"] == "max-age=31536000" and "X-Robots-Tag" not in prod


def test_merge_headers_like_node():
    base = [(b"Content-Security-Policy", b"a"), (b"X-Robots-Tag", b"noindex, nofollow")]
    extra = [(b"content-type", b"x"), (b"x-robots-tag", b"noindex"), (b"set-cookie", b"a=1"), (b"set-cookie", b"b=2")]
    assert merge_headers(base, extra) == [
        (b"Content-Security-Policy", b"a"),
        (b"X-Robots-Tag", b"noindex"),
        (b"content-type", b"x"),
        (b"set-cookie", b"a=1"),
        (b"set-cookie", b"b=2"),
    ]


def test_legacy_target_stays_on_site():
    assert legacy_target("/shrine") == "/"
    assert legacy_target("/shrine/") == "/"
    assert legacy_target("/shrine/privacy") == "/privacy"
    assert legacy_target("/shrine//evil.com") == "/evil.com"


def test_node_header_joining_and_client_ip():
    headers = [
        (b"host", b"a"), (b"Host", b"b"), (b"accept", b"x"), (b"Accept", b"text/html"),
        (b"cookie", b"a=1"), (b"cookie", b"b=2"), (b"x-forwarded-for", b" 1.2.3.4 , 10.0.0.1"),
    ]
    assert node_header(headers, "host") == "a"
    assert node_header(headers, "accept") == "x, text/html"
    assert node_header(headers, "cookie") == "a=1; b=2"
    assert node_header(headers, "if-none-match") is None
    scope = {"headers": headers, "client": ("9.9.9.9", 1234)}
    assert client_ip(scope, True) == "1.2.3.4"
    assert client_ip(scope, False) == "9.9.9.9"
    assert client_ip({"headers": [(b"x-forwarded-for", b" ,x")], "client": None}, True) == "unknown"


def test_redis_key():
    assert key("rl", "req", "abc") == "shrine:rl:req:abc"
    with pytest.raises(ValueError):
        key()
    with pytest.raises(ValueError):
        key("rl", "")


# ── /healthz: DB · Redis가 답하지 않을 때 ──


class _Down:
    async def ping(self, *a, **k):
        raise ConnectionError("down")


class _Up:
    async def ping(self, *a, **k):
        return True


async def _health(tmp_path, db, redis) -> tuple[int, dict, dict]:
    ctx = AppContext(config=cfg(DATA_DIR=str(tmp_path)), db=db, redis=redis)
    ctx.uploads = UploadStore(str(tmp_path))
    ctx.uploads.prepare()

    async def count(_ctx):
        return 3

    ctx.count_shrines = count
    req = Request({"type": "http", "method": "GET", "headers": [], "path": "/healthz"})
    res = await healthz(req, ctx)
    return res.status_code, json.loads(res.body), {k.decode(): v.decode() for k, v in res.raw_headers}


async def test_healthz_ok_and_failures(tmp_path):
    status, body, headers = await _health(tmp_path, _Up(), _Up())
    assert status == 200 and body == {
        "ok": True, "db": "ok", "uptime": 0, "shrines": 3, "uploads": {"usedPct": 0, "lowDisk": False, "writable": True},
    }
    assert headers == {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex"}
    status, body, _ = await _health(tmp_path, _Down(), _Up())
    assert status == 503 and body["ok"] is False and body["db"] == "fail" and body["shrines"] is None
    status, body, _ = await _health(tmp_path, _Up(), _Down())
    assert status == 503 and body["ok"] is False and body["db"] == "ok" and body["shrines"] == 3


# ── 요청 제한 ──


async def test_limiter_fails_open_without_redis():
    client = connect("redis://127.0.0.1:1/0")
    try:
        assert await FixedWindowLimiter(client, "t", 1, 1000).allow("x") is True
        assert await FixedWindowLimiter(client, "t", 1, 1000, fail_open=False).allow("x") is False
    finally:
        await client.aclose()


async def test_limiter_window_with_redis():
    client = connect(REDIS_URL)
    try:
        try:
            await client.ping()
        except Exception:
            pytest.skip("Redis가 없어 실제 요청 제한을 시험하지 않습니다")
        name = f"unit-{uuid.uuid4().hex[:8]}"
        lim = FixedWindowLimiter(client, name, 3, 300)
        assert [await lim.allow("ip") for _ in range(5)] == [True, True, True, False, False]
        assert await lim.allow("other") is True
        ttl = await client.pttl(key("rl", name, "ip"))
        assert 0 < ttl <= 300
        import asyncio

        await asyncio.sleep(0.35)
        assert await lim.allow("ip") is True  # 창이 지나면 다시 셈
        await client.delete(key("rl", name, "ip"), key("rl", name, "other"))
    finally:
        await client.aclose()
