"""운영 명령 가운데 사당 · 게시판 · 차단 쪽 (server/cli.ts list · status · remove · move · posts · post-* · blocks · block-ip ·
unblock). shrine/cli.py의 run()이 cli_registry 다음에 여기로 넘깁니다.

    uv run python -m shrine.cli list                          맵 사당 목록 (캐시를 비우고 다시 읽음)
    uv run python -m shrine.cli status <slug> live|check      점검중 전환
    uv run python -m shrine.cli remove <slug> [사유…]          내리기 (등록소에서 온 사당이면 그 접수는 반려로)
    uv run python -m shrine.cli move <slug> <자리> [채널]       다른 빈 자리로 (채널을 빼면 지금 채널 안에서)
    uv run python -m shrine.cli posts                         AI 트렌드 게시판 글 · 신고 수
    uv run python -m shrine.cli post-hide <id> | post-show <id> | post-del <id>
    uv run python -m shrine.cli blocks                        지금 걸려 있는 차단 · 강퇴 (IP 원문은 없음)
    uv run python -m shrine.cli block-ip <IP> <30m|12h|7d> [사유…]   IP 차단 (서버와 같은 TICKET_SECRET 필요, 최대 90d)
    uv run python -m shrine.cli unblock <번호>                차단 · 강퇴 풀기

출력 · 메시지 · 종료 코드는 Node와 같습니다 (사용법 안내의 명령 이름만 python -m shrine.cli). 서버가 떠 있는 동안 바꾼 사당은
서버의 사당 캐시가 30초 안에 다시 읽고, 차단 · 풀기는 실시간 쪽(shrine.moderation, P3)이 10초 안에 서버에 알립니다.
한 일은 admin_log에 'cli'로 남깁니다 (block-ip · unblock · erase — Node와 같은 명령만).
"""

from __future__ import annotations

import re
from typing import Any

from . import ops
from .cli_registry import PROG, CliFail, Handler, _kst_iso, _run, js_number
from .context import AppContext
from .logic.jsnum import is_integer
from .logic.jsstr import js_trim

#: 차단 기간 글자 → ms
_UNIT_MS = {"m": 60_000, "h": 3600_000, "d": 86_400_000}
_PERIOD = re.compile(r"([0-9]{1,6})(m|h|d)")


def _arg(args: list[str], i: int) -> str | None:
    return args[i] if len(args) > i else None


def _js(v: Any) -> str:
    return ops._num(v)


# ── 사당 ─────────────────────────────────────────────────────────────


async def _list(ctx: AppContext, args: list[str]) -> None:
    from .shrines import all_shrines, clear_shrine_cache

    clear_shrine_cache(ctx)
    for s in await all_shrines(ctx):
        print(f"채널 {_js(s['channel'])} · {_js(s['plot']).rjust(2)}  {s['status'].ljust(5)}  {s['slug'].ljust(20)}  {s['name']}  ({s['domain']})")


async def _status(ctx: AppContext, args: list[str]) -> None:
    a, b = _arg(args, 0), _arg(args, 1)
    if not a or b not in ("live", "check"):
        raise CliFail(f"사용법: {PROG} status <slug> live|check")
    try:
        await ops.set_shrine_status(ctx, a, b)
    except ops.OpError as e:
        raise CliFail(str(e)) from e
    print(f"{a} → {b}")


async def _remove(ctx: AppContext, args: list[str]) -> None:
    a = _arg(args, 0)
    if not a:
        raise CliFail(f"사용법: {PROG} remove <slug> [사유]")
    try:
        s = await ops.remove_shrine(ctx, a, " ".join(args[1:]))
    except ops.OpError as e:
        raise CliFail(str(e)) from e
    tail = f" (접수 #{_js(s['projectId'])}는 반려로)" if s["projectId"] else ""
    print(f"지웠습니다: {a}{tail}. 실제 화면 파일(public/img/shrines/)은 직접 지워 주세요.")


async def _move(ctx: AppContext, args: list[str]) -> None:
    a, b, c = _arg(args, 0), _arg(args, 1), _arg(args, 2)
    if not a or b is None:
        raise CliFail(f"사용법: {PROG} move <slug> <자리 번호> [채널 1~3]")
    try:
        r = await ops.move_shrine(ctx, a, b, c)
    except ops.OpError as e:
        raise CliFail(str(e)) from e
    same = r["fromChannel"] == r["shrine"]["channel"]
    print(f"{a}: 자리 {ops.move_text(r)}" if same else f"{a}: {ops.move_text(r)}")


# ── 게시판 ───────────────────────────────────────────────────────────


async def _posts(ctx: AppContext, args: list[str]) -> None:
    for p in await ops.all_posts_for_admin(ctx):
        when = _kst_iso(p["at"])[5:16].replace("T", " ")
        hidden = "숨김" if p["hidden"] else "보임"
        print(f"{_js(p['id']).rjust(4)}  {when}  {hidden}  신고 {p['reports']}  [{p['topic']}] {p['text']}  — {p['nick']}")


