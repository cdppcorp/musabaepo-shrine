# 무사배포 기원소 (Python 서버: FastAPI · uvicorn). 빌드 맥락은 저장소 루트입니다.
#   docker build -f app/Dockerfile -t musabaepo-shrine-api .        (deploy/docker-compose.yml이 이렇게 부름)
# 넣는 파일은 app/Dockerfile.dockerignore가 허용 목록으로 정합니다 (.env · data · 시험 · .venv는 들어가지 않음).
# 이미지 안 배치는 저장소와 같게 둡니다: /srv/shrine/app/shrine (코드), /srv/shrine/public (화면 파일).

# Python은 마이너 버전까지 고정합니다. 올릴 때는 두 FROM 줄을 같이 바꿉니다.
FROM python:3.13-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/srv/shrine/app/.venv
WORKDIR /srv/shrine/app
# 의존성만 먼저 (코드가 바뀌어도 이 층은 다시 쓰임). 프로젝트 자체는 설치하지 않고 작업 폴더에서 바로 불러옵니다
COPY app/pyproject.toml app/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev --no-install-project
COPY app/shrine ./shrine
COPY app/alembic ./alembic
COPY app/alembic.ini ./
# 읽기 전용 컨테이너에서 .pyc를 쓰지 못하므로 미리 만들어 둡니다
RUN .venv/bin/python -m compileall -q shrine alembic

FROM python:3.13-slim
# 앱 사용자: 1000번 (호스트 deploy/backups 폴더 주인과 같게)
RUN groupadd --gid 1000 shrine && useradd --uid 1000 --gid 1000 --no-create-home --shell /usr/sbin/nologin shrine \
    && mkdir -p /data && chown shrine:shrine /data
WORKDIR /srv/shrine/app
COPY --from=build /srv/shrine/app /srv/shrine/app
COPY public /srv/shrine/public

ENV PATH=/srv/shrine/app/.venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONIOENCODING=utf-8 \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3300 \
    DATA_DIR=/data \
    PUBLIC_DIR=/srv/shrine/public
USER shrine
EXPOSE 3300

# 헬스 체크: GET ${BASE_PATH}/healthz가 200이면 정상. wget이 없어 Python 표준 라이브러리로 봅니다
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD ["python", "-m", "shrine.healthcheck"]

# 워커는 1개만 (채널 · 접속자 · 그날 IP 소금이 프로세스 메모리에 있음). 시작할 때 DB 구조를 스스로 올립니다
CMD ["python", "-m", "shrine"]
