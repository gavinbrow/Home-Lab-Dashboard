> RESUMED BY USER: implementation is active again. This file preserves the historical pause/checkpoint; current work is tracked in COMPLETION_TRACKER.md.

# Paused implementation handoff

**BUILD PAUSED BY USER.** All agents finished their in-flight units and stopped. Do not resume building, start a new acceptance campaign, download another model or schedule automatic continuation without the user's explicit instruction. **V1 is not complete.** The original ten files in MD Files remain unchanged.

## Important current failure

The latest actual Ollama qwen3:0.6b autonomous job **FAILED: verification_failed** after about 68 seconds and two actual inferences. The model omitted required expected_sha256 and used mimeType instead of mime_type. Invalid calls were retained as rejected/executed:false; verification of the missing file failed. **No host mutation was created.** Passing basic chat/tool probes and the deterministic provider-fixture agent test do not turn this into a successful real-model agent run. See [actual result](acceptance/actual-model-agent-result.json) and [validation handoff](acceptance/WAVE2_PAUSE_HANDOFF.md). The proposed larger model was not downloaded after the pause.

## Implemented

- Runnable npm TypeScript workspace: React/Vite web, modular Fastify API, separate durable worker, PostgreSQL migrations 001–010, Go Windows/Linux agent/supervisor, production/development deployment assets and operations tools. Shared versioned contracts, JSON-schema endpoint, owner-filtered APIs and CI are present.
- Owner bootstrap/login, opaque server sessions, CSRF/Origin protection, revocation, local recovery, encrypted credential storage and CAS rotation with encrypted version history. Grants and immutable profiles enforce current and captured scope, identity/model/secret/network/verification and budgets.
- Native mTLS enrollment/rotation/revocation and real telemetry ingestion; signed Ed25519 outbound RPC relay with durable request/result records, stable IDs, machine binding, current restore epoch, bounded frames and atomic writer/worker admission. Late first delivery rechecks cancellation, lease/fence, reservation and current scope. Unknown outcomes retain reservations.
- Persisted jobs/events, replay, cancellation/reconciliation and linked attempts; persisted plain chat and structured agent tool loop; provider adapters/catalog/favorites/probes/native management and capacity pools. Command/file/action execution uses the host ledger rather than the browser lifetime.
- Host-approved workspace registration, rooted files, conditional writes, instructions/history, quarantine, checkpoint manifests/diffs, selected restore, ZIP export, artifacts, attachments and separate environment/binding lifecycle operations. Native restricted-account and Linux-container launch code is present.
- SSH/xterm and confined SFTP paths, Guacamole gateway plus installed lease listener and active revocation; fixed typed saved actions and selected service/container controls. Expanded frontend forms/views use these APIs and keep four selections independent.
- Backup/readiness/history and fixed durable orchestration, encrypted restic capture/restore tools, maintenance ownership/fencing, identity/path recovery procedures, telemetry retention/rollups and deployment installers. The incomplete host-export coverage below prevents a full backup-completion claim.

## Verified evidence (component scope)

| Check | Actual result |
|---|---|
| Final platform root/web TypeScript check | PASS after migration010/admission edits |
| Final frontend tests/build | PASS: 4 tests; production Vite build; large Monaco chunks remain |
| Current transport signing/strict cancellation checks | PASS: 4; reviewer independently reran them |
| Actual PostgreSQL late first delivery | PASS: cancellation, changed fence and revoked grant after durable enqueue all denied with zero deliveries and explicit no-effects evidence |
| Actual PostgreSQL credential rotation | PASS: concurrent CAS, foreign-owner denial, encrypted prior version, usable decryption after key reload and wrong-key refusal |
| Actual built Windows Go rooted-files checks | PASS: 4; binary/hash/CAS, separate read-only root, traversal/device/junction denial and hidden/untracked capture |
| Actual Go/native TLS/PostgreSQL | PASS: 4; enrollment, real samples, durable sequence restart and certificate revocation; machines' focused TLS/restore suite 10/10 |
| Deterministic provider fixture → real worker/mTLS Go/files | PASS: 3; persisted tool/file/receipt/checkpoint/artifact path, selected restore/conflict/replay and artifact download with host disconnected. Provider was injected |
| Actual Linux Go → dedicated Docker action | PASS: authenticated API/durable worker/signed relay restart and independent status verification; concurrent submissions produced one job. See docs/actions/actual-docker-results.json |
| Native/host component checks | Go tests/vet PASS; actual WSL dedicated identity/confinement proof, Docker lifecycle/hash and WAL journal-restore components passed. Windows credential-backed native/SCM execution remains unverified |
| Actual provider | Ollama 0.40.6/qwen3:0.6b provider components 7/7 and fixture checks 18/18; actual vision request returned expected unsupported HTTP400. Full actual agent result is the FAIL above |
| Remote gateway/SFTP | Actual Linux chroot fixture passed; installed Guacamole listener integration test passed 1/0 in 33.677s for its executed branches. Long-delay unknown-tunnel proof remains unproven below |
| Focused safety reviews | Writer barrier 3, job-reconcile barrier 4, inference authorization boundary 6, backup lease 1 and Python backup 7 passed per owner/reviewer evidence. See docs/security/REVIEW.md |

