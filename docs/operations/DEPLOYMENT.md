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

Install Docker Desktop for Windows with Linux containers enabled, then double-click the repository's **start.bat**. No manually configured WSL distribution, Linux root directory, host Node/npm, Python or Go is required. Docker Desktop may itself use its WSL2 backend; the launcher calls the Windows Docker CLI directly through its desktop-linux context and never runs commands inside a user Linux distribution. If the engine is stopped, the launcher opens Docker Desktop and waits up to three minutes; complete Docker Desktop's initial setup if required.

The first launch builds the pinned API, worker and web proxy images, generates cryptographic credentials and a master key inside protected project-specific Linux named volumes, starts PostgreSQL, provisions distinct database roles, applies migrations, and starts the live API/worker/HTTPS proxy. This can take several minutes and requires access to the image/package registries. Only the proxy is published, at **https://localhost:8443** on loopback; the database, Docker socket and agent/desktop transports are not exposed. Dispatch remains disabled in both the application environment and the initial database. The dashboard runs in production mode with secure cookies; there is no demo substitution, default owner account or authentication bypass.

The launcher verifies the exact project-owned proxy and CA volume, exports only the generated public CA certificate, and imports that exact CA into the current Windows user's Trusted Root store. The CA thumbprint and named-volume identity are pinned in local launcher metadata; an unexpected change stops startup. HTTPS certificate validation remains enabled. After container health and end-to-end trusted HTTPS readiness pass, the browser opens. The console stays open and, until the first owner is configured, displays the private setup token locally. Choose **First time? Set up owner** in the dashboard, enter your own email, a password of at least 12 characters and that token. Never share the token or save console output to a log. Existing owner setup disables further bootstrap; later launches show the normal login.

Persistent PostgreSQL data, artifacts, CA state and separate runtime/migrator/provisioning/PostgreSQL secret volumes belong to Compose project **homelab-desktop**. Runtime containers receive only the DML/master-key secret volume; administrator and migration credentials are isolated. Non-secret launcher settings and the public CA copy live under **%LOCALAPPDATA%\HomelabControl\homelab-desktop**. Nothing generated is stored in the checkout. Back up the database, required secret volumes, artifact volume and CA state together using the recovery procedures; losing the master key cannot be repaired by regenerating it.

Later double-clicks preserve those volumes, credentials, owner, database epoch and dispatch fences. An interrupted first image build or database setup can be retried: saved credentials are reused and successful provisioning/migration is marked before normal startup. A database/artifact/CA volume without its original configuration state is refused rather than assigned new secrets. No containers or volumes are deleted. Existing images are reused. Startup runs the installed image's checksum/advisory-lock-protected migrator idempotently on each launch; provisioning is first-run only. If a persistent installation has missing images, startup refuses to rebuild it while an old worker or operation might still be active. Restore the original images, or follow the reviewed stop/drain/backup/upgrade procedure separately before deliberately building a new version. Routine startup does not perform an automatic code upgrade.

If port8443 is occupied, the launcher refuses the collision without stopping anything. Choose another port/project on its first run from Windows Command Prompt:

```bat
start.bat -Project my-dashboard -Port 8444
```

The selected port is remembered; a later conflicting port argument is refused. HOMELAB_COMPOSE_PROJECT can select an existing project. Closing the launcher console leaves containers running. To stop only this installation without deleting its data:

```bat
docker --context desktop-linux compose -p homelab-desktop -f deploy/compose.windows.yml stop
```

Compose requires the launcher's non-secret interpolation values even for this explicit command: set HOMELAB_DESKTOP_IMAGE=homelab-desktop-homelab-desktop and HOMELAB_DESKTOP_PORT=8443 in that Command Prompt first (use your project's values if customized). Never use down -v or volume pruning as routine shutdown.

For a configuration-only check, run powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy\start-windows.ps1 -Check. This checks Windows launcher/Compose configuration without starting services; it is not an end-to-end readiness proof. The -NoBrowser and -NoToken options support independent tests without opening tabs or recording bootstrap credentials. The separately documented Linux deployment above remains available for dedicated control-plane hosts; this Windows launcher does not operate on its roots or the acceptance fixtures.

### Startup verification scope

The revised container setup was exercised with fresh isolated project volumes on the available Ubuntu Docker test engine: real initialization, restricted roles, migrations, trusted HTTPS, owner creation/login, and a second launch preserving database/owner/session, master key, encrypted secrets, artifacts and CA. Foreign-volume refusal and missing-configuration/existing-data refusal were also checked against actual isolated volumes. This engine was used only for component validation; the Windows launcher contains no Ubuntu/WSL fallback.

The actual Windows batch entry point was also exercised. Docker Desktop's local Linux backend remained unavailable because of its backend networking/proxy failure, so the launcher correctly attempted startup, waited its bounded three minutes and exited with an explicit error. **Full Windows Docker Desktop first-launch and second-launch end-to-end verification remains blocked on that machine.** Configuration-only checks or the separate passing Linux-container tests are not a Windows end-to-end pass.

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
