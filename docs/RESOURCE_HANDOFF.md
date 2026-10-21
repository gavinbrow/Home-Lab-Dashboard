# Local resource handoff

The final actual T08 run passed and all acceptance consumers have ended. Validation, frontend and provider owners have confirmed their boundaries. **Final owner cleanup is confirmed.** Data, keys, volumes and historical unknown outcomes are preserved; no prune, recursive delete or refused-cleanup retry is part of this handoff.

## Confirmed completed cleanup

- Final job `6cc32e92-7393-411b-afb2-ef071a082b9b`: validation confirms its exact Go processes and worker exited, its base container stopped, zero writer locks and all provider permits released.
- Frontend: completed-state snapshot, host-off downloads and two reloads passed; Vite80574 and its owned tab closed, zero dashboard tabs/streams/writers. Prior export/1.5B/command-PTY sessions were already closed. Three unrelated user tabs remain untouched.
- Native PostgreSQL18.4 on56008: exact owned process/data root stopped through `pg_ctl`, port absent, data retained. [Cleanup evidence](acceptance/NATIVE_POSTGRES_CLEANUP.json).
- Historical 1.5B job `b96bd0da-3b20-4026-8f17-27d248e05f65`: existing audited owner/CSRF routes released exactly two uncertain provider reservations and its writer after proving zero host operations. Reconciliation returned `replayed:false`; no job resumed and the original interruption/history remained. [Before/after route audits](acceptance/phantom-qwen25-audited-recovery.json).
- All three storage T13 Go/connector pairs are stopped. Recovery/component tests closed their own processes, temporary roots and unique databases. Storage owns no transfer daemon.

## Exact final service boundary

Operations owns the shared API `6a942e1657e5` (3009/3449), isolated API `1b9197b21677` (3019/3459), PostgreSQL `97989b381218` (internal5432), PG proxy `039918c686e8` (loopback15439), and provider fixture `f12b51a20dd1` (11438). All were stopped under the acknowledged all-owner consumer END; no images, persistent files or volumes were removed. The never-started audit container `c44d4b175c74` is CREATED, StartedAt0001, with no mounts.

Earlier backup, restore, production-HTTPS, demo and Guacamole fixture services were already stopped. Protected roots and model data remain. The unrelated `hyperqwen_qwen-cache` is outside this scope and untouched. Final operations confirmation records both APIs, PG proxy, provider and successful T13 container exited, with PostgreSQL stopped last at07:24:52Z. [Exact final inventory](operations/LOCAL_FIXTURE_INVENTORY.md) distinguishes stopped services from retained state.

## Preserved lifecycle uncertainty

These two original unknown fixtures were never replayed, unlocked or rebound to the successful fixture. Their runtime identities, protected roots, journal databases, receipts, proof and backend writer reservations remain untouched.

| Item | First unknown attempt | Second unknown attempt |
|---|---|---|
| Parent root | `/tmp/homelab-validation-wave2/sentinel-18a4e2f5-5ad6-4539-9d31-29be4479f80f` | `/tmp/homelab-validation-wave2/sentinel-26b8d714-60da-4534-8222-fd6165d55a36` |
| Workspace | `21eec5d7-27a7-4d40-8e95-05662cd9a3cf` | `4f211366-ef3e-48e0-ad36-b9d0deb594dd` |
| Original operation/RPC/receipt | `6cb0d40a-d549-4255-88e3-8e32e1252cd0` | `58c8b0a5-acc1-46e5-a8c0-96ef883a60ad` |
| Outcome | `outcome_unknown/environment_isolation_unverified` | `outcome_unknown/environment_template_unverified` |
| Retained runtime | `c9683b9f288613054b2f2e885994a9423c1ea78b50d1991f6ec4dcacaea47ea9` | `71c293caf2e32757d01e2e6b81999c30e1e6fb1fe6eaff19ea6c63acc7f7bf3b` |

The project child is `/project` beneath each parent. Protected configuration and identity contents are not copied into this document. Elapsed time or a stopped helper is not proof of a resolved mutation. Cleanup requires explicit reviewed resolution and exact-root authority.

## Successful third lifecycle fixture

This separate parent is `/tmp/homelab-validation-wave2/sentinel-f08f115a-596b-422c-935c-4d6f21e82f43`, workspace `82d9f6e6-5747-496c-992c-97840f173f66`. Its restart/rebuild and replay succeeded, environment generation/revision became2/2, and jobs/reservations are zero. Replacement runtime `24d4bb7741effa6c3c3568e4a9225aa2640b66c3acc8d5fea6fb8d07a2896a18` was stopped only after its exact labels/root/bind and absence of consumers were owner-verified. It is not either unknown fixture. Preserve source bytes, evidence and central history.

The original read-only active-run inventory is retained at [OWNER_RUNTIME_INVENTORY.json](acceptance/OWNER_RUNTIME_INVENTORY.json); it is historical, not a current running-state claim. Never delete shared `/tmp/homelab-validation-wave2/data/artifacts`, keys or PostgreSQL as per-fixture cleanup. Platform owns no temporary process.
