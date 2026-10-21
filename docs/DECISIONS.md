# Implementation decisions

Preserve ADR-001–014 in the planning pack. No stack deviation: npm TypeScript workspaces, Fastify modular API, separate worker, PostgreSQL, Go host, React web. Native folder shell execution is disabled until actual identity and containment enforcement are proven. Desktop launch is disabled until gateway authorization and active revocation are demonstrated. Neither is replaced by a mock.

ADR-015: database migrations are platform-owned, transactional and checksum-verified under an advisory lock. API readiness checks dependencies without creating schema automatically. Migration is a separate operator step.

ADR-016: scope grants require captured plus current persisted policy; malformed/expired/revoked grants deny. Human metadata CRUD still uses database owner checks. Model/profile/machine/workspace choices remain independent and historical context frozen.

ADR-017: runtime_control stores dispatch epoch, disabled-by-default flag and restore mode. Backup restore rotates epoch and disables dispatch; old jobs cannot replay by restarting worker.

ADR-018: no live credentials requested this build: user chose local implementation with homelab setup later. Missing integration prerequisites are reported blocked, never passing.


Resumed migration integrity correction: an early shared image had already applied migration012 before a backup-reference correction was made to its source. Checksum validation correctly refused the mismatch; no migration-ledger rewrite or database reset was performed. The exact applied012 bytes were recovered from that image (SHA256 d826527b4c2f0b78eca5a505c7831c4ebc97f4876b3c1cce5cf10475b2f08901), restored as immutable history, and the correction moved into additive015. Fresh001–015 tests pass. Shared upgrades are coordinated explicitly with operations before source consumers run; short booked integration windows freeze schema/image changes.

Reviewed recovery resolution is a separate internal broker class. Only the exact append-only file partial-acceptance endpoint is permitted during restore, after current owner/grant/binding, reviewed manifest, unexpired DB review, matching stable resolution ID and writer-token fencing. The same review is atomically consumed with durable enqueue; first delivery rechecks it. Recovery manifest reads return metadata only. Host trust epoch reconciliation remains mandatory and historical queued work remains quarantined.


Terminal transport privacy correction (forward018): a public digest or original Ed25519 signature of a low-entropy keystroke permits dictionary recovery even after raw bytes are scrubbed. Sensitive terminal delivery rows therefore retain ID/status-only tombstones after acknowledgement/consumption/expiry, and same-ID retries return410 rather than re-executing. Process-operation hashes remain retained because they establish a separate execution receipt. Forward018 cleans existing terminal rows without rewriting migration history. Short delivery staging is distinct from opt-in retained transcripts; logical cleanup does not promise forensic deletion from PostgreSQL WAL or historical backup archives. Restore fencing applies equivalent redaction before a restored database is served.
