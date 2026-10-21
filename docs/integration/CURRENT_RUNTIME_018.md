# Coherent integration cut: core018-output-host9b

The source/image/schema provenance gate passed at 2026-10-21 05:25:30 UTC. [Aggregate manifest](AGGREGATE_RUN_MANIFEST.json) groups this cut separately from preserved immutable017 proofs.

After this cut, the coordinator authorized source-only queue live-log and host/native boot candidates while the actual-model campaign continued on the immutable018 images and copied privacy9b executable. This document remains the frozen campaign baseline; it does not claim the deployed images contain those later candidates. The proposed next cut is `core018-live-logs-host10`, after candidate readiness and the active job's formal END, with schema018 unchanged but new source/image/binary proof required.

| Component | Verified identity |
| --- | --- |
| API image | `sha256:ccfe50162597c9c279eaa7c5413d1bad3eb3711a3b8cde342540e75f3c522a6a` |
| Worker image | `sha256:f05959f4556d9e8941fc2f3a9961be0550bf671ef0003f39c0fcdb4c6a900a3a` |
| Proxy image | `sha256:af92f1823035884a2ae8439e9654fd129c409c917618212416ce8019ab319a1c` |
| Database ledger | Actual migrations001–018; migration018 checksum `95e89adbdbfc738ee6948fc5c0c68a677499dfc0622d0fe1078a9557e99dca39` |
| Linux privacy9b executable | `c514be01e1084d30e5aeeba153c6770e07620bf71faffca9df770d6f51b911e6` |
| Windows privacy9b executable | `7bdecc4a4181304aa0a35e7240438586093486c99518b665c67055273a7f24ac` |

The [expanded image comparison](image-source-comparison-core018-output-host9b.json) verifies **231 files with zero mismatches**, using LF normalization and both checkout/image path sets. Coverage includes API/core/modules, worker, all packages, frontend source/styles, root/package/build configurations, migrations and deployment/restore tools. It includes 152 TypeScript files and 46 frontend source files. Root lock contents match. These are source/configuration comparisons, not acceptance-test counts.

The [388-file prebuild snapshot](source-manifest-core018-output-host9b-prebuild-allapps.json) and [388-file postbuild snapshot](source-manifest-core018-output-host9b-postbuild.json) include host Go source and integration drivers. Only `tests/integration/actual-model-command-survival.test.ts` changed during the cut. Core, host, deployment and build configurations stayed unchanged. The postbuild manifest records the exact updated driver/helper hashes for subsequent tests.

[Runtime evidence](runtime-manifest-core018-output-host9b.json) records actual database ledger/checksums, Node/npm versions and host executable hashes. [Endpoint evidence](runtime-endpoints-core018-output-host9b.json) independently identifies both shared3009/TLS3449 and isolated3019/TLS3459 API containers, current built worker/proxy images, and both readiness responses with all five checks true. Built image readiness does not imply that a particular test used that image; each campaign must retain its own process/container/helper identities.

The separately scoped immutable017 model-free durability component passed with prerequisite8, one physical180s command, worker replacement and isolated20s API outage. Its images/helpers are preserved in the aggregate rather than relabeled018. Actual-model T08, complete browser acceptance, current018 terminal privacy and restored-host new trust/new job evidence remain separate acceptance gates. No command, model request, migration, service restart or database mutation was performed by this verifier.
