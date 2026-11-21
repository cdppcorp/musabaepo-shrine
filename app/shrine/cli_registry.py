"""운영 명령 가운데 등록소 · 업로드 · 보관 기간 쪽 (server/cli.ts projects · approve · reject · erase · upload)과
시험용 훅 dev retention · erase-now · notify (tests/conformance/README.md §2). shrine/cli.py의 run()이 여기로 넘깁니다.

    uv run python -m shrine.cli projects [all]                    등록소 접수 (검토할 것만, all이면 전부)
    uv run python -m shrine.cli approve <접수번호> [자리|-] [채널]     빈 자리에 사당 세우기 · 변경 승인
    uv run python -m shrine.cli reject <접수번호> [사유…]             접수 반려 · 변경 반려
    uv run python -m shrine.cli erase <접수번호>                      개인정보 바로 파기 (되돌릴 수 없음, admin_log에 'cli')
    uv run python -m shrine.cli upload <이미지|->                     DATA_DIR/uploads에 넣고 screens에 쓸 up/<…>을 알려 줌
    uv run python -m shrine.cli dev retention                       보관 기간 정리 한 번 → 결과 JSON (알림은 보내기가 끝난 뒤 끝남)
    uv run python -m shrine.cli dev erase-now <번호>                 destroyProjectNow → {"ok","images","message"} (admin_log 안 씀)
    uv run python -m shrine.cli dev notify <event> <fields JSON>     알림 한 번, 보내기를 마친 뒤 'done'

서버와 같은 환경 변수를 읽고(설정이 틀리면 서버처럼 1로 끝남, 예: RETENTION_DAYS=-1), DB를 열 때 Alembic을 올립니다.
Redis가 닿지 않으면 Redis 없이 합니다 (업로드 소유 기록 · PIN 틀린 기록을 지우는 일만 빠짐).
메시지 · 출력 모양 · 종료 코드는 Node와 같습니다 (사용법 안내의 명령 이름만 python -m shrine.cli).
"""

from __future__ import annotations

import asyncio
import sys
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import text

from . import notify as notify_mod
from . import redis as shrine_redis
from .config import Config, config_or_exit
from .context import AppContext
from .db.engine import Database, MigrationError
from .logic.jsnum import JSONParseError, is_integer, json_parse, json_stringify
from .logic.util import now_ms
from .storage import UploadStore

#: 사용법 안내의 명령 모양: Node와 같은 글자 (cli.py add도 같음)
PROG = "python -m shrine.cli"

Handler = Callable[[AppContext, list[str]], Awaitable[None]]


class CliFail(Exception):
    """표준 오류에 이 메시지를 적고 1로 끝냅니다 (cli.ts fail)."""


def js_number(s: str | None) -> float | int:
    """JS Number(argv 글자). 없으면 NaN."""
    from .registry import js_to_number

    return float("nan") if s is None else js_to_number(s)


def _kst_iso(ms: int) -> str:
    """new Date(ms + 9h).toISOString()의 앞 19자 + 'Z' 모양 (날짜 · 시각만 씀)."""
    return datetime.fromtimestamp((ms + 9 * 3600_000) / 1000, UTC).strftime("%Y-%m-%dT%H:%M:%S")


# ── 연결 ────────────────────────────────────────────────────────────


async def open_ctx(config: Config) -> AppContext:
    """서버와 같은 순서로 업로드 폴더 · DB(+Alembic) · Redis를 엽니다."""
    ctx = AppContext(config=config)
    ctx.uploads = UploadStore(config.data_dir)
    try:
        ctx.uploads.prepare()
    except OSError as e:
        raise CliFail(f"업로드 폴더를 만들지 못했습니다 ({ctx.uploads.dir}): {e}") from e
    ctx.db = Database(config.database_url, pool_size=2, max_overflow=2)
    try:
        await ctx.db.migrate()
    except MigrationError as e:
        await ctx.db.dispose()
        raise CliFail(f"[shrine] {e}") from e
    client = shrine_redis.connect(config.redis_url)
    try:
        await asyncio.wait_for(client.ping(), 3)
        ctx.redis = client
    except Exception:  # noqa: BLE001 — 운영 명령은 Redis 없이도 됩니다
        await client.aclose()
        print("[shrine] Redis에 연결하지 못해 Redis 없이 합니다 (REDIS_URL)", file=sys.stderr)
    notify_mod.configure(config.notify_webhook_url)
    return ctx


