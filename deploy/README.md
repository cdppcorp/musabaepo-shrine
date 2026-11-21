# 운영 안내 (deploy)

무사배포 기원소를 Docker로 한 서버에 띄우고 운영하는 절차입니다.
첫 배포, 업데이트, 롤백, 백업과 복구, 서버 옮기기, 응급 조치를 다룹니다.

> 서버는 Python(`app/`: FastAPI + PostgreSQL + Redis)입니다.

- 명령은 모두 저장소의 `deploy/` 폴더에서, 아래 별칭을 건 셸에서 실행한다고 가정합니다.
  ```bash
  cd /srv/musabaepo-shrine/deploy
  C="docker compose --env-file ../.env"
  ```
  `--env-file ../.env`는 compose 파일 안의 `${POSTGRES_PASSWORD}` · `${APP_DB_PASSWORD}` · Caddy의 `${SHRINE_DOMAIN}` 같은 값을 채웁니다.
  빼면 `POSTGRES_PASSWORD를 넣고 --env-file ../.env로 실행하세요`처럼 멈춥니다.
- `<도메인>`은 `.env`의 `SHRINE_DOMAIN`입니다.
- 서버에 이미 nginx 같은 프록시가 80/443을 쓰고 있으면 13장 '다른 프록시 뒤에 둘 때'를 따릅니다. 그때는 Caddy가 172.17.0.1:8111에서 평문 HTTP만 받고, https · 인증서는 앞단이 맡습니다.

## 1. 구성

| 이름 | 하는 일 | 바깥에 여는 포트 |
|---|---|---|
| `api` (별칭 `shrine`) | 앱 (FastAPI + uvicorn 워커 1개, HTTP + WebSocket) | 없음. Caddy만 3300으로 붙습니다 |
| `postgres` | DB (PostgreSQL 17) | 없음 |
| `redis` | 요청 제한 · 잠금 · 신고 · 로그아웃한 운영자 세션 같은 짧은 상태. 디스크에 쓰지 않음 | 없음 |
| `caddy` | HTTPS 인증서 자동 발급, 프록시, 보안 헤더, 접속 기록. 환경 변수는 `SHRINE_DOMAIN` · `ACME_EMAIL`만 받음 | 80/tcp, 443/tcp, 443/udp(HTTP/3) |
| `backup` | 백업 만들기 · 정리 · 검사. 늘 떠 있지 않고 `run --rm`으로만 (profile `tools`, 네트워크 없음) | 없음 |

| 저장 위치 | 내용 |
|---|---|
| 볼륨 `pg-data` | DB 전부 (사당 · 접수 · 초 · 글 · 차단 · 운영 기록) |
| 볼륨 `api-data` (`/data`) | `uploads/`(등록소 이미지) |
| 호스트 `deploy/backups/` (`/backups`) | 백업 tar 파일 (주인 uid 1000). `api`는 읽기만, 쓰기는 `backup`만 |
| 볼륨 `caddy-data` | TLS 인증서, ACME 계정 |
| 볼륨 `caddy-logs` | 접속 기록 (IP 일부 가림, 30일 안에 지움) |
| 볼륨 `caddy-config` | Caddy가 저장하는 설정 사본 |

- Compose 프로젝트 이름은 `deploy`로 고정해 두었습니다 (`docker-compose.yml`의 `name:`). 볼륨의 실제 이름은 `deploy_pg-data`처럼 됩니다. `docker volume ls`로 확인합니다.
- 채널 · 접속자 · 그날 IP 소금이 프로세스 메모리에 있어서 앱은 하나(워커 1개)만 띄웁니다.
- Redis는 다시 만들면 비어 있습니다. 모든 키에 만료가 있고, 오래 남아야 하는 것(PIN 잠금, 차단 등)은 모두 PostgreSQL에 있습니다.
  메모리(64MB)가 차면 키를 버리지 않고 새 쓰기를 거절합니다 (`noeviction`). 로그인 · PIN 잠금 같은 보안 키가 밀려나 풀리지 않게.

**DB 계정**

- `shrine_app`: 앱(`api`)이 붙는 계정. 슈퍼유저 · 역할 만들기 · DB 만들기 권한이 없고, DB `shrine`의 주인이라 표를 만들고(Alembic) 씁니다. 비밀번호는 `.env`의 `APP_DB_PASSWORD`.
- `shrine`: 관리자(슈퍼유저). postgres 컨테이너 안 소켓으로만 받습니다 (`$C exec -T postgres pg_dump -U shrine …`). 네트워크로는 거절하므로, 앱 컨테이너가 `.env`의 `POSTGRES_PASSWORD`를 알아도 슈퍼유저로 붙지 못합니다.
- 볼륨이 빈 첫 실행에서 `deploy/postgres-init/10-app-role.sh`가 만듭니다. 이 스크립트는 리눅스 컨테이너가 그대로 실행하므로 줄 끝이 LF여야 합니다 (저장소의 `.gitattributes`가 지킴).
- 이 스크립트가 생기기 전에 만든 `pg-data` 볼륨에는 첫 실행 스크립트가 돌지 않습니다. 시험용이면 `$C down -v`로 지우고 다시 띄우는 것이 가장 간단하고, 데이터를 남기려면 한 번 손으로 옮깁니다.
  ```bash
  $C up -d postgres                                                   # 새 설정(APP_DB_PASSWORD · postgres-init)으로 다시 만듦
  $C exec -T postgres sh /docker-entrypoint-initdb.d/10-app-role.sh     # shrine_app · DB 주인 · 슈퍼유저 TCP 거절
  $C exec -T postgres psql -U shrine -d shrine -v ON_ERROR_STOP=1 \
    -c "DO \$\$DECLARE r record; BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP EXECUTE format('ALTER TABLE public.%I OWNER TO shrine_app', r.tablename); END LOOP; END\$\$" \
    -c 'SELECT pg_reload_conf()'
  $C up -d                                                            # api가 shrine_app으로 다시 붙음
  ```

## 2. 서버 준비

1. Docker Engine과 Compose v2를 설치합니다.
2. 방화벽은 22(관리자 IP만), 80/tcp, 443/tcp, 443/udp만 엽니다. 3300 · 5432 · 6379는 열지 않습니다. (다른 프록시 뒤에 둘 때는 13장)
3. DNS에 `<도메인>`의 A 레코드를 서버 IP로 겁니다.
   - AAAA(IPv6)는 서버가 IPv6로 실제 받는 것을 확인한 뒤에만 겁니다.
   - Cloudflare를 쓴다면 **DNS only(회색 구름)** 로 둡니다. 주황 구름(프록시)이면 모든 방문자가 Cloudflare IP로 보여 IP 제한에 같이 걸립니다. 꼭 켜야 하면 `Caddyfile`의 `trusted_proxies`를 Cloudflare 대역으로 바꿉니다 (11장).
4. Cloudflare Turnstile 키를 `<도메인>`용으로 발급합니다.
5. 코드를 받아 릴리스 태그로 맞춥니다.
   ```bash
   git clone <저장소 주소> /srv/musabaepo-shrine
   cd /srv/musabaepo-shrine && git checkout <태그>
   ```
