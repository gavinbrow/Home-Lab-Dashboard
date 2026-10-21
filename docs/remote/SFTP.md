# OpenSSH chroot SFTP

Scoped SFTP supports the whole namespace of an operator-provisioned OpenSSH chroot-only account. It does not accept a subdirectory of an unrestricted SSH account as isolation. Windows ACL-only confinement remains unavailable until a corresponding tested adapter exists. Chroot-only connections cannot use the human SSH terminal route.

Provision a root-owned, non-writable OpenSSH ChrootDirectory, ForceCommand internal-sftp, disabled forwarding/TTY, and a separate writable data directory. Keep secrets outside the jail. Place an immutable random marker inside it, hash the marker bytes through trusted host-local access, and establish a readable canary outside the jail whose existence is checked locally. The API cannot independently prove sshd configuration: explicit operator attestation identifies that trusted provisioning step, while runtime tests check identity, denial and file behavior. Scope is the entire jail, including intentional mounts. A narrower apparent root is not promised.

Enroll an SSH connection with `account_scope:"sftp_chroot"` and this `config.sftp` in addition to pinned SSH endpoint fields:

```json
{
  "type":"openssh_chroot",
  "virtual_root":"/",
  "host_root":"/actual/trusted/host/chroot",
  "operator_verified_sshd_chroot":true,
  "root_marker_path":"root-marker",
  "root_marker_sha256":"<trusted SHA256 hex of actual marker bytes>",
  "outside_canary_path":"/actual/known/outside-canary",
  "operator_verified_outside_canary_exists":true,
  "verification_directory":"data"
}
```

`POST /api/v1/remote/connections/:id/sftp-test` validates the marker, denies the known outside canary, creates one random dedicated test file, verifies its SHA256 and removes only that file. Successful verification is server-owned and lasts 24 hours; clients cannot supply `verified_at` during enrollment. Each access reconnects with the pinned host key and rechecks marker/canary. A changed host key fails closed.

`GET /api/v1/remote/connections/:id/files?path=data&operation=list` returns at most 1,000 entries. `operation=read` returns bounded base64 bytes. `POST /api/v1/remote/connections/:id/files` accepts `{path,data,encoding:"base64"}` for exclusive new-file uploads. Existing files/symlinks are not overwritten. A failed upload may leave a partial new file, reported as failure; no retry silently overwrites it. Relative traversal and Windows path syntax are rejected. Canonical checks are defense in depth; the chroot is the actual boundary against rename/symlink races. Restore mode denies all remote access/tests.

`docs/remote/test-fixture/Dockerfile` is a synthetic, unpublished local test account with a deliberate public test-only password. It must only run on the isolated fixture network. The real Linux jail test checks root identity, a known host-side canary denied from SFTP, random hash round-trip/cleanup, existing-file overwrite denial, traversal denial and a jail-only directory listing. It does not establish Windows support or real homelab configuration.

