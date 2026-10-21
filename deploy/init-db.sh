#!/bin/sh
set -eu
# psql quotes the variable as an SQL literal; no credential is printed.
psql -v ON_ERROR_STOP=1 --username postgres --dbname homelab <<'SQL'
\set app_password `cat /run/secrets/postgres_password`
CREATE ROLE homelab LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
ALTER DATABASE homelab OWNER TO homelab;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO homelab;
SQL
