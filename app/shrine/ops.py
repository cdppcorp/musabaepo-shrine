"""운영 작업 (server/ops.ts + ai.ts의 운영자 쪽 + admin_log): 사당 넣기 · 고치기 · 옮기기 · 상태 바꾸기 · 내리기,
게시판 글 숨기기 · 보이기 · 지우기, 운영 기록 남기기 · 읽기.

운영자 화면(admin_api.py)과 운영 명령(cli_ops.py)이 함께 씁니다. 입력을 여기서 검사하고 사당 규칙(validate_shrine)으로
한 번 더 봅니다. 실패하면 ``OpError``(화면에 그대로 보여 줄 한국어 문장 + HTTP 상태)를 던집니다. 메시지 · 검사 순서 ·
응답 키 순서는 Node와 같습니다.

Node와 다른 점 (동시성):
  · Node는 DB 호출이 동기라 '검사 → 쓰기' 사이에 다른 요청이 끼지 않았습니다. 여기서는 쓰기를 트랜잭션 하나로 하고
    사당 행을 FOR UPDATE로 잡습니다. 같은 자리 · 도메인 · slug를 동시에 쓰면 UNIQUE 제약이 막고
    ``sqlalchemy.exc.IntegrityError``가 올라갑니다 (운영자 화면은 Node의 UNIQUE 오류와 같은 409로 답함).
  · 사당 표를 바꾼 뒤 사당 캐시를 비웁니다 (커밋 뒤에 한 번 더: shrines.invalidate_after_commit).
    다른 프로세스(운영 명령)가 바꾼 것은 서버 캐시가 30초 안에 다시 읽습니다 (Node와 같음).
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .logic import chat as chat_logic
from .logic.jsnum import is_integer, is_number, json_stringify, number_to_string
from .logic.jsstr import canonical, js_lower, js_trim, slice_units
from .logic.links import (
    CATEGORY_KEYS,
    GOSA_DEFAULT,
    SLUG_RE,
    domain_of,
    from_row,
    is_gosa_key,
    is_prayer_key,
    is_valid_email,
    parse_github,
    read_links,
    slugify,
    unique_slug,
    validate_shrine,
)
from .logic.util import kst_date, now_ms
from .logic.world import CHANNELS, PLOTS, is_channel
from .shrines import clear_shrine_cache, free_plots_in, insert_shrine, invalidate_after_commit, plot_taken

__all__ = [
    "BIGINT_MAX", "OpError", "add_shrine", "admin_log", "all_posts_for_admin", "clean_note", "clean_op_text", "delete_post",
    "find_post", "move_shrine", "move_text", "post_counts", "posts_for_review", "read_log", "remove_shrine",
    "set_post_hidden", "set_shrine_status", "shrines_for_admin", "spot_name", "update_shrine",
]  # fmt: skip

NAME_MAX = 20
TAGLINE_MAX = 40
SIGN_MAX = 8
OPERATOR_MAX = 20
NOTE_MAX = 80
#: PostgreSQL BIGINT 상한 (넘는 번호는 '없는 것'으로)
BIGINT_MAX = 2**63 - 1
#: 로그인 실패 기록은 최근 1000건만 둡니다 (admin.ts LOGIN_FAIL_KEEP)
LOGIN_FAIL_KEEP = 1000


class OpError(chat_logic.OpError):
    """ops.ts ``OpError``: 화면에 그대로 보여 줄 한국어 메시지 + HTTP 상태 (기본 400)."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def _num(v: Any) -> str:
    """템플릿 문자열 안의 값 (`${v}`)."""
    if v is True or v is False:
        return "true" if v else "false"
    if is_number(v):
        return number_to_string(v)
    return "undefined" if v is None else str(v)


def clean_op_text(raw: Any, max_len: int, label: str, optional: bool = False) -> str:
    """ops.ts ``cleanOpText`` (logic.chat.clean_op_text) — 실패는 OpError(400)."""
    try:
        return chat_logic.clean_op_text(raw, max_len, label, optional)
    except OpError:
        raise
    except chat_logic.OpError as e:
        raise OpError(str(e)) from None


