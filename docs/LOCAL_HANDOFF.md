# Local implementation handoff

The final local implementation and scoped local acceptance are complete; immutable build/deployment/source evidence is retained. The temporary completed acceptance services have now been stopped. **The strict local autonomous T08 run passed** on job `6cc32e92-7393-411b-afb2-ef071a082b9b`; final owner cleanup is confirmed. This is local fixture acceptance, not an owner-homelab release declaration.

The same job completed with exactly one physical operation/counter, numbered logs 1–180, two successful model file verifications and two model-published artifacts. Owned dashboard tabs were closed for 205.169 seconds, covering the tail of the command and all subsequent tools; this is not a claim that the entire 180-second command ran during browser absence. The completed-state snapshot, host-off artifact download hashes and two final reloads passed, with 706 unique events and one final response retained. Frontend closed its owned tab and Vite process and confirmed zero dashboard tabs. [Exact actual-run evidence](acceptance/actual-t08-qwen4b-production-end.json) and [browser evidence](frontend/evidence/final-t08-4b-closure.json) preserve the scope.

## Implemented scope

- Persistent control plane: owner bootstrap, sessions and CSRF, encrypted versioned secrets, a DML-only runtime database role, immutable migrations, owner-scoped APIs, durable jobs, receipts and events.
- Execution and storage: enrolled native mTLS, signed generation-bound operations, restricted native/container identities, model/profile/grant checks, checkpoints and diffs, reviewed partial-effect recovery, resumable transfers, retained artifacts, reference-aware retention and cumulative budgets.
- Connected workflows: provider adapters and probes, saved actions, supervised model-free commands, restricted workspace terminals, SSH/SFTP/desktop gateways and revocation, telemetry/history, encrypted whole-host backup and restore, and frontend review/reconnect/history flows.

The [completion tracker](COMPLETION_TRACKER.md) gives the exact code, component and acceptance boundaries. Environment/template customization deferred by MD01 remains outside this first-version scope; no additional product scope was inferred.

## Last verified deployment version

The source cut is **core018-paths-export-securityopt11**, with migrations 001–018. The independent audit matched all 238 production, web, deployment, configuration and example files to the built image. The actual migration ledger, lockfile and helper hashes matched, and both APIs passed all five readiness checks. [Integration manifests](integration/) retain the source points, image comparisons and separately classified acceptance drivers.

| Component | Immutable SHA-256 |
|---|---|
| API | `7fbc79f81bc7ec8b819734ea8949b59b6a0367f630d8ae82da7d11e13dbf319b` |
| Worker/tools | `b0e86cad504a263005588faf72513b74d9d52cea076154b4158054a3d98f000f` |
| Proxy/web | `e12f986366a7505d36cc6c7317919cf0e9d9c8e0656c704dc37643c05e40e249` |
| Linux helper 11 | `8111acfb7678d09b22e19ff39674a2827a6bdb855800cf098411e751af4f44a1` |
| Windows helper 11 | `2ead4483e6b1fdcb39be95d1002bad30dea49fe7df767d3db0c26c2218f22e1c` |

## Verification and remaining local gate

The core aggregate passed **188 tests with zero failures and 16 explicit opt-in skips** (204 TAP entries). Build and type checks passed. The final display-only export delta passed **10 frontend tests**, its build, and a final whole-repository type check. Exact commands, toolchains, skip prerequisites and versioned logs are in the [aggregate report](platform/FINAL_AGGREGATE.md).

Actual local proofs include restricted PTY/browser identity, Unicode, reconnect and cancellation; 183 sensitive-RPC redactions; lifecycle restart/replacement/replay with unchanged source bytes and retained downloads; and readable eight-path export review followed by a verified 38,457,060-byte ZIP download. The deterministic physical durability component passed 186.969 seconds without its worker, a 20-second API outage, one operation/counter, all 180 logs and matching output hashes. This component does not replace autonomous T08.

The successful 4B attempt used the unchanged production output cap of 4096, an 8192 context, a 900-second provider deadline and a 3600-second job wall limit. The captured wire omitted thinking and temperature overrides. Both inferences finished normally (681.23 and 313.31 seconds); the full actual test passed in 1197.764 seconds. No model fallback, command replay or validation relaxation was used. The deterministic worker/API-loss proof remains a separate component.

Earlier failures remain evidence: the first 4B job ran its command but omitted mandatory verification; the later 1.5B job made eight real requests with twelve rejected tool calls and no host operation. Its final interruption came from an acceptance-only guard before a ninth HTTP request, not a provider wire failure. Exact provenance and results remain in [acceptance evidence](acceptance/); they are not relabeled by later harness corrections.

## Running locally

Use Node 24 LTS and the committed lockfile. From the repository root, run `npm ci`, `npm run typecheck`, `npm test` and `npm run build`. Opt-in tests require their explicitly booked resources; no host or endpoint is guessed.

For a usable deployment, create a **new absolute persistent root outside the checkout**, then follow the exact Compose, provisioning, migration and bootstrap commands in [deployment](operations/DEPLOYMENT.md). Dispatch starts disabled and requires both environment and database approval plus actual enrolled identity, containment and grants. Use the [recovery runbook](operations/RECOVERY.md) for a fresh restore epoch, revoked restored sessions and explicit host/path reconciliation. Do not remove volumes or rewrite migration checksums.

## External acceptance and preserved resources

Owner-designated Windows credentials/rights, physical remote endpoints, installed LM Studio/vLLM instances, GPU and sustained/200 ms monitoring, actual reboot/power-loss behavior, independent backup-device and key-escrow evidence remain separate owner-configured gates. The R01–R17/T01–T23 matrix stays explicit; local fixtures do not certify owner machines or R17 performance. Scoped schema-16/helper-9b restored-new-job evidence is not a current schema-18 full recovery claim. Unsupported hard network allowlists and command-generated file-byte quotas are rejected rather than silently promised.

Earlier lifecycle unknown records (`6cb0…`, `58c8…`) remain preserved, without unlock, replay or rebinding. The separate historical 1.5B writer/provider uncertainties were reconciled through audited owner routes after proving zero host operations; exactly two permits and its writer were released, with `replayed:false` and original interruption history retained. Ignored runtime/cache roots and volumes remain; refused cleanup is not retried. The final job has zero writer locks and released its provider reservations; validation recorded its Go processes stopped and base container stopped. The frontend and native PostgreSQL cluster are also stopped, and historical 1.5B audited recovery passed. Operations also stopped the exact completed APIs, PG proxy, provider, successful T13 container and PostgreSQL fixture, with all data/keys/volumes retained. Both historical unknown lifecycle runtimes remain untouched. See [resource handoff](RESOURCE_HANDOFF.md). Platform owns no temporary process.