async def close_ctx(ctx: AppContext) -> None:
    await notify_mod.drain()
    if ctx.redis is not None:
        await ctx.redis.aclose()
    if ctx.db is not None:
        await ctx.db.dispose()


async def _run(handler: Handler, args: list[str]) -> int:
    config = config_or_exit()
    try:
        ctx = await open_ctx(config)
    except CliFail as e:
        print(str(e), file=sys.stderr)
        return 1
    try:
        await handler(ctx, args)
        sys.stdout.flush()
        return 0
    except CliFail as e:
        print(str(e), file=sys.stderr)
        return 1
    finally:
        await close_ctx(ctx)


# ── 등록소 ───────────────────────────────────────────────────────────


def _project_lines(p: dict) -> list[str]:
    """cli.ts projects 한 접수의 줄들."""
    out: list[str] = []
    when = _kst_iso(p["at"])[5:16].replace("T", " ")
    link_review = p["pending_github"] is not None or p["pending_url"] is not None
    text_review = p["pending_name"] is not None or p["pending_tagline"] is not None or p["pending_sign"] is not None
    review = [x for x, on in (("링크", link_review), ("글자", text_review), ("이미지", p["pending_screen"] is not None)) if on]

    def day(ms: int | None) -> str:
        return _kst_iso(ms)[:10] if ms else ""

    def keep(v: str | None) -> str:
        return "(그대로)" if v is None else v

    tag = f" ({' · '.join(review)} 변경 검토)" if p["status"] == "approved" and review else ""
    out.append(f"#{p['id']}  {when}  {p['status']}{tag}  {p['name']} — {p['tagline']}  [{p['category']}]")
    repo = f" (확인됨 · 별 {p['stars']})" if p["repo_ok"] else (" (확인 못 함)" if p["github"] else "")
    out.append(f"      GitHub: {p['github'] or '-'}{repo}  서비스: {p['url'] or '-'}")
    if link_review:
        out.append(f"      바꿀 링크 → GitHub: {p['pending_github'] or '-'}  서비스: {p['pending_url'] or '-'}")
    if text_review:
        out.append(
            f"      바꿀 글자 → 이름: {keep(p['pending_name'])}  소개: {keep(p['pending_tagline'])}  지붕: {keep(p['pending_sign'])}"
        )
    dates = [
        label
        for label, ms in (("동의", p["consent_at"]), ("닫힘", p["closed_at"]), ("파기", p["purged_at"]))
        if ms
        for label in [f"{label} {day(ms)}"]
    ]
    if dates:
        out.append(f"      {'  '.join(dates)}")
    slug = f"  사당: {p['slug']}" if p["slug"] else ""
    note = f"  메모: {p['note']}" if p["note"] else ""
    out.append(f"      이메일: {p['email']} ({'공개' if p['email_public'] else '비공개'})  작성: {p['nick']}{slug}{note}")
    wish_ch = p["want_channel"] if p["want_channel"] is not None else (1 if p["want_plot"] is not None else None)
    ch_text = "아무 채널" if wish_ch is None else f"채널 {wish_ch}"
    plot_text = "아무 자리" if p["want_plot"] is None else f"{p['want_plot']}번"
    img = f"data/uploads/{p['screen']}" if p["screen"] else "-"
    pending = ""
    if p["pending_screen"] is not None:
        pending = "  바꿀 이미지: " + (f"data/uploads/{p['pending_screen']}" if p["pending_screen"] else "(지움)")
    out.append(f"      원하는 자리: {ch_text} · {plot_text}  이미지: {img}{pending}")
    return out


async def _projects(ctx: AppContext, args: list[str]) -> None:
    from .registry import projects_for_admin

    a = args[0] if args else None
    rows = await projects_for_admin(ctx, a == "all")
    if not rows:
        print("접수된 프로젝트가 없습니다." if a == "all" else "검토할 접수가 없습니다. (전부 보기: projects all)")
    for p in rows:
        print("\n".join(_project_lines(p)))


async def _approve(ctx: AppContext, args: list[str]) -> None:
    from .registry import RegistryError, approve_project

    a, b, c = (list(args) + [None, None, None])[:3]
    pid = js_number(a)
    if not is_integer(pid):
        raise CliFail(f"사용법: {PROG} approve <접수번호> [자리 번호 | -] [채널 1~3]")
    plot = None if b is None or b in ("-", "") else js_number(b)
    if plot is not None and not is_integer(plot):
        raise CliFail("자리 번호는 숫자입니다 (자동은 -)")
    channel = None if c is None or c == "" else js_number(c)
    if channel is not None and not is_integer(channel):
        raise CliFail("채널은 1~3입니다")
    try:
        msg = await approve_project(
            ctx, int(pid), int(plot) if plot is not None else None, int(channel) if channel is not None else None
        )
    except RegistryError as e:
        raise CliFail(str(e)) from e
    print(msg)


