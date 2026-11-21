# 운영 안내 (deploy)

무사배포 기원소를 Docker로 한 서버에 띄우고 운영하는 절차입니다.
첫 배포, 업데이트, 롤백, 백업과 복구, 서버 옮기기, 응급 조치를 다룹니다.

- 명령은 모두 저장소의 `deploy/` 폴더에서 실행한다고 가정합니다.
- `<도메인>`은 `.env`의 `SHRINE_DOMAIN`입니다.
- 컨테이너 안에서 운영 도구를 부르는 줄이 깁니다. 자주 쓴다면 별칭을 걸어 두면 편합니다.
  ```bash
  alias shrine-node='docker compose exec -T shrine node --disable-warning=ExperimentalWarning'
  # 예: shrine-node server/cli.ts list
  ```
  이 문서는 복사해 바로 쓸 수 있게 별칭 없이 전체 명령으로 적었습니다.

## 1. 구성

| 이름 | 하는 일 | 바깥에 여는 포트 |
|---|---|---|
| `shrine` | 앱 (HTTP + WebSocket, Node 24) | 없음. Caddy만 3300으로 붙습니다 |
| `caddy` | HTTPS 인증서 자동 발급, 프록시, 보안 헤더, 접속 기록 | 80/tcp, 443/tcp, 443/udp(HTTP/3) |

| 저장 위치 | 내용 |
|---|---|
| 볼륨 `shrine-data` (`/app/data`) | `shrine.db`(SQLite, WAL) + `uploads/`(등록소 이미지) |
| 호스트 `deploy/backups/` (`/app/backups`) | 백업 tar 파일 |
| 볼륨 `caddy-data` | TLS 인증서, ACME 계정 |
| 볼륨 `caddy-logs` | 접속 기록 (IP 일부 가림, 30일 안에 지움) |
| 볼륨 `caddy-config` | Caddy가 저장하는 설정 사본 |

- 볼륨의 실제 이름 앞에는 Compose 프로젝트 이름이 붙습니다. 보통 폴더 이름이라 `deploy_shrine-data`처럼 됩니다. `docker volume ls`로 확인합니다.
- 채널 정보가 프로세스 메모리에 있어서 앱은 하나만 띄웁니다.

## 2. 서버 준비

1. Docker Engine과 Compose v2를 설치합니다.
2. 방화벽은 22(관리자 IP만), 80/tcp, 443/tcp, 443/udp만 엽니다. 3300은 열지 않습니다.
3. DNS에 `<도메인>`의 A 레코드를 서버 IP로 겁니다.
   - AAAA(IPv6)는 서버가 IPv6로 실제 받는 것을 확인한 뒤에만 겁니다.
   - Cloudflare를 쓴다면 **DNS only(회색 구름)** 로 둡니다. 주황 구름(프록시)이면 모든 방문자가 Cloudflare IP로 보여 IP 제한에 같이 걸립니다. 꼭 켜야 하면 `Caddyfile`의 `trusted_proxies` 주석을 풉니다 (11장).
4. Cloudflare Turnstile 키를 `<도메인>`용으로 발급합니다.
5. 코드를 받아 릴리스 태그로 맞춥니다.
   ```bash
   git clone <저장소 주소> /srv/musabaepo-shrine
   cd /srv/musabaepo-shrine && git checkout <태그>
   ```
6. `.env`를 만들고 다른 사용자가 못 읽게 합니다. `.env.example`에서 '운영 필수'로 표시된 값을 모두 채웁니다.
   ```bash
   cp .env.example .env && chmod 600 .env
   ```
   - `NODE_ENV=production`
   - `SHRINE_DOMAIN`, `PUBLIC_ORIGIN`
   - `ACME_EMAIL`: 비어 있으면 Caddy가 시작하지 않습니다
   - `TICKET_SECRET`
   - `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`
7. 백업 폴더를 만들고 컨테이너 사용자(uid 1000)에게 넘깁니다. 이걸 빼먹으면 Docker가 root 소유로 만들어 백업이 실패합니다.
   ```bash
   cd deploy
   mkdir -p backups && sudo chown 1000:1000 backups && sudo chmod 700 backups
   ```

## 3. 첫 배포

```bash
cd deploy
docker compose up -d --build
docker compose ps          # shrine이 (healthy)가 되면 caddy가 뜹니다
docker compose logs -f     # 인증서 발급 확인 (Ctrl+C로 나옴)
```

확인:

```bash
curl -I https://<도메인>/          # 200, strict-transport-security, content-security-policy가 보여야 함
curl https://<도메인>/healthz      # 200
```

마지막으로 두 가지를 해 둡니다.

- 첫 백업을 만들고 매일 돌도록 cron을 겁니다 (7장).
- 바깥 가동 감시(UptimeRobot 같은 무료 서비스)로 `https://<도메인>/healthz`를 5분마다 확인합니다.
  - 서버가 죽으면 알 수 있습니다.
  - 접속 기록은 요청이 들어와야 날짜가 넘어가는데, 이 요청이 그 일을 꾸준히 해 줍니다 (10장).

## 4. 운영자가 사당을 넣는 곳

**관리자 페이지 `https://<도메인>/admin`**

