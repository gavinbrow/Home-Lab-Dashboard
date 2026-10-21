# 05 — Persistent workspaces, durable jobs, recovery, and backups

This document specifies implementation work. Statements using **must** are acceptance requirements; numerical defaults are proposed starting settings, configurable by the owner. Implement the foundational behavior in the working first version. Optional improvements are identified separately.

## 1. Establish the storage and execution contract first

The project is a durable identity with files, instructions, checkpoints, and execution history. An execution environment is a replaceable way to work on that project. A browser tab is only a client of those services.

Represent these separately in the database:

| Record | Required fields and meaning |
| --- | --- |
| `workspace` | Immutable ID, name, owner, storage type, home machine ID, approved root ID, canonical root path or volume identity, instructions revision, retention policy, quota, lock version. |
| `environment` | Workspace ID, execution machine ID, runtime kind, image digest or native-runtime description, generation number, runtime ID, mount specification, limits, status. |
| `job` | Job ID, requester, frozen model/profile/execution/workspace selections, policy revision, status, reason, timestamps, orchestration lease and generation. |
| `operation` | Immutable tool-operation ID, parent job/step IDs, target machine/environment, request digest, authorization decision, replay class, host acknowledgement and outcome. |
| `artifact` | ID, workspace/job/operation IDs, relative source path, size, MIME type, content hash, durable storage location, retention status. |
| `checkpoint` | Workspace ID, parent checkpoint, complete manifest hash, changed blobs, included/excluded paths, consistency status, creation reason and restore history. |

Freeze selections and the resolved policy on job creation. A provider serving a model on computer A may generate instructions for commands running on computer B, while files belong to a workspace on B. Show all three locations and the agent profile in the job header.

### 1.1 Existing-folder projects

1. The owner selects an enrolled computer and chooses a folder through its approved roots.
2. The host validates the real location, access rights, available space, and filesystem behavior. Preserve the owner’s files and do not initialize, relocate, or replace a repository implicitly.
3. Record the host-specific path; paths such as `C:\Projects\analysis` and `/srv/projects/analysis` are different resources even when names match.
4. Offer read-only or read/write file access. Native shell access is a separate permission with the execution-account limitations described in section 7.
5. Snapshot the initial configuration and create a first checkpoint before agent modifications.
6. Store dashboard metadata and checkpoint blobs outside the editable project root. A project process must not be able to rewrite its own authorization records or audit history.

### 1.2 Container projects

1. In v1, support dedicated **Linux containers on a configured Linux runtime**. A Windows computer can provide native-folder execution; a separately configured WSL2/Linux runtime is a distinct target with its own paths and availability. Native Windows containers are later work.
2. Allocate a durable project directory or a named volume explicitly owned by the workspace. Prefer a host directory for straightforward inspection and backup; use a named volume when its ownership and backup procedure are configured.
3. Mount it at `/workspace/project` by default. Mount only the selected project plus specifically granted read-only inputs.
4. Keep dependencies in the reproducible image, a deliberately retained cache, or a rebuild manifest. Do not store important outputs solely in the container writable layer or `/tmp`.
5. Run without host administrative privileges, without the Docker socket, and without broad host mounts. The trusted host broker creates containers using validated settings; it does not expose arbitrary Docker API access to the agent.
6. Associate each replacement container with the same workspace storage and a new environment generation. Validate the mounted workspace marker before starting commands.

