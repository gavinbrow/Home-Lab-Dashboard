# Latest verified deployment point

**core018-paths-export-securityopt11** passed its deployed provenance audit at 2026-10-21 06:36:58 UTC. Formal END was confirmed. [Aggregate manifest](AGGREGATE_RUN_MANIFEST.json) retains the exact source, image, schema, binary, helper and separately scoped acceptance records.

| Component | Immutable identity |
| --- | --- |
| API | sha256:7fbc79f81bc7ec8b819734ea8949b59b6a0367f630d8ae82da7d11e13dbf319b |
| Worker/tools | sha256:b0e86cad504a263005588faf72513b74d9d52cea076154b4158054a3d98f000f |
| Web proxy | sha256:e12f986366a7505d36cc6c7317919cf0e9d9c8e0656c704dc37643c05e40e249 |
| Linux host11 | 8111acfb7678d09b22e19ff39674a2827a6bdb855800cf098411e751af4f44a1 |
| Windows host11 | 2ead4483e6b1fdcb39be95d1002bad30dea49fe7df767d3db0c26c2218f22e1c |

Actual database ledger 001–018, root lock and both API readiness responses were verified. The [238-file comparison](image-source-comparison-core018-paths-export-securityopt11.json) found zero image/checkout mismatches across runtime/frontend sources, package/build configuration, migrations and deployment/restore tools/examples. [Runtime](runtime-manifest-core018-paths-export-securityopt11.json) and [endpoint evidence](runtime-endpoints-core018-paths-export-securityopt11.json) identify the exact containers, versions and checks.

The [413-file prebuild](source-manifest-core018-paths-export-securityopt11-prebuild.json) and [415-file postbuild](source-manifest-core018-paths-export-securityopt11-postbuild.json) manifests additionally cover Go and integration sources. Only fixture UI stopped-worker naming changed; a new Qwen25 test and frozen worker helper were added. No core, host or build source changed. [Driver hashes](final-acceptance-driver-point.json) record this point; each actual campaign must also record its loaded copy/hash at START.

The unchanged core baseline passed 188 tests, zero failed and 16 explicit opt-in skips. The narrow readable export coverage delta passed 10 focused web tests and production build; root typecheck passed. No redundant whole-suite rerun was attributed to that renderer delta. [Versioned baseline logs](evidence/core018-paths-securityopt11/FINAL_AGGREGATE.md) list all skip prerequisites.

Scoped acceptance remains separate: immutable017 model-free durability passed with one 180s launch, replacement worker and isolated 20s API outage. The earlier Qwen3:4B job physically completed its 180s command but failed verification with zero verified artifacts. Fresh manual T13 restart/rebuild, exact file hashes and host-offline artifact download passed; these artifacts were manually retained copied bytes, not model-published. Schema016 restore/new-job and schema018 HTTPS-upgrade proofs retain their own versions. The final Qwen25 campaign also failed: eight actual completed HTTP requests produced 12 rejected tool proposals and zero physical operations. The ninth durable inference was interrupted by the frozen fixture guard before HTTP when production prepared its intentional tool-less final request after budget exhaustion. No counter, browser-absence window or provider-stop proof occurred. [Retained final evidence](evidence/actual-qwen25-b96bd0da/outcome-manifest.json) preserves the launched driver/helper hashes, original persisted interruption reason and the untouched writer/two uncertain reservations; a future-only fixture correction does not change this outcome.

A later independent Qwen3:4B production-settings workflow completed successfully on the final images and host11: one physical180.299s operation, all180 numbered logs, two passed model-requested file verifications and two model-published artifacts. [Exact outcome and provenance](evidence/actual-qwen4b-production-6cc32e92/outcome-manifest.json) preserve driver93757D/helperC126, both actual inferences and final exited containers. Current writer count is zero and this job's reservations are released. Frontend reported205.169s tab closure with replay/download success; both host-off artifact redownload hashes matched and frontend consumerEND was confirmed. Tabs closed after most of the command elapsed, so this does not prove180s physical command execution while every tab was absent. The earlier1.5B failure remains a separate record. A later owner-authorized audited API recovery released its two phantom reservations and writer without replay; its original failed outcome and END snapshot remain unchanged.

This is a coherent deployment/provenance gate, not a claim that all opt-in, actual-model, native Windows or owner-homelab acceptance has passed.
