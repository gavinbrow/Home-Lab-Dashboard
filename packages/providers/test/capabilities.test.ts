import{test}from'node:test';
import assert from'node:assert/strict';
import{evaluateProbeValidity,probeValidity,resolveObservedModel,type ModelObservation}from'../src/index.js';
const probe={state:'tested_pass',config_revision:3,evidence:{model_digest:'digest-a',model_variant:'Q4',server_version:'1.0'},created_at:'2026-10-21T03:00:00Z'};
const current={revision:3,metadata:{digest:'digest-a',variant:'Q4',server_version:'1.0'},observed_at:'2026-10-21T03:01:00Z'};
test('capability pass binds exact observed model and server identity',()=>{
  const result=evaluateProbeValidity(probe,current,3,Date.parse('2026-10-21T03:02:00Z'));assert.equal(result.valid,true);assert.equal(result.identity_age_seconds,60);
  for(const[field,value,reason]of[['digest','digest-b','model_digest_changed'],['variant','Q8','model_variant_changed'],['server_version','2.0','provider_server_version_changed']]as const){
    const invalid=evaluateProbeValidity(probe,{...current,metadata:{...current.metadata,[field]:value}});assert.equal(invalid.valid,false);assert.equal(invalid.state,'stale');assert.ok(invalid.reasons.includes(reason));
  }
});
test('identity discovery invalidates old unbound probes at unchanged configuration revision',()=>{
  const result=evaluateProbeValidity({...probe,evidence:{}},current);assert.equal(result.state,'stale');assert.ok(result.reasons.includes('model_digest_not_bound_by_probe'));
  assert.equal(evaluateProbeValidity(probe,{...current,revision:4}).state,'stale');
  assert.equal(evaluateProbeValidity(probe,{...current,metadata:{...current.metadata,catalog:'removed'}}).state,'stale');
});
test('unknown identity stays explicit and latest failure never falls back to an older pass',()=>{
  const unknown={revision:1,metadata:{},observed_at:null};const result=evaluateProbeValidity({state:'tested_pass',config_revision:1,evidence:{}},unknown);
  assert.equal(result.valid,true);assert.equal(result.identity_age_seconds,null);
  assert.equal(evaluateProbeValidity({state:'tested_fail',config_revision:1,evidence:{}},unknown).valid,false);
  assert.equal(evaluateProbeValidity(null,unknown).state,'unknown');
  assert.equal(evaluateProbeValidity(probe,{...current,metadata:{...current.metadata,digest:null}}).state,'stale');
});
test('shared worker validity helper reads the latest probe and current installed metadata',async()=>{
  const db={query:async(_sql:string,values?:any[])=>{assert.deepEqual(values,['provider','model','tools']);return{rows:[{...probe,current_revision:3,current_metadata:{...current.metadata,digest:'replacement'},identity_observed_at:current.observed_at}]};}};
  const result=await probeValidity(db,'provider','model',3,'tools');assert.equal(result.valid,false);assert.equal(result.state,'stale');
});
test('loaded native instance keeps its inference ID and binds its selected configuration',()=>{
  const model:ModelObservation={id:'catalog-model',label:'Catalog model',observedAt:current.observed_at,source:'native',residency:'loaded',loadedInstances:[{id:'loaded-instance',config:{context_length:4096,flash_attention:true}}],metadata:current.metadata,capabilities:{tools:'claimed',images:'unknown'}};
  const selected=resolveObservedModel([model],'loaded-instance');assert.ok(selected);assert.equal(selected.id,'loaded-instance');assert.equal(selected.metadata.parent_model_id,'catalog-model');
  const fingerprint=selected.metadata.instance_config_fingerprint;assert.equal(typeof fingerprint,'string');
  const bound={...probe,evidence:{...probe.evidence,model_instance_config_fingerprint:fingerprint}};
  assert.equal(evaluateProbeValidity(bound,{...current,metadata:selected.metadata}).valid,true);
  const reordered=resolveObservedModel([{...model,loadedInstances:[{id:'loaded-instance',config:{flash_attention:true,context_length:4096}}]}],'loaded-instance');assert.equal(reordered?.metadata.instance_config_fingerprint,fingerprint);
  const changed=resolveObservedModel([{...model,loadedInstances:[{id:'loaded-instance',config:{context_length:8192,flash_attention:true}}]}],'loaded-instance');assert.ok(changed);
  assert.ok(evaluateProbeValidity(bound,{...current,metadata:changed.metadata}).reasons.includes('model_instance_configuration_changed'));
  assert.equal(resolveObservedModel([model],'missing-instance'),undefined);
});
