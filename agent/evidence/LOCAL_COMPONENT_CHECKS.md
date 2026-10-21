# Host-agent evidence — local components only

Date: 2026-10-20 (America/Chicago). Initial workspace contained the planning pack
and no Go toolchain on PATH. Official `go1.27.3.windows-amd64.zip` was downloaded
under `agent/.tools`, verified against SHA-256
`f26081f438319757f8a1b46d7d0b2c5ec7583d4038e485e0aa725cfde7885fff`, and expanded
without system installation. Dependencies are pinned by go.mod/go.sum.

`go test ./...` passes Windows local component tests for receipt durability after
SQLite reopen, duplicate dispatch, request conflicts, concurrent monotonic fences,
unknown launch without replay, created-but-not-started recovery, cancellation
receipt progression, expired-before-launch rejection, native execution rejection,
rooted reads/writes, reserved paths, stale saves, binary capture, symlink escape
(when symlink privilege available), rate-counter reset, bearer-gated local routes,
loopback restriction and cleartext transport rejection. Fake container backends
verify state logic only; they are not process-tree or containment proofs.

`go vet ./...` passed. Windows amd64 and Linux amd64 production binaries compiled
with `-trimpath`. One actual local collection ran on Windows 11 Pro 26H2, 32 logical
cores: 38 metrics, 23 available and 15 explicitly unavailable (including first
interval counter rates and unconfigured GPU collector). The sanitized summary is
`windows-collect-summary.json`; no hostname, IP, credentials or real enrollment ID
is included. This observation is not T03 accuracy/reference-tool acceptance.

No configured Linux/Windows homelab endpoint, restricted execution account,
verified Docker image/container project, GPU collector, CA/enrollment server or
model/provider credentials were supplied. Nothing was contacted or installed as
a host service. M00 native identity/process-group proofs and real T02/T03/T08–T12,
T15/T21 remain BLOCKED/NOT RUN. Linux cross-compilation is not Linux validation.
No v1-complete or live OS support claim is made.

This is the initial component baseline. Later real Linux restricted-identity and
PTY evidence is documented under `internal/native/` and `internal/terminal/`;
actual Docker lifecycle tests are under `internal/hostops/`. Current encrypted
capture/recovery procedures and their limitations are in `BACKUP_RECOVERY.md`.
`ENCRYPTED_NATIVE_METADATA_RESTORE.json` records the separate authenticated Linux
full-bundle metadata restore proof. The baseline's historical unrun list does not
describe the later implementation's current test status.
