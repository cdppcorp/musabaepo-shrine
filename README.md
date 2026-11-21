# 무사배포 기원소

개발자가 도트 캐릭터로 걸어 다니며, 서로의 프로젝트 사당에 "무사배포" 초를 켜 주는 작은 온라인 마당입니다.
로그인 없이 들어와 캐릭터를 꾸미고, 사당을 구경하고, 초를 켜고, 말풍선으로 인사합니다.

- 서버: Python 3.13 · FastAPI + uvicorn (HTTP + WebSocket) · PostgreSQL 17 · Redis 7 (`app/`)
- 화면: 프레임워크 없는 JavaScript + Canvas 도트 그림 (`public/`)
- 배포: Docker Compose (api + PostgreSQL + Redis + Caddy, 자동 HTTPS)

## 주요 기능

- **옷장**: 종족 · 몸 색 · 눈 · 머리 모양 · 옷 · 신발 · 소품을 골라 도트 캐릭터를 만듭니다. 4방향 걷기와 절 · 손 흔들기 · 뽀뽀 · 앉기 같은 동작이 있습니다.
- **프로젝트 사당**: 등록소에서 프로젝트(GitHub 저장소 또는 서비스 주소)를 접수하면, 운영자가 확인한 뒤 맵의 빈 자리에 사당으로 올라갑니다.
  사당 앞에서 초를 켤 수 있고(같은 사당은 한 사람이 30분에 한 번), 이번 주 켜진 초가 많을수록 마당 전체가 밝아집니다.
- **채널별 사당**: 채널(1~3)마다 사당 자리 20칸이 따로 있어 사당은 모두 60곳까지 들어가고, 사당은 자기 채널에서만 보입니다.
  등록소에서 접수할 때 채널과 그 채널의 빈 자리를 고릅니다 (자리를 고르지 않으면 그 채널의 빈 자리 아무 데나).
  초는 내 채널에 있는 사당에만 켤 수 있고, NPC도 자기 채널 사당만 구경합니다. 정원이 차서 생기는 넘침 채널(4번 이상)이 있다면 1번 채널 사당을 보여 줍니다.
- **같이 노는 공간**: 채널 3개(채널마다 20명), 정해진 말 · 짧은 직접 채팅(저장하지 않음), GitHub 신당 · AI 신당 · AI 트렌드 게시판(준비 중) · 배포운 상자 · 흡연구역(온라인 한숨).
- **네비게이터**: 켜면 화면 단추와 맵 위 장소마다 설명 카드가 붙는 튜토리얼 모드 (G 키).
- **관리자 페이지 · 운영 도구**: 등록소 접수 승인 · 반려, 사당 추가 · 수정, 게시판 신고 처리.

## 로컬에서 실행

