"""운영자 알림 (server/notify.ts). NOTIFY_WEBHOOK_URL(슬랙 · 디스코드 웹훅)로 짧은 글을 보내고 기다리지 않습니다.

  · 주소가 비어 있으면 아무것도 하지 않습니다.
  · 3초 안에 답이 없으면 끊고, 실패는 경고 한 줄만 남깁니다. 절대 예외를 올리지 않습니다.
  · 분당 20개를 넘으면 버리고, 다음 알림에 버린 개수를 붙입니다 (이 프로세스 안에서 셈 — Node와 같음).
  · 이메일 · PIN · 입장 표 같은 개인정보는 넣지 않습니다. 이름에 그런 말이 들어간 칸은 빼고, 값에 메일 주소처럼
    생긴 글자가 있으면 가립니다. 멘션(@everyone, <!channel>)이 되지 않게 @ 뒤에 U+200B, <> → ‹›.

글자 다듬기 · 길이 자르기는 JS 문자열(UTF-16 코드 단위) 기준으로 Node와 같은 글자를 만듭니다.

    from shrine import notify
    notify.configure(config.notify_webhook_url)   # 시작할 때 (main · cli)
    notify.notify("새 접수", {"접수": 3, "이름": "…"})
    await notify.drain()                           # 운영 명령처럼 곧 끝나는 프로세스: 보내기가 끝날 때까지
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Mapping
from typing import Any

import httpx

from .logic.jsnum import json_stringify, number_to_string, ordered_items
from .logic.jsstr import JS_WS_CLASS, canonical, to_utf16_units

log = logging.getLogger("shrine.notify")

TIMEOUT_S = 3.0
PER_MINUTE = 20
MAX_TEXT = 1_800
MAX_VALUE = 200
#: JS /…$|…/i (u 플래그 없음): 대소문자 무시는 ASCII만, $는 문자열 끝만
PRIVATE_KEY = re.compile(r"\A(?:ip|sid|pin)(?:_?key|_?hash)?\Z|e-?mail|pass|secret|token|ticket|cookie|hash", re.I | re.A)
#: JS /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/g (\s는 JS 공백)
EMAIL_LIKE = re.compile(f"[^{JS_WS_CLASS}@<>]+@[^{JS_WS_CLASS}@<>]+\\.[^{JS_WS_CLASS}@<>]+")
_CONTROL = re.compile("[\u0000-\u0008\u000b-\u001f\u007f]")


def js_string(v: Any) -> str:
    """JS ``String(v)`` (알림 값에 올 만한 것만: 글자 · 숫자 · 참거짓 · 배열 · 객체)."""
    if isinstance(v, str):
        return v
    if v is True:
        return "true"
    if v is False:
        return "false"
    if v is None:
        return "null"
    if isinstance(v, (int, float)):
        return number_to_string(v)
    if isinstance(v, (list, tuple)):
        return ",".join("" if x is None else js_string(x) for x in v)
    return "[object Object]"


def clean(value: str, max_len: int) -> str:
    """notify.ts ``clean``: 메일 가림 · 멘션 무력화 · 제어 문자 제거 뒤 max_len(코드 단위)에서 자르고 '…'."""
    s = to_utf16_units(value)
    s = EMAIL_LIKE.sub("[메일 가림]", s)
    s = s.replace("@", "@​").replace("<", "‹").replace(">", "›")
    s = _CONTROL.sub("", s)
    if len(s) > max_len:
        s = s[: max_len - 1] + "…"
    return canonical(s)


def build_text(event: str, fields: Mapping[str, Any], skipped: int) -> str:
    """notify.ts ``buildText``: 첫 줄 '[무사배포 기원소] 이벤트', 다음 줄부터 '• 키: 값'."""
    lines = [f"[무사배포 기원소] {clean(event, 60)}"]
    for key, raw in ordered_items(fields):
        if PRIVATE_KEY.search(key):
            continue
        if isinstance(raw, (int, float)) and not isinstance(raw, bool):
            value = number_to_string(raw)
        else:
            value = clean(js_string("" if raw is None else raw), MAX_VALUE)
        lines.append(f"• {clean(key, 40)}: {value}")
    if skipped > 0:
        lines.append(f"(앞서 알림 {skipped}건을 상한 때문에 건너뜀)")
    text = to_utf16_units("\n".join(lines))
    if len(text) > MAX_TEXT:
        text = text[: MAX_TEXT - 1] + "…"
    return canonical(text)


class Notifier:
    """프로세스 하나에 하나 (Node의 모듈 변수와 같음). 시험에서는 따로 만들어 씁니다."""

    def __init__(self, url: str = "") -> None:
        self.url = url
        self._window_start = 0.0
        self._sent = 0
        self._dropped = 0
        self._pending: set[asyncio.Task] = set()

    def configure(self, url: str) -> None:
        self.url = url or ""

    def notify(self, event: str, fields: Mapping[str, Any]) -> None:
        """기다리지 않고 보냅니다. 실패해도 예외를 올리지 않습니다. fields에는 공개해도 되는 값만."""
        try:
            if not self.url:
                return
            now = time.monotonic() * 1000
            if now - self._window_start >= 60_000:
                self._window_start = now
                self._sent = 0
            if self._sent >= PER_MINUTE:
                self._dropped += 1
                return
            self._sent += 1
            text = build_text(event, fields, self._dropped)
            self._dropped = 0
            # 슬랙은 text, 디스코드는 content를 읽습니다. 둘 다 모르는 칸은 무시합니다.
            body = (json_stringify({"text": text, "content": text}) or "").encode("utf-8")
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                return  # 이벤트 루프 밖 (부르는 쪽은 모두 async라 생기지 않음)
            task = loop.create_task(self._send(self.url, body), name="shrine:notify")
            self._pending.add(task)
            task.add_done_callback(self._pending.discard)
        except Exception:  # noqa: BLE001 — 알림 때문에 요청 처리가 실패하면 안 됩니다
            pass

    async def _send(self, url: str, body: bytes) -> None:
        try:
            async with httpx.AsyncClient(follow_redirects=False, trust_env=False, timeout=TIMEOUT_S) as client:
                res = await asyncio.wait_for(
                    client.post(url, content=body, headers={"Content-Type": "application/json"}), TIMEOUT_S
                )
            if 300 <= res.status_code < 400:
                # Node fetch(redirect: 'error')는 다른 주소로 보내면 TypeError로 실패합니다
                log.warning("[shrine] 알림 실패: TypeError")
            elif not 200 <= res.status_code < 300:
                log.warning("[shrine] 알림 실패: HTTP %s", res.status_code)
        except (asyncio.TimeoutError, httpx.TimeoutException):
            log.warning("[shrine] 알림 실패: TimeoutError")
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.warning("[shrine] 알림 실패: TypeError")

    async def drain(self, timeout: float = TIMEOUT_S + 1) -> None:
        """보내는 중인 알림이 끝날 때까지 (운영 명령 · 시험용 훅이 끝나기 전에)."""
        if self._pending:
            await asyncio.wait(list(self._pending), timeout=timeout)


#: 이 프로세스의 알림 (server/notify.ts의 모듈 상태)
notifier = Notifier()


def configure(url: str) -> None:
    notifier.configure(url)


def notify(event: str, fields: Mapping[str, Any]) -> None:
    notifier.notify(event, fields)


async def drain(timeout: float = TIMEOUT_S + 1) -> None:
    await notifier.drain(timeout)
