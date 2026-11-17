# 무사배포 기원소

개발자가 도트 캐릭터로 걸어 다니며, 서로의 프로젝트 사당에 "무사배포" 초를 켜 주는 작은 온라인 마당입니다.
로그인 없이 들어와 캐릭터를 꾸미고, 사당을 구경하고, 초를 켜고, 말풍선으로 인사합니다.

- 서버: Node 24 (TypeScript를 빌드 없이 실행) · SQLite · WebSocket
- 화면: 프레임워크 없는 JavaScript + Canvas 도트 그림
- 배포: Docker (앱 + Caddy, 자동 HTTPS)

## 주요 기능

- **캐릭터 꾸미기**: 종족 · 몸 색 · 눈 · 머리 모양 · 옷 · 신발 · 소품을 골라 도트 캐릭터를 만듭니다. 4방향 걷기와 절 · 손 흔들기 · 뽀뽀 · 앉기 같은 동작이 있습니다.
- **프로젝트 사당**: 등록소에서 프로젝트(GitHub 저장소 또는 서비스 주소)를 접수하면, 운영자가 확인한 뒤 맵의 빈 자리에 사당으로 올라갑니다.
  사당 앞에서 초를 켤 수 있고(같은 사당은 한 사람이 30분에 한 번), 이번 주 켜진 초가 많을수록 마당 전체가 밝아집니다.
- **같이 노는 공간**: 채널 3개(채널마다 20명), 정해진 말 · 짧은 직접 채팅(저장하지 않음), GitHub 신당 · AI 신당 · AI 트렌드 게시판(준비 중) · 배포운 상자 · 흡연구역(온라인 한숨).
- **AI 안경**: 켜면 화면 단추와 맵 위 장소마다 설명 카드가 붙는 튜토리얼 모드.
- **관리자 페이지 · 운영 도구**: 등록소 접수 승인 · 반려, 사당 추가 · 수정, 게시판 신고 처리.

## 로컬에서 실행

Node 24 이상이 필요합니다.

```bash
npm install
npm run dev          # http://127.0.0.1:3300/
npm run check        # 서버 타입 검사
```

- 개발 모드에서는 Turnstile 키가 없으면 사람 확인을 건너뜁니다. 운영(`NODE_ENV=production`)에서는 필요한 키가 없으면 서버가 시작하지 않습니다.
- 데이터는 `data/` 폴더(SQLite)에 쌓입니다. 지우면 빈 맵으로 다시 시작합니다.
- 처음에는 사당이 없습니다. 등록소로 접수한 뒤 운영 도구로 승인하거나(`npm run shrine -- approve <번호>`), 관리자 페이지에서 직접 넣습니다.

## 설정 (환경 변수)

`.env.example`을 `.env`로 복사해 채웁니다. 주요 값:

| 변수 | 뜻 |
|---|---|
| `SHRINE_DOMAIN` · `PUBLIC_ORIGIN` | 서비스 도메인 (Caddy 인증서 · 출처 확인) |
| `TICKET_SECRET` | 입장 표 서명 키 (긴 무작위 문자열) |
| `TURNSTILE_SITE_KEY` · `TURNSTILE_SECRET` | Cloudflare Turnstile 사람 확인 키 |
| `BASE_PATH` | 비워 두면 도메인 루트(`/`)에서 동작 |
| `CONTACT_EMAIL` | (선택) 화면에 보여 줄 문의 주소 |
| `FREE_CHAT` | `off`면 직접 채팅을 끄고 정해진 말만 |
| `GITHUB_CHECK` | `off`면 등록소의 GitHub 공개 저장소 확인을 끔 |
| `CANDLE_COOLDOWN_MS` | 같은 사당 초 켜기 간격 (기본 30분) |

## 배포 (Docker, 독립 도메인)

