# Wave 2 host components

This supersedes the original baseline's missing-code descriptions. It is a
component report, not a claim that the full real homelab release matrix passed.

Implemented:

* ECDSA P256 local CSR/bootstrap, server-CA verified HTTPS enrollment, atomic
  versioned certificate/private-key rotation, explicit dispatch-key pinning.
* Separate outbound mTLS poll/results/telemetry connection process and independent
  authenticated supervisor. Signed Ed25519 RPCs bind machine, epoch, body, path,
  method and expiry; ordinary bearer requests cannot bypass required signatures.
* FULL/WAL durable operation and RPC receipts/results, monotonic fences,
  unknown-operation reservations, journal reconciliation and explicit offline
  operator trust/epoch reconciliation preserving all historical operations.
* Native Linux systemd numeric UID/GID containment; Windows restricted-account
  token/suspended Job Object launcher; no current-account fallback. Provisioning
  remains a deliberate administrator task. Windows SCM and Linux unit setup
  paths run supervisor and connection independently.
* Protected rooted file/lifecycle/action helpers, pre-restore captures, cumulative
  quotas, quarantine outside project storage, expected-manifest recovery and
  immutable runtime binding changes.
* Trusted container helper caps/frames output before Docker logging and owns the
  offline timeout. User environment remains rejected; operation/job/workspace IDs
  are injected by the trusted supervisor for audit/sentinel fixtures.

Windows local tests and `go vet ./...` pass; Windows/Linux amd64 binaries build.
Tests prove signature tamper rejection, signed-only bypass rejection, durable
replay, expired RPC denial, namespace/path/symlink checks, fencing races, unknown
launch refusal, verified cancellation progression, log quota framing, persistent
telemetry sequence, OS-exclusive state locks and trust changes preserving unknown
records. Generic canonical JSON matches Node integer-key ordering and UTF-16
key comparison, including non-BMP/PUA fixtures.

Actual Linux primitive evidence is in `internal/native/LIVE_EVIDENCE.md`: existing
WSL Ubuntu/systemd255/cgroupv2 nobody UID/GID65534, real scoped write and sibling
denial, distinct private network, parent/descendant cancellation, kernel timeout,
bounded output, Runner reconstruction and trusted identity helper proof. No
account, security-policy change or installed system service was created. Fixture
units/directories were cleaned. These results do not validate Windows native
execution; that requires configured restricted Windows credentials and rights.

The validation/operations tracks own the separate cross-process PostgreSQL/TLS/
actual-Go/action/container/backup evidence. A local or deterministic model-provider
fixture is not evidence of a configured external model server. Desktop/SSH/GPU and
external-host tests still require their actual configured endpoints. Sanitized
metrics evidence omits hostname, addresses and secrets.

At the user's requested pause, remaining host code gaps are a complete fixed-root
host-state bundle export (identity/config/connection spool/quarantine/precheckpoints)
and chunked transfer for journal exports above 32 MiB. The current online SQLite
export is explicitly journal-only and cannot establish full-host backup coverage.
Windows restricted-account runtime and installed SCM-service verification require
actual configured credentials/rights; their launch/service code is present.
The trusted container helper's log-cap/framing tests pass; use the validation
track's separate evidence for actual end-to-end Docker runs.