- `.env`에 `ADMIN_PASSWORD`(16자 이상)를 넣고 `docker compose up -d`를 하면 켜집니다. 비어 있으면 `/admin`은 404입니다.
- `ADMIN_IPS`로 들어올 수 있는 IP를 정해 두길 권합니다. Caddy에서 한 겹 더 막을 수도 있습니다 (11장).
- 할 수 있는 일
  - 등록소 접수 승인 · 반려
  - 사당 추가 · 수정 (이미지 포함)
  - 게시판 신고 처리, 차단, 직접 채팅 켜고 끄기

**운영 도구 (CLI)**

- 컨테이너에서는 이렇게 부릅니다.
  ```bash
  docker compose exec -T shrine node --disable-warning=ExperimentalWarning server/cli.ts list
  docker compose exec -T shrine node --disable-warning=ExperimentalWarning server/cli.ts projects
  docker compose exec -T shrine node --disable-warning=ExperimentalWarning server/cli.ts approve <접수번호>
  ```
- 로컬 개발에서는 `npm run shrine -- list`처럼 씁니다.
- 명령 목록은 저장소 루트 README의 '운영 도구'에 있습니다.
- 호스트의 파일은 표준 입력으로 넘깁니다. `-T`가 꼭 있어야 합니다.
  ```bash
  docker compose exec -T shrine node --disable-warning=ExperimentalWarning server/cli.ts upload - < shot.png
  docker compose exec -T shrine node --disable-warning=ExperimentalWarning server/cli.ts add - < my-shrine.json
  ```
- 서버가 떠 있는 동안 바꾼 내용은 30초 안에 맵에 반영됩니다.

## 5. 업데이트

```bash
cd deploy
# 1) 업데이트 전 백업
docker compose exec -T shrine node --disable-warning=ExperimentalWarning server/backup.ts
# 2) 지금 돌고 있는 이미지에 이름을 붙여 남김 (롤백용)
docker tag musabaepo-shrine:latest musabaepo-shrine:prev-$(date +%Y%m%d-%H%M)
# 3) 새 코드
git fetch --tags && git checkout <새 태그>
# 4) 새 이미지를 만들고 바꿔 끼움
docker compose build shrine
docker compose up -d
# 5) 확인
docker compose ps && curl https://<도메인>/healthz
```

- 앱이 다시 뜨는 몇 초 동안 Caddy가 요청을 5초까지 붙잡아 둡니다. 그보다 길어지면 '잠시 정비 중' 화면을 보여 주고 10초 뒤 저절로 새로 고칩니다. 접속자 화면은 끊기면 알아서 다시 붙습니다.
- 메모리에만 있던 것은 초기화됩니다: 요청 제한, 초 쿨다운, 채널, 말풍선, 업로드 소유 기록, 사람 신고.
- DB 구조 변경(마이그레이션)은 앱이 시작할 때 저절로 돕니다.
- `.env`만 바꿨다면 `docker compose up -d`로 충분합니다. 바뀐 서비스만 다시 만듭니다.
- `Caddyfile`만 바꿨다면 `docker compose up -d --force-recreate caddy`를 씁니다. 파일 하나를 연결해 둔 것이라 재시작만으로는 편집기가 새로 쓴 파일을 못 볼 수 있습니다.
- 지난 이미지는 2~3개만 남기고 지웁니다.
  ```bash
  docker image ls musabaepo-shrine
  docker image rm musabaepo-shrine:prev-<옛 시각>
  ```

## 6. 롤백

```bash
cd deploy
docker image ls musabaepo-shrine                                   # prev-… 태그 확인
docker tag musabaepo-shrine:prev-<시각> musabaepo-shrine:latest     # 이전 이미지를 다시 latest로
docker compose up -d --no-build
git checkout <이전 태그>     # 코드도 맞춰 둡니다 (다음 build가 문제 버전을 다시 만들지 않게)
```

- DB 구조 변경은 대개 표나 칸을 더하는 쪽이라, 이전 버전도 새 DB를 그대로 엽니다.
- 이전 버전이 DB 때문에 시작하지 못하면, 업데이트 직전 백업으로 복구합니다 (8장). 이 경우 그 사이에 쌓인 초 · 접수 · 글은 사라집니다.

## 7. 백업

**무엇을 남기나**

- 백업 하나는 tar 파일 하나입니다.
  - `shrine.db`: SQLite 온라인 백업 API로 한 시점의 사본을 뜹니다. 서버가 도는 중에도 안전합니다. 실행 중에 db 파일만 복사하면 WAL에 있는 최근 쓰기가 빠지거나 사본이 깨집니다.
  - `uploads/`: 등록소 이미지
  - `manifest.json`: 표별 행 수, 이미지 수, 파일별 SHA-256
- 파일은 `deploy/backups/shrine-YYYYMMDD-HHMMSSZ.tar`(시각은 UTC)에 생기고, 권한은 600입니다.
- 넣지 않는 것
  - `.env`: 비밀값이라 서버 밖 안전한 곳(비밀번호 관리자 등)에 따로 둡니다
  - `caddy-data`(인증서): 서버를 옮길 때만 따로 옮깁니다 (9장)
  - 접속 기록

**얼마나 두나 (개인정보 처리방침: 14일)**

- 백업을 만들 때마다 아래 둘 중 먼저 걸리는 쪽으로 지웁니다.
  - 최근 `BACKUP_KEEP`개(기본 14)를 넘는 것
  - 만든 지 `BACKUP_MAX_DAYS - 1`일(기본 13일)이 지난 것
