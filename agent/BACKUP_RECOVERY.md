# Encrypted host-state capture and offline recovery

The supervisor exports only roots from protected local configuration. It encrypts the tar stream with standard age X25519 before the first RPC byte is returned. The public recipient is pinned locally; a remote request cannot replace it, supply a filesystem path, or request plaintext. Keep the age private identity in separate offline escrow. Do not place that private identity under an exported root.

Enable `backup` in the supervisor configuration with `enabled`, `recipient`, `grant_ids`, positive `policy_revision`, canonical private `staging_dir`, and the explicit `connection_config_file`. Configure `external_writers_quiesced` only after stopping external project writers. Full capture automatically includes the supervisor configuration/token/identity/state, connection configuration/identity/CA/spool, registered projects and configured native spool/credential files. Additional fixed roots can include separately configured service logs. Missing components, links/special files, source changes and unasserted external writer quiescence are reported explicitly. Capture does not freeze unrelated applications or filesystems.

The outbound connection process acknowledges a protected local pause at a safe boundary after draining pending RPC results. Collection, certificate rotation and RPC polling stop during the cut. The hostops and supervisor writer barriers then freeze managed commands, consoles, file mutations, upload chunks and receipt changes. The live supervisor journal is snapshotted with `VACUUM INTO` through its owning SQLite connection. Metadata and validation passes never open another descriptor for that live database: closing any such descriptor on POSIX can release the process's SQLite locks. Other quiesced databases are first copied from approved rooted handles with their rooted WAL into private staging; SQLite opens only that private clone. Before/after source fingerprints detect changes. The captured journal contains the in-progress capture's durable identity and is recovered without automatically replaying it.

Defaults are 4 MiB chunks, a 4 GiB encrypted bundle, 100,000 entries, a four-hour deadline, four retained captures and a staging budget of eight times the bundle limit. Before admission, the supervisor reserves that logical capacity and verifies available disk space. Ciphertext, SQLite clones/snapshots and manifest metadata are bounded. Retained ciphertext remains until a matching hash acknowledgment or explicit deletion; an ambiguous capture is not silently replayed. Windows staging uses a protected DACL restricted to the current service identity, Administrators and SYSTEM; Linux staging requires current ownership and no group/other permissions. Staging and protected state must not overlap project roots.

Signed RPC endpoints:

- `GET /v1/host-state/policy` advertises the enabled policy, grant ID/revision, recipient fingerprint and chunk size.
- `POST /v1/host-state/captures` accepts `{operation_id,backup_set_id,grant_id,policy_revision}` and returns a durable asynchronous capture.
- `GET /v1/host-state/captures/:id` reports state and public coverage.
- `GET /v1/host-state/captures/:id/chunks/:index` returns bounded ciphertext with offset, size and SHA256.
- `POST /v1/host-state/captures/:id/ack` accepts the whole ciphertext SHA256 after durable remote storage; it removes the retained ciphertext.
- `DELETE /v1/host-state/captures/:id` requests cancellation or removes that owned retained capture.

Public coverage includes machine/boot identity and workspace IDs, never private key bytes, metadata attribute values or plaintext files. Native ownership, modes, access ACLs, timestamps and supported extended attributes are inside the encrypted authenticated manifest. Unsupported Windows SACL/storage semantics and Linux birthtime/inode flags are explicit metadata omissions; do not interpret data coverage as a promise to recreate every filesystem feature. Ciphertext chunk RPC receipts retain hash/size evidence rather than recursively embedding earlier backup payloads.

Offline commands (absolute paths required):

```text
homelab-agent backup-keygen --identity-file NEW_PRIVATE_FILE --recipient-file NEW_PUBLIC_FILE
homelab-agent backup-unseal --bundle CIPHERTEXT --identity-file OFFLINE_KEY --output NEW_PRIVATE_DIRECTORY --sha256 EXPECTED_CIPHERTEXT_SHA256
homelab-agent backup-remap --root NEW_PRIVATE_DIRECTORY --ciphertext-sha256 EXPECTED_CIPHERTEXT_SHA256 --supervisor-url http://127.0.0.1:NEW_PORT
homelab-agent trust-reconcile --config NEW_PRIVATE_DIRECTORY/recovered-supervisor.json --dispatch-epoch REVIEWED_NEW_EPOCH --dispatch-public-key-file REVIEWED_PUBLIC_PEM --key-id REVIEWED_KEY_ID --allow-unresolved
```

Unseal authenticates ciphertext and manifest entries, rejects traversal/links/special files/portable case collisions, enforces extraction limits, and uses an exclusive new private directory. A failed extraction can leave partial private files; it has no successful verification marker. `--apply-native-metadata` explicitly enables same-platform, pinned-handle offline ACL/mode/xattr restoration after authentication. Ownership changes additionally require `--allow-ownership-change`; special permissions require `--allow-special-permissions`. Neither option changes accounts, system policy or service installation.

Remap rechecks all file hashes and the authenticated manifest marker, remaps captured root paths and versioned identity metadata into the new directory, and writes new exclusive supervisor/connection configuration files. It does not start them. Restored execution and backup capture remain disabled pending account/ACL/environment review and fresh identity proof. Journals and historical operation IDs remain intact. Unknown operations retain reservations until explicitly reconciled; changing the control-plane epoch does not prove termination or authorize command replay. Review the connection endpoint, certificate validity/revocation and installation generation before reconnecting. Restore a provider/model capability only after its own test passes.

Recovery increments workspace revisions and records operational binding remaps in
an append-only local audit; historical request and receipt bodies are preserved.
Set the recovered connection's control-plane URL explicitly to the reviewed new
endpoint before starting it. Keep the source host and recovered host on their
separate reviewed endpoints throughout validation.

Local validation has exercised two distinct signed encrypted captures, remote
durable acknowledgement, external-process SQLite readers, linked live WAL/SHM
continuity and a cold restart preserving all capture IDs. These checks do not
verify a separate physical backup device or a configured Windows service account.
