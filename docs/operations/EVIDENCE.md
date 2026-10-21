# Local deployment and backup checks

Current resumed evidence is in [WAVE3_EVIDENCE.md](WAVE3_EVIDENCE.md). The initial environment limitations below are historical; the existing WSL engine later supplied real builds, runtime, encrypted recovery and HTTPS evidence.

**Pause checkpoint:** Later WSL Docker, encrypted full-set recovery and fenced ownership evidence is recorded in [PAUSE_HANDOFF.md](PAUSE_HANDOFF.md). That later evidence supersedes initial NOT RUN statements below where explicitly identified. Full cross-host/live acceptance remains incomplete.

Implementation environment: Windows amd64, PowerShell, Python 3.12.10, Node 22.12.0 host runtime, Docker CLI 27.3.1, Compose `v2.29.7-desktop.1`. Linux container build targets pinned Node 24.22.0; that image has not been run here. Date: October 20, 2026 local time.

## Verified component checks

Commands executed from the repository root:

```text
python -m unittest discover -s deploy/tests -v
python -m py_compile deploy/backup.py deploy/restore.py deploy/database.py deploy/configure.py
docker compose --env-file .env.example -f deploy/compose.yml config --quiet
docker compose --env-file .env.example -f deploy/compose.yml -f deploy/compose.dev.yml config --quiet
docker compose --env-file .env.example -f deploy/compose.yml -f deploy/compose.restore.yml config --quiet
docker compose -f deploy/compose.demo.yml config --quiet
```

Five Python checks cover: a live WAL-backed SQLite snapshot including committed operation data; an unavailable required project reporting INCOMPLETE; corruption detection by SHA-256; rejection of archive traversal; binary/dotfile roundtrip; and authoritative inventory detecting an omitted remote workspace/host ledger. (Some checks cover more than one assertion.) They use disposable local files, not enrolled hosts. Compose production, development, restore, and static-demo configurations parse successfully; restore overlay removes worker/API egress. Registry digest metadata was fetched from Docker's official registry. No secret values were logged.

## Blocked / not run

`docker version` returned a client but failed connecting to `//./pipe/dockerDesktopLinuxEngine`: the pipe did not exist. Therefore image build/pull, containerized PostgreSQL migration/dump/restore execution, running container healthchecks, proxy/TLS behavior, fresh Linux installation, and container replacement are NOT RUN. No Docker service was started, engine enabled or live host enrolled. Native PostgreSQL component evidence follows below; broader local HTTP/browser evidence is maintained by validation.

## Native PostgreSQL component drill

Validation supplied a disposable loopback PostgreSQL **18.4** cluster with native binaries in `C:\Program Files\PostgreSQL\18\bin`. Operations created its own separate database, applied the tracked baseline with `psql`, and seeded synthetic owner/machine/queued-job/completed-operation rows. This never touched the browser-validation database or a homelab machine. The source intentionally had `runtime_control.dispatch_enabled=true` with no API/worker attached.

`deploy/database-native.py` executed real native `pg_dump -Fc --no-owner --no-acl` and `pg_restore --no-owner --no-acl --exit-on-error` into a newly created `homelab_restore_ops_*` database, then applied the restore fence. Result:

```json
{"dispatch_enabled":false,"restore_mode":true,"epoch_rotated":true,"restored_rows":{"users":1,"machines":1,"jobs":1,"operations":1},"historical_jobs_matching_new_epoch":0,"historical_queued_jobs_retained":1}
```

No API/worker started against the restored DB; this proves metadata preservation and the SQL epoch fence, not a complete worker/host no-replay scenario. The script accepts only loopback connections, reads connection material from a protected JSON file, refuses existing target database names and prints no URL/password. An initial test captured empty administrative `postgres`; restore correctly failed when the required runtime fence table was absent. A separately migrated/seeded source passed. All created `homelab_restore_source_*` / `homelab_restore_ops_*` databases were disposable and their lifecycle was handed back to validation's cluster owner. The metadata dump remained in a protected OS temporary directory, outside the Docker build context.

The tested **18.4 native** version is distinct from the **17.11 container pin**; this component drill does not establish that the container image builds/starts or that cross-major restoration works. Production Compose capture uses the client shipped with its matching image. Native CLI usage for a designated disposable cluster:

```text
python deploy/database-native.py --pg-bin ABSOLUTE_PG_BIN --connection-file PROTECTED_LOCAL_JSON capture --dump NEW_DUMP_PATH
python deploy/database-native.py --pg-bin ABSOLUTE_PG_BIN --connection-file PROTECTED_LOCAL_JSON restore --dump NEW_DUMP_PATH --target-database homelab_restore_NEW_UNIQUE_NAME
```

Native restic is unavailable/unconfigured; encrypted separate-device sealing and repository checks are NOT RUN. No real Linux/Windows project exports, protected key escrow, SSH/desktop endpoint, model provider, or configured test-host grants were supplied. Full T22/T23, R16, credentials-use recovery, no-replay reconciliation, RPO and RTO evidence remain BLOCKED. Static demo is an explicitly isolated illustration, not an interactive seeded application/database or live acceptance proof.

## Next specific gates

1. On an owner-designated disposable Linux host with Docker, build pins/lockfile and execute fresh install, DB migration, readyz, TLS and restart checks; record image IDs and schema version.
2. Configure actual Windows/Linux test roots, host journals/spools and key escrow. Capture a complete set and a second set with one required host offline; confirm the latter cannot be labeled complete.
3. Seal to the owner's encrypted separate-device destination. Restore into a newly generated isolated drill root and empty DB; prove hashes/counts/key recovery, disabled dispatch/new epoch, retained locks/no historical replay, and one new harmless job only after host reconciliation.
4. Record exact host/provider versions and sanitized evidence in the acceptance matrix. Component checks above do not pass those release gates.
