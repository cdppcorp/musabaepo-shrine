#!/bin/sh
# 무사배포 기원소 배포 스크립트 (GitHub Actions의 deploy 워크플로가 SSH로 부릅니다. 손으로 돌려도 됩니다)
#
# 서버에 설치:  sudo install -m 755 deploy/shrine-deploy.sh /usr/local/bin/shrine-deploy
# 배포 키는 authorized_keys에서 이 스크립트만 돌게 묶습니다 (deploy/README.md '자동 배포'):
#   command="SHRINE_DIR=/var/www/musabaepo-shrine /usr/local/bin/shrine-deploy",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA… github-deploy
#
# 하는 일: (1) main을 받아 지정한 커밋까지 빨리감기만 (2) 배포 전 백업 (3) 새로 빌드해 띄움 (4) api가 healthy인지 확인
# 받는 값: SSH가 넘긴 명령 = 배포할 커밋 SHA(40자 16진수). 그 밖의 값은 무시하고 origin/main을 씁니다.
set -eu

DIR="${SHRINE_DIR:-/srv/musabaepo-shrine}"
SHA="${SSH_ORIGINAL_COMMAND:-${1:-}}"
case "$SHA" in
  *[!0-9a-f]*|"") SHA="" ;;
esac
[ "${#SHA}" -eq 40 ] || SHA=""

log() { printf '[deploy] %s\n' "$*"; }

cd "$DIR"

# 배포는 한 번에 하나만
exec 9>"${TMPDIR:-/tmp}/shrine-deploy.lock"
if ! flock -n 9; then
  log "다른 배포가 진행 중입니다. 끝난 뒤 다시 하세요"
  exit 1
fi

# (1) 코드: 빨리감기만 (서버에서 손으로 고친 파일이 있거나 갈라졌으면 멈춤)
git fetch --quiet origin main
TARGET="${SHA:-origin/main}"
if ! git merge-base --is-ancestor "$TARGET" origin/main; then
  log "커밋 $TARGET 이 origin/main에 없습니다. 배포하지 않습니다"
  exit 1
fi
git merge --ff-only --quiet "$TARGET"
log "코드: $(git log --oneline -1)"

# (2) 배포 전 백업 (매일 백업과 같은 스크립트. sudoers에서 이것만 비밀번호 없이 허용)
if [ -x /usr/local/bin/shrine-backup ]; then
  if sudo -n /usr/local/bin/shrine-backup; then
    log "배포 전 백업을 만들었습니다"
  else
    log "배포 전 백업에 실패했습니다. 배포하지 않습니다"
    exit 1
  fi
else
  log "백업 스크립트(/usr/local/bin/shrine-backup)가 없어 백업 없이 진행합니다"
fi

# (3) 새로 빌드해 띄움 (.env의 COMPOSE_FILE을 따름: 다른 프록시 뒤 모드 등)
cd deploy
C="docker compose --env-file ../.env"
$C up -d --build --remove-orphans

# (4) api가 healthy가 될 때까지 (최대 3분)
API=$($C ps -q api)
i=0
while [ $i -lt 60 ]; do
  STATUS=$(docker inspect --format '{{.State.Health.Status}}' "$API" 2>/dev/null || echo unknown)
  if [ "$STATUS" = "healthy" ]; then
    log "배포를 마쳤습니다 (api healthy)"
    # 이 프로젝트가 빌드하며 남긴 이름 없는 옛 이미지만 정리 (같은 서버의 다른 프로젝트 이미지는 건드리지 않음)
    docker image prune -f --filter label=com.docker.compose.project=deploy >/dev/null 2>&1 || true
    exit 0
  fi
  i=$((i + 1))
  sleep 3
done
log "api가 3분 안에 healthy가 되지 않았습니다 (상태: $STATUS)"
$C ps
$C logs --tail 40 api
exit 1
