#!/bin/sh
# 앱 전용 DB 계정 (보안 점검). deploy/docker-compose.yml의 postgres가 데이터 폴더가 빌 때(첫 실행) 한 번만 부릅니다.
#   shrine_app : 로그인만 됨 (슈퍼유저 · 역할 만들기 · DB 만들기 · 복제 권한 없음). DB의 주인이라 public 스키마에
#                표를 만들고(Alembic) 쓸 수 있습니다. 앱(api)의 DATABASE_URL이 이 계정입니다.
#   POSTGRES_USER(shrine, 슈퍼유저) : 컨테이너 안 유닉스 소켓으로만 (docker compose exec postgres pg_dump · pg_restore).
#                네트워크(TCP)로는 받지 않습니다. 앱 컨테이너가 .env의 POSTGRES_PASSWORD를 알아도 슈퍼유저로 붙지 못하게.
# 이미 데이터가 있는 볼륨에는 돌지 않습니다 (그때 할 일은 deploy/README.md 1장 'DB 계정').
set -eu
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD가 비어 있습니다 (../.env)}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_pw="$APP_DB_PASSWORD" -v db="$POSTGRES_DB" <<'SQL'
CREATE ROLE shrine_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'app_pw';
ALTER DATABASE :"db" OWNER TO shrine_app;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
SQL

# pg_hba.conf는 위에서부터 처음 맞는 줄을 씁니다: 슈퍼유저의 TCP 접속을 맨 앞에서 거절
{ printf 'host all %s all reject\n' "$POSTGRES_USER"; cat "$PGDATA/pg_hba.conf"; } > "$PGDATA/pg_hba.conf.new"
mv "$PGDATA/pg_hba.conf.new" "$PGDATA/pg_hba.conf"
