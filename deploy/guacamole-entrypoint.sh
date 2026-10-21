#!/bin/sh
set -eu
JSON_SECRET_KEY="$(cat /run/secrets/guacamole_gateway_key)"
export JSON_SECRET_KEY
exec /opt/guacamole/bin/entrypoint.sh
