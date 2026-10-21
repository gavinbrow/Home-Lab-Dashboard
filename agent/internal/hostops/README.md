# Protected host file and lifecycle operations

`Manager.New` binds exact administrator-configured roots to already opened `files.Root` handles. Root IDs cannot be supplied as arbitrary paths through an RPC. Duplicate, overlapping, noncanonical, UNC, and recovery-inside-project bindings fail closed. `DataDir` and its parents must be inaccessible to execution identities; Windows requires an actual protected ACL, not just Go file-mode bits.

Register this manager only behind the agent's authenticated, signed transport. Its guard must be `Service.WithWorkspaceMutation`, which shares the command supervisor mutex and rejects unresolved command reservations. `Service.ExternalWorkspaceBusy` must call `Manager.WorkspaceBusy` so received or unknown file operations also block new command dispatch. The ordinary `WithWorkspaceWrite` guard would count a mutation's own received record and is therefore not the manager guard.

Mutations persist an intent before effects and never automatically replay a received/unknown intent. Repeating an operation ID with the same canonical logical request returns its receipt. Different input produces an identity conflict. `effects_started:false` is supplied only for a proven preflight content/revision conflict; a later restore/delete conflict becomes `outcome_unknown`. Failed receipt persistence poisons future workspace writers. Every operation scope is checked when querying a receipt.

| Route | Purpose |
| --- | --- |
| GET `/v1/workspaces` and GET `/:id/binding` | Enumerate configured exact bindings |
| PUT `/v1/workspaces/:id/binding` | Persist an expected-revision archive/unregister/reactivate transition |
| PUT `/v1/workspaces/:id/files` | Bounded content-hash save with cumulative quota |
| POST `/:id/directories` and POST `/:id/files/rename` | Create one directory; move a regular file without overwriting the destination |
| DELETE `/:id/files` | Quarantine a hash-matched regular file into protected host storage |
| GET `/:id/quarantine` and POST `/:id/quarantine/:qid/restore` | List recovery records; restore without overwriting newer content |
| POST `/:id/restore` | Manifest CAS, persisted precheckpoint, bounded reviewed writes/deletes |
| DELETE `/:id/data` | Separate exact-root ownership grant; recoverable deletion and host-owned archive revision |
| GET `/:id/file-operations/:operation` | Reconcile a durable mutation receipt |
| POST `/:id/environment/restart,rebuild,remove` | Dedicated owned Linux Docker environment lifecycle |
| GET `/v1/targets`, POST `/:id/actions`, GET `/:id/actions/:operation` | Fixed configured service/container helpers and durable receipts |
| POST `/:id/actions/:operation/cancel` | Return the known outcome; never claim an already applied action was undone |
| POST `/v1/backup` | Capture one configured workspace with honest consistency metadata |

All `/:id` abbreviations in the file rows are under `/v1/workspaces`; helper rows are under `/v1/targets`. File mutations carry `operation_id`. File saves and deletions carry a content hash; restore carries the expected manifest hash and explicit bytes/deletions. Directory/file type replacement requires an explicit delete of the replacement path and every existing directory descendant. Symlinks, Windows reparse points, ADS, special files, and unsupported file kinds cannot be restored. Captures enumerate ordinary dotfiles, untracked files, and binary bytes with explicit exclusions. Snapshots are `best_effort`: the broker lock does not freeze unrelated native editors.

Environment configuration contains a pinned image digest, nonroot UID/GID, CPU/memory/PID limits, explicit fixed command, separate grants, and the persistent root. Rebuild checks the old machine/workspace labels, captures its immutable Docker ID, recreates with no privileges/capabilities/socket/network and the same bind root, and persists a new environment UUID, generation, revision, and actual Docker ID. Runtime removal never uses Docker volume deletion. A crashed or failed lifecycle requires reconciliation. The parent callback updates supervisor configuration while its writer guard remains held.

Helper requests carry the captured grant, local policy revision, job ID, monotonic fence, dispatch epoch, machine/target identity, canonical logical request hash, and bounded log limit. The host allowlist supplies the actual service or immutable container identity. No caller supplies shell text or arbitrary helper arguments. Status reports observed `running`, `stopped`, or `unknown`. SCM/systemd controls and bounded journal/Event Log queries use fixed argv. Real Windows account/ACL and configured-service tests remain deployment acceptance work.

