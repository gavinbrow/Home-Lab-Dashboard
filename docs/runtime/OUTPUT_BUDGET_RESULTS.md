# Cumulative runtime output boundary evidence

Local component verification, 2026-10-21. No actual model/native command was started by this unit.

```powershell
$env:HOMELAB_LOCAL_PG_URL=(Get-Content tests/integration/.wave3-runtime/active-postgres.json | ConvertFrom-Json).databaseUrl
node --import tsx --test apps/worker/src/agent-boundaries.test.ts apps/worker/src/startup.test.ts apps/worker/src/reconcile-races.test.ts apps/worker/src/timing.test.ts apps/worker/src/budgets.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

Node test result: tests 45; pass 45; fail 0; cancelled 0; skipped 0. PostgreSQL tests create and drop unique databases, using only the explicitly supplied loopback fixture. No fixture service restart or cleanup of another owner's workload was performed.

New checks cover:

- Atomic rollback does not spend budget, stable-key replay does not spend twice, changed content conflicts, multibyte UTF-8 is never cut mid-codepoint.
- An expired old lease cannot release, mark uncertain, or acquire a replacement worker's provider permit.
- Primary and verifier logs share one limit across replacement workers and repeated receipt/log reads; 12 observed bytes retain exactly 10 bytes once.
- Actual chat and agent handlers with injected adapters retain at most 4096 bytes across chunks/rounds. Unknown provider stop remains interrupted with uncertainty. Oversized complete tool JSON fails before any tool step or mutation.
- Two prepared file writes cannot each consume a full per-job cap; the second is rejected before dispatch. Replaying the first does not reserve again.

Existing current-profile, grant/secret revocation, two pending-tool cancellation/deadline, checkpoint boundaries, terminal late-publication/session revocation, bounded WS pending input, concurrency recovery, model-free API, attachment history/export, schema-startup, reconciliation-race and exact-token-preflight cases also pass in the combined command.

Scope: output accounting limits retained producer content, not provider spend or upstream emitted bytes. Generated-file reservations limit direct prepared file contents; arbitrary command-generated hard byte budgets remain explicitly unsupported. Actual native/PTy/model/API restart campaigns require separate evidence.
