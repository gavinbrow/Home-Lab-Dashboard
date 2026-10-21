# Running command log ingestion candidate

The immutable CORE018 source only ingested command logs after a terminal receipt. Its host journal already captured running output, but no other worker/API path copied that output into job_events. Therefore it cannot establish MD07 section 5 step 4 (durable acknowledgement and several visible logs before all browser tabs close). Any physical survival evidence from that version remains separate from a full T08 verdict.

The source-only candidate polls the same operation's signed GET /v1/operations/:id/logs?after=N while acknowledged/running/cancelling, through the existing queue handler reconciliation cadence. It never launches a replacement command. Host response shape remains {logs:[{sequence,stream,data,truncated}]}; each page is at most 256 chunks and each chunk at most 16 KiB. A terminal full page keeps the job pending with host_log_replay until a final bounded page is persisted. No loop holds a worker indefinitely to drain an unbounded spool.

Before requesting output, the worker checks its lease, captured installation generation and captured/current command grants/profile. Broker requests carry scopeGrantId, scopeTool run_command and jobGuard. After the network await, the publication transaction repeats authority checks under job/profile/grant/machine locks. Loss of lease cannot publish. Scope reduction cannot publish a late raw response. Existing operation receipt inspection/cancellation remains independent of denied log authority.

Canonical log events, the host sequence cursor and the cumulative retained-output ledger commit atomically. Earlier cursor replay cannot duplicate content or recharge budget. Host truncation and job retained-output limits are explicit. Optional interactive terminal transcript rules are unchanged; this path is supervised command audit output.

Prepared regression coverage: running logs visible before receipt completion; replacement worker same operation/no POST; grant revoked inside GET; lease fenced inside GET; terminal backlog greater than the former 1 MiB batch threshold and final-page drain. After the validation owner confirmed model END and CPU idle, the combined focused suite passed **50/50 tests**, zero failures/skips. This includes the five new running-log cases and the previous 45 budget/security/runtime checks. Root TypeScript validation also passed. Exact TAP output is retained in running-log-tests.tap. The earlier 45-PASS evidence remains the preceding coherent source version.


Transient final-drain correction: transport timeout/unavailability, 404 before spool readiness, rate limiting and server errors retain a pending host_log_replay state even when the process receipt is terminal. The replacement worker fetches the same cursor and original operation after reconnect. Permanent authorization denial remains explicit and separate. A prepared regression injects a 503 on the first final log page and proves the job waits, then drains successfully without a new POST. This case passed in the 50-test combined run after the CPU hold ended.


Executed command (explicit loopback PostgreSQL fixture; unique test databases removed afterward):

```powershell
$env:HOMELAB_LOCAL_PG_URL=(Get-Content tests/integration/.wave3-runtime/active-postgres.json | ConvertFrom-Json).databaseUrl
node --import tsx --test apps/worker/src/agent-boundaries.test.ts apps/worker/src/startup.test.ts apps/worker/src/reconcile-races.test.ts apps/worker/src/timing.test.ts apps/worker/src/budgets.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

No actual provider inference or native command was launched by these injected-host regression cases. Actual immutable CORE018 completed one 180-second physical command but failed required_verification_missing in the subsequent actual model round; it must not be relabelled as a full T08 pass. The live-log source fix requires a new coherent source image for actual acceptance proof.
