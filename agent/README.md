# Host agent and independent supervisor

This is a separate Go module. `homelab-agent collect` reads the local host once;
`agent` sends samples only to an explicitly configured HTTPS endpoint using
mutually authenticated TLS; `supervisor` runs the durable local execution/file
service independently of that connection process. `enroll` generates a local
ECDSA key/CSR; `connect` runs the authenticated outbound telemetry/command relay.
The dedicated control-plane TLS listener verifies machine certificates and
revocation; the supervisor separately verifies Ed25519 command signatures and
dispatch epochs. A local supervisor endpoint is **not** a public worker endpoint.
No accounts or installed system services were created during implementation.

## Build and local checks

Use Go 1.27.3. The pinned Windows bootstrap script downloads the official SDK,
checks SHA-256, and expands it under `.tools/`; it does not alter PATH or install
a service. `go.mod`/`go.sum` pin dependencies. Commands from `agent/`:

```powershell
./scripts/bootstrap-go.ps1
./.tools/go/bin/go.exe test ./...
./.tools/go/bin/go.exe vet ./...
./.tools/go/bin/go.exe build -trimpath -o bin/homelab-agent.exe ./cmd/homelab-agent
./bin/homelab-agent.exe collect --machine-id local-component-check
```

On Linux use `go test ./...` and `go build -trimpath -o bin/homelab-agent ./cmd/homelab-agent`.
`GOOS=linux GOARCH=amd64 go build ...` checks compilation only, not Linux support.
Tests use temporary directories, local HTTP test servers and a fake container
backend. The Windows symlink test skips if the account cannot create symlinks.

## Configure deliberately

Copy `supervisor.example.json` outside the project into an operator-protected
directory. Replace every placeholder. Existing project registration never deletes
or moves project data. The data directory, configuration, local token, certificates,
and journal must be outside project access. Create a cryptographically random
local token of at least 32 characters in a separate file. Restrict all these paths
to the dedicated service identity and administrators using actual OS ACLs; Windows
`0600` file modes do not configure a Windows DACL. The binary does not provision
accounts, set ACLs, alter firewalls, add Docker-group membership, or install services.

Start `homelab-agent supervisor --config /protected/supervisor.json` under that
identity. It only binds an IP-literal loopback listener. All routes, including
health, require `Authorization: Bearer <local token>`. Never reverse-proxy this
endpoint onto a public or LAN listener. Granting this token grants access to the
explicit configured roots; use an authenticated, authorized local relay, not a
browser. Enroll using a one-use token in a protected file:

```text
homelab-agent enroll --machine-id ENROLLED_UUID --endpoint https://configured-control-plane:9443/agent/v1/enroll --ca /protected/server-ca.pem --identity-dir /protected/identity --token-file /protected/enrollment-token
homelab-agent supervisor --config /protected/supervisor.json
homelab-agent connect --config /protected/connection.json
```

Copy `connection.example.json`, set explicit configured URLs/paths, and configure
the supervisor with `identity_dir`, the enrolled `dispatch_epoch`, and
`require_signed_rpc:true`. It loads the pinned dispatch public key delivered over
CA-verified bootstrap TLS. Raw bearer mutation routes are then disabled; the
connection agent can only forward signed `/v1/rpc` envelopes. Private key material
is not sent by ordinary telemetry or command relay. Explicit encrypted host-state
backup includes configured identity files under the pinned offline age recipient.
Certificate renewal uses authenticated `/agent/v1/rotate`
before expiry and atomically publishes a versioned key/certificate pair. A lost
renewal response can require explicit re-enrollment if the old certificate was
already revoked; it never downgrades authentication. Server TLS CA trust is
separate from client-certificate issuer material. TLS 1.3, trusted CA and hostname
verification are mandatory; redirects and cleartext endpoints are rejected. Failed
telemetry uploads do not become successful observations. Collection sequence is
committed to a separate FULL/WAL SQLite telemetry ledger before each transmission
and survives connection-agent restart. Missing uploads appear as sequence gaps.

