# 03 — Machines, Monitoring, SSH, and Remote Desktop

## Purpose and first-version boundary

Implement a usable control surface for real Windows and Linux computers. A machine is an independently identified resource with capability-specific status. Its monitoring agent, SSH server, desktop server, container engine, and configured services can succeed or fail independently. Never infer that a computer is fully manageable because one TCP port is open.

This document defines proposed product behavior. Numerical intervals and operational limits below are configurable starting defaults, not vendor guarantees. Implementation must record tested software versions and machine configurations.

The working first version includes machine enrollment, live and historical metrics, interactive SSH terminals, scoped file management, browser RDP/VNC connections, selected service/container operations, parameterized actions, and a durable host runner for background commands. A host without a desktop can still be fully usable for monitoring and jobs. A host without the runner can offer SSH, but cannot claim reliable supervised background execution.

## 1. Reuse these components

| Requirement | Selected component | Integration responsibility |
|---|---|---|
| Browser terminal | [xterm.js](https://github.com/xtermjs/xterm.js) | Render terminal input/output; application supplies authenticated WebSocket transport, resize messages, session identity, and access control. |
| SSH and SFTP | [ssh2](https://github.com/mscdex/ssh2) in the TypeScript backend | Connect to enrolled hosts using server-held credentials and verified host keys; expose shell, SFTP, and bounded diagnostic execution. |
| Browser desktop | [Apache Guacamole web application and guacd](https://guacamole.apache.org/doc/gug/guacamole-architecture.html) | Browser connects to the Guacamole web layer; guacd connects to the enrolled RDP/VNC server. Deploy both components. |
| Desktop authorization | [Guacamole JSON authentication extension](https://guacamole.apache.org/doc/gug/json-auth.html) | Backend issues encrypted/signed connection descriptions with expiration; gateway enforces the dashboard session and connection scope. |
| Cross-platform basic metrics | [gopsutil](https://github.com/shirou/gopsutil) inside the Go host agent | Normalize CPU, memory, disk, and network observations; test each OS/platform combination rather than assume every field exists. |
| NVIDIA GPU metrics | [NVML / NVIDIA management interfaces](https://docs.nvidia.com/deploy/nvml-api/index.html) | Prefer NVML bindings where supported; bounded `nvidia-smi` queries are a fallback adapter. |
| Linux remote session | [xrdp with xorgxrdp](https://github.com/neutrinolabs/xrdp) | Host-side graphical remote-session prerequisite; verify the chosen distribution/desktop configuration. |
| Linux physical desktop | [GNOME Desktop Sharing](https://help.gnome.org/gnome-help/sharing-desktop.html), or [TigerVNC x0vncserver](https://tigervnc.org/doc/x0vncserver.html) for X11 | Explicitly enroll a physical-screen-sharing connection and verify locally. |
| Windows physical desktop | Configured VNC server, such as [TightVNC](https://www.tightvnc.com/docs.php) | Validate supported OS, unattended service operation, login screen, clipboard, and UAC behavior on the actual machine. |

Pin reviewed component versions and container image digests in the implementation lockfiles. Record licenses and notices before redistributing any component. Do not write a new RDP, VNC, SSH, or terminal-emulation protocol implementation.

## 2. Machine identity and connection contracts

Create one `machine_id` per enrolled OS installation, with a human label, tags, OS/version/edition, architecture, timezone, optional physical-device grouping, and a durable agent identity. Machine identity must not depend solely on a changing IP address. A WSL environment and its Windows host have distinct execution/filesystem identities even when grouped under one physical computer.

Store separate connections for:

- Monitoring/host runner: agent certificate identity, supported protocol version, last heartbeat, boot ID, and capability inventory.
- SSH: address, port, username, credential reference, host-key fingerprints, negotiated shell, and verified SFTP capability.
- Desktop: address, port, protocol, account reference, server type, display/session mode, certificate trust, and tested features.
- Container engine: adapter, engine identity, approved namespaces/containers, ownership labels, and allowed operations.
- Service health checks: service ID or fixed HTTP/TCP endpoint, check type, timeout, interval, expected result, and allowed control actions.

Each capability stores `configuration_state`, `health_state`, `last_test_at`, `last_success_at`, `observed_at`, and a safe failure reason. Use separate concepts: unconfigured, unsupported, permission denied, unreachable, degraded, healthy, and stale. A machine-level summary can aggregate these, but must preserve the underlying details.

Keep `supported`, `configured`, `permitted`, and `healthy` separate. For example, Docker might be installed but denied to this profile; desktop sharing might be supported but not configured; monitoring might be healthy while SSH credentials fail.

### Network topology requirement

The agent opens an outbound authenticated TLS connection to the control plane. That does **not** create an implicit tunnel for SSH, RDP, or VNC. In v1, require reachable LAN/VPN routes from the SSH backend to each SSH endpoint and from the guacd container to each desktop endpoint. Test DNS and connectivity from those exact containers. If an outbound-only host cannot meet this requirement, report desktop/SSH unavailable and continue monitoring/jobs through the agent. Reverse-tunnel relays are an explicit later feature.

## 3. Build the onboarding wizard in this order

### Step 1 — Define the computer and desired capabilities

1. Collect a display name, expected OS, address/VPN hostname, grouping tags, and desired monitoring, SSH, desktop, and workspace execution features.
2. Show a generated setup checklist tailored to Windows or Linux; make each step individually retryable.
3. Do not silently install desktop services, alter a user's default shell, add privileged groups, or disable host firewall rules.
4. Create the machine in `pending_setup`; record every test with timestamps and diagnostic evidence.

### Step 2 — Enroll the host agent

1. Generate a short-lived, single-use enrollment token bound to the pending machine record.
2. Provide a reviewed installer/package and version/hash. Keep the bootstrap token out of ordinary command-history/log output where the installer supports protected input.
3. Install the Go agent as a systemd service on the supported Linux baseline or a Windows service on the supported Windows baseline.
4. Exchange the token for a machine identity and mTLS credentials. Restrict local key files with OS permissions. Re-enrollment is a visible operation; do not silently trust a new installation using the same label.
5. Return OS/edition/build, hostname, uptime/boot ID, CPU/RAM inventory, disk mounts, network interfaces, GPU inventory, runner availability, container-engine availability, and agent version.
6. Rotate agent certificates before expiration and support revocation. Record minimum compatible protocol versions; incompatible agents stay visible with a clear upgrade requirement.

Use an unprivileged agent where practical. When privileged control is necessary, split it into a narrow local helper with explicit verbs and target IDs. General project commands must run under the configured execution account/container identity, not the privileged helper identity.

### Step 3 — Test monitoring independently

1. Receive at least three fresh samples and verify increasing sequence numbers and plausible timestamps.
2. Compare CPU, memory, disk, network, and GPU values with a host-local reference tool under both idle and simple load conditions.
3. Test missing metrics deliberately, such as absent GPU hardware or unavailable temperature sensors. Show `Unavailable — reason`, never a fabricated zero.
4. Temporarily pause telemetry and verify stale indicators and chart gaps.
5. Record monitoring as healthy even if SSH or desktop is not configured.

### Step 4 — Configure and test SSH independently

On Linux, install/enable the distribution's OpenSSH server and enroll a dedicated non-root account where feasible. On Windows, use the supported [OpenSSH installation workflow](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse). Validate service startup and restricted firewall reachability.

1. Collect connection fields and credential references; prefer key authentication. Keep private keys in the backend secret store.
2. Retrieve the host-key fingerprint and require comparison against a trusted host-side fingerprint during onboarding. Store trusted fingerprints; fail closed on unexpected key changes and offer an explicit re-verification workflow.
3. Test authentication and a harmless identity command. Verify reported username, hostname, working directory, and shell against the selected machine.
4. Test an interactive PTY, terminal resizing, Unicode, Ctrl+C, and a nonzero exit status through the browser.
5. Test SFTP separately using a temporary file inside an enrolled test directory; upload, download, compare hash, and remove only that test file.
6. Test denial outside the permitted file root and failure reporting when credentials expire or the host key changes.

Windows-specific handling: OpenSSH initially uses `cmd.exe` unless its default shell is configured otherwise. Detect the shell and show it explicitly; PowerShell scripts must not be generated using Bash quoting. Key file locations/ACLs differ for normal users and administrator accounts. Local and Active Directory account key authentication differ from unsupported Entra ID key authentication. Use Microsoft's [shell configuration](https://learn.microsoft.com/en-us/windows-server/administration/OpenSSH/openssh-server-configuration) and [key management](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement) instructions.

### Step 5 — Configure and test desktop independently

1. Ask whether the connection should share the physical screen or provide a remote desktop session.
2. Select a compatible desktop server, account, port, and certificate policy; configure it on the host if authorized.
3. Probe from guacd's network context, then perform an authenticated connection. A reachable port alone does not pass the desktop test.
4. Display the desktop in the browser and verify keyboard, mouse, resizing, disconnect/reconnect, and optional clipboard policies.
5. Have the operator observe the host display to confirm the enrolled session mode. Save the observed outcome, including whether the local screen locks and whether reconnect resumes the same session.
6. Save the connection as verified only after an actual display/control test. Otherwise save it as configured but unverified with the remaining step.

### Step 6 — Enroll permissions and verify durable execution

1. Select existing workspace roots, execution accounts, supported service targets, and container targets.
2. Test creation and cleanup in a dedicated project test directory. Resolve paths on the host using OS-native rules, not string-prefix checks.
3. Test a short supervised background command with a stable job ID, stdout/stderr, exit code, cancellation, and reconnect.
4. Verify the actual launched UID/account token can write only to the granted project and explicitly enrolled scratch/home/cache locations, can read necessary runtimes, and cannot access unrelated protected data or denied administrative operations. Configure Linux UID/GID or a Windows account-token/restricted-service launch path; a Job Object or stored identity ID alone does not select the account. Test network-policy enforcement separately and mark unsupported restrictive policies unavailable.
5. Present a final capability matrix. The onboarding workflow may finish with documented unavailable features; it must not mark them healthy.

## 4. Desktop behavior and platform limitations

| Host/server mode | What the user controls | Prerequisites and UI treatment |
|---|---|---|
| Windows native RDP | A Windows remote session; session reconnect/local lock behavior depends on edition, account, and policy | Supported host editions include Professional, Enterprise, Education, and Windows Server. Windows Home cannot act as the built-in RDP host. Label `Remote session`, record observed local-screen behavior, and keep NLA enabled where supported. |
| Windows VNC service | Configured physical-console desktop sharing | Label `Physical screen`. Test service/login/UAC behavior on the actual server version; do not assume an application launched in a user session remains available after logout. |
| Linux xrdp + xorgxrdp | Graphical remote Xorg session | Label `Remote session`. Verify the installed desktop environment and session persistence. This does not automatically mirror a Wayland console. |
| GNOME Desktop Sharing | Existing logged-in desktop | Label `Physical screen`. Detect the actual GNOME/server version and verify behavior when locked or logged out. |
| GNOME Remote Login | Remote account login/session | Label `Remote session`. Treat it as a separate connection from Desktop Sharing; ports can differ when both are enabled. |
| TigerVNC x0vncserver | Existing X display, commonly the physical screen | Label `Physical screen (X11)`; do not advertise native Wayland capture. |
| Xvnc/virtual VNC desktop | Separate virtual display | Label `Remote session`; `VNC` alone does not establish physical-screen sharing. |
| Headless Linux without a desktop server | No graphical desktop | Disable the desktop button with a setup explanation; monitoring, SSH, files, and jobs can still work. |

Sources for the platform distinctions: [Microsoft supported RDP host editions](https://learn.microsoft.com/en-us/windows-server/remote/remote-desktop-services/remotepc/remote-desktop-allow-access), [xrdp](https://github.com/neutrinolabs/xrdp), [GNOME sharing](https://help.gnome.org/gnome-help/sharing-desktop.html), [GNOME login](https://help.gnome.org/gnome-help/remote-login.html), [TigerVNC existing-display behavior](https://tigervnc.org/doc/x0vncserver.html), and [TightVNC setup modes](https://www.tightvnc.com/doc/win/TightVNC_for_Windows-Installation_and_Getting_Started.pdf).

Do not promise console-sharing from the RDP protocol name, simultaneous Windows desktop users, GPU acceleration in every remote session, or universal Wayland support. Verify deployment-specific behavior. Windows Server multi-user deployments have their own licensing and policy requirements; adding them is not part of a single-user desktop promise.

## 5. Guacamole integration and authentication gate

Implement a bounded integration proof before building the full desktop UI:

1. Deploy the Guacamole web application and guacd on internal container networks. Do not publish guacd directly to browsers or the public internet.
2. Backend authenticates the dashboard user, verifies machine/desktop permission, selects a server-side connection record, and creates a desktop session record.
3. Generate Guacamole JSON containing only that session's permitted connection and an expiry. Use the documented JSON extension and its reference implementation to verify the cryptographic encoding. Submit the encrypted data using the documented POST path, avoiding query-string credential material. The shared signing/encryption secret stays server-side. [Guacamole JSON documentation](https://guacamole.apache.org/doc/gug/json-auth.html)
4. Place the desktop application behind an authenticated gateway that binds launch and tunnel access to the dashboard session. A short-lived app launch ticket is single-use because the app tracks its consumption; Guacamole JSON expiration alone is not single-use enforcement.
5. Never expose raw RDP/VNC passwords, private keys, connection definitions, or backend signing secrets in frontend configuration. If the stock web application requires a transient Guacamole session token, treat it as a scoped bearer token with explicit expiry and no ordinary logging.
6. Define gateway behavior for WebSocket and HTTP tunnel fallback, active connection registry, idle timeout, and logout/revocation. Closing an existing tunnel must not depend on whether a new-authentication token has expired.
7. Verify that an unauthorized user cannot open a second connection by changing a URL, reusing a launch ticket, choosing an arbitrary hostname, or calling the Guacamole path directly.
8. Record connect/disconnect/denial events and the machine/account/session mode. Full video recording is optional and should have explicit retention/storage policy.

Prefer an embedded desktop panel after the stock application is proven to work through the gateway. A dedicated authenticated tab is acceptable for v1 if framing/CSP or stock-client integration would otherwise force brittle changes. Preserve the visible machine/session label in either mode. Do not make undocumented Guacamole administration endpoints a product dependency. If session enforcement cannot be achieved cleanly through the gateway, implement a small extension using [Guacamole's documented extension API](https://guacamole.apache.org/doc/gug/custom-auth.html) and treat its authorization/revocation tests as a release gate.

## 6. Monitoring schema, cards, and history

### Metrics to collect

| Group | Required fields where available | Meaning and handling |
|---|---|---|
| CPU | Total utilization, logical core count; per-core samples in detail view | Derive utilization from interval deltas; record collection interval and collector source. |
| Memory | Physical total, available, used, optional swap/pagefile | Document the platform-specific definition; avoid presenting incompatible Linux/Windows cached-memory accounting as identical. |
| Disk | Per mount/volume capacity, used/free bytes; read/write rates and IOPS where supported | Track mount identity and disappearance; do not combine unrelated volumes into a misleading percentage. |
| Network | Per-interface received/sent totals and bytes/s, address/link state where available | Derive rates from counters and elapsed time; handle reset/wrap/reboot without negative spikes. |
| GPU | Stable ID, vendor/model, utilization, VRAM used/total, temperature, power, optional clocks/processes | Keep each GPU separate and attach availability/reason to each metric. |
| Services | Process/service/container status plus configured HTTP/TCP checks | Distinguish `process running` from `application healthy`; show most recent check time and diagnostic reason. |
| Agent | Version, heartbeat, boot ID, collector errors, queue/spool usage | Provide operational diagnostics without disguising stale samples as current values. |

NVIDIA tools expose device-dependent metrics and may report unsupported fields as unavailable; Windows WDDM also limits some per-process memory reporting. Prefer NVML's more stable interface for maintained integrations. The application must preserve missing values and the reason rather than substitute zero. [NVIDIA management documentation](https://docs.nvidia.com/deploy/nvidia-smi/index.html)

For v1, validate NVIDIA GPUs actually present in the homelab. Keep AMD/Intel adapters behind capability discovery until tested on corresponding hardware. Detect unsupported vendor telemetry and show that limitation while retaining CPU/memory/disk/network monitoring.

### Proposed collection and retention defaults

- Sample every 10 seconds; send compact batches without blocking job traffic.
- Mark a metric stale after 30 seconds without a fresh sample; mark agent connection unreachable after 120 seconds. These describe observation health, not proof that power is off.
- Keep raw 10-second samples for 7 days, 5-minute aggregates for 90 days, and hourly aggregates for 1 year, all configurable.
- Aggregate averages and maxima, preserving sample counts and missing intervals. Keep original and received timestamps; display time in the user's configured timezone and retain UTC internally.
- Partition telemetry by time, index machine/time, and run bounded retention jobs. Avoid one database row for every scalar if row growth would dominate; benchmark a per-host-sample plus per-GPU structure with realistic host counts.
- Buffer a bounded telemetry backlog locally. It is acceptable to drop oldest telemetry under pressure if a gap is recorded; do not apply that policy silently to job results or audit records.

### Machine card and detail view

A card shows label, OS, online/last-seen information, CPU/RAM, most relevant disk utilization, network rate, one compact row per GPU, selected service indicators, and direct SSH/desktop/jobs buttons. Show absolute last-update time and relative age. Missing capabilities need explanatory disabled controls.

Clicking opens Overview, Metrics, Terminal, Desktop, Files, Services/Containers, Jobs, and Configuration. Historical charts support 1 hour, 24 hours, 7 days, and a bounded custom range. Show gaps; do not extend the last sample as a live reading. A visible banner identifies a disconnected or stale host even if historical metrics remain available.

## 7. Terminals, files, and background commands

### Human interactive SSH terminal

Create an authenticated backend-owned SSH session with a stable terminal-session ID. Bind access to the user and machine; validate WebSocket origin/session and apply output backpressure. Maintain a bounded replay buffer and a configurable disconnect grace period, proposed at 10 minutes. A refresh may reattach during that window; an API-process restart can terminate this session. Display that guarantee clearly.

Interactive terminal input is an arbitrary shell capability for the authorized human account. Do not pretend the shell is folder-confined because the UI starts in a folder. Agent tools must use the separately restricted runner, execution identity, and workspace controls. A raw human shell transcript also cannot provide reliable command-boundary auditing for every interactive program; record the session and optional transcript with its stated limitations.

Provide a separate **Run as background job** action that submits to the durable runner before executing anything. A command already typed into an ordinary shell cannot be retroactively made durable just by labeling it a job. Agent commands always use the durable job path.

### Workspace terminal

Attach the workspace terminal to the selected environment through its runner. Linux uses a PTY; Windows needs a tested [ConPTY integration](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session). Show execution account, environment/container identity, working directory, and actual file-storage location. Acquire the workspace writer reservation before launch and retain it through detached grace periods until the process and writable descendants have verifiably exited. Closing its socket alone does not release the reservation. Raw administrative SSH, remote-desktop applications, and local programs are external writers whose changes must be detected; they cannot be forced to obey the application lock. Treat Windows GUI programs and UAC prompts as unsupported background console interactions unless an explicit adapter supports them.

### Machine file browser

Use the enrolled host file adapter for strictly confined file operations. SFTP is available only with a separately tested server-side jail/restricted-account boundary, or as clearly labeled broader human-account management; remote string-prefix or check-then-open path validation alone cannot enforce race-resistant confinement. Implement paginated listing, upload/download progress, rename, directories, safe deletion, and permission/error reporting. Normalize Linux/Windows paths on the host; account for drive letters, case behavior, junctions, symlinks, UNC shares, and files locked by other programs. Reject SMB/UNC roots in the v1 baseline unless a separately implemented and tested adapter supports them. Project editing, ZIP export, previews, and checkpoints follow the project-workspace specification; machine files must not silently become project files.

## 8. Service controls, containers, and saved actions

### Supported first-version controls

| Target | Operations | Scope enforcement |
|---|---|---|
| Linux systemd unit | Status, bounded logs, start/stop/restart | Admin-enrolled unit IDs and verbs through a narrow local helper; no arbitrary unit-file editing. |
| Windows Service Control Manager service | Status, start/stop/restart; configured event-log view | Enrolled service names and delegated privileges; do not run all agent commands as LocalSystem. |
| Approved Docker container on Linux | List/status/logs/start/stop/restart | Server-side container identity/ownership labels and explicit allowed verbs; all actions recorded as jobs. |
| Dashboard-managed project container | Create/start/stop/restart/rebuild | Controlled image/mount/network/resource configuration; persistent project storage remains external to disposable container layers. |
| HTTP/TCP application check | Health/readiness status | Fixed enrolled endpoints and bounded timeouts; no user-supplied arbitrary network fetch per check. |

Docker daemon access can convey extensive host control. Keep the engine socket available only to a trusted broker/host helper, never to arbitrary project containers or browser clients. Do not claim that a socket proxy allowing container creation can enforce safety without also validating mounts, privilege flags, namespace settings, and allowed images. [Docker Engine security](https://docs.docker.com/engine/security/)

Windows native services are supported in v1. Linux containers run on the selected Linux host; using WSL2/Docker Desktop requires an explicitly enrolled and tested Linux execution environment, including its startup and storage behavior. Native Windows container lifecycle management can be a later adapter.

### Parameterized saved actions

Store action ID/version, display name, description, allowed machines/profiles, OS-specific executable/script, typed parameter schema, working-directory policy, environment-variable allowlist, timeout, concurrency limit, required privileges, and optional verification command. Prefer structured argument arrays; never substitute raw user text into a shell template.

Examples: restart one selected enrolled service, run a project's test command, inspect a configured log, rebuild a managed project environment, or perform a provider health check. The UI displays resolved target and parameters before submission. Permission evaluation and parameter validation occur again in the backend and host helper. Routine in-scope actions use retained authorization; changing target/scope or invoking an explicitly destructive action follows the configured approval policy.

Every saved-action execution is a job with stable ID, elapsed time, logs, outcome, affected target, and verification result. A stop/restart request that loses host contact becomes `waiting` with reason `host_unreachable` while its outcome is reconciled. It becomes `interrupted` only if reliable continuation/outcome cannot be established; it must not be silently retried against another target.

## 9. Implementation sequence and real-machine acceptance

1. **Inventory and identity:** implement machine/connection/capability records and pending onboarding UI; save tests independently.
2. **Agent enrollment:** implement certificate enrollment, heartbeat, inventory, version negotiation, and revocation on one Windows and one Linux machine.
3. **Metrics:** validate normalized samples, missing-field behavior, retention, stale states, and card/detail views using those machines.
4. **SSH/files:** integrate xterm.js, SSH host verification, PTY resize, shell detection, SFTP test, and permitted-root file operations.
5. **Desktop proof:** deploy Guacamole, test JSON auth/gateway binding, then verify one Windows and one Linux desktop connection with recorded session semantics.
6. **Runner:** add the durable-command integration and host execution-identity checks; never advertise a durable job based solely on an SSH stream.
7. **Controls/actions:** implement narrow adapters, schema validation, job submission, audit records, and post-action health verification.
8. **Failure tests:** revoke credentials, change a test SSH key, pause telemetry, interrupt network access, reconnect, and prove individual capabilities recover without fabricated health.

Release evidence must identify actual enrolled machine IDs, OS/build/edition, agent version, tested connection mode, and result timestamps. Minimum checks:

- On one Windows and one Linux machine, compare live metrics against host-local references; verify history after reloading the dashboard.
- Disable SSH while monitoring remains running: tile must preserve monitoring health and show SSH failure. Repeat with desktop unavailable.
- On each supported SSH machine, complete browser shell, resize, Ctrl+C, Unicode filename, SFTP hash round trip, host-key mismatch rejection, and permitted-root denial tests.
- On an RDP-capable Windows host, observe/control the desktop and record local-screen/session behavior. If the available Windows host is Home, validate the selected physical-sharing VNC path and record native RDP as unsupported.
- On Linux, verify the selected remote session or physical-sharing path. If the product advertises both modes, each must have a real corresponding test.
- On a real GPU host, show each GPU separately; show an unavailable field accurately and confirm a stale GPU series does not read as zero utilization.
- Run and cancel a saved service/container action against a designated test target; verify scope denial against a non-enrolled target and check the audited postcondition.
- Close the browser during a supervised command, reopen it, and attach to the existing job ID without a second execution. This is a separate required gate from ordinary terminal reconnect.
- Keep synthetic fixtures under an explicit demo/test mode with an unmistakable banner and isolated database/namespace. Live mode must show empty/unavailable states until real telemetry or tests exist.

## 10. Sources and implementation verification notes

All component/platform claims above reference primary project or vendor documentation. Product-specific schemas, intervals, workflows, and UI behaviors are proposed requirements. Recheck versions and adapter behavior when implementing.

- [Guacamole architecture](https://guacamole.apache.org/doc/gug/guacamole-architecture.html)
- [Guacamole encrypted JSON authentication](https://guacamole.apache.org/doc/gug/json-auth.html)
- [Guacamole custom authentication extension API](https://guacamole.apache.org/doc/gug/custom-auth.html)
- [Guacamole connection settings](https://guacamole.apache.org/doc/gug/configuring-guacamole.html)
- [xterm.js](https://github.com/xtermjs/xterm.js)
- [ssh2](https://github.com/mscdex/ssh2)
- [gopsutil](https://github.com/shirou/gopsutil)
- [Windows OpenSSH setup](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse)
- [Windows OpenSSH configuration](https://learn.microsoft.com/en-us/windows-server/administration/OpenSSH/openssh-server-configuration)
- [Windows OpenSSH keys and ACLs](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement)
- [Windows RDP host prerequisites](https://learn.microsoft.com/en-us/windows-server/remote/remote-desktop-services/remotepc/remote-desktop-allow-access)
- [Windows ConPTY](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session)
- [xrdp](https://github.com/neutrinolabs/xrdp)
- [GNOME Desktop Sharing](https://help.gnome.org/gnome-help/sharing-desktop.html)
- [GNOME Remote Login](https://help.gnome.org/gnome-help/remote-login.html)
- [TigerVNC existing-display sharing](https://tigervnc.org/doc/x0vncserver.html)
- [TightVNC Windows setup](https://www.tightvnc.com/doc/win/TightVNC_for_Windows-Installation_and_Getting_Started.pdf)
- [NVIDIA monitoring and field availability](https://docs.nvidia.com/deploy/nvidia-smi/index.html)
- [Docker daemon security](https://docs.docker.com/engine/security/)
