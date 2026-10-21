// Freeze this harness read-only inside the explicitly pinned worker image; all core imports resolve from /app.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { AgentBroker, HostRpcError } from '@homelab/transport';
import { BlobStore, RootedHostFileAdapter, createCheckpointForJob, publishCheckpointChanges, createProjectExportHandler } from '@homelab/storage';
import type { Workspace, PolicyGrant } from '@homelab/contracts';
import { createProviderAdapter, createTransport } from '@homelab/providers';
import { createAgentHandler, type AgentDependencies } from '../../../apps/worker/src/agent.js';
import { createAgentTools } from '../../../apps/worker/src/agent-tools.js';
import { createOperationExecutor } from '../../../apps/worker/src/operations.js';
import { claimJob, runClaimedJob } from '../../../apps/worker/src/runtime.js';
import { expectedMachineGeneration, assertCurrentGrant } from '../../../apps/worker/src/authority.js';
import { createCommandHandler } from '../../../apps/worker/src/commands.js';
import { createTerminalHandler } from '../../../apps/worker/src/terminal.js';
import { executeProviderJob } from '@homelab/providers/jobs';
import { createCapabilityTestHandler } from '../../../apps/api/src/modules/machines/capability-jobs.js';
import { probeMachineCapability } from '../../../apps/api/src/modules/remote/probes.js';
import { createSecretStore, parseMasterKey } from '../../../apps/api/src/core/secrets.js';
import type { HandlerRegistry, JobHandler } from '../../../apps/worker/src/runtime.js';
import { assertRuntimeSchema } from '../../../apps/worker/src/startup.js';

