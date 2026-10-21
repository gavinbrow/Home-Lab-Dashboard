# 06 — Step-by-step implementation sequence

## 1. How to execute this roadmap

Complete M00–M14 for the working first version. Each milestone has dependencies, concrete outputs, and a pass condition. Maintain `docs/IMPLEMENTATION_STATUS.md` with requirement IDs, implementation status, validation evidence, and remaining blockers. Use `planned`, `in progress`, `implemented`, `verified`, or `blocked`; do not collapse implementation and real-machine verification into the same status.

Maintain a decision log for departures from the recommended stack. Repository constraints may justify another framework; they do not justify weakening persistence, authorization, recovery, or truthful capability reporting. Use small mergeable changes with clear ownership.

Early milestones may run the component/substrate portion of a release test before the full agent/UI path exists. Record such evidence as a component check, not a PASS for the entire release test. Complete full end-to-end tests only after their stated dependencies are implemented, and rerun the integrated path at M14.

## 2. M00 — Inventory, version selection, and risk proofs

**Dependencies:** none. **Requirements:** R08, R11, R12, R17.

1. Inspect the repository and existing deployment before creating files or selecting package versions. Record any existing backend, frontend, database, or remote-access components worth retaining.
2. Record the real control-plane Linux host, one Windows host, one Linux execution host, at least one GPU host where available, actual model provider/model, and test project locations. Machines may fill multiple roles; IDs and roles must remain explicit.
3. Record Windows edition/build, Linux distribution/desktop/display server, SSH/SFTP availability, runtime identity, and available container engine. Mark unknowns instead of guessing.
4. Choose supported released versions for Node, Go, PostgreSQL, Guacamole/guacd/extensions, Docker, editor/terminal packages, and provider adapters. Pin versions/digests and retain upstream references.
5. Create sanitized live-test configuration and a secret injection method. Never commit credentials or include them in fixture data.
6. Prove two high-risk interfaces with minimal disposable harnesses: authenticated Guacamole launch/session revocation, and Go supervisor process-group launch/cancellation on both operating systems. Prove Windows restricted execution identity before advertising native workspace shell confinement.
7. Write architecture decisions for four selections, project storage, durable queue/host ledger, desktop behavior, and first-version platform support.

**Outputs:** inventory, compatibility matrix, initial decision log, test credentials references, two recorded integration proofs. **Gate:** unknown/missing host capabilities are named blockers; no implementation agent substitutes a mocked result for either proof.

## 3. M01 — Repository, contracts, and runnable services

**Dependencies:** M00 decisions. **Requirements:** foundations for all.

1. Create or adapt the repository layout in document 02. Keep API, worker, host agent, provider adapters, and frontend boundaries explicit.
2. Add reproducible dependency lockfiles, formatter/linter/type checking, Go build, basic CI, and `.env.example` containing placeholders only.
3. Define versioned contracts for machines, capabilities, projects, run context, jobs, operations, events, artifacts, permission decisions, and errors.
4. Establish schema migration tooling and a first empty PostgreSQL database. Add health/readiness endpoints with meaningful dependency checks.
5. Produce development Compose configuration with persistent database/artifact mounts. Keep demo services in a separate profile/project.
6. Document fresh setup, normal startup, graceful shutdown, and the difference between stopping services and deleting storage.

**Outputs:** compiling services, generated API client/contracts, reproducible development stack. **Gate:** a fresh checkout starts without undisclosed local files; restarting API/worker retains database state.

## 4. M02 — Login, secrets, and authorization skeleton

**Dependencies:** M01. **Requirements:** R01, R15.

1. Implement first-owner bootstrap with a short-lived setup secret or local setup procedure; disable bootstrap after use.
2. Add password hashing, rate-limited login, server-side sessions, logout/revocation, CSRF defenses, WebSocket origin checks, HTTPS proxy settings, and local account recovery. Optional TOTP may be included; do not make unimplemented SSO a dependency.
3. Add encrypted secret storage with a separate master key and versioned credential references. Disable sensitive request/response logging.
4. Implement policy evaluation over user, tool, machine, workspace, profile, job scope, and current revocations. Return structured reasons suitable for the interface.
5. Add audit events for login, secret changes, permission changes, and denials. Use resource ownership checks even with one owner so object-ID substitutions cannot bypass scope.
6. Verify the frontend receives only credential presence/status, never a saved secret value.

