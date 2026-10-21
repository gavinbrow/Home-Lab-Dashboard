# Retained local acceptance fixtures

These are allocated WSL Ubuntu fixtures, not live homelab deployments. Root coordination requested idle services be stopped after their checks. No database, volume, backup, key, manifest or evidence directory was deleted. No Docker prune, `down -v` or rejected deletion retry occurred. All protected roots may contain credentials; never print or commit their contents.

| Scope | Retained root | Current checkpoint |
|---|---|---|
| Signed backup capture/API history | `/tmp/homelab-backup-wave3` | API3011/TLS3451, worker and PostgreSQL stopped; browser3017 oneoff stopped; source helper8 pair stopped |
| Canonical repaired-helper restore | `/tmp/homelab-restore-wave3-callback8` | API3015/TLS3455, worker, fixed proxy and PostgreSQL stopped; cloned helper9b pair stopped |
| Earlier restore evidence | `/tmp/homelab-restore-wave3` | API3013/TLS3453, fixed proxy and PostgreSQL stopped; original restore fence retained |
| Final018 production HTTPS upgrade | `/tmp/homelab-https-wave3` | API/proxy4449/PostgreSQL stopped; owner, CA and schema18 retained |
| Explicit static demo | Compose project `homelab-demo-ops-wave3` | Demo8088 stopped; no API/database/host configuration |
| Guacamole listener fixtures | `/tmp/homelab-ops-wave2` | Packaged-image check passed; Guacamole, guacd, VNC and PostgreSQL stopped; keys/data retained |
| Shared validation APIs | `/tmp/homelab-validation-wave2` | HTTP3009/TLS3449 and isolated HTTP3019/TLS3459, PostgreSQL and loopback15439 proxy stopped after final consumer END; keys/data preserved |
| Tiny snapshot-retirement rehearsal | `/tmp/homelab-retention-drill-ljpei2k8` | Files/repository/receipt retained; no daemon |

Before shutdown the four stopped database fixtures had zero accepted current-epoch jobs, uncertain physical operations, writer locks, pending current-epoch relay requests or maintenance cuts. Deliberate historical jobs on old epochs remain preserved. The host owner separately confirmed no pending outbox/physical operation before stopping its exact process pairs. Frontend consumers had closed their tabs and Vite process. Protected check results remain in `/tmp/homelab-ops-wave3-shutdown-check.json`.

The remote owner confirmed its final packaged-image driver exited successfully and no desktop consumer remained. The Guacamole fixture database had zero leased jobs and no operation rows before its four services stopped. Its strict test log remains `/tmp/homelab-remote-wave2/guacamole-packaged-check.log`; the image contains the source-built listener JAR. The final shared validation and provider bookings ended after the successful 4B acceptance, retained artifact downloads and audited phantom-history recovery. Their exact services were stopped as recorded below.

## Inspect a retained fixture

Final coordinated shutdown completed on 2026-10-21 at 07:24:52 UTC after frontend, validation, provider, storage and platform consumer END. Docker inspection confirmed these exact containers exited; no container or volume was removed:

| Container | ID prefix | Preserved scope |
|---|---|---|
| `homelab-validation-wave2-api-1` | `6a942e1657e5` | Final API image and shared keys/artifacts |
| `homelab-validation-wave3-isolated-api` | `1b9197b21677` | Final isolated API and acceptance histories |
| `homelab-validation-wave3-pgproxy` | `039918c686e8` | Loopback15439 proxy configuration |
| `homelab-validation-wave2-postgres-1` | `97989b381218` | `/tmp/homelab-validation-wave2/data/postgres` |
| `homelab-provider-wave2` | `f12b51a20dd1` | Named model volume `homelab-provider-wave2` |
| `homelab-env-ead6b4d3-527f-4ff7-97e9-bd7e8bd947ed` | `24d4bb7741ef` | Successful third T13 project and artifact evidence |

The audit container `c44d4b175c74` remains `created`, never started. Unknown lifecycle runtime IDs beginning `6cb` and `58c8`, their roots and reservations remain entirely untouched. The unrelated `hyperqwen_qwen-cache` volume is untouched. No global container stop, prune, deletion, history rewrite or replay occurred. Validation separately stopped its exact workers/Go processes/base and native PostgreSQL fixture; operations did not broaden cleanup to other environment containers.

Use the existing engine without resetting Docker/WSL:

```powershell
wsl -d Ubuntu --exec /bin/bash --noprofile --norc
```

Start only the explicitly selected database first, for example:

```sh
docker start homelab-restore-wave3-callback8-postgres-1
docker exec homelab-restore-wave3-callback8-postgres-1 psql -X -U postgres -d homelab -v ON_ERROR_STOP=1 -c 'UPDATE runtime_control SET dispatch_enabled=false,restore_mode=true WHERE singleton;'
docker start homelab-restore-wave3-callback8-api-1 homelab-restore-wave3-callback8-proxy
```

This starts read inspection with an independent database restore fence. The successful new-export fixture had deliberately enabled new jobs before shutdown; do not infer a safe dispatch setting merely from its project name. Keep its worker and host processes stopped. Read histories/artifacts using the protected fixture owner login. For another fixture, substitute only its exact owned container names after checking labels and consumer bookings.

To stop that inspection, stop API/proxy first and PostgreSQL last. Replacing containers requires the preserved Compose root, exact image versions and overlays; follow the deployment/recovery runbooks rather than reconstructing secrets. A restore root's worker/host may start only after explicit trust, epoch, generation, binding and unknown-operation reconciliation. Never bulk-replay historical jobs or rerun a completed acceptance command to obtain another result.

The helper8 source and helper9b clone configurations/process manifests remain under their protected roots. Their prior journals and recovered WAL evidence remain intact. Restoring the same host bundle again requires a new empty output; it must not overwrite the evidence or the stopped clone.
