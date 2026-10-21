import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import { AgentBroker } from '@homelab/transport';

const execute = promisify(execFile);
export const stackRoot = '/tmp/homelab-validation-wave2';
export const stackUnc = '\\\\wsl.localhost\\Ubuntu\\tmp\\homelab-validation-wave2';
export const safeImage = 'node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';
export const linux = async (...args: string[]) => (await execute('wsl.exe', ['-d', 'Ubuntu', '--exec', ...args], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout.trim();

/** Only explicitly allocated validation stack resources; no service or user creation. */
export async function startLinuxStackRelay(options: { db: Pool; owner: string; machine: string; workspace: string; identity: string; environment: string; grant: string; agentOrigin?: string; quotaBytes?: number; maxOutputBytes?: number }) {
  if (process.env.HOMELAB_LINUX_STACK !== '1') throw Error('Explicit HOMELAB_LINUX_STACK=1 is required');
  if (options.quotaBytes !== undefined && (!Number.isSafeInteger(options.quotaBytes) || options.quotaBytes < 4096 || options.quotaBytes > 64 * 1024 * 1024)) throw Error('Disposable project quota must be4KiB–64MiB');
  if (options.maxOutputBytes !== undefined && (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1024 || options.maxOutputBytes > 1024 * 1024)) throw Error('Disposable output bound must be1KiB–1MiB');
  const suffix = randomUUID();
  const directory = `${stackRoot}/sentinel-${suffix}`, files = join(stackUnc, `sentinel-${suffix}`);
  const root = `${directory}/project`, projectFiles = join(files, 'project');
  const binary = `${directory}/homelab-agent`;
  const sourceBinary = process.env.HOMELAB_AGENT_LINUX ?? '/mnt/c/Projects/Home-Lab-Dashboard/agent/bin/homelab-agent-linux-wave3-generation-6';
  const port = 40000 + Math.floor(Math.random() * 10000);
  const agentOrigin = options.agentOrigin ?? 'https://127.0.0.1:3449';
  if (!['https://127.0.0.1:3449', 'https://127.0.0.1:3459'].includes(agentOrigin)) throw Error('Only explicitly owned agent listener origins are permitted');
  const processes: Array<{ child: ChildProcess; pid: number }> = [];
  let runtimeId: string | undefined;
  let diagnostic = '';
  const launch = async (args: string[]) => {
    const child = spawn('wsl.exe', ['-d', 'Ubuntu', '--exec', 'sh', '-c', 'echo $$; exec "$@"', 'homelab-validation', binary, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr!.on('data', bytes => { diagnostic = (diagnostic + String(bytes)).slice(-4096); });
    const pid = await new Promise<number>((resolve, reject) => {
      child.stdout!.once('data', bytes => { const value = Number(String(bytes).split(/\r?\n/)[0]); value > 1 && Number.isSafeInteger(value) ? resolve(value) : reject(Error('Missing owned Linux PID')); });
      child.once('error', reject); child.once('exit', code => { if (code) reject(Error(`Linux fixture exited ${code}`)); });
    });
    const tracked = { child, pid }; processes.push(tracked); return tracked;
  };
  const stop = async () => {
    for (const item of processes.reverse()) if (item.child.exitCode === null && item.child.signalCode === null) {
      await linux('/bin/kill', '-TERM', String(item.pid)); item.child.kill();
    }
    // Leave exact fixture data for evidence/recovery. Container cleanup is caller-coordinated.
  };
  try {
    const control = (await options.db.query('SELECT * FROM runtime_control WHERE singleton=true')).rows[0];
    if (!control.dispatch_enabled || control.restore_mode || control.maintenance_mode) throw Error('Dedicated stack must be explicitly enabled and outside recovery before starting');
    await mkdir(files);
    await Promise.all(['identity', 'supervisor', 'connection', 'artifacts', 'project'].map(name => mkdir(join(files, name))));
    await linux('/bin/chmod', '0700', directory);
    await linux('/bin/cp', '--', sourceBinary, binary);
    // The trusted executable is bind-mounted into a nonroot container; its parent stays0700.
    await linux('/bin/chmod', '0755', binary);
    await linux('/bin/chmod', '0770', root);
    await linux('sudo', '-n', '/bin/chown', '10001:1000', root);
    const token = randomBytes(32).toString('base64url');
    await options.db.query("INSERT INTO agent_enrollments(id,machine_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')", [randomUUID(), options.machine, createHash('sha256').update(token).digest('hex')]);
    await writeFile(join(files, 'enrollment-token'), token, { mode: 0o600 });
    await linux(binary, 'enroll', '--endpoint', `${agentOrigin}/agent/v1/enroll`, '--ca', `${stackRoot}/config/agent-ca-cert.pem`, '--machine-id', options.machine, '--identity-dir', `${directory}/identity`, '--token-file', `${directory}/enrollment-token`);
    const identity = JSON.parse(await readFile(join(files, 'identity', 'identity.json'), 'utf8'));
    const localToken = randomBytes(32).toString('base64url');
    await writeFile(join(files, 'local-token'), localToken, { mode: 0o600 });
    const environmentCommand = ['/usr/local/bin/node', '-e', 'setInterval(()=>{},1000)'];
    runtimeId = await linux('/usr/bin/docker', 'run', '-d', '--name', `homelab-validation-environment-${suffix}`, '--label', `homelab.machine_id=${options.machine}`, '--label', `homelab.workspace_id=${options.workspace}`, '--user', '10001:10001', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--network', 'none', '--pids-limit', '32', '--memory', '256m', '--cpus', '1', '--mount', `type=bind,source=${root},target=/workspace/project`, safeImage, ...environmentCommand);
    const workspace = { id: options.workspace, root, approved_root_id: options.workspace, runtime_path: '/workspace/project', type: 'container', quota_bytes: options.quotaBytes ?? 64 * 1024 * 1024, revision: 1, execution_identity_id: options.identity, environment_id: options.environment, environment_generation: 1, runtime_id: runtimeId, environment_command: environmentCommand, image: safeImage, user: '10001:10001', cpus: 1, memory_bytes: 268435456, pids_limit: 32, max_output_bytes: options.maxOutputBytes ?? 1024 * 1024, timeout_path: '/usr/bin/timeout', policy_revision: 1, grant_ids: [options.grant], environment_grant_ids: [options.grant], deletion_grant_id: options.grant, writable: true, container_enabled: true, native_enabled: false };
    await writeFile(join(files, 'supervisor.json'), JSON.stringify({ machine_id: options.machine, dispatch_epoch: identity.dispatch_epoch, data_dir: `${directory}/supervisor`, listen: `127.0.0.1:${port}`, local_token_file: `${directory}/local-token`, docker_path: '/usr/bin/docker', identity_dir: `${directory}/identity`, require_signed_rpc: true, workspaces: [workspace] }), { mode: 0o600 });
    await writeFile(join(files, 'connection.json'), JSON.stringify({ machine_id: options.machine, control_plane_url: agentOrigin, server_ca_file: `${stackRoot}/config/agent-ca-cert.pem`, identity_dir: `${directory}/identity`, supervisor_url: `http://127.0.0.1:${port}`, local_token_file: `${directory}/local-token`, data_dir: `${directory}/connection`, telemetry_interval_seconds: 2 }), { mode: 0o600 });
    const supervisorArgs = ['supervisor', '--config', `${directory}/supervisor.json`];
    let supervisor: Awaited<ReturnType<typeof launch>> | undefined = await launch(supervisorArgs); await delay(1000);
    const crashSupervisor = async () => {
      if (!supervisor || supervisor.child.exitCode !== null || supervisor.child.signalCode !== null) throw Error('Owned supervisor is not running');
      const child = supervisor.child, exited = new Promise<void>(done => child.once('exit', () => done()));
      await linux('/bin/kill', '-KILL', String(supervisor.pid)); await Promise.race([exited, delay(5000)]);
      if (child.exitCode === null && child.signalCode === null) throw Error('Owned supervisor did not exit');
      supervisor = undefined;
    };
    const resumeSupervisor = async () => { if (supervisor) throw Error('Owned supervisor already running'); supervisor = await launch(supervisorArgs); await delay(500); };
    const connectorArgs = ['connect', '--config', `${directory}/connection.json`];
    let connector: Awaited<ReturnType<typeof launch>> | undefined = await launch(connectorArgs);
    const pauseTransport = async () => {
      if (connector && connector.child.exitCode === null && connector.child.signalCode === null) {
        const child = connector.child;
        const exited = new Promise<void>(done => child.once('exit', () => done()));
        await linux('/bin/kill', '-TERM', String(connector.pid));
        await Promise.race([exited, delay(5000)]);
        if (child.exitCode === null && child.signalCode === null) throw Error('Owned connector did not stop');
      }
      connector = undefined;
    };
    const resumeTransport = async () => { if (connector) throw Error('Owned connector already running'); connector = await launch(connectorArgs); };
    const signer = { keyId: await linux('sudo', '-n', '/bin/cat', `${stackRoot}/config/dispatch-key-id`), privateKeyPem: await linux('sudo', '-n', '/bin/cat', `${stackRoot}/config/dispatch-private.pem`) };
    const broker = new AgentBroker(options.db, { signer });
    const machineGeneration = (await options.db.query('SELECT identity_generation FROM machines WHERE id=$1 AND owner_id=$2', [options.machine, options.owner])).rows[0].identity_generation as string;
    const health = await broker.rpc(options.machine, 'GET', '/v1/health', null, { ownerId: options.owner, expectedMachineGeneration: machineGeneration, timeoutMs: 20_000 });
    const proof = await broker.rpc(options.machine, 'POST', `/v1/identities/${options.identity}/verify`, {}, { ownerId: options.owner, expectedMachineGeneration: machineGeneration, timeoutMs: 30_000 });
    return { directory, files, root, projectFiles, workspace, broker, signer, health, proof, stop, crashSupervisor, resumeSupervisor, pauseTransport, resumeTransport, runtimeId, machineGeneration, diagnostic: () => diagnostic };
  } catch (error) { await stop(); if (runtimeId) await linux('/usr/bin/docker', 'rm', '-f', runtimeId); throw error; }
}