**Outputs:** working login/settings foundation and backend policy service. **Gate:** unauthenticated HTTP/WebSocket access is denied; logout invalidates active access; forbidden resources remain forbidden through direct API calls. Tests T01 and T15 begin here.

## 5. M03 — Core records and project ownership

**Dependencies:** M02. **Requirements:** R02–R04, R14–R16.

1. Add migrations for machines/connections, provider/model definitions, profile revisions, projects/workspaces, execution identities, artifacts/checkpoints, and audit references.
2. Implement immutable revisions for profile instructions and project instructions. Store defaults separately from explicit per-run selections.
3. Define project storage ownership: machine ID, canonical root or external volume ID, runtime mount path, quota, retention policy, and backup coverage.
4. Add server-side validation of model/profile/target/workspace compatibility. Reject wrong-machine roots and unsupported runtime combinations.
5. Define file-object/content-hash and artifact storage APIs without tying bytes to API container storage.
6. Build simple administrative CRUD views sufficient for configuration; defer polish until real integrations exist.

**Outputs:** durable domain records and validated selection contract. **Gate:** API tests demonstrate separate selections and immutable historical revisions; project deletion cannot be invoked by rebuilding an environment.

## 6. M04 — Windows/Linux host enrollment and telemetry path

**Dependencies:** M02–M03. **Requirements:** R08–R09.

1. Implement the Go connection/monitoring agent and systemd/Windows service installation paths. Use a protected local data directory.
2. Add single-use enrollment, certificate issuance/rotation/revocation, protocol negotiation, machine identity, and boot identity.
3. Establish outbound mTLS streaming with reconnect/backoff, bounded local buffering, sequence IDs, and separate traffic classes for telemetry versus operation acknowledgements.
4. Collect CPU, RAM, per-volume disk, per-interface network, agent health, and supported per-GPU observations. Preserve unavailable fields and collection errors.
5. Persist observations with device IDs, units, observed/received times, source, sample interval, and quality/stale information.
6. Implement selected HTTP/TCP/service health checks with fixed destinations and bounded timeouts.
7. Enroll the actual Windows and Linux hosts; compare observations against local references.

**Outputs:** two enrolled live hosts and an independent capability inventory. **Gate:** monitoring works without SSH/desktop; stale samples and unsupported sensors are represented accurately. T02 and T03.

## 7. M05 — Durable queue, host supervisor, and reconciliation

**Dependencies:** M03–M04 and the M00 execution proofs. **Requirements:** R06–R07, R15.

1. Add jobs/attempts/steps, operation receipts, dispatch outbox, ordered events, workspace locks, resource reservations, and idempotency constraints.
2. Implement short queue-claim transactions, lease generations, dispatch fencing, state-transition validation, and periodic reconciliation.
3. Implement the independent host supervisor with SQLite receipt journal, stable operation IDs/request hashes, boot/process containment identities, local stdout/stderr spool, and durable results.
4. Launch Linux jobs in controlled process groups/systemd units and Windows jobs in tested Job Objects under the selected restricted identity. Separate privileged administrative helpers from arbitrary project commands.
5. Add cancellation with grace/force stages, child-process verification, time/output/resource limits, and explicit cancellation-pending states when a host is unavailable.
6. Add SSE event replay and current snapshots. The API returns a job ID promptly and never waits for task completion to own its lifetime.
7. Inject lost acknowledgements, worker crash, network loss, full receipt storage, and launch ambiguity. Reconcile the same operation instead of creating another.
8. Ensure unresolved mutations retain workspace locks after orchestrator lease expiry. Define how an owner can inspect and resolve an unknown outcome.

**Outputs:** durable background-command path and Jobs view. **Gate:** a direct supervised sentinel command executes once through browser closure, API restart, worker loss, and dropped acknowledgement; uncertain launch outcomes remain interrupted. Run the execution-substrate portions of T09–T12 and T21, plus a direct-command precursor to T08. Full model-driven T08 is a gate at M10, not a dependency for starting M10. Do not build the agent tool loop on an unverified execution foundation.

## 8. M06 — Persistent workspaces and file interface

**Dependencies:** M03–M05. **Requirements:** R04–R05, R14–R15.

