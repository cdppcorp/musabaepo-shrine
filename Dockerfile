# 무사배포 기원소. Node 24가 TypeScript를 바로 실행하므로 빌드 단계가 없습니다.
# Node는 마이너 버전까지 고정합니다. 올릴 때는 이 줄만 바꾸고 다시 빌드합니다.
FROM node:24.14-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

# 데이터(SQLite · 올린 이미지)와 백업 폴더. 코드는 root 소유로 두고, 앱은 node 사용자(1000)로만 돕니다.
RUN mkdir -p /app/data /app/backups && chown node:node /app/data /app/backups
USER node

ENV HOST=0.0.0.0 PORT=3300 DATA_DIR=/app/data BACKUP_DIR=/app/backups
EXPOSE 3300

# 헬스 체크: GET /healthz가 200이면 정상. BASE_PATH 아래에 붙였으면 그 경로로 봅니다.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -T 4 -O /dev/null "http://127.0.0.1:${PORT}${BASE_PATH}/healthz" || exit 1

# 힙 상한은 컨테이너 메모리(512MB)보다 작게 잡습니다. 업로드 버퍼는 힙 밖을 쓰므로 여유를 남깁니다.
CMD ["node", "--max-old-space-size=384", "--disable-warning=ExperimentalWarning", "server/main.ts"]
