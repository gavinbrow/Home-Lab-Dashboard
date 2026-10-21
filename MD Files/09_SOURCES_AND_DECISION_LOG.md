# 09 — Sources, decisions, and implementation-time checks

**Research date:** October 20, 2026. These are primary project/vendor/standard references. Their documented capabilities inform the proposed integrations; they do not prove that a particular homelab installation has those capabilities enabled. Recheck the documentation for the exact versions chosen during implementation.

Product-specific architecture, schemas, limits, retention, milestones, and acceptance criteria are recommendations created for this project. Numerical defaults are configurable design choices rather than benchmark claims.

## 1. Remote access and machine management

| Reference | Use in this plan |
|---|---|
| [Apache Guacamole architecture](https://guacamole.apache.org/doc/gug/guacamole-architecture.html) | Reuse browser gateway and daemon, keeping their roles separate |
| [Guacamole encrypted JSON authentication](https://guacamole.apache.org/doc/gug/json-auth.html) | Documented external authentication; application additionally owns session scope/revocation |
| [Guacamole custom authentication extensions](https://guacamole.apache.org/doc/gug/custom-auth.html) | Supported extension path if a gateway alone cannot meet session requirements |
| [Guacamole connection configuration](https://guacamole.apache.org/doc/gug/configuring-guacamole.html) | Verify protocol/server settings against installed version |
| [xterm.js security](https://xtermjs.org/docs/guides/security/) | Terminal privilege and browser-origin implications |
| [ssh2](https://github.com/mscdex/ssh2) | Reusable Node SSH and SFTP transport |
| [Microsoft OpenSSH setup](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse) | Windows host prerequisites and service setup |
| [Microsoft OpenSSH configuration](https://learn.microsoft.com/en-us/windows-server/administration/OpenSSH/openssh-server-configuration) | Default shell and server settings |
| [Microsoft OpenSSH key management](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement) | Account-specific key handling and permissions |
| [Microsoft RDP host editions](https://learn.microsoft.com/en-us/windows-server/remote/remote-desktop-services/remotepc/remote-desktop-allow-access) | Windows Home versus supported built-in RDP host editions |
| [xrdp](https://github.com/neutrinolabs/xrdp) | Linux graphical remote-session implementation |
| [GNOME Desktop Sharing](https://help.gnome.org/gnome-help/sharing-desktop.html) and [Remote Login](https://help.gnome.org/gnome-help/remote-login.html) | Physical-desktop sharing versus remote login as separate configured modes |
| [TigerVNC x0vncserver](https://tigervnc.org/doc/x0vncserver.html) | Sharing an existing X display; not a universal Wayland solution |
| [TightVNC Windows installation](https://www.tightvnc.com/doc/win/TightVNC_for_Windows-Installation_and_Getting_Started.pdf) | Candidate Windows console-sharing server, tested per installation |
| [gopsutil](https://github.com/shirou/gopsutil) | Cross-platform host telemetry library candidate |
| [NVIDIA SMI](https://docs.nvidia.com/deploy/nvidia-smi/index.html) and [NVML](https://docs.nvidia.com/deploy/nvml-api/index.html) | Per-device metrics and hardware/driver-dependent availability |

## 2. Model connections and interface reference

| Reference | Use in this plan |
|---|---|
| [Open WebUI documentation](https://docs.openwebui.com/) | Conversation/model-selector/file-tool interaction reference |
| [Ollama chat](https://docs.ollama.com/api/chat) | Native streaming inference and tool interactions |
| [Ollama catalog](https://docs.ollama.com/api/tags) and [running models](https://docs.ollama.com/api/ps) | Distinguish discoverable models from memory residency |
| [Ollama usage](https://docs.ollama.com/api/usage) | Token/timing measurements, cache semantics, nanosecond conversion |
| [Ollama FAQ](https://docs.ollama.com/faq) | Installed-server behavior and concurrency settings |
| [LM Studio API comparison](https://lmstudio.ai/docs/developer/rest) | Compatible chat/custom tools versus native management |
| [LM Studio model listing](https://lmstudio.ai/docs/developer/rest/list) and [load API](https://lmstudio.ai/docs/developer/rest/load) | Loaded instances and optional management configuration |
| [LM Studio tool use](https://lmstudio.ai/docs/developer/openai-compat/tools) | Compatible endpoint integration for dashboard-owned tool loop |
| [vLLM online serving](https://docs.vllm.ai/en/stable/serving/online_serving/) | OpenAI-compatible inference adapter |
| [vLLM server options](https://docs.vllm.ai/en/stable/cli/serve/) | Tool parser/template-dependent behavior |
| [vLLM metrics](https://docs.vllm.ai/en/stable/usage/metrics/) | Optional server observations, distinct from per-request timing |

Do not copy provider APIs across implementations merely because both advertise compatibility. Test endpoint behavior, model identity, custom tools, cancellation, management functions, and metric semantics on the actual deployment.

## 3. Persistence, execution, and recovery

| Reference | Use in this plan |
|---|---|
| [Docker volumes](https://docs.docker.com/engine/storage/volumes/) and [bind mounts](https://docs.docker.com/engine/storage/bind-mounts/) | Project bytes live outside replaceable runtime layers and belong to the daemon's host |
| [Docker security](https://docs.docker.com/engine/security/) and [rootless mode](https://docs.docker.com/engine/security/rootless/) | Broker boundary, mounts, privileges, and supported isolation choices |
| [PostgreSQL SELECT](https://www.postgresql.org/docs/current/sql-select.html) | Queue-claim locking with SKIP LOCKED |
| [PostgreSQL NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html) | Wake-up hints separate from durable queue/event records |
| [SQLite WAL](https://www.sqlite.org/wal.html) | Host launch-journal durability settings |
| [WHATWG server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html) | Reconnection and event cursors; application still supplies persistence |
| [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) | Managed process groups, limits, and cancellation |
| [Windows account-token process launch](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw) | Actual execution identity requires a supported launch path |
| [Windows ConPTY](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session) | Workspace-terminal integration |
| [systemd process termination](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html) and [resource controls](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html) | Native Linux process containment and limits |
| [Go traversal-resistant file APIs](https://go.dev/blog/osroot) | Rooted file operations and path/symlink race considerations |
| [PostgreSQL backup](https://www.postgresql.org/docs/current/backup.html) and [pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html) | Consistent metadata backup and restoration |
| [SQLite backup API](https://www.sqlite.org/backup.html) | Consistent capture of live host journals |
| [restic introduction](https://restic.readthedocs.io/en/stable/010_introduction.html) | Candidate backup/restore and integrity-check tooling |
| [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) | Authentication/session controls |
| [Monaco editor](https://github.com/microsoft/monaco-editor) | Reusable browser code/text editor |

## 4. Architecture decision log

| ID | Decision | Reason | Revisit when |
|---|---|---|---|
| ADR-001 | Linux Compose control plane; React/Fastify/Go | Concrete deployment with a cross-platform host service and clear process ownership | Existing repository imposes a justified different stack |
| ADR-002 | Four independent selections | Prevent hidden model/host/workspace coupling and misdirected commands | Never remove; presets may bundle visible defaults |
| ADR-003 | PostgreSQL queue/events plus host ledger | Durable browser-independent work and recovery from lost acknowledgements | Measured scaling need justifies another broker, preserving semantics |
| ADR-004 | No exactly-once promise for arbitrary shell side effects | OS launch and remote effects cannot be atomically committed with central DB | Operation-specific idempotent APIs offer stronger guarantees |
| ADR-005 | Explicit storage ownership outside containers | Files survive runtime replacement and can be backed up independently | Add storage adapters without weakening lifetime separation |
| ADR-006 | Native Windows folders and Linux containers in v1 | Meets both OS workflows without assuming uniform container semantics | Native Windows-container demand justifies its compatibility matrix |
| ADR-007 | Guacamole/SSH components reused | Proven protocol components reduce custom remote-access implementation | Measured console/video requirement justifies another adapter |
| ADR-008 | Dashboard-owned provider/tool loop | One authorization, job, audit, and recovery contract across providers | External agent adapter can meet the same contract |
| ADR-009 | One workspace writer at a time | Makes checkpoints, edits, and recovery tractable initially | Branch/merge or collaboration design supports concurrent changes |
| ADR-010 | Monitoring history initially in PostgreSQL | Avoid additional infrastructure before measuring data volume | Retention/scale requires a dedicated time-series store |
| ADR-011 | Private LAN/VPN and single owner initially | Clear deployment and account scope for the first usable release | Public/multiuser operation receives its own tested architecture |
| ADR-012 | Independent retained artifact copies | Downloadable outputs remain available while execution hosts are offline | Retention/storage budgets require explicit policy changes |
| ADR-013 | Existing-folder unregister preserves files | Registration does not transfer ownership of pre-existing user data | File deletion receives a separate exact-root grant |
| ADR-014 | Container cancellation can stop dedicated environment | Prove descendant termination when command-group cleanup is uncertain | Per-job containers or stronger runtime containment narrows impact |

## 5. Decisions to confirm from the actual installation

Complete these during M00/onboarding rather than blocking preparation of the plan:

1. Which always-on Linux computer/VM hosts the control plane and backups?
2. Which Windows edition and Linux desktop/session technologies are actually installed?
3. Which execution accounts and folder roots should profiles receive?
4. Which provider endpoints/models already exist, and which support reliable tools or images?
5. Which machine owns each project, and what storage/quota/backup destination applies?
6. Which specific services/containers/actions should appear on tiles?
7. Which GPU metrics are exposed by the installed hardware/driver combinations?
8. Which restrictive filesystem/network policies can the selected runtime actually enforce?

Do not guess these details from sample names or previously discussed hardware. Capture current values through the onboarding process, then record tested versions and results in the compatibility matrix.