def clean_note(raw: Any) -> str:
    """메모 · 사유 (없어도 됨, 80자까지)."""
    return clean_op_text(raw, NOTE_MAX, "사유", True)


def _sign_from(tagline: str) -> str:
    """``[...tagline].slice(0, 8).join('').trim()``"""
    return js_trim("".join(list(canonical(tagline))[:SIGN_MAX]))


def _read_category(raw: Any) -> str:
    if not isinstance(raw, str) or raw not in CATEGORY_KEYS:
        raise OpError("분류를 골라 주세요")
    return raw


def _read_gosa(raw: Any) -> str:
    """고사상 물건 (logic/links.py GOSA_KEYS). 비우면(None · '') 기본 'cake'."""
    if raw is None or (isinstance(raw, str) and raw == ""):
        return GOSA_DEFAULT
    if is_gosa_key(raw):
        return raw
    raise OpError("고사상을 골라 주세요 (cake · wreath · siru · bugeo)")


def _read_status(raw: Any) -> str:
    if raw in ("live", "check") and isinstance(raw, str):
        return raw
    raise OpError("상태는 live(운영 중) 또는 check(닫힘 · 점검 중)입니다")


LINK_FAIL = {
    "github": "GitHub 저장소 주소가 올바르지 않습니다 (https://github.com/<owner>/<repo>)",
    "url": "서비스 주소는 https 도메인 주소여야 합니다 (IP · localhost · 포트 불가)",
    "link": "GitHub 저장소나 서비스 주소 중 하나는 있어야 합니다",
}


def _read_links_or_throw(github: Any, url: Any) -> dict[str, str]:
    r = read_links(github, url)
    if not r["ok"]:
        raise OpError(LINK_FAIL.get(r["reason"], LINK_FAIL["link"]))
    return r["links"]


def _links_of(s: dict[str, Any]) -> dict[str, str]:
    """사당에 저장된 대표 링크를 GitHub · 서비스 주소 두 칸으로."""
    return {"github": s["repo"], "url": "" if s["domain"].startswith("github.com/") else s["url"]}


def _ascii_digits(v: str, lo: int, hi: int) -> bool:
    """JS /^\\d{lo,hi}$/ (u 플래그 없음: \\d = [0-9])."""
    return lo <= len(v) <= hi and all("0" <= c <= "9" for c in v)


def _as_int(n: Any) -> Any:
    """정수 값(2.0 같은 실수 포함)은 int로 (DB의 INTEGER 칸 · JSON 글자는 같음)."""
    return int(n) if is_integer(n) else n


def _read_channel(raw: Any, fallback: int | None) -> int | None:
    """채널 번호 읽기 (1~3). 비어 있으면 fallback."""
    if raw is None or raw == "":
        return fallback
    if is_number(raw):
        n: Any = raw
    elif isinstance(raw, str) and _ascii_digits(raw, 1, 2):
        n = int(raw)
    else:
        n = float("nan")
    if not is_channel(n):
        raise OpError(f"없는 채널입니다 (1~{CHANNELS})")
    return int(n)


async def _read_free_plot(target: Any, raw: Any, channel: int) -> int:
    """자리 번호 읽기: 있는 자리이고 그 채널에서 비어 있어야 합니다 (채널마다 자리 20칸이 따로 있음)."""
    if is_number(raw):
        n: Any = raw
    elif isinstance(raw, str) and _ascii_digits(raw, 1, 3):
        n = int(raw)
    else:
        n = float("nan")
    if not is_integer(n) or not 0 <= n < len(PLOTS):
        raise OpError(f"없는 자리 번호입니다 (0~{len(PLOTS) - 1})")
    n = int(n)
    if await plot_taken(target, channel, n):
        raise OpError(f"이미 사당이 있는 자리입니다: 채널 {channel} · {n}번", 409)
    return n


