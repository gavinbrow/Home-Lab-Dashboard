import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
const execute = promisify(execFile), stackRoot = '/tmp/homelab-validation-wave2';
const linux = async (...args: string[]) => (await execute('wsl.exe', ['-d', 'Ubuntu', '--exec', ...args], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout.trim();
const pinnedWorker = process.env.HOMELAB_UI_WORKER_IMAGE, pinnedApi = process.env.HOMELAB_UI_API_IMAGE;
if (pinnedWorker && (!/^sha256:[a-f0-9]{64}$/.test(pinnedWorker) || !/^sha256:[a-f0-9]{64}$/.test(pinnedApi ?? ''))) throw Error('Explicit immutable API and worker images required');

const manifestPath = resolve('tests/integration/.wave3-runtime/ui-fixture.json');
const fixture = JSON.parse(await readFile(manifestPath, 'utf8'));
const configPath = resolve('tests/integration/.wave3-runtime/ui-worker-config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
if (config.ownerId !== fixture.ids.owner || !/^\/tmp\/homelab-validation-wave2\/sentinel-[0-9a-f-]{36}$/.test(fixture.host_directory)) throw Error('Explicit preserved owned UI fixture required');
const directory = fixture.host_directory, unc = '\\\\wsl.localhost\\Ubuntu' + directory.replaceAll('/', '\\');
const binary = fixture.agent_binary_path ?? `${directory}/homelab-agent`;
if (binary !== `${directory}/homelab-agent` && !new RegExp(`^${directory}/homelab-agent-[A-Za-z0-9_-]+$`).test(binary)) throw Error('Frozen owned Go binary path required');
const privilegedBinary = fixture.privileged_supervisor_binary_path ?? binary;
if (fixture.privileged_supervisor && !new RegExp(`^${directory}/privileged/homelab-agent-[A-Za-z0-9_-]+$`).test(privilegedBinary)) throw Error('Root-private frozen supervisor path required');
const db = new pg.Pool({ connectionString: config.databaseUrl, max: 8 });
if (!(await db.query("SELECT name FROM schema_migrations WHERE name='018_terminal_input_fingerprint_redaction.sql'")).rowCount) throw Error('UI fixture requires schema018');
const identity = JSON.parse(await readFile(join(unc, 'identity', 'identity.json'), 'utf8'));
const current = (await db.query('SELECT identity_generation FROM machines WHERE id=$1 AND owner_id=$2', [fixture.ids.machine, fixture.ids.owner])).rows[0];
if (identity.machine_identity_generation !== current?.identity_generation) throw Error('Preserved host installation changed; do not silently re-enroll or retarget');
const stopFile = resolve('tests/integration/.wave3-runtime/ui-runtime-stop'); await writeFile(stopFile, ''); await writeFile(config.stopFile, '');
const children: Array<{ child: ChildProcess; pid: number; privileged: boolean }> = [];
let worker: ChildProcess | undefined, workerContainer: string | undefined, pinnedStopFile: string | undefined, frozenWorkerPath: string | undefined, app: import('fastify').FastifyInstance | undefined, stop = false;
const counts: Record<string, number> = {}, errors: Array<{ path: string; code: string }> = [];
let counter: NodeJS.Timeout | undefined;
process.on('SIGTERM', () => { stop = true; }); process.on('SIGINT', () => { stop = true; });
const launch = async (args: string[]) => {
  const privileged = fixture.privileged_supervisor === true && args[0] === 'supervisor';
  const selectedBinary = privileged ? privilegedBinary : binary;
  const pattern = '^' + [selectedBinary, ...args].join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
  const findOwned = () => linux('sudo', '-n', '/usr/bin/pgrep', '-f', pattern).catch(() => '');
  if (privileged && await findOwned()) throw Error('Exact privileged fixture process already exists');
  const child = spawn('wsl.exe', ['-d', 'Ubuntu', '--exec', ...(privileged ? ['sudo', '-n', selectedBinary, ...args] : ['sh', '-c', 'echo $$; exec "$@"', 'homelab-ui-fixture', selectedBinary, ...args])], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const pid = privileged ? await (async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const found = await findOwned();
      if (/^[0-9]+$/.test(found)) {
        const value = Number(found), command = (await linux('sudo', '-n', '/bin/cat', `/proc/${value}/cmdline`)).split('\0').filter(Boolean);
        if (JSON.stringify(command) !== JSON.stringify([selectedBinary, ...args])) throw Error('Privileged fixture process identity mismatch');
        return value;
      }
      if (child.exitCode !== null) throw Error('Privileged fixture exited before startup');
      await delay(100);
    }
    child.kill(); throw Error('Exact privileged fixture PID not observed');
  })() : await new Promise<number>((resolve, reject) => { child.stdout!.once('data', bytes => { const value = Number(String(bytes).split(/\r?\n/)[0]); value > 1 && Number.isSafeInteger(value) ? resolve(value) : reject(Error('Missing owned Linux PID')); }); child.once('error', reject); });
  children.push({ child, pid, privileged });
};
try {
  await launch(['supervisor', '--config', fixture.privileged_supervisor ? `${directory}/privileged/supervisor.json` : `${directory}/supervisor.json`]); await delay(1000);
  await launch(['connect', '--config', `${directory}/connection.json`]);
  if (!pinnedWorker) {
  Object.assign(process.env, { APP_ORIGIN: fixture.app_origin, MASTER_KEY: config.masterKey, ARTIFACT_ROOT: config.artifactRoot, DISPATCH_SIGNING_KEY_FILE: config.keyFile, DISPATCH_SIGNING_KEY_ID: config.keyId, COOKIE_SECURE: 'false', NODE_ENV: 'test', DISPATCH_ENABLED: 'true', RESTORE_MODE: 'false' });
  for (const [name, file] of Object.entries({ AGENT_TLS_KEY_FILE: 'agent-server-key.pem', AGENT_TLS_CERT_FILE: 'agent-server-cert.pem', AGENT_CA_CERT_FILE: 'agent-ca-cert.pem', AGENT_CA_KEY_FILE: 'agent-ca-key.pem' })) {
    const target = join(unc, `ui-${file}`); await writeFile(target, await linux('sudo', '-n', '/bin/cat', `${stackRoot}/config/${file}`), { mode: 0o600 }); process.env[name] = target;
  }
  }
  if (pinnedWorker) {
    if (await linux('/usr/bin/docker', 'inspect', '--format', '{{.Image}}', 'homelab-validation-wave3-isolated-api') !== pinnedApi) throw Error('Actual isolated API image mismatch');
    const runSuffix = String(Date.now()), harnessName = `ui-pinned-worker-${runSuffix}.ts`, keyName = `ui-pinned-key-${runSuffix}.pem`, configName = `ui-pinned-config-${runSuffix}.json`;
    const source = resolve('tests/integration/helpers/sentinel-worker.ts'), target = join(unc, harnessName); await copyFile(source, target); frozenWorkerPath = target;
    const stateName = `ui-pinned-state-${Date.now()}`, stateDirectory = `${directory}/${stateName}`; await mkdir(join(unc, stateName));
    await linux('sudo', '-n', '/bin/chown', '10001:1000', stateDirectory); await linux('sudo', '-n', '/bin/chmod', '0770', stateDirectory);
    pinnedStopFile = join(unc, stateName, 'stop'); await writeFile(pinnedStopFile, '');
    await writeFile(join(unc, keyName), await readFile(config.keyFile), { mode: 0o600 });
    await writeFile(join(unc, configName), JSON.stringify({ ...config, keyFile: '/run/test/key.pem', artifactRoot: '/data/artifacts', stopFile: '/runtime/stop', readyFile: '/runtime/ready.json' }), { mode: 0o600 });
    await linux('sudo', '-n', '/bin/chown', '1000:10001', `${directory}/${keyName}`, `${directory}/${configName}`);
    await linux('/bin/chmod', '0640', `${directory}/${keyName}`, `${directory}/${configName}`); await linux('/bin/chmod', '0444', `${directory}/${harnessName}`);
    if (await linux('/usr/bin/docker', 'ps', '-q', '--filter', `label=homelab.validation_owner=${fixture.ids.owner}`)) throw Error('An owned UI worker is already running');
    workerContainer = await linux('/usr/bin/docker', 'run', '-d', '--name', `homelab-validation-ui-worker-${fixture.ids.owner}-${Date.now()}`, '--label', `homelab.validation_owner=${fixture.ids.owner}`, '--user', '10001:10001', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--network', 'host', '--memory', '768m', '--pids-limit', '128', '--cpus', '1', '--tmpfs', '/tmp:rw,nosuid,noexec,size=64m', '--env', 'DISPATCH_ENABLED=true', '--env', 'RESTORE_MODE=false', '--mount', `type=bind,source=${directory}/${harnessName},target=/app/tests/integration/helpers/sentinel-worker.ts,readonly`, '--mount', `type=bind,source=${directory}/${configName},target=/run/test/config.json,readonly`, '--mount', `type=bind,source=${directory}/${keyName},target=/run/test/key.pem,readonly`, '--mount', `type=bind,source=${stateDirectory},target=/runtime`, '--mount', `type=bind,source=${stackRoot}/data/artifacts,target=/data/artifacts`, '--entrypoint', 'node', pinnedWorker, '--import', 'tsx', '/app/tests/integration/helpers/sentinel-worker.ts', '/run/test/config.json');
    if (!/^[a-f0-9]{64}$/.test(workerContainer)) throw Error('Missing immutable UI worker identity');
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const status = JSON.parse(await linux('/usr/bin/docker', 'inspect', '--format', '{{json .}}', workerContainer));
      if (status.Image !== pinnedWorker || !status.State.Running) throw Error('Pinned UI worker exited or image changed before readiness');
      const marker = JSON.parse(await readFile(join(unc, stateName, 'ready.json'), 'utf8').catch(() => '{}'));
      if (marker.owner_id === fixture.ids.owner) { ready = true; break; }
      await delay(500);
    }
    if (!ready) throw Error('Pinned UI worker initialization not observed');
    fixture.api_origin = 'http://127.0.0.1:3019';
  } else {
  const { buildApp } = await import('../../../apps/api/src/app.js');
  app = await buildApp({ db });
  app.addHook('onRequest', async request => { const key = `${request.method} ${request.url.split('?')[0]}`; counts[key] = (counts[key] ?? 0) + 1; });
  app.addHook('onError', async (request, _reply, error) => { errors.push({ path: request.url.split('?')[0], code: String((error as any).code ?? error.name) }); if (errors.length > 50) errors.shift(); });
  await app.listen({ host: '127.0.0.1', port: 3021 });
  worker = spawn(process.execPath, ['--import', 'tsx', resolve('tests/integration/helpers/sentinel-worker.ts'), configPath], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  worker.stderr!.on('data', bytes => { process.stderr.write(String(bytes).slice(-2048)); });
  }
  const rows = (await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
  const provenance = { ready_at: new Date().toISOString(), scope: 'Preserved real UI fixture; no re-enrollment or old job replay', source_mode: pinnedWorker ? 'Immutable API and worker images; frozen harness; direct fixed Go launch' : 'Legacy direct source runtime', schema_count: rows.length, migrations: rows, api_image: pinnedApi, worker_image: pinnedWorker, worker_container: workerContainer, worker_harness_sha256: pinnedWorker ? createHash('sha256').update(await readFile(frozenWorkerPath!)).digest('hex') : undefined, go_binary_sha256: (await linux('/usr/bin/sha256sum', binary)).split(' ')[0], privileged_supervisor_sha256: fixture.privileged_supervisor ? (await linux('sudo', '-n', '/usr/bin/sha256sum', privilegedBinary)).split(' ')[0] : undefined, shared_agent_api: 'https://127.0.0.1:3449', driver_pid: process.pid, worker_pid: worker?.pid, host_pids: children.map(child => child.pid) };
  fixture.runtime_evidence = provenance;
  await writeFile(manifestPath, JSON.stringify(fixture, null, 2), { mode: 0o600 });
  await writeFile(resolve('tests/integration/.wave3-runtime/ui-runtime-state.json'), JSON.stringify(provenance, null, 2));
  if (!pinnedWorker) counter = setInterval(() => { void writeFile(resolve('tests/integration/.wave3-runtime/ui-request-counts.json'), JSON.stringify({ observed_at: new Date().toISOString(), counts, errors })).catch(() => undefined); }, 1000);
  console.log(`UI_RUNTIME_READY schema=${rows.length} ${fixture.api_origin}; bounded60min; explicit stop marker available`);
  const deadline = Date.now() + 60 * 60_000;
  while (!stop && Date.now() < deadline && !(await readFile(stopFile, 'utf8').catch(() => ''))) await delay(500);
} finally {
  if (counter) clearInterval(counter);
  if (pinnedStopFile) await writeFile(pinnedStopFile, 'UI fixture stopping');
  if (workerContainer) await linux('/usr/bin/docker', 'stop', '--time', '10', workerContainer);
  await writeFile(config.stopFile, 'UI runtime stopping');
  if (worker && worker.exitCode === null && worker.signalCode === null) await new Promise<void>(done => { const timeout = setTimeout(() => { worker!.kill(); done(); }, 10_000); worker!.once('exit', () => { clearTimeout(timeout); done(); }); });
  await app?.close();
  for (const item of children.reverse()) if (item.child.exitCode === null && item.child.signalCode === null) { await linux(...(item.privileged ? ['sudo', '-n'] : []), '/bin/kill', '-TERM', String(item.pid)); item.child.kill(); }
  await db.end();
}
