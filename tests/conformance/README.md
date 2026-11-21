# 적합성 시험 틀 (tests/conformance)

예전 Node 서버(`server/*.ts`)에서 모두 통과한 블랙박스 시험 묶음을 Python 서버(`app/`)에 그대로 돌립니다.
Python 서버로 옮길 때의 완료 기준이었고, 지금은 Python 서버의 회귀 시험입니다 (570 PASS + 3 SKIP).

> **node 대상은 은퇴했습니다.** Node 서버(`server/`)는 커밋 `a2b1bf6` 뒤에 저장소에서 빠졌습니다. `--target node`는 그 사실을 알리고
> 멈춥니다. Node 쪽 기준값을 다시 보려면 `git switch --detach a2b1bf6`에서 돌립니다. 아래 표의 'node' 칸 · `lib/node-*.mjs`는 그때의 기록입니다.

Node 24 이상(`ws` 패키지: `npm ci`), `uv`, 개발용 PostgreSQL · Redis 컨테이너가 필요합니다 (루트 README '로컬에서 실행').

```bash
npm run test:conformance                      # 대상 py (기본) = node tests/conformance/run.mjs
npm run test:conformance -- --only s1,chan    # 몇 묶음만
npm run test:conformance -- --browser         # 화면 시험(headless Edge)까지
npm run test:conformance -- --selftest        # 운전기 자체 시험(driver 묶음)을 먼저: 시험 틀이 그 대상에서 제대로 도는지
SHRINE_TARGET=py node tests/conformance/s2.test.mjs   # 묶음 하나만 직접
```

결과는 묶음마다 `PASS / FAIL / SKIP / 못 감(중간에 끝나 세지 못한 검사)`으로 나오고, 전체 출력은 작업 폴더
(`<OS 임시 폴더>/musabaepo-conformance/<대상>-<실행 번호>/<묶음>.log`)에 남습니다.
기능이 아직 없는 대상에서는 몇몇 검사가 우연히 PASS로 나옵니다 (예: 모든 주소가 404라 "없는 사당 → 404"가 맞음,
양쪽이 다 `undefined`라 같음). 그래서 옮기는 중의 PASS 수는 진척 지표가 아니고, **FAIL 0 · 못 감 0**만 완료 기준입니다.

## 묶음

| 묶음 | 포트 | 기준(Node) | 다루는 것 |
|---|---|---|---|
| `s1` | 3340 | 107 | 잘못된 WS 메시지 · 게시판 닫힘 · 신고 · 강퇴/차단(IPv6 /64) · 채팅 끄기 · 운영 명령 차단 반영 · 기록/개인정보 · DB 쓰기 잠금 · SIGTERM · 잡히지 않은 예외 · 설정 거부 23종 · 구조 버전 |
| `admin` | 3341 | 130 (`--browser` 140) | 운영자 화면 켜짐/꺼짐 · 허용 IP · 헤더 · 로그인 잠금 · 세션 쿠키 · 출처 · 승인/반려 · 사당 추가/고치기/옮기기/내리기 · 글 · 설정 · 기록 · BASE_PATH |
| `registry` | 3342 | 65 | 등록소 접수 검증 · 접수 코드 · PIN 잠금 · 관리 · 승인/반려 · /go · 링크 변경 검토 · 내리기 · 재시작 뒤 유지 |
| `upload` | 3343 | 29 | 이미지 올리기 · 비공개 미리 보기 · 승인 뒤 공개 · 이미지 변경 검토 |
| `shrine` | 3344 | 90 | BASE_PATH=/shrine 공개 화면 · world · WS 입장/이동/초/말풍선/채팅 거르기/앉기/AI 기도/게시판 · 제한 |
| `s2` | 3345 · 3346 · 웹훅 3347 | 94 | healthz · 약관 · 동의/PIN · 웹훅 알림 · EXIF 지우기 · 업로드 제한 · 변경 검토 · 클릭 수 · 옛 PIN · 차단 · 보관 기간 · robots/sitemap |
| `chan` | 3348 | 53 | 채널별 사당: world · 접수 · 관리 · 승인 · 옮기기 · 추가 · 실시간 초 켜기 |
| `npc` | 3349 | 5 | NPC가 자기 채널 사당만 구경 감 |
| `edge` | 3350 (CDP 9521) | 43 | `--browser`만. 채널 화면 · 등록소 채널 고르기 · 375px · 운영자 화면 |
| `driver` | 3351 | 24 | `--selftest`만. 기능 시험이 아니라 운전기 자체 시험 (서버 띄우기/끄기 · sql · 잠금 · 원문 · Redis 짝 · 구조 버전 · 설정 거부 · 정리). py가 P1만 있어도 모두 통과 |