## Supported behavior and enforcement

Windows and Linux collection uses gopsutil for interval CPU, physical memory,
per-volume capacity, per-disk I/O and per-interface counters/rates. Initial/reset
rates are `null` with an unavailable reason. NVIDIA collection requires an explicit
`--nvidia-smi` executable and bounded two-second query. Other GPU collectors and
selected-service checks are not yet implemented. Historical storage belongs to
the control plane. The local component check is not monitoring onboarding or
an idle/load/reference-tool accuracy acceptance test.

Native commands require explicit `native_enabled:true`, a dedicated provisioned
account, reviewed real ACLs, and the platform configuration documented in
`internal/native/README.md`. Linux uses numeric UID/GID systemd units with cgroup
containment and kernel limits. Windows uses LogonUser, actual token/SID and
privilege checks, suspended CreateProcessAsUser, and Job Objects before resume.
There is no current-user/administrator fallback. Restrictive Windows networking
and arbitrary network allowlists are rejected; Linux deny uses PrivateNetwork.
An onboarding identity probe verifies the actual account, root/scratch writes and
protected sentinel denial; proofs are scoped to the current configuration/process
and expire after five minutes. A working directory is not confinement. Linux
native denial, descendants, timeouts and the trusted identity probe have actual
local WSL evidence; credential-backed Windows launch awaits a provisioned account.

Linux container dispatch uses the configured local engine.
It requires the trusted local configuration to enable a workspace with a pinned
image digest, nonzero numeric UID:GID, canonical host directory, environment
generation, identity/grant IDs and current policy revision. Requests cannot select
their image, mounts, privileges, network, user, Docker arguments or host paths.
The process gets only `/workspace/project` plus bounded `/tmp`, read-only image,
no network, all capabilities dropped, no privilege escalation, CPU/RAM/PID limits
and a read-only mounted trusted Go helper that owns timeout and bounded output.
The default example
keeps container execution disabled. The parent of the approved bind root must be
operator-owned and unmodifiable by project code. The Docker socket is never mounted.
Docker engine configuration is host authority and must be reviewed separately.

Each operation uses a dedicated deterministic container name. Creating an operation
commits the receipt in SQLite WAL with synchronous FULL before launch. A `launching`
record precedes any Docker create/start. Restart discovers the original container;
missing/ambiguous identity becomes `outcome_unknown`, never automatic replay.
Queued receipts past their deadline never launch. A created but unstarted container
becomes interrupted. Cancellation stops the dedicated container and verifies it
stopped before reporting cancelled. Exit 124/137 can mean timeout or runtime kill;
the reason reports that uncertainty. No exactly-once side-effect guarantee is made.

An unresolved operation holds the host workspace reservation, including after a
worker lease expires. File writes share that host reservation. Host grant IDs and
policy revisions are pinned in protected local configuration; revocation requires
local configuration change/restart plus cancellation of accepted work. New central
grants cannot expand local authority. Environments here use one disposable container
per operation, rather than a long-lived shell environment; external project data
is never removed by the runner. Protected lifecycle helpers restart/rebuild/remove
only the configured environment, preserve project storage, increment generations
and revisions, and persist the binding before another operation may dispatch.

Output is bounded in memory and durable sequenced SQLite log chunks, with a visible
truncation event at the request quota. The container helper caps bytes before
daemon logging, batches binary-safe frames and emits one explicit truncation
marker. Docker retention covers the maximum encoded output and bounded frame
overhead; arbitrary tool output cannot silently rotate away before a poll.
SQLite receipt or spool write failures
stop the supervisor; it accepts no new operations afterward. Network-agent restart
does not stop containers/supervisor. Supervisor crash reconciliation is implemented
and native Linux descendant/cancellation proofs have been run on disposable WSL
fixtures. See native evidence for exact versions and limits.

