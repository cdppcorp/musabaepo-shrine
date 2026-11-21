"""운영자 API (server/admin.ts 267-555): 읽기 (me · dashboard · projects · project · shrines · posts · settings · log ·
players · reports · blocks), 바꾸기 (logout · upload · project/* · shrine/* · post/*), 접속자 관리 (player/* · report/* ·
block/* · chat/free).

응답은 Node와 같은 모양 · 키 순서입니다 (logic.jsnum.json_stringify). 한 일은 모두 admin_log에 남기고, 이메일(개인정보)이
보이는 화면(project · shrines)을 연 것도 남깁니다. 실패 변환은 admin.ts handleAdmin과 같습니다:
  OpError → 그 상태 + {ok:false, reason:'rule', message} / ModerationError → 400 rule /
  UNIQUE 위반 → 409 rule '같은 주소 · 자리 · 이름을 쓰는 사당이 이미 있습니다' / 한국어 메시지 예외 → 409 rule / 그 밖 → 500.

접속자 · 신고 · 차단 · 채팅 끄기는 실시간 쪽(shrine.realtime · shrine.moderation, P3)의 함수를 부릅니다 (모두 첫 인자 ctx).
"""

from __future__ import annotations

import base64
import logging
import os
import platform
import re
from typing import Any
from urllib.parse import parse_qsl

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from starlette.requests import Request

from . import admin_auth as auth
from . import ops
from .logic.jsnum import is_integer, is_number
from .logic.jsstr import js_trim, slice_units
from .logic.world import CHANNELS, PLOTS, is_channel
from .registry import (
    BIGINT_MAX,
    RegistryError,
    approve_project,
    is_project_filter,
    project_counts,
    project_for_admin,
    projects_by_filter,
    reject_project,
)
from .retention import destroy_project_now
from .shrines import candle_summary, free_plots_by_channel
from .uploads import UPLOAD_MAX, owns_upload, save_upload

log = logging.getLogger("shrine.admin")