1. Register existing Linux and Windows test folders without moving or rewriting their contents. Verify actual execution-account access and approved roots.
2. Implement dedicated Linux container environments with workspace-owned external storage, deterministic mount paths, labels/IDs, image digests, and generation numbers.
3. Build traversal-resistant file APIs and editor conditional writes. Add upload staging, streaming downloads, recoverable delete, conflict handling, and bounded file listing.
4. Implement text/code/Markdown/JSON/CSV/image/PDF previews with unsupported-format handling and isolated/sanitized active content.
5. Implement checkpoint manifests/blobs covering tracked, untracked, and binary files; capture existing files before first agent modification.
6. Add project terminal attachment, editable versioned instructions, and queued ZIP export from a consistent capture.
7. Add Restart, Rebuild, Remove Environment, Archive, and Delete Files as distinct actions. Rebuild preserves storage and refuses unresolved active mutations.
8. Register outputs as immutable retained artifacts; verify their checksums before marking uploads complete.

**Outputs:** both workspace modes with real persisted data. **Gate:** replacing the container changes its runtime ID but preserves file hashes, instructions, artifacts, and project identity; editor conflicts and path escapes are handled. Run file/storage portions of T06 and T15 and a direct-command precursor to T13. Full agent-generated T13 follows M10; full checkpoint-review/restore T14 follows M12.

## 9. M07 — Machine dashboard and historical observability

**Dependencies:** M04–M06. **Requirements:** R08–R10.

1. Implement onboarding wizard state and individually retryable monitoring/SSH/desktop/runner tests.
2. Add machine tiles, capability indicators, update ages, service health, and current/historical charts.
3. Add historical retention/rollup tasks using server-side scheduling or maintenance commands. Preserve min/max/mean/count and gaps; counter resets cannot produce negative network/disk rates.
4. Add per-GPU panels keyed by stable device ID, including VRAM, utilization, temperature/power where supported, and unavailable reasons.
5. Add service logs, registered container inventory, queue/spool diagnostics, and warnings for stale observations or storage pressure.
6. Verify healthy monitoring persists visually when SSH or desktop fails.

**Outputs:** operational overview on real data. **Gate:** no random/demo values in live responses; history survives reload/restart; capabilities fail independently. T02–T03 and T20.

## 10. M08 — SSH, SFTP, and browser remote desktop

**Dependencies:** M02, M04, M06; M00 Guacamole proof. **Requirements:** R08, R10–R11.

1. Implement SSH connection records, key/password secret references, host-key enrollment and mismatch handling.
2. Add xterm.js with backend SSH transport, PTY resizing, bounded replay, disconnect grace period, and visible session identity.
3. Detect Windows shell and use correct OS-specific invocation/argument handling. Verify SFTP independently; show actual filesystem roots.
4. Implement **Run as background job** as an explicit pre-execution submission to M05. Do not relabel an already running interactive command as durable.
5. Deploy matching Guacamole/guacd/auth-extension versions and authenticated proxy paths. Keep guacd internal.
6. Implement scoped desktop launches, documented JSON authentication, active tunnel registry, logout/revocation, replay protection for app launch tickets, and restricted connection definitions.
7. Test the available Windows desktop server and selected Linux desktop mode. Record physical-sharing versus remote-session behavior by observing the actual local display.
8. Integrate a desktop panel or dedicated authenticated tab with visible machine/session context.

**Outputs:** browser access to actual hosts. **Gate:** T04–T05 pass; changing a URL/connection ID cannot open an unauthorized machine. Desktop token expiry is not used as a substitute for active-session revocation.

## 11. M09 — Providers, model catalog, and streaming chat

**Dependencies:** M02–M05. **Requirements:** R12–R13.

1. Implement the provider adapter contract, secret references, endpoint normalization, and independent connection/auth/catalog/inference tests.
2. Add generic compatible Chat Completions; native Ollama; LM Studio compatible inference plus native management; verified vLLM compatible configuration.
3. Add discovery, manual exact IDs, favorites, capabilities and versioned smoke probes. Unknown capability and failed capability remain different.
4. Add independent catalog/reachability/residency/activity fields, with source and age. Group aliases for one inference server into a shared concurrency pool.
5. Implement background model load/unload/download actions only when supported, with progress, capability-specific controls, and accurate cancellation semantics.
6. Implement persisted chat/message/attachment streams, reconnect-by-cursor, stop/regenerate, partial/interrupted answers, and truthful requested/resolved model labels.
7. Collect provider timings/token counts when supplied; distinguish queue time, load, first content, prompt processing, decode, and end-to-end speed.
8. Verify the real installed local provider, and any actual compatible endpoint the owner supplies. Keep unconfigured adapters labeled unverified.

