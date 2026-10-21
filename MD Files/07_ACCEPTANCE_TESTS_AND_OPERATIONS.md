# 07 — Real-machine acceptance and operating procedures

## 1. What this file is

This is a test plan and evidence template. **All tests are NOT RUN at the time this plan is delivered.** No test outcome, real machine connection, deployment, benchmark, or restored backup is claimed here.

Mocks and deterministic fixtures are useful for development. Release evidence must use actual configured Windows/Linux computers, real SSH/desktop endpoints, a real model provider, and actual persisted project files. Test in dedicated disposable projects and reversible test services; do not interrupt unrelated running work.

## 2. Required test inventory

| Role | Required recorded information | Acceptance use |
|---|---|---|
| Control plane | Host ID, OS, deployment version, database version, storage volumes | Restart, upgrade, restore, persistence |
| Linux execution machine | Enrolled machine ID, distro/kernel, agent/supervisor versions, execution UID/groups, runtime | Native job and container tests |
| Windows execution machine | Machine ID, edition/build, service identity, executed token identity, SSH shell | Native files/jobs, SSH, service controls, desktop |
| GPU host | Machine ID, each device's stable ID/model, driver/collector versions | Per-GPU current/history readings where available |
| Desktop endpoints | Protocol/server/version, account, physical or remote-session classification | Authenticated browser display/control and session behavior |
| Local model provider | Adapter/version, endpoint reference, actual model/variant, runtime pool | Chat, tool loop, concurrency, capability tests |
| Existing-folder projects | One Linux and one Windows folder, permissions, initial file hashes | Non-destructive registration and native file access |
| Container project | Storage owner/root or volume, mounted path, image digest, runtime ID | Replacement and retained-file tests |
| Backup destination | Separate device/location reference, encryption/recovery arrangement | Restore drill and coverage validation |

One physical computer may fill several roles. Windows and a WSL Linux environment still have separate machine/execution identities. A missing Windows test machine means Windows support is not yet verified. A headless Linux machine needs a configured desktop test endpoint if the release claims Linux desktop support. Unsupported hardware fields can be not applicable with evidence; mandatory platform workflows cannot be waived by relabeling them optional.

## 3. Evidence to retain

For each test record: test ID, requirement IDs, application commit/version, configuration revisions, host/provider versions, start/end times, actual job/operation IDs, steps performed, expected/observed outcomes, relevant hashes, and links to sanitized logs/screenshots. Protect live secrets and personally sensitive desktop content. Screenshots alone do not prove command uniqueness or file persistence; use operation journals and hashes.

Allowed outcomes: **PASS**, **FAIL**, **BLOCKED**, **NOT RUN**, **NOT APPLICABLE**. A blocked test names the missing prerequisite and next action. Never use PASS to mean that code exists.

## 4. Acceptance matrix

