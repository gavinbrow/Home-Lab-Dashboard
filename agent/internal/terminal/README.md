# Restricted workspace terminals

The supervisor owns PTY/ConPTY endpoints and OS containment. Browser/API sockets
are clients of a stable terminal ID, never the process parent or writer lease.
Human administrative SSH remains a distinct capability.

`Config` contains an enrolled native identity or dedicated Linux container,
trusted shell/arguments, network/resource policy, protected state directory,
disconnect grace, input-idle timeout, bounded replay capacity and optional raw
transcript recording. No browser-supplied executable/arguments/environment are
used to start a console. The full signed `Spec.Request` is captured as immutable
authorization/environment context. Current host authorization/fence checks remain
mandatory for every route; the manager is not an unauthenticated transport.

Native consoles require a fresh real identity/access proof from the configured
account, rather than `acl_reviewed` alone. Linux starts an actual controlling PTY
inside the existing restricted UID/GID systemd policy. Its one slave is permitted
through a closed device policy. Windows uses ConPTY with a LogonUser batch token,
verified expected SID/nonprivileged groups/rights, suspended CreateProcessAsUser,
protected Job Object assignment/membership verification and only then resume.
There is no current-administrator shell fallback. Missing ConPTY/credentials/rights
or unenforceable native network restrictions produce explicit setup errors.

Linux containers use a fixed privileged Docker CLI helper in a transient systemd
unit; **all project shell code executes inside the nonroot container**. Enrollment
must name its immutable resolved ID, machine/workspace ownership, image digest,
UID:GID, exact project bind, CPU/memory/process limits and denied network. Host
namespaces, added capabilities, privileged mode, devices, socket/extra mounts and
unconfined security profiles are rejected. Actual `id -u`/`id -g` run under the
selected account before console admission. High-level environment generation is
also checked against the signed snapshot and the host's current binding.

**Container terminal termination stops the entire dedicated environment**, on
normal shell exit, cancellation or deadline. It must not host unrelated services.
Persistent project storage stays intact. Killing the Docker client is never proof
that writable descendants stopped. A protected fixed-agent ExecStopPost helper
rechecks exact container ID/start identity and isolation, then stops/verifies the
dedicated container. A restarted/mismatched runtime remains uncertain. The unit's
kernel deadline/stop helper survives a network-agent disconnect or supervisor
endpoint loss. External Docker administrators remain external writers; application
locks cannot prevent their out-of-band changes.

The trusted command helper is `homelab-agent terminal-container-stop --state
<protected-id.container.json>`. It accepts no project command and requires a
canonical supervisor-owned 0600 state file inside the configured private spool.
Container ExecStopPost retains Docker-exec's own exit result where available;
the container entrypoint's exit code is never substituted for the console code.
If the helper/result is unavailable, `exit_code` stays null with an explicit reason.

The signed host protocol uses `Start(ctx, Spec)`, `Read(ctx,id,after,max)`,
`AttachClient(ctx,id,client_id,after,max)`, `InputClient`, `ResizeClient`,
`DetachClient`, `Cancel`, `Inspect`, and `List`. Client IDs are stable connection
UUIDs. Replacing an attachment invalidates input/resize/detach from the old ID.
The API also checks its authoritative active connection before forwarding frames.
Replay uses byte offsets, base64 JSON bytes, `next_offset` and `truncated`; a
lagging client resets when older bytes fell out of the bounded ring. Empty output
is an empty base64 string. Input chunks are at most 65536 bytes and the queue holds
at most eight chunks; a full queue returns backpressure instead of buffering
without limit. Terminal dimensions are 2–500 columns and 2–300 rows.

Acquire/Release callbacks integrate the host durable writer journal. Acquire runs
before launch; a durable `launching` record precedes OS process creation. An
ambiguous launch retains the writer and cannot be automatically replayed. New
sessions initially await attachment within disconnect grace. Detach/replacement
never releases the writer. Expired grace/input idle requests OS cancellation;
release follows verified descendant termination and durable exit state. Callback
implementations must be idempotent, bind operation/job/fence exactly, and must not
reenter the manager or run while holding an inverted host-service mutex.

State lives below the protected supervisor spool, outside all execution-account
writable roots. On supervisor restart, an old live containment without its PTY
endpoint becomes `outcome_unknown`; it is never relaunched or unlocked merely
because an API process restarted. It may be cancelled/reconciled by the original
OS identity. Native Windows kill-on-close means seamless restart is not claimed.

Replay is bounded in memory. Raw transcripts are disabled by default; if enabled,
they are protected, bounded by the configured output quota and access controlled.
Recording requires both protected `Config.RecordTranscript` permission and the
signed per-session `retain_output: true` opt-in. Omission means false; replaying
the same session ID with a changed retention flag is rejected. The signed outer
terminal body binds this flag without changing the generic command-request hash.
Arbitrary programs may print secrets: terminal recording is not automatically
safe to share or a complete command-boundary audit. State records/offsets are
durable; a raw transcript is not required for reconnect during one supervisor's
lifetime. Process exit drains output before final receipt where possible and
reports incomplete final output explicitly if the bounded drain deadline expires.
PTY output quotas apply to replay/transcript bytes, not arbitrary project file
sizes. Native background-command spool policy remains separate; no filesystem
quota is claimed for a workspace terminal.

The local supervisor captures its actual kernel `BootID` in each new terminal
record. After a genuine host reboot it may call `ConfirmHostBootChanged`, binding
the old ID to the protected operation journal and the new ID to the actual kernel.
Only a recovered native session from that prior boot, with no live endpoint, can
be marked interrupted/exited and release its writer. Empty, equal, mismatched or
current-session boot claims are rejected. This method is never exposed as an RPC
accepting caller-supplied boot proof. Legacy records without a captured boot ID
stay uncertain, and Docker sessions require actual container reconciliation
because the daemon/runtime may survive the connection host's reboot.
Both IDs must be canonical nonzero `osboot-v1:<OS>:<UUID>` values from trusted OS
queries for the same platform. Legacy `machine:BootTime` clock estimates, raw UUIDs,
query failures and cross-platform pairs never authorize boot-only release. They
remain subject to normal containment inspection/cancellation or explicit reviewed
reconciliation; legacy values are never silently upgraded to strong proof.

Component tests and configured-runtime evidence are in `LIVE_EVIDENCE.md`.
