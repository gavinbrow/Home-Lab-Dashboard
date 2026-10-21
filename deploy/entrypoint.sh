#!/bin/sh
set -eu
cr=$(printf '\r')
for secret_env in /run/secrets/runtime_env /run/secrets/migration_env; do
if [ -r "$secret_env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%"$cr"}
    key=${line%%=*}
    value=${line#*=}
    case "$key" in
      DATABASE_URL|MIGRATION_DATABASE_URL|APP_DB_ROLE|MASTER_KEY|BOOTSTRAP_TOKEN) export "$key=$value" ;;
      ''|'#'*) ;;
      *) echo "Unsupported runtime secret key" >&2; exit 1 ;;
    esac
  done < "$secret_env"
fi
done
if [ -n "${DISPATCH_SIGNING_KEY_ID_FILE:-}" ]; then
  DISPATCH_SIGNING_KEY_ID="$(cat "$DISPATCH_SIGNING_KEY_ID_FILE")"
  export DISPATCH_SIGNING_KEY_ID
fi
exec "$@"