| Test | Procedure | Required pass evidence |
|---|---|---|
| T01 — Login and session access | Sign in/out; attempt unauthenticated API, SSE, terminal, artifact, and desktop access; try disallowed object IDs; revoke a session | Protected resources denied; valid session works; active access closes on revocation according to documented behavior; no credentials in client assets |
| T02 — Independent onboarding | Enroll real Linux and Windows hosts; run monitoring, runner, SSH/SFTP, and desktop tests separately; disable one capability | Independent results/timestamps and actionable errors; monitoring stays healthy when SSH fails; machine identity persists across IP change |
| T03 — Metrics and stale data | Compare idle/load observations to host tools; use each actual GPU; pause telemetry; reboot a test host; inspect history | Per-device data and supported fields are plausible; stale age/gaps appear; counters reset safely; unsupported values are unavailable rather than zero |
| T04 — SSH/SFTP | Open both OS terminals; verify actual account/shell, resizing, Ctrl+C, Unicode; hash round-trip a test file; present wrong host key | Interactive behavior works; wrong keys fail closed; scoped files use an enforced boundary; direct human account access is labeled accurately |
| T05 — Remote desktop | Connect to actual Windows and Linux endpoints; observe local screen; test input, reconnect, logout, altered launch IDs, token replay | Physical-sharing/remote-session labels match observation; unsupported host editions are explained; auth bypass/replay denied; active tunnel closes when revoked |
| T06 — Complete file workflow | In both native projects and container project, upload, list, edit, preview, download, rename/delete/recover, export ZIP | Source/download hashes match; editor conflict handled; export manifest matches authorized files; unsupported previews offer download |
| T07 — Four independent selections | Use a model provider on one computer and execution/workspace on another; create/duplicate/revise a profile; change profile/model/provider endpoint during a running job | Actual response/model, process location, and file path agree with frozen run context; revisions and future selectors do not retarget existing work |
| T08 — Agent survives browser closure | Execute the detailed scenario in section 5 | Same job and operation; one physical command launch; complete logs/output/final verification after all tabs close |
| T09 — API and worker recovery | During a supervised command restart API, then kill worker; reconnect and reconcile | Original command continues or is truthfully reconciled; no duplicate side effect; worker resumes only at known persisted boundaries |
| T10 — Host disconnect and reboot | Break agent connectivity, restore it; separately reboot a disposable host during work | Temporary loss yields waiting/stale status; replay fills logs; reboot interrupts native execution; no automatic replay; files preserved |
| T11 — Cancellation and descendants | Cancel parent/child process fixtures on Linux, Windows, and inside a project container; cancel queued work; lose contact during cancellation | Confirmed process-group cleanup; queued work never launches; pending cancellation remains unconfirmed while disconnected; partial outputs retained |
| T12 — Duplicate dispatch and ambiguity | Drop acknowledgement, resend same operation ID; reuse idempotency key with changed payload; crash at launch-record boundary | Duplicate returns original receipt; changed payload conflicts; unknown launch outcome is reconciled or interrupted without replay |
| T13 — Container replacement | Execute section 6 with actual generated files | New runtime/container ID and generation; identical persistent file hashes; existing artifact links still download |
| T14 — Diffs and checkpoint recovery | Modify/delete text, create untracked and binary files, make an outside edit, restore selected files/checkpoint | Complete change manifest, recoverable prior bytes, visible external conflicts; unrelated later work preserved; protected manifests cannot be rewritten by project code |
| T15 — Permissions and policy limits | Attempt path traversal, symlink/junction races, archive escape, other-project reads, unauthorized service action, secret access; revoke grant; test supported egress policy; exhaust step/wall-time/command-time limits | Backend and real execution identity enforce advertised boundary; allowed scratch works; restrictive networking is enforced or rejected; limits stop dispatch/processes with accurate reasons |
| T16 — Provider and capability tests | Discover/stream real local models; save/reload a favorite; test tools/JSON/image; configure wrong credentials; exercise native management; interrupt upstream inference | Accurate tested capability state; favorites persist; unsupported management explained; partial response retained as interrupted; provider-stop uncertainty remains visible |
| T17 — Model status and performance | Compare catalog, loaded instances and active requests; generate while another client is active; run warm and cold requests | Available/loaded/busy stay distinct; external activity uncertainty shown; timings/units/provenance correct; missing metrics are not invented |
| T18 — Concurrency and locks | Submit beyond pool/machine/workspace limits, including aliases to same provider; disconnect a writer until lease expires; open a workspace terminal | Limits hold; extra jobs wait; aliases share capacity; unknown operation keeps its writer lock; terminal holds lock until process exit, not socket close |
| T19 — Saved actions and audit | Run approved service/container action and parameterized test command; attempt command injection and unapproved target; verify postcondition | Fixed argument schema and target scope enforced; effects/history/exit/verification recorded; routine authorized actions do not repeatedly prompt |
| T20 — Demo/live separation | Start both modes separately; inspect live database and disconnected machines; disable live endpoints | Distinct configuration/storage/databases; demo banner; no fixture metrics or fabricated success appears in live mode |
| T21 — Storage, log, and stream limits | Slow/disconnect a log viewer; exceed a configured output quota; fill disposable journal storage; exhaust test upload quota | Bounded memory; explicit log gap/truncation; unsafe new launches refused when receipts cannot persist; partial uploads do not appear complete |
| T22 — Backup and full restore | Follow section 7 into isolated deployment, including one offline-host partial-backup case | Complete restored configuration/history/files/keys where supplied; partial coverage is explicit; old actions never replay; usable new job after reconciliation |
| T23 — Install/upgrade/retention | Fresh install; stop/start stack; upgrade agent/API through compatible versions; run retention cleanup | Documented setup works; data retained; mismatched agents denied execution; garbage collection retains all referenced files/checkpoints |

