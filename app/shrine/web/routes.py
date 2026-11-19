"""BASE_PATH 아래 라우트를 Node(http.ts handleRequest 389-435)와 같은 순서로 붙입니다.

front.py가 1~7단계(헬스 체크 · 요청 제한 · robots · BASE 리다이렉트 · 밖이면 404)를 마친 요청만 여기 옵니다.
scope['path']는 Node의 pathname(퍼센트 인코딩 그대로, 점 조각 정리)이라서 /api/%77orld는 /api/world와 다릅니다.

순서 (나중 단계는 표시한 자리에 라우터를 넣습니다. 경로가 서로 겹치지 않아 순서는 주로 읽기용입니다):
   8. 운영자 (/admin…, /api/admin…)            → admin.routes()          [P4가 채움]
   9. GET/HEAD /                                → pages
  10. GET/HEAD /privacy · /terms                 → pages
  11. GET/HEAD /legal/(privacy|terms).html 301   → pages
  12. GET/HEAD /sitemap.xml                      → pages
  13~20. /api/world · /api/posts · /api/enter · /api/upload · /api/submit · /api/manage/* ·
         /img/shrines/up/* · /api/submit/<code> · /go/<slug>               [P2: 모듈마다 build_router()]
  21. 그 밖 GET/HEAD → 정적 파일, 22. 그 밖 메서드 → 404 글자              → fallback (늘 맨 끝)

라우터 작성 규칙 (나중 단계):
  · FastAPI 라우트는 메서드가 다르면 405를 내지 않고 맨 끝 fallback으로 갑니다(fallback이 모든 경로 · 메서드를 받음).
    그래서 Node처럼 "GET만" 라우트에 HEAD가 오면 정적 파일 → 404가 됩니다. GET과 HEAD를 둘 다 받으려면
    methods=["GET", "HEAD"]로 적습니다 (FastAPI는 GET에 HEAD를 저절로 붙이지 않음).
  · 본문은 FastAPI 모델로 받지 말고 직접 읽습니다 (Node는 형식이 틀리면 422가 아니라 {ok:false, reason:'bad'}).
  · 응답은 responses.py의 NodeResponse · json_response 등으로 (Starlette Response는 머리글을 덧붙임).
  · 경로 조각은 Node 정규식으로 다시 확인합니다 (예: /go/{slug}는 [a-z0-9-]{1,40}).
"""

from __future__ import annotations

from fastapi import FastAPI
from starlette.requests import Request
from starlette.routing import Route

from ..context import AppContext
from . import admin, pages
from .responses import AnyMethod, NodeResponse, not_found


def install(app: FastAPI, ctx: AppContext) -> None:
    base = ctx.config.base_path
    page = pages.Pages(ctx.config)

    # 8. 운영자
    app.router.routes.extend(admin.routes(base))
    # 9~12. 첫 화면 · 문서 · 사이트맵
    app.include_router(pages.build_router(page), prefix=base)
    # 13~20. (P2) 공개 API · 업로드 이미지 · /go

    # 21~22. 그 밖: GET/HEAD는 정적 파일, 나머지 메서드는 404 글자
    async def fallback(request: Request) -> NodeResponse:
        if request.method in ("GET", "HEAD"):
            return await page.static(request, request.scope["path"][len(base) :])
        return not_found()

    app.router.routes.append(Route("/{rest:path}", AnyMethod(fallback), include_in_schema=False))
