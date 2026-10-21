import 'reflect-metadata';
import type { Pool } from 'pg';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentBroker } from '@homelab/transport';
import { generateLocalPki, loadAuthority } from '../../../apps/api/src/modules/machines/pki.js';
import { createAgentServer } from '../../../apps/api/src/modules/machines/agent-server.js';
import type { ApiContext } from '../../../apps/api/src/core/context.js';

const exec = promisify(execFile);
export async function startGoRelay(options: { db: Pool; broker: AgentBroker; machine: string; workspace: string; identity: string; grant: string; recoveryGrant?: string }) {
  const sourceBinary = resolve(process.env.HOMELAB_AGENT_EXE!);
  const directory = await mkdtemp(join(tmpdir(), 'homelab-signed-go-'));
  const binary = join(directory, process.platform === 'win32' ? 'homelab-agent.exe' : 'homelab-agent');
  await copyFile(sourceBinary, binary);
  if (process.platform !== 'win32') await chmod(binary, 0o700);
  const root = join(directory, 'project'), identityDirectory = join(directory, 'identity'), supervisorData = join(directory, 'supervisor'), connectionData = join(directory, 'connection');
  await Promise.all([mkdir(root), mkdir(identityDirectory), mkdir(supervisorData), mkdir(connectionData)]);
  const pki = await generateLocalPki();
  const authority = await loadAuthority(pki.ca_pem, pki.ca_key_pem);
  const server = createAgentServer({ db: options.db, agentBroker: options.broker, audit: async () => {} } as unknown as ApiContext, { key: pki.server_key_pem, cert: pki.server_pem, ca: pki.ca_pem, authority });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const serverPort = (server.server.address() as { port: number }).port;
  const caPath = join(directory, 'ca.pem'), tokenPath = join(directory, 'enrollment-token');
  const token = randomBytes(32).toString('base64url');
  const { createHash, randomUUID } = await import('node:crypto');
  await options.db.query("INSERT INTO agent_enrollments(id,machine_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')", [randomUUID(), options.machine, createHash('sha256').update(token).digest('hex')]);
  await Promise.all([writeFile(caPath, pki.ca_pem), writeFile(tokenPath, token, { mode: 0o600 })]);
  const processes: ChildProcess[] = [];
  let connection: ChildProcess | undefined;
  let supervisor: ChildProcess | undefined;
  let diagnostic = '';
  const launch = (args: string[]) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    child.stderr!.on('data', bytes => { diagnostic = (diagnostic + String(bytes)).slice(-4096); });
    processes.push(child); return child;
  };
  const stop = async (child?: ChildProcess) => {
    if (child && child.exitCode === null && child.signalCode === null) { const exit = new Promise<void>(done => child.once('exit', () => done())); child.kill(); await exit; }
  };
  const close = async () => {
    await stop(connection); await stop(supervisor);
    for (const process of processes) await stop(process);
    await server.close();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await exec(binary, ['enroll', '--endpoint', `https://127.0.0.1:${serverPort}/agent/v1/enroll`, '--ca', caPath, '--machine-id', options.machine, '--identity-dir', identityDirectory, '--token-file', tokenPath], { timeout: 15_000, maxBuffer: 4096, windowsHide: true });
    const enrolled = JSON.parse(await readFile(join(identityDirectory, 'identity.json'), 'utf8'));
    const portReservation = createServer();
    await new Promise<void>(done => portReservation.listen(0, '127.0.0.1', done));
    const supervisorPort = (portReservation.address() as { port: number }).port;
    await new Promise<void>((done, reject) => portReservation.close(error => error ? reject(error) : done()));
    const localToken = randomBytes(32).toString('base64url'), localTokenPath = join(directory, 'local-token');
    await writeFile(localTokenPath, localToken, { mode: 0o600 });
    const supervisorConfig = join(directory, 'supervisor.json'), connectionConfig = join(directory, 'connection.json');
    await writeFile(supervisorConfig, JSON.stringify({ machine_id: options.machine, dispatch_epoch: enrolled.dispatch_epoch, data_dir: supervisorData, listen: `127.0.0.1:${supervisorPort}`, local_token_file: localTokenPath, docker_path: '', identity_dir: identityDirectory, require_signed_rpc: true, workspaces: [{ id: options.workspace, root, approved_root_id: 'validation-root', runtime_path: root, type: 'native', quota_bytes: 16 * 1024 * 1024, revision: 1, execution_identity_id: options.identity, policy_revision: 1, grant_ids: [options.grant], recovery_grant_id: options.recoveryGrant, writable: true, container_enabled: false, native_enabled: false }] }), { mode: 0o600 });
    await writeFile(connectionConfig, JSON.stringify({ machine_id: options.machine, control_plane_url: `https://127.0.0.1:${serverPort}`, server_ca_file: caPath, identity_dir: identityDirectory, supervisor_url: `http://127.0.0.1:${supervisorPort}`, local_token_file: localTokenPath, data_dir: connectionData, telemetry_interval_seconds: 2 }), { mode: 0o600 });
    supervisor = launch(['supervisor', '--config', supervisorConfig]);
    for (let attempt = 0; ; attempt++) {
      if (supervisor.exitCode !== null) throw new Error(`Actual signed supervisor stopped: ${diagnostic}`);
      try { const response = await fetch(`http://127.0.0.1:${supervisorPort}/v1/health`, { headers: { authorization: `Bearer ${localToken}` }, signal: AbortSignal.timeout(500) }); if (response.ok) { await response.body?.cancel(); break; } } catch { /* Bounded startup readiness. */ }
      if (attempt >= 100) throw new Error(`Actual supervisor did not start: ${diagnostic}`);
      await delay(50);
    }
    connection = launch(['connect', '--config', connectionConfig]);
    const machineGeneration = (await options.db.query('SELECT identity_generation FROM machines WHERE id=$1', [options.machine])).rows[0].identity_generation as string;
    const health = await options.broker.rpc(options.machine, 'GET', '/v1/health', null, { timeoutMs: 10_000, expectedMachineGeneration: machineGeneration });
    return { directory, root, server, health, machineGeneration, identityDirectory, supervisorData, connectionData, diagnostic: () => diagnostic,
      stopConnection: async () => { await stop(connection); connection = undefined; },
      restartConnection: async () => { await stop(connection); connection = launch(['connect', '--config', connectionConfig]); },
      close };
  } catch (error) { await close(); throw error; }
}