Requirements R01–R17 must each map to at least one passing applicable test. Detailed per-component tests in documents 03–05 supplement this release matrix.

For T15, create short-lived test profiles that deliberately exhaust a small tool-step limit and a short job wall-time limit, then run a command exceeding its local timeout. Repeat the timeout with the browser closed and the agent-control connection temporarily disconnected. Verify no later agent step dispatches after the limit, the host enforces its local deadline without browser/backend assistance, descendants are stopped under the documented runtime policy, and the failed/interrupted reason distinguishes a configured limit from user cancellation. Use bounded harmless fixtures rather than unlimited loops. Also verify that reducing/revoking scope during a run stops new out-of-scope dispatches.

## 5. Required scenario A — a real agent job survives browser closure

1. Create a dedicated project on a real execution computer. Use a known supported model with a passing tool-use probe and an agent profile permitted to edit/test this project.
2. Prepare a harmless fixture that, on process startup, appends its operation ID to a flushed execution counter, emits a numbered log line every second for at least 180 seconds, and writes a small report plus a binary output. Use a host-supported runtime and record its version.
3. Ask the agent to invoke that fixture once, inspect the resulting files, compute their hashes, and report its verification. This must use the actual model tool loop; submitting only a direct manual command does not fully test the agent requirement.
4. Wait until the supervisor has durably acknowledged the command and several logs are visible. Record job ID, operation ID, host boot ID, and current event cursor.
5. Close **all dashboard browser tabs**. Do not leave another tab open to sustain the run. Keep the backend/host services running.
6. After the fixture's expected finish time, reopen the dashboard and open the existing job. The client must fetch that job, not create a new one.
7. Verify the execution counter contains exactly one launch for the operation and the host ledger contains one accepted execution. Check the complete or explicitly retained log sequence and the same job ID.
8. Verify the agent performed its subsequent inspection/hash checks while the browser was closed, or finishes them under the same persisted job after a documented backend recovery boundary. Browser closure alone must not pause orchestration.
9. Download both outputs and match their hashes to the job's artifact manifest. Verify elapsed/queue/wait timing was derived from server/host timestamps.
10. Reload twice more and reconnect the event stream from an earlier cursor. No command reruns and no duplicate tool result or assistant content is appended.

**Pass:** browser absence had no effect on job lifetime; one command launch, truthful retained history, real verification results, and usable outputs. Repeat against the Windows runner for native-job support. The container-specific survival case is covered next.

## 6. Required scenario B — generated files survive container replacement

1. Create a dedicated Linux container workspace with persistent storage owned by the project. Record project ID, storage host/root or volume identity, mount target, image digest, container ID, and generation.
2. Upload an existing input, edit project instructions, and use an agent to create a text report and binary file. Include at least one output not tracked by Git.
3. Record a complete manifest with relative paths, sizes, and SHA-256 hashes. Publish the intended outputs as retained artifacts and verify their control-plane copies.
4. Finish/cancel active jobs and confirm no unresolved writer remains. Use **Rebuild environment** to remove and replace the execution container while retaining the same storage.
5. Verify the new container ID differs and the environment generation increments. A stop/start of the same container alone does not pass this test.
6. Open the project in the replacement environment. Verify the original input, instructions, generated text, and binary outputs have the same hashes as before.
7. Continue the project with a harmless new agent task. Check that its model/profile/execution/workspace selections reference the existing project and new environment generation.
8. Download previously published artifacts through their original links. Temporarily disconnect the execution host and verify retained central copies remain downloadable; live working files should truthfully show that the host is unavailable.
9. Verify Restart, Remove Environment, and ordinary runtime cleanup never call project-file deletion. Test protected deletion separately on disposable managed data.
10. Register an existing user-owned folder, remove its dashboard registration, and verify its original files remain untouched. Registration is not permission to delete or quarantine that folder.

**Pass:** container lifecycle and project-data lifecycle are demonstrably separate. No result depends on files left in the former container's writable layer.

## 7. Required scenario C — complete backup and restore