6. `.env`를 만들고 다른 사용자가 못 읽게 합니다. `.env.example`에서 '운영 필수' · '배포 필수'로 표시된 값을 모두 채웁니다.
   ```bash
   cp .env.example .env && chmod 600 .env
   ```
   - `NODE_ENV=production` (변수 이름은 Node 서버 때 그대로)
   - `SHRINE_DOMAIN`, `PUBLIC_ORIGIN`
   - `ACME_EMAIL`: 비어 있으면 Caddy가 시작하지 않습니다
   - `TICKET_SECRET` (`openssl rand -hex 32`)
   - `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`
   - `CONTACT_EMAIL`
   - `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`: 둘 다 `openssl rand -hex 24` (DB 주소에 그대로 들어가므로 `@ : /` 금지)
   - `DATABASE_URL` · `REDIS_URL`은 적지 않습니다. compose가 `postgres` · `redis` 서비스로 정합니다.
7. 백업 폴더를 만들고 컨테이너 사용자(uid 1000)에게 넘깁니다. 이걸 빼먹으면 Docker가 root 소유로 만들어 백업이 실패합니다.
   ```bash
   cd deploy
   mkdir -p backups && sudo chown 1000:1000 backups && sudo chmod 700 backups
   ```

## 3. 첫 배포

```bash
cd /srv/musabaepo-shrine/deploy
C="docker compose --env-file ../.env"
$C up -d --build
$C ps          # postgres · redis가 (healthy) → api가 (healthy) → caddy가 뜹니다
$C logs -f     # DB 구조 올리기 · 인증서 발급 확인 (Ctrl+C로 나옴)
```

확인:

```bash
curl -I https://<도메인>/          # 200, strict-transport-security, content-security-policy가 보여야 함
curl https://<도메인>/healthz      # 200
```

- DB 구조(Alembic)는 앱이 시작할 때 저절로 올립니다. 빈 DB면 처음부터 만듭니다.
- 처음에는 사당이 없습니다. 운영자 화면이나 운영 도구로 넣습니다 (4장).

마지막으로 두 가지를 해 둡니다.

- 첫 백업을 만들고 매일 돌도록 cron을 겁니다 (7장).
- 바깥 가동 감시(UptimeRobot 같은 무료 서비스)로 `https://<도메인>/healthz`를 5분마다 확인합니다.
  - 서버가 죽으면 알 수 있습니다.
  - 접속 기록은 요청이 들어와야 날짜가 넘어가는데, 이 요청이 그 일을 꾸준히 해 줍니다 (10장).

## 4. 운영자가 사당을 넣는 곳

**관리자 페이지 `https://<도메인>/admin`**

- `.env`에 `ADMIN_PASSWORD`(16자 이상)를 넣고 `$C up -d`를 하면 켜집니다. 비어 있으면 `/admin`은 404입니다.
- `ADMIN_IPS`로 들어올 수 있는 IP를 정해 두길 권합니다. 사무실 내부망 전체처럼 대역(`192.168.123.0/24`)으로도 적을 수 있습니다. Caddy에서 한 겹 더 막을 수도 있습니다 (11장).
  - 운영에서 `ADMIN_PASSWORD`가 있는데 `ADMIN_IPS`가 비어 있으면 시작할 때 `[shrine] 설정 경고: ADMIN_IPS가 비어 있습니다 …`가 나옵니다 (시작은 함).
  - 로그인 잠금은 IP당 15분 5번, 서버 전체 15분 50번입니다. `ADMIN_IPS`가 있으면 전체 잠금은 쓰지 않습니다 (로그인까지 오는 요청이 `ADMIN_IPS`뿐이라, 남이 전체 잠금을 걸어 운영자를 막을 수 없게).
- 로그아웃한 세션 목록은 Redis에 세션이 끝나는 시각까지 둡니다. 앱만 다시 띄워도 로그아웃한 쿠키는 계속 막힙니다. 비밀번호를 바꾸고 다시 띄우면 예전 세션은 모두 끊깁니다.
- 할 수 있는 일
  - 등록소 접수 승인 · 반려
  - 사당 추가 · 수정 (이미지 포함)
  - 게시판 신고 처리, 차단, 직접 채팅 켜고 끄기
- 모든 작업은 `admin_log`에 남습니다 (관리자 IP는 해시로).

**운영 도구 (CLI)**

```bash
$C exec -T api python -m shrine.cli list
$C exec -T api python -m shrine.cli projects
$C exec -T api python -m shrine.cli approve <접수번호> [자리|-] [채널]
$C exec -T api python -m shrine.cli status <slug> check
$C exec -T api python -m shrine.cli block-ip <IP> 12h [사유]
$C exec -T api python -m shrine.cli blocks
$C exec -T api python -m shrine.cli upload - < shot.png        # 호스트의 파일은 표준 입력으로. -T가 꼭 있어야 합니다
$C exec -T api python -m shrine.cli add - < my-shrine.json
$C exec -T api python -m shrine.cli schema                     # DB 구조 버전 (Alembic)
```

- 명령 목록은 저장소 루트 README의 '운영 도구'에 있습니다.
- 서버가 떠 있는 동안 바꾼 사당은 30초 안에 맵에 반영됩니다. 차단 · 풀기는 10초 안에 반영되고 걸린 접속자는 그때 끊깁니다.
- DB를 열 때 서버처럼 Alembic을 올립니다. 이 도구가 모르는 더 새 구조면 `더 새 서버가 만든 DB`로 멈춥니다.
- 로컬 개발에서는 `app/` 폴더에서 `uv run python -m shrine.cli --env-file ../.env list`처럼 씁니다
  (`--env-file`: 이미 있는 환경 변수가 이기고, 파일이 없으면 건너뜀).

## 5. 업데이트

> GitHub Actions 자동 배포를 켜 두었다면 `main`에 머지하는 것으로 아래 순서가 저절로 돕니다 (14장). 아래는 손으로 할 때입니다.

```bash
cd /srv/musabaepo-shrine/deploy
C="docker compose --env-file ../.env"
# 1) 업데이트 전 백업 (7장 '매일 자동으로'의 스크립트를 그대로 한 번 돌려도 됩니다)
/usr/local/bin/shrine-backup
# 2) 지금 돌고 있는 이미지에 이름을 붙여 남김 (롤백용)
docker tag musabaepo-shrine-api:latest musabaepo-shrine-api:prev-$(date +%Y%m%d-%H%M)
# 3) 새 코드
git fetch --tags && git checkout <새 태그>
# 4) 새 이미지를 만들고 바꿔 끼움
$C build api
$C up -d
# 5) 확인
$C ps && curl https://<도메인>/healthz
```