포트는 3340~3359만 씁니다 (3300은 개발 서버, 운전기가 띄우기 전에 거부). 묶음은 하나씩 돕니다. 실행기는 시작 전에 포트가
비어 있는지 보고, 끝난 뒤 그 포트에 남은 프로세스(그 묶음이 띄운 것)를 끄고 py면 그 실행의 시험 DB를 지웁니다.
`startServer`도 띄우기 전에 포트가 비었는지 확인합니다 (남은 서버의 응답을 새 서버로 착각하지 않게).

## 파일

```
tests/conformance/
  run.mjs              실행기
  driver.mjs           대상마다 다른 부분 전부 (아래 API)
  lib/check.mjs        PASS/FAIL/SKIP 세기 · "##conformance {json}" 요약 줄
  lib/node-wrap.mjs    Node 대상: main.ts + 표준 입력 신호 흉내
  lib/node-hooks.mjs   Node 대상: 시험용 훅 (retention · erase-now · notify · npc-goals)
  fixtures/seed/*.json 시험용 사당 2곳 (예시 도메인)
  *.test.mjs           시험 묶음
  selftest.mjs         운전기 자체 시험 (driver 묶음)
app/tests/conformance_helpers/pgtool.py   py 대상: PostgreSQL · Redis 도우미 (JSON 한 줄씩 주고받음)
```

## 환경 변수

| 이름 | 기본 | 뜻 |
|---|---|---|
| `SHRINE_TARGET` | `py` | `py` (`node`는 은퇴: 커밋 `a2b1bf6` 이하에서만) |
| `SHRINE_TEST_PG` | `postgresql://postgres:dev@127.0.0.1:55432/postgres` | py: 관리자 접속 주소 (개발용 컨테이너 `musabaepo-dev-pg`). 시험마다 무작위 비밀번호의 역할과 새 DB를 만들고 끝나면 지웁니다 (이름 `shrine_conf_<실행>_…`) |
| `SHRINE_TEST_REDIS` | `redis://127.0.0.1:56379` | py: Redis (개발용 컨테이너 `musabaepo-dev-redis`). DB 번호만 바꿔 씁니다 |
| `SHRINE_CONF_REDIS_DBS` | `1-12` | py: 시험이 비우고 쓰는 Redis DB 번호 (13은 app pytest가 씀) |
| `SHRINE_PYTHON` | `app/.venv`의 python | py: Python 실행 파일 (없으면 `uv run`으로 찾음) |
| `SHRINE_CONF_WORK` | `<임시 폴더>/musabaepo-conformance` | DATA_DIR · 로그 · 화면 사진 (저장소 안은 안 됨) |
| `SHRINE_CONF_KEEP` | - | `1`이면 py 시험 DB를 지우지 않음 (실행기는 묶음마다 지움) |
| `SHRINE_READY_MS` | node 15000 · py 45000 | 서버가 뜨기를 기다리는 시간 |
| `SHRINE_EDGE` | Edge 기본 경로 | 화면 시험 브라우저 |

## driver.mjs API

