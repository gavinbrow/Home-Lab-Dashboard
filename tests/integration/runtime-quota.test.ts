import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { AgentBroker } from '@homelab/transport';
import { linux, stackRoot } from './helpers/linux-stack.js';

test('actual protected4KiB quota rejects publication and retains conservative unknown receipt', { skip: process.env.HOMELAB_QUOTA_CONTINUE !== '1' ? 'Explicit retained owned controls fixture only' : false, timeout: 45_000 }, async () => {
  const old=JSON.parse(await readFile('docs/acceptance/runtime-controls-first-physical-partial.json','utf8'));
  assert.equal(old.ids.workspace,'237909ca-eb58-4984-9c10-fa4d6e72ea87');
  const root=old.fixture_directory, files='\\\\wsl.localhost\\Ubuntu'+root.replaceAll('/','\\');
  const admin=new URL(await linux('sudo','-n','/bin/cat',`${stackRoot}/config/database-admin-url`));admin.hostname='127.0.0.1';admin.port='15439';
  const db=new pg.Pool({connectionString:admin.href}); const processes:Array<{child:ChildProcess;pid:number}>=[];
  const evidence:Record<string,any>={outcome:'RUNNING',started_at:new Date().toISOString(),scope:'One existing isolated4KiB project quota; no hostdisk exhaustion, no model or oldoperation retry',workspace_id:old.ids.workspace,host_sha256:old.host_sha256};
  process.env.DISPATCH_ENABLED='true';
  const launch=async(args:string[])=>{const child=spawn('wsl.exe',['-d','Ubuntu','--exec','sh','-c','echo $$; exec "$@"','homelab-quota-owned',`${root}/homelab-agent`,...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});const pid=await new Promise<number>((done,reject)=>{child.stdout!.once('data',raw=>{const n=Number(String(raw).split(/\r?\n/)[0]);Number.isSafeInteger(n)&&n>1?done(n):reject(Error('Missing owned PID'));});child.once('error',reject);});processes.push({child,pid});};
  try{
    assert.equal((await linux('/usr/bin/sha256sum',`${root}/homelab-agent`)).split(' ')[0],old.host_sha256);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM workspace_locks WHERE workspace_id=$1',[old.ids.workspace])).rows[0].n,0);
    await launch(['supervisor','--config',`${root}/supervisor.json`]);await delay(500);await launch(['connect','--config',`${root}/connection.json`]);
    const keyId=await linux('sudo','-n','/bin/cat',`${stackRoot}/config/dispatch-key-id`);
    const broker=new AgentBroker(db,{signer:{keyId,privateKeyPem:await readFile(join(files,'controls-key.pem'),'utf8')}});
    const generation=(await db.query('SELECT identity_generation FROM machines WHERE id=$1',[old.ids.machine])).rows[0].identity_generation;
    const write=async(path:string,size:number)=>{const operation=randomUUID();return broker.rpc(old.ids.machine,'PUT',`/v1/workspaces/${old.ids.workspace}/files`,{operation_id:operation,grant_id:old.ids.grant,path,content_base64:Buffer.alloc(size,81).toString('base64'),expected_sha256:null},{requestId:operation,ownerId:old.ids.owner,expectedMachineGeneration:generation,scopeGrantId:old.ids.grant,scopeTool:'file.write',timeoutMs:12000}) as Promise<any>;};
    const a=await write('quota-a.bin',2500);evidence.first=a;assert.equal(a.state,'completed',JSON.stringify(a));
    const b=await write('quota-b.bin',2500);evidence.second=b;assert.notEqual(b.state,'completed');assert.match(String(b.error??b.reason),/quota/);
    assert.equal(await readFile(join(files,'project','quota-b.bin')).then(()=>true,()=>false),false);assert.deepEqual(await readFile(join(files,'project','quota-a.bin')),Buffer.alloc(2500,81));
    const c=await write('quota-after-unknown.txt',1);evidence.followup=c;assert.notEqual(c.state,'completed');assert.match(String(c.error??c.reason),/busy|unknown|unresolved/i);
    assert.equal(await readFile(join(files,'project','quota-after-unknown.txt')).then(()=>true,()=>false),false);
    evidence.quota_bytes=4096;evidence.unknown_receipt_retained=b.state==='outcome_unknown';evidence.outcome='PASS';evidence.completed_at=new Date().toISOString();
  }catch(error){evidence.outcome='FAIL';evidence.error=error instanceof Error?error.message:String(error);throw error;}
  finally{await writeFile('docs/acceptance/runtime-quota-result.json',JSON.stringify(evidence,null,2)+'\n');for(const item of processes.reverse())if(item.child.exitCode===null&&item.child.signalCode===null){await linux('/bin/kill','-TERM',String(item.pid));item.child.kill();}await db.end();}
});
