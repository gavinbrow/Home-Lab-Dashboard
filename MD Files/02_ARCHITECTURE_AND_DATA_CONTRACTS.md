# 02 — Architecture, persistent data, and interfaces

## 1. Deployment and process boundaries

Use an always-on Linux computer or Linux VM as the initial control plane. A proposed starting budget is 4 vCPU, 8 GB RAM, and SSD-backed storage, excluding inference and project workloads. This is a planning allowance, not a measured minimum. Measure actual memory, database growth, and log/artifact volume during acceptance, then revise it.

Deploy the HTTPS reverse proxy, web/API service, worker, PostgreSQL, Guacamole web application, and guacd with Docker Compose. Keep the host execution service outside the control-plane application container. If this same physical computer executes projects, enroll it as a separate execution target with the same controls as other machines.

| Component | Owns | Must not own |
|---|---|---|
| React frontend | Views, editor state, selectors, authenticated stream subscriptions | Credentials, authoritative job state, process lifetime, permission decisions |
| Fastify API | Sessions, policy checks, validated commands, job submission, file/remote-access brokers | Long tasks attached to request lifetime |
| Worker | Persisted agent loop, queue claims, provider requests, dispatch/reconciliation | Unjournaled remote side effects |
| PostgreSQL | Durable metadata, queue, events, locks/reservations, histories | Sole copies of large file bytes |
| Artifact store | Immutable outputs, checkpoint blobs/manifests, retained log segments | Only copy of mutable working projects |
| Host connection/monitoring agent | Outbound mTLS, inventory, metrics, event forwarding | Running arbitrary user code as its privileged identity |
| Host execution supervisor | Durable operation journal, launch/attach/cancel, local log spool | Trusting arbitrary paths or commands without a validated grant |
| Project process/container | Actual commands, project-local tools | Control-plane secrets or unrestricted Docker access |
| Guacamole webapp / guacd | Desktop web client/tunnel and RDP/VNC gateway | Dashboard-wide authorization without an application integration |

The Go binary may expose `agent` and `supervisor` modes, installed as separate services/processes. The connection agent can restart without killing supervised tasks. If the supervisor itself fails, its startup reconciles OS process/container identity and recorded operations before accepting new mutations. Do not promise survival through host power loss.

## 2. Network paths

| From → to | Transport and purpose | Reachability rule |
|---|---|---|
| Browser → reverse proxy/API | HTTPS; SSE for events; WebSocket for terminals | Private LAN/VPN in v1; authenticated app session |
| Browser → desktop gateway | HTTPS plus WebSocket/HTTP tunnel | Same authorization scope as launch; active-session revocation |
| Host agent → API agent endpoint | Outbound mTLS stream over HTTPS | Certificate bound to machine ID; no browser session reuse |
| API SSH broker → target SSH server | SSH/SFTP | Verified host key; explicit LAN/VPN route |
| guacd → target desktop server | RDP/VNC | Explicit LAN/VPN route and enrolled endpoint |
| Worker → model provider | HTTPS or explicitly trusted private HTTP | Registered endpoint, server-side credential, bounded request |
| Host supervisor → local runtime | Restricted IPC/OS process/container API | Local identity and narrow verbs; no general public execution endpoint |
| API/worker → PostgreSQL/artifact store | Internal network or local persistent mount | Service-specific credentials and restricted access |

An outbound host-agent connection is not automatically an SSH/RDP tunnel. A host may have working jobs while remote desktop is unreachable. Port defaults such as SSH 22, RDP 3389, and VNC 5900 are hints only; store configured values.

Avoid public exposure of raw SSH/RDP/VNC/Docker/model endpoints. The product's first deployment assumes the owner provides a working LAN/VPN route. VPN setup or repairs are separate tasks, not silently performed by onboarding.

## 3. Reusable components and decisions