Rooted file operations use Go `os.Root`, reject lexical traversal/Windows special
names/alternate streams and reject symlink/special files in reads and snapshots.
The root must not contain untrusted bind mounts or device nodes; `os.Root` does not
confine mount boundaries. Files are limited to 16 MiB, listings 1000 entries and
snapshot captures 64 MiB/10000 entries. Snapshot consistency is always `best_effort`
and exclusions are explicit. Conditional saves detect stale hashes, serialize
dashboard writes, stage and sync before rename. An external application can still
edit between the last hash check and rename; atomic CAS against external writers
is not claimed. Durable writes, rename, mkdir, quarantine/recover, manifest-based
restore, protected pre-restore checkpoints, cumulative quotas and exact-root
deletion are exposed by `internal/hostops`. Quarantine metadata/bytes live in the
protected supervisor state directory, outside project code access.

## Protocol and recovery

`internal/protocol` mirrors `packages/contracts/src/index.ts`. Request hashes exclude
`request_hash`, `fence`, `dispatch_epoch`, recursively sort object keys, serialize
compact JSON without HTML escaping (escaping U+2028/U+2029), and hash UTF-8 SHA-256.
Duplicate ID/hash returns the original receipt; changed content conflicts. Fences
increase monotonically per job, and a pinned dispatch epoch rejects restored/stale
control planes. Rotating that epoch is a deliberate configuration/recovery action.

Local routes:

* `POST /v1/operations`, `GET /v1/operations/{id}`
* `POST /v1/operations/{id}/cancel` with `fence`/`dispatch_epoch`
* `GET /v1/operations/{id}/logs?after=N` (up to 256 sequenced chunks)
* `GET /v1/workspaces/{id}/files?path=.&mode=list` / `mode=read`
* `PUT /v1/workspaces/{id}/files` with `path`, `content_base64`, `expected_sha256`
* `GET /v1/workspaces/{id}/snapshot`
* `POST /v1/rpc` / `GET /v1/rpc-receipts/{id}`
* `GET /v1/identities` / `POST /v1/identities/{id}/verify`
* `GET /v1/workspaces` / `GET/PUT /v1/workspaces/{id}/binding`
* Hostops restore/quarantine/environment/target helper routes

File reads return `content_base64`, SHA-256 and length. Snapshot file entries carry
`bytes` as base64 alongside the shared checkpoint-entry metadata. A null expected
hash means create only. Authentication failures are 401, hash/fence/save conflicts
409, missing operation 404. File-error responses are bounded codes, not raw file bytes.

For backup, stop the supervisor after reconciling accepted work, then copy the
entire protected state directory including journal/WAL/SHM while it is stopped.
Do not copy only a live `.db` file. The scoped hostops backup handler uses SQLite
`VACUUM INTO` with project capture/manifest checks and refuses unresolved writers;
its capability/coverage result must be included in the overall backup report.
The compatibility journal endpoint is limited to 32 MiB and explicitly excludes
identity, configuration, connection spool and protected recovery directories.
The fixed-root encrypted host-state exporter covers those configured components
and registered projects through bounded ciphertext chunks, including bundles over
32 MiB. See [BACKUP_RECOVERY.md](BACKUP_RECOVERY.md) for escrow, coverage omissions,
writer barriers and the offline unseal/remap/trust procedure.
Restore with dispatch disabled, preserve the old records, choose a new dispatch
epoch and reconcile every unresolved operation. Do not delete deterministic
containers before recording their outcomes. Host power loss does not promise
command continuation.

Process recovery uses a trusted OS boot UUID (`osboot-v1`), separate from the
telemetry series identity. Windows queries the kernel boot GUID; Linux reads the
kernel boot UUID. Only two valid, different IDs for the current OS can prove a
native process belonged to a previous boot. Legacy clock-based receipts, missing
queries and mixed formats never release a writer solely on a boot comparison;
they require ordinary identity/containment reconciliation. A query failure logs a
fixed code and disables that boot-only shortcut. See
`evidence/KERNEL_BOOT_RECOVERY.json` for tested scope, including the live Linux
writer regression; no physical reboot or configured Windows account is claimed.

See `evidence/LOCAL_COMPONENT_CHECKS.md` for the exact local checks and unrun gates.