```js
import * as D from './driver.mjs'
D.TARGET, D.isPy, D.PORTS, D.BROWSER, D.has(cap), D.DB_LOCK_ERROR_RE
await D.freshDataDir(name)                 // 새 DATA_DIR 경로 (py: + 새 PG DB + 비운 Redis DB 번호, DATA_DIR로 짝지음)
await D.startServer(env, { ready, hooks }) // { proc, out, err, exited } — env.DATA_DIR의 짝 DB가 따라감
await D.stopServer(srv) / await D.restartServer(srv, envPatch)
D.signal(srv, 'SIGTERM' | 'crash' | 'reject')   // hooks: true로 띄운 서버만
D.boot(env, ms)                            // 설정 검사용 한 번 띄우기 { code, text }
D.cli(args, { env, input })                // 운영 명령 { status, stdout, stderr }
D.devHook(name, args, { env })             // 시험용 훅 · D.runRetention(env) · D.eraseNow(env, id) · D.notify(env, ev, fields) · D.npcGoals(env, ch, n)
await D.sql(dir, 'SELECT … WHERE id = ?', [id]) / D.sqlGet(…)   // SQLite식 ?, 넣기는 RETURNING id
await D.sqlLock(dir)                       // { begin, run, rollback, close } 다른 연결의 쓰기 잠금
await D.dbDump(dir)                        // DB에 저장된 모든 것 (latin1 글자)
D.dbIntegrityOk · D.tableColumns · D.hasTable · D.seedLegacySchema · D.preMigrateSnapshots · D.setFutureSchemaVersion · D.walSize · D.uploadFile · D.redisKeys
await D.cleanup()                          // lib/check.mjs의 done()이 부름
```

시험 코드는 대상 이름으로 갈리지 않습니다. 대상이 갖지 않은 **저장소 특성**만 `D.has(cap)` / `T.okIf(cap, …)`로 갈리고 SKIP으로 셉니다.

| 특성 | node | py | 그 특성이 필요한 검사 |
|---|---|---|---|
| `sqlite-wal` | O | - | s1 "종료 전 -wal 파일에 내용 있음", "WAL 체크포인트" |
| `sqlite-legacy` | O | - | s1 "바꾸기 전 사본"(pre-migrate/), "옛 데이터 그대로"(조건 일부), "사본 더 안 뜸"(조건 일부) |

py 대상의 SKIP은 3개입니다 (s1). 따라서 py 완료 기준은 **s1 104 PASS + 3 SKIP, 나머지 묶음은 기준과 같은 수의 PASS**입니다.

## Python 서버가 갖춰야 하는 시험 접점 (P2~P4)

### 1. 운영 명령 `python -m shrine.cli <명령> …` (app/에서, `uv run python -m shrine.cli …`와 같음)

`server/cli.ts`와 **같은 이름 · 같은 인자 · 같은 종료 코드**(성공 0, 실패 1 + 표준 오류에 까닭). 환경 변수는 서버와 같습니다
(`DATA_DIR` · `DATABASE_URL` · `REDIS_URL` · `TICKET_SECRET` …). DB를 열 때 서버처럼 Alembic을 올립니다 (빈 DB → head).
서버가 떠 있는 동안 바꾼 값은 서버에 반영돼야 합니다: 사당은 30초 안(`/api/world`), 차단 · 풀기는 10초 안(걸린 접속자는 4005로 끊김).

시험이 보는 출력 (정규식):

| 명령 | 시험이 보는 것 |
|---|---|
| `add <json 파일 \| ->` | 0 / 실패면 ≠0 + 까닭 (표준 입력 `-` 포함) |
| `upload -` (표준 입력 바이트) | 표준 출력에 `up/<16자>.(png\|jpg\|webp)` |
| `list` | 사당 slug가 들어감 |
| `status <slug> live\|check` | 0 / 없는 사당: 1 + `/없는 사당/` |
| `move <slug> <자리> [채널]` | `/12 → 3/` / 찬 자리: 1 + `/이미 사당이 있는 자리/` |
| `projects [all]` | `#<번호>`, `dev@example.com (공개)`, 변경 검토면 `링크 변경 검토` |
| `approve <번호> [자리\|-] [채널]` | `/승인했습니다/`, `/자리 3/`, `/채널 2 · 자리 1/`, `/링크 변경을 승인/`, `/글자 변경을 승인/`, `/이미지 변경을 승인했습니다/`; 찬 자리 ≠0 |
| `reject <번호> [사유…]` | `/반려했습니다/`, 변경 반려는 `/변경을 반려/` |
| `blocks` | `/차단/`, `#<번호>`, IP 원문 없음 |
| `block-ip <IP> <30m\|12h\|7d> [사유…]` | 0 + `/막았습니다/`; 기간 형식이 틀리면 1 |
| `unblock <번호>` | 0 + `/풀었습니다/` |
| `schema` | `DB 구조 버전 v4 …` (`/버전 v4/`; Alembic 0001 = Node 구조 v4. 리비전이 늘면 v5 …) / 이 서버가 모르는 리비전이면 ≠0 + 표준 오류 `/더 새 서버가 만든 DB/` |

