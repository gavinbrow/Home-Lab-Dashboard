// Runs only in an owned Linux helper container; never receives the Docker socket.
const fs = require('node:fs');
const crypto = require('node:crypto');
const command = process.argv[2] || 'configure';
const statePath = '/state/configuration.json';
const marker = '/state/installed.json';
function atomicCreate(path, text) {
  const staged = path + '.' + crypto.randomUUID() + '.pending';
  const fd = fs.openSync(staged, 'wx', 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.linkSync(staged, path); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  fs.unlinkSync(staged);
  const directory = fs.openSync(require('node:path').dirname(path), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
function saveExclusive(path, text, uid = 0) {
  if (!fs.existsSync(path)) atomicCreate(path, text);
  if (fs.existsSync(path)) {
    if (fs.readFileSync(path, 'utf8') !== text) throw Error('Existing protected configuration differs; refusing overwrite: ' + path);
  }
  fs.chownSync(path, uid, uid);
  fs.chmodSync(path, 0o600);
}
if (command === 'status') {
  console.log(fs.existsSync(marker) ? 'installed' : 'pending');
} else if (command === 'installed') {
  if (!fs.existsSync(statePath)) throw Error('Configuration missing');
  if (!fs.existsSync(marker)) atomicCreate(marker, JSON.stringify({ installedAt: new Date().toISOString() }));
} else if (command === 'token') {
  console.log(JSON.parse(fs.readFileSync(statePath, 'utf8')).bootstrap);
} else if (command === 'configure') {
  for (const dir of ['/state', '/runtime', '/migration', '/provision', '/postgres']) {
    fs.chownSync(dir, 0, 0); fs.chmodSync(dir, dir === '/state' ? 0o700 : 0o755);
  }
  let state;
  if (fs.existsSync(statePath)) state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  else {
    if (fs.readdirSync('/postgres-data').length || ['/artifacts', '/caddy-data', '/caddy-config'].some(dir => fs.readdirSync(dir).length)) throw Error('Existing persistent data has no protected configuration state. Restore its original configuration; never regenerate keys/passwords.');
    for (const dir of ['/runtime', '/migration', '/provision', '/postgres']) {
      if (fs.readdirSync(dir).length) throw Error('Protected files exist without installation state; refusing to regenerate secrets');
    }
    state = { version: 1, port: process.env.INSTALL_PORT, app: crypto.randomBytes(32).toString('hex'), migration: crypto.randomBytes(32).toString('hex'), admin: crypto.randomBytes(32).toString('hex'), master: crypto.randomBytes(32).toString('base64'), bootstrap: crypto.randomBytes(48).toString('base64url') };
    // Commit source of truth first; retries derive the same files after interruption.
    atomicCreate(statePath, JSON.stringify(state));
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  }
  if (state.version !== 1 || state.port !== process.env.INSTALL_PORT) throw Error('Existing installation settings differ; select its original project/port');
  saveExclusive('/runtime/runtime_env', `DATABASE_URL=postgresql://homelab_app:${state.app}@postgres:5432/homelab\nMASTER_KEY=${state.master}\nBOOTSTRAP_TOKEN=${state.bootstrap}\n`, 10001);
  saveExclusive('/migration/migration_env', `MIGRATION_DATABASE_URL=postgresql://homelab_migrator:${state.migration}@postgres:5432/homelab\nAPP_DB_ROLE=homelab_app\n`, 10001);
  saveExclusive('/provision/database_admin_url', `postgresql://postgres:${state.admin}@postgres:5432/homelab`);
  saveExclusive('/provision/app_password', state.app);
  saveExclusive('/provision/migration_password', state.migration);
  saveExclusive('/postgres/postgres_admin_password', state.admin, 999);
  for (const dir of ['/artifacts', '/caddy-data', '/caddy-config']) { fs.chownSync(dir, 10001, 10001); fs.chmodSync(dir, 0o700); }
  console.log('Protected configuration ready. Existing secrets and data preserved.');
} else throw Error('Unknown installation command');