- 앱이 다시 뜨는 몇 초 동안 Caddy가 요청을 5초까지 붙잡아 둡니다. 그보다 길어지면 '잠시 정비 중' 화면을 보여 주고 10초 뒤 저절로 새로 고칩니다. 접속자 화면은 끊기면 알아서 다시 붙습니다.
- 앱 프로세스 메모리에만 있던 것은 초기화됩니다: 채널, 말풍선, 접속자, 업로드 소유 기록. Redis에 있는 요청 제한 · 잠금 · 신고는 `redis` 컨테이너를 다시 만들기 전까지 남습니다.
- DB 구조 변경(Alembic)은 앱이 시작할 때 저절로 돕니다. 바꾸기 전 사본은 따로 뜨지 않으므로 1)의 백업이 그 역할을 합니다.
- `.env`만 바꿨다면 `$C up -d`로 충분합니다. 바뀐 서비스만 다시 만듭니다.
- `Caddyfile`만 바꿨다면 `$C up -d --force-recreate caddy`를 씁니다. 파일 하나를 연결해 둔 것이라 재시작만으로는 편집기가 새로 쓴 파일을 못 볼 수 있습니다.
- `postgres:17-alpine` · `redis:7-alpine` · `caddy:2.11` 이미지의 보안 업데이트는 `$C pull postgres redis caddy && $C up -d`로 받습니다 (PostgreSQL 큰 버전(17 → 18)은 덤프 · 복구가 필요하므로 이 명령으로 바꾸지 않습니다).
- 지난 이미지는 2~3개만 남기고 지웁니다.
  ```bash
  docker image ls musabaepo-shrine-api
  docker image rm musabaepo-shrine-api:prev-<옛 시각>
  ```

## 6. 롤백

```bash
cd /srv/musabaepo-shrine/deploy
C="docker compose --env-file ../.env"
docker image ls musabaepo-shrine-api                                       # prev-… 태그 확인
docker tag musabaepo-shrine-api:prev-<시각> musabaepo-shrine-api:latest     # 이전 이미지를 다시 latest로
$C up -d --no-build
git checkout <이전 태그>     # 코드도 맞춰 둡니다 (다음 build가 문제 버전을 다시 만들지 않게)
```

- 그 업데이트에 DB 구조 변경이 없었다면 이것으로 끝입니다.
- 구조 변경이 있었다면 이전 버전은 `더 새 서버가 만든 DB`로 시작하지 않습니다. 그때는 업데이트 직전 백업으로 복구합니다 (8장). 그 사이에 쌓인 초 · 접수 · 글은 사라집니다.

## 7. 백업

**무엇을 남기나**

- 백업 하나는 tar 파일 하나입니다.
  - `db.dump`: `pg_dump --format=custom`(-Fc). 서버가 도는 중에도 한 시점의 사본입니다 (pg_dump는 트랜잭션 하나로 뜸).
  - `uploads/`: 등록소 이미지. DB 덤프를 다 받은 뒤에 넣으므로, 덤프가 가리키는 이미지는 모두 들어갑니다.
  - `manifest.json`: 표별 행 수(덤프 안의 데이터를 풀어 센 수) · 이미지 수 · 파일별 SHA-256 · pg_dump 버전.
  - (서명을 켜면) `manifest.sig`
- 파일은 `deploy/backups/shrine-YYYYMMDD-HHMMSSZ.tar`(시각은 UTC)에 생기고, 권한은 600입니다.
- 앱 컨테이너에는 `pg_dump`가 없습니다. **호스트 cron이 postgres 컨테이너의 pg_dump를 `backup` 컨테이너(앱과 같은 이미지)의 백업 도구로 파이프로 넘깁니다.**
- `api`는 백업 폴더를 읽기만 합니다. 앱이 뚫려도 백업을 지우거나 가짜 백업을 넣어 두지 못하게, 만들기 · 정리는
  한 번 띄우고 지우는 `backup` 컨테이너(네트워크 없음, `.env` 비밀 값 없음, 이미지 폴더는 읽기만)가 합니다.
- 넣지 않는 것
  - `.env`: 비밀값이라 서버 밖 안전한 곳(비밀번호 관리자 등)에 따로 둡니다
  - `caddy-data`(인증서): 서버를 옮길 때만 따로 옮깁니다 (9장)
  - 접속 기록, Redis(짧은 상태뿐)

**얼마나 두나 (개인정보 처리방침: 14일)**

- 백업을 만들 때마다 아래 둘 중 먼저 걸리는 쪽으로 지웁니다.
  - 최근 `BACKUP_KEEP`개(기본 14)를 넘는 것
  - 만든 지 `BACKUP_MAX_DAYS - 1`일(기본 13일)이 지난 것
- 매일 같은 시각에 돌리면 어떤 백업도 14일을 넘겨 남지 않습니다.
- 백업이 실패해도 기한이 지난 것은 먼저 지웁니다.
- 복구 때 뜬 `backups/pre-restore-*.dump`(DB 전체 사본)도 같은 기한으로 지웁니다.
- 숫자를 늘리려면 처리방침도 같이 고쳐야 합니다.
- DB에서 이미 파기한 개인정보도, 그 전에 만든 백업에는 남아 있습니다. 백업이 지워질 때(최대 14일) 같이 사라집니다.

**명령**

```bash
$C exec -T postgres pg_dump -U shrine -d shrine --format=custom | $C run --rm --no-deps -T backup create --dump -   # 만들기
$C run --rm --no-deps backup list                          # 목록
$C run --rm --no-deps backup verify /backups/<파일>         # 검사
$C run --rm --no-deps backup prune                         # 정리만
```

- `verify`가 확인하는 것
  - tar 모양 (끊김 · 머리 검사값)
  - `db.dump`를 끝까지 읽어 압축이 풀리는지, 표별 행 수가 만들 때와 같은지 (pg_restore 없이)
  - 이미지 수 · 용량, 모든 파일의 SHA-256 (내용 손상)
  - (서명을 켰으면) `manifest.sig`
- 덤프가 비었거나 중간에 끊겼으면(pg_dump 실패) 백업 도구가 `[backup] …`을 쓰고 1로 끝나며 아무것도 남기지 않습니다.
- 로컬 개발: `app/`에서 `uv run python -m shrine.backup --env-file ../.env create`. `pg_dump`가 PATH에 있으면 `DATABASE_URL`로 직접 뜨고,
  없으면 `PG_DUMP`(명령 통째로, 예: `PG_DUMP="docker exec -i <pg 컨테이너> pg_dump -U shrine -d shrine -Fc"`)나 `--dump`를 씁니다.

**서명 (선택)**

- manifest의 SHA-256은 백업 안에서만 맞춰 보는 값입니다. 서명을 켜면 운영자 키 없이는 맞는 백업을 만들 수 없습니다.
- `BACKUP_SIGNING_KEY`(32자 이상, `openssl rand -hex 32`)가 있으면 만들 때 `manifest.json`의 HMAC-SHA256을 `manifest.sig`로 넣고,
  `verify` · `restore`는 서명이 없거나 틀리면 멈춥니다. 키가 없으면 서명은 보지 않습니다 (SHA-256 검사만).
- 키는 `.env`에 넣지 않습니다 (`api`가 `.env`를 통째로 받음). 운영자만 읽는 파일에 둡니다:
  `sudo install -d -m 700 /etc/musabaepo-shrine && openssl rand -hex 32 | sudo tee /etc/musabaepo-shrine/backup.key >/dev/null && sudo chmod 600 /etc/musabaepo-shrine/backup.key`