async def _first_free_spot(target: Any, channel: int | None) -> tuple[int, int] | None:
    """첫 빈 자리: 채널을 정했으면 그 채널에서, 아니면 1번 채널부터."""
    order = [channel] if channel is not None else list(range(1, CHANNELS + 1))
    for ch in order:
        free = await free_plots_in(target, ch)
        if free:
            return ch, free[0]
    return None


def spot_name(channel: Any, plot: Any) -> str:
    """채널 · 자리를 '채널 2 · 5번'처럼."""
    return f"채널 {_num(channel)} · {_num(plot)}번"


async def _ensure_domain_free(s: AsyncSession, domain: str, except_slug: str) -> None:
    row = (
        await s.execute(text("SELECT slug FROM shrines WHERE domain = :d AND slug <> :s LIMIT 1"), {"d": domain, "s": except_slug})
    ).first()
    if row is not None:
        raise OpError(f"다른 사당({row[0]})이 같은 주소를 씁니다: {domain}", 409)


def _read_email(raw: Any) -> str:
    if raw is None or raw == "":
        return ""
    if not isinstance(raw, str):
        raise OpError("이메일 형식이 올바르지 않습니다")
    e = js_lower(js_trim(raw))
    if not e:
        return ""
    if not is_valid_email(e):
        raise OpError("이메일 형식이 올바르지 않습니다")
    return e


def _rules_or_throw(s: dict[str, Any]) -> None:
    errors = validate_shrine(s)
    if errors:
        raise OpError(f"사당 규칙에 맞지 않습니다: {' / '.join(errors)}")


async def _get_shrine(s: AsyncSession, slug: Any, *, lock: bool = False) -> dict[str, Any]:
    row = None
    if isinstance(slug, str) and SLUG_RE.fullmatch(slug):
        sql = "SELECT * FROM shrines WHERE slug = :s" + (" FOR UPDATE" if lock else "")
        row = (await s.execute(text(sql), {"s": slug})).mappings().first()
    if row is None:
        raise OpError(f"없는 사당입니다: {slice_units(slug, 0, 40) if isinstance(slug, str) else ''}", 404)
    return from_row(dict(row))


async def _taken_slugs(s: AsyncSession) -> set[str]:
    taken = {x for (x,) in await s.execute(text("SELECT slug FROM shrines"))}
    taken |= {x for (x,) in await s.execute(text("SELECT slug FROM projects WHERE slug <> ''"))}
    return taken


# ── 목록 ─────────────────────────────────────────────────────────────


async def shrines_for_admin(ctx) -> list[dict[str, Any]]:
    """사당 전부 (규칙에 어긋나 맵에서 빠진 사당도 이유와 함께)."""
    async with ctx.db.session() as s:
        rows = (await s.execute(text("SELECT * FROM shrines ORDER BY channel, plot"))).mappings().all()
    out = []
    for r in rows:
        sh = from_row(dict(r))
        out.append({**sh, "errors": validate_shrine(sh)})
    return out


# ── 넣기 ─────────────────────────────────────────────────────────────


