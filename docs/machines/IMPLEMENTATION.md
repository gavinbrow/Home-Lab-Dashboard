# Machine integration status

Requirements R08/R09/R15; milestones M03/M04/M07. Metadata CRUD, genuine CA enrollment/rotation/revocation, authenticated telemetry, durable RPC relay routes, independent capability jobs and bounded history are implemented. Real Windows/Linux acceptance T02/T03/T20/T23 remains NOT RUN until configured machines and reference measurements are supplied. Loopback fixtures do not establish live support.

## Setup and trust

Explicit local provisioning (refuses existing directory; does not modify system trust):

```powershell
npx --no-install tsx apps/api/src/modules/machines/pki-init.ts C:\Protected\HomelabAgentPki localhost
```

Creates ca.pem, ca-key.pem, server.pem, server-key.pem, dispatch-key.pem. Restrict the directory to the control-plane service account and recovery administrator. Unix files are created mode 0600/directory 0700; Windows directory ACL protection must be applied before production use. No key/token contents are printed. Back up CA/signing keys through protected recovery. Replacing keys silently breaks enrolled trust.

Configure AGENT_TLS_KEY_FILE, AGENT_TLS_CERT_FILE, AGENT_CA_CERT_FILE, AGENT_CA_KEY_FILE, AGENT_HOST (default loopback), AGENT_PORT (default 3443), DISPATCH_SIGNING_KEY_FILE and DISPATCH_SIGNING_KEY_ID. Server composition starts the dedicated TLS listener. All four TLS paths absent disables it; partial/invalid configuration fails startup. Use a certificate matching the agent-facing DNS hostname. Generated fixture certificates also cover 127.0.0.1/::1. Never replace native TLS identity with forwarded headers.

The listener requests client certificates. A global onRequest hook rejects every route unless the native TLS socket is CA-authorized and its fingerprint/serial maps to a current unrevoked protocol 1 database certificate. The sole exception is exact POST /agent/v1/enroll, which still requires encrypted TLS and a one-use token. Checks precede body parsing. Headers/cookies/browser actors cannot supply identity. Keepalive does not bypass later revocation checks. Limits: enrollment/rotation 20 KiB, poll 4 KiB, telemetry 8 MiB, authenticated RPC results 96 MiB.

## Enrollment and renewal

An authenticated owner creates metadata, then POST /api/v1/machines/:id/enrollments with {}. An already enrolled installation requires explicit {re_enroll:true}. Response exposes a 10-minute random 256-bit token once with Cache-Control:no-store; only SHA256 hash is retained. New pending tokens expire previous pending tokens. Pass tokens through protected host input, never URLs or shell history.

Host generates its private ECDSA P256 key locally and sends {token,csr_pem,protocol_version:1} to dedicated TLS /agent/v1/enroll. It must trust the pinned CA/server certificate. Issuer verifies CSR proof/key algorithm, replaces requested subject/extensions with database-bound machine UUID and urn:homelab:machine:<UUID> SAN, CA=false, digitalSignature and clientAuth. Host private keys never leave the host. Leaf validity is at most 30 days and cannot outlive CA.

Token locking, certificate insertion, old-certificate revocation and token consumption share one PostgreSQL transaction. Concurrent reuse issues one certificate. Failed issuance rolls back consumption. Re-enrollment becomes effective when replacement is issued and resets agent-owned capability verification; historical samples/tests remain retained. Response includes certificate/CA PEM, serial/expiry, machine ID, dispatch epoch and pinned dispatch public key (null for monitoring-only configuration without signer).

POST /agent/v1/rotate {csr_pem,protocol_version:1} authenticates current mTLS identity and transactionally revokes the old certificate. Persist returned files atomically. A lost committed rotation response requires explicit operator re-enrollment; trust is never silently replaced. Owner revocation denies subsequent requests but does not prove an already launched OS process stopped; reconciliation/cancellation is separate.

## Browser API

All browser paths are authenticated under /api/v1, inherit Origin/CSRF checks and scope SQL by actor ownership.

