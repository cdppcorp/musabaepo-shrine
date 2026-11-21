"""운영 명령 (server/cli.ts). 명령 이름 · 인자 · 출력 · 종료 코드는 Node와 같습니다.

    uv run python -m shrine.cli [--env-file ../.env] <명령> …
    uv run python -m shrine.cli add <사당.json | ->      (규칙 검사 후 추가. - 이면 표준 입력. "channel"을 빼면 1번 채널)
    uv run python -m shrine.cli schema                  (DB 구조 버전)
  등록소 · 업로드 · 시험용 훅(projects · approve · reject · erase · upload · dev …)은 cli_registry.py,
  사당 · 게시판 · 차단(list · status · remove · move · posts · post-* · blocks · block-ip · unblock)은 cli_ops.py.

--env-file: 그 파일의 값을 환경 변수로 읽습니다 (이미 있는 환경 변수가 이깁니다, 파일이 없으면 건너뜀 —
Node의 npm run shrine = node --env-file-if-exists=.env와 같은 규칙. 서버의 python -m shrine --env-file과 같음).

환경 변수는 서버와 같습니다 (DATABASE_URL · TICKET_SECRET …). DB를 열 때 서버처럼 Alembic을 올립니다 (빈 DB → head).
서버가 떠 있는 동안 넣은 사당은 서버의 사당 캐시가 30초 안에 다시 읽습니다 (Node와 같음).
성공하면 종료 코드 0, 실패하면 표준 오류에 까닭을 쓰고 1.
"""

from __future__ import annotations

import asyncio
import sys
from typing import Any, NoReturn

from .config import Config, config_or_exit
from .db.engine import Database, MigrationError
from .logic.jsnum import JSONParseError, is_number, json_parse, number_to_string
from .logic.links import validate_shrine

USAGE = (
    "명령: list | add <json|-> | upload <이미지|-> | status <slug> live|check | remove <slug> [사유] | move <slug> <자리> [채널] | "
    "posts | post-hide <id> | post-show <id> | post-del <id> | projects [all] | approve <id> [자리|-] [채널] | reject <id> [사유] | "
    "erase <id> | blocks | block-ip <IP> <기간> [사유] | unblock <번호> | schema"
)
#: 아직 없는 시험용 훅 (dev npc-goals는 실시간 쪽 P3)
NOT_YET = frozenset({"dev"})


class CliFail(Exception):
    pass


def fail(msg: str) -> NoReturn:
    raise CliFail(msg)


def _js(v: Any) -> str:
    """템플릿 문자열 안의 값 (`${v}`): 숫자는 JS 숫자 글자로."""
    if v is True or v is False:
        return "true" if v else "false"
    if is_number(v):
        return number_to_string(v)
    return "undefined" if v is None else str(v)


async def _open(config: Config) -> Database:
    """서버처럼 DB를 열고 구조를 올립니다 (db.ts가 import될 때 migrate()와 같은 자리)."""
    db = Database(config.database_url, pool_size=1, max_overflow=0)
    try:
        await db.migrate()
    except BaseException:
        await db.dispose()
        raise
    return db


async def cmd_add(config: Config, arg: str | None) -> None:
    from sqlalchemy.exc import IntegrityError

    from .shrines import ShrineRuleError, insert_shrine

    db = await _open(config)
    try:
        if not arg:
            fail("사용법: npm run shrine -- add <사당.json | ->")
        try:
            raw = sys.stdin.buffer.read() if arg == "-" else open(arg, "rb").read()  # noqa: SIM115
            data = json_parse(raw.decode("utf-8", "replace"))
        except (OSError, JSONParseError) as e:
            fail(f"사당 JSON을 읽지 못했습니다: {e}")
        # 등록소에서 생긴 칸(저장소 · 이메일 · 접수 번호)은 비워 두면 기본값, 채널을 비우면 1번 채널
        s: dict[str, Any] = {"repo": "", "email": "", "emailPublic": False, "projectId": 0, "channel": 1}
        if isinstance(data, dict):
            s.update(data)
        try:
            errors = validate_shrine(s)
        except (KeyError, TypeError, AttributeError) as e:
            fail(f"규칙에 맞지 않습니다: 사당 JSON에 칸이 빠졌거나 모양이 틀립니다 ({type(e).__name__}: {e})")
        if errors:
            fail(f"규칙에 맞지 않습니다: {' / '.join(errors)}")
        try:
            await insert_shrine(db, s)
        except ShrineRuleError as e:
            fail(str(e))
        except IntegrityError:
            fail(f"같은 주소 · 이름(slug)이나 같은 채널 · 자리를 쓰는 사당이 이미 있습니다 (채널 {_js(s['channel'])} · {_js(s['plot'])}번)")
        print(f"추가했습니다: {s['slug']} (채널 {_js(s['channel'])} · 자리 {_js(s['plot'])})", flush=True)
    finally:
        await db.dispose()