- 매일 같은 시각에 돌리면 어떤 백업도 14일을 넘겨 남지 않습니다.
- 백업이 실패해도 기한이 지난 것은 먼저 지웁니다.
- 앱이 업데이트 때 DB 구조를 바꾸기 전에 뜨는 사본(`shrine-data`의 `pre-migrate/`)도 DB 전체 사본이라, 백업을 돌릴 때 같은 기한으로 지웁니다.
- 숫자를 늘리려면 처리방침도 같이 고쳐야 합니다.
- DB에서 이미 파기한 개인정보도, 그 전에 만든 백업에는 남아 있습니다. 백업이 지워질 때(최대 14일) 같이 사라집니다.

**명령**

```bash
docker compose exec -T shrine node --disable-warning=ExperimentalWarning server/backup.ts            # 만들기
docker compose exec -T shrine node --disable-warning=ExperimentalWarning server/backup.ts list       # 목록
docker compose exec -T shrine node --disable-warning=ExperimentalWarning server/backup.ts verify /app/backups/<파일>
docker compose exec -T shrine node --disable-warning=ExperimentalWarning server/backup.ts prune      # 정리만
```

- `verify`가 확인하는 것
  - DB 무결성
  - 표별 행 수와 이미지 수가 백업할 때 기록과 같은지
  - 모든 파일의 SHA-256 (내용 손상)
- 로컬 개발에서는 `npm run backup`, `npm run backup -- verify <파일>`처럼 씁니다.

**매일 자동으로 + 서버 밖 사본**

`/usr/local/bin/shrine-backup` (실행 권한 `chmod 700`):

