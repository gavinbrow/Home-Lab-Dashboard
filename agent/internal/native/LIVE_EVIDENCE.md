# Native execution evidence — 2026-10-20

Current Windows workstation: nine safe native-package tests pass; native package
`go vet` passes. No alternate restricted Windows account/credential was supplied,
so actual Windows LogonUser/CreateProcessAsUser, ACL denials, descendant cleanup,
CPU/memory/process limits and kill-on-close tests remain **blocked**. Compiling the
Windows launcher does not establish those results.

Local WSL2 Ubuntu is a distinct Linux machine/runtime. Read-only inspection found:
systemd PID 1, systemd 255 (255.4-1ubuntu8.18), cgroup v2 cpu/memory/pids
controllers, existing nobody UID 65534/GID 65534 with only nogroup, and existing
passwordless sudo for the local owner. The native test uses root **only as the
transient-unit supervisor**; all project commands execute as nobody. No accounts,
security policy, installed services, or unrelated services were modified.

The opt-in `TestLiveLinuxRestrictedIdentityAndCgroup` passed against that real
runtime. It created a fresh `/srv/homelab-native-*` project/scratch and root-owned
0700 spool, then launched uniquely named systemd operation services. It proved:

- Actual process output `uid=65534(nobody) gid=65534(nogroup)` and actual `/proc`
  UID/GID credential inspection; successful approved-project write.
- Sibling write denied with `Read-only file system` and no forbidden file created.
- Private network namespace differs from supervisor host namespace.
- Original launch context cancellation does not terminate the unit.
- A new Runner can inspect/recover the original invocation and cancel it.
- Parent plus ordinary sleep child cancellation; child PID independently checked
  after cancellation and not running. Confirmed result persisted in protected
  cancellation receipt when systemd garbage-collects the stopped transient unit.
- Two-second kernel RuntimeMaxSec stops parent plus child with result `timeout`,
  exit status 15; child independently checked not running.
- 8192-byte regular-file output quota stops a 16384-byte writer at 8192 bytes
  with signal 25 (SIGXFSZ). LimitCORE=0 prevents core-file retention; systemd can
  still label the signal termination `core-dump`.

Last recorded four operation invocations, including launch-context cancellation
and Runner reconstruction assertions:

| Case | Invocation ID | Observed result |
|---|---|---|
| Identity/scope | d1b8734e171343f094c20a5bd7e55fd8 | success, exit 0 |
| Cancel | 13de3cc377814f94a6f62999e28da937 | cancelled_containment_stopped, exit 143 |
| Deadline | 200e555350d7489f83d00450560dd285 | timeout, exit 15 |
| Output | 96cfef076dd845c495abede0a83b214c | signal 25, 8192 bytes |

The opt-in `TestLiveLinuxIdentityProof` also passed using the host agent's compiled
`agent/bin/homelab-agent-linux-amd64` trusted `identity-probe` helper. It ran as
nobody in a separate disposable root/scratch, verified project/scratch temporary
file writes, denied protected sentinel reads and parent-directory writes, and
persisted a real valid proof at `2026-10-21T03:45:47Z` with digest
`386ee2df6885f503e0e5b50300cf1088928f51bc3e6bf46b943d1695b0eb7573`.
Changing configured UID invalidated that proof; an invalid explicit recheck
removed the previous green result. Helper resources/units were also cleaned.

All fixture directories and transient units were cleaned; final `systemctl
list-units --all 'homelab-native-live-*'` returned zero loaded units and no fixture
directory remained under `/srv`. Initial development failures exposed PrivateTmp
hiding `/var/tmp` fixture roots and transient-unit GC after stop; those paths were
fixed and rerun. The two initial failed units were explicitly reset by exact name.

Reproduce from Windows PowerShell in the agent directory:

```powershell
$env:GOOS='linux'
$env:GOARCH='amd64'
$env:CGO_ENABLED='0'
.\.tools\go\bin\go.exe test -c -o .tools/native-linux.test ./internal/native
Remove-Item Env:GOOS,Env:GOARCH,Env:CGO_ENABLED
wsl -d Ubuntu --exec /bin/sh -c 'sudo -n env HOMELAB_NATIVE_LIVE=1 HOMELAB_NATIVE_AGENT_EXE=/mnt/c/Projects/Home-Lab-Dashboard/agent/bin/homelab-agent-linux-amd64 /mnt/c/Projects/Home-Lab-Dashboard/agent/.tools/native-linux.test -test.v -test.run=TestLiveLinux -test.timeout=45s'
```

This is native primitive evidence, not full R01–R17 release acceptance. End-to-end
enrollment, browser closure/recovery, provider tools, backup, desktops and actual
Windows restricted execution require their separate configured-runtime tests.

Wave3 short-probe regression found two genuine timing/resource failures and fixed
them without accepting logs as authority: MainPID may exit between a systemd
snapshot and `/proc` open, so ENOENT now triggers at most three fresh reads of the
same verified invocation. Separately, TasksMax=8 counted Go runtime threads and
intermittently caused `newosproc` after successful access checks. Only the fixed
trusted identity-probe task budget is now 32; project-command limits stay unchanged.
Twelve copied-binary actual probes then passed consecutively at 04:31:44–46Z.