시험에서 쓰지 않지만 같은 이름으로 있어야 하는 것: `remove`, `posts`, `post-hide`, `post-show`, `post-del`, `erase`.

### 2. 시험용 훅 `python -m shrine.cli dev <훅> …`

서버 내부 함수를 한 번 부르는 운영 명령입니다 (Node 대상은 `lib/node-hooks.mjs`가 같은 일을 함). 설정 검사는 서버와 같아서
`RETENTION_DAYS=-1`이면 ≠0 + 표준 오류에 `RETENTION_DAYS`가 들어가야 합니다.

| 훅 | 하는 일 | 출력 (마지막 줄) |
|---|---|---|
| `dev retention` | 보관 기간 정리 한 번 (서버의 주기 작업과 같은 함수, `RETENTION_DAYS` · `PENDING_DAYS` 반영). 알림(웹훅)을 보내면 **보내기가 끝난 뒤** 끝남 | `{"expired":0,"expiredChanges":0,"purged":0,"images":0,"posts":1,"reports":2}` |
| `dev erase-now <번호>` | 작성자 요청 바로 파기 (`destroyProjectNow`: 맵에서 빼고 이미지 지움, admin_log는 안 씀) | `{"ok":true,"images":1,"message":"…"}` / 없는 접수 `{"ok":false,…}` |
| `dev notify <event> <fields JSON>` | `notify(event, fields)` 한 번, 보내기가 끝날 때까지(실패해도) 기다림. 주소가 없으면 아무것도 안 보냄 | `done` (종료 코드 0, 받는 곳이 없어도 0) |
| `dev npc-goals <채널> <횟수>` | NPC 목적지 고르기를 횟수만큼 (빈 자리는 모두 찬 것으로 보고, NPC가 없는 채널은 빈 채널 상태로) | `[{"kind":"shrine","at":{"x":…,"y":…}}, …]` |

### 3. 신호 흉내 `SHRINE_TEST_STDIN=1` (P3)

Windows에서는 다른 프로세스에 SIGTERM을 보낼 수 없어서, 이 환경 변수가 있으면 서버가 **표준 입력의 줄 명령**을 읽습니다
(`NODE_ENV=production`이면 무시). Node 대상은 `lib/node-wrap.mjs`가 같은 일을 합니다.

| 명령 | 서버가 할 일 | 시험이 보는 것 |
|---|---|---|
| `term` | SIGTERM을 받은 것과 같은 길 | 모든 접속자 close 1012, 8초 안에 종료 코드 0, 로그 `끝내는 중 (SIGTERM)` · `끝났습니다 (SIGTERM)`, 그 뒤 쓰기가 DB에 남음, 포트 닫힘 |
| `crash` | 이벤트 루프에서 `Exception('시험용 예외')`가 잡히지 않고 올라간 것처럼 | 접속자 1012, 종료 코드 1, 로그 `잡히지 않은 예외` + `시험용 예외` |
| `reject` | 기다리지 않는 작업이 `Exception('시험용 거부')`로 실패한 것처럼 (결과를 아무도 안 봄) | 로그 `처리되지 않은 Promise 거부`, 서버는 계속 응답 |

### 4. 그 밖에 시험이 기대는 동작

- **DB 쓰기 잠금**(s1 §10): 다른 연결이 모든 표를 `LOCK … IN EXCLUSIVE MODE`로 잡으면 서버의 쓰기는 오래 기다리지 말고
  약 3초 안에 실패해야 합니다 (Node `busy_timeout = 3000`과 같게: 예 `SET lock_timeout = '3s'`). 로그는
  `실시간 메시지 처리(report) 실패` + 오류 종류(`LockNotAvailable` 또는 `lock timeout`), 같은 연결에서 1분에 5번이면 그 연결만 1011.