```sh
#!/bin/sh
# 매일 백업하고 서버 밖으로 복제합니다
set -eu
cd /srv/musabaepo-shrine/deploy
docker compose exec -T shrine node --disable-warning=ExperimentalWarning server/backup.ts
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
| 디스크 여유가 부족합니다 | 디스크를 비우거나 `BACKUP_KEEP`을 줄입니다. 백업 뒤에도 256MB는 남아야 합니다 (디스크가 차면 SQLite 쓰기가 실패합니다) |
| DB 파일이 없습니다 | `DATA_DIR`을 확인합니다 (Docker에서는 `/app/data`) |

## 8. 복구

복구는 **앱을 멈춘 상태에서** 합니다.

- 지금 있던 DB(`-wal`, `-shm` 포함)와 이미지는 지우지 않고 데이터 폴더의 `pre-restore-<시각>/`으로 옮겨 둡니다.
- 백업을 먼저 옆 폴더에 풀어 검사하고, 통과했을 때만 바꿔 넣습니다. 검사에서 떨어지면 아무것도 바꾸지 않습니다.

**Docker**

```bash
cd deploy
F=/app/backups/shrine-20261117-193000Z.tar      # 되살릴 백업 (deploy/backups 안에 있어야 함)
# 0) 먼저 검사
docker compose exec -T shrine node --disable-warning=ExperimentalWarning server/backup.ts verify $F
# 1) 앱 멈춤 (그동안 Caddy가 '잠시 정비 중' 화면을 보여 줌)
docker compose stop shrine
# 2) 되살리기
docker compose run --rm --no-deps shrine node --disable-warning=ExperimentalWarning server/backup.ts restore $F
# 3) 다시 시작하고 확인
docker compose up -d
docker compose ps && curl https://<도메인>/healthz
# 4) 확인이 끝나면 옮겨 둔 옛 파일을 지웁니다 (개인정보가 들어 있으므로 늦어도 14일 안에)
docker compose run --rm --no-deps shrine sh -c 'rm -rf /app/data/pre-restore-*'
```

서버 밖에서 가져온 백업이라면 `deploy/backups/`에 넣고 `sudo chown 1000:1000 <파일>`을 한 뒤 위 순서를 따릅니다.

**Docker 없이 (로컬, 일반 서버)**

```bash
# 서버를 멈춘 뒤
npm run backup -- verify backups/shrine-20261117-193000Z.tar
npm run backup -- restore backups/shrine-20261117-193000Z.tar     # .env의 DATA_DIR로
npm start
```

**도구 없이 tar로**

```bash
mkdir restore-tmp && tar -xf shrine-20261117-193000Z.tar -C restore-tmp    # shrine.db, uploads/, manifest.json
```

1. 서버를 멈춥니다.
2. 데이터 폴더의 `shrine.db`, `shrine.db-wal`, `shrine.db-shm`, `uploads/`를 모두 옆으로 옮깁니다. 옛 `-wal`이 새 DB 옆에 남으면 안 됩니다.
3. `restore-tmp`의 `shrine.db`와 `uploads/`를 넣습니다.
4. Docker 볼륨이라면 주인을 `1000:1000`으로 맞춥니다.

**복구 연습** (분기에 한 번 권장)

```bash
docker compose exec -T shrine node --disable-warning=ExperimentalWarning server/backup.ts restore /app/backups/<파일> /app/backups/drill
# 출력된 표별 행 수가 list · verify 결과와 같은지 보고 지웁니다
sudo rm -rf backups/drill
```

화면까지 보려면 백업 파일을 개발 PC로 옮겨 아래처럼 띄워 봅니다. 확인한 뒤 `drill-data`와 백업 파일을 지웁니다.

```bash
npm run backup -- restore <파일> ./drill-data
DATA_DIR=./drill-data PORT=3301 npm run dev
```

## 9. 서버 옮기기

1. 새 서버를 2장대로 준비합니다.
   - 같은 태그의 코드를 받고, `.env`를 복사해 `chmod 600`, `backups` 폴더를 만들어 `chown 1000:1000`합니다.
   - DNS TTL은 하루 전에 300초쯤으로 낮춰 둡니다.
2. 옛 서버에서 받는 것을 멈추고 마지막 백업과 인증서를 챙깁니다.
   ```bash
   cd deploy
   docker compose stop caddy        # 새 요청 막기
   docker compose exec -T shrine node --disable-warning=ExperimentalWarning server/backup.ts
   docker compose stop shrine
   docker run --rm -v deploy_caddy-data:/data -v "$PWD":/out alpine tar czf /out/caddy-data.tgz -C /data .
   ```
   볼륨 이름은 `docker volume ls | grep caddy-data`로 확인합니다.
   - 인증서(`caddy-data`)도 옮기는 까닭: 새로 받으면 Let's Encrypt 발급 횟수 제한에 걸릴 수 있습니다.
   - 접속 기록(`caddy-logs`)은 옮기지 않습니다.
3. 마지막 백업 파일과 `caddy-data.tgz`를 새 서버의 `deploy/backups/`로 복사하고, `chown 1000:1000`합니다.
4. 새 서버에서 되살립니다.
   ```bash
   cd deploy
   docker compose build
   docker compose create                     # 볼륨 · 컨테이너만 만들고 시작하지 않음
   docker run --rm -v deploy_caddy-data:/data -v "$PWD/backups":/in alpine tar xzf /in/caddy-data.tgz -C /data
   docker compose run --rm --no-deps shrine node --disable-warning=ExperimentalWarning server/backup.ts restore /app/backups/<마지막 백업>
   rm backups/caddy-data.tgz
   ```
5. DNS A 레코드를 새 IP로 바꾸고 `docker compose up -d`, 3장의 확인을 합니다.
6. 새 서버가 잘 돌면 옛 서버의 데이터를 지웁니다. 옛 서버에도 개인정보가 남아 있기 때문입니다.
   ```bash
   docker compose down -v    # 볼륨까지 지움
   rm -rf backups ../.env
   ```

## 10. 무엇이 어디에 얼마나 남나

개인정보 처리방침과 맞춰야 하는 부분입니다. 앱 쪽 보관 규칙을 바꾸면 이 표와 처리방침을 함께 고칩니다.

| 기록 | 내용 | 위치 | 보관 |
|---|---|---|---|
| 서비스 DB | 사당 정보, 등록소 접수(이메일 · 관리 PIN 해시 · 링크 · 자동 닉네임), 게시판 글, 초 · 클릭 집계, 차단(차단한 사람의 IP 키 HMAC), 운영자 작업 기록(관리자 IP 해시) | `shrine-data` | 앱 규칙: 게시판 7일, 반려 · 내린 접수는 30일 뒤 파기 등 (`server/retention.ts`) |
| 등록소 이미지 | 올린 그림 파일 | `shrine-data`의 `uploads/` | 접수와 함께 |
| 백업 | 위 둘의 전체 사본 | `deploy/backups/` + 서버 밖 사본 | 14일 (7장) |
| 복구 때 옮겨 둔 옛 파일 | 복구 직전의 DB · 이미지 | `shrine-data`의 `pre-restore-*/` | 확인 뒤 바로 지움, 늦어도 14일 |
| DB 구조 변경 전 사본 | 업데이트 때 앱이 뜬 DB 사본 | `shrine-data`의 `pre-migrate/` | 14일 (매일 백업할 때 함께 정리) |
| 접속 기록 (Caddy) | 시각, 가린 IP(IPv4는 앞 3자리 /24, IPv6는 앞 /32), 메서드, 주소, 상태 코드, 크기, 걸린 시간. 쿠키 · User-Agent 같은 헤더는 남기지 않음 | `caddy-logs` | 30일 안 |
| Caddy 자체 기록 | 시작, 인증서, 오류. 오류에 요청 정보가 붙으면 IP를 위와 같이 가리고 헤더는 지움 | Docker 로그 | 10MB × 5개. 넘치면 오래된 것부터 지움 |
| 앱 기록 | 시작 · 오류 메시지 (IP · 이메일은 쓰지 않음) | Docker 로그 | 10MB × 5개 |
| 메모리에만 | 채팅 말풍선, 요청 제한에 쓰는 그날만 유효한 IP 해시, 사람 신고(24시간) | 앱 프로세스 | 앱이 다시 뜨면 사라짐 |
| 인증서 | TLS 인증서, ACME 계정(`ACME_EMAIL`) | `caddy-data` | 계속 |

**접속 기록이 30일을 넘지 않는 방식**

- Caddy가 24시간마다 새 파일로 넘깁니다. 넘긴 파일은 27일이 지나면 지웁니다.
- 하루치 묶음과 정리 지연을 더해도 30일 안에 끝납니다.
- 다만 파일을 넘기는 일은 24시간이 지난 뒤 들어온 **첫 요청 때** 일어납니다. 3장의 가동 감시가 5분마다 요청을 보내므로, 실제로는 매일 넘어갑니다.
- Docker 로그(json-file)는 크기로만 지워집니다. 그래서 IP가 남을 수 있는 접속 기록은 Docker 로그가 아니라 이 파일에 둡니다.

```bash
docker compose exec caddy tail -f /var/log/caddy/access.log      # 지금 기록
docker compose exec caddy ls -l /var/log/caddy                   # 넘긴 파일 (access-<시각>.log.gz)
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

