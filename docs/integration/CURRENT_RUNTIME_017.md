# Current schema 017 integration boundary

Read-only capture at 2026-10-21 05:04–05:05 UTC. This records the current refresh; schema016 records remain historical and do not establish current-source coverage.

| Component | Independently observed identity |
| --- | --- |
| API image | `sha256:9cacbf1531c618fd3869adf7f3192439ed42c8caebc3490644fe032e67a0d849` |
| Worker image, built | `sha256:0655e48c57a0213847447b38c1c10b077bd4883262a2a2db5da4f1e21122cff1` |
| Shared API | Container `c4b2a625fc5160a5c008a3ef57b9f9ea095118943129c48c9c676db50703e260`; HTTP3009 / TLS3449 |
| Isolated API | Container `62f5f26d1d420b0c0a40b1dafdea2257fc05e15c0abc711df2eb60693423d5c8`; HTTP3019 / TLS3459 |
| API runtime | Node `v24.22.0`, npm `11.19.1` |
| Actual database ledger | 17 migrations; `017_terminal_delivery_staging.sql` SHA256 `889218b96c508a644c68e46970970be8e04ef1d8cb65600c7cd8e7050bd9ae46`, applied 05:03:46.380 UTC |

Both API containers use the current017 image and return `ready`, with all five database/schema/artifacts/secret-key/database-role checks true. The isolated3019 endpoint is therefore also017 at this boundary; it must not be described as an immutable016 API in a subsequent report. Built worker image identity alone does not establish which worker process a particular test executed.

The [complete comparison](image-source-comparison-core017-ready.json) covers **137 files**: 103 runtime TypeScript files across all API/core/modules, worker and package sources, plus 34 root/package/build/deployment/migration configuration files. All match the current image after CRLF normalization. The comparison checks both image and checkout path sets, so a new checkout source file absent from the image is a mismatch. Root package lock has no added, removed or changed entries.

The [formal source cut](source-manifest-core017-formal-sourcecut.json), at 05:02:19.919 UTC, and [runtime-ready snapshot](source-manifest-core017-runtime-ready.json), at 05:04:39.357 UTC, cover 165 files. Only `tests/integration/helpers/sentinel-worker.ts` changed between them; core, package, build and schema sources remained unchanged. That helper change is part of test-driver provenance and must remain visible in any test using a direct-source worker.

[Runtime/schema/binary evidence](runtime-manifest-core017-gen6-ready.json) records the pinned generation6 command/file binaries. Host terminal-privacy acceptance requires its separately selected updated executable and actual terminal evidence; this manifest does not claim it. [Endpoint and worker-image evidence](runtime-endpoints-core017.json) includes exact container identities and readiness responses.

No command, model request, migration, service restart or database mutation was performed by the integration verifier. A model-free180s durability precursor, actual-model T08, frontend browser campaign, terminal privacy, and restored-host new trust/job proof remain separately identified acceptance work. Their results must name the particular source/image/schema/binary/test-driver snapshot they exercised.

## First immutable017 model-free precursor

Validation's [preserved failure](../acceptance/model-free-survival-step-id-failure.json) names job `bfb5299f-323c-4f6e-a781-4c5eb0ed48bd` and immutable worker container `4b7999bc7c8dec8d0d8a5e8d761ce116ed2bbc759b39e4b00e27b8b04fd55d37`, using the017 worker image above. Frozen helper SHA256 is `5c231dc27389e1805a109ec76eab9254b6bc2ad09b005698a7e057ecef4f473f`. The worker imports application source from its immutable image, rather than the changing checkout.

The actual signed operation `f3f7c193-3676-4daf-9409-7558563f9dc4` reached the host but was rejected with `invalid_request`: worker step ID `command:0` conflicted with the Go identifier validator's colon restriction. The job failed `command_failed` before the startup counter existed. No worker replacement or API outage occurred. This is a failed model-free integration preflight and establishes no 180-second durability or actual-model T08 success. Validation retains its failed containers and reported closing its own Go/process fixtures; the host owner owns the targeted compatibility fix.

The verifier independently inspected that retained worker container: exact image ID matches the017 worker, state is `exited`, startup was 05:06:20.221978858 UTC and finish was 05:06:22.661558713 UTC. This corroborates immutable worker identity and termination; it is not evidence of the unstarted workload's survival.

## Immutable017 prerequisite8 physical precursor: PASS

The subsequent distinct job `81aa6758-319c-446e-b04a-81a8c683fa94` and operation `33d3cbba-fc47-4149-8ccc-86c80e0287e6` passed validation's model-free durability component in 218.8 seconds. [Final assertion evidence](../acceptance/model-free-survival-result.json) and [passing TAP](../acceptance/model-free-survival-helper8.tap) record an actual signed marker-command preflight, 186.969 seconds without the first worker, a 20-second isolated API outage, one physical counter entry and one operation, successful reconciliation with advanced fence3, all 180 numbered logs, and matching text/binary hashes. API observations recorded 82 up and 11 down samples. Shared3449 was not the outage target.

The verifier independently captured the [first worker/execution containers](owned-run-precursor017-host8-first-worker.json) while the physical workload continued after worker death, then the [replacement](owned-run-precursor017-host8-replacement.json). The first worker `641802a2c4495111749b58ba3418d218fc776c98f9bd090e744cec15d3969a1f` exited137 at 05:17:12.304 UTC. Replacement `f23d0f7c9b790b1c0b721c2b80067449706e2a622261b8ba9dd28a1fbbccbf60` started at 05:20:20.013 UTC and exited0. Both used exact worker image0655 and the same read-only helper SHA256 `5c231dc27389e1805a109ec76eab9254b6bc2ad09b005698a7e057ecef4f473f`. The sole physical execution container `34fc7a739bbd5257c37f386dbe24395c675329bbd58d98ba6893fd0dfb6163e5` ran from 05:17:10.514594825 to 05:20:10.833069296 UTC and exited0.

The [prerequisite8 binary hashes](host-prerequisite8-manifest.json) and [driver/workload hashes](precursor017-prerequisite8-driver-manifest.json) identify the targeted helper used. Text SHA256 is `68c49c9c6e7c7be112537834450f13187b6eba2de958dae18fd4ca3fdb07f4bc`; binary SHA256 is `40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880`. This establishes the scoped model-free component, with immutable017 application source and provisional prerequisite8 command helper. It does not establish actual-model T08, browser acceptance, container replacement, final terminal privacy, or future018 source coverage. Validation issued formal END and closed its relay.