async def _post_hide_show(ctx: AppContext, args: list[str], hide: bool) -> None:
    a = _arg(args, 0)
    pid = js_number(a)
    if not is_integer(pid) or not await ops.set_post_hidden(ctx, pid, hide):
        raise CliFail(f"없는 글입니다: {_js(a)}")
    print(f"{_js(pid)} → {'숨김' if hide else '보임'} (화면은 새로 불러올 때 반영)")


async def _post_hide(ctx: AppContext, args: list[str]) -> None:
    await _post_hide_show(ctx, args, True)


async def _post_show(ctx: AppContext, args: list[str]) -> None:
    await _post_hide_show(ctx, args, False)


async def _post_del(ctx: AppContext, args: list[str]) -> None:
    a = _arg(args, 0)
    pid = js_number(a)
    if not is_integer(pid) or not await ops.delete_post(ctx, pid):
        raise CliFail(f"없는 글입니다: {_js(a)}")
    print(f"지웠습니다: {_js(pid)}")


# ── 차단 (shrine.moderation, P3: 바꾸면 Redis 채널로 서버에 알림) ──────


def _mod():
    from . import moderation

    return moderation


def _bv(b: Any, k: str) -> Any:
    return b.get(k) if isinstance(b, dict) else getattr(b, k, None)


async def _blocks(ctx: AppContext, args: list[str]) -> None:
    rows = await _mod().list_blocks(ctx)
    if not rows:
        print("걸려 있는 차단이 없습니다.")
    for x in rows:
        until = _kst_iso(int(_bv(x, "until")))[5:16].replace("T", " ")
        by_ip, by_sid = bool(_bv(x, "byIp")), bool(_bv(x, "bySid"))
        who = f"{'IP' if by_ip else ''}{'+' if by_ip and by_sid else ''}{'입장 표' if by_sid else ''}"
        reason = f"  사유: {_bv(x, 'reason')}" if _bv(x, "reason") else ""
        kind = "강퇴" if _bv(x, "kind") == "kick" else "차단"
        print(f"#{_js(_bv(x, 'id'))}  {kind}  ~{until}  {who} ({_bv(x, 'tag')})  {_bv(x, 'nick') or '-'}{reason}")


async def _block_ip(ctx: AppContext, args: list[str]) -> None:
    import os

    a, b = _arg(args, 0), _arg(args, 1)
    m = _PERIOD.fullmatch(b if b is not None else "")
    if not a or not m:
        raise CliFail(f"사용법: {PROG} block-ip <IP> <기간: 30m | 12h | 7d> [사유]")
    # 서버와 같은 키로 IP 키를 만들어야 해서 서버와 같은 TICKET_SECRET이 있어야 합니다
    if not js_trim(os.environ.get("TICKET_SECRET", "")):
        raise CliFail("TICKET_SECRET이 없습니다. 서버와 같은 .env로 실행해 주세요 (예: node --env-file=.env … 또는 docker compose exec)")
    ms = int(m.group(1)) * _UNIT_MS[m.group(2)]
    mod = _mod()
    try:
        # add_block이 Redis 채널로 서버에 알립니다 (서버는 바로 다시 읽음, Redis가 없어도 10초 갱신으로 반영)
        x = await mod.add_block(ctx, {"kind": "block", "ipKey": a, "ms": ms, "reason": " ".join(args[2:])})
    except mod.ModerationError as e:
        raise CliFail(str(e)) from e
    except Exception as e:  # noqa: BLE001 — Node: ModerationError가 아니면 '막지 못했습니다: …'
        raise CliFail(f"막지 못했습니다: {e}") from e
    await ops.admin_log(ctx, "ip-block", _bv(x, "tag"), "cli", f"운영 도구 · {b}")
    print(f"막았습니다: #{_js(_bv(x, 'id'))} ({_bv(x, 'tag')}, {b}). 서버에는 10초 안에 반영됩니다.")


async def _unblock(ctx: AppContext, args: list[str]) -> None:
    a = _arg(args, 0)
    bid = js_number(a)
    if not is_integer(bid) or bid <= 0:
        raise CliFail(f"사용법: {PROG} unblock <번호>  (번호는 blocks로 확인)")
    x = await _mod().remove_block(ctx, int(bid)) if bid <= ops.BIGINT_MAX else None
    if not x:
        raise CliFail(f"없는 차단입니다: {_js(a)}")
    await ops.admin_log(ctx, "block-remove", _bv(x, "tag"), "cli", f"운영 도구 · #{_js(bid)}")
    print(f"풀었습니다: #{_js(bid)} ({_bv(x, 'tag')}). 서버에는 10초 안에 반영됩니다.")


COMMANDS: dict[str, Handler] = {
    "list": _list,
    "status": _status,
    "remove": _remove,
    "move": _move,
    "posts": _posts,
    "post-hide": _post_hide,
    "post-show": _post_show,
    "post-del": _post_del,
    "blocks": _blocks,
    "block-ip": _block_ip,
    "unblock": _unblock,
}


async def dispatch(argv: list[str]) -> int | None:
    """cli.py run()이 부릅니다: 이 모듈의 명령이면 실행하고 종료 코드, 아니면 None."""
    handler = COMMANDS.get(argv[0] if argv else "")
    return None if handler is None else await _run(handler, argv[1:])