// Protected file input keeps credentials out of argv/stdout. Only the selected job is claimable.
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (!/^[0-9a-f-]{36}$/i.test(config.jobId) || config.ownerId || config.mode !== 'actual-t08-qwen4b-production') throw Error('Only one explicit actual T08 qwen3:4b job is permitted');
const db = new pg.Pool({ connectionString: config.databaseUrl, max: 8 });
await assertRuntimeSchema(db);
const selectedJob = (await db.query("SELECT kind,context->>'model_id' AS model FROM jobs WHERE id=$1", [config.jobId])).rows[0];
if (selectedJob?.kind !== 'agent' || selectedJob.model !== 'qwen3:4b') throw Error('Explicit actual qwen3:4b agent job required');
const abort = new AbortController();
process.on('SIGTERM', () => abort.abort()); process.on('SIGINT', () => abort.abort());
process.env.DISPATCH_ENABLED = 'true'; process.env.RESTORE_MODE = 'false';
const broker = new AgentBroker(db, { signer: { keyId: config.keyId, privateKeyPem: await readFile(config.keyFile, 'utf8') } });
const files = new RootedHostFileAdapter((machine, method, route, body, options) => broker.rpc(machine, method, route, body, { ...options, timeoutMs: 10_000 }));
const store = new BlobStore(config.artifactRoot, 64 * 1024 * 1024, { db });
const scopedFiles = (job: Parameters<AgentDependencies['checkpoint']>[0], runtime: { signal?: AbortSignal }, tool: string) => new RootedHostFileAdapter((machine, method, route, body, options) => broker.rpc(machine, method, route, body, { ...options, expectedMachineGeneration: expectedMachineGeneration(job, machine), ownerId: job.requester_id, signal: runtime.signal, scopeGrantId: (job.payload.grant as PolicyGrant).id, scopeTool: tool, jobGuard: { job_id: job.id, fence: job.fence, lease_owner: job.lease_owner ?? undefined, workspace_id: job.workspace_id } }));
const checkpoint: AgentDependencies['checkpoint'] = async (job, runtime, reason) => {
  const workspace = (await db.query('SELECT * FROM workspaces WHERE id=$1', [job.workspace_id])).rows[0]; workspace.quota_bytes = Number(workspace.quota_bytes);
  const permission = ['file.read', 'run_command'].find(tool => (job.payload.grant as PolicyGrant).tools.includes(tool));
  if (!permission) throw Error('checkpoint_scope_denied');
  const captured = await createCheckpointForJob({ db, store, adapter: scopedFiles(job, runtime, permission), workspace: workspace as Workspace, job, reason, assertLease: () => runtime.assertLease() });
  return { id: captured.id, manifest_hash: captured.manifest_hash, consistency: captured.consistency };
};
const publishChanges: NonNullable<import('../../../apps/worker/src/operations.js').OperationDependencies['publishChanges']> = async (job, runtime, operation_id, before, after) => {
  const ids = [(before as { id: string }).id, (after as { id: string }).id];
  const rows = (await db.query('SELECT * FROM checkpoints WHERE id=ANY($1::uuid[])', [ids])).rows;
  return publishCheckpointChanges({ db, store, job, operation_id, before: rows.find(row => row.id === ids[0]), after: rows.find(row => row.id === ids[1]), attribution: 'recorded_tool', assertLease: runtime.assertLease });
};
const operations = createOperationExecutor({ broker, checkpoint, publishChanges });
const secrets = config.masterKey ? createSecretStore(db, parseMasterKey(config.masterKey)) : undefined;
const resolveCredential = async (owner: string, id: string) => { if (!secrets) throw Error('No credential store in this explicit fixture'); return secrets.get(owner, id); };
let requestNumber = 0;
const handler = createAgentHandler({ resolveCredential: async () => { throw Error('No provider credentials in explicit local fixture'); }, checkpoint,
  executeTool: createAgentTools({ broker, files, scopedFiles, store, operations, checkpoint, publishChanges }),
  makeAdapter: (snapshot, dependencies) => {
    const transport = createTransport(snapshot, dependencies.resolveCredential);
    const adapter = createProviderAdapter(snapshot, { ...dependencies, transport: { request: async (path, body, signal) => {
      if (path === '/api/chat') {
        const wire = body as Record<string, unknown>;
        const options = wire.options as Record<string, unknown>;
        if ('think' in wire || options.temperature !== undefined || options.num_predict !== 4096 || options.num_ctx !== 8192) throw Error('Expected unmodified production generation fields for the explicit4B model');
        for (const name of Array.isArray(wire.tools) && wire.tools.length ? ['read_file', 'verify_file', 'publish_artifact'] : []) {
          const tool = (wire.tools as any[])?.find(item => item.function?.name === name);
          const pattern = tool?.function?.parameters?.properties?.path?.pattern;
          if (typeof pattern !== 'string' || !new RegExp(pattern).test('sentinel-report.txt') || new RegExp(pattern).test('/workspace/project/sentinel-report.txt')) throw Error('Reviewed relative-path schema missing from actual offered tools');
        }
        await writeFile(`${config.wireDirectory}/request-${++requestNumber}.json`, JSON.stringify({ captured_at: new Date().toISOString(), path, schema_sha256: createHash('sha256').update(JSON.stringify(wire.tools ?? [])).digest('hex'), body: wire }, null, 2), { mode: 0o640 });
      }
      return transport.request(path, body, signal);
    } } });
    return adapter;
  }
});
const reconnect = (work: JobHandler): JobHandler => async (job, runtime) => { try { await work(job, runtime); } catch (error) { if (error instanceof HostRpcError) await runtime.wait(error.code, 3); else throw error; } };
const registry: HandlerRegistry = {
  agent: reconnect(handler), command: reconnect(createCommandHandler(operations)),
  workspace_terminal: createTerminalHandler({ broker, operations, checkpoint, publishChanges }),
  project_export: reconnect(createProjectExportHandler({ db, store, adapterForJob: job => scopedFiles(job as Parameters<AgentDependencies['checkpoint']>[0], {}, 'project.export'), authorize: async (owner, workspace, grant) => { await assertCurrentGrant(db, owner, { execution_machine_id: workspace.machine_id, workspace_id: workspace.id }, 'project.export', grant); } })),
  capability_test: createCapabilityTestHandler({ broker, operations, probe: (machine, owner, capability, session) => { if (!secrets) throw Error('No credential store configured'); return probeMachineCapability(db, secrets, machine, owner, capability, session); } }),
  'provider.connectivity': async (job, runtime) => executeProviderJob(job, runtime, resolveCredential),
  'provider.discovery': async (job, runtime) => executeProviderJob(job, runtime, resolveCredential),
  'provider.runtime': async (job, runtime) => executeProviderJob(job, runtime, resolveCredential)
};
const active = new Map<string, Promise<void>>();
try {
  while (!abort.signal.aborted) {
    if (config.stopFile && await readFile(config.stopFile, 'utf8').catch(() => '')) { abort.abort(); break; }
    if (config.ownerId) {
      // A UI fixture may only claim this exact synthetic owner, with normal admission.
      // Model generation is deliberately excluded while the provider has a separate booking.
      const kinds = Object.keys(registry).filter(kind => kind !== 'agent');
      const rows = (await db.query("SELECT id FROM jobs WHERE requester_id=$1 AND kind=ANY($2::text[]) AND state IN ('queued','running','waiting','cancelling') AND next_run_at<=now() ORDER BY created_at LIMIT 12", [config.ownerId, kinds])).rows;
      for (const row of rows) {
        if (active.size >= 4) break;
        if (active.has(row.id)) continue;
        const claimed = await claimJob(db, `ui-fixture-${process.pid}`, 30, row.id);
        if (claimed) { const work = runClaimedJob(db, claimed, registry, abort.signal).finally(() => { active.delete(row.id); }); active.set(row.id, work); }
      }
      await delay(250); continue;
    }
    const current = (await db.query('SELECT state FROM jobs WHERE id=$1', [config.jobId])).rows[0];
    if (!current || ['completed', 'failed', 'interrupted', 'cancelled'].includes(current.state)) break;
    const job = await claimJob(db, `sentinel-${process.pid}`, 15, config.jobId);
    if (job) await runClaimedJob(db, job, registry, abort.signal);
    else await delay(250);
  }
} finally { abort.abort(); await Promise.allSettled(active.values()); await db.end(); }
