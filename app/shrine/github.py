"""GitHub 공개 저장소 확인 (registry.ts checkGithub).

GET https://api.github.com/repos/{owner}/{repo} — 3초 안에, 다시 하지 않음.
  · 404 → 없음(False), 비공개(private) → 없음(False)
  · 그 밖 오류 · 시간 초과 · 응답이 이상함 → 확인 못 함(None, 접수는 통과하고 repo_ok=0)
  · GITHUB_CHECK=off면 부르지 않음(None). config가 대소문자 · 빈칸을 정리한 값(github_check)을 씁니다
    (Node는 정확히 소문자 'off'만 봤습니다 — config.py 머리말의 일부러 다른 점).
  · GITHUB_TOKEN(권한 없는 토큰)이 있으면 Authorization: Bearer … (서버 IP당 시간 60번 제한 대신 토큰 제한)
"""

from __future__ import annotations

import asyncio
import math
from typing import Any
from urllib.parse import quote

import httpx

from .logic.jsnum import JSONParseError, json_parse
from .logic.jsstr import utf8_decode
from .logic.links import parse_github

TIMEOUT_S = 3.0
USER_AGENT = "musabaepo-shrine"


def _stars(v: Any) -> int:
    """JS ``Number(v) || 0`` (별 수 칸에 올 만한 값만)."""
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            return 0
        return int(v)
    if isinstance(v, str):
        try:
            f = float(v.strip()) if v.strip() else 0.0
        except ValueError:
            return 0
        return 0 if math.isnan(f) or math.isinf(f) else int(f)
    return 0


async def check_github(github: str, *, enabled: bool = True, token: str = "") -> tuple[bool | None, int]:
    """(있음 여부, 별 수). 있음 여부: True · False(없음 · 비공개) · None(확인 못 함 · 끔)."""
    g = parse_github(github)
    if not g or not enabled:
        return None, 0
    url = f"https://api.github.com/repos/{quote(g['owner'], safe='')}/{quote(g['repo'], safe='')}"
    headers = {"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        async with httpx.AsyncClient(follow_redirects=True, trust_env=False, timeout=TIMEOUT_S) as client:
            res = await asyncio.wait_for(client.get(url, headers=headers), TIMEOUT_S)
        if res.status_code == 404:
            return False, 0
        if not 200 <= res.status_code < 300:
            return None, 0
        data = json_parse(utf8_decode(res.content))
    except (JSONParseError, httpx.HTTPError, asyncio.TimeoutError, OSError, ValueError):
        return None, 0
    if data is None:
        return None, 0  # JS: null.private → TypeError → 확인 못 함
    if isinstance(data, dict):
        private = data.get("private")
        if private not in (None, False, 0, "", 0.0) and not (isinstance(private, float) and math.isnan(private)):
            return False, 0
        return True, _stars(data.get("stargazers_count"))
    return True, 0


async def check_github_for(config, github: str) -> tuple[bool | None, int]:
    return await check_github(github, enabled=config.github_check, token=config.github_token)
