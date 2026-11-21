# 기여 안내

무사배포 기원소에 관심 가져 주셔서 고맙습니다. 버그 신고, 제안, PR 모두 환영합니다.

## 시작하기

[uv](https://docs.astral.sh/uv/), Docker(개발용 PostgreSQL · Redis), Node 24 이상(적합성 시험 · 화면 코드 문법 검사)이 필요합니다.
개발용 컨테이너와 `.env`를 만드는 법은 [README의 '로컬에서 실행'](README.md#로컬에서-실행)에 있습니다.

```bash
cd app
uv sync
uv run python -m shrine --env-file ../.env     # http://127.0.0.1:3300/
uv run pytest                                  # 단위 · DB 시험 (PR 전에 꼭 통과해야 합니다)
cd ..
npm ci && npm run test:conformance             # 적합성 시험 (서버 동작을 바꿨다면)
for f in public/js/*.js public/admin/*.js; do node --check "$f"; done
```

- 서버 코드는 `app/shrine/`(Python 3.13, FastAPI)입니다. DB 구조를 바꾸면 `app/alembic/versions/`에 마이그레이션을 더합니다.
- 화면 코드(`public/js/*.js`, `public/admin/*.js`)는 프레임워크 없는 브라우저 JavaScript입니다.
- `app/tests/data/golden/`은 예전 Node 서버에서 뽑아 둔 기준값입니다. 손으로 고치지 않습니다 (`app/tests/golden.py` 설명).

## PR 보내기

1. 큰 변경은 먼저 이슈로 이야기해 주세요. 방향이 맞는지 미리 맞추면 서로 시간을 아낄 수 있습니다.
2. PR 하나에는 한 가지 목적만 담아 주세요.
3. `uv run pytest`와 화면 코드 문법 검사가 통과해야 합니다 (GitHub Actions가 PR마다 적합성 시험까지 돌립니다).
4. 화면이 바뀌면 바꾸기 전 · 후 스크린샷을 붙여 주세요.
5. 비밀번호 · 키 · 개인정보(이메일 · 전화번호 등)는 코드 · 커밋 · 스크린샷 어디에도 넣지 마세요.
6. 캐릭터 꾸미기 부위의 순서 · 개수를 바꾸면 `app/shrine/logic/world.py`의 `LOOK_SIZES`도 같이 바꿔야 합니다 (저장된 캐릭터가 깨지지 않게 신중하게).

코드 주석과 화면 문구는 한국어로 씁니다.

## 기여한 내용의 권리

이 프로젝트는 [PolyForm Noncommercial License 1.0.0](LICENSE)으로 공개되어 있고, 상업적 이용은 프로젝트 운영자(CDPP)만 할 수 있습니다.
그래서 기여를 받을 때 아래에 동의해 주셔야 합니다.

**PR(또는 패치)을 보내면, 보낸 사람은 다음에 동의한 것으로 봅니다.**

- 기여한 내용은 본인이 직접 만들었거나, 이렇게 제공할 권리가 있는 것입니다.
- 기여한 내용에 대해 프로젝트 운영자(CDPP)에게 영구적이고 전 세계적이며 무상이고 취소할 수 없는 라이선스를 줍니다.
  이 라이선스로 운영자는 기여한 내용을 사용 · 복제 · 수정 · 배포 · 재라이선스하고 상업적으로 이용할 수 있습니다.
- 기여한 내용은 이 저장소에서 [PolyForm Noncommercial License 1.0.0](LICENSE)으로 다른 사람에게도 공개됩니다.

동의하지 않으시면 PR 대신 이슈로 아이디어만 남겨 주세요.