async def add_shrine(ctx, body: dict[str, Any], screens: list[str]) -> dict[str, Any]:
    """운영자가 사당을 직접 넣습니다 (ops.ts addShrine). 도메인(저장소) 확인 날짜는 오늘로 남습니다.

    screens는 부르는 쪽이 확인한 이미지 이름('up/<이름>'). channel · plot: 비우면 자동 — 자리만 정하면 1번 채널,
    채널만 정하면 그 채널의 첫 빈 자리, 둘 다 비우면 1번 채널부터 첫 빈 자리.
    """
    name = clean_op_text(body.get("name"), NAME_MAX, "이름")
    tagline = clean_op_text(body.get("tagline"), TAGLINE_MAX, "한 줄 소개")
    sign = clean_op_text(body.get("sign"), SIGN_MAX, "지붕 소개", True) or _sign_from(tagline)
    category = _read_category(body.get("category"))
    links = _read_links_or_throw(body.get("github"), body.get("url"))
    domain = domain_of(links)
    async with ctx.db.begin() as s:
        invalidate_after_commit(s, ctx)
        await _ensure_domain_free(s, domain, "")
        operator = clean_op_text(body.get("operator"), OPERATOR_MAX, "운영 표시명", True) or "익명"
        prayer = "deploy" if body.get("prayer") is None or body.get("prayer") == "" else body.get("prayer")
        if not is_prayer_key(prayer):
            raise OpError("현판 기원을 골라 주세요")
        gosa = _read_gosa(body.get("gosa"))
        want_channel = _read_channel(body.get("channel"), None)
        if body.get("plot") is None or body.get("plot") == "":
            free = await _first_free_spot(s, want_channel)
            if free is None:
                raise OpError(f"채널 {want_channel}에는 빈 사당 자리가 없습니다" if want_channel is not None else "빈 사당 자리가 없습니다", 409)
            channel, plot = free
        else:
            channel = want_channel if want_channel is not None else 1
            plot = await _read_free_plot(s, body.get("plot"), channel)
        status = _read_status(body["status"] if body.get("status") is not None else "live")
        email = _read_email(body.get("email"))
        raw_slug = body.get("slug")
        taken = await _taken_slugs(s)
        if isinstance(raw_slug, str) and js_trim(raw_slug):
            slug = js_lower(js_trim(raw_slug))
            if not SLUG_RE.fullmatch(slug):
                raise OpError("주소 이름(slug)은 영문 소문자 · 숫자 · 하이픈 1~40자입니다")
            if unique_slug(slug, taken) != slug:
                raise OpError(f"이미 쓰는 주소 이름입니다: {slug}", 409)
        else:
            g = parse_github(links["github"]) if links["github"] else None
            slug = unique_slug(slugify(g["repo"] if g else "") or slugify(name) or slugify(domain) or "shrine", taken)
        today = kst_date()
        sh: dict[str, Any] = {
            "slug": slug, "name": name, "tagline": tagline, "category": category, "domain": domain,
            "url": links["url"] or links["github"], "operator": operator, "keeper": body.get("keeper") is True,
            "paid": False, "verifiedDomain": today, "verifiedBusiness": None, "joinedAt": today, "status": status,
            "prayer": prayer, "charm": None, "deco": [], "screens": screens, "capturedAt": today, "channel": channel,
            "plot": plot, "repo": links["github"], "email": email,
            "emailPublic": body.get("emailPublic") is True if email else False, "projectId": 0, "sign": sign, "gosa": gosa,
        }  # fmt: skip
        _rules_or_throw(sh)
        await insert_shrine(s, sh)
    clear_shrine_cache(ctx)
    return sh


# ── 고치기 ───────────────────────────────────────────────────────────

_FIELDS = ("name", "tagline", "sign", "category", "operator", "status", "domain", "url", "repo", "screens", "gosa")