BODY_MAX = 8 * 1024
#: 이미지 올리기는 base64라서 10MB의 4/3 + 여유 (admin.ts UPLOAD_BODY_MAX = 13,982,040)
UPLOAD_BODY_MAX = -(-UPLOAD_MAX // 3) * 4 + 1024
_B64_RE = re.compile(r"[A-Za-z0-9+/]+={0,2}")
_HANGUL = re.compile("[가-힣]")


class Reply:
    """처리 결과: 상태 + JSON 본문 (+ Set-Cookie). web/admin.py가 머리글을 붙여 보냅니다."""

    __slots__ = ("body", "cookie", "status")

    def __init__(self, status: int, body: Any, cookie: str | None = None) -> None:
        self.status = status
        self.body = body
        self.cookie = cookie


NOT_FOUND = Reply(404, None)


def fail(status: int, reason: str, message: str | None = None) -> Reply:
    body: dict[str, Any] = {"ok": False, "reason": reason}
    if message:
        body["message"] = message
    return Reply(status, body)


def ok(body: dict[str, Any] | None = None, status: int = 200, cookie: str | None = None) -> Reply:
    return Reply(status, {"ok": True, **(body or {})}, cookie)


def _num(v: Any) -> str:
    return ops._num(v)


def read_id(raw: Any) -> int | float | None:
    """``readId``: 숫자이거나 1~9자리 숫자 글자, 양의 정수만."""
    if is_number(raw):
        n: Any = raw
    elif isinstance(raw, str) and 1 <= len(raw) <= 9 and all("0" <= c <= "9" for c in raw):
        n = int(raw)
    else:
        return None
    if not is_integer(n) or n <= 0:
        return None
    return int(n) if n <= BIGINT_MAX else n


def _db_id(pid: Any) -> bool:
    """PostgreSQL BIGINT 안의 번호인가 (넘으면 '없는 번호'로 봅니다. Node SQLite도 그런 행은 없음)."""
    return isinstance(pid, int) and 0 < pid <= BIGINT_MAX


def query_first(request: Request, name: str) -> str | None:
    """URLSearchParams.get: 같은 이름이 여럿이면 첫 값 (Starlette QueryParams는 마지막 값)."""
    for k, v in parse_qsl(request.scope.get("query_string", b"").decode("latin-1"), keep_blank_values=True, errors="replace"):
        if k == name:
            return v
    return None


# ── 실시간 쪽 (shrine.realtime · shrine.moderation, P3) ───────────────
# 모두 첫 인자가 ctx. 실시간 · 차단 모듈은 web 쪽을 불러오므로 함수 안에서 불러옵니다 (불러오기 순환을 피함).


def _rt():
    from . import realtime

    return realtime


def _mod():
    from . import moderation

    return moderation


def free_chat(ctx) -> bool:
    """지금 직접 채팅이 켜져 있는지 (Node config.freeChat: 화면에서 바꾸면 다시 띄울 때까지 그 값)."""
    return bool(_rt().free_chat(ctx))


async def _moderation_summary(ctx) -> dict[str, Any]:
    m = _mod()
    return {"reports": m.open_report_count(ctx), **(await m.block_counts(ctx)), "freeChat": free_chat(ctx)}


# ── 읽기 ─────────────────────────────────────────────────────────────


def _free_count(free: dict[int, list[int]]) -> int:
    return sum(len(v) for v in free.values())


async def dashboard(ctx) -> dict[str, Any]:
    rt = _rt().channel_stats(ctx)
    candles = await candle_summary(ctx)
    async with ctx.db.session() as s:
        row = (
            await s.execute(
                text("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'live' THEN 1 ELSE 0 END), 0) AS live FROM shrines")
            )
        ).one()
    total, live = int(row.total), int(row.live)
    # 사당 자리는 채널마다 20칸 (free · plots는 세 채널을 합한 수, freeByChannel은 채널별 빈 자리 수)
    free = await free_plots_by_channel(ctx)
    return {
        "connections": rt["connections"],
        "channels": rt["channels"],
        "moderation": await _moderation_summary(ctx),
        "candles": {"today": candles["today"], "week": candles["weekTotal"]},
        "projects": await project_counts(ctx),
        "posts": await ops.post_counts(ctx),
        "shrines": {
            "total": total, "live": live, "check": total - live, "free": _free_count(free), "plots": len(PLOTS) * CHANNELS,
            "freeByChannel": {ch: len(v) for ch, v in free.items()},
        },
    }  # fmt: skip


def _env_set(name: str) -> bool:
    return bool(js_trim(os.environ.get(name, "")))


async def settings(ctx) -> list[dict[str, str]]:
    """지금 설정 요약. 비밀 값(비밀번호 · 서명 키 · Turnstile 비밀 키)은 들어 있는지만 보여 줍니다."""
    from .logic.jsnum import js_round

    c = ctx.config
    st = auth.setup(ctx)

    def on(v: bool) -> str:
        return "켜짐" if v else "꺼짐"

    def setv(name: str) -> str:
        return "설정됨" if _env_set(name) else "비어 있음"

    fc = free_chat(ctx)
    base = c.base_path
    free = _free_count(await free_plots_by_channel(ctx))
    return [
        {"key": "NODE_ENV", "label": "실행 모드", "value": "운영 (production)" if c.is_prod else "개발"},
        {"key": "HOST · PORT", "label": "받는 주소", "value": f"{c.host}:{c.port}"},
        {"key": "BASE_PATH", "label": "주소 앞부분", "value": base or "(도메인 루트)"},
        {"key": "PUBLIC_ORIGIN", "label": "공개 주소", "value": c.public_origin or "(없음)"},
        {"key": "TRUST_PROXY", "label": "프록시가 준 IP 믿기", "value": on(c.trust_proxy)},
        {"key": "DATA_DIR", "label": "데이터 폴더", "value": c.data_dir},
        {"key": "ALLOW_INDEXING", "label": "검색 노출", "value": on(c.allow_indexing)},
        {
            "key": "FREE_CHAT", "label": "직접 쓰는 채팅",
            "value": f"{on(fc)}{' (접속자 화면에서 바꿈, 다시 띄우면 .env 값)' if fc != c.free_chat else ''}",
        },
        {"key": "BOARD_OPEN", "label": "AI 트렌드 게시판 글쓰기", "value": "열림" if c.board_open else "준비 중 (닫힘)"},
        {"key": "WS_MAX_PER_IP", "label": "같은 IP 동시 접속", "value": f"{c.ws_max_per_ip}개"},
        {"key": "NOTIFY_WEBHOOK_URL", "label": "운영자 알림 (웹훅)", "value": setv("NOTIFY_WEBHOOK_URL")},
        {"key": "CONTACT_EMAIL", "label": "화면에 보이는 연락처", "value": c.contact_email or "(안 보임)"},
        {"key": "CANDLE_COOLDOWN_MS", "label": "같은 사당 초 다시 켜기", "value": f"{_num(js_round(c.candle_cooldown_ms / 60_000))}분"},
        {"key": "GITHUB_CHECK", "label": "등록소 GitHub 저장소 확인", "value": on(c.github_check)},
        {"key": "TURNSTILE_*", "label": "사람 확인 (Turnstile)", "value": "건너뜀 (개발, 키 없음)" if c.dev_skip_human_check else "켜짐"},
        {"key": "TICKET_SECRET", "label": "입장 표 · 세션 서명 키", "value": "설정됨" if _env_set("TICKET_SECRET") else "임시 키 (다시 띄우면 바뀜)"},
        {"key": "ADMIN_PASSWORD", "label": "운영자 비밀번호", "value": setv("ADMIN_PASSWORD")},
        {"key": "ADMIN_IPS", "label": "운영자 화면 허용 IP", "value": ", ".join(st.ips) if st.ips else "(제한 없음)"},
        {"key": "—", "label": "운영자 세션 길이", "value": f"{_num(auth.SESSION_MS / 3600_000)}시간"},
        {"key": "—", "label": "사당 자리", "value": f"채널마다 {len(PLOTS)}칸 × {CHANNELS}채널 (빈 자리 {free})"},
        # Node는 'Node' · process.version. 여기는 Python 버전 (일부러 다르게 둔 곳)
        {"key": "—", "label": "Python", "value": platform.python_version()},
    ]  # fmt: skip


async def log_action(ctx, request: Request, action: str, target: Any = "", detail: str = "") -> None:
    await ops.admin_log(ctx, action, target, auth.log_ip(auth.setup(ctx), request), detail)


async def reads(ctx, request: Request, s: dict[str, Any], action: str) -> Reply:
    if action == "me":
        return ok({"exp": s["exp"]})
    if action == "dashboard":
        return ok(await dashboard(ctx))
    if action == "projects":
        flt = query_first(request, "filter")
        flt = "review" if flt is None else flt
        if not is_project_filter(flt):
            return fail(400, "bad")
        return ok(
            {"filter": flt, "projects": await projects_by_filter(ctx, flt), "freePlots": await free_plots_by_channel(ctx), "channels": CHANNELS}
        )
    if action == "project":
        pid = read_id(query_first(request, "id"))
        p = await project_for_admin(ctx, pid) if pid else None
        if not p:
            return fail(404, "none")
        # 이메일(개인정보)을 보는 화면이라 누가 언제 어느 접수를 열었는지 남깁니다
        if p["email"]:
            await log_action(ctx, request, "project-view", pid if pid is not None else "")
        return ok({"project": p, "freePlots": await free_plots_by_channel(ctx), "channels": CHANNELS})
    if action == "shrines":
        shrines = await ops.shrines_for_admin(ctx)
        with_email = sum(1 for x in shrines if x["email"])
        if with_email:
            await log_action(ctx, request, "shrines-view", "", f"이메일 {with_email}곳")
        # freePlots: 채널 번호 → 빈 자리 번호들, plots: 채널 하나의 자리 수
        return ok({"shrines": shrines, "freePlots": await free_plots_by_channel(ctx), "plots": len(PLOTS), "channels": CHANNELS})
    if action == "posts":
        return ok({"posts": await ops.posts_for_review(ctx)})
    if action == "settings":
        return ok({"settings": await settings(ctx)})
    if action == "log":
        return ok({"log": await ops.read_log(ctx, query_first(request, "limit"))})
    if action == "players":
        return ok({"channels": _rt().players_for_admin(ctx), "freeChat": free_chat(ctx)})
    if action == "reports":
        return ok({"reports": _mod().list_user_reports(ctx, _rt().is_online)})
    if action == "blocks":
        return ok({"blocks": await _mod().list_blocks(ctx)})
    return NOT_FOUND


# ── 접속자 관리 ──────────────────────────────────────────────────────


def read_minutes(raw: Any, block_max_ms: int) -> int | None:
    """기간: 분(1 ~ 90일). 틀리면 None."""
    if is_number(raw):
        n: Any = raw
    elif isinstance(raw, str) and 1 <= len(raw) <= 6 and all("0" <= c <= "9" for c in raw):
        n = int(raw)
    else:
        return None
    if not is_integer(n) or n < 1 or n * 60_000 > block_max_ms:
        return None
    return int(n)


def fmt_minutes(m: int) -> str:
    if m % 1440 == 0:
        return f"{m // 1440}일"
    if m % 60 == 0:
        return f"{m // 60}시간"
    return f"{m}분"


def _bv(b: Any, k: str) -> Any:
    return b.get(k) if isinstance(b, dict) else getattr(b, k, None)


def block_detail(b: Any, m: int | None) -> str:
    parts = [_bv(b, "nick") or "-", fmt_minutes(m) if m else "", "IP · 입장 표" if _bv(b, "byIp") else "입장 표", _bv(b, "reason")]
    return " · ".join(str(x) for x in parts if x)


def _target(rep: Any) -> Any:
    return _bv(rep, "target")


async def moderation_writes(ctx, request: Request, action: str, body: dict[str, Any]) -> Reply | None:
    if action not in ("player/kick", "player/block", "report/kick", "report/block", "report/dismiss", "block/ip", "block/remove", "chat/free"):
        return None
    rt, mod = _rt(), _mod()
    block_max = mod.BLOCK_MAX_MS
    if action == "player/kick":
        r = await rt.kick_player(ctx, body.get("id"), body.get("reason"))
        if not r:
            return fail(404, "gone")
        b = _bv(r, "block")
        await log_action(ctx, request, "player-kick", _bv(b, "tag"), block_detail(b, None))
        return ok({"nick": _bv(r, "nick")})
    if action == "player/block":
        m = read_minutes(body.get("minutes"), block_max)
        if not m:
            return fail(400, "bad")
        r = await rt.block_player(ctx, body.get("id"), m * 60_000, body.get("ip") is True, body.get("reason"))
        if not r:
            return fail(404, "gone")
        b = _bv(r, "block")
        await log_action(ctx, request, "player-block", _bv(b, "tag"), block_detail(b, m))
        return ok({"nick": _bv(r, "nick"), "block": b})
    if action in ("report/kick", "report/block"):
        rid = read_id(body.get("id"))
        rep = mod.find_user_report(ctx, rid) if rid else None
        if not rid or not rep:
            return fail(404, "none")
        t = _target(rep)
        if action == "report/kick":
            r = await rt.kick_player(ctx, _bv(t, "pid"), body.get("reason"))
            if not r:
                return fail(404, "gone")
            mod.close_user_report(ctx, rid, "kicked")
            b = _bv(r, "block")
            await log_action(ctx, request, "player-kick", _bv(b, "tag"), f"신고 #{rid} · {block_detail(b, None)}")
            return ok({"nick": _bv(r, "nick")})
        m = read_minutes(body.get("minutes"), block_max)
        if not m:
            return fail(400, "bad")
        # 접속을 끊은 사람도 신고에 남은 입장 표 · IP 키로 막을 수 있습니다
        b = await rt.block_target(ctx, t, m * 60_000, body.get("ip") is True, body.get("reason"))
        mod.close_user_report(ctx, rid, "blocked")
        await log_action(ctx, request, "player-block", _bv(b, "tag"), f"신고 #{rid} · {block_detail(b, m)}")
        return ok({"nick": _bv(t, "nick"), "block": b})
    if action == "report/dismiss":
        rid = read_id(body.get("id"))
        if not rid or not mod.close_user_report(ctx, rid, "dismissed"):
            return fail(404, "none")
        await log_action(ctx, request, "report-dismiss", f"#{rid}")
        return ok()
    if action == "block/ip":
        # 운영자가 아는 IP(예: 서버 로그)를 바로 막기. IP 원문은 키로만 바꿔 두고 기록에도 남기지 않습니다
        m = read_minutes(body.get("minutes"), block_max)
        ip = body.get("ip")
        if not m or not isinstance(ip, str) or len(ip.encode("utf-16-le", "surrogatepass")) // 2 > 64:
            return fail(400, "bad")
        b = await mod.add_block(ctx, {"kind": "block", "ipKey": ip, "ms": m * 60_000, "reason": body.get("reason")})
        await log_action(ctx, request, "ip-block", _bv(b, "tag"), block_detail(b, m))
        return ok({"block": b})
    if action == "block/remove":
        bid = read_id(body.get("id"))
        b = await mod.remove_block(ctx, bid) if bid and isinstance(bid, int) else None
        if not b:
            return fail(404, "none")
        kind = "강퇴" if _bv(b, "kind") == "kick" else "차단"
        await log_action(ctx, request, "block-remove", _bv(b, "tag"), f"{kind} #{_num(_bv(b, 'id'))} · {_bv(b, 'nick') or '-'}")
        return ok()
    # chat/free
    on = body.get("on")
    if not isinstance(on, bool):
        return fail(400, "bad")
    rt.set_free_chat(ctx, on)
    await log_action(ctx, request, "chat-free", "on" if on else "off")
    return ok({"freeChat": free_chat(ctx)})


# ── 바꾸기 ───────────────────────────────────────────────────────────


async def screens_from(ctx, raw: Any, s: dict[str, Any]) -> list[str]:
    """올린 이미지 이름 → 사당 화면 목록. 이 세션에서 하루 안에 올린 것만 받습니다."""
    if not await owns_upload(ctx, raw, f"admin:{s['sid']}"):
        raise ops.OpError("이미지를 다시 올려 주세요 (이 로그인에서 올린 이미지만 쓸 수 있습니다)")
    return [f"up/{raw}"]


def _b64(data: str) -> bytes:
    """``Buffer.from(data, 'base64')`` (모양은 이미 /^[A-Za-z0-9+/]+={0,2}$/로 확인함): 끝의 남는 1글자는 버림."""
    core = data.rstrip("=")
    if len(core) % 4 == 1:
        core = core[:-1]
    return base64.b64decode(core + "=" * (-len(core) % 4))


def _too_big_id(pid: Any) -> bool:
    return is_number(pid) and not _db_id(pid)


async def writes(ctx, request: Request, s: dict[str, Any], action: str, body: dict[str, Any]) -> Reply:
    moderated = await moderation_writes(ctx, request, action, body)
    if moderated is not None:
        return moderated

    if action == "logout":
        await auth.revoke(ctx, s)
        await log_action(ctx, request, "logout")
        return ok(cookie=auth.session_cookie(ctx, request, "", 0))

    if action == "upload":
        data = body.get("data")
        if not isinstance(data, str) or not data or not _B64_RE.fullmatch(data):
            return fail(400, "bad")
        buf = _b64(data)
        if len(buf) > UPLOAD_MAX:
            return fail(413, "size")
        r = await save_upload(ctx, buf, f"admin:{s['sid']}", request.state.ip_hash)
        if not r["ok"]:
            reason = r["reason"]
            # Node와 같게: size만 413, slow · many만 429, 나머지(type · bad · busy · full)는 400
            return fail(413 if reason == "size" else 429 if reason in ("slow", "many") else 400, reason)
        await log_action(ctx, request, "upload", r["id"])
        return ok({"id": r["id"]}, 201)

    if action == "project/approve":
        pid = read_id(body.get("id"))
        if not pid:
            return fail(400, "bad")
        plot: Any = None
        if body.get("plot") is not None and body.get("plot") != "":
            n = read_id(body["plot"])
            if n is None:
                n = 0 if (body["plot"] == 0 and is_number(body["plot"])) or body["plot"] == "0" else None
            if n is None:
                return fail(400, "bad")
            plot = n
        channel: Any = None
        if body.get("channel") is not None and body.get("channel") != "":
            n = read_id(body["channel"])
            if n is None or not is_channel(n):
                return fail(400, "bad")
            channel = int(n)
        if _too_big_id(pid):
            raise RegistryError(f"없는 접수입니다: {_num(pid)}")
        # 채널을 비우면 작성자가 고른 채널 (registry.approve_project)
        message = await approve_project(ctx, pid, plot, channel)
        p = await project_for_admin(ctx, pid)
        await log_action(ctx, request, "project-approve", pid, message)
        return ok({"message": message, "project": p})

    if action == "project/erase":
        # 작성자의 요청 등으로 30일을 기다리지 않고 개인정보를 바로 파기 (되돌릴 수 없음)
        pid = read_id(body.get("id"))
        if not pid:
            return fail(400, "bad")
        r = await destroy_project_now(ctx, pid) if _db_id(pid) else {"ok": False, "images": 0, "message": f"없는 접수입니다: {_num(pid)}"}
        if not r["ok"]:
            return fail(404, "none", r["message"])
        await log_action(ctx, request, "project-erase", pid, f"이미지 {r['images']}개")
        return ok({"message": r["message"], "project": await project_for_admin(ctx, pid)})

    if action == "project/reject":
        pid = read_id(body.get("id"))
        if not pid:
            return fail(400, "bad")
        note = ops.clean_note(body.get("note"))
        if _too_big_id(pid):
            raise RegistryError(f"없는 접수입니다: {_num(pid)}")
        message = await reject_project(ctx, pid, note)
        await log_action(ctx, request, "project-reject", pid, note)
        return ok({"message": message, "project": await project_for_admin(ctx, pid)})

    if action == "shrine/add":
        screens = await screens_from(ctx, body.get("screen"), s)
        shrine = await ops.add_shrine(ctx, body, screens)
        await log_action(ctx, request, "shrine-add", shrine["slug"], f"{shrine['name']} · {ops.spot_name(shrine['channel'], shrine['plot'])}")
        return ok({"shrine": shrine}, 201)

    if action == "shrine/update":
        screen = body.get("screen")
        patch = {k: v for k, v in body.items() if k not in ("screen", "slug")}
        screens = None if screen is None or screen == "" else await screens_from(ctx, screen, s)
        r = await ops.update_shrine(ctx, body.get("slug"), patch, screens)
        if r["changed"]:
            await log_action(ctx, request, "shrine-update", r["shrine"]["slug"], ", ".join(r["changed"]))
        return ok({"shrine": r["shrine"], "changed": r["changed"]})

    if action == "shrine/move":
        r = await ops.move_shrine(ctx, body.get("slug"), body.get("plot"), body.get("channel"))
        await log_action(ctx, request, "shrine-move", r["shrine"]["slug"], ops.move_text(r))
        return ok({"shrine": r["shrine"]})

    if action == "shrine/remove":
        r = await ops.remove_shrine(ctx, body.get("slug"), body["note"] if "note" in body and body["note"] is not None else "")
        tail = f" · 접수 #{_num(r['projectId'])} 반려로" if r["projectId"] else ""
        await log_action(ctx, request, "shrine-remove", r["slug"], f"{r['name']}{tail}")
        return ok()

    if action in ("post/hide", "post/show", "post/delete"):
        pid = read_id(body.get("id"))
        post = await ops.find_post(ctx, pid) if pid else None
        if not pid or not post:
            return fail(404, "none")
        done = await ops.delete_post(ctx, pid) if action == "post/delete" else await ops.set_post_hidden(ctx, pid, action == "post/hide")
        if not done:
            return fail(404, "none")
        await log_action(ctx, request, action.replace("/", "-", 1), pid, f"[{post['topic']}] {slice_units(post['text'], 0, 40)}")
        return ok()

    return NOT_FOUND


def error_reply(e: BaseException) -> Reply | None:
    """admin.ts handleAdmin의 catch: 아는 오류면 응답, 모르면 None (500)."""
    if isinstance(e, ops.OpError):
        return fail(e.status, "rule", str(e))
    from .logic.chat import OpError as ChatOpError

    if isinstance(e, ChatOpError):
        return fail(400, "rule", str(e))
    if isinstance(e, _mod().ModerationError):
        return fail(400, "rule", str(e))
    if isinstance(e, IntegrityError):
        orig = getattr(e, "orig", None)
        codes = {getattr(o, a, None) for o in (orig, getattr(orig, "__cause__", None)) for a in ("sqlstate", "pgcode")}
        if "23505" in codes or "duplicate key" in str(e):
            return fail(409, "rule", "같은 주소 · 자리 · 이름을 쓰는 사당이 이미 있습니다")
        return None
    msg = str(e)
    if re.search("UNIQUE constraint", msg, re.IGNORECASE):
        return fail(409, "rule", "같은 주소 · 자리 · 이름을 쓰는 사당이 이미 있습니다")
    if _HANGUL.search(msg):
        return fail(409, "rule", slice_units(msg, 0, 200))
    return None


__all__ = [
    "BODY_MAX", "NOT_FOUND", "UPLOAD_BODY_MAX", "Reply", "dashboard", "error_reply", "fail", "fmt_minutes", "log_action", "ok",
    "query_first", "read_id", "read_minutes", "reads", "settings", "writes",
]  # fmt: skip

