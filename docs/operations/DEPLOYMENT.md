# Deploying the control plane

Work resumed after the historical PAUSE_HANDOFF.md checkpoint. Pinned image builds, PostgreSQL17.11 initialization, scoped role provisioning, migrations and isolated API readiness passed using the existing WSL Docker29.7.2/Compose5.4 engine. The queued encrypted backup fixture and strict Guacamole listener proof also passed within their documented scopes. Full host recovery and production acceptance still require their separate evidence; no real homelab host was deployed.

## Prerequisites

- Dedicated Linux control-plane host with Docker Engine and Compose >=2.24.4; a private LAN/VPN and owner-configured firewall. Local container fixtures ran on existing Ubuntu WSL Docker29.7.2/Compose5.4.
- An absolute persistent root on durable storage outside this checkout and a separately protected backup destination.
- Node/npm dependencies installed from the committed lockfile. Compose builds use pinned Node 24.22.0 and `npm ci`.
- A chosen hostname and a trusted private CA path. Caddy uses its internal CA; install its root certificate on authorized client devices after verifying its fingerprint through a trusted channel. Persist `/data` because it contains the CA private material.

The app starts with dispatch disabled. The desktop route fails closed. No Docker socket, SSH key directory, guacd port, database port, or raw Guacamole client is published.

## Generate and inspect configuration

Run from the repository root on Linux. Configuration generation does not start any service. It creates random database/admin passwords, a 32-byte master key, a bootstrap token, persistent directories and `compose.env` under the new root. Linux ownership setup requires root; inspect generated paths before running.

```sh
sudo python3 deploy/configure.py --root /srv/homelab-control --hostname dashboard.internal.example
docker compose --env-file /srv/homelab-control/compose.env -f deploy/compose.yml config --quiet
docker compose --env-file /srv/homelab-control/compose.env -f deploy/compose.yml build
docker compose --env-file /srv/homelab-control/compose.env -f deploy/compose.yml up -d --wait postgres

docker compose --env-file /srv/homelab-control/compose.env -f deploy/compose.yml run --rm provision
docker compose --env-file /srv/homelab-control/compose.env -f deploy/compose.yml run --rm migrate
docker compose --env-file /srv/homelab-control/compose.env -f deploy/compose.yml up -d api proxy
```

The default listener is `127.0.0.1:443`. Set `BIND_ADDRESS` to the exact private LAN/VPN address only after owner configuration grants access and the firewall restricts authorized clients. `DASHBOARD_HOST` is a hostname without scheme or port; API `APP_ORIGIN` is the corresponding HTTPS origin. Keep client and origin hostnames identical.

The PostgreSQL bootstrap superuser uses a separate admin password. `provision` connects using the protected admin URL and provisions `homelab_migrator` as database/schema owner and `homelab_app` as a DML-only login. API and worker use only the application URL. The migration service reads its separate migration secret. Production readiness rejects privileged/owning runtime roles. Provisioning scopes ownership changes to the selected database's public objects; editing a password file alone does not rotate a persisted PostgreSQL password.

`runtime.env` contains only `DATABASE_URL`, `MASTER_KEY`, and `BOOTSTRAP_TOKEN`; `migration.env` contains `MIGRATION_DATABASE_URL` and `APP_DB_ROLE`. Secret values do not appear in Compose interpolation. Application UID/GID is `10001:10001`; artifact, staging, repository and proxy state directories must be writable by that identity. Local Compose secrets retain host file permissions: runtime/migration files use group10001/read640, while admin and role-password provisioning inputs remain owner-only/read600 and the short-lived provision service runs as container root. The PostgreSQL admin password uses group999/read640. Config parent directories remain private. Windows generation requires explicitly restricted NTFS ACLs and is not proof of Linux installation.

## Windows one-click startup

The root `start.bat` starts an **already installed** persistent Linux control plane through WSL. It detects a sole user Linux distribution (excluding Docker Desktop's internal distributions); with multiple distributions, select one using `HOMELAB_WSL_DISTRO` or `-Distro`. It uses Linux root access to read the protected configuration, `/srv/homelab-control`, and Compose project `homelab-control`. Application containers keep their configured users. Windows PowerShell, WSL, Linux Docker Engine/Compose >=2.24.4 (or Docker Desktop's integration with that distribution), and Linux `python3` are required. Host Node/npm, Go and Python for Windows are not needed by this launcher.

