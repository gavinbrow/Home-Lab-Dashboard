# 01 — Product scope and user experience

## 1. Product boundaries

The dashboard is a private control center for the owner's existing homelab. It coordinates model requests, remote access, project files, and background execution. It does not replace the operating systems, model-serving software, SSH servers, or desktop servers. Those remain explicit integrations with independent health and capability information.

First-version assumptions: one owner; several trusted Windows/Linux computers; a routable LAN or VPN; at least one local inference provider; one Linux computer capable of hosting Docker containers. Native Windows folders are first-class projects. Native Windows containers, shared multiuser administration, and automatic migration of work between computers are later work.

## 2. Requirement registry and release grouping

Every first-version requirement below is part of release acceptance. An increment in the implementation roadmap is a development milestone, not permission to omit remaining first-version requirements.

| ID | Working first version | Later enhancement |
|---|---|---|
| R01 | Login, secure sessions, backend authorization, secrets storage, private HTTPS deployment | OIDC/SSO, richer roles, optional passkeys |
| R02 | Four separate model/profile/execution-computer/workspace selections; resolved run context visible | Saved context presets with explicit overrides |
| R03 | Reusable, versioned agent profiles with instructions, tools, models, permitted targets/folders, execution limits | Shared profile library and delegated specialist teams |
| R04 | Existing-folder and dedicated-container projects with persistent data and editable project instructions | Environment templates, cross-host workspace migration |
| R05 | File browser, uploads/downloads, complete scoped project ZIP, common previews, editor, terminal | Collaborative editing and richer office-format previews |
| R06 | Backend agent/job queue, live and retained logs, cancellation, durations, history, required states | Schedules, dependencies, richer workflow builder |
| R07 | Reattach without duplicate commands; recovery for browser, host, worker, and API/backend failure | Control-plane high availability and advanced failover |
| R08 | Complete Windows/Linux onboarding with separate monitoring, SSH/SFTP, desktop, and runner tests | Bulk enrollment and automatic inventory discovery |
| R09 | Current/history CPU, RAM, disk, network, supported per-GPU metrics, selected services, timestamps, stale/unavailable indicators | More GPU vendors, Prometheus/Grafana integrations, long-term telemetry backend |
| R10 | Browser SSH terminal, scoped file management, supported service/container controls, saved parameterized actions | Expanded platform adapters, power-management integrations |
| R11 | Desktop profiles identify shared physical screen versus remote login/session; browser access through reusable gateway | Integrated console-agent alternative, advanced video workflows |
| R12 | Provider configuration, model discovery/favorites, capability tests, streaming chat, supported native management | Broader provider/plugin ecosystem |
| R13 | Available/loaded/busy states kept distinct; per-provider/model concurrency and measured performance where known | Resource-aware placement, reservations, prewarming policies |
| R14 | File changes, commands, affected systems, verification evidence, diffs, recoverable checkpoints | Cross-project provenance and richer comparison tools |
| R15 | Backend tool/workspace permission enforcement; durable scope grants; credentials excluded from frontend/logs | Multiuser delegations and external vault integration |
| R16 | Backup and tested restoration of settings, definitions, profiles, projects, histories, secrets, retained files | More backup destinations and automated recovery exercises |
| R17 | Real-machine acceptance and explicit separation of demo fixtures from live operations | Larger compatibility matrix and benchmark automation |

The actual capability of a machine/provider limits which controls it can expose. For example, an unsupported GPU metric may be unavailable without blocking release; omitting all GPU support on a configured, supported NVIDIA machine would fail R09. Missing credentials are **blocked tests**, not passing results.

## 3. Main navigation

Use a persistent sidebar: **Overview**, **Machines**, **Chat & Agents**, **Projects**, **Jobs**, **Models**, **Activity**, and **Settings**. A compact global strip shows control-plane health, connected-machine count, running/waiting jobs, and storage warnings. Keep detailed implementation terminology out of normal workflows.

### 3.1 Overview and machine tiles

Each tile includes name, OS, owner-selected tags, reachability summary, latest CPU/RAM/disk/network readings, GPU summaries, selected services, and the age of each relevant observation. Use capability badges: Monitoring, SSH, Desktop, Runner, Containers. A machine may have working SSH while its telemetry is stale, or working telemetry while RDP is unavailable.

Clicking a tile opens machine details; adjacent quick actions open **Terminal**, **Desktop**, **Files**, or **Actions**. Unavailable controls stay visible with a reason and a path to repair onboarding. Machine history has 1 hour, 24 hour, 7 day, and custom ranges. Gaps remain visible. Disk capacity and disk I/O are separate charts; network rates are not confused with cumulative bytes.

### 3.2 Machine details

Tabs: Overview, Metrics, Terminals, Desktop, Files, Services & Containers, Actions, Jobs, Connection Settings. Show the real hostname and stable machine ID in an expandable details panel, plus versions and most recent capability test results. Changing a connection address or credential makes the affected test stale until it is rerun.

Desktop buttons name their behavior: **Share physical screen** or **Open remote session**. If the installed endpoint cannot establish this classification, show **Session behavior unverified** and require the onboarding test before labeling it as shared. Show Windows locking behavior and Linux display-server constraints on the relevant connection's details.

### 3.3 Chat and agent workspace