async def update_shrine(ctx, slug_raw: Any, body: dict[str, Any], screens: list[str] | None = None) -> dict[str, Any]:
    """이름 · 한 줄 소개 · 지붕 소개 · 분류 · 링크 · 운영 표시명 · 상태 · 이미지 · 고사상을 고칩니다 (보낸 칸만) → {shrine, changed}.

    등록소에서 온 사당이면 접수 기록도 같이 고쳐서, 작성자가 나중에 고칠 때 되돌아가지 않게 합니다.
    """
    async with ctx.db.begin() as s:
        cur = await _get_shrine(s, slug_raw, lock=True)
        nxt = dict(cur)
        if "name" in body:
            nxt["name"] = clean_op_text(body["name"], NAME_MAX, "이름")
        if "tagline" in body:
            nxt["tagline"] = clean_op_text(body["tagline"], TAGLINE_MAX, "한 줄 소개")
        if "sign" in body:
            nxt["sign"] = clean_op_text(body["sign"], SIGN_MAX, "지붕 소개", True) or _sign_from(nxt["tagline"])
        if "category" in body:
            nxt["category"] = _read_category(body["category"])
        if "operator" in body:
            nxt["operator"] = clean_op_text(body["operator"], OPERATOR_MAX, "운영 표시명", True) or "익명"
        if "status" in body:
            nxt["status"] = _read_status(body["status"])
        if "gosa" in body:
            nxt["gosa"] = _read_gosa(body["gosa"])
        if "github" in body or "url" in body:
            now = _links_of(cur)
            links = _read_links_or_throw(body["github"] if "github" in body else now["github"], body["url"] if "url" in body else now["url"])
            nxt["domain"] = domain_of(links)
            nxt["url"] = links["url"] or links["github"]
            nxt["repo"] = links["github"]
            if nxt["domain"] != cur["domain"]:
                await _ensure_domain_free(s, nxt["domain"], cur["slug"])
                # 직접 넣은 사당은 운영자가 새 주소를 확인한 날로
                if not cur["projectId"]:
                    nxt["verifiedDomain"] = kst_date()
        if screens is not None:
            nxt["screens"] = screens
        changed = [k for k in _FIELDS if json_stringify(nxt[k]) != json_stringify(cur[k])]
        if not changed:
            return {"shrine": cur, "changed": changed}
        _rules_or_throw(nxt)
        invalidate_after_commit(s, ctx)
        await s.execute(
            text(
                """UPDATE shrines SET name = :name, tagline = :tagline, sign = :sign, category = :category, operator = :operator,
                     status = :status, domain = :domain, url = :url, repo = :repo, screens = :screens, verified_domain = :vd,
                     gosa = :gosa
                   WHERE slug = :slug"""
            ),
            {
                "name": nxt["name"], "tagline": nxt["tagline"], "sign": nxt["sign"], "category": nxt["category"],
                "operator": nxt["operator"], "status": nxt["status"], "domain": nxt["domain"], "url": nxt["url"],
                "repo": nxt["repo"], "screens": json_stringify(nxt["screens"]), "vd": nxt["verifiedDomain"], "gosa": nxt["gosa"],
                "slug": cur["slug"],
            },
        )  # fmt: skip
        if cur["projectId"]:
            lk = _links_of(nxt)
            first = nxt["screens"][0] if nxt["screens"] else ""
            img = first[3:] if first.startswith("up/") else ""
            await s.execute(
                text(
                    """UPDATE projects SET name = :name, tagline = :tagline, sign = :sign, category = :category, github = :github,
                         url = :url, screen = :screen WHERE id = :id"""
                ),
                {
                    "name": nxt["name"], "tagline": nxt["tagline"], "sign": nxt["sign"], "category": nxt["category"],
                    "github": lk["github"], "url": lk["url"], "screen": img, "id": cur["projectId"],
                },
            )  # fmt: skip
            if "gosa" in changed:
                # 작성자가 관리 화면에서 보는 값도 같게 (고른 적이 없으면 NULL 그대로 두려고 바뀐 때만)
                await s.execute(text("UPDATE projects SET gosa = :g WHERE id = :id"), {"g": nxt["gosa"], "id": cur["projectId"]})
    clear_shrine_cache(ctx)
    return {"shrine": nxt, "changed": changed}


async def set_shrine_status(ctx, slug: Any, status: Any) -> dict[str, Any]:
    """상태: live(운영 중) · check(닫힘 · 점검 중)."""
    st = _read_status(status)
    async with ctx.db.begin() as s:
        cur = await _get_shrine(s, slug, lock=True)
        invalidate_after_commit(s, ctx)
        await s.execute(text("UPDATE shrines SET status = :st WHERE slug = :slug"), {"st": st, "slug": cur["slug"]})
    clear_shrine_cache(ctx)
    return {**cur, "status": st}


