"""적합성 시험 틀(tests/conformance)의 PostgreSQL · Redis 도우미. 시험 대상이 py일 때만 씁니다.

표준 입력으로 JSON 한 줄을 받고 표준 출력에 JSON 한 줄로 답합니다 (요청마다 {"id": …}가 그대로 돌아감).
driver.mjs가 이 프로세스 하나를 띄워 두고 계속 씁니다.

    {"id":1,"op":"ping"}
    {"id":2,"op":"create","db":"shrine_conf_x_1","role":"shrine_conf_x","password":"…"}   역할(없으면)과 새 DB
    {"id":3,"op":"drop","dbs":["…"],"role":"…"}                                          DB · 역할 지우기
    {"id":4,"op":"drop_prefix","prefix":"shrine_conf_"}                                   남은 시험 DB · 역할 모두 지우기
    {"id":5,"op":"query","db":"…","sql":"SELECT … $1","params":[…]}                      → {"rows":[{…}]}
    {"id":6,"op":"script","db":"…","sql":"…; …"}                                        여러 문장 (매개변수 없음)
    {"id":7,"op":"lock","db":"…","key":"l1"}       따로 연결을 열어 BEGIN + 모든 표 EXCLUSIVE 잠금 (읽기는 됨, 쓰기는 기다림)
    {"id":8,"op":"lock_run","key":"l1","sql":"…","params":[…]}                           그 잠금 트랜잭션 안에서 실행
    {"id":9,"op":"unlock","key":"l1"}                                                    ROLLBACK 후 닫기
    {"id":10,"op":"dump","db":"…"}                 모든 표의 모든 행 (row_to_json 글자) → {"text":"…"}
    {"id":11,"op":"tables","db":"…"} / {"op":"columns","db":"…","table":"…"}
    {"id":12,"op":"redis_flush","url":"redis://…/3"}

접속: SHRINE_TEST_PG (관리자 접속 주소, 기본 개발용 컨테이너 postgresql://postgres:dev@127.0.0.1:55432/postgres).
"""

from __future__ import annotations

import asyncio
import datetime
import decimal
import json
import os
import re
import sys
import uuid

import asyncpg

PG_ADMIN = os.environ.get("SHRINE_TEST_PG", "postgresql://postgres:dev@127.0.0.1:55432/postgres")
NAME_RE = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")

_conns: dict[str, asyncpg.Connection] = {}
_locks: dict[str, asyncpg.Connection] = {}


def _ident(name: str) -> str:
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise ValueError(f"이름이 이상합니다: {name!r}")
    return name


def _dsn(db: str | None) -> str:
    """관리자 주소에서 데이터베이스 이름만 바꿉니다."""
    if not db:
        return PG_ADMIN
    head, sep, tail = PG_ADMIN.rpartition("/")
    query = ""
    if "?" in tail:
        tail, query = tail.split("?", 1)
        query = "?" + query
    return f"{head}{sep}{db}{query}"


async def _conn(db: str) -> asyncpg.Connection:
    c = _conns.get(db)
    if c is None or c.is_closed():
        c = await asyncpg.connect(_dsn(db), timeout=5)
        _conns[db] = c
    return c


async def _close_db_conns(db: str) -> None:
    c = _conns.pop(db, None)
    if c is not None and not c.is_closed():
        await c.close()


