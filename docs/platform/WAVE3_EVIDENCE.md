# Resumed platform integration evidence

Focused actual PostgreSQL18.4 run, isolated uniquely named disposable databases, loopback only. Command: `tsx --test tests/unit/database-roles.test.ts tests/unit/blob-publication.test.ts tests/unit/secret-rotation.test.ts tests/unit/delivery-authority.test.ts packages/transport/test/*.test.ts` with explicit HOMELAB_LOCAL_PG_URL from validation-owned fixture manifest.

Result: 8 PASS, 0 FAIL, 0 SKIP. Each owned database/temporary role was removed by its test; shared validation PostgreSQL was left running for its owner. Migrations001–013 applied from fresh state.

- DML application role can insert/select, cannot create public/temporary tables, alter/drop application tables, update migration ledger or grant migration authority. Migration owner can apply and rerun migrations.
- Frozen queued attachment reference survives source attachment purge; non-live blob publication is rejected; external backup file hashes do not masquerade as central retained blobs.
- Secret rotation owner isolation/CAS and encrypted history/key reload pass. Existing remote session is revoked, connection version advances and SFTP/desktop proof is invalidated in the same transaction.
- Cancellation, worker fence changes and grant revocation after enqueue prevent first host delivery with explicit no-effects evidence.
- Canonical dangerous property preservation, signatures, route bounds and fixed cancellation validation pass.

Root TypeScript check passed after these changes. Production readiness additionally rejects privileged or schema/database-owning runtime database roles. This focused evidence does not replace filesystem GC concurrency, queued backup/deployment, terminal runtime, final aggregate tests or owner homelab acceptance.


Additive recovery follow-up: migrations001–015 fresh install passed, including original immutable012 restored from the applied image and forward015 correction. Focused reviewed-recovery actualPG test passed: normal POST denied in restore; tampered/foreign-used review denied; valid exact reviewed append-only request claims/responds; arbitrary files GET denied while metadata manifest allowed. Metadata-only preview and actual host partial-acceptance are separate storage integration gates.


Post-freeze platform suite: 12 PASS, 0 FAIL, 0 SKIP with fresh001-017 databases; root `tsc --noEmit` PASS. Added controlled two-order restore/response lock test, terminal GET/logout/controller boundary, delivery staging consume/expiry/late-ACK no-resurrection and closed-terminal backup scrub, installation replacement/rotation and newly required optional profile cap denial. The actual185-second model attempt e815a839-1ac7-42fc-8c3b-7764c8ed07bb failed strict argument validation before any host operation; it does not pass the duration gate. Actual Gen6 native preflight77cf1d13-38b8-458d-baa0-53901b2ecffc and independent verification/diffs passed separately.


Forward018 privacy correction: public SHA/signature proofs of one-character terminal frames permit dictionary recovery even after byte scrub. Sensitive delivery tombstones therefore retain IDs/status only, with original request signatures removed at acknowledgement and response fingerprints removed on consume/expiry. Actual fresh001–018 PostgreSQL focused suite:12 PASS,0 FAIL,0 SKIP; root TypeScript PASS. The terminal test exercises historical public-proof row cleanup with the exact018 SQL, same-ID410/no replay, duplicate acknowledgement410 and late-ACK no resurrection. Process-operation receipt hashes are unaffected. Immutable017 deployed images have not been silently replaced; host counterpart and integrated terminal proof remain separate gates.