| Route | Behavior |
|---|---|
| GET /machines | Up to 500 owned records, independent capabilities, no synthetic metrics. |
| POST /machines | {name,os,tags}; linux/windows/unknown. Capabilities start unconfigured. |
| GET /machines/:id | Metadata, latest 100 tests, enrollment availability. |
| PATCH /machines/:id | {revision,name?,tags?}; 409 on concurrent changes. |
| DELETE /machines/:id | Unused metadata only; foreign-key references 409. No project bytes removed. |
| POST /machines/:id/tests | {capability,idempotency_key}; queue job/test atomically retained. 202 means queued. |
| GET /machines/:id/metrics | Required ISO from/to, max 31 days; resolution raw/5m/1h; limit 1..2000 (default 1000). |
| POST /machines/:id/enrollments | One-use token issuance; genuinely absent issuer prerequisites prevent issuance. |
| GET /machines/:id/certificates | Public serial/protocol/validity/revocation metadata. |
| POST /machines/:id/certificates/:certificate_id/revoke | Idempotent ownership-scoped revocation/audit. |

Old main-server /agent/enroll,/agent/telemetry,/agent/rotate remain closed. Use dedicated /agent/v1/* listener; no browser-auth identity fallback.

## Telemetry, relay and probes

Authenticated /agent/v1/telemetry accepts current Go Sample: schema_version,machine_id,boot_id,sequence,observed_at,inventory,metrics. Metrics retain name/device/source/unit/value/availability/reason/observation time; receipt time is assigned by PostgreSQL. Available values must be finite; unavailable values require null+reason. Machine mismatch, duplicate series, excessive clock skew are rejected. Canonical payload hashes per machine/boot/sequence make exact retries idempotent; changed content conflicts. Delayed distinct batches remain stored without regressing latest inventory/capability observations. Boot high-water marks and samples survive API restart.

History exposes range/resolution/truncated/availability/reason. Empty history remains unavailable. Raw records include age/stale flags. Query rollups group boot/device/series/unit/source/bucket, retain min/max/mean/count/missing/reasons and preserve absent buckets as gaps. Limit applies to input rows, so truncated rollups are explicitly incomplete. Background raw/rollup retention is implemented by retention.ts, with a bounded internal worker maintenance timer and a one-batch CLI. Reset/boot/gap helpers never invent negative rates or missing-sensor zeroes.

Authenticated /agent/v1/poll and /agent/v1/results bind body machine IDs to certificate identity. Platform AgentBroker owns durable signed IDs, leases, response hashes, restore/dispatch gates and unknown outcomes. Machines duplicates no job state. Missing dispatch signer blocks polling; monitoring-only enrollment remains valid. Host signature/route/identity/workspace/policy checks remain mandatory. See ../TRANSPORT.md.

Worker factory actually verifies three fresh increasing same-boot samples. Reference-tool comparison remains not_run: plausible samples do not pass live accuracy acceptance. Runner tests require runner:{workspace_id,execution_identity_id,grant_id}, capture current owned scope, then execute fixed id/whoami diagnostics through the shared durable operation executor. They require verified enrolled identity, workspace lock, policy and checkpoint checks. Pending/unknown/cancelled outcomes remain explicit; a metadata health response cannot pass the test. Separate cancellation and platform release evidence remain required. SSH/SFTP/desktop delegate to remote adapter; partial authentication/transport never proves full desktop control or confinement.

## Verification

```powershell
$env:MACHINE_TEST_DATABASE_URL = '<isolated local PostgreSQL admin URL>'
npx --no-install tsx --test apps/api/src/modules/machines/*.test.ts
npx --no-install tsc --noEmit --pretty false
```

On 2026-10-21, 10/10 tests PASS including real loopback native TLS and temporary PostgreSQL 18.4 database created/dropped by the test. Verified: native-TLS restore recovery-read success with ordinary traffic and ingestion denial; bounded retention batches and retained-history API; external CA issuer ASN.1 encoding interoperability; CSR proof/tampering/forced identity/CA=false; header spoofing/foreignCA denial; concurrent single-use token; authenticated telemetry exact dedup+changed409+wrongmachine403; actual three-sample monitoring; real broker claim/result; rotation/revocation denial. Global TypeScript checking passed. No system trust store, unknown homelab endpoint or machine service was modified. Validation also exercised the actual built Go Windows agent against loopback TLS/PostgreSQL: enrollment CSR, three real samples, restart with durable sequence and certificate revocation denial (tests/integration/go-tls-postgres.test.ts). These are local host component checks, not enrolled homelab acceptance.

Without MACHINE_TEST_DATABASE_URL the realPG test skips explicitly. Actual Windows/Linux/GPU comparisons, OS installations, runner confinement, human-observed desktop semantics and real fault/recovery acceptance still require configured host evidence. Component success does not waive release gates.



## Retention maintenance

The worker invokes startTelemetryMaintenance(db,onError), which runs one batch immediately and every 60 seconds, coalesces concurrent ticks and stops before database shutdown. The explicit one-batch CLI is:

```powershell
npx --no-install tsx apps/api/src/modules/machines/retention-cli.ts
```

Configure METRICS_RAW_SECONDS (default 604800), METRICS_FIVE_MINUTE_SECONDS (7776000), METRICS_HOURLY_SECONDS (31536000), and METRICS_RETENTION_BATCH_SIZE (5000, maximum 10000). Windows must be ordered raw <= five-minute <= hourly. These are observation retention settings, not a generic file/job pruning command. Restore mode blocks maintenance, enrollment, rotation and telemetry writes. Authenticated poll/results remain open solely to let the broker enforce its narrow, newly signed current-epoch recovery-read channel; ordinary requests/results remain denied.

Each transaction takes a nonblocking advisory lock and uses a 15-second statement timeout. It processes at most one bounded raw-row batch, merges min/max/weighted mean/available count/missing count by machine+boot+series+device+unit+source+kind into both retained resolutions, then atomically removes those source rows. Retrying a committed batch cannot double count because those source IDs are gone. Failure rolls back all three effects. At most one bounded batch per resolution expires; referenced machine/job/audit/artifact metadata is untouched. No empty buckets are synthesized. Boundary buckets may extend slightly beyond an exact range/window, explicitly labeled in the API.

History reads raw and stored rollups in one repeatable-read snapshot, avoiding a race that would count both the old raw rows and newly compacted rows. The local real-PostgreSQL test processes three one-row batches containing 10, unavailable, and 30, then verifies both resolutions retain min10/max30/mean20/count2/missing1, raw fresh observations survive, and the API reads retained history correctly.

Additional onboarding routes: GET /machines/:id/host-identities, /roots, /host-targets use owner-scoped signed host discovery; POST /machines/:id/execution-identities/:host_identity_id/verify runs the protected host proof. Create/PATCH accepts max_concurrent_operations (1..32, default1) under revision checking. Client values cannot assert that an execution identity has been verified.




## Resumed validation and identity replacement

The resumed machine suite passes 16/16 tests with isolated PostgreSQL 18.4 and native loopback TLS, with no skipped tests. Global TypeScript checking also passes. Tests create unique databases and close/drop their listeners and databases in finally blocks. Validation/Actions additionally confirmed actual Linux Go enrollment against the disposable API using the external OpenSSL CA, exercising the issuer-name interoperability fix. The separate actual Windows Go ingestion fixture covers enrollment, real samples, durable sequence restart and revoked-certificate denial.

The full suite was rerun successfully after migration016 activation. It verifies enrollment generation equals the database pin, rotation preserves it, re-enrollment changes it, an old prepared enqueue is rejected, and a stale captured-generation capability job stays unverified. A separate native TLS race revokes the certificate after onRequest authentication but before broker claim; the transactional certificate fence returns 403. The fixture also confirms delayed observations retain the maximum bucket receipt timestamp independently of observation ordering.

Fresh enrollment replaces the installation identity: it revokes old certificates, changes identity_generation, clears machine agent inventory/verification, invalidates execution identity restriction proofs, and quarantines pending RPC envelopes in one transaction. Never-delivered envelopes expire; delivered envelopes retain outcome_unknown evidence. Certificate rotation preserves installation generation, proof and pending work. Both certificate responses expose machine_identity_generation for protected host pinning. Native poll/results pass the authenticated certificate serial into the broker, which holds a current certificate lock through its transaction. Telemetry rechecks the certificate inside its write transaction under the same machine-first lock order as revocation. Owner discovery/proof requests capture the initially selected generation in expectedMachineGeneration. Capability jobs retain the original machine_identity_generations map and reject absent or changed generations before dispatch and before reporting success. Migration016 and the shared transport own durable generation fencing; legacy pending envelopes cannot silently inherit replacement authority.

Upgrading a host with a pre016 protected identity requires genuine pinned-TLS enrollment or trusted rotation to obtain its authoritative generation, followed by supervisor restart to reload the pin. Incoming signed requests cannot supply or replace the local protected pin. The generation-aware host rejects new generation-bearing requests when the protected pin is missing with machine_identity_generation_unconfigured_reenroll_or_trusted_rotation_required, and rejects missing/mismatched generations once pinned. Rotation of an existing nonempty pin cannot change it.

Runner probes compare actual UID and GID or Windows SID with the protected expected identity. Fault-injected mismatch invalidates the backend identity proof; this is a rejection test, not a claim of host confinement. Final capability evidence requires the current shared job lease/fence and current certificate/boot snapshot in the same transaction. Revocation during testing cannot promote healthy. Cancellation retains unknown-operation locks until the shared executor reconciles them. Container tests require an owned enrolled docker_container target permitting status and a captured actions.run grant; a known status receipt proves helper inspection, with container_running recorded separately.

Local component success does not establish sensor accuracy or full homelab acceptance. Real Windows/Linux reference comparisons, hardware-specific GPU evidence where available, configured remote SSH/SFTP/Desktop observation, and complete runner cancellation/recovery drills remain explicit evidence requirements owned by the corresponding acceptance campaigns. Unsupported sensors remain null with a reason. No unknown host, system trust store or machine service was modified by these tests.

The host owner reports actual local Windows and WSL sample shape/availability evidence and reset/rate checks, without a measured CPU idle/load reference comparison. The tested configuration has no configured nvidia-smi adapter; GPU availability must remain explicit rather than implying a GPU inventory or passing a hardware accuracy test. No active telemetry wire or certificate incompatibility was reported on resume.

LOCAL_WINDOWS_REFERENCE.json records a separate bounded read-only Windows component snapshot at 2026-10-21 04:37:22–28 UTC. Eight matched checks and zero failed checks cover physical memory total (exact), available memory (before/after envelope ±256 MiB), one volume capacity (exact) and free space (envelope ±64 MiB), and four cumulative network counters across two matched interfaces (exact before/after brackets). Eight collector network metrics could not be matched to the reference adapter inventory and have no comparison claim. The snapshot contains sanitized device aliases rather than hostnames, addresses, adapter names or volume paths. One-shot rates correctly remain unavailable, and GPU reports nvidia_collector_unconfigured. It does not establish sustained CPU/load accuracy, network rate accuracy, GPU support or whole T02/T03 acceptance.

CPU_REFERENCE.md and the CPU_* JSON artifacts add actual local one-second diagnostic CPU comparisons using immutable READY8 helpers. WSL direct /proc/stat comparisons matched six samples across baseline and a booked bounded-load phase, with full coverage and maximum difference 0.052 percentage points. Windows PDH remained inconclusive because invalid counter intervals and timing uncertainty failed the declared prerequisites; its threshold was not relaxed. A separate GetSystemTimes implementation comparison matched six baseline/load samples but explicitly shares the underlying OS primitive with gopsutil and is corroboration only (maximum difference 2.68 points). The sequential load phases took 7.76 seconds within validation's explicitly released idle window, at most two single-thread workers per phase; all workers/samplers/timing files were cleaned and the booking released. Background OS activity was not fully controlled. These results do not prove production-default 200 ms accuracy, monotonic full-load response, independent Windows PDH accuracy or configured Windows/Linux host acceptance.