Use a familiar chat layout: conversation list, streamed conversation, composer, searchable model selector, tool-result cards, and a resizable project/files pane. Use Open WebUI as an interaction reference, not an architectural dependency. Its official documentation provides a relevant example of provider-agnostic chat and tool/file presentation. [Open WebUI](https://docs.openwebui.com/)

Above every conversation, show four independent controls:

| Selection | Example placeholder | What it means |
|---|---|---|
| Model | `Ollama / configured-model:tag` | Provider/model generating responses |
| Agent profile | `Project developer · revision 3` | Instructions, tools, allowed targets, limits |
| Execution computer | `linux-runner-01 · project container` | Where tools and background processes execute |
| Project workspace | `analysis-tools · /workspace/project` | Selected project and file location |

Under the selectors, display a readable resolved context: **Responses: Model X on Provider Y · Commands: linux-runner-01/container Z · Files: linux-runner-01:/srv/homelab/projects/P/data → /workspace/project**. A Windows folder project instead shows its native path. The project details also disclose where retained output copies and backups reside.

Selecting a profile applies defaults only to unset fields, or offers a visible **Apply profile defaults** action. It must not silently overwrite a deliberate model choice. Selecting a workspace filters valid execution targets. An incompatible combination shows the exact conflict and blocks submission. A future migration/copy workflow may resolve it; silently executing against an empty folder cannot.

Changing selectors applies to the next run. Running jobs retain immutable resolved context, and historical messages show the model actually used. Switching a provider/model that cannot accept a conversation's image or tool messages triggers a clear compatibility decision. No automatic fallback to another model.

**Plain chat** has no execution target or workspace requirement and presents these fields as None. **Agent task** requires a valid target and workspace for file/command tools. A profile for read-only machine monitoring may operate against explicitly selected permitted machines without a project, but cannot acquire a shell by inference.

### 3.4 Projects

Project overview shows description, instructions, workspace type, storage computer/path, environment image/version, permitted profiles, active writer, retained outputs, checkpoint history, and latest backup coverage. File tools support text/Markdown/JSON, bounded CSV tables, common images, and PDFs. Unsupported formats offer download; do not promise native editing of Word/PowerPoint.

Editor saves use content-version checks. If an agent or external application modified the file, offer a diff/conflict resolution rather than overwriting it. Background tasks do not take over a user's editor silently. Project instructions are versioned configuration whose snapshot is recorded on each run.

Keep environment operations visually and semantically distinct:

| Action | Effect | Project data |
|---|---|---|
| Restart environment | Stop/start the same environment | Preserved |
| Rebuild environment | Replace container from pinned image/configuration and reconnect storage | Preserved |
| Archive project | Hide/disable new work; retain configuration and files | Preserved |
| Unregister existing folder | Remove dashboard registration/access; leave the original host folder alone | Preserved |
| Delete project files | Explicitly remove the selected project's stored bytes after configured protection/checkpoint | Deleted only by this action |

Do not place data deletion behind a generic reset button. Enrollment does not grant ownership of an existing folder; deleting or moving its bytes needs a separate grant identifying that host and root. Before a rebuild, show active jobs and require them to finish or be cancelled. Files installed outside persistent project paths may disappear during rebuild; display that distinction in environment details.

### 3.5 Jobs and activity

The Jobs view supports queued, running, waiting, cancelling, completed, failed, cancelled, and interrupted states. Every row has job ID, task, initiating user/profile, model, execution target, project, state reason, queued/start/end timestamps, queue wait, active elapsed time, and last heartbeat. Running duration freezes or displays uncertainty appropriately when status is unconfirmed.

Job detail includes streamed logs, ordered tool calls, command arguments with secrets removed, results/exit codes, affected systems/files, before/after diffs, checkpoints, artifacts, and explicit verification results. **Verification: not run** differs from a failed verification and from the agent's prose claim of success.

Refreshing a job view attaches to its existing ID. **Retry** creates a new linked attempt only after the former attempt is reconciled; it never happens because the page refreshed. **Cancel** requests cancellation and reports progress until the supervisor confirms termination. If the host is unavailable, show **Cancellation pending — host unreachable**.

Activity combines configuration edits, connection tests, desktop/terminal session metadata, agent mutations, permission decisions, and recovery events. Do not record human terminal passwords or all keystrokes by default.

## 4. Scope grants without repeated interruptions

A project/profile combination may allow reading, editing, testing, building, and running ordinary commands under a defined runtime identity and limits. Persist that authorization and reuse it for subsequent permitted steps. A model's instructions are not authorization.

Requests outside that scope return a structured denial or a concrete request showing target, operation, affected files/services, and reason. Any approval names its scope and duration. Adding a new machine, widening filesystem access, or deleting project data cannot be smuggled into a generic “continue” operation. A permission revocation applies to new dispatches immediately and initiates best-effort cancellation of affected running actions; the interface reports any work whose stop cannot yet be confirmed.

## 5. Later phases

**Phase 2 — convenience and automation:** scheduled jobs with timezone/DST/missed-run behavior, alerts with thresholds/hysteresis, email/webhook/other opt-in notifications, saved environment templates, and private web previews. A preview uses a separate origin and scoped access; project-generated HTML must not gain dashboard credentials.

**Phase 3 — resource scheduling:** measured CPU/RAM/GPU demand, model memory reservations, placement proposals, queue priorities, prewarming, and explicit policies for external workloads. Build on first-version concurrency controls; do not infer free capacity solely from a stale utilization sample.

**Phase 4 — collaboration and extensibility:** multiple cooperating agents with separate scopes and budgets; workspace branches or isolated copies; merge/review workflow; optional additional users and roles; approved MCP/plugin integrations. Multiple agents must not edit the same directory concurrently without an explicit coordination design.

## 6. Demo mode

Provide demo fixtures only in a separately launched development/demo deployment with its own database, storage, credentials namespace, and network configuration. It has a persistent **DEMO — no real machine connections** banner and deterministic seeded data. Normal production startup never enables it automatically, and production test reports cannot cite it as real-machine evidence.