async def move_shrine(ctx, slug: Any, plot_raw: Any, channel_raw: Any = None) -> dict[str, Any]:
    """다른 빈 자리로 옮기기 → {shrine, from, fromChannel}. 채널을 비우면 지금 채널 안에서, 정하면 그 채널의 빈 자리로."""
    async with ctx.db.begin() as s:
        cur = await _get_shrine(s, slug, lock=True)
        channel = _read_channel(channel_raw, cur["channel"])
        if channel is None:
            channel = cur["channel"]
        plot = await _read_free_plot(s, plot_raw, channel)
        invalidate_after_commit(s, ctx)
        await s.execute(
            text("UPDATE shrines SET channel = :ch, plot = :pl WHERE slug = :slug"), {"ch": channel, "pl": plot, "slug": cur["slug"]}
        )
    clear_shrine_cache(ctx)
    return {"shrine": {**cur, "channel": channel, "plot": plot}, "from": cur["plot"], "fromChannel": cur["channel"]}


def move_text(r: dict[str, Any]) -> str:
    """옮긴 기록 · 안내 글: 같은 채널이면 '0 → 12', 채널이 바뀌면 '채널 1 · 0번 → 채널 2 · 12번'."""
    sh = r["shrine"]
    if r["fromChannel"] == sh["channel"]:
        return f"{_num(r['from'])} → {_num(sh['plot'])}"
    return f"{spot_name(r['fromChannel'], r['from'])} → {spot_name(sh['channel'], sh['plot'])}"


async def remove_shrine(ctx, slug: Any, note_raw: Any = "") -> dict[str, Any]:
    """맵에서 내리기. 등록소에서 온 사당이면 그 접수는 '반려'(사유: removed)로 바꿔서, 작성자가 고쳐 다시 내면
    검토 대기로 돌아오게 합니다. 올린 이미지는 하루 뒤 정리됩니다 (uploads.py)."""
    async with ctx.db.begin() as s:
        cur = await _get_shrine(s, slug, lock=True)
        why = clean_note(note_raw)
        invalidate_after_commit(s, ctx)
        await s.execute(text("DELETE FROM shrines WHERE slug = :slug"), {"slug": cur["slug"]})
        if cur["projectId"]:
            # 반려로 바꾸고 검토 대기 값은 버립니다. closed_at부터 30일 뒤 retention.py가 개인정보를 파기합니다
            await s.execute(
                text(
                    """UPDATE projects SET status = 'rejected', pending_github = NULL, pending_url = NULL, pending_screen = NULL,
                         pending_name = NULL, pending_tagline = NULL, pending_sign = NULL, review_at = NULL, closed_at = :now,
                         note = :note
                       WHERE id = :id AND status = 'approved'"""
                ),
                {"now": now_ms(), "note": f"removed: {why}" if why else "removed", "id": cur["projectId"]},
            )
    clear_shrine_cache(ctx)
    return cur


# ── 게시판 (ai.ts 운영자 쪽) ─────────────────────────────────────────

_POST_COLS = """p.id, p.at, p.topic, p.text, p.nick, p.hidden,
                (SELECT COUNT(*) FROM post_reports r WHERE r.post_id = p.id) AS reports"""


def _post(r: Any) -> dict[str, Any]:
    return {
        "id": r["id"], "at": r["at"], "topic": r["topic"], "text": r["text"], "nick": r["nick"],
        "hidden": r["hidden"], "reports": int(r["reports"]),
    }  # fmt: skip


async def all_posts_for_admin(ctx, limit: int = 100) -> list[dict[str, Any]]:
    """운영 명령 posts: 새 글부터 (숨긴 글 포함)."""
    async with ctx.db.session() as s:
        rows = await s.execute(text(f"SELECT {_POST_COLS} FROM posts p ORDER BY p.at DESC, p.id DESC LIMIT :n"), {"n": limit})
        return [_post(r) for r in rows.mappings()]


async def posts_for_review(ctx, limit: int = 200) -> list[dict[str, Any]]:
    """운영자 화면: 신고된 글 먼저, 그다음 새 글부터 (숨긴 글 포함)."""
    sql = f"""SELECT * FROM (SELECT {_POST_COLS} FROM posts p) x
              ORDER BY (x.reports > 0) DESC, x.at DESC, x.id DESC LIMIT :n"""
    async with ctx.db.session() as s:
        rows = await s.execute(text(sql), {"n": limit})
        return [_post(r) for r in rows.mappings()]