1. Docker가 설치된 서버를 준비하고, 도메인의 DNS A 레코드를 서버 IP로 겁니다.
2. Cloudflare Turnstile에서 그 도메인용 키를 발급합니다.
3. `.env`를 채웁니다 (`BASE_PATH`는 비워 둡니다).
4. 띄웁니다:
   ```bash
   cd deploy
   docker compose up -d --build
   ```
   Caddy가 HTTPS 인증서를 자동으로 받고, 앱은 Caddy 뒤에서만 받습니다.

데이터는 `shrine-data` 볼륨 하나에 있습니다. 서버를 옮길 때는 저장소 · `.env` · 볼륨을 옮기고 DNS만 바꿉니다.
채널 정보가 프로세스 메모리에 있어서 앱은 한 개만 띄웁니다.

## 운영 도구

```bash
npm run shrine -- list                    # 사당 목록
npm run shrine -- projects [all]          # 등록소 접수 (검토할 것만, all이면 전부)
npm run shrine -- approve <번호> [자리]     # 접수 승인 → 빈 자리(0~19)에 사당으로. 링크 · 이미지 변경 승인도 같은 명령
npm run shrine -- reject <번호> [사유]      # 접수 반려 (링크 · 이미지 변경만 되돌리기)
npm run shrine -- posts                   # AI 트렌드 게시판 글 · 신고 수
npm run shrine -- post-hide <번호> | post-show <번호> | post-del <번호>
npm run shrine -- status <slug> check|live  # 점검중 전환 · 되돌리기
npm run shrine -- remove <slug>
```

Docker에서는 `docker compose exec shrine node --disable-warning=ExperimentalWarning server/cli.ts list`처럼 씁니다.

## 구조

| 파일 | 하는 일 |
|---|---|
| `server/main.ts` | HTTP + WebSocket 서버 |
| `server/http.ts` | 화면 · API · 정적 파일 · 보안 헤더 |
| `server/realtime.ts` | 채널, 위치 검사, 말풍선 · 동작, 초 켜기 |
| `server/npc.ts` | 채널을 채우는 NPC 방문객 |
| `server/registry.ts` · `server/uploads.ts` | 프로젝트 등록소 · 이미지 올리기 |
| `server/security.ts` | 입장 표, Turnstile, 요청 제한 |
| `server/shrines.ts` · `server/db.ts` | 사당 데이터 · SQLite |
| `server/world.ts` | 맵 (서버와 화면이 같이 씀) |
| `server/cli.ts` | 운영 도구 |
| `public/js/main.js` | 화면: 입장, 걷기, 실시간, 창, 연출 |
| `public/js/avatar*.js` | 캐릭터 도트 (부위별 그림 + 합성) |
| `public/js/lens.js` | AI 안경 설명 카드 |

캐릭터 꾸미기 부위의 순서와 개수는 `server/world.ts`의 `LOOK_SIZES`와 같아야 합니다.

## 봇 차단 · 개인정보

- 입장할 때 Turnstile 사람 확인을 거쳐 서명된 입장 표(HttpOnly 쿠키)를 받습니다. WebSocket은 입장 표가 있어야 열리고, IP당 연결 수 · 메시지 수 · 요청 수를 제한합니다.
- 직접 쓴 채팅은 저장하지 않습니다. IP는 그날만 쓰는 무작위 값과 섞은 해시로만 다룹니다.
- 등록소에 적은 이메일은 운영자 연락용으로 서버에만 두고, 작성자가 공개를 고른 경우에만 사당 창에 보입니다.

## 기여하기

버그 신고 · 제안 · PR 모두 환영합니다. [CONTRIBUTING.md](CONTRIBUTING.md)를 먼저 읽어 주세요.
보안 문제는 공개 이슈 대신 [SECURITY.md](SECURITY.md)의 방법으로 알려 주세요.

## 라이선스

[PolyForm Noncommercial License 1.0.0](LICENSE) — 코드를 보고, 고치고, 비상업적으로 쓰는 것은 자유롭습니다.
**상업적 이용(이 코드로 수익을 내는 서비스 운영 등)은 별도 허가가 필요합니다.** 문의는 GitHub 이슈로 남겨 주세요.