- 셸에 `export BACKUP_SIGNING_KEY="$(sudo cat /etc/musabaepo-shrine/backup.key)"`를 한 뒤 `backup` 명령은 그대로(compose가 넘김),
  `api`로 하는 복구 명령은 `-e BACKUP_SIGNING_KEY`를 붙여 씁니다 (8장). 키를 서버 밖에도 따로 보관해 둡니다.

**매일 자동으로 + 서버 밖 사본**

`/usr/local/bin/shrine-backup` (실행 권한 `chmod 700`):

```sh
#!/bin/sh
# 매일 백업하고 서버 밖으로 복제합니다
set -eu
cd /srv/musabaepo-shrine/deploy
C="docker compose --env-file ../.env"
# (선택) 백업 서명 키: .env가 아니라 운영자만 읽는 파일에서 (7장 '서명')
if [ -r /etc/musabaepo-shrine/backup.key ]; then BACKUP_SIGNING_KEY="$(cat /etc/musabaepo-shrine/backup.key)"; export BACKUP_SIGNING_KEY; fi
# postgres 컨테이너의 pg_dump(-Fc) → backup 컨테이너의 백업 도구(표준 입력). 덤프가 비거나 끊기면 백업 도구가 1로 끝나 set -e로 멈춥니다
$C exec -T postgres pg_dump -U shrine -d shrine --format=custom | $C run --rm --no-deps -T backup create --dump -
# 서버 밖 사본: 둘 중 하나를 씁니다. sync / --delete라서 서버에서 지운 백업은 밖에서도 지워집니다 (14일 규칙을 같이 지킴)
rclone sync ./backups shrine-offsite:musabaepo-shrine --include 'shrine-*.tar'
# rsync -a --delete --include 'shrine-*.tar' --exclude '*' ./backups/ backup@other-host:/srv/shrine-backups/
```

`/etc/cron.d/musabaepo-shrine`:

```
30 4 * * * root /usr/local/bin/shrine-backup 2>&1 | logger -t shrine-backup
```

- 결과는 `journalctl -t shrine-backup`으로 봅니다.
- 실패를 놓치지 않으려면 끝에 `&& curl -fsS <healthchecks.io 같은 서비스의 ping 주소>`를 붙여, 하루 넘게 소식이 없을 때 알림을 받게 합니다.
- `pg_dump`는 postgres 컨테이너 안에서 유닉스 소켓으로 붙습니다 (컨테이너 안 접속은 비밀번호 없이 되는 이미지 기본값).

**서버 밖 사본의 보관 기간**

- 위처럼 `rclone sync`나 `rsync --delete`로 복제하면, 밖의 사본도 서버와 같은 파일만 남아 14일을 넘지 않습니다.
- 복사만 하는 방식(`rclone copy`, `rsync` without `--delete`)을 쓴다면 밖에서도 따로 지워야 합니다. 매일 돌립니다.
  ```bash
  rclone delete shrine-offsite:musabaepo-shrine --min-age 13d
  find /srv/shrine-backups -name 'shrine-*.tar' -mtime +12 -delete
  ```
- 밖의 저장소에 버전 관리 · 휴지통 · 객체 잠금이 켜져 있으면, 지운 사본이 거기 남습니다. 14일 안에 비워지도록 수명 규칙을 맞춥니다.
- 백업에는 이메일 같은 개인정보가 들어 있습니다.
  - rclone이라면 암호화 원격(`crypt`)을 씁니다.
  - rsync 대상은 접근이 제한된 서버로 둡니다.

**백업이 실패할 때**

| 메시지 | 할 일 |
|---|---|
| 백업 폴더에 쓸 수 없습니다 | `sudo chown 1000:1000 backups` |
| DB 덤프가 비어 있습니다 · db.dump가 중간에 끊겼습니다 | `$C ps`로 postgres가 healthy인지, `$C logs postgres`를 봅니다 (디스크가 차면 pg_dump도 실패) |
| POSTGRES_PASSWORD를 넣고 --env-file ../.env로 실행하세요 | 스크립트의 `C=`에 `--env-file ../.env`가 있는지, `.env`에 값이 있는지 확인합니다 |

## 8. 복구

복구는 **앱을 멈춘 상태에서** 합니다. 백업 도구는 앱(또는 운영 명령)이 DB에 붙어 있으면 되살리지 않고 멈춥니다
(`pg_stat_activity`의 연결 이름 `musabaepo-shrine`으로 봄). DB에 이 백업에 없는 표(더 새 서버가 만든 표)가 있어도 멈춥니다.

```bash
cd /srv/musabaepo-shrine/deploy
C="docker compose --env-file ../.env"
F=/backups/shrine-20261117-193000Z.tar      # 컨테이너 안 경로 (호스트의 deploy/backups/…)
# (서명을 쓰면) export BACKUP_SIGNING_KEY="$(sudo cat /etc/musabaepo-shrine/backup.key)"
# 0) 먼저 검사
$C run --rm --no-deps backup verify $F
# 1) 앱 멈춤 (그동안 Caddy가 '잠시 정비 중' 화면을 보여 줌)
$C stop api
# 2) 지금 DB 사본 (되살린 뒤 문제가 있으면 이걸로 되돌림. 13일 뒤 prune이 지움)
$C exec -T postgres pg_dump -U shrine -d shrine --format=custom > backups/pre-restore-$(date -u +%Y%m%d-%H%M%S)Z.dump
# 3) DB: 검사한 db.dump를 꺼내 postgres 컨테이너의 pg_restore로 (한 트랜잭션: 실패하면 DB는 그대로)
#    -U shrine_app: 되살린 표의 주인이 앱 계정이 되게 (슈퍼유저로 되살리면 앱이 표를 못 씀)
$C run --rm --no-deps -T -e BACKUP_SIGNING_KEY api python -m shrine.backup restore $F --db-to - \
  | $C exec -T postgres pg_restore -U shrine_app -d shrine --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error
# 4) 이미지: 지금 이미지는 /data/pre-restore-<시각>Z/로 옮겨 두고 바꿔 넣음
$C run --rm --no-deps -e BACKUP_SIGNING_KEY api python -m shrine.backup restore $F --uploads-only
# 5) 다시 시작하고 확인
$C up -d
$C ps && curl https://<도메인>/healthz
# 6) 확인이 끝나면 옮겨 둔 옛 이미지를 지웁니다 (개인정보가 들어 있으므로 늦어도 14일 안에)
$C run --rm --no-deps api sh -c 'rm -rf /data/pre-restore-*'
```

- 3)에서 pg_restore가 실패하면 DB는 바뀌지 않습니다 (`--single-transaction`). 그때는 4)로 넘어가지 말고 까닭을 봅니다.
- 2)의 사본으로 되돌리기: `$C exec -T postgres pg_restore -U shrine_app -d shrine --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error < backups/pre-restore-<시각>Z.dump`
- 서버 밖에서 가져온 백업이라면 `deploy/backups/`에 넣고 `sudo chown 1000:1000 <파일>`을 한 뒤 위 순서를 따릅니다.
- Docker 없이 (로컬 · 일반 서버, `pg_dump` · `pg_restore`가 있을 때): 서버를 멈춘 뒤
  `uv run python -m shrine.backup --env-file ../.env restore <파일>` 한 번이면 위 2)~4)를 차례로 합니다
  (지금 DB는 `DATA_DIR/pre-restore-<시각>Z/db.dump`, 이미지는 같은 폴더의 `uploads/`로 옮겨 둠).

