import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {BlobStore} from '../../packages/storage/src/blobs.js';
import {createSecretStore,parseMasterKey} from '../../apps/api/src/core/secrets.js';
if(process.env.HOMELAB_RECOVERY_FIXTURE!=='1')throw new Error('Explicit allocated fixture required');
const db=new Pool({connectionString:process.env.DATABASE_URL}),store=new BlobStore(process.env.ARTIFACT_ROOT!,64*1024*1024,{db});
const secretStore=createSecretStore(db,parseMasterKey(process.env.MASTER_KEY));
const proofPath='/proof/retained-key-fixture.json';
try{
 if(process.argv[2]==='seed'){
  const fixture=JSON.parse(await readFile('/fixture-data.json','utf8'));
  const owner=(await db.query('SELECT owner_id FROM workspaces WHERE id=$1',[fixture.workspace_id])).rows[0].owner_id;
  const value=randomBytes(32).toString('base64'),secret_id=await secretStore.put(owner,'actual-enrolled-backup-fixture',value);
  const blob=await store.put(Buffer.from(Array.from({length:4096},(_,index)=>index%256))),artifact_id=randomUUID();
  await db.query("INSERT INTO artifacts(id,owner_id,workspace_id,relative_path,sha256,size_bytes,mime_type,storage_key) VALUES($1,$2,$3,'retained-fixture.bin',$4,$5,'application/octet-stream',$4)",[artifact_id,owner,fixture.workspace_id,blob.hash,blob.size]);
  await writeFile(proofPath,JSON.stringify({owner,secret_id,secret_sha256:createHash('sha256').update(value).digest('hex'),artifact_id,artifact_hash:blob.hash,artifact_bytes:blob.size},null,2),{flag:'wx',mode:0o600});
  console.log(JSON.stringify({status:'SEEDED',scope:'actual application secret store and retained blob',artifact_bytes:blob.size}));
 }else{
  const proof=JSON.parse(await readFile(proofPath,'utf8'));
  assert.equal(createHash('sha256').update(await secretStore.get(proof.owner,proof.secret_id)).digest('hex'),proof.secret_sha256);
  const bytes=await store.get(proof.artifact_hash);assert.equal(bytes.length,proof.artifact_bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),proof.artifact_hash);
  const control=(await db.query('SELECT * FROM runtime_control WHERE singleton')).rows[0];
  assert.equal(control.restore_mode,true);assert.equal(control.dispatch_enabled,false);
  console.log(JSON.stringify({restored_secret_decryption:'PASS',retained_blob_hash:'PASS',artifact_bytes:bytes.length,dispatch_enabled:false,restore_mode:true,new_epoch:control.dispatch_epoch}));
 }
}finally{await db.end();}
