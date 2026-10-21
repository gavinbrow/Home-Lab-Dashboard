# Local validation evidence

Initial inventory on 2026-10-20 America/Chicago: repository initially contained only the ten baseline Markdown files. No AGENTS.md was found in the repository or checked parent directories. No real machines, provider endpoints, Docker daemon, databases, or secret stores were contacted by this inventory.

`Get-Command node,npm,pnpm,go,docker,git,python,psql -ErrorAction SilentlyContinue` found Node/npm/pnpm/Docker/Git/Python on PATH; Go and psql were absent. Version commands returned Node v22.12.0, npm 11.15.0, pnpm 11.25.0, Git 2.48.1.windows.1, Docker CLI 27.3.1 ce12230, Python 3.12.10. CLI presence does not establish daemon/server availability or real integration support.

The acceptance planner is offline infrastructure, not a real acceptance test. Actual T01–T23 outcomes remain BLOCKED pending the explicit inventory and access described in README.md. Local build/typecheck/unit-test results will be appended after the monorepo scripts stabilize.

Executed local checks:

| Command/check | Observed result | Scope |
|---|---|---|
| `node tests/integration/plan.mjs` | Exit 0; 23 unique test mappings and all 17 requirements covered; all real outcomes BLOCKED | Offline planning only |
| `node tests/integration/plan.mjs --config tests/integration/config.example.json` | Exit 0; missing inventory reported; no connection attempted | Offline config validation only |
| `node tests/integration/survival-fixture.mjs <explicit local disposable output directory> local-fixture-smoke 1` | Exit 0; one flushed counter record; text and binary hashes independently matched with PowerShell `Get-FileHash`; generated smoke files removed | Fixture smoke only, 2026-10-21 03:01:34 UTC; does not satisfy 180-second real model-driven T08 |

Fixture binary SHA-256: `40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880`. Docker CLI is installed but operations reported the engine is stopped; it was not started for validation. No Go compiler or PostgreSQL CLI was available on PATH during initial inventory.

## Actual local PostgreSQL and HTTP evidence

Subsequent explicit tooling inspection found installed PostgreSQL **18.4** binaries at `C:\Program Files\PostgreSQL\18\bin`, outside PATH. Validation initialized a brand-new cluster in its ignored `.runtime` directory, listening only on 127.0.0.1 and an ephemeral high port. No existing database, password store, Windows service or remote host was inspected or modified. PostgreSQL 18.4 is local component evidence and differs from the deployment's pinned PostgreSQL version.

`HOMELAB_LOCAL_PG_URL=<explicitly owned loopback URL> npm run test:integration` passed **15**, failed **0**, skipped **1** (16 including nested tests). The skip is the external enrolled HTTPS live access test. Each actual database test creates and drops a uniquely named database and applies the real migration files.

- `local-postgres.test.ts`: actual Fastify HTTP listener and actual PostgreSQL; repeated migrations, readiness, anonymous denial, owner bootstrap, cookie flags, session lookup, bad CSRF/Origin denial with no conversation write, two simultaneous identical chat submissions yielding one job/event/outbox, changed payload conflict, queued cancellation idempotency, authenticated SSE replay after persisted cursor, original idempotent job returned after provider configuration changes, missing host-file adapter 503, concurrent saved action one dispatch/job, injection denial, logout revocation.
- `worker-postgres.test.ts`: concurrent independent claims, incremented replacement fence and no obsolete handler execution; unknown launch outcome preventing completion and retaining writer lock after lease expiry; second writer waiting; serialized provider capacity with uncertain reservation retained beyond expired lease; restore epoch fence preventing an old handler from committing completion.
- The worker also completed an explicitly injected chat-provider fixture and persisted inference, messages and deltas. A second deliberately interrupted fixture retained partial content and uncertain capacity. Reinvoking stale workers did not call either fixture again. This proves local database/orchestration behavior, **not a real provider/model or host-agent integration**.

`pwsh -NoProfile -File tests/integration/local-postgres.ps1 -PostgresBin 'C:\Program Files\PostgreSQL\18\bin' -Suite integration` independently initialized another fresh real cluster, ran the same 15-pass/1-skip suite, stopped it and removed its exact owned cluster directory (exit 0). The script supports `-Suite all` for the complete Node suite.

## Monorepo gate

| Command | Result | Limits |
|---|---|---|
| `npm run typecheck` | PASS, exit 0 | Root TypeScript and web TypeScript |
| `npm test` without PostgreSQL opt-in | Final platform run: 46 passed, 0 failed, 4 skipped (50 total) | Expected actual PostgreSQL and enrolled-live checks skipped; this run alone cannot establish DB behavior |
| `HOMELAB_LOCAL_PG_URL=<owned loopback URL> npm test` | Final validation run: 60 passed, 0 failed, 1 skipped (61 total) | Includes actions-owner immutable revision/CAS/foreign-owner/revoked-grant actual DB tests; sanitized full output in `local-node-test.tap` |
| `npm run build` | Final validation run: PASS, exit 0; Vite 761 transformed modules, 12.48 seconds | Bundle-size warning remains; Monaco/editor workers produce large chunks; output in `local-build.log` |

Initial `npm ci` performed by platform encountered Windows locking of esbuild while development tools were running; platform restored dependencies with `npm install`. After development tools stopped, platform reran **`npm ci` successfully** (17 seconds, 132 packages), then its independent final build and offline suite passed. Validation's final actual-PostgreSQL full suite and build above ran after that clean install. Security review separately classified two low audit findings in vendored Monaco/DOMPurify as local-baseline residuals; see its detailed review for advisories and upgrade conditions.

Full R01–R17/T01–T23 real-machine release outcomes remain **BLOCKED/deferred live configuration**. Actual local HTTP/database tests do not satisfy physical desktop observation, real Windows/Linux runner restrictions, browser-closed model-driven execution, runtime replacement, or full cross-host encrypted backup recovery.

## Browser integration and metrics regression

The frontend owner exercised the actual browser against a separate database on the disposable PostgreSQL cluster: owner bootstrap, restored session on reload, empty live overview, metadata-only machine creation and independent unavailable capabilities. Initial machine selection exposed a render-driven metrics-fetch loop in actual API logs. The owner fixed the history endpoint dependencies and abort behavior before the final local verdict.

Validation restarted the actual loopback API with aggregate request counters and the frontend owner repeated the browser flow. Initial Metrics mount produced **one** metrics request and remained at one across three consecutive 10-second snapshots. Changing the history range once produced **one additional** request; metrics remained **two total** across four consecutive 10-second snapshots, including navigation to Settings (counter capture completed 2026-10-21 03:13:54 UTC). This confirms the reported idle fetch storm was removed. See `docs/frontend` for screenshots and precise browser scope; it does not establish remote-machine telemetry.

## Runtime shutdown and cleanup

Frontend confirmed its Vite process stopped; validation stopped both API sessions it created and shut down its exact PostgreSQL cluster with `pg_ctl -m fast -w stop` (server stopped successfully). The ignored plaintext test-only browser credential/config manifests were deleted and their absence confirmed. No installed Windows service or pre-existing database was changed.

Automatic approval review rejected recursive removal of the verified owned `tests/integration/.runtime` directory twice with `blocked by policy` and supplied no more specific reason. Validation did not try another deletion mechanism. An inactive, ignored disposable PostgreSQL data/log directory therefore remains; the separately tested fresh-cluster runner had successfully removed its own other data directory. Retained data is test fixtures only, and the server is stopped.
