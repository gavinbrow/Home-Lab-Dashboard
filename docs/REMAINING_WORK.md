> RESUMED BY USER: implementation is active again. This file preserves the historical pause/checkpoint; current work is tracked in COMPLETION_TRACKER.md.

# Remaining v1 work — historical pause inventory

**Historical pause checkpoint, superseded by explicit user resume.** See COMPLETION_TRACKER.md for current work and evidence. This inventory distinguishes missing code, failing tests and unverified configured-service gates. [PAUSED_HANDOFF.md](PAUSED_HANDOFF.md) lists what exists and the exact evidence. Later schedules/alerts, resource-aware placement, automatic cross-host migration and product multi-agent collaboration remain outside v1.

## Incomplete code / integration

| Work | Owner on resume | Requirements | Concrete finish gate |
|---|---|---|---|
| Complete fixed-root host-state exporter and journal transport beyond32MiB | Host + operations | R07,R16 | Export protected identity/config/journal/spool and registered-root coverage consistently; chunk large data with hashes and bounded memory; report offline/partial coverage truthfully |
| Queued backup runtime tools, destination mounts and deployment glue | Operations + queue | R16 | Worker image includes pinned required tools; only allowlisted destination/config refs; actual API→durable job→maintenance/capture/seal/history completes; cancellation/crash reclaim preserves cut ownership |
| Full recovery integration and restricted database roles | Operations + platform | R01,R15,R16 | App DML login is separate from schema/migration owner; isolated host remap/trust/key recovery, no old replay and a new verified harmless job; final proxy/install/update proof |
| Command checkpoint-to-file_changes/text-diff publication | Queue + storage | R14 | Before/after command captures publish tracked/untracked/binary changes and actual verification evidence, including interrupted/partial commands |
| Owner-reviewed partial-effect acceptance API/UI | Storage + frontend | R14,R15 | Separate recovery grant, exact current manifest, concrete review and audit; host helper receipt respected; no agent tool or generic unlock |
| Restricted workspace PTY/ConPTY and conversation project pane | Host/native + queue + frontend | R04,R05,R15 | Real selected identity/container, root/network limits, process-lifetime writer reservation and correct disconnect/cancel behavior; clear separation from broad human SSH |
| Reference-aware blob/log retention and transfer service | Storage + queue + operations + frontend | R05,R06,R14,R16 | Never prune referenced checkpoints/artifacts; show expired/truncated history; bounded transfer progress/cancel and required chunk/resume support. Current uploads are staged bounded one-request transfers |
| Model/server digest-aware capability invalidation | Providers | R12,R13 | Changed observed model/server digest/version invalidates the old probe even without a config edit; fixtures and installed-service regression |
| Provider performance/activity UI and remaining conversation/history controls | Frontend + queue/providers | R02,R05,R06,R12,R13 | Connect measured/provenance-aware fields; saved context application, attachment history/exports, older job pagination, authoritative active/wait durations; final route-shape integration |
| Model-free manual commands and known-never-delivered retry ergonomics | Queue + frontend | R02,R06,R07 | Manual supervised commands need no fabricated model selection; explicit linked retry preserves old evidence and does not revive ambiguous work |
| Runtime limits / fixed-action integration completion | Queue + actions + host | R03,R10,R15 | Prove fixed executable actions with both host permissions; preserve rejection for unsupported command quota/network modes; verify token/output budgets with supplied/unknown usage distinctions |

## Failed or unrun mandatory scenarios

| Gate | Current outcome | Next action only after explicit resume |
|---|---|---|
| Actual model-driven autonomous file task | **FAIL: verification_failed**, about68s/two inferences; no host mutations | Inspect persisted rejected calls and feedback; use an explicitly selected supported configuration/new job, preserve old failure and strict preconditions; no silent fallback |
|180-second all-tabs-closed sentinel and full actual-agent container replacement | **NOT STARTED** | Prove one physical launch, full subsequent verification, reconnection/restart/no replay, persistent text/binary hashes and original artifact links |
| Unknown Guacamole tunnel created after the20-second bound | **Proof gap** | ACK raw sync and establish target liveness beyond bound before lease revocation; idle-timeout-confounded phase is not a pass |
| Wave2 expanded browser workflows | **NOT RUN** | Browser-test composed current APIs/host/provider/gateway, uploads/downloads/conflicts/reviewed restore/history/settings; repeat bounded request checks |
| Two prepared checkpoint-boundary runtime cases | **NOT RUN**, PostgreSQL had stopped | Run on an explicitly owned throwaway database; do not interpret ECONNREFUSED as a product result |
| Full queued/cross-host encrypted backup restore | **Incomplete implementation + acceptance** | Finish exporter/tool glue first, then coverage/offline failure, usable secrets/files/history, rotated trust/no replay, remapping and a new harmless job |
| Final whole-project regression/install/upgrade/retention | **NOT RUN after pause** | Rebuild current source/images, run focused regressions then justified aggregate acceptance; do not reuse stale image/source assumptions |

## Configured-service evidence still needed

Actual owner-designated Windows/Linux identities/ACLs, native Windows credential-backed execution and SCM; installed systemd actions; SSH/SFTP accounts and both physically observed desktop modes; GPU references/staleness; installed LM Studio/vLLM or the owner's compatible endpoint; actual backup destination/key escrow; remaining cancellation/reboot/lost-ack/unknown-outcome/storage-pressure/limits cases. Some actual local WSL/Docker/Go/TLS/provider components passed, but they do not establish all owner homelab R01–R17/T01–T23 gates.

A genuine unsupported capability (Windows Home RDP host, unavailable GPU sensor, unsupported restrictive networking or provider management) must stay unavailable with evidence. Missing implementation above must not be relabeled unsupported or merely blocked by credentials.

## Handoff entry points

- docs/PAUSED_HANDOFF.md and docs/security/REVIEW.md
- docs/acceptance/WAVE2_PAUSE_HANDOFF.md and actual-model-agent-result.json
- docs/runtime/IMPLEMENTATION.md, docs/storage/OPERATIONS.md, docs/frontend/VERIFICATION.md
- docs/operations/PAUSE_HANDOFF.md, docs/remote/WAVE2_EVIDENCE.md, docs/providers/PAUSE_HANDOFF.md
- docs/actions/README.md, docs/machines/IMPLEMENTATION.md and agent documentation

All owners stopped their current units and temporary workloads. Preserve the stopped fixtures/caches/volumes; no rejected cleanup is to be retried. The user has explicitly resumed; preserved fixtures may be used only through current owner booking.