- **서버 로그**: 설정 경고는 표준 오류로 (`설정 경고: ADMIN_PASSWORD …`, 시험은 `16~256자`를 봄). 운영 모드 시작 줄에 `운영)`.
- **DB에 IP 원문 · 말풍선을 저장하지 않음**: `D.dbDump()`는 PostgreSQL의 모든 표 · 모든 행을 봅니다 (Redis는 Node의 메모리와 같아 보지 않음).
- **업로드 파일 위치**: `DATA_DIR/uploads/<id>` (보관 기간 시험이 파일이 지워졌는지 봄).
- **구조 버전**: `alembic_version`에 이 서버가 모르는 리비전이 있으면 서버 · `cli schema` 모두 `더 새 서버가 만든 DB`로 거부.

## 옮기지 못한 것 · 바꾼 것

| 원래 시험 | 이식이 안 되는 까닭 | 이 틀에서 |
|---|---|---|
| s1 §9 DB 파일 바이트 검색 | PG는 파일이 아님 | `D.dbDump()` (node: shrine.db* 파일, py: 모든 행을 row_to_json) |
| s1 §10 `DatabaseSync` BEGIN IMMEDIATE | SQLite 잠금 | `D.sqlLock()` (py: 따로 연결 + 모든 표 EXCLUSIVE 잠금), 오류 글자는 `D.DB_LOCK_ERROR_RE` |
| s1 §11 `-wal` 파일 크기 2개 | PG에 없음 | `sqlite-wal` 특성 → py SKIP |
| s1 §11·12 `s1-wrap.mjs` + `process.emit` | Node 전용 | `D.signal()` (node: lib/node-wrap.mjs, py: `SHRINE_TEST_STDIN=1`) |
| s1 §14 v0 SQLite DB → v4, pre-migrate 사본 | 결정 D4(빈 DB로 시작)라 옛 PG DB가 없음 | node는 그대로. py: 빈 DB → `cli schema`가 head로 올리는지 · 새 표/칸 확인, 사본 1개는 SKIP, 미래 버전은 `alembic_version` 조작 |
| s2 `retention.ts` · `notify.ts` import | Node 모듈 | `dev retention` · `dev erase-now` · `dev notify` 훅 |
| npc `npc.ts` · `world.ts` · `shrines.ts` import | Node 모듈 | `dev npc-goals` 훅 + 자리 좌표 · 사당은 `/api/world` |
| 모든 묶음의 SQLite 직접 읽고 쓰기 | 방언 | `D.sql()` (SQLite식 `?`를 `$1`로, `lastInsertRowid` 대신 `RETURNING id`) |
| 고정 경로 · 고정 포트 · `ws` 경로 import | 저장소 밖 | 저장소 기준 경로 · 3340~3359 · `import WebSocket from 'ws'` |
| 서버 준비 확인 | 묶음마다 제각각 (대부분 `/api/world`가 200) | 그 주소에서 HTTP 응답이 오면 준비 끝 (아직 없는 주소여도 시험이 계속 돌아 실제 검사가 FAIL로 드러남) |
| 씨앗 사당 (실제 서비스 이름) | 공개 저장소 | `fixtures/seed/{a,b}.json`을 예시 도메인 `seed-one/seed-two.example.com`으로 (자리 · 분류 · 기도 등은 같음) |
| `destroyProjectNow(없는 번호)` 출력을 `/"ok":false/`로 봄 | JSON 띄어쓰기에 기댐 | 해석한 결과의 `ok === false`로 봄 |
| s1 전체가 try 하나 | 앞에서 예외가 나면 뒤 구간(설정 검사 · 구조 버전 등)을 못 감 | 구간 6개(1~9 · 10 · 11 · 12 · 13 · 14)를 따로 감쌈. 검사 내용 · 수는 그대로, 예외는 그 구간의 `예외` FAIL 하나 |

Node 전용 문구(설정 거부 메시지 등)는 그대로 둡니다. Python 서버가 같은 한국어 메시지를 냅니다.