**요청 크기 상한 (Caddy)**

| 경로 | 상한 |
|---|---|
| `/api/upload` | 11MB |
| `/api/admin/upload` | 14MB (JSON 안의 base64) |
| 나머지 | 16KB |

**운영자 화면 지키기**

- `ADMIN_PASSWORD`는 16자 이상 무작위로 씁니다.
- `ADMIN_IPS`로 들어올 수 있는 IP를 정합니다.
- 더 막고 싶으면 `Caddyfile`의 `@adminOutside` 주석을 풀어, 허용한 IP 밖에서는 Caddy가 먼저 404를 내게 합니다.

**Cloudflare 프록시를 켤 때**

`Caddyfile` 전역의 `servers { trusted_proxies … }` 주석만 풉니다.

- `reverse_proxy` 안의 `header_up X-Forwarded-For {client_ip}`는 늘 켜 둡니다 (보안 점검). 앱이 받는 X-Forwarded-For가
  늘 값 하나(Caddy가 판단한 방문자 IP)라서, `trusted_proxies`를 켜도 방문자가 보낸 값이 앞에 남아 IP를 꾸미지 못합니다.
- `trusted_proxies`를 풀지 않으면 모든 방문자가 Cloudflare IP로 보여 IP 제한에 같이 걸립니다.

**www 주소**

- 기본은 꺼 두었습니다.
- `www.<도메인>` DNS를 서버로 건 뒤에만 `Caddyfile` 끝의 주석을 풉니다. DNS 없이 켜면 인증서 발급이 계속 실패합니다.

**컨테이너 강화**

| 항목 | 앱 | Caddy |
|---|---|---|
| 실행 사용자 | node (1000) | root |
| 파일 시스템 | 루트 읽기 전용 (`/tmp`만 64MB 메모리) | 기본 |
| 권한 | 모두 뺌 (`cap_drop: ALL`) | 80 · 443을 여는 권한만 |
| 권한 상승 | 막음 (`no-new-privileges`) | 막음 |
| 메모리 · CPU · 프로세스 수 | 512MB · 1 · 200 | 256MB · 0.5 · 200 |

- Node 힙 상한은 384MB입니다.
- 로그는 두 서비스 모두 10MB × 5개로 제한합니다.

## 12. 상태 확인 · 응급 조치

**헬스 체크**

- Docker가 15초마다 앱의 `/healthz`를 부릅니다. 3번 연속 실패하면 `docker compose ps`에 `(unhealthy)`로 보입니다.
- Docker는 unhealthy만으로는 다시 시작하지 않습니다. 프로세스가 죽으면 `restart: unless-stopped`로 다시 뜹니다.
- unhealthy가 이어지면 아래처럼 봅니다.
  ```bash
  docker compose logs --tail 200 shrine
  docker compose restart shrine
  ```
- Caddy는 앱이 healthy가 된 뒤에 시작합니다.

**디스크**

- `df -h`와 `docker system df`로 봅니다.
- 디스크가 차면 SQLite 쓰기가 실패합니다. 백업은 256MB 여유가 없으면 만들지 않습니다.

**상황별 대응**

| 상황 | 할 일 |
|---|---|
| 직접 채팅이 어지러움 | 운영자 화면에서 직접 채팅을 끄거나, `.env`에 `FREE_CHAT=off` 후 `docker compose up -d` |
| 비밀 키 유출이 의심됨 | `TICKET_SECRET`을 새로 만들고 `docker compose up -d`. 모든 입장 표, 운영자 세션, IP 차단이 풀립니다 |
| `ADMIN_PASSWORD` 유출 | 새 값으로 바꾸고 `docker compose up -d`. 예전 세션은 모두 끊깁니다 |
| 문제 있는 사당 | 운영자 화면, 또는 `… server/cli.ts status <slug> check`로 점검중 전환 |
| Cloudflare Turnstile 장애 | 사람 확인을 못 해서 새 입장이 막힙니다. 운영에서는 끄는 설정이 없으니 복구를 기다립니다 |
| 업데이트 뒤 앱이 계속 재시작 | `docker compose logs shrine`을 보고 6장대로 롤백 |
| 인증서 발급 실패 | `docker compose logs caddy`. DNS A 레코드, 80 · 443 방화벽, `ACME_EMAIL` 값을 확인 |

**공개하는 날**

`.env`에 `ALLOW_INDEXING=true`를 넣고 `docker compose up -d`를 합니다. 검색에 노출됩니다.

---

## 13. Python 서버(이전 후)

> 이 장은 Python 서버 구성(`deploy/docker-compose.py.yml`: api + PostgreSQL + Redis + Caddy)로 바꾼 뒤에 씁니다.
> 바꾸기 전까지 운영본은 위 1~12장의 Node 구성입니다. 두 구성을 동시에 띄우지 않습니다 (80 · 443이 겹침).

명령은 모두 `deploy/` 폴더에서, 아래 별칭을 건 셸에서 실행한다고 가정합니다.

```bash
cd /srv/musabaepo-shrine/deploy
C="docker compose --env-file ../.env -f docker-compose.py.yml"
```

