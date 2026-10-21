# Workspace terminal component evidence — 2026-10-20/21

Windows: native package safe tests pass, including ConPTY API create/resize/close
without launching any child. Actual alternate-account ConPTY is **blocked pending
configured credentials/rights/ACLs**. No account was created and no administrative
project shell fallback was used. Terminal manager unit tests and Windows/Linux
vet/cross-compilation pass.

Manager tests prove bounded replay/cursor truncation; duplicate-ID no-relaunch;
detach/reconnect writer retention; original invocation preservation; verified
OS-stop-before-release; supervisor restart uncertainty without old PTY endpoint;
unavailable-host cancellation remaining unconfirmed; bounded input/backpressure;
real-proof admission gate; detach-grace cancellation; requested network-deny
intersection before writer admission and unsupported allowlist rejection.
Additional tests cover ambiguous launch retaining its writer with no replay,
closed-supervisor launch rejection, bounded Docker response capture and rejection
of root/foreign identity, privileged/host namespaces/network, unconfined profiles,
wrong mounts and increased resource settings. Eight portable manager tests and
two Linux container-policy tests pass (the latter include eight denial cases).

Actual WSL Ubuntu/systemd tests used the already existing nobody UID/GID 65534,
fresh owned `/srv` disposable roots, root-owned 0700 spool and the trusted compiled
agent identity-probe helper. They passed:

- `native.TestLiveLinuxRestrictedPTY`: actual UID output; controlling tty 80×24,
  resize to 100×35; foreground Ctrl+C recovery; cgroup cancellation. Recorded
  invocation `6007486ca5c34341ac62ec18d48f861d`. A 16 KiB approved project file was
  written successfully with an 8 KiB terminal output budget, proving those are
  separate policies; Ctrl+C recovery uses an unambiguous formatted output marker.
- `terminal.TestLiveRestrictedWorkspaceTerminal`: actual account proof then real
  PTY input/output and resize; detach/reconnect to the same invocation; stale
  prior-client detach/input rejected after replacement; writer acquired once,
  retained through detach/replacement and released only after real OS stop.
  Session `terminal-live-1792556236210884585`, invocation
  `89ebc821d42c45c1bad27297ab751a0a`.
- `terminal.TestLiveDedicatedContainerPTY`: fresh dedicated container from cached
  pinned `ubuntu@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac`,
  nonroot UID/GID 65534, strict no-network/read-only/cap-drop/no-new-privileges,
  exact project bind, 0.25 CPUs/64MiB/32 tasks. Actual PTY identity, 80×24→100×35
  resizing, reconnect, fixed systemd stop-helper escalation and independent Docker
  stopped-state check before writer release passed. Runtime
  `0ee304851a9873ef1561e04021b76761b4a6c05512f74fcfc0c866d62dbcb908`,
  start `2026-10-21T04:28:52.506273565Z`. Only this disposable container was removed.

The later fresh-helper proof with immutable
`homelab-agent-linux-wave3-integrated-3` passed in 11.37 seconds. Its first disposable
session passed explicit cancellation. After explicitly restarting that same owned
fixture, a second unique terminal received `exit 7`; ExecStopPost retained actual
Docker-exec status 7, stopped the environment, and only then released its second
writer. Runtime `708a8ae48a135eacfb260c046a8d2edfbff4a17d1e72973ae7deaf309e8e2585`,
start `2026-10-21T04:34:59.756081105Z`. All fixture units/container/directories were
cleaned. Full signed API/worker/WebSocket/browser and revocation/fencing
integration are separate host/queue/frontend gates; these component tests do not
claim that aggregate acceptance already passed.

Reproduction (compile test binaries with the pinned Go toolchain, GOOS=linux,
GOARCH=amd64, CGO_ENABLED=0, then remove cross-build environment variables):

```text
sudo env HOMELAB_NATIVE_LIVE=1 HOMELAB_NATIVE_AGENT_EXE=<trusted-agent> \
  <terminal-linux.test> -test.v -test.run=TestLiveRestrictedWorkspaceTerminal
sudo env HOMELAB_TERMINAL_CONTAINER_LIVE=1 HOMELAB_NATIVE_AGENT_EXE=<trusted-agent> \
  <terminal-linux.test> -test.v -test.run=TestLiveDedicatedContainerPTY
```

Do not run these opt-in tests against unrelated containers, services or projects.
They create only uniquely named transient units/fixtures and explicitly clean
those exact resources. No local accounts, installed services or security policy
were created or changed.

Post-END focused follow-up: twelve portable terminal tests and two Linux policy
tests pass, with Windows/Linux vet and cross-compilation. New recording tests
cover all four protected-config/session-opt-in combinations, default opt-out and
stable-ID retention conflicts. New recovery tests cover trusted captured-old /
current-kernel boot-ID binding, idempotent release, and rejection of empty/equal/
mismatched IDs, live endpoints, current-boot sessions, legacy missing-ID records
and container boot-only claims. These are tests of the trusted local recovery
API and its refusal conditions. **No actual host reboot was performed.** The host
supervisor must supply actual kernel/current and protected journal/old boot IDs;
no RPC caller can assert reboot proof. Native Windows alternate-account runtime
remains an external configured-account gate.

P1 boot-identity correction: the earlier host wiring supplied a clock-derived
`machine:BootTime` identifier. The candidate now permits boot-only termination
only when both captured and current identifiers are canonical, nonzero
`osboot-v1:<current-OS>:<UUID>` values and differ. Legacy identifiers and OS-query
failure retain the writer and require ordinary OS process reconciliation. A fake
still-running process regression covers legacy clock shifts and query failure;
full portable native/terminal tests pass on Windows and Linux, along with both
platform vet checks and Linux test cross-builds. Actual OS boot queries and
supervisor wiring belong to the host component. These checks did not reboot the
host or modify the previously running immutable runtime.

Main signed UI terminal privacy corroboration (helper11): session
`6ee0d669-2775-4cb6-810d-ed44c7384a39`, job
`fb5d1b4b-f18a-4b5a-be05-b83a298ff27f`, was independently reported stopped with
container PID0, no writer locks and no retained output. Read-only host metadata
confirmed its terminal record exited, `retain_output=false`, no transcript file,
and zero journal log rows/bytes. The operation receipt was failed and the terminal
record reported container-shell-exit-unavailable; no shell exit-code claim is
inferred.
An IDs-only mapping of 183 central RPCs matched 182 host receipts: 26 were expired
input tombstones, all status410 with the fixed expiry response; no active input
fingerprints remained; 99 were expired-output gap responses. No matched receipt
contained an encrypted output envelope or nonempty top-level output data, and no
matched connection outbox row remained. One central ID had no host receipt;
absence alone does not establish its delivery outcome. Separate fixture-wide
counts were 485 receipts, 26 expired input tombstones, zero active input
fingerprints/output envelopes and an empty connection outbox. Those aggregate
counts are not independently session-scoped because scrubbed tombstones erase
session linkage. No payload bytes, terminal input/output or keys were displayed;
the check made no changes and started no processes.
