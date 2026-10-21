// Read-only capture of the explicitly allocated Wave3 validation runtime.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {Pool} = require('pg');
const container = 'homelab-validation-wave2-api-1';
const root = path.resolve(__dirname, '../..');
const label=process.argv[2]??'wave3d';if(!/^[a-z0-9-]{1,80}$/.test(label))throw Error('Invalid evidence label');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const normalize = bytes => bytes.toString('utf8').replace(/\r\n/g, '\n');
const docker = (...args) => execFileSync('wsl.exe', ['-d','Ubuntu','--exec','docker',...args], {windowsHide:true,maxBuffer:32*1024*1024});
async function main() {
  const inspect = JSON.parse(docker('inspect','--format','{{json .}}',container));
  const result = {captured_at:new Date().toISOString(),scope:'Read-only snapshot; no jobs, migrations, service changes, or ledger writes',api:{container_id:inspect.Id,image_id:inspect.Image,configured_image:inspect.Config.Image,state:inspect.State.Status},files:[]};
  result.api.runtime_version=docker('exec',container,'node','--version').toString().trim();
  result.api.npm_version=docker('exec',container,'npm','--version').toString().trim();
  for(const name of ['packages/transport/src/index.ts','package-lock.json',...fs.readdirSync(path.join(root,'db/migrations')).filter(name=>name.endsWith('.sql')).map(name=>'db/migrations/'+name)]) {
    const image = docker('exec',container,'cat',`/app/${name}`), source=fs.readFileSync(path.join(root,name));
    result.files.push({path:name,image_sha256:sha(image),checkout_sha256:sha(source),image_lf_sha256:sha(normalize(image)),checkout_lf_sha256:sha(normalize(source)),identical_after_lf_normalization:normalize(image)===normalize(source)});
  }
  const imageLock=JSON.parse(docker('exec',container,'cat','/app/package-lock.json'));
  const currentLock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json')));
  const added=Object.entries(currentLock.packages).filter(([name])=>!Object.hasOwn(imageLock.packages,name));
  result.lock_difference={added_entries:added.map(([name,pkg])=>({name,version:pkg.version,optional:pkg.optional===true})),removed_entries:Object.keys(imageLock.packages).filter(name=>!Object.hasOwn(currentLock.packages,name)),changed_existing_entries:Object.keys(imageLock.packages).filter(name=>Object.hasOwn(currentLock.packages,name)&&JSON.stringify(imageLock.packages[name])!==JSON.stringify(currentLock.packages[name]))};
  const generation=/gen([0-9]+)/.exec(label)?.[1]??'5';
  const suppliedBinaries=process.argv.slice(3);
  if(suppliedBinaries.length>4||suppliedBinaries.some(binary=>!/^agent\/bin\/[a-zA-Z0-9_.-]+$/.test(binary)))throw Error('Only explicitly named agent/bin binaries are accepted');
  result.host_binaries=(suppliedBinaries.length?suppliedBinaries:label==='wave3d'?['agent/bin/homelab-agent-linux-wave3-integrated-1']:[`agent/bin/homelab-agent-linux-wave3-generation-${generation}`,`agent/bin/homelab-agent-windows-wave3-generation-${generation}.exe`]).map(binary=>({path:binary,sha256:sha(fs.readFileSync(path.join(root,binary)))}));
  const url=new URL(fs.readFileSync('\\\\wsl.localhost\\Ubuntu\\tmp\\homelab-validation-wave2\\config\\database-admin-url','utf8').trim());url.hostname='127.0.0.1';url.port='15439';
  const db=new Pool({connectionString:url.href,max:1});
  try {
    await db.query('BEGIN READ ONLY');
    result.database=(await db.query('SELECT version() AS version,current_database() AS database')).rows[0];
    result.migrations=(await db.query('SELECT name,checksum,applied_at FROM schema_migrations ORDER BY name')).rows;
    result.runtime_control=(await db.query('SELECT dispatch_epoch,dispatch_enabled,restore_mode,maintenance_mode FROM runtime_control WHERE singleton=true')).rows[0];
    await db.query('COMMIT');
  }finally {await db.end();}
  fs.writeFileSync(path.join(__dirname,`runtime-manifest-${label}.json`),JSON.stringify(result,null,2)+'\n');
  process.stdout.write(JSON.stringify({image:result.api.image_id,migrations:result.migrations.length,lock_additions:added.length,changed_existing_lock_entries:result.lock_difference.changed_existing_entries.length,binaries:result.host_binaries})+'\n');
}
main().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
