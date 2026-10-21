# Backup and isolated restoration

Work resumed after the historical pause. Actual signed full Linux host capture, repeated SQLite/WAL continuity, encrypted restic restoration, original credential decryption, retained artifact verification, offline root/trust reconciliation and a NEW durable restored project export passed in allocated fixtures. Exact images, schema16 scope, captured file hashes and historical-delivery fences are in [RESTORE_CALLBACK8_EVIDENCE.json](RESTORE_CALLBACK8_EVIDENCE.json). The final schema18 HTTPS upgrade has separate evidence. The repository remains on the same device, so overall backup coverage remains incomplete; no live homelab or separate-device recovery acceptance is claimed. RPO24h/RTO4h remain unmeasured operational targets.

## Coverage and consistency

The backup is a set: consistent PostgreSQL archive; retained artifacts/checkpoint bytes; each registered workspace's actual files; every host supervisor's SQLite journal and associated spool/identity/configuration; control-plane credentials/master/CA recovery material; and software/configuration metadata. A central artifact copy does not cover mutable remote projects. PostgreSQL's data directory must not be copied live as a substitute for `pg_dump`.

The tool compares required workspace and host-ledger IDs with an authoritative database inventory. This conservative baseline requires a ledger for every registered machine; document unsupported/non-runner machines rather than omitting them. Native NTFS ACLs, junctions, special files, database files inside projects, open external application files and arbitrary remote storage are **not automatically covered** by the portable tar adapter. Obtain a native consistent export plus restore evidence, or mark coverage incomplete. An offline host always produces INCOMPLETE, not global success.

`STAGED` means all declared and database-reconciled items were captured with consistency evidence. `SEALED` means the set was successfully written into an encrypted restic repository and a full read check succeeded. Neither means the release restore test passed. `INCOMPLETE` returns exit code 2; operational failures return 1. Never replace a last-complete pointer with an incomplete set. There is intentionally no automatic last-complete pointer before a completed restore drill.

## Capture

Use a dedicated maintenance window. Block new mutations, flush host receipts/spools, complete checkpoints, and drain or reconcile all unresolved operations while preserving writer locks. Stop API, worker, proxy and all ancillary services; keep only PostgreSQL running. Stopping the API does not stop already accepted host processes or unrelated desktop applications. Confirm those writers are quiescent independently.

```sh
docker compose --env-file /srv/homelab-control/compose.env -f deploy/compose.yml stop api worker proxy
python3 deploy/database.py --env-file /srv/homelab-control/compose.env --project homelab-control capture --output /protected/capture/NEW_SET
```

`database.py` checks that only PostgreSQL is running, refuses unresolved operations, makes a custom-format archive, and exports registered workspace/host/dispatch inventory. It does not stop/restart services itself. Database and file captures remain in one quiesced window. Existing roles are recreated by the deployment bootstrap; dumps use `--no-owner --no-acl`. Custom roles/tablespaces/external settings require separate protected exports and coverage entries.

On each actual host, capture SQLite with its online backup API while retaining its WAL semantics:

```sh
python3 deploy/backup.py sqlite /actual/protected/ledger.sqlite /new/protected/export/ledger.sqlite
```

The command refuses an existing destination and runs `PRAGMA integrity_check`. It captures a consistent SQLite snapshot; that alone does not flush separate log files or coordinate a workspace cut. Quiesce local writers and capture the supervisor spool, identity, configuration and actual project roots with a platform-aware adapter. Securely stage those exports and record host/boot/environment IDs, checkpoint/revision, capture timestamps and consistency evidence. An SSH file copy of only a live `.db` is unsupported.

Copy `deploy/backup-inventory.example.json` outside the repository and replace every placeholder. Set `database_inventory_file` to the just-exported JSON. Required control-plane component kinds are `postgres`, `artifacts`, `keys`, and `ca` (the persisted Caddy CA directory). Add a `project` component with `workspace_id` for every workspace and a `sqlite` component with `machine_id` for every registered host. Add separate spool/configuration and native export components as needed. Set `consistent=true` only after actual quiescence/export evidence. Reference evidence paths, software/schema versions and key-recovery evidence without plaintext secrets. Keep unknown/offline entries required and let them fail explicitly.

```sh
python3 deploy/backup.py stage --inventory /protected/backup-inventory.json --output /protected/staging/NEW_BACKUP_SET
python3 deploy/backup.py verify /protected/staging/NEW_BACKUP_SET
```

Staging contains **unencrypted sensitive bytes**, including keys; keep it on a protected encrypted filesystem. Tar captures refuse symlinks/junctions/special files rather than silently omit bytes or cross roots. No native Windows ACL completeness claim is made. The operator must map native exports and separately restore their ownership/ACLs.

Use reviewed restic **0.18.1**, verify its signed/checksummed upstream release, provision an encrypted repository on another device, and keep its password file outside both repository and staging. Initialize that repository explicitly (`restic init`) using the same protected environment. Then:

```sh
export RESTIC_REPOSITORY=/separate-device/homelab-backup
export RESTIC_PASSWORD_FILE=/protected/offline-recovery/restic-password
python3 deploy/backup.py seal /protected/staging/NEW_BACKUP_SET
```

`seal` pins the restic version, writes the set with its ID as a tag, and executes `restic check --read-data`. Preserve returned snapshot ID and set manifest hash in a protected backup register. Capture full data checks on a suitable maintenance schedule; no schedule is created by this repository. Resume application services only after the cut/result is recorded and host state is reconciled. No script wipes the plaintext staging copy; retire it according to the owner's protected-storage procedure.

## Restore without dispatch