[uv](https://docs.astral.sh/uv/)와 Docker(개발용 PostgreSQL · Redis)가 필요합니다. Python 3.13은 uv가 받아 줍니다.

```bash
# 1) 개발용 PostgreSQL · Redis (한 번만. 적합성 시험도 이 두 컨테이너를 씁니다)
docker run -d --name musabaepo-dev-pg -e POSTGRES_PASSWORD=dev -p 127.0.0.1:55432:5432 postgres:17-alpine
docker run -d --name musabaepo-dev-redis -p 127.0.0.1:56379:6379 redis:7-alpine
docker exec musabaepo-dev-pg createdb -U postgres shrine_dev

# 2) 설정: 저장소 루트의 .env (git에 올라가지 않음)
cat > .env <<'EOF'
DATABASE_URL=postgresql://postgres:dev@127.0.0.1:55432/shrine_dev
REDIS_URL=redis://127.0.0.1:56379/0
DATA_DIR=../data
EOF

# 3) 띄우기 (app/ 폴더에서)
cd app
uv sync
uv run python -m shrine --env-file ../.env      # http://127.0.0.1:3300/
```

- `--env-file`은 그 파일의 값을 환경 변수로 읽습니다 (이미 있는 환경 변수가 이기고, 파일이 없으면 건너뜀). 운영 도구 · 백업 도구도 같은 옵션을 받습니다.
- 개발 모드(`NODE_ENV`가 비었거나 `development`)에서는 Turnstile 키가 없으면 사람 확인을 건너뛰고, `TICKET_SECRET`이 없으면 시작할 때마다 무작위로 만듭니다.
  운영(`NODE_ENV=production`)에서는 필요한 키가 없으면 서버가 시작하지 않습니다. 변수 이름 `NODE_ENV`는 Node 서버 때 쓰던 그대로입니다.
- DB 구조(Alembic)는 서버가 시작할 때 저절로 올립니다. 빈 DB면 처음부터 만듭니다.
- 올린 이미지는 `DATA_DIR/uploads/`에 쌓입니다 (위 예에서는 저장소 루트의 `data/`).
- 처음에는 사당이 없습니다. 등록소로 접수한 뒤 운영 도구로 승인하거나(`uv run python -m shrine.cli --env-file ../.env approve <번호>`), 관리자 페이지에서 직접 넣습니다.
- Windows에서 출력을 파일로 넘겨도 한국어가 깨지지 않게, 서버 · 운영 도구 · 백업 도구는 표준 출력 · 오류를 늘 UTF-8로 씁니다.

## 설정 (환경 변수)

`.env.example`을 `.env`로 복사해 채웁니다. 주요 값:

| 변수 | 뜻 |
|---|---|
| `NODE_ENV` | `production`(운영) 또는 `development`(개발, 기본) |
| `SHRINE_DOMAIN` · `PUBLIC_ORIGIN` | 서비스 도메인 (Caddy 인증서 · 출처 확인) |
| `TICKET_SECRET` | 입장 표 서명 키 (긴 무작위 문자열, `openssl rand -hex 32`) |
| `TURNSTILE_SITE_KEY` · `TURNSTILE_SECRET` | Cloudflare Turnstile 사람 확인 키 |
| `DATABASE_URL` | PostgreSQL 주소 (`postgresql://사용자:비밀번호@호스트:5432/DB`). Docker 배포에서는 compose가 정합니다 |
| `REDIS_URL` | Redis 주소 (기본 `redis://127.0.0.1:6379/0`). Docker 배포에서는 compose가 정합니다 |
| `POSTGRES_PASSWORD` · `APP_DB_PASSWORD` | Docker 배포 전용: DB 관리자(`shrine`) · 앱 계정(`shrine_app`) 비밀번호 (`openssl rand -hex 24`) |
| `BASE_PATH` | 비워 두면 도메인 루트(`/`)에서 동작 |
| `DATA_DIR` | 올린 이미지 폴더 (기본 `./data`, Docker에서는 `/data`) |
| `CONTACT_EMAIL` | 화면 · 처리방침에 보여 줄 문의 주소 (운영에서는 필수) |
| `FREE_CHAT` | `off`면 직접 채팅을 끄고 정해진 말만 |
| `GITHUB_CHECK` | `off`면 등록소의 GitHub 공개 저장소 확인을 끔 |
| `CANDLE_COOLDOWN_MS` | 같은 사당 초 켜기 간격 (기본 30분) |
| `ADMIN_PASSWORD` · `ADMIN_IPS` | 운영자 화면(`/admin`) 비밀번호(16자 이상)와 허용 IP · 대역(예: `192.168.123.0/24`). 비밀번호를 비워 두면 운영자 화면이 꺼집니다 |
| `NOTIFY_WEBHOOK_URL` | (선택) 새 접수 · 신고 · 장애를 알릴 웹훅 주소 (https) |
| `BOARD_OPEN` | `on`이면 AI 트렌드 게시판 글쓰기를 엽니다 (기본 off, 준비 중) |
| `WS_MAX_PER_IP` | IP당 동시 실시간 연결 수 (기본 4, IPv6는 /64를 한 IP로 셈) |
| `RETENTION_DAYS` · `PENDING_DAYS` | 반려 · 내린 접수를 파기하기까지 날 수(기본 30), 검토 대기를 자동 반려하기까지 날 수(기본 90) |
| `BACKUP_KEEP` · `BACKUP_MAX_DAYS` | 백업을 남길 개수(기본 14)와 최대 보관 날 수(기본 14) |
| `BACKUP_SIGNING_KEY` | (선택) 백업 서명 키 (32자 이상). `.env`가 아니라 백업 cron 스크립트의 셸 환경에 둡니다 ([deploy/README.md](deploy/README.md) 7장) |
| `GITHUB_TOKEN` | (선택) GitHub 저장소 확인에 쓸 토큰 (요청 한도를 늘림) |

- 등록소 이미지는 한 장에 5MB(5MiB)까지 받습니다 (PNG · JPEG · WebP, 메타데이터는 지우고 저장).
- 설정값이 틀리면 서버가 문제를 한국어로 모아 보여 주고 시작하지 않습니다. 운영(`NODE_ENV=production`)에서는 예시 값 · 짧은 비밀값 · 시험용 Turnstile 키 · 약한 DB 비밀번호도 거부합니다.

## 배포 (Docker Compose, 독립 도메인)

1. Docker가 설치된 서버를 준비하고, 도메인의 DNS A 레코드를 서버 IP로 겁니다.
2. Cloudflare Turnstile에서 그 도메인용 키를 발급합니다.
3. `.env`를 채웁니다 (`BASE_PATH`는 비워 둡니다. 인증서용 `ACME_EMAIL`, DB 비밀번호 `POSTGRES_PASSWORD` · `APP_DB_PASSWORD`도 넣습니다).
4. 띄웁니다:
   ```bash
   cd deploy
   mkdir -p backups && sudo chown 1000:1000 backups
   docker compose --env-file ../.env up -d --build
   ```
   Caddy가 HTTPS 인증서를 자동으로 받고, 앱(`api`)은 Caddy 뒤에서만 받습니다. PostgreSQL · Redis는 밖으로 열지 않습니다.

- 데이터는 `pg-data`(DB)와 `api-data`(올린 이미지) 볼륨에 있습니다. Redis는 디스크에 쓰지 않습니다 (요청 제한 · 잠금 같은 짧은 상태뿐).
- 채널 정보가 프로세스 메모리에 있어서 앱은 한 개(워커 1개)만 띄웁니다.
- 업데이트 · 롤백 · 백업 · 복구 · 서버 옮기기 · 장애 대응 순서는 [deploy/README.md](deploy/README.md)에 있습니다.

## 운영 도구

Docker에서는 `deploy/` 폴더에서 `docker compose --env-file ../.env exec -T api python -m shrine.cli <명령>`으로,
로컬에서는 `app/` 폴더에서 `uv run python -m shrine.cli --env-file ../.env <명령>`으로 부릅니다.

```bash
python -m shrine.cli list                    # 사당 목록 (채널 · 자리)
python -m shrine.cli add <사당.json | ->        # 사당 직접 넣기 ("channel": 1~3, 빼면 1번 채널)
python -m shrine.cli upload <이미지 | ->        # 이미지 올리기 (사당 json에 넣을 up/<id> 이름이 나옴)
python -m shrine.cli projects [all]          # 등록소 접수 (검토할 것만, all이면 전부. 원하는 채널 · 자리도 보임)
python -m shrine.cli approve <번호> [자리|-] [채널]
                                             # 접수 승인 → 그 채널의 빈 자리(0~19)에 사당으로. 자리를 빼거나 -면 작성자가 고른 채널 · 자리,
                                             # 찼으면 그 채널의 첫 빈 자리. 링크 · 이미지 변경 승인도 같은 명령
python -m shrine.cli move <slug> <자리> [채널]   # 다른 빈 자리로 옮기기 (채널을 빼면 지금 채널 안에서)
python -m shrine.cli reject <번호> [사유]      # 접수 반려 (링크 · 이미지 변경만 되돌리기)
python -m shrine.cli posts                   # AI 트렌드 게시판 글 · 신고 수
python -m shrine.cli post-hide <번호> | post-show <번호> | post-del <번호>
python -m shrine.cli status <slug> check|live  # 점검중 전환 · 되돌리기
python -m shrine.cli remove <slug> [사유]
python -m shrine.cli erase <번호>             # 접수의 개인정보(이메일 · 비밀번호 해시 · 이미지) 바로 파기
python -m shrine.cli blocks                  # 이용 제한 목록
python -m shrine.cli block-ip <IP> <30m|12h|7d> [사유] | unblock <번호>
python -m shrine.cli schema                  # DB 구조 버전 (Alembic)
```

호스트의 파일은 표준 입력으로 넘깁니다: `docker compose --env-file ../.env exec -T api python -m shrine.cli add - < my-shrine.json` (`-T`가 꼭 필요).

## 백업

- 백업 하나는 tar 하나입니다: `db.dump`(`pg_dump -Fc`) + `uploads/` + `manifest.json`(표별 행 수 · 파일별 SHA-256), 서명을 켜면 `manifest.sig`.
- Docker에서는 호스트 cron이 postgres 컨테이너의 `pg_dump`를 `backup` 컨테이너(`python -m shrine.backup`)로 넘깁니다.
  ```bash
  cd deploy && C="docker compose --env-file ../.env"
  $C exec -T postgres pg_dump -U shrine -d shrine --format=custom | $C run --rm --no-deps -T backup create --dump -
  $C run --rm --no-deps backup list | verify /backups/<파일> | prune
  ```
- 개인정보 처리방침에 맞춰 14일(최근 14개 · 만든 지 13일)을 넘는 백업은 만들 때마다 지웁니다.
- 로컬: `app/`에서 `uv run python -m shrine.backup --env-file ../.env create | list | verify <파일> | restore <파일>`.
- 매일 자동 백업 · 서버 밖 사본 · 복구 순서는 [deploy/README.md](deploy/README.md) 7~8장에 있습니다.

## 구조

| 파일 | 하는 일 |
|---|---|
| `app/shrine/__main__.py` · `main.py` | 서버 시작 (`python -m shrine`): FastAPI + uvicorn, HTTP와 WebSocket을 프로세스 하나에서 |
| `app/shrine/config.py` | 환경 변수 읽기 · 검사 (틀리면 한국어로 모아 보여 주고 멈춤) |
| `app/shrine/web/` | 화면 · 공개 API · 등록소 API · 업로드 · 운영자 화면 라우트 · 보안 헤더 · `/healthz` |
| `app/shrine/realtime/` | 채널, 위치 검사, 말풍선 · 동작, 초 켜기, 게시판 글쓰기 (WebSocket) |
| `app/shrine/npc.py` | 채널을 채우는 NPC 방문객 |
| `app/shrine/registry.py` · `uploads.py` · `storage.py` | 프로젝트 등록소 · 이미지 올리기 · 업로드 폴더 |
| `app/shrine/shrines.py` · `ops.py` · `posts.py` | 사당 데이터 · 운영 작업 · 게시판 글 |
| `app/shrine/logic/` | DB 없는 규칙: 맵(`world.py`), 채팅 거르기, 링크 규칙, 서명 · 해시, JS와 같은 숫자 · 문자열 · URL 동작 |
| `app/shrine/moderation.py` | 강퇴 · 이용 제한 · 접속자 신고 |
| `app/shrine/admin_api.py` · `admin_auth.py` · `public/admin/` | 운영자 화면 |
| `app/shrine/retention.py` · `backup.py` | 보관 기간이 지난 정보 파기 · 백업 |
| `app/shrine/cli.py` · `cli_ops.py` · `cli_registry.py` | 운영 도구 |
| `app/shrine/db/` · `app/alembic/` | PostgreSQL 연결 · 표 정의 · 마이그레이션 |
| `app/shrine/redis.py` | Redis: 요청 제한 · 잠금 · 신고 같은 짧은 상태 |
| `app/tests/` | `pytest` 시험 (Node와 맞춰 보던 값은 `tests/data/golden/`) |
| `tests/conformance/` | 블랙박스 적합성 시험 (Node 서버에서 모두 통과한 묶음을 지금 서버에) |
| `deploy/` | Docker Compose · Caddy · DB 첫 실행 스크립트 · 운영 안내 |
| `public/js/main.js` | 화면: 입장, 걷기, 실시간, 창, 연출 |
| `public/js/avatar*.js` | 캐릭터 도트 (부위별 그림 + 합성) |
| `public/js/lens.js` | 네비게이터 설명 카드 |

- 캐릭터 꾸미기 부위의 순서와 개수는 `app/shrine/logic/world.py`의 `LOOK_SIZES`와 같아야 합니다.
- 서버는 원래 Node 24(TypeScript) · SQLite였고 Python으로 옮겼습니다. `app/` 코드 주석의 `server/*.ts:줄` 같은 표시는
  그 Node 판 원본 자리입니다 (git 기록의 커밋 `a2b1bf6`까지 `server/`에 있음).

## 시험

```bash
cd app && uv run pytest                     # 단위 · DB 시험 (PostgreSQL · Redis가 없으면 그 시험만 건너뜀)
npm ci && npm run test:conformance          # 적합성 시험 (= node tests/conformance/run.mjs, Node 24 · 개발용 PostgreSQL · Redis 필요)
for f in public/js/*.js public/admin/*.js; do node --check "$f"; done   # 화면 코드 문법 검사
```

- `pytest`는 기본으로 개발용 컨테이너(`127.0.0.1:55432` · `127.0.0.1:56379`)를 찾습니다. 다른 곳이면 `SHRINE_TEST_PG` · `SHRINE_TEST_REDIS_BASE`(적합성 시험은 `SHRINE_TEST_REDIS`)로 정합니다.
- 적합성 시험은 3340~3359 포트에 서버를 띄웁니다. 자세한 것은 [tests/conformance/README.md](tests/conformance/README.md).

## 봇 차단 · 개인정보

- 입장할 때 Turnstile 사람 확인을 거쳐 서명된 입장 표(HttpOnly 쿠키)를 받습니다. WebSocket은 입장 표가 있어야 열리고, IP당 연결 수 · 메시지 수 · 요청 수를 제한합니다.
- 직접 쓴 채팅은 저장하지 않습니다. IP는 그날만 쓰는 무작위 값과 섞은 해시로만 다룹니다. 이용 제한을 받은 경우에만 제한 기간 동안 되돌릴 수 없는 값으로 저장합니다.
- 등록소에 적은 이메일은 운영자 연락용으로 서버에만 두고, 작성자가 공개를 고른 경우에만 사당 창에 보입니다.

## 기여하기

버그 신고 · 제안 · PR 모두 환영합니다. [CONTRIBUTING.md](CONTRIBUTING.md)를 먼저 읽어 주세요.
보안 문제는 공개 이슈 대신 [SECURITY.md](SECURITY.md)의 방법으로 알려 주세요.

## 라이선스

[PolyForm Noncommercial License 1.0.0](LICENSE) — 코드를 보고, 고치고, 비상업적으로 쓰는 것은 자유롭습니다.
**상업적 이용(이 코드로 수익을 내는 서비스 운영 등)은 별도 허가가 필요합니다.** 문의는 GitHub 이슈로 남겨 주세요.
