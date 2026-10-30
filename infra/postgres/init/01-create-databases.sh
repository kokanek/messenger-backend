#!/bin/bash
# Runs once, when the postgres volume is first created. One database and one
# login per service, so a service can only touch its own data.
set -euo pipefail

run_sql() {
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres "$@"
}

create_service_db() {
  local db="$1" role="$2" password="$3"
  run_sql -v db="$db" -v role="$role" -v password="$password" <<'SQL'
CREATE ROLE :"role" LOGIN PASSWORD :'password';
CREATE DATABASE :"db" OWNER :"role";
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
SQL
}

create_service_db auth auth_svc "$AUTH_DB_PASSWORD"
create_service_db message message_svc "$MESSAGE_DB_PASSWORD"

# Local and CI only: databases the integration tests can wipe freely.
if [ "${CREATE_TEST_DATABASES:-false}" = "true" ]; then
  run_sql <<'SQL'
CREATE DATABASE auth_test OWNER auth_svc;
CREATE DATABASE message_test OWNER message_svc;
REVOKE ALL ON DATABASE auth_test FROM PUBLIC;
REVOKE ALL ON DATABASE message_test FROM PUBLIC;
SQL
fi