For a new installation, open that WSL distribution, change to this checkout (for example `cd /mnt/c/Projects/Home-Lab-Dashboard`), and complete **Generate and inspect configuration** above. Those copyable commands generate protected configuration, build images, provision/migrate the database, and create API/proxy containers. The launcher deliberately refuses missing configuration or missing core containers. It never guesses credentials, initializes a database, rebuilds images, applies migrations or recreates containers. Existing stopped containers must be compatible with the installed schema; follow the upgrade procedure separately when updating code.

The generated `dashboard.localhost` hostname resolves to loopback on current Windows browsers; custom hostnames require your own DNS/hosts entry. Once the initial proxy is running, retrieve its public CA certificate from the configured installation (this file is public; the CA private key must stay protected):

```sh
docker compose --env-file /srv/homelab-control/compose.env -f deploy/compose.yml cp proxy:/data/caddy/pki/authorities/local/root.crt /mnt/c/Users/YOUR_WINDOWS_USER/Downloads/homelab-root.crt
```

Verify the certificate fingerprint through your trusted installation channel before importing it into Windows **Current User > Trusted Root Certification Authorities** using the certificate import wizard. Use the same configured HTTPS hostname for login. The launcher checks `/readyz` through Windows HTTPS trust before opening a browser and never skips certificate checks. A trust/DNS failure leaves the containers running and shows an actionable error.

Then double-click `start.bat` from any working directory. It starts existing PostgreSQL/API/proxy containers plus the execution worker **only if that worker already exists**; it preserves existing container overlays/configuration, persistent mounts, owner authentication, dispatch/restore flags and the database epoch. It checks the project data/config mounts before starting anything, waits up to 180 seconds for container health, and then checks API and Windows HTTPS readiness. It does not enroll hosts or start separately installed host agents/optional desktop services. Closing its paused console leaves services running. Stop the installation with the documented Compose `stop` command when appropriate.

For a different installation, set persistent Windows user environment variables `HOMELAB_WSL_DISTRO`, `HOMELAB_CONTROL_ROOT`, and/or `HOMELAB_COMPOSE_PROJECT` before launching. Alternatively, run from Windows Command Prompt (quote paths/names containing spaces):

```bat
start.bat -Root "/srv/my-dashboard" -Distro "Ubuntu" -Project "my-dashboard"
```

Use the same project name used at initial deployment (`--project-name my-dashboard` on each Compose command). The launcher targets only this configured installation, never the acceptance fixtures. No credentials or generated configuration belong in this checkout.

For a safe launcher-only smoke check, run `powershell.exe -NoProfile -File deploy\start-windows.ps1 -Check`. This validates launcher syntax/path translation through WSL without reading deployment secrets or starting services; it does not certify an installed deployment.

## Owner bootstrap and readiness

Use the application's bootstrap/login interface with the locally generated token. The auth contract is `POST /api/v1/auth/bootstrap` with `email`, `password`, and `token`; owner bootstrap must become unavailable after use. Do not paste tokens into URLs, logs, or screenshots. After bootstrap remove `BOOTSTRAP_TOKEN` from `runtime.env` and recreate API/worker containers.

`/healthz` checks API liveness. `/readyz` checks database/schema/artifact/key readiness. Compose waits for database readiness before API and for API readiness before proxy. Proxy health validates its loaded configuration; it does not establish end-to-end application or host health. Worker health requires a database-backed heartbeat less than 30 seconds old; this does not prove host connectivity or successful execution. Review `docker compose ... ps` and sanitized service logs when readiness fails; do not print `runtime.env` in support reports.

## Development

Use an entirely separate root and Compose project, for example `homelab-dev`. Never reuse production paths or secrets.

```sh
python3 deploy/configure.py --root /absolute/new/homelab-dev --hostname dashboard.localhost
docker compose --env-file /absolute/new/homelab-dev/compose.env -p homelab-dev -f deploy/compose.yml -f deploy/compose.dev.yml build
docker compose --env-file /absolute/new/homelab-dev/compose.env -p homelab-dev -f deploy/compose.yml -f deploy/compose.dev.yml up -d --wait postgres

docker compose --env-file /absolute/new/homelab-dev/compose.env -p homelab-dev -f deploy/compose.yml -f deploy/compose.dev.yml run --rm provision
docker compose --env-file /absolute/new/homelab-dev/compose.env -p homelab-dev -f deploy/compose.yml -f deploy/compose.dev.yml run --rm migrate
docker compose --env-file /absolute/new/homelab-dev/compose.env -p homelab-dev -f deploy/compose.yml -f deploy/compose.dev.yml up -d api web
```