1. Seed a small real dataset: settings, two machine definitions, provider definition, agent profile revisions, project instructions, conversation, completed and interrupted jobs, an artifact, and a checkpoint.
2. Capture baseline object counts and selected file hashes. Do not include plaintext credentials in the evidence report.
3. Run the backup workflow with a backup-set ID. Verify consistent database export, referenced blobs, Windows/Linux project coverage, safe host-ledger capture, and protected recovery-key availability.
4. Deliberately take one required storage host offline for a second backup attempt. That backup must report partial/incomplete coverage and name the affected project; it must not overwrite the last complete-backup status.
5. Restore the complete set into an isolated instance. Keep dispatch disabled and prevent restored scheduled/provider-management jobs from reaching production endpoints during initial validation.
6. Verify data counts/hashes, open the restored conversation, read historical operations, restore one changed file, and download the retained artifact.
7. Supply the separately protected secret recovery material and verify credentials can be used without re-entering every connection definition. If the test intentionally omits secrets, report the resulting manual recovery requirement.
8. Reconnect one designated test host, reconcile its boot/environment/operation ledger and rotate the dispatch epoch. No historical action may execute as a consequence of restore.
9. Permit a new harmless job and verify success. Recheck SSH/desktop capabilities individually rather than assuming old tests remain current.
10. Record elapsed restore time and the age of the most recent complete backup. Compare with proposed goals: **24-hour recovery point and four-hour recovery time** for the small initial deployment. These remain measured operational targets, not guarantees.

## 8. Operating procedures for v1

### Routine use and health

Review stale/offline capability indicators, failed/interrupted jobs, disk usage, local spool backlogs, and last complete backup coverage. Verify the selected execution computer and project path before starting a new task. Routine actions within an existing grant should not require repeated confirmation.

### Browser or network disconnect

Reopen the existing job by ID. Do not click Retry merely because logs stopped arriving. Inspect last receipt/heartbeat and the waiting/interrupted reason. Reconnect streams from the persisted cursor and reconcile the host ledger before changing execution state.

### Unknown command outcome

Keep the workspace writer lock. Inspect host boot ID, operation receipt, process/container identity, logs, and affected files/service state. If the original process is active, reattach or cancel it; if its result is known, record it. If outcome remains unknown, retain an interrupted attempt and require an explicit new attempt after reviewing possible partial effects. Do not automatically apply a checkpoint restore to external service/database effects.

### Environment rebuild

Show the exact project storage and current environment generation. Drain or cancel active jobs, capture required checkpoint/configuration, replace runtime only, validate the mount marker and file hashes, and reopen. If replacement fails, keep project data and previous configuration available for recovery.

### Credentials and agent certificate rotation

Rotate the secret version or machine certificate through protected administrative paths. Retest only affected connections. Provider credential rotation may preserve the same endpoint under an explicit policy; editing provider endpoint/adapter configuration cannot silently retarget an existing job. Revoking a host certificate denies new commands and marks active outcomes pending reconciliation as necessary.

### Software upgrade

Take a verified backup, drain new writes, record component versions, and apply reviewed migrations. Upgrade within the supported agent protocol window and run a short actual-machine smoke test. Preserve original images/configuration for rollback, but do not roll code back across an incompatible database migration without its documented recovery procedure.

### Storage and retention

Expose quotas and retained-file sizes. Proposed defaults: raw metrics 7 days, five-minute rollups 90 days, hourly rollups one year; normal logs 30 days; job/audit metadata one year; explicitly retained project files/artifacts until owner deletion. Checkpoint retention is project-configurable and reference-aware. Before pruning, show what would be lost and ensure references/backups remain consistent.

### Project removal and deletion

Unregistering an existing folder removes dashboard configuration/access, not the user's files. Deleting its bytes requires a separate grant naming host and root. Dashboard-owned managed storage may enter a configurable recovery quarantine (proposed 30 days). Never hide permanent deletion inside restart, rebuild, image cleanup, or unregister.

## 9. Release report template

The implementation agent should create a report with:

- Application commit and exact tested component versions.
- Sanitized real-machine/provider inventory and supported capability matrix.
- R01–R17 coverage and T01–T23 outcomes, with evidence paths.
- Browser-closure job ID and one-launch proof.
- Old/new container IDs and before/after artifact hashes.
- Restored backup-set ID, coverage, key-recovery result, and measured recovery time.
- Required failures/blockers and optional unavailable features.
- Operational quick start, restart/rebuild distinction, and recovery procedure.

Do not include a screenshot-filled success report with unresolved required integration tests hidden in footnotes. State the actual release readiness plainly.