**복구 연습** (분기에 한 번 권장, 운영 DB는 건드리지 않음)

```bash
$C run --rm --no-deps backup verify /backups/<파일>
$C exec -T postgres createdb -U shrine -O shrine_app shrine_drill
$C exec -T api sh -c 'tar -xOf /backups/<파일> db.dump' \
  | $C exec -T postgres pg_restore -U shrine_app -d shrine_drill --no-owner --no-privileges --single-transaction --exit-on-error
$C exec -T postgres psql -U shrine -d shrine_drill -c 'SELECT count(*) FROM shrines' -c 'SELECT count(*) FROM projects'
# 행 수가 verify의 '표:' 줄과 같은지 보고 지웁니다
$C exec -T postgres dropdb -U shrine shrine_drill
```

## 9. 서버 옮기기

1. 새 서버를 2장대로 준비합니다.
   - 같은 태그의 코드를 받고, `.env`를 복사해 `chmod 600`, `backups` 폴더를 만들어 `chown 1000:1000`합니다.
   - DNS TTL은 하루 전에 300초쯤으로 낮춰 둡니다.
2. 옛 서버에서 받는 것을 멈추고 마지막 백업과 인증서를 챙깁니다.
   ```bash
   cd /srv/musabaepo-shrine/deploy && C="docker compose --env-file ../.env"
   $C stop caddy        # 새 요청 막기
   /usr/local/bin/shrine-backup    # 또는 7장의 '만들기' 한 줄
   $C stop api
   docker run --rm -v deploy_caddy-data:/data -v "$PWD":/out alpine tar czf /out/caddy-data.tgz -C /data .
   ```
   - 인증서(`caddy-data`)도 옮기는 까닭: 새로 받으면 Let's Encrypt 발급 횟수 제한에 걸릴 수 있습니다.
   - 접속 기록(`caddy-logs`)은 옮기지 않습니다.
3. 마지막 백업 파일과 `caddy-data.tgz`를 새 서버의 `deploy/backups/`로 복사하고, `chown 1000:1000`합니다.
4. 새 서버에서 되살립니다.
   ```bash
   cd /srv/musabaepo-shrine/deploy && C="docker compose --env-file ../.env"
   $C build
   $C create                                  # 볼륨 · 컨테이너만 만들고 시작하지 않음
   docker run --rm -v deploy_caddy-data:/data -v "$PWD/backups":/in alpine tar xzf /in/caddy-data.tgz -C /data
   rm backups/caddy-data.tgz
   $C up -d postgres redis                    # DB만 먼저 (빈 DB, shrine_app이 만들어짐)
   ```
   그다음 8장의 3)~4)를 따릅니다 (앱은 아직 멈춰 있으므로 0)~2)는 건너뜀).
5. DNS A 레코드를 새 IP로 바꾸고 `$C up -d`, 3장의 확인을 합니다.
6. 새 서버가 잘 돌면 옛 서버의 데이터를 지웁니다. 옛 서버에도 개인정보가 남아 있기 때문입니다.
   ```bash
   $C down -v    # 볼륨까지 지움
   rm -rf backups ../.env
   ```

## 10. 무엇이 어디에 얼마나 남나

개인정보 처리방침과 맞춰야 하는 부분입니다. 앱 쪽 보관 규칙을 바꾸면 이 표와 처리방침을 함께 고칩니다.

| 기록 | 내용 | 위치 | 보관 |
|---|---|---|---|
| 서비스 DB | 사당 정보, 등록소 접수(이메일 · 관리 PIN 해시 · 링크 · 자동 닉네임), 게시판 글, 초 · 클릭 집계, 차단(차단한 사람의 IP 키 HMAC), 운영자 작업 기록(관리자 IP 해시) | `pg-data` | 앱 규칙: 게시판 7일, 반려 · 내린 접수는 30일 뒤 파기 등 (`app/shrine/retention.py`) |
| 등록소 이미지 | 올린 그림 파일 | `api-data`의 `uploads/` | 접수와 함께 |
| 백업 | 위 둘의 전체 사본 | `deploy/backups/` + 서버 밖 사본 | 14일 (7장) |
| 복구 때 옮겨 둔 옛 파일 | 복구 직전의 DB 사본 · 이미지 | `deploy/backups/pre-restore-*.dump`, `api-data`의 `pre-restore-*/` | DB 사본은 prune이 13일 뒤 지움, 이미지는 확인 뒤 바로 지움(늦어도 14일) |
| 짧은 상태 (Redis) | 요청 제한 횟수, 로그인 · PIN 시도 잠금, 사람 신고(24시간), 로그아웃한 운영자 세션 | `redis` 컨테이너 메모리 (디스크에 쓰지 않음) | 키마다 만료. 컨테이너를 다시 만들면 사라짐 |
| 접속 기록 (Caddy) | 시각, 가린 IP(IPv4는 앞 3자리 /24, IPv6는 앞 /32), 메서드, 주소, 상태 코드, 크기, 걸린 시간. 쿠키 · User-Agent 같은 헤더는 남기지 않음 | `caddy-logs` | 30일 안 |
| Caddy 자체 기록 | 시작, 인증서, 오류. 오류에 요청 정보가 붙으면 IP를 위와 같이 가리고 헤더는 지움 | Docker 로그 | 10MB × 5개. 넘치면 오래된 것부터 지움 |
| 앱 · DB 기록 | 시작 · 오류 메시지 (IP · 이메일은 쓰지 않음) | Docker 로그 | 10MB × 5개 |
| 메모리에만 | 채팅 말풍선, 요청 제한에 쓰는 그날만 유효한 IP 소금 | `api` 프로세스 | 앱이 다시 뜨면 사라짐 |
| 인증서 | TLS 인증서, ACME 계정(`ACME_EMAIL`) | `caddy-data` | 계속 |

**접속 기록이 30일을 넘지 않는 방식**

- Caddy가 24시간마다 새 파일로 넘깁니다. 넘긴 파일은 27일이 지나면 지웁니다.
- 하루치 묶음과 정리 지연을 더해도 30일 안에 끝납니다.
- 다만 파일을 넘기는 일은 24시간이 지난 뒤 들어온 **첫 요청 때** 일어납니다. 3장의 가동 감시가 5분마다 요청을 보내므로, 실제로는 매일 넘어갑니다.
- Docker 로그(json-file)는 크기로만 지워집니다. 그래서 IP가 남을 수 있는 접속 기록은 Docker 로그가 아니라 이 파일에 둡니다.

```bash
$C exec caddy tail -f /var/log/caddy/access.log      # 지금 기록
$C exec caddy ls -l /var/log/caddy                   # 넘긴 파일 (access-<시각>.log.gz)
```

