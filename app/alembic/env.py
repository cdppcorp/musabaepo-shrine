"""Alembic 실행 환경 (async).

- 서버 안에서: shrine.db.engine.Database.migrate()가 연결을 config.attributes['connection']으로 넘겨 줍니다.
  이때는 로깅 설정을 건드리지 않습니다 (서버 로그 설정을 덮어쓰지 않게).
- 명령줄에서: DATABASE_URL 환경 변수로 async 엔진을 만들어 돌립니다.
"""

from __future__ import annotations

import asyncio
import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import Connection
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from shrine.db.models import Base

config = context.config
target_metadata = Base.metadata


def _url() -> str:
    raw = os.environ.get("DATABASE_URL", "").strip()
    if not raw:
        raise SystemExit("DATABASE_URL이 비어 있습니다 (예: postgresql://shrine:비밀번호@127.0.0.1:5432/shrine)")
    return make_url(raw).set(drivername="postgresql+asyncpg").render_as_string(hide_password=False)


def do_run_migrations(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    engine = create_async_engine(_url())
    async with engine.connect() as connection:
        await connection.run_sync(do_run_migrations)
        await connection.commit()
    await engine.dispose()


def run_migrations_offline() -> None:
    context.configure(url=_url(), target_metadata=target_metadata, literal_binds=True, dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()


shared = config.attributes.get("connection")
if shared is not None:
    do_run_migrations(shared)
elif context.is_offline_mode():
    run_migrations_offline()
else:
    if config.config_file_name is not None:
        fileConfig(config.config_file_name, disable_existing_loggers=False)
    asyncio.run(run_async_migrations())
