# Six development phases for v1

The original `MD Files/` planning pack remains the requirements baseline. Every phase below is a development increment of v1, not a separate release. Later spec phases (schedules, placement, multi-agent collaboration) follow v1 acceptance.

| Phase | Milestones | Requirements | Owners and parallel sections | Exit gate |
|---|---|---|---|---|
| 1 Foundations | M00–M01 | R08,R11,R12,R17; foundations all | Platform: inventory, decisions, npm workspace, shared contracts/schema; operations: deploy; validation: acceptance harness | Local reproducible install/typecheck, meaningful health/readiness; real Guacamole/OS identity proofs deferred with named blockers |
| 2 Identity and domain | M02–M03 | R01–R04,R14–R16 | Platform: owner bootstrap, sessions, CSRF, secrets, grants, immutable profile/project revisions | Local auth/policy tests; wrong host/revision rejected; actual HTTPS/revocation tests remain acceptance |
| 3 Hosts and durability | M04–M05 | R06–R09,R15 | Host agent: Go agent/supervisor; machines: enrollment/telemetry; queue: jobs/worker/ledger | Local ledger/idempotency/cancellation tests; actual Windows/Linux one-launch and identity proofs required before live activation |
| 4 Files and integrations | M06–M09 | R04–R05,R08–R14 | Storage: file/checkpoint/export; machines: history; remote: SSH/desktop; providers: catalog/chat adapters; frontend parallel using contracts | Local traversal/conflict/provider transport checks; real file replacement, SSH and desktop/provider gates deferred |
| 5 Durable agent work | M10–M12 | R02–R07,R10,R14–R15 | Queue: persisted loop and chat; actions: fixed control definitions; storage: review/restore; frontend: four selections/history | Agent/tools use grants, ledger and checkpoints; full T07–T19 needs configured hosts/provider, no fake completion |
| 6 Operations and release | M13–M14 | R01–R17 | Operations: backup/restore/deploy; validation: acceptance evidence; security: independent review; platform: integration | Local build/tests plus honest deferred report; v1 release only after applicable T01–T23 pass on actual machines |

Dependency order: contracts and migration baseline precede coupled implementations. Host and provider pure adapters, frontend shell and validation planning run independently. M05 execution substrate must be proven before dangerous M10 tool activation. M06 storage gates precede M12 restore. M13 backup tooling may be built early but usable restore proof remains a release gate.

Ownership: platform exclusively owns root package/config/lock, packages/contracts, packages/policy, db/migrations, API core/auth/domain/composition. Other owners exclusively own API module directories machines/jobs/projects/providers/remote/actions, apps/worker, apps/web, agent, packages/storage/providers/actions, deploy and associated docs. No shared-file concurrent edits. Module entrypoints and signatures are in CONTRACTS.md. Dependency/schema changes route to platform.

Current target agreed by owner: build runnable local code; configure real homelab hosts/providers later. Missing external credentials blocks specific live tests, not safe local implementation. Native execution, agent enrollment and desktop session paths remain capability-disabled unless enforcement prerequisites are established.