API is loopback port 3000; Vite is loopback port 5173. The dev override deliberately disables secure cookies only for this local HTTP origin. The source is built into the image; rebuild after edits. Bare-process development can use `.env.example` values with real secrets injected separately and PostgreSQL configured on the intended development endpoint.

## Dispatch and remote-access gates

The execution profile is opt-in and still defaults `DISPATCH_ENABLED=false`. Enable only after configuring compatible host transport, identity/containment verification, durable ledger reconciliation and current scope grants. Both the API/worker environment and database `runtime_control.dispatch_enabled` must permit dispatch; restore mode independently denies it. A running worker does not establish host readiness.

For an initial configured installation, set `DISPATCH_ENABLED=true` in its protected `compose.env`, explicitly enable the database flag only while `restore_mode=false` and `maintenance_mode=false`, then recreate API and start the execution-profile worker with the same overlays. Do not rotate the epoch for ordinary restarts. A restored installation must complete the recovery procedure first; changing this environment value cannot bypass the database restore fence.

`compose.desktop.yml` supplies matching Guacamole/guacd 1.6.0 for an **internal integration proof**, using the bundled matching JSON auth extension. It requires a proof key and publishes no ports. Production proxy contains no bypass route. Desktop launch stays disabled until dashboard-session binding, one-use launches, WebSocket and HTTP tunnel revocation, logout, altered IDs, and replay tests pass. Merely starting the stock containers cannot pass T05. Never publish port 4822 or stock `/guacamole` as a workaround.

Host-agent systemd/Windows installers live under `agent/` and are owned by that component. Installing or enrolling a real host requires its actual configuration/grants. Do not mount host execution sockets into API/worker/project containers.

## Stop, restart, rebuild, upgrade

Use `docker compose ... stop` for graceful shutdown and `start` to restart existing containers. `up -d --build api proxy` replaces application containers while retaining persistent mounts. Do not delete data directories or use volume-removal commands. Container restart/replacement is separate from project environment lifecycle on execution hosts.

Before upgrades: stop new submissions, drain/reconcile operations and writers, take a sealed backup, record exact old image IDs and schema version, apply reviewed migrations, then replace compatible services. Validate readyz and a bounded disposable-host smoke test. Rollback across an incompatible migration requires the documented isolated restore path, never blind old-code startup against a new schema. Retention cleanup must be reference-aware; manual blob pruning is unsupported.

For an older deployment that lacks the role split, stop its application services and run `sudo python3 deploy/prepare-upgrade.py --root /srv/homelab-control`. This prepares new protected role files without changing the runtime URL or master key. Build the new image, run `provision`, then `migrate`; after both succeed run the same helper with `--activate`, then recreate API/worker. A checksum mismatch stops migration: preserve the ledger and resolve it with a new reviewed forward migration. Never rewrite stored checksums to bypass the refusal.

## Encrypted backup worker

Initialize trust with `sudo python3 deploy/provision-trust.py --root /srv/homelab-control --agent-hostname dashboard.internal.example` before using `compose.agent.yml` and `compose.backup.yml`. The backup worker target includes digest-pinned PostgreSQL17.11 `pg_dump`, Python3.12.13 and restic0.18.1; it runs as UID10001 and inherits no PostgreSQL data volume. Apply the backup overlay to API and worker. Its protected destination JSON maps a browser-visible reference to fixed repository/password/staging/key/CA paths; browser requests cannot supply paths, shell commands, or repository credentials.

The generated local destination deliberately declares `separate_device=false`. Set the explicit `BACKUP_REPOSITORY_DIR` to an operator-controlled repository mount, configure its trust/credentials and independently escrow its password before initializing it. Record and verify the separate-device property before attesting `separate_device=true`; a local test directory does not prove it. Initialize the selected empty repository with the fixed restic executable, using the protected file, for example:

```sh
docker compose --env-file /srv/homelab-control/compose.env -f deploy/compose.yml -f deploy/compose.backup.yml --profile execution run --rm --no-deps -e RESTIC_REPOSITORY=/backup/repository -e RESTIC_PASSWORD_FILE=/run/secrets/backup_repository_password worker restic init
```

The key capture uses individual application/trust secret mounts. PostgreSQL admin/migration credentials and the repository password are excluded from this worker's key tree; they require independent protected escrow. The job enters a lease-fenced maintenance cut, captures fixed components, seals and fully reads the repository before publishing history. Offline/uncovered hosts, uncontrolled writers or same-device status yield `incomplete` without replacing the last complete record. Each reclaimed lease uses a new attempt directory and cut. Cancellation terminates the tool process group and releases maintenance only under the current lease fence.