Use a separate isolated machine/VM/network for a full drill. It must not route to production provider/SSH/RDP/agent endpoints. A different Compose project name is not network isolation. The restore tooling starts **no application or worker process** and refuses overwrite of existing databases/directories.

1. With separately held restic recovery material, run `restic check --read-data`, inspect snapshots and restore the exact tagged snapshot into a new protected directory using `restic restore SNAPSHOT_ID --target NEW_DIRECTORY`. Locate the restored backup-set directory; do not restore directly over production.
2. Verify/extract: `python3 deploy/restore.py /restored/NEW_BACKUP_SET --output /protected/NEW_EXTRACTED`. Hash mismatch fails. An incomplete set remains incomplete with exit 2. No restored credential is used automatically.
3. Generate a new root: `sudo python3 deploy/configure.py --restore-drill --root /srv/NEW-drill --hostname restore.localhost`. This writes `RESTORE_MODE=true`, new DB passwords, and a drill marker. Preserve the new marker and env mapping.
4. Start only the new database: `docker compose --env-file /srv/NEW-drill/compose.env -p homelab-restore-drill1 -f deploy/compose.yml up -d --wait postgres`.
5. Restore and fence: `python3 deploy/database.py --env-file /srv/NEW-drill/compose.env --project homelab-restore-drill1 restore --isolated-drill --dump /protected/NEW_EXTRACTED/database.bin`. The database component ID determines the filename. The CLI requires an empty schema, a newly generated isolated root/marker and stopped application services. Before any recovered API starts, both Docker and native restore callers apply `deploy/restore-fence.sql` atomically: dispatch is disabled, restore mode is enabled, the epoch rotates, and queued/leased relay requests become outcome-unknown. Recovered browser and remote sessions are revoked, terminal tickets consumed, active terminal clients detached and transient terminal payloads scrubbed. Terminal request/response hashes and signatures are also replaced with ID-only tombstones because short-input fingerprints can disclose keystrokes. Terminal processes retain an unknown outcome; physical operations, writer locks and delivery IDs/statuses are preserved. Sign in again after restore; a pre-backup cookie must be denied even when it was revoked only after the snapshot.
6. Run the new root's `provision` service after the restore to assign the restored public objects to its migration role and grant application DML, then `migrate` using the separate migration secret. Restore extracted artifact bytes to the empty artifact directory and reapply UID/GID10001. Recover the original master key into the new `runtime.env`; preserve the **new** database URL/password and remove bootstrap tokens. Recover dispatch key ID, signing/CA/TLS keys and matching Guacamole API/gateway secret with restrictive ownership. Verify credential decryption through the application before counting key recovery as passed.
7. Restore each project's native files/ACLs/spool/identity to designated disposable hosts with explicit mappings and hashes. Keep all historical queued/running/waiting/outcome-unknown jobs blocked for reconciliation. An epoch change fences new work; it does not terminate an already running original process.
8. Use Compose >=2.24.4 and apply `-f deploy/compose.yml -f deploy/compose.restore.yml` when starting the restored API. The restore overlay removes the API/worker outbound network, forces restore mode and disables dispatch. On the separate isolated network, start only API/proxy to inspect histories/conversations/artifacts/checkpoints. Confirm no worker/dispatch is enabled. Record baseline/restored counts and file hashes, credential use, one selected-file checkpoint restoration and retained artifact download.
9. Reconnect one designated disposable host through the actual authenticated transport. Reconcile boot ID, environment generation, operation IDs/receipts, process containment and log cursors. Preserve unresolved locks and unknown outcomes. Retest SSH and desktop separately. Only after this report and owner acceptance of unresolved gaps may the platform's execution gate be enabled for **new** harmless jobs; do not bulk-replay old queue rows.

Record set/snapshot IDs, source age, start/end times, measured duration, image/schema versions, full coverage, key recovery outcome, epoch before/after, reconciliation proof, one new job's one-launch evidence and remaining gaps. T22 stays NOT RUN/BLOCKED until this actual end-to-end record exists.

## Credential rotation and account recovery

Loss of the master key makes encrypted credentials unrecoverable even if PostgreSQL is intact. Escrow the key and restic password separately, rehearse access, and retain key versions required by stored ciphertext. Database password rotation must update the persisted role and protected application URL together during a maintenance window. Master-key rotation requires a supported rewrapping migration; changing the environment alone is not rotation. Agent identity/certificate rotation and revocation require the host component's documented procedure and retesting of affected capabilities.

The local owner credential-recovery CLI is `npm run auth:recover`. It requires `RECOVERY_EMAIL` and a new `RECOVERY_PASSWORD` of at least 16 characters, replaces that owner's hash, revokes all existing sessions and records an audit event. It has no public HTTP endpoint and does not reopen bootstrap. Run only as the authorized local administrator. In Bash, collect the secret interactively to keep it out of command history:

```sh
read -r -p 'Owner email: ' RECOVERY_EMAIL
read -r -s -p 'New password (16+ characters): ' RECOVERY_PASSWORD
export RECOVERY_EMAIL RECOVERY_PASSWORD
docker compose --env-file /srv/homelab-control/compose.env -f deploy/compose.yml exec -T -e RECOVERY_EMAIL -e RECOVERY_PASSWORD api /app/deploy/entrypoint.sh npm run auth:recover
unset RECOVERY_EMAIL RECOVERY_PASSWORD
```

The entrypoint reloads the protected database URL for the recovery subprocess; Docker exec alone does not inherit secrets exported by another process. Do not put a password literal after `-e` or in a shell command. After recovery, sign in again and verify the old session is denied.
