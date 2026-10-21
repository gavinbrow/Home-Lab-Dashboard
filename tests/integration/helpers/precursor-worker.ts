// Freeze a copy of THIS file into the explicitly pinned worker image. No checkout mount.
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { AgentBroker, HostRpcError } from '@homelab/transport';
import { BlobStore, RootedHostFileAdapter, createCheckpointForJob, publishCheckpointChanges } from '@homelab/storage';
import { claimJob, runClaimedJob } from '../../../apps/worker/src/runtime.js';
import { createCommandHandler } from '../../../apps/worker/src/commands.js';
import { createOperationExecutor } from '../../../apps/worker/src/operations.js';
import { expectedMachineGeneration } from '../../../apps/worker/src/authority.js';
import type { AgentDependencies } from '../../../apps/worker/src/agent.js';
import type { PolicyGrant } from '@homelab/contracts';
import { assertRuntimeSchema } from '../../../apps/worker/src/startup.js';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (!/^[0-9a-f-]{36}$/i.test(config.jobId)) throw Error('Only an explicit owned job UUID is permitted');
const db = new pg.Pool({ connectionString: config.databaseUrl, max: 6 });
await assertRuntimeSchema(db);
const broker = new AgentBroker(db, { signer: { keyId: config.keyId, privateKeyPem: await readFile(config.keyFile, 'utf8') } });
const store = new BlobStore(config.artifactRoot, 64 * 1024 * 1024, { db });
const checkpoint: AgentDependencies['checkpoint'] = async (job, runtime, reason) => {
  const workspace = (await db.query('SELECT * FROM workspaces WHERE id=$1 AND owner_id=$2', [job.workspace_id, job.requester_id])).rows[0]; workspace.quota_bytes = Number(workspace.quota_bytes);
  const files = new RootedHostFileAdapter((machine, method, path, body, options) => broker.rpc(machine, method, path, body, { ...options, expectedMachineGeneration: expectedMachineGeneration(job, machine), ownerId: job.requester_id, scopeGrantId: (job.payload.grant as PolicyGrant).id, scopeTool: 'run_command', signal: runtime.signal, jobGuard: { job_id: job.id, fence: job.fence, lease_owner: job.lease_owner ?? undefined, workspace_id: job.workspace_id } }));
  const captured = await createCheckpointForJob({ db, store, adapter: files, workspace, job, reason, assertLease: runtime.assertLease });
  return { id: captured.id, manifest_hash: captured.manifest_hash, consistency: captured.consistency };
};
const operations = createOperationExecutor({ broker, checkpoint, publishChanges: async (job, runtime, operation_id, before, after) => {
  const rows = (await db.query('SELECT * FROM checkpoints WHERE id=ANY($1::uuid[])', [[(before as any).id, (after as any).id]])).rows;
  return publishCheckpointChanges({ db, store, job, operation_id, before: rows.find(row => row.id === (before as any).id), after: rows.find(row => row.id === (after as any).id), attribution: 'recorded_tool', assertLease: runtime.assertLease });
} });
const command = createCommandHandler(operations);
try {
  for (;;) {
    const row = (await db.query('SELECT state FROM jobs WHERE id=$1', [config.jobId])).rows[0];
    if (!row || ['completed', 'failed', 'interrupted', 'cancelled'].includes(row.state)) break;
    const job = await claimJob(db, `immutable-precursor-${process.pid}`, 15, config.jobId);
    if (job) await runClaimedJob(db, job, { command: async (selected, runtime) => { try { await command(selected, runtime); } catch (error) { if (error instanceof HostRpcError) await runtime.wait(error.code, 2); else throw error; } } });
    else await delay(250);
  }
} finally { await db.end(); }