Docker documents that volumes persist independently of a container’s lifecycle; bind mounts address paths on the Docker daemon’s host. Therefore the backend must validate the storage host, not assume a path on the control plane refers to the same files on an execution computer. See [Docker volumes](https://docs.docker.com/engine/storage/volumes/) and [bind mounts](https://docs.docker.com/engine/storage/bind-mounts/).

### 1.3 Cross-machine selection rules

V1 supports execution on the workspace’s home machine or its explicitly configured local container runtime. Selecting an incompatible execution computer must show why it cannot use that workspace. Do not silently copy a project, create an empty same-name folder, mount an unconfigured network share, or run against stale files. Later cross-machine work requires an explicit transfer or shared-storage connector, revision checks, and a named destination.

### 1.4 Lifecycle actions must have different behavior

| Action | Required behavior |
| --- | --- |
| Restart environment | Stop its processes, start the same environment configuration, and preserve durable files. Show affected jobs first. |
| Rebuild environment | Stop affected jobs, create a replacement from the recorded image/build specification, remount the same project storage, and verify files. Preserve old configuration for rollback. |
| Remove environment | Remove runtime resources and detach storage; keep the workspace, files, checkpoints, and history. |
| Archive project | Hide it from active lists and prevent new writes; retain files and history. |
| Delete project files | Separate explicit operation identifying the actual host/path, retained checkpoints, and consequences. Never include this in restart, rebuild, or ordinary cleanup. |

Dashboard-created managed storage may use recoverable quarantine with an owner-configured grace period, proposed as 30 days. Permanent deletion is a separate owner action. Removing an existing-folder project normally removes only its dashboard registration: moving, quarantining, or deleting that folder requires a separate owner grant naming the exact host and root. Enrollment alone does not grant ownership of those files. Rebuilds should refuse while active jobs remain unless the owner explicitly elects to cancel them. Neither environment garbage collection nor a Compose shutdown may remove workspace storage.

## 2. Build the project interface and file service

Implement in this order:

1. **Tree and metadata:** paginated directory listing, breadcrumbs, sizes, modified times, read/write status, hidden-file toggle, search, and current host/path. Distinguish an offline host from an empty directory.
2. **Transfers:** resumable uploads where practical, bounded streaming downloads, progress, cancellation, conflict choices, and checksums. Upload to a temporary path and atomically publish only after validation.
3. **Previews:** plain text/code, sanitized Markdown, images, PDF, and bounded CSV/JSON tables. Unknown formats receive download-only behavior. HTML/SVG previews must not execute with the application’s origin or session privileges.
4. **Editor:** a basic code editor with explicit save status, encoding/newline handling, diff view, and optimistic concurrency. Submit the last-seen content hash; reject a stale save with a compare/merge choice.
5. **File changes:** create, rename, move, and recoverable delete within the approved root. Recheck policy and location at execution time.
6. **Instructions:** editable `PROJECT_INSTRUCTIONS.md` or an explicitly selected instructions file, with version history and a clear indication of the revision used by each job. Reading instructions never grants permissions.
7. **Terminal:** open a terminal in the displayed environment and directory. Keep interactive terminal sessions distinct from durable background jobs. An ordinary human SSH session has connection-dependent lifetime and is outside the durable-agent-job guarantee; label this in its UI. Provide “Run as background job,” which submits through the host supervisor, for commands expected to survive a session ending.
8. **ZIP export:** make a real queued export job, write the ZIP outside the project, and return an authenticated downloadable artifact. Include a manifest of exported and excluded files.

Whole-project export includes all authorized project files, including dotfiles unless deliberately excluded. Present exclusions for credentials, caches, large outputs, or inaccessible files before export; never describe a silently partial archive as complete. Refuse path traversal and do not follow links outside the root. Record permissions and symlinks in the manifest when ZIP cannot preserve them faithfully. This export is portable file transfer, not a complete backup of NTFS ACLs, services, or external databases.

For a consistent export, acquire the workspace write lock and create an immutable checkpoint, then stream from that checkpoint. If an external desktop program keeps changing files, either quiesce it or label the export as best-effort with the paths that changed during capture.

## 3. Implement durable execution before the agent tool loop

### 3.1 Components and responsibilities

| Component | Responsibility |
| --- | --- |
| API | Authenticate; validate selections, permissions, and limits; create job and event records; return job ID. Never own a long-running command in an HTTP request handler. |
| PostgreSQL queue | Authoritative job state, operation IDs, leases, transitions, event cursors, dispatch outbox, and retry decisions. |
| Orchestrator worker | Claim jobs; call model providers; persist agent messages/tool decisions; dispatch operations; reconcile outcomes; enforce budgets. |
| Host network agent | Maintain authenticated outbound connection, report capabilities/health, and deliver requests to the local execution supervisor. |
| Host supervisor | Own processes independently of the network agent and API; persist launch/outcome records and logs; enforce local policy/limits; cancel process groups. |
| Browser | Submit once; display state; reconnect by job ID and event cursor. Closing the browser never cancels work implicitly. |

The queue can use short PostgreSQL transactions with `FOR UPDATE SKIP LOCKED` to claim due jobs. PostgreSQL explicitly describes this locking option as useful for queue-like consumers. A claim commits before any network call; do not hold database locks during a model request or command. Use leases for orchestration ownership, not as proof that a process has stopped. [PostgreSQL SELECT documentation](https://www.postgresql.org/docs/current/sql-select.html)

Use a transactionally written dispatch outbox. `LISTEN/NOTIFY` may wake workers, but periodically query the durable queue because notifications are not the source of truth. Store event payloads in tables, not notification strings. [PostgreSQL NOTIFY documentation](https://www.postgresql.org/docs/current/sql-notify.html)

### 3.2 Submission and launch protocol

1. The client supplies an idempotency key. Scope it to the authenticated caller and request digest. An identical retry returns the existing job; a reused key with different content is rejected.
2. In one transaction, create the job, immutable configuration snapshot, first event, and outbox entry.
3. The worker claims an orchestration lease with a monotonically increasing generation. Proposed defaults: heartbeat every 5 seconds, 30-second lease, configurable for the deployment.
4. Allocate a unique operation ID for every tool invocation. Keep this ID stable when resending an unacknowledged dispatch.
5. The host supervisor checks authorization, environment generation, operation ID, request digest, and fencing generation, then durably records receipt **before** launch. Duplicate requests return the existing record.
6. Start through the platform supervisor, recording process identity, host boot ID, start time, containment ID, and execution account. A PID alone is insufficient because it can be reused.
7. Write sequenced output and outcome records locally, replicate them to the control plane, and acknowledge replication only after durable storage.
8. After a disconnect, query the operation ID instead of resubmitting the command as a new operation.

Keep the host journal on local durable storage using SQLite transactions with settings chosen for actual durability, such as WAL plus `synchronous=FULL` for operation receipts and outcomes. SQLite documents the durability tradeoff between `FULL` and `NORMAL`; do not silently weaken it for launch receipts. Logs may use bounded batching with the possible final unflushed tail disclosed. [SQLite WAL documentation](https://www.sqlite.org/wal.html)

**Do not promise exactly-once arbitrary command execution.** An OS process launch and a database commit do not form a single transaction. A crash after launch but before a trustworthy identity/outcome record may leave the result unknown. Reconcile the supervisor, containment group, filesystem, and recorded effects. If uncertainty remains, mark `interrupted` with `outcome_unknown` and do not automatically replay a mutating command. A user-directed retry is a new attempt linked to the first.

Fencing prevents an obsolete orchestrator from issuing additional work after lease ownership changes. It does not undo a command already running. A replacement worker must reconcile that command before scheduling dependent operations or acquiring another write lock. **An expired worker lease or disconnected host must not release an unknown operation’s workspace write lock or other side-effect reservation.** Keep the workspace blocked until the host proves completion/termination or the owner performs an explicit recovery procedure. Similarly, a lost model connection does not prove the provider has stopped inference: retain an uncertain request reservation until provider reconciliation or a configured conservative recovery decision, and display the uncertainty.

### 3.3 State machine

| State | Meaning and allowed next states |
| --- | --- |
| `queued` | Durable request awaiting capacity; may become `running`, `waiting`, or `cancelled`. |
| `running` | Active orchestration, inference, or supervised execution; may become `waiting`, `cancelling`, `completed`, `failed`, or `interrupted`. |
| `waiting` | Persisted reason such as model capacity, host reconnect, authorization change, or user input. Show the pending operation and whether it might still be executing. May resume, cancel, fail a defined timeout, or become interrupted. |
| `cancelling` | Cancellation requested; outcome still being established. Becomes `cancelled` only after execution has stopped, or `interrupted` if termination cannot be verified. |
| `completed` | All required steps and verification finished successfully; outputs and final events are committed. |
| `failed` | A known error or unsuccessful verification ended the job. Preserve partial files and command outcomes. |
| `cancelled` | Work was stopped or cancelled before launch; preserve partial effects and outputs. Cancellation is not rollback. |
| `interrupted` | Execution lost its reliable continuation/outcome, for example host reboot or ambiguous launch. Show reconciliation and retry options. |

Store a machine-readable reason separately from the state. Do not show an offline host as a successful cancellation or a model refusal as infrastructure failure. Terminal attempts remain immutable; retry or continue creates a linked attempt.

### 3.4 Logs, elapsed time, and reconnect

Persist ordered event IDs and output offsets. SSE is suitable for one-way job/chat updates; WebSockets remain suitable for interactive terminal input. Support `Last-Event-ID` or an explicit cursor, send a current state snapshot when the cursor has expired, and deduplicate by event ID. The HTML standard defines SSE reconnection and event IDs; application persistence is still required. [WHATWG server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)

Show queue time, active run time, waiting time, total wall time, and the last verified host update. Use UTC server timestamps for records and host monotonic clocks for measured execution intervals. Do not let a browser timer become the authoritative elapsed time.

Proposed retention: job metadata and summarized audit history for one year; normal logs for 30 days; project files and explicitly retained artifacts until owner deletion. Configure per-job output and per-host spool quotas, for example 100 MiB and 2 GiB initially. Preserve a visible truncation/gap event rather than silently dropping output. If durable receipt storage is full, stop accepting new operations. If a running job exhausts its spool and cannot upload, apply a configured bounded-output policy or stop it with an explicit log-storage error.

## 4. Specify recovery behavior for every failure boundary

| Failure | Required behavior |
| --- | --- |
| Browser closed, refreshed, or network lost | Job continues on the backend. Reopen using the job ID; replay missing events. Never repeat a command as part of page mounting. |
| API restart | Workers and host processes continue independently where possible. Sessions reauthenticate as necessary; job/event records remain authoritative. |
| Orchestrator worker crash | Lease expires; new worker reconciles persisted model/tool steps and host operations. It does not create duplicate operations or assume the command failed. |
| Model stream lost | Preserve partial response and mark the inference step interrupted. Never execute incomplete streamed tool arguments. A new inference attempt is explicit and references the persisted transcript/tool outcomes. |
| Host connection lost | Mark telemetry stale and the job waiting for reconciliation. The already accepted command may continue under local limits; do not start dependent or duplicate work elsewhere. |
| Host network agent restarts | Local supervisor continues; reconnect and upload journal/log offsets. |
| Local execution supervisor fails | Identify surviving containment groups and reconcile. If process ownership or exit status cannot be established, interrupt; never advertise seamless recovery without a tested implementation. |
| Host reboots or power fails | Detect boot-ID change. Ordinary native processes are interrupted. Recover files and logs; only an explicitly checkpointable application may resume from its own checkpoint. |
| Database unavailable | Stop new dispatches. Hosts finish already accepted bounded operations and spool locally. Resume after ledger reconciliation, respecting host storage limits. |
| Execution container replaced unexpectedly | Existing process is interrupted; workspace files remain. Rebuild a new environment generation only after recording the previous outcome. |
| Control plane restored from old backup | Start in recovery mode with dispatch disabled. Reconcile host journals and environment identities before enabling jobs; old queued/running rows must not replay automatically. |

### Cancellation implementation

The supervisor must terminate the whole managed process tree. For native Linux commands, use a separate per-operation systemd unit/cgroup with an appropriate `KillMode`; on Windows, use a Job Object without ordinary breakaway permission and verify membership/termination. These mechanisms control groups of processes; neither alone creates a filesystem sandbox. See [systemd kill behavior](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html), [resource controls](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html), and [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

Container execution needs its own containment strategy: killing a local `docker exec` client does not prove the container's command/children stopped. In v1, track command process groups through an in-container helper and, if group termination cannot be proved, stop the dedicated project container and verify it has stopped before confirming cancellation. Disclose this environment-wide escalation in the workspace policy; the single-writer rule prevents other managed writers from sharing it. Keep storage intact and mark any affected environment processes stopped/interrupted. Do not run unrelated background services in this execution container. A later per-job-container design can narrow this escalation. Test nested children inside the container as well as native processes.

Use a graceful stop followed by a configured force-stop deadline. Record exit information and leftover processes. For an offline host, persist the cancel request and show “cancellation pending—host unreachable”; do not mark it cancelled immediately. Host-side timeouts remain effective without the control plane. Applications that deliberately launch scheduled tasks or external services are external side effects, not guaranteed children; restrict these operations through separate tools and report them explicitly.

## 5. Retain outputs and make changes reviewable

Capture a checkpoint before the first mutation and after a job’s completed changes. Use an external manifest and content-addressed blob store covering tracked, untracked, and binary files. Git integration can provide useful diffs but cannot alone recover ignored files, generated images, or arbitrary existing folders.

Each checkpoint records paths, content hashes, sizes, file types, relevant permissions, symlinks, exclusions, and scan consistency. For very large projects, use incremental manifests and configurable quotas. If a checkpoint required by policy cannot be created, stop before mutation and explain the capacity or access problem.

Enforce one active writer per workspace in v1; allow simultaneous readers. Dashboard editors, uploads, agent mutations, and managed workspace terminals must honor the lock. A workspace terminal holds its writer reservation for its process/descendants' lifetime, including detached grace periods; socket closure is not proof of exit. Raw administrative SSH, desktop applications, and local programs are external writers. Detect their changes and conflicts instead of claiming the application lock constrains them. A full filesystem snapshot can be a later optimization, not a claim attached to a best-effort directory scan.

For every operation, record:

- Actor, agent profile revision, selected model and provider, job/step IDs, target computer/environment, execution account, and workspace.
- Tool name, sanitized arguments or command, working directory, authorization scope, timestamps, exit status, and measured limits.
- Before/after checkpoint IDs, changed paths, added/deleted/binary indicators, and downloadable diffs where meaningful.
- Affected services, containers, or other systems when the tool has that information.
- Verification commands and actual results. “Command exited successfully” and “the requested outcome was verified” are separate facts.

For native shell, before/after workspace manifests identify project changes; they do not prove all system-wide side effects were observed. Mark that visibility limit in the audit entry. Structured service/container tools can record affected objects precisely.

Register intended deliverables in an artifact manifest. Files remain on the external project storage, and outputs marked “retained” also receive an immutable checksum-verified copy in durable control-plane artifact storage. This lets those retained outputs remain downloadable when their execution host is offline. Ordinary unregistered project files remain available when their home host reconnects. Do not imply that every project file has been centrally backed up merely because it appears in the browser.

Restore selected files or an entire checkpoint only after showing the proposed diff. Acquire the write lock first, create a pre-restore checkpoint, check for newer external edits, then apply the restore. Project checkpoints do not roll back system packages, remote APIs, database mutations, or service restarts.

## 6. Persistence layout and database requirements

| Data | Authoritative location | Backup obligation |
| --- | --- | --- |
| Users, settings, host connections, approved roots, profiles, provider definitions | PostgreSQL; credentials referenced by secret ID | Database backup plus separately protected secret material. |
| Conversations, jobs, operations, event history, audit metadata | PostgreSQL, with immutable large log chunks stored externally if needed | Database plus referenced log objects at a recorded backup cut. |
| Existing-folder project files | Selected host filesystem | Include the approved folder in that host’s backup plan. |
| Container project files | Workspace-owned host path or durable volume | Back up independently from the container/image. |
| Retained artifacts/checkpoint blobs | Persistent file/blob directory outside disposable application containers | Encrypted backup with manifests and hash verification. |
| Host operation ledger and unreplicated logs | Host-local SQLite and spool | Back up ledger safely; reconcile with central history. |
| Images and caches | Runtime storage/registry plus pinned configuration | Usually reproducible; back up locally unique images or build inputs. |
| Encryption keys, CA private keys, recovery material | Protected secrets storage outside ordinary DB exports | Separate encrypted recovery copy, with a tested restore procedure. |

Use foreign keys, unique operation/idempotency constraints, schema migrations, optimistic versions, and transactional state transitions. Partition or prune high-volume events/metrics according to policy. Do not store unbounded terminal output or binary artifacts in a single job row.

## 7. Enforce permissions in both backend and host

Effective permission is the intersection of user permissions, agent-profile scope, workspace policy, target-host allowlist, and the specific job’s grant. Persist this grant so ordinary operations inside the configured scope continue without repeated prompts. Re-evaluate revocations and restrictions before every new operation. A change to a profile cannot silently expand an already running job’s authority.

Separate permissions for file read/write, native shell, container execution, service/container administration, model management, credential use, network access, and deletion. Credentials are backend/host references, never frontend configuration, project instructions, ordinary environment dumps, or model context. Restrict which secrets a tool can consume; do not pass the complete application secret set into an agent container.

### 7.1 File APIs

Use traversal-resistant filesystem APIs rooted at an approved directory. Reject escapes through `..`, absolute paths, symlinks/reparse points, special Windows names, and archive entries. A string prefix check or `realpath` followed by an unrelated open is insufficient because directories can change between validation and use. Go’s `os.Root` family is an appropriate starting point; confirm platform support and test each operation used. [Go traversal-resistant file APIs](https://go.dev/blog/osroot)

### 7.2 Native commands

**Setting the working directory and filtering command text does not restrict arbitrary shell code to that folder.** Native execution must run as a dedicated account whose filesystem ACLs and OS privileges match the intended scope. Use per-project accounts/permissions when projects must be isolated from each other. Permit reads of necessary system runtimes while denying access to unrelated user data and writes outside approved project/scratch locations.

If that boundary cannot be configured and verified, disable autonomous native shell for that profile or clearly expose it as broader, trusted host-account access requiring the owner’s explicit configuration. File-only tools can remain available. A human administrative SSH terminal is also a broader capability and must not be presented as a confined workspace shell.

Provision the actual execution identity, its required logon rights/profile, and explicit writable scratch/home/cache locations. Validate the launched UID or Windows token with a real command. File/account permissions do not enforce native network policy: restrictive per-job egress requires tested OS firewall/namespace/WFP or equivalent integration. Reject an unenforceable policy/runtime combination or select a container/runtime that supports it; never silently accept an unenforced restriction.

### 7.3 Containers

Prefer non-root execution and a rootless runtime where compatible. Otherwise confine privileged Docker control to a small trusted broker with a fixed request schema. The agent receives no Docker socket, host PID namespace, privileged mode, host-root mount, or arbitrary device access. Docker warns that daemon control can provide extensive host access through mounts. [Docker security](https://docs.docker.com/engine/security/) and [rootless mode](https://docs.docker.com/engine/security/rootless/)

Enforce CPU/memory/process/time limits and only expose GPUs when granted. Start with network disabled for file-only jobs; explicitly grant egress when required and enforce it through supported host/firewall/proxy controls. Do not claim a network allowlist works if the chosen runtime bypasses that enforcement. Keep control-plane credentials and management endpoints outside the container’s permitted network scope.

Redact known secret values and sensitive parameters from logs, disable request-body logging on credential endpoints, and keep raw terminal recording optional and access controlled. Redaction cannot reliably recognize every secret that arbitrary programs print; do not label ordinary stdout automatically safe for sharing.

## 8. Back up and restore the complete system

V1 needs a documented, executable backup command and a real restore drill. Automatic scheduled backups can be added later; creating a schedule is not a substitute for proving restore.

### Backup sequence

1. Create a backup-set ID and record software/schema versions and configured machines.
2. Enter a short maintenance window that prevents new mutations. Drain active writers or arrange application-consistent snapshots; if a project cannot be quiesced, label its backup incomplete and explain why.
3. Flush host receipts/log acknowledgements and create project checkpoints. Export the database consistently and capture referenced blob manifests at the same backup cut.
4. For the small v1 deployment, use a consistent `pg_dump` archive plus required role/configuration recovery data. As recovery objectives tighten, add physical/base backups and WAL archiving. A live copy of PostgreSQL’s data directory is not an adequate backup procedure. [PostgreSQL backup and restore](https://www.postgresql.org/docs/current/backup.html), [pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html)
5. Back up each workspace’s actual storage host and retained control-plane artifacts/checkpoints. Record offline or failed hosts; never report global success when a required project was skipped.
6. Use SQLite’s backup API or another documented consistent method for live host ledgers, not an arbitrary copy of only the `.db` file while WAL is active. [SQLite backup API](https://www.sqlite.org/backup.html)
7. Encrypt backups and keep a copy on a different device. A tool such as restic can provide encrypted repository snapshots and restoration; store its recovery credentials separately. Validate repository metadata and periodically verify stored data. [restic introduction](https://restic.readthedocs.io/en/stable/010_introduction.html)
8. Write a manifest with per-component success, hashes, capture times, exclusions, and the last recoverable project revision. Exit maintenance mode only after recording the result.

Suggested starting objectives are at most 24 hours of data loss after the latest successful complete backup and restoration within four hours for a small homelab. These are targets to measure, not guarantees. Include size/growth monitoring so retained outputs and checkpoint history cannot quietly exhaust storage.

### Restore sequence

1. Restore into an isolated control-plane instance with job dispatch, schedules, and provider management disabled.
2. Restore compatible PostgreSQL data, blob storage, configuration, and separately supplied decryption material. Verify hashes and application migrations before connecting hosts.
3. Restore project roots/volumes to their intended machines or explicitly remap them. Reapply ownership/ACLs and verify workspace markers.
4. Treat all previously queued/running/waiting jobs as requiring reconciliation. Query surviving host ledgers; never replay old actions automatically.
5. Reestablish host trust, revoke obsolete credentials if needed, and test monitoring, read-only file access, SSH, and desktop independently.
6. Open a restored conversation/job, download an artifact, inspect a checkpoint, and recover a selected file.
7. Enable new jobs only after the restore report identifies missing components and the owner accepts any unresolved gaps.

## 9. Acceptance tests on real configured machines

Record host IDs, OS/runtime versions, timestamps, job IDs, checksums, and screenshots/log evidence. Use disposable test projects and a reversible test service where needed. Demonstration fixtures do not satisfy these tests.

| ID | Test | Pass criteria |
| --- | --- | --- |
| WJ-01 | Existing Windows and Linux folders | Browse, upload, edit, preview, download, and ZIP-export files on both machines; downloaded hashes match source. |
| WJ-02 | Browser survival | Start an agent job that issues a supervised command lasting at least three minutes and creates an output; close every dashboard tab, reopen later, and attach to the same job. The command ran once and the output is retained. |
| WJ-03 | Container replacement | Generate text and binary outputs, record hashes, remove and replace only the execution container, and reattach the same workspace. All generated files still exist with identical hashes. |
| WJ-04 | API/worker restart | Restart API and kill the orchestrator during a command. Reconciliation yields the original operation’s outcome with no duplicate append or service action. |
| WJ-05 | Host disconnect | Break the host’s control connection during a command. UI shows stale/waiting status; reconnect retrieves missing logs and outcome without launching a second command. |
| WJ-06 | Host reboot | Reboot a test host during execution. Job becomes interrupted with the correct reason; no unsafe automatic restart occurs; persistent files remain accessible after reconnect. |
| WJ-07 | Cancellation | Cancel a command that spawns child processes on native Windows/Linux and inside a project container. Verify descendants stop, including documented container-stop escalation; partial files remain and the audit shows what happened. |
| WJ-08 | Lost acknowledgement | Suppress the first dispatch acknowledgement and resend the same operation ID. Host returns its original receipt/outcome; a sentinel counter increments only once. |
| WJ-09 | Ambiguous launch | Inject a crash at the launch/record boundary. Either recover a trustworthy original process identity or show `outcome_unknown`; never blindly replay the mutation. |
| WJ-10 | File confinement | Attempt traversal, symlink/reparse escape, ZIP traversal, and stale editor save. Backend/host refuse escape and report conflicts without modifying unrelated files. |
| WJ-11 | Native shell scope | Under the actual configured execution account, attempt access to an unrelated project/user file and privileged action. Enforced denials match the advertised scope. If unsupported, autonomous native shell is disabled. |
| WJ-12 | Checkpoint recovery | Modify, delete, and create text, untracked, and binary files; restore a checkpoint and verify hashes, deletion recovery, and conflict handling. |
| WJ-13 | Capacity failure | Exhaust a test job’s log quota and simulate full receipt storage. Show explicit truncation/storage errors and refuse unsafe new launches. |
| WJ-14 | Complete restore | Restore settings, hosts, profiles, provider definitions, project configuration, conversations, job history, checkpoints, and retained files into an isolated instance. Reconcile prior jobs and run a new harmless job successfully. |
| WJ-15 | Unknown operation retains lock | Disconnect a host during a mutating command, let the orchestration lease expire, and submit a second writer. The second job waits; neither a replacement worker nor a browser refresh releases the unresolved operation's workspace lock. |

## 10. Later extensions

After these acceptance gates pass, add filesystem snapshots for large workspaces, resumable application-specific computation, resource-aware scheduling, multi-writer collaboration with merge conflicts, cross-machine project transfer, storage replicas, WAL-based point-in-time recovery, and more advanced sandbox runtimes. Preserve the same storage identities, operation IDs, audit contract, and explicit recovery semantics.

## Sources and implementation references

Primary documentation was checked during plan preparation. Pin and recheck chosen component versions during implementation.

- [Docker volumes](https://docs.docker.com/engine/storage/volumes/) and [bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)
- [Docker security](https://docs.docker.com/engine/security/) and [rootless mode](https://docs.docker.com/engine/security/rootless/)
- [PostgreSQL SELECT](https://www.postgresql.org/docs/current/sql-select.html), [NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html), [backup and restore](https://www.postgresql.org/docs/current/backup.html), and [pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html)
- [SQLite WAL](https://www.sqlite.org/wal.html) and [backup API](https://www.sqlite.org/backup.html)
- [WHATWG server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [systemd kill](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html) and [resource control](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html)
- [Microsoft Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Go traversal-resistant file APIs](https://go.dev/blog/osroot)
- [restic introduction and verification](https://restic.readthedocs.io/en/stable/010_introduction.html)
