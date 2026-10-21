# Saved actions — local implementation status

Saved actions have immutable revisions and strict typed parameters (enum, integer, boolean, and bounded character-class string). Command definitions identify an absolute executable and an array of literal or whole-parameter arguments. Parameters are never expanded into shell text. Supported string patterns are `^[A-Za-z0-9_.-]+$`, `^[A-Za-z0-9 _.-]+$`, `^[A-Za-z0-9]+$`, and `^[a-z0-9_-]+$`; arbitrary regular expressions are rejected to avoid pathological matching. Shell/control metacharacters and control characters are rejected in parameter values.

Routes under authenticated `/api/v1`:

- `GET /actions`, `POST /actions` (
ame`, `definition`).
- `GET /actions/:id/revisions`, `POST /actions/:id/revisions` (`expected_revision`, `definition`). Revision writes use optimistic concurrency.
- `POST /actions/:id/runs`: `revision`, `machine_id`, `workspace_id` or null, `profile_id` or null, optional `execution_identity_id`, `grant_id`, `parameters`, `idempotency_key`.
- `GET /actions/:id/runs` returns retained job outcomes; `GET /actions/capabilities` explains missing helpers.
- `GET /actions/targets`, `POST /actions/targets`: register protected target UUID, `machine_id`, display 
ame`, `kind` (`systemd`, `windows_service`, `docker_container`), `allowed_operations`. This registers configuration; the matching host target must be enrolled separately in protected host configuration. No native service name or Docker runtime ID is accepted by this API.

Definitions require explicit `machine_ids`; commands and command verification also require explicit `workspace_ids`. Nonempty `profile_ids` restrict invocation. Working directory is always the persisted workspace root. `limits` uses the shared Limits schema. `command` has `executable`, `args` (`{literal:"--suite"}` or `{parameter:"suite"}`), `cwd_policy:"workspace_root"`, and `env:{}`. Custom environment variables are rejected until an independently approved host environment allowlist exists. `verification` is null or a separately fixed command and expected exit code. Every request includes the exact revision to prevent silent retargeting. Stored permissions must permit `actions.run` and the selected machine/workspace/profile. Fixed command execution and command verification additionally require `run_command` in both captured/current grants and selected/captured profiles; `actions.run` alone never grants a general command capability. The signed host operation carries the saved action ID/revision/definition hash and the host independently checks both permissions. String parameters cannot introduce a leading command option.

Commands capture an explicitly selected verified execution identity. If omitted, an identity is captured only when exactly one verified owner/machine identity explicitly includes the workspace in its `config.workspace_ids`. An ambiguous or unconfigured selection stays unconfigured; it never silently switches identity when retried.

Definitions are platform-specific: Unix executable paths require an enrolled Linux machine; drive-qualified paths require Windows. Verification paths must match too. Systemd and Docker target controls require Linux, and SCM requires Windows. An unknown or mismatched machine OS is rejected; use separate definitions for each platform.

Runs capture the definition, resolved arguments, workspace revision/generation, grant snapshot, limits, affected target, and verification request in a durable `saved_action` job. The dispatch row and queue insertion share one database transaction. Owner-scoped idempotency keys bind to the original normalized request; retries return its job and changed requests conflict. Audit events omit parameter values. Verification remains 
ot_run` until actual host evidence establishes it.

The API never launches commands. The worker's saved-action handler uses the durable host-operation layer for fixed commands and trusted controls. Windows SCM, systemd and Docker controls require an independently enforcing, enrolled host helper. Helper definitions support only enumerated target UUIDs and `status`, `logs`, `start`, `stop`, or `restart`; submissions check owner, machine, kind and enrolled verbs. A mutating control requires a permitted status check unless a separate fixed verification command is configured. Container creation/rebuild is outside this helper definition.

The handler records stable primary and verification step IDs. It reserves both the action and helper target, so uncertain outcomes continue blocking competing control operations after worker lease loss. Lost acknowledgements reconcile the existing operation; unknown outcomes interrupt the job and retain reservations. Known outcomes release reservations. Service postconditions compare a separate host status receipt with `running` or `stopped`; fixed verification commands compare their actual exit code with the expected code. Verification events, job results and audits retain the evidence. Capabilities remain unconfigured/unverified until an actual receipt establishes helper evidence, and become stale after five minutes.

The host independently enforces local target enrollment, allowed grants/verbs, current policy, workspace generation and delegated OS identity; backend validation alone is not an OS boundary. Saved definition authors are trusted administrators: fixed binaries and arguments are configuration, not a sandbox. The shared `@homelab/actions` resolver is used by API/agent callers; the worker revalidates captured and current scope and rejects changed/tampered resolved definitions before new work.

Local unit coverage: typed argv resolution, injection rejection, target restrictions, shell/admin launcher exclusion, undeclared parameter rejection, and deterministic hashing. Configured-host acceptance remains a separate gate. The actual disposable proofs below cover Linux restricted native commands, one newly created transient systemd service, and one newly created Docker container; Windows SCM has not been exercised locally.

Validated locally: nine definition unit tests pass. One additional route/worker component test passes against a fresh temporary PostgreSQL database: revision immutability/CAS, historical revision capture, machine/owner/revoked-grant denials, denial audits, and honest unconfigured controls. Synthetic operation receipts additionally exercise acknowledgement loss and worker replacement, one primary launch plus distinct verification, passing postconditions and observations, reservation release, unknown-outcome interruption, retained target locks and no replay. These are real database/worker tests with explicitly synthetic host receipts. The shared `tests/integration/local-postgres.test.ts` additionally verifies authenticated HTTP submission, simultaneous identical requests producing one job/dispatch, changed-request conflict, and injection rejection. These tests do not prove live host execution.

Run 
px tsx --test apps/api/src/modules/actions/definition.test.ts`. For the route component test, set `HOMELAB_LOCAL_PG_URL` to an explicitly owned, throwaway loopback PostgreSQL instance whose user can create/drop databases, then run 
px tsx --test apps/api/src/modules/actions/routes.test.ts`. It creates and drops only its randomly named test database; without the variable the test skips.

## Actual disposable Docker proof

`real-docker.test.ts` passed through the authenticated HTTP action API, PostgreSQL dispatch and operation journals, current worker/action handler, signed mTLS relay, an enrolled Linux Go supervisor, and a newly created dedicated Docker container. Two concurrent identical requests returned one job; exactly one restart operation and one separate status postcondition completed. The immutable container ID stayed constant, its actual Docker start timestamp changed, and the independently observed postcondition was `running`. The test removed its own container, supervisor/connector processes and protected configuration directory afterward. No SCM or systemd service was modified.

Sanitized measured evidence is in [actual-docker-results.json](actual-docker-results.json). This is local component evidence on WSL/Docker, not acceptance for an owner's configured Windows/Linux homelab. The actual proof test is opt-in with `HOMELAB_ACTIONS_STACK=1` and assumes the explicitly owned `homelab-validation-wave2` stack, current Linux binary, protected signing/CA configuration, and its loopback PostgreSQL proxy. It retains only its uniquely owned database history in that disposable stack. It must not target an existing production stack.

## Actual restricted Linux and transient systemd proof

The opt-in `real-native.test.ts` passed using the scoped application database role, authenticated HTTP action submissions, current worker, signed mTLS relay and Linux Go supervisor. The fixed Python command and independent verifier ran as existing nobody UID/GID 65534; a sibling write was denied. Both operations retained before/after checkpoints, and the actual result.txt change retained a readable text diff artifact. Signed requests carried the immutable action ID/revision/hash and both actions.run and run_command permissions. Concurrent identical submissions returned one job, and injected parameters were denied. A separately created, uniquely named transient sleep service passed restart followed by an independent running-status check. No account or persistent service was installed. Sanitized measured evidence is in [actual-native-results.json](actual-native-results.json).

Machine installation generations are captured during action scope resolution, checked transactionally at queue insertion, and compared again before fresh execution phases; a reinstall cannot retarget an old action job. The temporary PostgreSQL regression covers this stale-generation denial.

Latest schema016 regression passed in 23.57 seconds using immutable generation-6 Linux helper SHA256 DE07A961BA5EA6B4EC10536BD35DFA9D8C478F360CAB56D50CEF88F05F8B941A, including the trusted identity-probe task budget correction and bounded same-invocation process-exit reconciliation. The host inner command/control schema correction now binds installation generation into the request hash and rejects missing or stale installed generations. Primary command, independent verifier, actual retained diff and disposable systemd restart/status all passed; own processes, transient units and unique directories were removed.

Remaining live gates: disposable Windows SCM and Windows restricted-account execution; each owner-configured restricted identity/target; external host power-loss acceptance. Custom command environment is explicitly unsupported until an independently enforcing host allowlist exists. Linux local proofs establish only their configured disposable fixtures.




