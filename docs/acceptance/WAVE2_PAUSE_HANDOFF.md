# Paused after the current integration work

The owner requested finishing current work and then pausing. **Building and test campaigns are paused. V1 is not complete.** No automation or automatic continuation was created.

## Completed validation work

| Evidence | Result and practical scope |
|---|---|
| `go-files.test.ts` | 4 passed on the updated actual Windows Go executable: real local collection, binary bytes/hash/conditional conflicts, separate read-only root, traversal/ADS/device/junction denial, hidden/untracked snapshot. No arbitrary native shell. |
| `go-tls-postgres.test.ts` | 4 passed: actual Go identity enrollment, actual native TLS/mTLS telemetry into PostgreSQL, durable sequence after connection-process restart, certificate revocation stopping ingestion. |
| `transport-postgres.test.ts` | 8 passed: real PostgreSQL signed RPC identity/digest/machine checks, disabled mutations, restore and epoch fencing, cancellation-before-enqueue, exact safety cancellation and narrow classified recovery reads. |
| `agent-relay.test.ts`, explicit deterministic provider fixture | 3 passed: actual CLI enrollment and signed mTLS Go relay, persisted agent steps, real file mutation/receipt/hash verification, immutable checkpoints/artifact, authenticated selected-file restore preserving unrelated later work, stale-preview rejection, restore replay, artifact HTTP download with host connection stopped. Only the provider is injected. |
| Existing Linux Go collector | Actual WSL Ubuntu executable returned schema 1/Linux observations with 24 available and 27 unavailable metric fields. No fabricated hardware values or retained hostname inventory. |
| Owners' focused current checks | Machines reports native TLS/PostgreSQL restore recovery round-trip and suite 10/10. Storage reports actual PostgreSQL writer/reconcile race 3/3. Platform reports real PostgreSQL credential rotation and final persisted delivery-authority checks for cancellation, grant revocation and changed fence before first delivery. Actions reports authenticated API → durable worker → signed mTLS Go Linux helper → actual dedicated Docker restart and independent status verification. These are separate component results, not an aggregate whole-suite release PASS. |

The first wave's clean-install/full-suite/build output remains in `LOCAL_EVIDENCE.md`, `local-node-test.tap`, and `local-build.log`. Those counts predate the second wave; a complete current aggregate release regression was not run after the pause request.

Final focused root and web TypeScript checks passed after the delivery-authority fixes. Platform reports three actual-PostgreSQL delivery-guard scenarios and four pure transport checks passed. Queue reports its previously executed six agent-boundary and four race checks passed; **two subsequently prepared file-boundary tests were NOT RUN successfully** because PostgreSQL was already stopped (`ECONNREFUSED`). They were not silently counted as passing and the server was not restarted after pause.

## Current actual-model result: FAIL

The final bounded actual Ollama `qwen3:0.6b` agent run ended **`failed / verification_failed`** after approximately 68 seconds and two actual inference requests. Job ID: `ab29873a-a491-4f8b-85cb-40bbf8ad9980`.

- `write_file` omitted required `expected_sha256`; the complete call was rejected and recorded `executed: false`.
- `verify_file` attempted the still-missing file; the actual Go read failure was retained as failed verification.
- `publish_artifact` used `mimeType` instead of `mime_type`; the call was rejected and recorded `executed: false`.
- The model finished without correcting these errors. **No host mutation operation was created.** An assistant's completion prose did not turn this into success.

Sanitized persisted steps and outcomes are in `actual-model-agent-result.json`; the final test output is `actual-model-final-attempt.tap`. Earlier invalid-call failure output is retained in `actual-model-first-attempt.tap`, with provider-side bounded diagnostics in `docs/providers`.

This is distinct from the provider owner's successful real chat/basic tool-round-trip probes. Passing a small capability probe does not prove this multi-step autonomous workflow. There was no silent model substitution. The separately proposed `qwen2.5:1.5b` trial was **not downloaded or started** because work was paused.

The attempts also found and led owners to fix real integration issues: migration SQL reserved-word usage, durable file-receipt normalization, strict schema rejection feedback, deterministic missing-file tool error feedback, and latest-per-target verification after repair. The final run still failed because the selected small model did not repair its invalid calls.

## Remaining work at pause

1. Finish the actual model-driven autonomous task gate using an explicitly selected model/configuration that follows the tool schema; preserve the failed attempt and create a new model/job identity for any alternative.
2. Run the full 180-second model-driven container sentinel with an actual startup counter, close owned dashboard tabs, interrupt API/worker and reconnect to the same operation without replay. **This campaign was not started.**
3. Integrate that actual agent's generated text/binary files and retained artifact links with actual container replacement. The host-files owner's actual Docker lifecycle preservation proof is a component precursor, not this full scenario.
4. Complete full recovery/host reboot/lost acknowledgement/cancellation/limits/storage-pressure scenarios across the configured Windows/Linux runtimes. Native Windows shell confinement still requires a safely provisioned execution identity; validation did not create an account/service or substitute the current user's unrestricted shell.
5. Exercise the completed second-wave UI in an actual browser against a persistent configured host/project/provider, including transfers, conflicts, instructions, checkpoints and restored artifacts. New dataset/API port 3021 and browser campaign were not started. The earlier metrics request-storm fix remains separately verified.
6. Complete all remaining first-release live gates: real SSH/SFTP and physically observed Windows/Linux desktop behavior, complete cross-host encrypted/key-restorable backup recovery, install/upgrade/retention rehearsal, current aggregate build/security/regression and required T01–T23 evidence. Review owner handoffs for source-level partial implementation items; local component checks do not waive them.

## Runtime state

All validation-owned Go supervisor/connection processes, temporary native TLS/API listeners and worker instances from completed tests stopped through their fixture cleanup. The new Windows PostgreSQL 18.4 cluster was shut down successfully after the platform owner's final in-flight security test; its active manifest was removed. No validation API was started on port 3021. The provider owner stopped its isolated Ollama container and retained its dedicated cache; actions cleaned its own Docker helper/proxy/processes. Operations owns shutdown/preservation of its separately configured Compose stacks.

Inactive ignored PostgreSQL test data/log directories remain. The first wave's recursive cleanup had been rejected by automatic approval review; **no rejected cleanup was retried**. No new destructive cleanup campaign was attempted at pause. Test credentials/keys belonged to disposable fixtures, not production configuration.
