# Backup snapshot retirement

Retirement is an operator maintenance action. It does not run from a browser request or a timer. The application storage collector separately protects referenced artifacts/checkpoints and refuses collection during backup/restore maintenance.

`deploy/retention.py` uses reviewed restic0.18.1. It preserves every unregistered snapshot, the newest snapshot and every explicitly protected snapshot. At least one protected snapshot must have a recorded successful restore drill. An expired `retain_until` alone is insufficient: `retirement_approved` must also be true. Keep incomplete captures, incident evidence, required key versions and restore investigations protected until their owners release them.

Maintain a protected register outside the repository. Use full snapshot IDs and timezone-qualified times:

```json
{"schema_version":1,"snapshots":[{"snapshot_id":"FULL_64_HEX_SNAPSHOT_ID","retain_until":"2027-01-01T00:00:00+00:00","protected":true,"restore_verified":true,"retirement_approved":false}]}
```

During a quiesced repository window, with the same protected `RESTIC_REPOSITORY` and `RESTIC_PASSWORD_FILE` used for capture:

```sh
python3 deploy/retention.py plan --registry /protected/recovery-register.json --plan /protected/NEW-retirement-plan.json
python3 deploy/retention.py apply --registry /protected/recovery-register.json --plan /protected/NEW-retirement-plan.json --approve-plan-sha256 REVIEWED_PLAN_SHA256 --repository-quiesced --receipt /protected/NEW-retirement-receipt.json
```

Review the exact `remove` and `keep` IDs before supplying the plan digest. Plans expire after one hour; changing the repository snapshot list or register requires a new plan. Apply first claims a new receipt, performs a full repository read check, forgets only the approved full IDs and performs another full check. A partial failure leaves a started receipt for reconciliation; do not blindly retry it. No repository URL or password is written into the plan.

The helper deliberately does not prune data packs, remove plaintext staging, change application backup history or delete local/remote project bytes. Forgotten snapshots lose their recovery references even while their encrypted data remains stored. Reclaiming physical repository space requires a separately reviewed restic maintenance procedure and a current recovery register. See the [official restic0.18.1 retirement documentation](https://restic.readthedocs.io/en/v0.18.1/060_forget.html).

An actual isolated three-snapshot rehearsal retired one approved snapshot while retaining an unregistered snapshot and a protected, byte-restored snapshot. Changed-register, wrong-approval and retry attempts failed; final full read check and protected-file restore passed. Evidence remains under `/tmp/homelab-retention-drill-ljpei2k8`. No canonical backup repository or unrelated Docker state was modified, and no data prune occurred.