async def _reject(ctx: AppContext, args: list[str]) -> None:
    from .registry import RegistryError, reject_project

    pid = js_number(args[0] if args else None)
    if not is_integer(pid):
        raise CliFail(f"사용법: {PROG} reject <접수번호> [사유]")
    try:
        msg = await reject_project(ctx, int(pid), " ".join(args[1:]))
    except RegistryError as e:
        raise CliFail(str(e)) from e
    print(msg)


async def _erase(ctx: AppContext, args: list[str]) -> None:
    from .retention import destroy_project_now

    pid = js_number(args[0] if args else None)
    if not is_integer(pid) or pid <= 0:
        raise CliFail(f"사용법: {PROG} erase <접수번호>")
    r = await destroy_project_now(ctx, int(pid))
    if not r["ok"]:
        raise CliFail(r["message"])
    async with ctx.db.begin() as s:
        await s.execute(
            text("INSERT INTO admin_log (at, action, target, ip_hash, detail) VALUES (:at, 'project-erase', :t, 'cli', :d)"),
            {"at": now_ms(), "t": str(int(pid)), "d": f"운영 도구 · 이미지 {r['images']}개"},
        )
    print(r["message"])


async def _upload(ctx: AppContext, args: list[str]) -> None:
    from .uploads import save_upload

    a = args[0] if args else None
    if not a:
        raise CliFail(f"사용법: {PROG} upload <이미지 파일 | ->")
    try:
        buf = sys.stdin.buffer.read() if a == "-" else Path(a).read_bytes()
    except OSError as e:
        raise CliFail(f"이미지를 읽지 못했습니다: {e}") from e
    # Node는 운영 명령마다 새 메모리라 할당량이 사실상 없었습니다 → 세지 않음
    r = await save_upload(ctx, buf, "cli", "cli", quotas=False)
    if not r["ok"]:
        why = {"type": "PNG · JPEG · WebP만 됩니다", "size": "5MB까지입니다", "full": "이미지 저장 공간이 꽉 찼습니다"}
        raise CliFail(f"올리지 못했습니다: {why.get(r['reason'], r['reason'])}")
    print(f'올렸습니다: up/{r["id"]}  (사당 JSON의 "screens": ["up/{r["id"]}"]. 하루 안에 사당에 쓰지 않으면 지워집니다)')


# ── 시험용 훅 ────────────────────────────────────────────────────────


async def _dev_retention(ctx: AppContext, args: list[str]) -> None:
    from .retention import run_retention

    r = await run_retention(ctx)
    await notify_mod.drain()
    print(json_stringify(r))


async def _dev_erase_now(ctx: AppContext, args: list[str]) -> None:
    from .retention import destroy_project_now

    print(json_stringify(await destroy_project_now(ctx, js_number(args[0] if args else None))))


async def _dev_notify(ctx: AppContext, args: list[str]) -> None:
    event = args[0] if args else "undefined"
    try:
        fields = json_parse(args[1] if len(args) > 1 else "{}")
    except JSONParseError as e:
        raise CliFail(f"fields JSON을 읽지 못했습니다: {e}") from e
    notify_mod.notify(event, fields if isinstance(fields, dict) else {})
    await notify_mod.drain()
    print("done")


DEV_HOOKS: dict[str, Handler] = {"retention": _dev_retention, "erase-now": _dev_erase_now, "notify": _dev_notify}


COMMANDS: dict[str, Handler] = {
    "projects": _projects,
    "approve": _approve,
    "reject": _reject,
    "erase": _erase,
    "upload": _upload,
}


async def dispatch(argv: list[str]) -> int | None:
    """cli.py run()이 먼저 부릅니다: 이 모듈의 명령 · 훅이면 실행하고 종료 코드, 아니면 None (cli.py가 이어서 봄)."""
    cmd = argv[0] if argv else ""
    if cmd == "dev":
        hook = DEV_HOOKS.get(argv[1] if len(argv) > 1 else "")
        return None if hook is None else await _run(hook, argv[2:])
    handler = COMMANDS.get(cmd)
    return None if handler is None else await _run(handler, argv[1:])