def _version(revision: str) -> str:
    """Alembic 리비전 → Node 구조 번호 (0001 = Node v4, 리비전이 하나 늘 때마다 +1)."""
    return f"v{int(revision) + 3}" if revision.isdigit() else revision


async def cmd_schema(config: Config) -> None:
    from alembic.runtime.migration import MigrationContext
    from alembic.script import ScriptDirectory

    from .db.engine import alembic_config

    db = await _open(config)
    try:
        async with db.engine.connect() as conn:
            current = await conn.run_sync(lambda c: MigrationContext.configure(c).get_current_heads())
        head = ScriptDirectory.from_config(alembic_config()).get_current_head() or "0"
        now = ", ".join(_version(r) for r in current) or "v0"
        print(f"DB 구조 버전 {now} (이 서버가 아는 마지막 버전 {_version(head)})", flush=True)
    finally:
        await db.dispose()


async def run(argv: list[str]) -> int:
    cmd = argv[0] if argv else None
    a = argv[1] if len(argv) > 1 else None
    from .cli_registry import dispatch as p2b_dispatch  # P2b: projects · approve · reject · erase · upload · dev retention/erase-now/notify

    if (code := await p2b_dispatch(argv)) is not None:
        return code
    from .cli_ops import dispatch as p4_dispatch  # P4: list · status · remove · move · posts · post-* · blocks · block-ip · unblock

    if (code := await p4_dispatch(argv)) is not None:
        return code
    if cmd == "dev" and a == "npc-goals":  # P3: NPC 목적지 뽑기 (npc.py dev_npc_goals)
        from .npc import dev_npc_goals

        return await dev_npc_goals(argv[2:])
    if cmd in NOT_YET:
        print(f"'{cmd}' 명령은 아직 Python 서버로 옮기지 않았습니다 (P4).", file=sys.stderr)
        return 1
    if cmd not in ("add", "schema"):
        print(USAGE, file=sys.stderr)
        return 1
    config = config_or_exit()
    try:
        if cmd == "add":
            await cmd_add(config, a)
        else:
            await cmd_schema(config)
    except CliFail as e:
        print(str(e), file=sys.stderr)
        return 1
    except MigrationError as e:
        print(f"[shrine] {e}", file=sys.stderr)
        return 1
    return 0


def load_env_file(argv: list[str]) -> list[str]:
    """맨 앞의 ``--env-file <경로>`` (또는 ``--env-file=<경로>``)를 읽고 뺀 argv. 있는 환경 변수가 이기고, 파일이 없으면 건너뜁니다."""
    import os

    path: str | None = None
    if argv and argv[0] == "--env-file" and len(argv) > 1:
        path, argv = argv[1], argv[2:]
    elif argv and argv[0].startswith("--env-file="):
        path, argv = argv[0].split("=", 1)[1], argv[1:]
    if path and os.path.isfile(path):
        from dotenv import load_dotenv

        load_dotenv(path, override=False, encoding="utf-8")
    return argv


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")
    sys.exit(asyncio.run(run(load_env_file(sys.argv[1:]))))


if __name__ == "__main__":
    main()
