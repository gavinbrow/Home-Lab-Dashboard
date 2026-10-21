# Wave 2 integration and release tracking

Wave 2 resumes implementation of the incomplete baseline. The prior local gate remains useful regression evidence; it does not establish implementation of the formerly disabled paths. Full T01–T23 live acceptance remains separate from the local integration gates below. No configured real homelab endpoint or restricted account is assumed.

## Requirement gaps at wave start

| Requirement | Implementation remaining at wave start | Separate real acceptance still needed |
|---|---|---|
| R01 | Wire production TLS/auth boundaries to newly active agent/desktop routes | Private HTTPS, active-session access and real deployment recovery |
| R02 | Integrate four frozen selections throughout autonomous execution | Different actual inference/execution machines and visible immutable context |
| R03 | Connect versioned profile/tool budgets to the durable agent loop | Actual profile revision changes/revocation/limits during real execution |
| R04 | Connect authenticated host files, environment lifecycle and ownership checks | Native Windows/Linux and actual replacement container storage |
| R05 | Finish file transfer/preview/export/restore workflow and UI | Real native and container project round-trip hashes/conflicts/ZIP |
| R06 | Enable persisted autonomous orchestration and real operation completion | Long-running actual model/tool work, cancellation and retained logs |
| R07 | Connect host ledger reconciliation to active command/file dispatch | Real browser absence, reboot/disconnect/lost acknowledgement and descendants |
| R08 | Implement certificate enrollment, authenticated relay/ingestion and onboarding | Installed Windows/Linux independent runner/SSH/desktop tests |
| R09 | Wire authenticated real collector data and history | Comparison with actual host/GPU references, stale/reboot gaps |
| R10 | Connect scoped controls and approved saved actions to narrow host helpers | Real OS service/container postconditions and restricted target denials |
| R11 | Finish authenticated Guacamole proxy, tickets and active tunnel revocation | Real Linux/Windows physical-screen/session observation |
| R12 | Connect provider adapters, capability probes and durable agent/UI paths | Actual installed provider/model tool/image/management capabilities |
| R13 | Integrate observed provider state, limits and measured provenance in UI/jobs | Actual warm/cold behavior and external-client uncertainty |
| R14 | Finish end-to-end manifests, protected checkpoints, restores and artifacts | Actual native/container diffs, binary/untracked recovery and conflicts |
| R15 | Wire current/captured grants through all active transport/file/agent paths | Real OS account/ACL/network/containment enforcement; absent safe identities remain disabled |
| R16 | Implement encrypted complete local/remote backup coverage and restoration | Separate-device cross-host restore with recoverable keys and no historical replay |
| R17 | Replace disabled implementation gaps with executable local integrated evidence | Full real T01–T23 suite after owner supplies configured live targets |

These rows are a wave-start snapshot, not a claim that other agents' in-progress code is still missing when this document is read. Executed evidence will identify the tested implementation and remaining blockers.

## Local integration gates to execute after contracts stabilize

| Gate | Concrete local evidence | Outcome at wave start |
|---|---|---|
| W2I01 | Actual TLS enrollment/session: single-use bootstrap, certificate/machine binding, wrong certificate/revocation/expired enrollment denied | NOT RUN — transport implementation pending |
| W2I02 | Actual Go executable emits local collector/file observations through authenticated loopback transport into actual PostgreSQL | NOT RUN — relay and Go interfaces pending |
| W2I03 | Real rooted Go file operations with hashes, conditional conflicts, traversal/junction denial and disallowed roots; no current-user arbitrary shell | NOT RUN — adapter wiring pending |
| W2I04 | Explicit provider fixture returns structured tool calls; persisted agent loop authorizes and dispatches to Go file operations; actual bytes/change manifest/checkpoint/artifact verified | NOT RUN — autonomous tool loop pending |
| W2I05 | Reconnect/worker restart/lost acknowledgement reconciles same operation; counter/hash proves no duplicate local side effect and unknown outcomes retain reservations | NOT RUN — active relay integration pending |
| W2I06 | Actual checkpoint restore preserves unrelated later files/conflicts; original retained artifact downloads after working file changes; lifecycle storage marker/generation checks | NOT RUN — restore/lifecycle implementation pending |
| W2I07 | Actual local gateway/tunnel fixture denies altered/replayed tickets and closes existing access after session revocation | NOT RUN — desktop gateway pending; Docker availability assessed by operations |
| W2I08 | Real encrypted backup of actual DB and file bytes restores into an isolated new database/root with dispatch disabled/epoch rotated; partial coverage and wrong recovery keys fail truthfully | NOT RUN — encrypted/remote backup implementation pending |
| W2I09 | Actual browser exercises newly implemented configuration/project/agent/desktop flows; request counts stay bounded and unavailable capabilities remain explicit | NOT RUN — complete UI pending |

Provider/server fixtures are conspicuous test inputs. A local tool-call fixture cannot establish model intelligence, native account confinement, a real desktop connection, or a live-machine T08/T13 PASS. Host file/collector tests may use this explicitly authorized local Go executable; shell checks require an already provisioned safe restricted account or an actual isolated container. Validation will not create an OS account/service or run arbitrary tools as the current user merely to satisfy a test.

## Regression and runtime policy

Keep actual PostgreSQL claims/fences/unknown writer locks/provider permits, authentication/CSRF/session checks, build/typechecks, focused security review and bounded browser requests active. Use new uniquely owned disposable loopback cluster/database roots. The prior inactive PostgreSQL cluster directory under `.runtime`, whose recursive cleanup was rejected, will not be removed or reused. Do not retry its refused deletion through another mechanism. New wave-2 runtime files use `.wave2-runtime`.