async def post_counts(ctx) -> dict[str, int]:
    """운영자 화면 요약: 신고가 하나라도 있는 글 · 숨긴 글 · 보관 중인 글."""
    async with ctx.db.session() as s:

        async def n(sql: str) -> int:
            return int((await s.execute(text(sql))).scalar_one())

        return {
            "reported": await n("SELECT COUNT(DISTINCT r.post_id) FROM post_reports r JOIN posts p ON p.id = r.post_id"),
            "hidden": await n("SELECT COUNT(*) FROM posts WHERE hidden = 1"),
            "total": await n("SELECT COUNT(*) FROM posts"),
        }


def _id_ok(pid: Any) -> bool:
    return is_integer(pid) and -BIGINT_MAX <= pid <= BIGINT_MAX


async def find_post(ctx, pid: Any) -> dict[str, Any] | None:
    if not _id_ok(pid):
        return None
    async with ctx.db.session() as s:
        r = (
            await s.execute(text("SELECT id, at, topic, text, nick, hidden FROM posts WHERE id = :id"), {"id": int(pid)})
        ).mappings().first()
    return dict(r) if r is not None else None


async def set_post_hidden(ctx, pid: Any, hidden: bool) -> bool:
    if not _id_ok(pid):
        return False
    async with ctx.db.begin() as s:
        r = await s.execute(text("UPDATE posts SET hidden = :h WHERE id = :id"), {"h": 1 if hidden else 0, "id": int(pid)})
        return (r.rowcount or 0) > 0


async def delete_post(ctx, pid: Any) -> bool:
    if not _id_ok(pid):
        return False
    async with ctx.db.begin() as s:
        await s.execute(text("DELETE FROM post_reports WHERE post_id = :id"), {"id": int(pid)})
        r = await s.execute(text("DELETE FROM posts WHERE id = :id"), {"id": int(pid)})
        return (r.rowcount or 0) > 0


# ── 운영 기록 (admin_log) ────────────────────────────────────────────

_PRUNE_LOGIN_FAILS = text(
    """DELETE FROM admin_log WHERE action = 'login-fail' AND id <=
         (SELECT id FROM admin_log WHERE action = 'login-fail' ORDER BY id DESC LIMIT 1 OFFSET :keep)"""
)


async def admin_log(ctx, action: str, target: Any = "", ip_hash: str = "", detail: str = "") -> None:
    """admin_log 한 줄: 시각 · 작업 · 대상(80자) · 관리자 IP 해시(운영 명령은 'cli') · 내용(200자).
    로그인 실패는 최근 1000건만 둡니다."""
    async with ctx.db.begin() as s:
        await s.execute(
            text("INSERT INTO admin_log (at, action, target, ip_hash, detail) VALUES (:at, :a, :t, :ip, :d)"),
            {"at": now_ms(), "a": action, "t": slice_units(_num(target), 0, 80), "ip": ip_hash, "d": slice_units(detail, 0, 200)},
        )
        if action == "login-fail":
            await s.execute(_PRUNE_LOGIN_FAILS, {"keep": LOGIN_FAIL_KEEP})


async def read_log(ctx, limit_raw: str | None) -> list[dict[str, Any]]:
    """``Number(limit ?? 100)``가 양의 정수면 500까지, 아니면 100개 (새것부터)."""
    from .registry import js_to_number

    n = js_to_number("100" if limit_raw is None else limit_raw)
    limit = min(int(n), 500) if is_integer(n) and n > 0 else 100
    async with ctx.db.session() as s:
        rows = await s.execute(
            text("SELECT id, at, action, target, ip_hash AS ip, detail FROM admin_log ORDER BY id DESC LIMIT :n"), {"n": limit}
        )
        return [dict(r) for r in rows.mappings()]


__all__ += ["LINK_FAIL", "NAME_MAX", "NOTE_MAX", "TAGLINE_MAX", "_as_int"]
