# 08 — Handoff to the implementation model

## 1. Copyable starting instruction

Use the following when you are ready for a coding model to implement the project. Give it the complete folder so it can follow the linked specifications.

~~~text
Implement the self-hosted Homelab Control Dashboard described in this Markdown pack. First read 00_START_HERE.md, then the product scope, architecture, and implementation sequence; read the detailed component files before working on those components. Inspect the existing repository and preserve unrelated work. Create a tracked task list mapped to requirements R01–R17 and milestones M00–M14, then implement the working first version in tested vertical slices. Use the recommended stack unless actual repository constraints justify a documented alternative.

Keep model, agent profile, execution computer, and project workspace independent and visible. Backend jobs and a machine-side supervisor own execution; browser closure must not stop work. Project storage and retained outputs must survive execution-container replacement. Use stable operation IDs, durable journals, reconciliation, and explicit unknown-outcome states rather than replaying uncertain commands. Enforce permissions in the backend and the actual execution environment. Reuse appropriate remote-access and provider components instead of implementing their protocols yourself.

Use subagents for independent tracks when available, with one owner for shared schemas, migrations, policy, and job-state contracts. Keep demo fixtures separate from live deployments. Configure and test actual Windows/Linux machines and actual model providers when access is available. A test using a mock service cannot establish live-machine support. Complete all work that is possible with available access; ask a single grouped question for missing connection details or permissions only when they block specific integration steps. Do not repeatedly request approval for routine actions already authorized within the configured scope.

Before calling v1 complete, run the acceptance matrix in 07_ACCEPTANCE_TESTS_AND_OPERATIONS.md, including a real model-driven agent job that finishes with every browser tab closed, generated text/binary files surviving container replacement, duplicate-dispatch prevention, real account/path restrictions, and a complete backup/restore drill. Keep implemented versus verified status separate. Report required failures and blockers plainly, with evidence and exact next actions. Deliver the runnable code, deployment/install scripts, migrations, operations documentation, and real test report. Later-phase features follow v1 acceptance.
~~~

## 2. Minimum files to give each worker

Every worker reads documents 00, 01, and relevant contracts in 02. Do not send only one narrow feature paragraph and expect it to infer durability or permissions.

| Worker assignment | Additional files | Expected contribution |
|---|---|---|
| Lead/backend | All files | Shared contracts, migrations, policy, queue, integration and status |
| Windows/Linux host agent | 03, 05, 06, 07 | Enrollment, collectors, restricted identity launch, supervisor, process cleanup, OS tests |
| Remote access | 03, 06, 07 | SSH/SFTP, Guacamole gateway/session lifecycle, real desktop tests |
| Models/chat/agents | 04, 05, 06, 07 | Provider adapters, persisted chat, profiles, tool loop, concurrency/metrics |
| Project/files UI and backend | 05, 06, 07 | Persistent storage, browser/editor/export, checkpoints, environment lifecycle |
| Frontend | 01–07 | Real capability states, four selectors, jobs, diffs, error and recovery views |
| QA/operations | All files | Real-machine test evidence, fault injection, backup/restore, deployment guides |

## 3. Rules for parallel work

1. Establish versioned shared schemas and typed API contracts first. One lead owns migrations and merges interface changes.
2. Give each subagent a non-overlapping code area and concrete acceptance gate. Record dependencies rather than inventing alternate local contracts.
3. Use temporary fixtures behind explicit development adapters. Replace them with live integrations for release tests.
4. Make each change reviewable: explain the problem, behavior implemented, validation, and remaining limitations.
5. If a component cannot enforce a promised boundary, return a capability error or disable that mode; never hide the limitation behind UI text.

## 4. Status report format

Keep reports focused on what remains and what decisions or access are needed:

~~~text
Current milestone:
Implemented but not yet verified:
Verified on real machines (test IDs and evidence):
Failing or blocked mandatory tests:
Missing access/configuration, if any:
Next concrete work:
Changes to the plan and why:
~~~

Do not call a static UI prototype a completed dashboard, call a database row a running job, or claim Windows/Linux support without the relevant actual-machine evidence. If implementation ends before the release gate, provide a concise continuation handoff with exact files, commands already run, and remaining tests.

## 5. Expected implementation deliverables

The final code repository should contain application and host-agent source; pinned dependencies; database migrations; Compose/proxy configuration; Windows/Linux installation and update procedures; environment and credential examples without secrets; backup/restore tools; test fixtures and executable integration checks; a compatibility matrix; and evidence for required release tests. Preserve this planning pack as the baseline and record any intentional deviations.

The implementation model must not assume that credentials, computers, model IDs, or permission grants exist merely because an example appears in this pack.