Use xterm.js for terminal rendering and ssh2 for backend SSH/SFTP; use Monaco for basic code/text editing. xterm.js is a terminal component, not a permission boundary, and its own security guidance emphasizes the privilege implications of embedding a shell. [xterm.js security](https://xtermjs.org/docs/guides/security/), [ssh2](https://github.com/mscdex/ssh2), [Monaco](https://github.com/microsoft/monaco-editor)

Use Guacamole's web application and guacd with its documented encrypted JSON authentication mechanism. The application still owns connection authorization, short-lived launch tickets, active tunnel revocation, and browser session binding. Do not assume an expiry in Guacamole authentication data terminates an already active session. [Guacamole JSON authentication](https://guacamole.apache.org/doc/gug/json-auth.html)

Use a provider adapter interface rather than hardcoding one model runtime. Keep inference, catalog discovery, capability information, and optional model-management operations distinct. The official LM Studio API, for example, separates compatible inference endpoints from native load/unload/download endpoints. [LM Studio API](https://lmstudio.ai/docs/developer/rest)

Use PostgreSQL for the initial queue instead of adding Redis solely for job ownership. Short transactions claim eligible records using row locking and `SKIP LOCKED`, then commit before network or model work. PostgreSQL explicitly identifies queue-like consumption as a use for this locking behavior. This is not an exactly-once execution guarantee. `NOTIFY` may wake workers, but workers always recover work from durable tables and periodic polling. [SELECT locking](https://www.postgresql.org/docs/current/sql-select.html), [NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)

No Kubernetes, distributed filesystem, vector database, or mandatory external agent framework is needed for v1. Introduce additional infrastructure only for a measured requirement.

## 4. Four independent selections and location invariants

### 4.1 Domain relationships

| Entity | Essential fields | Invariant |
|---|---|---|
| Model reference | Provider ID, advertised model ID, optional digest/version, capabilities | Identifies response generation, never a tool execution host |
| Agent profile revision | Instructions, tool set, default model, permitted machines/workspaces, execution budgets | Instructions are context; policy fields are enforced code |
| Execution target | Machine ID, execution mode, OS identity, optional container/environment ID | Resolves to exactly one actual execution location |
| Workspace | Project ID, type, storage-machine ID, canonical root/storage ID, environment binding | Defines where mutable project files actually reside |

A model provider may have an optional `serving_machine_id` for display and resource accounting. For a cloud/relay provider this can be unknown or external. It cannot select the execution target automatically.

In v1, native-folder tasks execute on their storage machine. Container projects execute on the machine whose Docker engine owns their project storage. Selecting another machine produces a validation error unless a future explicit migration/import workflow creates a compatible copy. Mounting a path from one machine on another does not make the same string the same filesystem.

Record both the host storage path and the path seen by commands. For example: `linux-runner-01:/srv/homelab/projects/<project-id>/data` is mounted as `/workspace/project`. For Windows: `windows-workstation-01:D:\HomelabProjects\Example`. Never pass the Windows path to a Linux process without an explicit mapping.

### 4.2 Immutable run snapshot

At submission, resolve and persist a snapshot with these fields:

```json
{
  "schema_version": 1,
  "provider_id": "configured-provider-id",
  "provider_config_revision": 2,
  "provider_adapter": "openai-compatible",
  "provider_endpoint": "https://model-server.example/v1",
  "model_id": "actual-provider-model-id",
  "profile_id": "configured-profile-id",
  "profile_revision": 3,
  "execution_machine_id": "configured-machine-id",
  "execution_identity_id": "configured-restricted-account-id",
  "workspace_id": "configured-project-id",
  "workspace_revision": 7,
  "environment_id": "configured-container-environment-id",
  "environment_generation": 2,
  "project_instruction_revision": 4,
  "policy_revision": 5,
  "limits": {
    "max_tool_steps": 60,
    "wall_time_seconds": 1800,
    "per_command_timeout_seconds": 300
  }
}
```

Values are illustrative; use actual nullable types and validated IDs in implementation. For native execution use JSON `null` for environment ID/generation when no managed environment exists. Policy at dispatch is the intersection of this grant and current permissions/revocations. Editing a profile cannot silently expand a running job's authority. Freeze provider configuration revision, adapter, and endpoint too: an endpoint edit applies to new runs or pauses affected older runs for an explicit change, never silently retargets them. Credential rotation may refresh a secret reference under an explicit same-endpoint policy; no secret value enters the snapshot. A provider that resolves an alias to another model must report that mapping when known and retain it with the response.

## 5. Persistent records

Implement database migrations, foreign keys, explicit enum/check constraints, and ownership/resource checks. Treat this as a logical schema; choose normalized tables and indexes during implementation.

| Record/table group | Required persistent content |
|---|---|
| `users`, `sessions`, `auth_events` | Owner identity, password hash, optional MFA state, session revocations and login history |
| `machines`, `machine_connections`, `capability_tests` | OS identity, connection definitions, credential references, feature health, last test evidence |
| `agent_enrollments`, `agent_certificates` | Enrollment expiry/use state, machine binding, certificate serial/revocation/protocol version |
| `execution_identities`, `permission_grants` | OS/container identity, permitted resources, action scope, expiry/revision/revocation |
| `providers`, `provider_runtime_pools` | Endpoints, adapters, secret references, discovered versions, shared concurrency limits |
| `models`, `model_observations`, `model_favorites`, `capability_probes` | Catalog IDs, availability/residency observations, source/age, test outcomes and tested version |
| `agent_profiles`, `agent_profile_revisions` | Instructions, defaults, permitted tools/targets/paths, budgets |
| `projects`, `workspaces`, `environment_generations` | Project config/instructions, host/path/storage binding, image digest, lifecycle state |
| `conversations`, `messages`, `inference_requests` | Message content, attachments, run/model provenance, stream lifecycle, token/timing metrics |
| `jobs`, `job_attempts`, `job_steps` | State, reason, dependencies, resolved run context, limits, timestamps, worker lease/fence |
| `operations`, `dispatch_outbox`, `host_receipts` | Stable operation IDs, request digest, dispatch status, host launch/results reconciliation |
| `job_events`, `log_segments` | Replay cursor, event ordering, durable segment pointers/hashes, retention boundaries |
| `resource_reservations`, `workspace_locks` | Provider/machine permits, modifying-workspace owner, unresolved-operation protection |
| `file_changes`, `checkpoints`, `artifacts` | Before/after hashes, manifests/blob IDs, recovery policy, retained output metadata |
| `service_targets`, `saved_actions`, `action_revisions` | Enumerated control targets, typed parameters, fixed executable/script revision, verification |
| `metric_samples`, `metric_rollups`, `service_observations` | Metric value/unit/availability/source, host/receipt timestamps, per-device identity |
| `audit_events`, `backup_runs`, `restore_runs` | Actor/action/target/result, backup coverage, restored evidence and integrity checks |

Critical uniqueness: owner + idempotency key for submission; globally unique operation ID; operation ID + host event sequence; job ID + event sequence; provider ID + model ID; one active modifying lock per workspace. Idempotency keys must include a request hash so the same key with different content returns a conflict.

Use parameterized SQL, bounded pagination, and time-range indexes. Partition high-volume metrics/events as justified by measurement. Keep job metadata after log expiration, with explicit `logs_expired` information. Do not infer an empty job history from a failed database query.

## 6. Storage map and ownership

The following are proposed installation paths, not existing paths:

| Location | Data | Lifetime |
|---|---|---|
| Control-plane PostgreSQL persistent volume | Configuration, sessions, jobs, chat, observations, references | Independent of API/worker containers |
| `/srv/homelab-control/artifacts/` | Published output bytes, checkpoint blobs, retained logs/export files | Retained according to explicit policies and backups |
| Restricted control-plane key directory | Master encryption key, CA material, backup key references | Separately protected and recoverable |
| Linux `/var/lib/homelab-agent/` | Agent identity, SQLite operation journal, log spool | Survives agent service replacement |
| Windows `%ProgramData%\HomelabAgent\` | Same agent data with restricted ACLs | Survives Windows service replacement |
| Execution host project root | Mutable project files and user-editable instructions/configuration | Independent of environment generation |
| Protected host/control-plane metadata directories | Authoritative checkpoint manifests, policies, operation records, and audit metadata | Outside project-code write access |
| Container writable layer / temporary paths | Disposable caches, temporary tools/process state | May disappear on rebuild |

Bind-mounted project directories are the recommended managed-project default because the owner can inspect them directly on the host. Externally managed named volumes are also acceptable with an explicit backup/export path. Docker documents that volumes outlive the container that mounts them; the application must additionally prevent its own lifecycle operations from deleting them. [Docker volumes](https://docs.docker.com/engine/storage/volumes/)

Retained artifact copies are independent of mutable working files. A file deleted or overwritten in the project does not silently remove an already published artifact. Host-local project data may be inaccessible while that host is offline; an artifact uploaded to the control plane remains downloadable. Show which copies exist.

## 7. API contracts

Publish OpenAPI/JSON schemas before frontend implementation. Prefix application routes with `/api/v1`. All mutations require authentication, server-side authorization, validation, and an audit record. Representative routes:

| Route/action | Contract |
|---|---|
| `POST /machines`, `POST /machines/{id}/tests` | Create metadata; enqueue named independent capability tests |
| `GET /machines/{id}/metrics` | Bounded time range/resolution; value availability and observation age |
| `POST /terminals` | Select verified connection + identity; return scoped session ID, not SSH credentials |
| `POST /desktop-sessions` | Select enrolled connection; authorize and return short-lived scoped launch |
| `POST /providers/{id}/discover` or `/capability-tests` | Background operation; never silently execute a probe on every selector change |
| `POST /jobs` | Idempotency key + immutable resolved selections; return accepted job ID before execution |
| `GET /jobs/{id}`, `GET /jobs/{id}/events` | Current snapshot plus replayable SSE; resume after last event cursor |
| `POST /jobs/{id}/cancel` | Idempotent cancellation request with reason; does not immediately assert process death |
| `POST /jobs/{id}/resume` or `/retry` | Explicit safe continuation/new linked attempt after reconciliation |
| `GET/PUT /projects/{id}/files/...` | Root-relative file operations; conditional writes by content hash/version |
| `POST /projects/{id}/exports` | Snapshot-aware ZIP export as a tracked job |
| `POST /projects/{id}/checkpoints`, `/restore` | Capture and recover files with a pre-restore checkpoint |
| `POST /projects/{id}/environment/restart` or `/rebuild` | Separate lifecycle verbs preserving registered project data |
| `DELETE /projects/{id}/data` | Explicit protected data removal naming host/root; existing-folder registration alone never authorizes it |
| `POST /actions/{id}/runs` | Fixed saved action revision + validated typed parameters + authorized target |

Events include schema version, event ID, job ID, type, timestamp, sequence, and payload. Persist before advertising them to clients. Replay log/text chunks, not execution commands. Deduplicate client rendering by event ID. If a cursor is older than retention, return a clear resynchronization response with the current snapshot and available segment range.

Terminal WebSockets and desktop tunnels are session transports, not the job queue. Define close/reconnect/idle behavior independently. Stream backpressure must not block the host process indefinitely or exhaust memory.

## 8. Permission and credential boundary

Use a maintained authentication library and secure password hashing; local owner login is enough for v1. Store sessions server-side; cookies use Secure, HttpOnly, appropriate SameSite, rotation, and expiration. Require CSRF protection on cookie-authenticated mutations and verify WebSocket origins. Provide recovery through a documented local administrator procedure. Logout closes interactive access/subscriptions but does not implicitly cancel previously authorized background jobs. Revoking a job grant is a separate operation with its own cancellation/reconciliation behavior. These choices follow standard session-management practice. [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)

Encrypt provider credentials, SSH keys, desktop passwords, and secret-bearing configuration at rest with a reviewed library. Store the wrapping/master key outside the database and outside frontend/public assets. Secret references may enter job configuration; secret values must not enter model prompts, event payloads, URLs, ordinary logs, or exports. Redact known injected secrets in output, but acknowledge that arbitrary tools can transform data: least-privilege injection is the primary control, not perfect log redaction.

The API validates actor → profile → tool → machine → project/path → action. The host independently checks the dispatch machine, permitted execution identity, project/environment generation, operation ID/request hash, grant revision, and limits. The privileged helper accepts enumerated administrative actions, not arbitrary shell strings.

Native shell authorization is constrained by the actual OS identity. To offer a restricted project, create an execution account with appropriate filesystem permissions and no unrelated secret access, or use the container mode. An unrestricted personal SSH account remains an explicitly broader human-management capability. Do not advertise that account as confined by a frontend folder picker.

Provision identity switching as actual platform integration: Linux units/processes specify the execution UID/GID and approved writable project/scratch/home/cache paths. On Windows, use a restricted-account execution service or a reviewed account-token process-launch path with required logon rights, profile/environment initialization, and ACLs. A Job Object groups processes but does not change their account identity. Verify the launched token/UID, not only stored metadata. See [Microsoft process launch under a user token](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw).

Native per-job network restrictions require a tested OS network-control mechanism; account/file ACLs and backend URL validation do not constrain arbitrary shell networking. If the chosen runtime cannot enforce a requested network policy, reject that combination or use an enforceable container/runtime. Onboarding records this capability explicitly.

For containers, use non-root execution, dropped capabilities, no privilege escalation, resource limits, and narrowly scoped mounts. Do not mount the Docker socket into a project. Container network access is an explicit policy; downloaded code does not gain dashboard or host-agent credentials. Native process tools and Docker access remain different privilege classes.

File APIs reject traversal, wrong-root paths, symlink/junction escapes, special devices, and cross-project access using OS-aware handle/path controls. Windows path rules include drive letters, UNC paths, case folding, reparse points, and alternate data streams. ZIP extraction/export cannot follow links outside the allowed root. User-generated HTML/SVG/content previews are sanitized or served without dashboard-origin privileges.

Endpoint configuration deliberately allows enrolled private LAN/VPN hosts. Protect provider probes and health checks from becoming arbitrary URL fetchers: validate scheme and port, check resolved targets against explicit permitted destinations, restrict redirects, and exclude infrastructure metadata endpoints unless a separately authorized integration requires them.

## 9. Repository structure and integration boundaries

Recommended repository packages:

| Path | Responsibility |
|---|---|
| `apps/web/` | React screens and browser transports |
| `apps/api/` | Fastify routes, auth, policy, brokers |
| `apps/worker/` | Durable orchestration and reconciliation |
| `packages/contracts/` | Versioned JSON/OpenAPI schemas and generated clients |
| `packages/providers/` | Inference/catalog/management adapters |
| `packages/policy/` | Permission evaluation with structured decisions |
| `packages/storage/` | Files, artifacts, checkpoints, exports |
| `agent/` | Go connection agent, supervisor, OS-specific implementations |
| `db/migrations/` | Reviewed forward migrations and recovery notes |
| `deploy/` | Compose, proxy, service installers, backup/restore scripts |
| `tests/integration/` | Real-service and fault-injection tests |
| `docs/` | Architecture decisions, setup, compatibility, operations, evidence |

Pin supported released versions during M00; do not use unpinned `latest` or development branches in production deployment. Version the agent protocol and keep an upgrade compatibility window. An incompatible agent can still be shown in inventory, but cannot receive commands until a supported path is restored.
