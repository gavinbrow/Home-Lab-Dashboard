/** Opt-in real PostgreSQL check. All tables are connection-local TEMP tables. */
import{Client}from'pg';
import assert from'node:assert/strict';
import{probeValidity,refreshModelIdentity,type ProviderAdapter,type ProviderSnapshot}from'../src/index.js';
const connectionString=process.env.HOMELAB_TEST_DATABASE_URL;if(!connectionString)throw new Error('Explicit HOMELAB_TEST_DATABASE_URL is required');
const db=new Client({connectionString});await db.connect();
try{
  await db.query(`CREATE TEMP TABLE providers(id text PRIMARY KEY,owner_id text NOT NULL,revision integer NOT NULL);
    CREATE TEMP TABLE models(id text PRIMARY KEY,provider_id text,model_id text,metadata jsonb,capabilities jsonb,observed_at timestamptz,UNIQUE(provider_id,model_id));
    CREATE TEMP TABLE capability_probes(id text PRIMARY KEY,provider_id text,model_id text,capability text,state text,config_revision integer,evidence jsonb,created_at timestamptz);`);
  await db.query("INSERT INTO providers VALUES('provider','owner',3)");
  await db.query("INSERT INTO models VALUES('model','provider','exact-model',$1,'{}',now())",[{digest:'a',server_version:'1',catalog:'discovered'}]);
  await db.query("INSERT INTO capability_probes VALUES('first','provider','exact-model','tools','tested_pass',3,$1,clock_timestamp())",[{model_digest:'a',server_version:'1'}]);
  assert.equal((await probeValidity(db,'provider','exact-model',3,'tools')).valid,true);
  const snapshot:ProviderSnapshot={id:'provider',revision:3,adapter:'ollama',baseUrl:'http://127.0.0.1:1',runtimePoolId:'fixture',routing:'unknown',allowedAddresses:['127.0.0.1'],allowPrivateHttp:true,timeoutMs:100};
  const adapter={discoverModels:async()=>[{id:'exact-model',label:'fixture',observedAt:new Date().toISOString(),source:'explicit_test_adapter',residency:'unknown',loadedInstances:[],metadata:{digest:'b'},capabilities:{tools:'unknown',images:'unknown'}}],getServerVersion:async()=> '2'}as unknown as ProviderAdapter;
  await refreshModelIdentity(db,snapshot,'exact-model','owner',adapter);
  const changed=await probeValidity(db,'provider','exact-model',3,'tools');assert.equal(changed.state,'stale');assert.ok(changed.reasons.includes('model_digest_changed'));assert.ok(changed.reasons.includes('provider_server_version_changed'));
  assert.equal((await db.query("SELECT state FROM capability_probes WHERE id='first'")).rows[0].state,'tested_pass');
  await db.query("INSERT INTO capability_probes VALUES('second','provider','exact-model','tools','tested_pass',3,$1,clock_timestamp())",[{model_digest:'b',server_version:'2'}]);
  assert.equal((await probeValidity(db,'provider','exact-model',3,'tools')).valid,true);
  await refreshModelIdentity(db,snapshot,'exact-model','owner',{...adapter,discoverModels:async()=>[]});
  assert.ok((await probeValidity(db,'provider','exact-model',3,'tools')).reasons.includes('model_removed_from_catalog'));
  process.stdout.write(JSON.stringify({scope:'real PostgreSQL TEMP-table capability invalidation; no installed model inference',outcome:'PASS',checks:['same_revision_digest_change','same_revision_server_version_change','old_evidence_preserved','new_probe_restores_validity','native_catalog_removal']})+'\n');
}finally{await db.end();}