## 11. 보안 설정

**보안 헤더**

- 화면마다 다른 헤더는 앱이 붙입니다.
  - CSP, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`
  - 공개 전에는 `X-Robots-Tag: noindex`
  - 운영자 화면은 더 좁은 CSP를 씁니다
- Caddy는 앱 설정과 상관없이 늘 있어야 하는 것을 응답 직전에 덮어씁니다.
  - `Strict-Transport-Security: max-age=31536000`
  - `X-Content-Type-Options: nosniff`
  - `Server`, `Via` 헤더 제거
  - '잠시 정비 중' 화면에도 같은 헤더를 붙입니다.
- HSTS는 1년 동안 브라우저가 이 도메인을 https로만 열게 합니다.
  - `includeSubDomains`와 `preload`는 일부러 넣지 않았습니다. 같은 도메인 아래 다른 서비스까지 묶이기 때문입니다.
- 확인:
  ```bash
  curl -sI https://<도메인>/ | grep -iE 'strict-transport|content-security|x-frame|x-content-type|referrer-policy|permissions-policy'
  ```

**요청 크기 상한**

| 경로 | Caddy | 앱 |
|---|---|---|
| `/api/upload` | 11MB | 5MiB (넘으면 413) |
| `/api/admin/upload` | 14MB | 약 7MB (JSON 안의 base64) |
| 나머지 | 16KB | 경로마다 더 작게 |

**운영자 화면 지키기**

- `ADMIN_PASSWORD`는 16자 이상 무작위로 씁니다.
- `ADMIN_IPS`로 들어올 수 있는 IP를 정합니다 (4장).
- 더 막고 싶으면 `Caddyfile`의 `@adminOutside` 주석을 풀어, 허용한 IP 밖에서는 Caddy가 먼저 404를 내게 합니다.

**Cloudflare 프록시를 켤 때**

`Caddyfile` 전역 `servers`의 `trusted_proxies` 줄을 Cloudflare 대역 목록 전체(https://www.cloudflare.com/ips/)로 바꾸고, `client_ip_headers CF-Connecting-IP` 주석을 풉니다.

- `reverse_proxy` 안의 `header_up X-Forwarded-For {client_ip}`는 늘 켜 둡니다. 앱이 받는 X-Forwarded-For가
  늘 값 하나(Caddy가 판단한 방문자 IP)라서, `trusted_proxies`를 켜도 방문자가 보낸 값이 앞에 남아 IP를 꾸미지 못합니다.
- `trusted_proxies`를 풀지 않으면 모든 방문자가 Cloudflare IP로 보여 IP 제한에 같이 걸립니다.

**www 주소**

- 기본은 꺼 두었습니다.
- `www.<도메인>` DNS를 서버로 건 뒤에만 `Caddyfile` 끝의 주석을 풉니다. DNS 없이 켜면 인증서 발급이 계속 실패합니다.

**컨테이너 강화**

| 항목 | api · backup | postgres | redis | caddy |
|---|---|---|---|---|
| 실행 사용자 | shrine (1000) | postgres (70) | redis (999) | root |
| 파일 시스템 | 루트 읽기 전용 (`/tmp`만 64MB 메모리) | 기본 (데이터는 `pg-data`) | 루트 읽기 전용 | 기본 |
| 권한 | 모두 뺌 (`cap_drop: ALL`) | 모두 뺌 | 모두 뺌 | 80 · 443을 여는 권한만 |
| 권한 상승 | 막음 (`no-new-privileges`) | 막음 | 막음 | 막음 |
| 메모리 · CPU · 프로세스 수 | 512MB · 1 · 200 (backup 100) | 512MB · 1 · 200 | 128MB · 0.5 · 100 | 256MB · 0.5 · 200 |
| 네트워크 | api: 기본, backup: 없음 | 기본 (밖으로 열지 않음) | 기본 (밖으로 열지 않음) | 80 · 443 |

- 로그는 모든 서비스가 10MB × 5개로 제한합니다.

## 12. 상태 확인 · 응급 조치

**헬스 체크**

- Docker가 15초마다 앱의 `/healthz`를 부릅니다 (`python -m shrine.healthcheck`). 3번 연속 실패하면 `$C ps`에 `(unhealthy)`로 보입니다.
- Docker는 unhealthy만으로는 다시 시작하지 않습니다. 프로세스가 죽으면 `restart: unless-stopped`로 다시 뜹니다.
- unhealthy가 이어지면 아래처럼 봅니다.
  ```bash
  $C logs --tail 200 api
  $C logs --tail 100 postgres redis
  $C restart api
  ```
- api는 postgres · redis가 healthy가 된 뒤에, Caddy는 api가 healthy가 된 뒤에 시작합니다.

**디스크**

- `df -h`와 `docker system df`로 봅니다.
- 디스크가 차면 PostgreSQL 쓰기와 pg_dump가 실패합니다. 지난 이미지(5장)와 오래된 백업부터 봅니다.

**상황별 대응**

| 상황 | 할 일 |
|---|---|
| 직접 채팅이 어지러움 | 운영자 화면에서 직접 채팅을 끄거나, `.env`에 `FREE_CHAT=off` 후 `$C up -d` |
| 비밀 키 유출이 의심됨 | `TICKET_SECRET`을 새로 만들고 `$C up -d`. 모든 입장 표, 운영자 세션, IP 차단이 풀립니다 |
| `ADMIN_PASSWORD` 유출 | 새 값으로 바꾸고 `$C up -d`. 예전 세션은 모두 끊깁니다 |
| DB 비밀번호 유출 | 아래 'DB 비밀번호 바꾸기' |
| 문제 있는 사당 | 운영자 화면, 또는 `$C exec -T api python -m shrine.cli status <slug> check`로 점검중 전환 |
| Cloudflare Turnstile 장애 | 사람 확인을 못 해서 새 입장이 막힙니다. 운영에서는 끄는 설정이 없으니 복구를 기다립니다 |
| 업데이트 뒤 앱이 계속 재시작 | `$C logs api`를 보고 6장대로 롤백 |
| 인증서 발급 실패 | `$C logs caddy`. DNS A 레코드, 80 · 443 방화벽, `ACME_EMAIL` 값을 확인. 다른 프록시 뒤라면 앞단 certbot · nginx 쪽입니다 (13장) |

**DB 비밀번호 바꾸기**

`POSTGRES_PASSWORD` · `APP_DB_PASSWORD`는 볼륨을 처음 만들 때만 DB에 들어갑니다. `.env`만 바꾸면 api가 붙지 못하므로 DB 쪽도 같이 바꿉니다.

```bash
NEW=$(openssl rand -hex 24)
$C exec -T postgres psql -U shrine -d shrine -v ON_ERROR_STOP=1 -c "ALTER ROLE shrine_app PASSWORD '$NEW'"
# .env의 APP_DB_PASSWORD를 $NEW로 바꾼 뒤
$C up -d
```

**공개하는 날**

`.env`에 `ALLOW_INDEXING=true`를 넣고 `$C up -d`를 합니다. 검색에 노출됩니다.

## 13. 다른 프록시 뒤에 둘 때 (예: 서버에 이미 nginx가 80/443을 쓰는 경우)

한 서버에 여러 사이트가 있고 앞단 nginx가 80/443과 인증서를 이미 맡고 있으면, 기원소의 Caddy를 그 뒤에 둡니다.

```
방문자 ─https─▶ 앞단 nginx (80/443 · 인증서) ─http─▶ 172.17.0.1:8111 ─▶ caddy ─▶ api (shrine:3300)
```

`docker-compose.behind-proxy.yml`을 덧씌우면 caddy만 바뀝니다.

- 80/443을 열지 않고 `172.17.0.1:8111`에서 평문 HTTP만 받습니다. 172.17.0.1은 Docker 기본 브리지(docker0)의 게이트웨이라 서버 안(호스트 · 컨테이너)에서만 닿습니다.
- 인증서를 받지 않습니다 (사이트 주소가 `http://:80`). `ACME_EMAIL`은 비워 둬도 됩니다.
- 방문자 IP는 앞단이 보낸 `X-Forwarded-For`에서 읽습니다. 믿는 앞단은 `SHRINE_TRUSTED_PROXIES`(기본 사설 대역)이고, 앱에는 늘 값 하나만 넘깁니다.
- 접속 기록(IP 일부 가림 · 30일), 요청 크기 상한, 보안 헤더(HSTS 포함), '잠시 정비 중' 화면은 단독 모드와 같습니다.
- api · postgres · redis · backup과 볼륨은 그대로입니다. 단독 모드와 오가도 데이터는 같습니다.
- 앞단 nginx 설정 예시는 `deploy/nginx-front.example.conf`입니다.

