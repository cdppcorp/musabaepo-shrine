"""PostgreSQL 연결 (SQLAlchemy 2 async + asyncpg) · 시작할 때 Alembic 마이그레이션.

쓰는 법 (나중 단계):
    async with ctx.db.session() as s:          # AsyncSession
        ...
        await s.commit()
    async with ctx.db.begin() as s:            # 트랜잭션: 블록이 끝나면 commit, 예외면 rollback
        ...

Node는 DB 호출이 동기라 요청 사이에 끼어드는 일이 없었습니다. 여기서는 여러 문장을 한 번에 바꾸는 작업
(승인 · 내리기 · 파기 · PIN 잠금 증가 등)을 반드시 `begin()` 트랜잭션 안에서, 필요하면 행 잠금(FOR UPDATE)과 함께 씁니다.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from sqlalchemy import Connection, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

APP_DIR = Path(__file__).resolve().parents[2]
ALEMBIC_INI = APP_DIR / "alembic.ini"
ALEMBIC_DIR = APP_DIR / "alembic"

# 마이그레이션을 한 번에 하나만 (서버와 운영 명령이 동시에 떠도). 임의의 고정 번호
MIGRATION_LOCK_ID = 0x5348_524E  # 'SHRN'


class MigrationError(RuntimeError):
    pass


def alembic_config(connection: Connection | None = None):
    from alembic.config import Config as AlembicConfig

    cfg = AlembicConfig(str(ALEMBIC_INI))
    cfg.set_main_option("script_location", str(ALEMBIC_DIR))
    if connection is not None:
        cfg.attributes["connection"] = connection
    return cfg


def _upgrade(connection: Connection) -> None:
    from alembic import command
    from alembic.runtime.migration import MigrationContext
    from alembic.script import ScriptDirectory

    cfg = alembic_config(connection)
    script = ScriptDirectory.from_config(cfg)
    current = MigrationContext.configure(connection).get_current_heads()
    known = {rev.revision for rev in script.walk_revisions()}
    unknown = [r for r in current if r not in known]
    if unknown:
        raise MigrationError(
            f"DB 구조 버전({', '.join(unknown)})을 이 서버가 모릅니다. 더 새 서버가 만든 DB입니다. "
            "서버를 그 버전 이상으로 올리거나 백업에서 되살려 주세요."
        )
    command.upgrade(cfg, "head")
    after = MigrationContext.configure(connection).get_current_heads()
    if tuple(after) != tuple(current):
        print(f"[shrine] DB 구조를 바꿨습니다: {', '.join(current) or '빈 DB'} → {', '.join(after)}", flush=True)


class Database:
    def __init__(self, url: str, *, pool_size: int = 10, max_overflow: int = 10):
        self.engine: AsyncEngine = create_async_engine(
            url,
            pool_size=pool_size,
            max_overflow=max_overflow,
            pool_pre_ping=True,
            pool_recycle=1800,
            pool_timeout=10,
            connect_args={
                "timeout": 5,
                "command_timeout": 30,
                "server_settings": {"application_name": "musabaepo-shrine"},
            },
        )
        self.sessionmaker = async_sessionmaker(self.engine, expire_on_commit=False)

    def session(self) -> AsyncSession:
        return self.sessionmaker()

    @asynccontextmanager
    async def begin(self) -> AsyncIterator[AsyncSession]:
        async with self.sessionmaker() as s, s.begin():
            yield s

    async def ping(self, timeout: float = 3.0) -> None:
        """SELECT 1. 실패하거나 timeout 안에 답이 없으면 예외."""

        async def run() -> None:
            async with self.engine.connect() as conn:
                await conn.execute(text("SELECT 1"))

        await asyncio.wait_for(run(), timeout)

    async def migrate(self) -> None:
        """Alembic upgrade head. 다른 프로세스가 동시에 돌리지 않게 advisory lock 안에서 (트랜잭션 하나)."""
        try:
            async with self.engine.begin() as conn:
                await conn.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": MIGRATION_LOCK_ID})
                await conn.run_sync(_upgrade)
        except MigrationError:
            raise
        except Exception as e:
            raise MigrationError(f"DB 구조 바꾸기(Alembic upgrade)에 실패했습니다: {e}") from e

    async def dispose(self) -> None:
        await self.engine.dispose()
