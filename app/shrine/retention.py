"""개인정보 보관 기간 (server/retention.ts, 개인정보처리방침과 같은 숫자).

  · 검토를 PENDING_DAYS(90일) 동안 처리하지 못하면 저절로 끝냅니다.
      새 접수 → 반려(note 'expired'). 맵에 있는 사당의 변경 요청 → 바꾸려던 것만 버리고 사당은 그대로.
  · 반려되거나 작성자가 내린 접수는 RETENTION_DAYS(30일) 뒤 이메일 · PIN 해시 · 링크 · 이름 · 올린 이미지를 파기합니다
    (번호 · 시각 · 분류 · 상태 같은 개인정보가 아닌 기록만 남김). 그 접수의 pin_locks · Redis PIN 기록도 지웁니다.
  · 게시판 글은 7일, 신고 기록은 글과 함께 지웁니다.
  · 작성자가 요청하면 운영자가 바로 파기: destroy_project_now(ctx, 번호).
시작할 때 한 번, 그다음 하루에 한 번 (install_tasks). 시험할 때만 RETENTION_DAYS · PENDING_DAYS를 줄입니다 (0이면 바로).
"""

from __future__ import annotations

import logging
from typing import Any

from . import notify as notify_mod
from . import posts
from .logic.jsnum import is_integer, number_to_string
from .logic.util import DAY_MS, now_ms
from .registry import closed_before, erase_project, expire_stale_reviews, prune_pin_locks, purge_project
from .uploads import cleanup_uploads, remove_uploads

log = logging.getLogger("shrine.retention")


async def prune_posts(ctx, now: int | None = None) -> dict[str, int]:
    """7일 지난 글과 그 신고 기록(그리고 글이 없어진 신고 기록)을 지웁니다 (ai.ts prunePosts → posts.py). 한 트랜잭션."""
    return await posts.prune_posts(ctx, now)


def _days(v: float) -> str:
    return number_to_string(v)


async def run_retention(ctx, now: int | None = None) -> dict[str, int]:
    """한 번 돌리기 (retention.ts runRetention). 무엇을 얼마나 했는지 (개인정보 없음):
    {expired, expiredChanges, purged, images, posts, reports}."""
    now = now_ms() if now is None else now
    config = ctx.config
    stale = await expire_stale_reviews(ctx, now - config.pending_days * DAY_MS, now)
    purged = 0
    images = 0
    for pid in await closed_before(ctx, now - config.retention_days * DAY_MS, now):
        files = await purge_project(ctx, pid, now)
        if files is None:
            continue
        purged += 1
        images += await remove_uploads(ctx, files)
    p = await prune_posts(ctx, now)
    result = {
        "expired": stale["registrations"], "expiredChanges": stale["changes"], "purged": purged, "images": images,
        "posts": p["posts"], "reports": p["reports"],
    }  # fmt: skip
    if stale["registrations"] or stale["changes"] or purged:
        print(
            f"[shrine] 보관 기간 정리: 기한 지난 접수 {stale['registrations']} · 변경 요청 {stale['changes']}, "
            f"파기 {purged}건 (이미지 {images})",
            flush=True,
        )
    if stale["registrations"] or stale["changes"]:
        notify_mod.notify(
            f"검토 기한({_days(config.pending_days)}일)이 지나 저절로 끝냄",
            {"접수": stale["registrations"], "변경 요청": stale["changes"]},
        )
    return result


async def destroy_project_now(ctx, pid: Any) -> dict[str, Any]:
    """작성자 요청으로 바로 파기 (운영자 화면 · 운영 도구). 맵에 있으면 사당도 뺍니다. {ok, images, message}."""
    if not is_integer(pid) or pid <= 0:
        return {"ok": False, "images": 0, "message": f"없는 접수입니다: {_id_text(pid)}"}
    files = await erase_project(ctx, int(pid))
    if files is None:
        return {"ok": False, "images": 0, "message": f"없는 접수입니다: {_id_text(pid)}"}
    images = await remove_uploads(ctx, files)
    return {"ok": True, "images": images, "message": f"접수 #{_id_text(pid)}의 개인정보를 파기했습니다 (이미지 {images}개)"}


def _id_text(v: Any) -> str:
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return number_to_string(v)
    return str(v)


async def _safe_retention(ctx) -> None:
    try:
        await run_retention(ctx)
    except Exception as e:  # noqa: BLE001 — 다음 날 다시 돕니다
        log.error("[shrine] 보관 기간 정리 실패: %s", e)


async def _safe_cleanup(ctx) -> None:
    try:
        await cleanup_uploads(ctx)
    except Exception:  # noqa: BLE001
        log.exception("[shrine] 이미지 정리 실패")


async def _safe_pin_locks(ctx) -> None:
    try:
        await prune_pin_locks(ctx)
    except Exception:  # noqa: BLE001
        log.exception("[shrine] PIN 잠금 기록 정리 실패")


def install_tasks(ctx) -> None:
    """주기 작업 (main.ts:135-145, registry.ts 끝): 업로드 정리(시작 + 6시간마다) · 보관 기간(시작 + 하루마다) ·
    풀린 PIN 잠금 기록(1시간마다). ctx.on_startup에서 부릅니다."""
    ctx.tasks.every("업로드 정리", 6 * 3600, lambda: _safe_cleanup(ctx), immediate=True)
    ctx.tasks.every("보관 기간", 24 * 3600, lambda: _safe_retention(ctx), immediate=True)
    ctx.tasks.every("PIN 잠금 정리", 3600, lambda: _safe_pin_locks(ctx), immediate=False)