**.env**

- `SHRINE_DOMAIN=<도메인>`, `PUBLIC_ORIGIN=https://<도메인>`
  - `PUBLIC_ORIGIN`은 방문자가 주소창에서 여는 주소와 똑같아야 합니다. 앱이 WebSocket · 입장 요청의 출처(Origin)를 이 값과 비교해서, 다르면 실시간 연결이 403으로 막힙니다.
- `TRUST_PROXY=true` (기본 그대로). `ACME_EMAIL`은 비워 둬도 됩니다.
- `COMPOSE_FILE=docker-compose.yml:docker-compose.behind-proxy.yml`을 넣어 두길 권합니다.
  - 그러면 이 문서의 `C="docker compose --env-file ../.env"`(5장 업데이트, 6장 롤백, 7장 cron 스크립트 등)가 그대로 이 모드로 돕니다.
  - 넣지 않으면 아래 `C`를 모든 곳에 씁니다. `-f` 없이 `up`을 하면 caddy가 80/443을 잡으려다 실패하고 사이트가 멈춥니다 (앞단 nginx가 이미 씀). 그때는 아래 `C`로 다시 `up -d`를 합니다.
- 포트를 바꿀 때만 `SHRINE_PROXY_PORT`(기본 8111) · `SHRINE_PROXY_BIND`(기본 172.17.0.1). 바꾸면 nginx의 `proxy_pass`도 같이 바꿉니다.

**기원소 띄우기**

```bash
cd /srv/musabaepo-shrine/deploy
C="docker compose --env-file ../.env -f docker-compose.yml -f docker-compose.behind-proxy.yml"
$C up -d --build
$C ps                     # caddy의 PORTS가 172.17.0.1:8111->80/tcp 하나뿐
curl -sS -o /dev/null -w '%{http_code}\n' http://172.17.0.1:8111/healthz     # 서버 안에서: 200
```

나머지(2장의 `.env` · `backups` 폴더 준비, 4장 이후의 운영)는 단독 모드와 같습니다. 2장의 DNS · 방화벽 대신 아래를 봅니다.

**앞단 nginx에 붙이기**

`<앞단>`은 앞단 nginx 컨테이너 이름입니다 (예: `skillforge-nginx`).

1. 앞단 nginx가 읽는 설정 폴더 · certbot webroot · 인증서 폴더를 확인하고, 앞단에서 기원소가 닿는지 봅니다.
   ```bash
   docker inspect <앞단> --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'
   docker exec <앞단> wget -qO- http://172.17.0.1:8111/healthz     # {"ok":true,…}가 오면 됨
   ```
2. DNS에 `<도메인>`의 A 레코드를 서버 IP로 겁니다.
3. `deploy/nginx-front.example.conf`를 그 설정 폴더로 복사하고(예: `conf.d/shrine.conf`) `shrine.example.com`을 모두 `<도메인>`으로 바꿉니다.
   - webroot(`/var/www/certbot`) · 인증서 경로는 그 서버의 다른 사이트 설정과 같게 맞춥니다.
   - 인증서가 아직 없으니 처음에는 3)의 443 `server` 블록을 빼 둡니다. 없는 인증서 파일을 가리키면 `nginx -t`가 실패합니다.
   - `map $http_upgrade $connection_upgrade`가 앞단에 이미 있으면 파일의 1) 블록은 지웁니다.
4. 80 블록만으로 다시 읽습니다.
   ```bash
   docker exec <앞단> nginx -t && docker exec <앞단> nginx -s reload
   ```
5. 서버에 있는 certbot으로 webroot 방식 인증서를 받습니다. compose 폴더 · 서비스 이름 · webroot는 그 서버의 certbot 구성에 맞춥니다.
   ```bash
   cd <certbot이 있는 compose 폴더>      # 예: /var/www/clib-skills
   docker compose run --rm --entrypoint certbot certbot certonly --webroot -w /var/www/certbot \
     -d <도메인> --email <운영 메일> --agree-tos --no-eff-email
   ```
   - `--entrypoint certbot`: certbot 서비스에 갱신 반복(`certbot renew` 루프) 같은 entrypoint가 걸려 있어도 이 명령만 돌게.
   - 갱신은 그 서버의 certbot이 다른 인증서와 함께 합니다. 갱신 뒤 nginx를 다시 읽는 방식도 기존 그대로입니다.
6. 빼 두었던 443 블록을 다시 넣고 `nginx -t` → `nginx -s reload`.

앞단 설정에서 지킬 것 (예시 파일에 이유를 적어 두었습니다):

- `proxy_set_header X-Forwarded-For $remote_addr;` 로 **덮어씁니다**. `$proxy_add_x_forwarded_for`는 쓰지 않습니다. 방문자가 보낸 값 뒤에 덧붙이는 것이라 맨 앞 값을 방문자가 마음대로 정해 IP를 꾸미고, IP별 제한 · 차단 · `ADMIN_IPS`를 비켜 갈 수 있습니다. (Caddy도 `trusted_proxies_strict`로 오른쪽부터 읽어 막지만, 앞단에서 먼저 값을 하나로 만듭니다.)
- `access_log off;` 개인정보 처리방침의 접속 기록(IP 일부 가림 · 30일)은 기원소 안의 Caddy가 지킵니다. 앞단이 이 사이트의 원래 IP를 따로 쌓지 않게 합니다.
- `proxy_set_header Host $host;` · WebSocket 업그레이드 · `proxy_read_timeout 120s` (앱의 ping이 25초마다).
- `client_max_body_size 8m;` (운영자 화면 이미지가 JSON 안 base64로 약 7MB까지).
- 보안 헤더(HSTS 등)는 `add_header`로 더하지 않습니다. Caddy가 붙이므로 겹치면 두 번 나갑니다.