**Outputs:** working chat and model-management surface. **Gate:** T16–T18; no silent fallback model and no tools executed from plain code blocks.

## 12. M10 — Profiles and durable agent tasks

**Dependencies:** M05–M06, M09. **Requirements:** R02–R07, R14–R15.

1. Add profile create/edit/duplicate/archive with instructions, permitted tools/machines/workspaces, default models, budgets, and required verifications.
2. Build the four-selector context bar and server-generated resolved context. Plain chat can select no execution target.
3. Persist agent loop steps and context snapshots. Validate complete structured tool calls before dispatch; never execute incomplete streaming arguments.
4. Implement `read_file`, `list_files`, `apply_patch`, `run_command`, `inspect_machine`, and explicitly granted service/container tools through the shared policy and operation ledger.
5. Acquire the workspace writer lock for modifying runs; preserve it through disconnects and unresolved outcomes. Record file manifests around shell tools.
6. Feed bounded results back to the model; link large logs/artifacts; enforce step/time/token/output budgets.
7. Persist scope grants for routine work, recheck restrictions/revocation at dispatch, and show concrete scope-expansion requests only when necessary.
8. Save verification results and a factual final summary with changed files, executed commands, affected systems, and unverified items.
9. Run the full browser-closure and container-replacement agent scenarios against the real provider and machine.

**Outputs:** end-to-end autonomous project work with durable evidence. **Gate:** full T07–T08, T13, and agent/policy portions of T15 pass; a task can finish with no browser open and its outputs can outlive the container. Validate command/file audit now; full saved-action T19 follows M11.

## 13. M11 — Supported controls and saved parameterized actions

**Dependencies:** M05, M07–M08. **Requirements:** R10, R14–R15.

1. Implement enumerated Linux systemd and Windows SCM adapters with status/start/stop/restart and bounded logs.
2. Implement approved Docker container actions and project-container lifecycle through the trusted broker. Validate mounts/devices/namespaces if creation is allowed.
3. Add saved action revisions with typed parameters, fixed executable/script, argument arrays, target restrictions, working-directory policy, limits, and postcondition checks.
4. Route all actions through durable jobs with stable operation IDs and auditable effects.
5. Validate parameter injection attempts and scope denials using disposable services/containers, then expose the actions in machine/project views.

**Outputs:** useful repeatable operations. **Gate:** T19; routine allowed operations run without repeated permission prompts, while unauthorized targets are denied by both backend and local helper.

## 14. M12 — Change review, checkpoints, and complete project export

**Dependencies:** M06, M10–M11. **Requirements:** R05, R14.

1. Implement text diffs, binary metadata, added/deleted file records, affected-system links, and verification status in both job history and chat.
2. Add selected-file and whole-checkpoint restore with pre-restore snapshot, conflict review, and write-lock enforcement.
3. Verify recovery of tracked text, untracked text, ignored/binary output, deleted files, and pre-existing user changes.
4. Complete ZIP export with explicit inclusions/exclusions, link-handling rules, capture consistency, and authenticated download.
5. Add retention/garbage-collection rules that retain referenced blobs and expose expired logs distinctly.

**Outputs:** reviewable, recoverable project work. **Gate:** T06 and T14; Git-only recovery is insufficient if generated or untracked files would be lost.

## 15. M13 — Backup, restore, deployment, and operations

**Dependencies:** M01–M12. **Requirements:** R16–R17.

1. Create production Compose/proxy settings with explicit persistent mounts, health checks, resource budgets, and no default demo mode.
2. Add graceful shutdown/drain, certificate/credential rotation, safe upgrades, and protocol/migration compatibility checks.
3. Implement the backup command: consistent PostgreSQL export, blob/manifest capture, remote project coverage, safe SQLite journal backup, encrypted separate-device storage, and recovery-key procedure.
4. Implement restore mode with dispatch disabled, identity/path remapping, integrity checks, and host ledger reconciliation. Rotate the control-plane dispatch epoch before permitting recovered workers to send new operations.
5. Restore into an isolated instance and prove settings, profiles, credentials, definitions, chat, jobs, checkpoints, artifacts, and project files are usable.
6. Document recovery point/time targets, actual measured restore duration, retention/storage needs, and incomplete coverage warnings.