These are separate component results. A complete aggregate regression/build/install campaign was not rerun after the pause request. First-wave full-suite counts are historical evidence, not current whole-project acceptance. Two low Monaco/DOMPurify audit entries remain documented; there is no unconditional security or production GO.

## Still needs implementation

1. Complete the fixed-root **host state bundle exporter** and chunked journal transfer beyond the current bounded 32MiB path. Current online host backup reports journal-only/incomplete coverage. Full host identity/config/journal/spool/root coverage cannot be claimed yet.
2. Implement the restricted workspace **PTY/ConPTY terminal** and process-lifetime writer reservation; current human SSH and durable command submissions are different workflows. Complete the resizable conversation project/files pane.
3. Finish the explicit owner-reviewed **accept_partial** API/UI for known partial filesystem effects. Host/adapter support exists, but the protected recovery grant, reviewed current manifest and audit reason must not be replaced by a generic unlock or agent tool.
4. Add **reference-aware blob garbage collection** and complete log/retention presentation. Finish bounded transfer progress/cancellation and any needed chunk/resume service; current uploads are bounded staged one-request transfers.
5. Bind capability probe staleness to observed **server/model version/digest**, rather than only configuration revision. Wire provider activity/performance readouts into the UI.
6. Complete remaining UI/API ergonomics: saved historical context application, attachment-history/export integration, older job pagination and authoritative active-versus-waiting durations. Validate final cross-module route shapes. See docs/frontend/VERIFICATION.md for exact gaps.
7. Finish queued backup deployment: the handler/API exist, but the default Node worker lacks pg_dump/Python/restic and destination mounts/configuration. The tool image/deployment glue and actual queued-backup proof are incomplete. Separate the app DML role from the migration/schema owner; the app is nonsuperuser but remains database owner. Complete real host remapping/new restored job and final proxy/install/update/retention proofs. See docs/operations/PAUSE_HANDOFF.md.
8. Finish command checkpoint-to-file_changes/text-diff publication and the model-free manual command submission shape. Fixed-executable saved actions still need their host run_command/actions.run permission integration proof. Never-delivered expired RPCs currently require explicit linked retry; no automatic renewal is claimed. Token usage is observational where exact counts are unavailable; unsupported command file-quota and network-allowlist modes are rejected. Two newly prepared checkpoint-boundary tests were not run after PostgreSQL stopped. See docs/runtime/IMPLEMENTATION.md.
9. Reconcile final cross-module contracts and rebuild only after an explicit resume. Source and disposable image snapshots changed during parallel work; an old test image may not contain final guards. No final current whole-project aggregate was run at pause.

## Still needs testing or external configuration

- Repair/verify a successful actual model-driven task without weakening required preconditions or silently switching models. Then run the **180-second all-tabs-closed sentinel**, actual startup counter, API/worker interruptions, lost acknowledgements, full cancellation/descendant/limit/storage-pressure drills and actual agent-generated text/binary container replacement. That campaign was not started.
- Exercise the expanded Wave2 UI in a browser against the composed current API, enrolled host/workspace, provider and desktop gateway. Its source compiles/builds; Wave2 browser integration was not run. The earlier metrics request loop was fixed and separately shown bounded.
- Prove the Guacamole **unknown late tunnel beyond 20 seconds** while the target remains alive. The raw monitor did not acknowledge sync and guacd idle timeout confounded that phase. Future monitor must acknowledge sync and prove liveness before revocation. No new attempt was made after pause.
- Complete full cross-host encrypted restore with all advertised coverage, usable secrets, rotated dispatch trust, retained unknown locks, no historical replay and a new harmless job. Fixed-set/native/database/encrypted component drills do not waive missing host-export code or full release T22.
- Configure actual owner-designated Windows/Linux accounts/ACLs, SSH/SFTP and observed desktop modes, GPU references, provider versions, backup destination and key escrow. Installed LM Studio/vLLM and Windows credential-backed native/SCM paths have no actual configured-service proof. Genuine unsupported platform metrics/features must remain unavailable with evidence.
- Run fresh install/upgrade/protocol/retention rehearsals and the applicable T01–T23 release matrix. Keep failed, blocked, unrun and passed distinct.

## Resources and restart boundary

Platform owns no running listener, worker, database or test process. Validation stopped its native PostgreSQL cluster and all Go/API/TLS workers and removed active manifests. Provider stopped the isolated Ollama container and retained its dedicated model cache/volume; actions cleaned its temporary helper/proxy; frontend has no Vite/browser session; machines, storage and security report no owned background resources. Operations stopped all shared fixture containers; its final docker ps was empty and fixture leases were zero. Preserved roots, volumes and caches remain. Exact final operations state is in docs/operations/PAUSE_HANDOFF.md.

Inactive test data, caches, binaries and volumes may remain intentionally. Earlier recursive cleanup was rejected by automatic approval review; no rejected deletion was retried. Runtime/cache paths are excluded from source and Docker contexts. Do not delete retained data or use down -v for tidiness.

On an explicit resume, read this file, REMAINING_WORK.md, the latest security issue table and the owner handoffs first; check stopped resources and schema 001–010; finish known code gaps, then rebuild and run focused regressions plus the missing integrated acceptance. No automatic resume is configured.