**방화벽**

- ufw에서 따로 열 것이 없습니다. 80/443은 앞단 nginx가 이미 쓰고, 8111은 열지 않습니다.
- Docker가 연 포트는 ufw를 거치지 않습니다. 그래서 `SHRINE_PROXY_BIND`를 `0.0.0.0`이나 공인 IP로 바꾸면 ufw 설정과 상관없이 바깥에서 Caddy로 바로 붙어 앞단을 건너뜁니다. 172.17.0.1은 서버 밖에서 닿지 않으므로 그대로 둡니다.

**확인**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://<도메인>/healthz            # 200
curl -sI https://<도메인>/ | grep -ciE '^strict-transport-security:'          # 1 (2면 앞단의 add_header를 지움)
curl -sI http://<도메인>/ | head -1                                           # 301 (https로)
```

- WebSocket: 브라우저로 `https://<도메인>`을 열고 입장합니다. 개발자 도구 → Network → `WS`에서 `/ws` 요청이 `101`이면 앞단을 통과한 것입니다. `403`이면 `PUBLIC_ORIGIN`이 주소창 주소와 같은지 봅니다.
- 방문자 IP: 내 PC에서 사이트를 몇 번 연 뒤 Caddy 접속 기록을 봅니다.
  ```bash
  $C exec caddy tail -n 5 /var/log/caddy/access.log | grep -o '"\(remote_ip\|client_ip\)":"[^"]*"'
  ```
  - `client_ip`가 내 공인 IP의 앞 3자리여야 합니다 (예: 내 IP가 203.0.113.57이면 `203.0.113.0`). `172.…`이면 앞단이 `X-Forwarded-For`를 넘기지 않거나 `SHRINE_TRUSTED_PROXIES`에 앞단 주소가 없는 것입니다 (모든 방문자가 한 IP로 보여 IP 제한에 같이 걸림).
  - `remote_ip`는 앞단에서 붙은 주소(`172.….0`)입니다.
- `ADMIN_IPS`에 내 IP를 넣어 두었다면, 내 PC에서는 `/admin`이 열리고 다른 곳(휴대폰 데이터 등)에서는 404여야 합니다. 앱이 실제 방문자 IP를 보고 있다는 뜻입니다.

**믿는 앞단 좁히기 (선택)**

- 기본 `SHRINE_TRUSTED_PROXIES`는 사설 대역 전체입니다. 앞단 nginx가 어느 Docker 네트워크에 있어도 맞게 하려는 것입니다.
- 위 접속 기록의 `remote_ip` 대역(예: `172.20.0.0/16`)만 남겨 `.env`에 적고 `$C up -d`를 해도 됩니다. 접속 기록에는 앞 3자리만 남으니 대역은 `/16` 이상으로 넉넉히 적습니다.
- 바깥 방문자는 앞단이 값을 덮어쓰므로 IP를 꾸밀 수 없습니다. 다만 이 서버의 다른 컨테이너도 172.17.0.1:8111에 닿을 수 있어서, 그쪽이 뚫리면 IP를 꾸며 보낼 수 있다는 정도의 위험은 남습니다.

## 14. 자동 배포 (GitHub Actions)

`main`에 올라간 커밋이 시험(`check` 워크플로)을 통과하면 `deploy` 워크플로가 서버에 SSH로 붙어 `deploy/shrine-deploy.sh`를 돌립니다.

- 그 스크립트가 하는 일
  1. `origin/main`을 받아 그 커밋까지 빨리감기만 합니다. 서버에서 손으로 고친 파일이 있으면 멈춥니다.
  2. 배포 전 백업을 만듭니다 (`/usr/local/bin/shrine-backup`).
  3. `up -d --build`로 띄웁니다. `.env`의 `COMPOSE_FILE`(다른 프록시 뒤 모드)을 따릅니다.
  4. `api`가 3분 안에 healthy가 되는지 봅니다. 아니면 실패로 끝나고 Actions에 빨간 표시가 뜹니다.
- 다른 사람이 보낸 PR에서는 돌지 않습니다 (`check`가 `main` push로 성공했을 때만). GitHub는 PR에 비밀값을 주지 않습니다.
- 손으로 다시 배포: Actions → deploy → Run workflow.

**`main` 보호 (저장소 Settings → Rules → Rulesets 또는 Branches)**

- 대상: `main`
- 머지 · 푸시는 저장소 관리자(운영자)만: 'Restrict updates' / 'Restrict who can push'에 운영자만
- PR 필수, 상태 검사 `check`의 두 작업(pytest · conformance) 통과 필수
- 강제 푸시 · 삭제 금지

**서버 준비 (한 번)**

```bash
cd /srv/musabaepo-shrine
sudo install -m 755 deploy/shrine-deploy.sh /usr/local/bin/shrine-deploy
# 배포 전 백업만 비밀번호 없이 (배포 계정이 root 백업 스크립트 하나만 부를 수 있게)
echo "$USER ALL=(root) NOPASSWD: /usr/local/bin/shrine-backup" | sudo tee /etc/sudoers.d/musabaepo-shrine-deploy
sudo chmod 440 /etc/sudoers.d/musabaepo-shrine-deploy && sudo visudo -c
# 배포 전용 키: 이 스크립트만 돌게 묶어 authorized_keys에 넣음
ssh-keygen -t ed25519 -N "" -C github-deploy-musabaepo -f ~/shrine-deploy-key
printf 'command="SHRINE_DIR=%s /usr/local/bin/shrine-deploy",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding %s\n' \
  "$PWD" "$(cat ~/shrine-deploy-key.pub)" >> ~/.ssh/authorized_keys
```

**GitHub 비밀값 (Settings → Secrets and variables → Actions → New repository secret)**

| 이름 | 값 |
|---|---|
| `DEPLOY_HOST` | 서버 공인 주소 |
| `DEPLOY_PORT` | SSH 포트 (22면 비워도 됨) |
| `DEPLOY_USER` | 서버 계정 (`echo $USER`) |
| `DEPLOY_SSH_KEY` | `cat ~/shrine-deploy-key`의 내용 전체 (BEGIN … END 줄 포함). 넣은 뒤 서버의 이 파일은 지웁니다: `shred -u ~/shrine-deploy-key` |
| `DEPLOY_KNOWN_HOSTS` | `echo "<서버 공인 주소> $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"`의 출력 한 줄 |

- 확인: Actions → deploy → Run workflow → 로그 끝에 `[deploy] 배포를 마쳤습니다`.
- 키를 바꾸거나 끊으려면 `~/.ssh/authorized_keys`에서 `github-deploy-musabaepo` 줄을 지웁니다.
- GitHub 러너가 서버 SSH 포트에 닿아야 합니다 (공유기 포트포워딩 · 방화벽). 닿지 않으면 배포 단계가 연결 시간 초과로 실패합니다.
