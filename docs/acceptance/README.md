# Acceptance evidence and real release gate

The baseline is `MD Files/07_ACCEPTANCE_TESTS_AND_OPERATIONS.md`. Implementation, local component checks, and full real-machine acceptance have separate statuses. No T01–T23 PASS is established by this directory or by building the application. The release remains **BLOCKED** until all mandatory real scenarios pass.

The owner selected **build locally; configure homelab hosts later**. All external real-machine gates are deferred pending configuration. This does not block local implementation, builds, typechecks, component tests or review. No live secrets or hosts are requested in this phase. A passing local development gate establishes a locally usable implementation, not a v1 real-machine release.

## Reproducible offline planning

From the repository root run `node tests/integration/plan.mjs`. It validates the unique T01–T23 registry and R01–R17 coverage, prints every real test as BLOCKED, and makes no network connection. To inspect sanitized inventory completeness, run `node tests/integration/plan.mjs --config tests/integration/config.example.json`. The example cannot establish access. Use an operator-owned configuration outside version control for real deployment references; do not put credentials into this file. The offline planner never authenticates or contacts the configured URL.

The machine-readable requirement/milestone mapping is `tests/integration/acceptance-map.json`. M05 direct-command evidence supports the execution substrate; full T08 requires the actual model tool loop at M10 and rerun at M14. M06 storage evidence supports the substrate; T13 requires actual agent-generated text and binary outputs and runtime replacement.

## Local PostgreSQL component gate

After `npm ci`, Windows users with explicitly selected PostgreSQL binaries can run `pwsh -File tests/integration/local-postgres.ps1 -PostgresBin 'C:\Program Files\PostgreSQL\18\bin' -Suite all`. The script initializes a new cluster under ignored test runtime storage, binds only 127.0.0.1 on an ephemeral port, runs the selected suite with temporary environment injection, stops its own cluster, and removes its exact owned data directory. It does not inspect an existing cluster, install services, or change system configuration. Local trust authentication is limited to this disposable loopback cluster; this is not production configuration. A PostgreSQL version compatible with the schema is required; the recorded local run used 18.4 while the deployment's PostgreSQL image is separately pinned.

For an already explicitly owned throwaway loopback server, set `HOMELAB_LOCAL_PG_URL` temporarily and run `npm run test:integration` or `npm test`. Each opted-in test creates and drops its own uniquely named database. Do not point this variable at a production server. Without the variable these database tests skip, and without `HOMELAB_LIVE_READONLY=1` the separately enrolled HTTPS check skips.

The actual-PostgreSQL checks cover migration idempotency, HTTP authentication/session/CSRF, concurrent submission and saved-action transactions, queue claims/fencing, unresolved writer locks, provider reservations, restore epoch fencing and persisted chat orchestration with an explicitly injected provider fixture. They do not establish a real inference endpoint or host execution.

## Missing access and configuration

No live inventory was supplied in the planning pack. These grouped prerequisites block the real gate:

1. Deployment: explicitly enrolled HTTPS control-plane URL, Linux host/version, persistent database/artifact storage, and protected login/CSRF secret injection method.
2. Machines: actual Linux and Windows machine IDs, OS/edition/build, agent/supervisor versions, execution UID/token identity, explicitly disposable roots, and allowed scratch paths. GPU details only where installed.
3. Remote access: backend-reachable SSH addresses, trusted host fingerprints, server-side credential references, guacd-reachable desktop endpoints, observed physical/remote classification, and operator display observation.
4. Provider/workspaces: actual adapter/version/model with passing tool probe, runtime pool and endpoint revisions, Windows/Linux existing-folder projects, Linux container storage identity/image digest/generation, and test profiles with fixed scope.
5. Fault/recovery: disposable test-service/container targets, specific allowed disconnect/reboot/cancellation/storage-exhaustion operations, isolated restore destination, separate backup device, and separately protected recovery material.

Never infer addresses or grants from sample names. Missing credentials are BLOCKED, never PASS. Do not read credential stores to discover them.

## Executable fixture and integration interface

`node tests/integration/survival-fixture.mjs ABSOLUTE_DISPOSABLE_ROOT OPERATION_ID 180` appends a flushed counter entry before producing one numbered log per second, text/binary outputs, and SHA-256 manifest. Run it only in an explicitly disposable project using the actual model-driven tool path for T08. The operation ID must be the supervisor's stable operation identity. A standalone short smoke test is local fixture evidence only. The counter is not a security boundary: corroborate it with the protected host ledger, boot ID, containment identity, and durable dispatch records. Reusing an operation ID intentionally increments the fixture counter, exposing duplicate launch.

Planned live harness contracts, after API stabilization: explicit opt-in target origin; cookie/CSRF injection through environment or protected file; timeout-bounded HTTP/SSE client with no cross-origin redirect; readiness and unauthenticated-denial checks; immutable context/idempotency/event replay assertions; manifest/ledger comparison; operator-attested browser closure and desktop observation; isolated fault commands gated by named disposable targets. No test may label an HTTP 200 or mock response as full real acceptance. No default test starts jobs, mutates hosts, restarts services, or reads secrets.

## Security and recovery review gates

- T01/T05: active tunnel/session revocation must close current access; token expiry alone is insufficient. Reject launch-ticket replay, altered object IDs, missing CSRF and mismatched WebSocket origin.
- T12/T18: lost acknowledgement keeps the original operation; changed request digest conflicts. Unknown operations retain the writer lock beyond worker lease expiry. No page refresh/reconnect/restore replays a mutation.
- T15: a cwd or Job Object is not confinement. Verify the real UID/token, ACLs and rooted path APIs; include symlink/junction races, archive escapes and supported network policy. Reject unenforceable restrictions.
- T11/T15: local wall/command deadlines and descendant cleanup must hold with browser closed and control connection lost. Offline cancellation is pending until proven, and container stop escalation preserves storage.
- T13/T14: demonstrate different old/new container IDs and incremented generation, matching persistent file hashes, original artifact links, untracked/binary recovery, protected manifests and outside-edit conflicts.
- T21/T22: receipt storage failure stops new launches; output truncation is explicit. Restore with dispatch disabled, reconcile host journals and rotate dispatch epoch before a fresh job. Offline-host backup remains partial without replacing the last complete status.

## Evidence record per test

Record outcome (PASS/FAIL/BLOCKED/NOT RUN/NOT APPLICABLE), test and requirement IDs, commit, exact component versions, configuration revisions, UTC start/end, sanitized machine/provider/workspace IDs, job/operation/event IDs, expected and observed results, file sizes/SHA-256 hashes, sanitized evidence paths, and remaining next action. Keep raw secret-bearing output outside tracked evidence. Screenshots supplement journals/hashes. NOT APPLICABLE needs capability evidence; it cannot waive required Windows/Linux workflows.
