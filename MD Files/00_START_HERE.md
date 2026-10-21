# Homelab Control Dashboard — implementation plan

**Prepared:** October 20, 2026  
**Deliverable:** a detailed specification and implementation sequence for coding agents.  
**Status:** planning only. No homelab machine has been contacted, enrolled, modified, or tested while preparing these files.

## 1. What to build

Build a self-hosted website that lets its owner sign in, inspect Windows and Linux computers, open browser SSH terminals and remote desktops, manage permitted files/services/containers, and run local or remote AI models against persistent projects. Long-running work belongs to backend jobs and machine-side supervisors; browser tabs are clients of those jobs. The interface takes inspiration from Open WebUI's conversation and model-selection experience.

The four independent selections are **model**, **agent profile**, **execution computer**, and **project workspace**. Keep them separate in the data model, permission checks, interface, run history, and acceptance tests. The machine serving a model can differ from the machine executing its tools. Project storage can differ from the control-plane server. Make every location visible.

This is one integrated application with several reusable infrastructure components. Implement it in vertical slices and verify each on real configured machines. A polished mock dashboard is insufficient for the first release.

## 2. Read these files in order

| File | Purpose | Primary audience |
|---|---|---|
| [01_SCOPE_AND_USER_EXPERIENCE.md](01_SCOPE_AND_USER_EXPERIENCE.md) | First version versus later phases; screen behavior; requirements IDs | All implementers |
| [02_ARCHITECTURE_AND_DATA_CONTRACTS.md](02_ARCHITECTURE_AND_DATA_CONTRACTS.md) | Deployment, reusable components, boundaries, records, APIs, permissions | Architecture/backend/host-agent implementers |
| [03_MACHINES_AND_REMOTE_ACCESS.md](03_MACHINES_AND_REMOTE_ACCESS.md) | Windows/Linux onboarding, metrics, SSH, remote desktop, controls | Host-agent/remote-access implementers |
| [04_MODELS_AGENTS_AND_CHAT.md](04_MODELS_AGENTS_AND_CHAT.md) | Provider adapters, model states, chat, reusable profiles, tool orchestration | Model/backend/frontend implementers |
| [05_WORKSPACES_JOBS_AND_RECOVERY.md](05_WORKSPACES_JOBS_AND_RECOVERY.md) | Persistent files, execution lifecycle, job recovery, checkpoints, backups | Worker/storage implementers |
| [06_STEP_BY_STEP_IMPLEMENTATION.md](06_STEP_BY_STEP_IMPLEMENTATION.md) | Ordered milestones with tasks, dependencies, outputs, and gates | Lead coding agent |
| [07_ACCEPTANCE_TESTS_AND_OPERATIONS.md](07_ACCEPTANCE_TESTS_AND_OPERATIONS.md) | Real-machine acceptance suite, failure drills, release evidence, operating procedures | Integration/test/release implementers |
| [08_CODING_AGENT_HANDOFF.md](08_CODING_AGENT_HANDOFF.md) | Copyable task instructions, delegation boundaries, progress reporting | Lead coding agent and subagents |
| [09_SOURCES_AND_DECISION_LOG.md](09_SOURCES_AND_DECISION_LOG.md) | Official references, rationale, implementation-time version checks | All implementers |

The ZIP package contains the same Markdown files with working relative links. No files in this pack are executable installers or production configuration.

## 3. Recommended defaults

These are design decisions, not claims about the current homelab inventory. Change a default only after documenting the reason and preserving the requirement it serves.

| Area | First-version decision |
|---|---|
| Deployment | One always-on Linux control-plane computer or VM; Docker Compose; private LAN/VPN access and HTTPS |
| Frontend | React, TypeScript, Vite; xterm.js terminal; Monaco editor; standard accessible UI components |
| Backend | TypeScript/Fastify modular monolith plus a separate worker process |
| Durable state | PostgreSQL for settings, queue, jobs, events, audit metadata, chat, and initial telemetry history |
| Retained file bytes | Persistent control-plane artifact/checkpoint storage plus explicit project storage on the owning computer |
| Managed machines | Go service on Windows/Linux, with distinct connection/monitoring and execution-supervisor responsibilities |
| Interactive SSH | Backend SSH/SFTP adapter; browser never holds private keys |
| Remote desktop | Apache Guacamole web application and guacd; RDP/VNC endpoints configured per machine |
| Model adapters | Generic OpenAI-compatible Chat Completions, Ollama native, LM Studio compatible inference plus native management; vLLM through compatible adapter |
| Agent runtime | Dashboard-owned, persisted tool loop; no dependency on an external autonomous-agent framework |
| Workspace modes | Existing Windows/Linux folder, or dedicated Linux container with separately owned persistent project data |
| Concurrency | Configurable global/machine/provider limits; one modifying job per workspace initially |
| Scope | Single-owner deployment first, with backend ownership and resource permission checks from the beginning |

## 4. Non-negotiable implementation rules

1. Never infer an execution computer from the selected model, and never silently move files when a selection changes.
2. Never store the only copy of generated output in a container's writable layer.
3. Never tie an agent job's lifetime to an HTTP request, websocket, tab, or browser process.
4. Never automatically rerun a command merely because its acknowledgement was lost. Unknown outcomes require reconciliation.
5. Never call a native shell a folder sandbox just because its working directory is inside the project. Enforce restrictions through OS accounts/ACLs or a suitable isolated environment.
6. Never call unavailable telemetry zero, stale data current, an untested model capability supported, or an offline worker proof that the whole computer is powered off.
7. Never put provider keys, SSH private keys, passwords, or enrollment secrets in frontend configuration, ordinary logs, URLs, or model context.
8. Routine actions already permitted by a profile and project policy should run without repeated approval dialogs. Scope expansion and explicitly protected destructive actions use concrete, recorded authorization.
9. Demo fixtures use a separate deployment/database and conspicuous labeling. Live screens never fall back to random or sample values.
10. Do not mark the first version complete until the real-machine acceptance suite passes, including browser closure, backend recovery, and container replacement.

## 5. First execution of this plan

The lead coding agent should inspect the repository, identify existing stack constraints, and produce a tracked task list mapped to the requirement IDs. Then complete milestone M00 in the implementation sequence: record a real Linux host, a real Windows host, one actual provider/model, one existing-folder workspace, and one disposable container workspace. Missing credentials or machines can block particular integration tests without blocking local implementation.

No password, API key, private key, real IP address, or unverified hardware inventory is provided in this pack. Display names such as `linux-runner-01` and `windows-workstation-01` are placeholders. Configure actual values through the application's onboarding/settings flow or documented secret injection.

## 6. Definition of a working first version

The owner can sign in, onboard both operating systems, see live and historical measurements, distinguish capability failures, open SSH and an appropriate desktop connection, inspect/edit project files, choose a model/profile/computer/workspace, and run an agent that changes files and verifies its work. That agent can keep working while the browser is closed. Logs and events replay without re-executing tools. Outputs can still be downloaded after replacing the execution container. Jobs, credentials, policies, histories, and retained data can be restored from a tested backup.

Later phases improve automation and scale; they do not postpone these foundations.