**Outputs:** deployable stack, operational runbooks, tested backup set and restore report. **Gate:** T22–T23; a backup job reporting success without a usable restore does not satisfy release acceptance.

## 16. M14 — Complete real-machine acceptance and release

**Dependencies:** all previous milestones. **Requirements:** R01–R17.

1. Run every applicable test in document 07 with recorded machine IDs/versions and real job/operation/artifact IDs.
2. Distinguish passed, failed, blocked, not run, and not applicable. Give evidence for every unavailable capability.
3. Resolve mandatory failures; rerun only the affected tests and regression checks justified by the change.
4. Verify demo isolation, denied scopes, secret handling, failure recovery, stale metrics, and multi-GPU display where supported.
5. Complete fresh-install and upgrade rehearsals. Check that shutdown/rebuild/replacement does not remove persistent files.
6. Publish the implemented feature matrix, compatibility matrix, unresolved optional limitations, and quick-start/restore instructions.

**Release condition:** the working first version meets all R01–R17 gates on the actual configured machines. A required test blocked by absent access remains an explicit release blocker, even if local code is otherwise finished.

## 17. Parallel implementation after contracts stabilize

| Track | Main ownership | Can run alongside | Integration dependency |
|---|---|---|---|
| Platform/backend | Auth, schema, queue, policy, orchestration | Host-agent and frontend contract work | Owns shared migrations/contracts |
| Host agent | Enrollment, metrics, OS execution, filesystem boundary | Provider adapters and frontend | Stable operation/capability schemas |
| Remote access | SSH/SFTP and Guacamole gateway | Providers and project UI | Auth/secret/connection APIs |
| Model integration | Providers, capability probes, metrics, chat transport | Machine dashboards and files | Queue/event/policy APIs |
| Frontend | Screens/context bar/editor/history | Backend work against explicit fixtures | Real adapters replace fixtures before acceptance |
| Validation/operations | Fault fixtures, test report, backup/restore, installers | Every track | Actual machines required for release gates |

Do not assign different agents simultaneous ownership of the same migrations, policy engine, job state machine, or file. One lead resolves contract changes and integrates tests.

## 18. Later phase implementation order

### Phase 2 — schedules, alerts, templates, and previews

1. Add schedules that create ordinary jobs. Persist schedule revision, IANA timezone, next occurrence, and an idempotency key per planned occurrence. Define DST, missed-run, catch-up, overlap, and downtime behavior; default to skipping stale occurrences or a single explicit catch-up, not an unbounded burst.
2. Add alerts over observed health/metrics with dwell time, hysteresis, cooldown, stale-data handling, and acknowledgements. Separate service unavailable from no recent observation.
3. Add opt-in notification destinations with test messages, secret storage, delivery history, rate limits, and no confidential log dumps by default.
4. Add environment templates with pinned image/build recipe, declared persistent mounts, tools, resource/network policy, and migration notes. Rebuild retains project data.
5. Add private web previews through authorized runner/proxy routes. Use a separate origin, restricted ports/targets, scoped sessions, and explicit start/stop lifetime; generated pages cannot inherit dashboard-origin privileges.

### Phase 3 — resource-aware placement

1. Collect reliable machine/runtime capacity and workload observations, including uncertainty from external clients.
2. Add declared CPU/RAM/GPU/VRAM needs and reservations with priority/fairness policies.
3. Propose compatible placement while respecting workspace ownership; move files only through an explicit transfer plan.
4. Add provider-aware model loading/prewarming/eviction with active-user protection and measured benchmarks.
5. Test overcommit, stale capacity, multiple GPUs, canceled reservations, and competing external workloads. Do not combine GPU memory into a single usable pool unless the inference runtime actually supports that placement.

### Phase 4 — multi-agent collaboration and extensions

1. Add parent/subtask relationships, individual agent scopes, shared budgets, and attribution.
2. Use separate project branches/worktrees or copies for parallel edits; retain checkpoints and conflict handling for binaries/untracked data.
3. Add reviewable merges and explicit conflict resolution before touching the authoritative workspace.
4. Add optional MCP/CLI/external-agent adapters behind the existing job/policy/audit contract.
5. Add additional users/roles only after ownership isolation and collaboration permissions have acceptance tests.