def _plain(v):
    if isinstance(v, decimal.Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    if isinstance(v, (bytes, bytearray, memoryview)):
        return bytes(v).hex()
    if isinstance(v, (datetime.date, datetime.datetime, datetime.time)):
        return v.isoformat()
    if isinstance(v, uuid.UUID):
        return str(v)
    return v


def _rows(records) -> list[dict]:
    return [{k: _plain(v) for k, v in r.items()} for r in records]


async def _tables(c: asyncpg.Connection) -> list[str]:
    rows = await c.fetch(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    )
    return [r["tablename"] for r in rows]


async def handle(req: dict) -> dict:
    op = req.get("op")
    if op == "ping":
        c = await _conn("")
        return {"version": await c.fetchval("SHOW server_version")}
    if op == "create":
        db, role, password = _ident(req["db"]), _ident(req["role"]), req["password"]
        if not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", password):
            raise ValueError("비밀번호 모양이 이상합니다")
        c = await _conn("")
        if not await c.fetchval("SELECT 1 FROM pg_roles WHERE rolname = $1", role):
            await c.execute(f"CREATE ROLE {role} LOGIN PASSWORD '{password}'")
        await c.execute(f"DROP DATABASE IF EXISTS {db} WITH (FORCE)")
        await c.execute(f"CREATE DATABASE {db} OWNER {role}")
        return {}
    if op == "drop":
        c = await _conn("")
        for db in req.get("dbs", []):
            _ident(db)
            await _close_db_conns(db)
            await c.execute(f"DROP DATABASE IF EXISTS {db} WITH (FORCE)")
        if req.get("role"):
            await c.execute(f"DROP ROLE IF EXISTS {_ident(req['role'])}")
        return {}
    if op == "drop_prefix":
        prefix = req["prefix"]
        if not re.fullmatch(r"[a-z_]{6,40}", prefix):
            raise ValueError("접두어가 이상합니다")
        c = await _conn("")
        dbs = [r["datname"] for r in await c.fetch("SELECT datname FROM pg_database WHERE starts_with(datname, $1)", prefix)]
        for db in dbs:
            await _close_db_conns(db)
            await c.execute(f"DROP DATABASE IF EXISTS {_ident(db)} WITH (FORCE)")
        roles = [r["rolname"] for r in await c.fetch("SELECT rolname FROM pg_roles WHERE starts_with(rolname, $1)", prefix)]
        for role in roles:
            await c.execute(f"DROP ROLE IF EXISTS {_ident(role)}")
        return {"dbs": dbs, "roles": roles}
    if op == "query":
        c = await _conn(_ident(req["db"]))
        return {"rows": _rows(await c.fetch(req["sql"], *req.get("params", [])))}
    if op == "script":
        c = await _conn(_ident(req["db"]))
        return {"status": await c.execute(req["sql"])}
    if op == "lock":
        key = str(req["key"])
        c = await asyncpg.connect(_dsn(_ident(req["db"])), timeout=5)
        tables = await _tables(c)
        await c.execute("BEGIN")
        if tables:
            await c.execute(f"LOCK TABLE {', '.join(_ident(t) for t in tables)} IN EXCLUSIVE MODE")
        _locks[key] = c
        return {"tables": tables}
    if op == "lock_run":
        c = _locks[str(req["key"])]
        return {"rows": _rows(await c.fetch(req["sql"], *req.get("params", [])))}
    if op == "unlock":
        c = _locks.pop(str(req["key"]), None)
        if c is not None:
            try:
                await c.execute("ROLLBACK")
            finally:
                await c.close()
        return {}
    if op == "dump":
        c = await _conn(_ident(req["db"]))
        parts = []
        for t in await _tables(c):
            for r in await c.fetch(f"SELECT row_to_json(x)::text AS j FROM {_ident(t)} x"):
                parts.append(f"{t} {r['j']}")
        return {"text": "\n".join(parts)}
    if op == "tables":
        return {"tables": await _tables(await _conn(_ident(req["db"])))}
    if op == "columns":
        c = await _conn(_ident(req["db"]))
        rows = await c.fetch(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
            req["table"],
        )
        return {"columns": [r["column_name"] for r in rows]}
    if op == "redis_flush":
        import redis.asyncio as aioredis

        r = aioredis.from_url(req["url"], socket_connect_timeout=3)
        try:
            await r.flushdb()
            return {"databases": int((await r.config_get("databases")).get("databases", 16))}
        finally:
            await r.aclose()
    raise ValueError(f"모르는 op: {op!r}")


async def main() -> None:
    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        req: dict = {}
        try:
            req = json.loads(line)
            out = {"id": req.get("id"), "ok": True, **(await handle(req))}
        except Exception as e:  # 시험 도우미: 오류는 그대로 돌려줌
            out = {"id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}"}
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    for c in list(_locks.values()) + list(_conns.values()):
        try:
            await c.close()
        except Exception:
            pass


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(main())
