# Final aggregate verification

Stable **core018-paths-securityopt11** source aggregate PASS: **188 passed, 0 failed, 16 explicitly skipped** (204 TAP entries including nested/parents); root/web TypeScript and production Vite build PASS; frontend **9/9** tests PASS. Combined commands took43.74 seconds. Staged images passed a separate237-file production image/source audit. No service was restarted by this build; deployed lifecycle-budget-host10 and its accepted work remain distinct.

Host toolchain: Node22.12.0, npm11.15.0, TypeScript5.9.3; disposable loopback PostgreSQL18.4. Container versions are recorded independently by the integration verifier.

Exact commands and historical runs: [machine-readable results](FINAL_AGGREGATE_RESULTS.json). Current raw logs: [node tests](final-node-test.tap), [build](final-build.log), [frontend tests](final-web-test.tap). Earlier401/402 logs and initial strict fixture failures are preserved under their versioned names. Fixture corrections retained dual grants, original machine generations, fail-fast path rejection and unknown reservations.

These opt-in cases are skipped in this aggregate because their actual resources require separate bookings. Separate campaign results do not convert aggregate skips into passes.

| Test | Actual prerequisite |
|---|---|
| actual Linux Docker saved action: authenticated HTTP -> durable worker -> signed mTLS Go helper -> verified restart | Requires explicitly owned NEW homelab-validation-wave2 stack |
| actual restricted Linux saved command and disposable transient systemd control retain scoped verification/diff evidence | Requires explicitly owned refreshed validation stack and existing nobody account |
| actual OpenSSH Linux chroot fixture: root marker, outside-canary denial and exclusive hash round trip | Opt in only on isolated homelab-ops-wave2 fixture network |
| actual authenticated API and signed Go mTLS accept genuine Windows partial restore and release only the reviewed writer | Explicit owned Windows Go executable and disposable loopback PostgreSQL required |
| actual booked Linux T13 restart/replacement preserves original text, binary and existing retained artifact URLs | Requires explicit exclusive retained 3019 fixture booking |
| actual fresh T13 fixture preserves copied verified text/binary and retained URLs across restart and runtime replacement | Requires root-authorized exclusive fresh fixture booking and exact helper11 |
| actual qwen3:4b autonomous180s command verifies and retains both real outputs | Requires booked actual4B provider, allocated API3459, browser campaign and immutable worker image |
| persisted agent through actual signed Go relay: explicit deterministic provider fixture | Explicit owned PostgreSQL and built Go executable required |
| authenticated command cancellation confirms actual container and descendant exit | Requires exclusive writer booking on the owned actual UI host fixture |
| actual local Go executable: collector and rooted file bytes, conflicts and escape denials | Opt in with explicitly built HOMELAB_AGENT_EXE; never starts arbitrary native shell |
| actual Go + native TLS + PostgreSQL: enrolled collector, durable sequence and certificate revocation | Explicit disposable PostgreSQL and built Go executable required |
| actual signed Go 17MiB resumable binary transfer and staged selected checkpoint restore | Requires coordinated live owned UI/Go fixture; never creates or guesses a host |
| actual model Linux 180-second sentinel survives worker/control-plane loss without execution replay | Explicit owned Linux stack/model and coordinated API outage required |
| live component check: anonymous API resource access is denied (partial T01 only) | Deferred: explicit HOMELAB_LIVE_READONLY=1 and enrolled HTTPS origin required |
| model-free precursor: actual 180s command, killed immutable worker and isolated API outage, same physical launch | Requires explicitly allocated isolated API3459 and immutable worker image |
| owned actual Go controls: lost acknowledgment, disconnected cancellation, deadlines and bounded output | Requires explicitly booked isolated TLS fault proxy3469 and immutable worker |

After-run exact-byte comparison checked408 prebuild files; missing[], changed["tests/integration/helpers/linux-stack.ts"]. Driver-only changes are classified separately by the integration verifier; no production/core/host/build drift was found. This is not full autonomous T08, terminal, lifecycle or owner homelab acceptance.

Final display-only delta core018-paths-export-securityopt11 has its own413-file manifest. Its actual object/escaping/empty renderer regressions passed in frontend10/10 tests; frontend typecheck/build passed13.22s and final whole-repository typecheck passed4.28s. The unchanged core aggregate above is not relabeled or rerun for this display-only change. New image/runtime parity is recorded separately by the integration verifier.