### 13.1 구성

| 이름 | 하는 일 | 바깥에 여는 포트 |
|---|---|---|
| `api` (별칭 `shrine`) | 앱 (FastAPI + uvicorn 워커 1개, HTTP + WebSocket) | 없음. Caddy만 3300으로 붙습니다 |
| `postgres` | DB (PostgreSQL 17) | 없음 |
| `redis` | 요청 제한 · 잠금 · 로그아웃한 운영자 세션 같은 짧은 상태. 디스크에 쓰지 않음 | 없음 |
| `caddy` | Node 구성과 같은 `Caddyfile`. 환경 변수는 `SHRINE_DOMAIN` · `ACME_EMAIL`만 받음 | 80/tcp, 443/tcp, 443/udp |
| `backup` | 백업 만들기 · 정리 · 검사. 늘 떠 있지 않고 `run --rm`으로만 (profile `tools`, 네트워크 없음) | 없음 |

| 저장 위치 | 내용 |
|---|---|
| 볼륨 `pg-data` | DB 전부 (사당 · 접수 · 초 · 글 · 차단 · 운영 기록) |
| 볼륨 `api-data` (`/data`) | `uploads/`(등록소 이미지) |
| 호스트 `deploy/backups/` (`/backups`) | 백업 tar 파일 (Node 구성과 같은 폴더, 주인 uid 1000). `api`는 읽기만, 쓰기는 `backup`만 |

- Redis는 다시 띄우면 비어 있습니다 (Node의 메모리와 같음). 오래 남아야 하는 것은 모두 PostgreSQL에 있습니다.
- 백업 폴더 주인은 Node 때와 같이 `sudo chown 1000:1000 backups && sudo chmod 700 backups`입니다.
- Redis는 메모리(64MB)가 차면 키를 버리지 않고 새 쓰기를 거절합니다 (`noeviction`). 로그인 · PIN 잠금 같은 보안 키가 밀려나 풀리지 않게.
- DB 계정은 둘입니다 (보안 점검).
  - `shrine_app`: 앱(`api`)이 붙는 계정. 슈퍼유저 · 역할 만들기 · DB 만들기 권한이 없고, DB `shrine`의 주인이라 표를 만들고(Alembic) 씁니다. 비밀번호는 `.env`의 `APP_DB_PASSWORD`.
  - `shrine`: 관리자(슈퍼유저). postgres 컨테이너 안 소켓으로만 받습니다 (`$C exec -T postgres pg_dump -U shrine …`). 네트워크로는 거절하므로, 앱 컨테이너가 `.env`의 `POSTGRES_PASSWORD`를 알아도 슈퍼유저로 붙지 못합니다.
  - 볼륨이 빈 첫 실행에서 `deploy/postgres-init/10-app-role.sh`가 만듭니다. `.env`에 `POSTGRES_PASSWORD` · `APP_DB_PASSWORD`(둘 다 `openssl rand -hex 24`)가 있어야 합니다.
- 이 변경 전에 만든 `pg-data` 볼륨은 첫 실행 스크립트가 돌지 않습니다. 시험용이면 `$C down -v`로 지우고 다시 띄우는 것이 가장 간단하고, 데이터를 남기려면 한 번 손으로 옮깁니다.

  ```bash
  $C up -d postgres                                                   # 새 설정(APP_DB_PASSWORD · postgres-init)으로 다시 만듦
  $C exec -T postgres sh /docker-entrypoint-initdb.d/10-app-role.sh     # shrine_app · DB 주인 · 슈퍼유저 TCP 거절
  $C exec -T postgres psql -U shrine -d shrine -v ON_ERROR_STOP=1 \
    -c "DO \$\$DECLARE r record; BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP EXECUTE format('ALTER TABLE public.%I OWNER TO shrine_app', r.tablename); END LOOP; END\$\$" \
    -c 'SELECT pg_reload_conf()'
  $C up -d                                                            # api가 shrine_app으로 다시 붙음
  ```

### 13.2 운영 도구 (CLI)

명령 이름 · 인자 · 출력은 Node의 `server/cli.ts`와 같습니다 (목록은 저장소 루트 README의 '운영 도구' 그대로).

```bash
$C exec -T api python -m shrine.cli list
$C exec -T api python -m shrine.cli projects
$C exec -T api python -m shrine.cli approve <접수번호> [자리|-] [채널]
$C exec -T api python -m shrine.cli status <slug> check
$C exec -T api python -m shrine.cli block-ip <IP> 12h [사유]
$C exec -T api python -m shrine.cli blocks
$C exec -T api python -m shrine.cli upload - < shot.png        # 표준 입력은 -T가 꼭 필요합니다
$C exec -T api python -m shrine.cli add - < my-shrine.json
$C exec -T api python -m shrine.cli schema                     # DB 구조 버전 (Alembic 0001 = Node v4)
```

- 서버가 떠 있는 동안 바꾼 사당은 30초 안에 맵에 반영됩니다. 차단 · 풀기는 10초 안에 반영되고 걸린 접속자는 그때 끊깁니다.
- 로컬 개발에서는 `app/` 폴더에서 `uv run python -m shrine.cli --env-file ../.env list`처럼 씁니다
  (`--env-file`: 있는 환경 변수가 이기고, 파일이 없으면 건너뜀. Node `npm run shrine`의 `--env-file-if-exists=.env`와 같은 규칙).