## Verification

Windows `go test ./...` passes. Recovery tests cover binary quarantine outside the project, refusal to overwrite external edits, cumulative quota, CAS before precheckpoint, no publication on failed checkpoint, partial-outcome classification, and explicit file/directory replacement. Manager tests cover durable no-replay receipts, conflicting operation IDs, unresolved writer reservations, receipt scope, stable file-save receipts, stale job fences, and injection-resistant service names.

The opt-in Linux test `TestDisposableDockerLifecycle` was crosscompiled and executed in WSL Ubuntu with Docker 29.7.2 and an explicitly pinned Node 24 image. It created only generated disposable names, verified restart/rebuild/remove, advanced environment identity/generation/revision, and verified HTTP helper restart/status plus a rejected stale fence. The binary sentinel SHA-256 was `8b328551c4e43b3c8440278df42640f176d1d113ea6ca277c6df47bc6979543c` before/after runtime replacement/removal. The latest run persisted actual replacement ID `43d16e434938479179c92c409f9d59250ec7a8b4ec1b59ebb13243bee4a9dbcb` and passed in 27.82 seconds. All test-owned runtime names/IDs were cleaned without touching unrelated containers or deleting a volume. Set `HLD_HOSTOPS_DOCKER_IMAGE` to an approved locally available digest to opt in; otherwise the test skips.

Live SQLite journal backup is owned by `supervisor.Journal` and must use its consistent export API, never copy a live `.db` file directly. Project snapshots alone are not proof that settings, secrets, history, or external editors were quiesced.

For the agent's live Linux SQLite database, even a raw descriptor opened only for metadata or header detection must not be closed: POSIX advisory locks belong to the process, and closing another descriptor for the same inode can release the owning SQLite connection's locks. The backup owner must use the existing owning database's snapshot callback before any raw file probe. `files.CaptureProtectedPathNativeMetadataNoOpen` captures fixed administrator-protected paths with `Lstat` and bounded named extended-attribute syscalls, without opening or closing that inode. It rejects noncanonical paths, symlinks and changed object identity. No project RPC accepts a path for this helper; project capture continues to use rooted pinned handles.

The Linux `TestProtectedNoOpenMetadataPreservesPOSIXLocks` regression holds a write lock, captures metadata, and invokes a separate process to prove the lock still blocks a competing lock. It passed in WSL alongside the owner/mode/xattr restore tests. This helper-level proof is separate from the backup owner's external SQLite reader continuity test. Native metadata records explicit unsupported fields, including Linux birth time/inode flags and Windows SACL, extended attributes, and compression/encryption/sparse storage attributes.

## Explicit recovery and journal export

`POST /v1/workspaces/:id/file-operations/:operation/reconcile` accepts only `resolution: "accept_partial"`, an exact current manifest hash, a meaningful review reason, and a separate protected `RecoveryGrantID` with the current local policy revision. It cannot adjudicate environment, binding, root deletion, or admin helper operations. The same supervisor guard rejects unresolved commands. The original receipt remains immutable; an append-only resolution record records the observed manifest and review. Receipt queries then report a known failed partial outcome, and only that file reservation is released. This acknowledges the reviewed current state without rolling back or replaying a side effect. Agent model tools do not expose this action.

`POST /v1/journal/backup` uses the supervisor's global quiescence callback and SQLite `VACUUM INTO` with a host-generated protected destination. Export bytes are limited to 32 MiB for the bounded signed frame. Larger journals return an explicit chunk-transport requirement. The export payload is not embedded in the live journal, so backups cannot recursively inflate later backups. Coverage is explicitly incomplete: project/quarantine/precheckpoint bytes, agent configuration, enrollment key, RPC spool, and execution credentials require separate protected backup coverage.

Regression tests prove that reconciliation rejects an ordinary grant, a stale manifest, and an unresolved command; retains the original unknown receipt; prevents replay; and releases only the reviewed file reservation. A real WAL SQLite export test verifies a committed row in the restored database, `quick_check=ok`, byte hashes, excluded coverage, and refusal to export over an unresolved file operation.
