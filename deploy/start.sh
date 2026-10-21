#!/usr/bin/env bash
# Start an installed deployment; never initialize, rebuild, migrate or recreate it.
set -euo pipefail
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
root=${1:-/srv/homelab-control}
project=${2:-homelab-control}
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd -- "$repo"
[[ $root == /* ]] || fail 'Deployment root must be an absolute Linux path.'
[[ $project =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail 'Invalid Compose project name.'
command -v docker >/dev/null || fail 'Install Docker Engine and Docker Compose in this WSL distribution, or enable Docker Desktop WSL integration.'
command -v python3 >/dev/null || fail 'Install python3 in this WSL distribution.'
[[ $(docker info --format '{{.OSType}}') == linux ]] || fail 'Docker must be running with Linux containers in this distribution.'
docker compose version >/dev/null || fail 'Docker Compose >=2.24.4 is required.'
if [[ ! -f $root/compose.env ]]; then
    printf 'No configured deployment at %s. One-time setup is required.\n' "$root" >&2
    printf 'In this WSL distribution, from the repository root, generate NEW configuration:\n' >&2
    printf '  sudo python3 deploy/configure.py --root %q --hostname dashboard.localhost\n' "$root" >&2
    printf 'Then follow the provision/migrate/initial startup commands in docs/operations/DEPLOYMENT.md.\n' >&2
    fail 'No configuration was generated and no services were started.'
fi
dc() { docker compose --project-name "$project" --env-file "$root/compose.env" -f "$repo/deploy/compose.yml" "$@"; }
dc config --quiet || fail 'Compose configuration is invalid; check protected configuration and Compose version.'
# Parse Compose metadata without sourcing compose.env or displaying secret values.
metadata=$(dc config --format json | python3 -c '
import json,re,sys
c=json.load(sys.stdin)
def source(service,target):
    return next(v["source"] for v in c["services"][service]["volumes"] if v["target"]==target)
host=c["services"]["proxy"]["environment"]["DASHBOARD_HOST"]
if not re.fullmatch(r"[A-Za-z0-9.-]+",host): raise SystemExit("Invalid dashboard hostname")
print(source("postgres","/var/lib/postgresql/data"))
print(c["secrets"]["runtime_env"]["file"])
print(host)
') || fail 'Cannot read validated deployment metadata.'
mapfile -t fields <<< "$metadata"
services=(postgres api proxy)
for service in "${services[@]}"; do
    id=$(dc ps --all --quiet "$service")
    [[ -n $id ]] || fail "No installed $service container for project $project. Complete one-time build/provision/migrate/start in docs/operations/DEPLOYMENT.md (use --project-name $project). This launcher never upgrades a database."
done
postgres=$(dc ps --all --quiet postgres)
api=$(dc ps --all --quiet api)
actual_data=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Source}}{{end}}{{end}}' "$postgres")
actual_secret=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/run/secrets/runtime_env"}}{{.Source}}{{end}}{{end}}' "$api")
[[ $actual_data == "${fields[0]}" && $actual_secret == "${fields[1]}" ]] || fail 'Project containers belong to different data/config paths. Select the correct root/project; no containers were started.'
worker=$(dc --profile execution ps --all --quiet worker)
if [[ -n $worker ]]; then services+=(worker); fi
printf 'Starting existing project %s; persistent data, keys, container configuration and dispatch gates are preserved.\n' "$project"
dc start --wait --wait-timeout 180 "${services[@]}" || fail 'Container health did not pass within 180 seconds. Review Compose ps and sanitized logs; no containers/data were removed.'
# Check application readiness, not just proxy configuration or a running container.
dc exec -T api node -e 'fetch("http://127.0.0.1:3000/readyz",{signal:AbortSignal.timeout(10000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' || fail 'API readiness check failed.'
printf 'HOMELAB_READY_URL=https://%s\n' "${fields[2]}"