- DB를 열 때 서버처럼 Alembic을 올립니다. 이 서버가 모르는 더 새 구조면 `더 새 서버가 만든 DB`로 멈춥니다.

### 13.3 운영자 화면

Node와 같습니다 (4장 · 11장): `ADMIN_PASSWORD`(16자 이상)를 넣어야 켜지고, `ADMIN_IPS` 밖이면 404, 같은 출처 · 세션 쿠키 ·
로그인 잠금(IP당 15분 5번, 전체 15분 50번) · 모든 작업을 `admin_log`에 남기는 것까지 같습니다. 다른 점은 둘입니다.

- `ADMIN_IPS`가 있으면 서버 전체 잠금(15분 50번)은 쓰지 않고 IP별 잠금만 씁니다 (보안 점검). 그때 로그인까지 오는 요청은
  `ADMIN_IPS`뿐이라, 남이 전체 잠금을 걸어 운영자를 15분 동안 막을 수 없습니다. 운영에서 `ADMIN_PASSWORD`가 있는데
  `ADMIN_IPS`가 비어 있으면 시작할 때 `[shrine] 설정 경고: ADMIN_IPS가 비어 있습니다 …`가 나옵니다 (시작은 함).
  `ADMIN_IPS`나 Caddyfile의 `@adminOutside`로 들어올 IP를 정해 두길 권합니다.

- 로그아웃한 세션 목록을 Redis에 둡니다 (세션이 끝나는 시각까지). 그래서 앱만 다시 띄워도 로그아웃한 쿠키는 계속 막힙니다.
  비밀번호를 바꾸고 다시 띄우면 예전 세션이 모두 끊기는 것은 Node와 같습니다.

### 13.4 백업

**무엇을 남기나**

- 백업 하나는 tar 파일 하나입니다 (이름 규칙 · 보관 규칙은 7장과 같음: `shrine-YYYYMMDD-HHMMSSZ.tar`, UTC, 권한 600).
  - `db.dump`: `pg_dump --format=custom`(-Fc). 서버가 도는 중에도 한 시점의 사본입니다 (pg_dump는 트랜잭션 하나로 뜸).
  - `uploads/`: 등록소 이미지. DB 덤프를 다 받은 뒤에 넣으므로, 덤프가 가리키는 이미지는 모두 들어갑니다.
  - `manifest.json`: 표별 행 수(덤프 안의 데이터를 풀어 센 수) · 이미지 수 · 파일별 SHA-256 · pg_dump 버전.
- 앱 컨테이너에는 `pg_dump`가 없습니다. **호스트 cron이 postgres 컨테이너의 pg_dump를 `backup` 컨테이너(앱과 같은 이미지)의 백업 도구로 파이프로 넘깁니다** (결정 D8).
- `api`는 백업 폴더를 읽기만 합니다 (보안 점검). 앱이 뚫려도 백업을 지우거나 가짜 백업을 넣어 두지 못하게, 만들기 · 정리는
  한 번 띄우고 지우는 `backup` 컨테이너(네트워크 없음, `.env` 비밀 값 없음, 이미지 폴더는 읽기만)가 합니다.
- 보관 기간도 7장과 같습니다: 최근 `BACKUP_KEEP`개(14) · 만든 지 `BACKUP_MAX_DAYS - 1`일(13일). 복구 때 뜬
  `backups/pre-restore-*.dump`(DB 전체 사본)도 같은 기한으로 지웁니다.
- Node 백업(`version 1`, `shrine.db`)은 Python 서버에 되살릴 수 없습니다 (도구가 알려 주고 멈춤). 이전은 빈 DB로 시작합니다 (결정 D4).

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
- 덤프가 비었거나 중간에 끊겼으면(pg_dump 실패) 백업 도구가 `[backup] …`을 쓰고 1로 끝나며 아무것도 남기지 않습니다.
- 로컬 개발: `app/`에서 `uv run python -m shrine.backup --env-file ../.env create`. `pg_dump`가 PATH에 있으면 `DATABASE_URL`로 직접 뜨고,
  없으면 `PG_DUMP`(명령 통째로, 예: `PG_DUMP="docker exec -i <pg 컨테이너> pg_dump -U shrine -d shrine -Fc"`)나 `--dump`를 씁니다.

**서명 (선택, 보안 점검)**

- manifest의 SHA-256은 백업 안에서만 맞춰 보는 값입니다. 서명을 켜면 운영자 키 없이는 맞는 백업을 만들 수 없습니다.
- `BACKUP_SIGNING_KEY`(32자 이상, `openssl rand -hex 32`)가 있으면 만들 때 `manifest.json`의 HMAC-SHA256을 `manifest.sig`로 넣고,
  `verify` · `restore`는 서명이 없거나 틀리면 멈춥니다. 키가 없으면 서명은 보지 않습니다 (예전처럼 SHA-256 검사만).
- 키는 `.env`에 넣지 않습니다 (`api`가 `.env`를 통째로 받음). 운영자만 읽는 파일에 둡니다:
  `sudo install -d -m 700 /etc/musabaepo-shrine && openssl rand -hex 32 | sudo tee /etc/musabaepo-shrine/backup.key >/dev/null && sudo chmod 600 /etc/musabaepo-shrine/backup.key`
