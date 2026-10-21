# Homelab Control Dashboard

Private control plane for independent model, agent profile, execution computer, and workspace selections. The baseline specification is in [MD Files/00_START_HERE.md](MD%20Files/00_START_HERE.md). The local implementation and scoped acceptance checks are complete. **Owner-configured homelab acceptance remains separate**, including real host/credential, performance and backup-device requirements; local fixtures do not certify those targets.

Start with [deployment](docs/operations/DEPLOYMENT.md), [backup and recovery](docs/operations/RECOVERY.md), [pinned components](docs/operations/VERSIONS.md), and [local operations evidence](docs/operations/EVIDENCE.md). See [acceptance evidence](docs/acceptance/README.md) for live-test requirements.

Current implementation, immutable build/test evidence, local run instructions and remaining acceptance gates are summarized in the [local handoff](docs/LOCAL_HANDOFF.md) and [completion tracker](docs/COMPLETION_TRACKER.md). No local model/browser readiness result is a full owner-homelab release verdict.

Work has resumed. The [historical operations checkpoint](docs/operations/PAUSE_HANDOFF.md) records the prior pause; current component evidence and remaining acceptance gates are tracked in the operations and acceptance runbooks.

## Windows one-click startup

After the [one-time Linux/WSL deployment setup](docs/operations/DEPLOYMENT.md#windows-one-click-startup), double-click **start.bat**. It starts the existing persistent control plane, waits for health and trusted HTTPS readiness, then opens the dashboard. The default root is `/srv/homelab-control`; a sole user WSL distribution is detected automatically (otherwise select it as documented). Initial setup still requires Docker/Compose, protected configuration, database provisioning/migration, and trust of your installation's CA. The launcher preserves data and existing security/dispatch settings; it does not initialize or upgrade installations.

## Local development

Use Node 24 LTS and the committed npm lockfile:

```sh
npm ci
npm run typecheck
npm test
```

Create local deployment configuration outside this checkout using `python deploy/configure.py --root /absolute/new/path`. Follow the deployment runbook for database migrations and owner bootstrap. No real machine, project root, model endpoint, or permission grant is inferred from examples. Live screens never substitute demo fixtures.

## Persistence and execution

PostgreSQL stores metadata, jobs, receipts and events. Durable artifacts, checkpoint bytes, keys, and execution-host project roots have independent lifetimes. Stopping or replacing containers does not authorize deleting their data. Never use `docker compose down -v` as routine cleanup.

Dispatch starts disabled in both application configuration and the database. Restored databases require a new dispatch epoch and host reconciliation before any new operation. Browser reconnect only replays retained events.

## Separate static demo

```sh
docker compose -f deploy/compose.demo.yml up -d
```

Open `http://localhost:8088`. This conspicuously labeled static example has no application database, credentials, machine connections, or executable actions. It is independent from production/development deployments.
