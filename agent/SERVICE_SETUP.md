# Operator service setup

No instructions in this file have been executed automatically. Provision the
dedicated execution accounts and actual ACL/logon rights described in
`internal/native/README.md` first; the privileged supervisor identity must never
be the identity used for project commands. Keep binary/configuration/keys/journal
and approved root ancestors outside project write access. Record installed binary
hashes and backed-up configuration before changing them.

On Linux install the reviewed Linux binary in a root-owned read-only executable
directory such as `/usr/local/libexec/homelab-agent`. Run **two independent units**:

```ini
[Unit]
Description=Homelab execution supervisor
After=local-fs.target
[Service]
Type=simple
ExecStart=/usr/local/libexec/homelab-agent supervisor --config /etc/homelab-supervisor/config.json
Restart=on-failure
UMask=0077
[Install]
WantedBy=multi-user.target
```

Create a separate connection unit with
`ExecStart=/usr/local/libexec/homelab-agent connect --config /etc/homelab-agent/connection.json`
and its own unprivileged `User=` account. Grant it read access only to its own
certificate/key and supervisor bearer token, not the supervisor journal/account
credentials. The supervisor needs carefully reviewed service-manager and/or Docker
authority. Do not add an arbitrary project account to the Docker group. Install
unit files and enable them only after the operator reviews the exact paths and
identity policy. Existing-folder unregister and service removal preserve project
and supervisor state directories. Avoid `PrivateTmp` on the supervisor if approved
roots intentionally live under `/tmp`; native operation units use their own
documented private namespaces.

Windows binaries implement the Service Control Manager protocol in `service`
mode. In an elevated administrator PowerShell session, after manually reviewing
ACLs and paths, register independent services using quoted absolute paths:

```powershell
$binary = 'C:\Program Files\HomelabAgent\homelab-agent.exe'
$supervisorArgs = '"' + $binary + '" service --name HomelabSupervisor --mode supervisor --config "C:\ProgramData\HomelabAgent\supervisor.json"'
New-Service -Name HomelabSupervisor -BinaryPathName $supervisorArgs -StartupType Automatic
$connectionArgs = '"' + $binary + '" service --name HomelabConnection --mode connect --config "C:\ProgramData\HomelabAgent\connection.json"'
New-Service -Name HomelabConnection -BinaryPathName $connectionArgs -StartupType Automatic
```

Configure service identities, recovery actions and filesystem ACLs explicitly
before starting either service. The connection service should use a dedicated
low-privilege identity. The supervisor's LogonUser/CreateProcessAsUser requirements
are documented in the native guide. Execution passwords remain protected exact
UTF-8 local files, without a trailing newline; never put them in service arguments.
The installer does not create/reconfigure any account, privilege, firewall or
service automatically. Removing either service does not delete keys, journals,
project files or retained artifacts. Windows credential-backed native/SCM service
installation remains an actual-machine validation step for the operator.

Upgrade by stopping the connection service first, reconciling/draining mutations,
taking the supported backup, stopping the supervisor, replacing the reviewed
binary, and restarting supervisor then connection. Never discard unknown operation
receipts or reset the dispatch epoch merely to clear a job. Restored control-plane
epochs require the explicit operator reconciliation described in the main guide.

For an isolated restore, keep control-plane dispatch disabled, stop the local
supervisor and connection, verify the restored server's signing public key and
new dispatch epoch through the trusted recovery channel, then run:

```text
homelab-agent trust-reconcile --config /protected/supervisor.json --dispatch-epoch VERIFIED_NEW_UUID --dispatch-public-key-file /protected/verified-dispatch-public.pem --key-id VERIFIED_KEY_ID
```

The command acquires the same OS-exclusive state lock as the supervisor and
refuses to change a running service. It validates Ed25519 and refuses a dispatch
key inside project storage. By default it refuses unresolved operations. After
reviewing their exact IDs/outcomes, `--allow-unresolved` changes authority/fence
metadata while preserving those original records and workspace reservations;
it never acknowledges success, reruns commands, or deletes their logs. Restart
the supervisor, reconcile/cancel original operations by their original IDs, and
only then enable new dispatch. A partial filesystem/database trust update fails
closed; rerun the same explicitly reviewed command to complete the metadata change.