- 셸에 `export BACKUP_SIGNING_KEY="$(sudo cat /etc/musabaepo-shrine/backup.key)"`를 한 뒤 `backup` 명령은 그대로(compose가 넘김),
  `api`로 하는 복구 명령은 `-e BACKUP_SIGNING_KEY`를 붙여 씁니다 (13.5). 키를 서버 밖에도 따로 보관해 둡니다.

**매일 자동으로 + 서버 밖 사본**

`/usr/local/bin/shrine-backup` (실행 권한 `chmod 700`):

```sh
#!/bin/sh
# 매일 백업하고 서버 밖으로 복제합니다 (Python 서버)
set -eu
cd /srv/musabaepo-shrine/deploy
C="docker compose --env-file ../.env -f docker-compose.py.yml"
# (선택) 백업 서명 키: .env가 아니라 운영자만 읽는 파일에서 (13.4 '서명')
if [ -r /etc/musabaepo-shrine/backup.key ]; then BACKUP_SIGNING_KEY="$(cat /etc/musabaepo-shrine/backup.key)"; export BACKUP_SIGNING_KEY; fi
# postgres 컨테이너의 pg_dump(-Fc) → backup 컨테이너의 백업 도구(표준 입력). 덤프가 비거나 끊기면 백업 도구가 1로 끝나 set -e로 멈춥니다
$C exec -T postgres pg_dump -U shrine -d shrine --format=custom | $C run --rm --no-deps -T backup create --dump -
# 서버 밖 사본 (7장과 같음: sync / --delete라서 14일 규칙을 같이 지킴)
rclone sync ./backups shrine-offsite:musabaepo-shrine --include 'shrine-*.tar'
```

`/etc/cron.d/musabaepo-shrine` (Node 때 줄을 이 줄로 바꿉니다. 줄은 같고 바뀐 것은 위 스크립트입니다):

```
30 4 * * * root /usr/local/bin/shrine-backup 2>&1 | logger -t shrine-backup
```

- 결과는 `journalctl -t shrine-backup`으로 봅니다. 실패 알림은 7장처럼 끝에 `&& curl -fsS <ping 주소>`를 붙입니다.
- `pg_dump`는 postgres 컨테이너 안에서 유닉스 소켓으로 붙습니다 (컨테이너 안 접속은 비밀번호 없이 되는 이미지 기본값).

### 13.5 복구

복구는 **앱을 멈춘 상태에서** 합니다. 백업 도구는 앱(또는 운영 명령)이 DB에 붙어 있으면 되살리지 않고 멈춥니다
(`pg_stat_activity`의 연결 이름 `musabaepo-shrine`으로 봄). DB에 이 백업에 없는 표(더 새 서버가 만든 표)가 있어도 멈춥니다.

```bash
cd /srv/musabaepo-shrine/deploy
C="docker compose --env-file ../.env -f docker-compose.py.yml"
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

- 3)에서 pg_restore가 실패하면 `set -e`가 없어도 DB는 바뀌지 않습니다 (`--single-transaction`). 그때는 4)로 넘어가지 말고 까닭을 봅니다.
- 2)의 사본으로 되돌리기: `$C exec -T postgres pg_restore -U shrine_app -d shrine --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error < backups/pre-restore-<시각>Z.dump`
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

### 13.6 Node 구성과 다른 점 (운영자가 알아 둘 것)

| 항목 | Node | Python |
|---|---|---|
| DB | `shrine-data` 볼륨의 SQLite 파일 | `pg-data` 볼륨의 PostgreSQL |
| 백업 만들기 | `exec shrine node server/backup.ts` 한 줄 | postgres의 `pg_dump` → `backup` 컨테이너의 `create --dump -` (파이프, `run --rm`) |
| 백업 안의 DB | `shrine.db` | `db.dump` (pg_dump -Fc), manifest `version: 2` |
| 복구 | `restore` 한 번 | DB(`--db-to -` → pg_restore)와 이미지(`--uploads-only`) 두 번 |
| 복구 전 사본 | `DATA_DIR/pre-restore-…/` (DB + 이미지) | DB는 `backups/pre-restore-….dump`(prune이 13일 뒤 지움), 이미지는 `/data/pre-restore-…/` |
| DB 구조 바꾸기 전 사본 | `pre-migrate/` | 없음 (Alembic, 업데이트 전 백업으로 대신) |
| 로그아웃한 운영자 세션 | 메모리 (앱을 다시 띄우면 잊음) | Redis (세션이 끝날 때까지) |
| 실시간 IP당 동시 연결 기본값 (`WS_MAX_PER_IP`) | 12 | 4 (IPv6는 /64를 한 IP로 셈) |
| 자리 비움으로 끊기 (정원 90% 이상) | 10분 동안 아무 메시지 없음 | 3분 동안 실제로 한 일 없음 (같은 자리 이동 신호는 세지 않음) |
| 게시판 글이 신고로 숨는 조건 | 서로 다른 IP 해시 3개 | IP(/64) · 입장 표가 둘 다 다른 3명 |
| 운영자 전체 로그인 잠금 (15분 50번) | 늘 | `ADMIN_IPS`가 있으면 쓰지 않음 (IP별 잠금은 같음) |
| 앱의 DB 계정 | (SQLite) | `shrine_app` (슈퍼유저 아님) |
| 백업 폴더 | 앱이 씀 | 앱은 읽기만, `backup` 컨테이너가 씀 (서명은 선택) |
