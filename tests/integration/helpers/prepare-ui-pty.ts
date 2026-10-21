// Offline preparation of one explicitly owned fixture; no application imports.
import { readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const linux = async (...args: string[]) => (await run('wsl.exe', ['-d', 'Ubuntu', '--exec', ...args], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout.trim();
const manifestPath = resolve('tests/integration/.wave3-runtime/ui-fixture.json'), fixture = JSON.parse(await readFile(manifestPath, 'utf8'));
const blobsOnly = process.env.HOMELAB_UI_BLOBS_ONLY === '1';
const directory = fixture.host_directory;
if (!/^\/tmp\/homelab-validation-wave2\/sentinel-[0-9a-f-]{36}$/.test(directory)) throw Error('Explicit owned root required');
const unc = '\\\\wsl.localhost\\Ubuntu' + directory.replaceAll('/', '\\'), privateRoot = `${directory}/privileged`;
if (await linux('sudo', '-n', '/usr/bin/pgrep', '-f', `^${directory}/homelab-agent`).catch(() => '')) throw Error('Stop existing owned Go processes before offline preparation');
if (!blobsOnly && await linux('sudo', '-n', '/usr/bin/test', '-e', privateRoot).then(() => true, () => false)) throw Error('Private fixture already prepared; do not overwrite its state');
const config = JSON.parse(await readFile(join(unc, 'supervisor.json'), 'utf8'));
if (config.machine_id !== fixture.ids.machine || config.workspaces.length !== 1 || config.workspaces[0].id !== fixture.ids.workspace || config.workspaces[0].root !== `${directory}/project` || config.data_dir !== `${directory}/supervisor`) throw Error('Preserved fixture identity/config mismatch');
const binarySource = '/mnt/c/Projects/Home-Lab-Dashboard/agent/bin/homelab-agent-linux-wave3-kernelboot-10';
const expected = '8eafe4986ec0e9534a8edc0b24d019c1b6d5588f227de42b086b9548485a9526';
if ((await linux('/usr/bin/sha256sum', binarySource)).split(' ')[0] !== expected) throw Error('Frozen host10 binary hash mismatch');

// Preserve all already referenced fixture blobs when switching Windows Node API
// storage to the immutable Linux API. Publish hash-checked files without replacing
// existing content-addressed objects; never copy keys or unrelated directories.
const sourceRoot = resolve(fixture.artifact_root), allowed = resolve('tests/integration/.wave3-runtime');
if (!sourceRoot.startsWith(allowed + '\\') || basename(sourceRoot) !== `artifacts-${fixture.ids.workspace}`) throw Error('Expected owned legacy blob root');
const central = '/tmp/homelab-validation-wave2/data/artifacts';
let total = 0, copied = 0, existing = 0;
const migrated: Array<{ sha256: string; bytes: number; copied: boolean }> = [];
for (const folder of await readdir(sourceRoot, { withFileTypes: true })) {
  if (!folder.isDirectory() || !/^[a-f0-9]{2}$/.test(folder.name)) continue;
  for (const file of await readdir(join(sourceRoot, folder.name), { withFileTypes: true })) {
    if (!file.isFile() || !/^[a-f0-9]{64}$/.test(file.name) || !file.name.startsWith(folder.name)) continue;
    const source = join(sourceRoot, folder.name, file.name), stat = await lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Unexpected blob source');
    total += stat.size; if (total > 256 * 1024 * 1024) throw Error('Bounded fixture migration exceeded256MiB');
    if (createHash('sha256').update(await readFile(source)).digest('hex') !== file.name) throw Error('Legacy fixture blob hash mismatch');
    const targetDir = `${central}/${folder.name}`, target = `${targetDir}/${file.name}`;
    const present = (await linux('sudo', '-n', '/usr/bin/sha256sum', target).catch(() => '')).split(' ')[0];
    if (present) { if (present !== file.name) throw Error('Existing immutable target hash mismatch'); existing++; migrated.push({ sha256: file.name, bytes: stat.size, copied: false }); continue; }
    await linux('sudo', '-n', '/bin/mkdir', '-p', '--', targetDir); await linux('sudo', '-n', '/bin/chown', '10001:10001', targetDir); await linux('sudo', '-n', '/bin/chmod', '0700', targetDir);
    const staging = `${targetDir}/.fixture-copy-${randomUUID()}`, sourceLinux = '/mnt/' + source[0].toLowerCase() + source.slice(2).replaceAll('\\', '/');
    await linux('sudo', '-n', '/bin/cp', '--', sourceLinux, staging);
    if ((await linux('sudo', '-n', '/usr/bin/sha256sum', staging)).split(' ')[0] !== file.name) throw Error('Staged blob hash mismatch');
    await linux('sudo', '-n', '/bin/chown', '10001:10001', staging); await linux('sudo', '-n', '/bin/chmod', '0600', staging); await linux('sudo', '-n', '/usr/bin/sync', '-d', staging);
    try { await linux('sudo', '-n', '/bin/ln', '--', staging, target); }
    catch { if ((await linux('sudo', '-n', '/usr/bin/sha256sum', target)).split(' ')[0] !== file.name) throw Error('Concurrent blob publication mismatch'); }
    await linux('sudo', '-n', '/bin/rm', '--', staging); await linux('sudo', '-n', '/usr/bin/sync', '-f', targetDir);
    copied++; migrated.push({ sha256: file.name, bytes: stat.size, copied: true });
  }
}

if (blobsOnly) {
  await writeFile(resolve('docs/acceptance/ui-fixture-image-migration.json'), JSON.stringify({ scope: 'Hash-checked offline fixture blob migration into existing immutable Linux API; no runtime or host changes', prepared_at: new Date().toISOString(), workspace_id: fixture.ids.workspace, source_blob_bytes: total, copied, existing, migrated }, null, 2) + '\n');
  console.log(`UI_BLOBS_MIGRATED copied=${copied} existing=${existing} bytes=${total}; no host process started`);
  process.exit(0);
}

await linux('sudo', '-n', '/usr/bin/install', '-d', '-m', '0700', privateRoot, `${privateRoot}/terminal-spool`);
await linux('sudo', '-n', '/bin/cp', '-a', '--', config.data_dir, `${privateRoot}/state`);
const privilegedBinary = `${privateRoot}/homelab-agent-kernelboot-10`, connectorBinary = `${directory}/homelab-agent-kernelboot-10`;
await linux('sudo', '-n', '/usr/bin/install', '-o', '0', '-g', '0', '-m', '0555', '--', binarySource, privilegedBinary);
await linux('/bin/cp', '--', binarySource, connectorBinary); await linux('/bin/chmod', '0755', connectorBinary);
config.data_dir = `${privateRoot}/state`;
config.workspaces[0].terminal = { shell: '/bin/sh', args: ['-i'], network_policy: 'none', limits: { TimeoutSeconds: 240, MaxOutputBytes: 1048576, MemoryBytes: 268435456, Pids: 32, CPUPercent: 100 }, grace_seconds: 60, idle_seconds: 240, replay_bytes: 1048576, record_transcript: false, container: { systemd_run: '/usr/bin/systemd-run', systemctl: '/usr/bin/systemctl', spool_dir: `${privateRoot}/terminal-spool`, identity_probe: '/usr/bin/id' } };
await writeFile(join(unc, 'ui-private-supervisor-staging.json'), JSON.stringify(config), { mode: 0o600 });
await linux('sudo', '-n', '/usr/bin/install', '-o', '0', '-g', '0', '-m', '0600', '--', `${directory}/ui-private-supervisor-staging.json`, `${privateRoot}/supervisor.json`);
await linux('sudo', '-n', '/bin/chown', '-R', '0:0', `${privateRoot}/state`); await linux('sudo', '-n', '/bin/chmod', '0700', `${privateRoot}/state`);
fixture.agent_binary_path = connectorBinary; fixture.privileged_supervisor = true; fixture.privileged_supervisor_binary_path = privilegedBinary;
await writeFile(manifestPath, JSON.stringify(fixture, null, 2), { mode: 0o600 });
await writeFile(resolve('docs/acceptance/ui-fixture-image-migration.json'), JSON.stringify({ scope: 'Offline operator fixture preparation, not product migration acceptance', prepared_at: new Date().toISOString(), machine_id: fixture.ids.machine, workspace_id: fixture.ids.workspace, go_sha256: expected, private_supervisor: privilegedBinary, terminal_user: '10001:10001', terminal_transcript: false, source_blob_bytes: total, copied, existing, migrated }, null, 2) + '\n');
console.log(`UI_PTY_PREPARED host10=${expected} copied_blobs=${copied} existing_blobs=${existing} bytes=${total}; no host process started`);
