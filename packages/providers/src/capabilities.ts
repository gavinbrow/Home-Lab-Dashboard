import{createHash,randomUUID}from'node:crypto';
import type{ModelObservation,ProviderAdapter,ProviderSnapshot}from'./types.js';
/** Resolve an explicitly selected native loaded instance without changing its inference ID. */
export function resolveObservedModel(models:ModelObservation[],modelId:string):ModelObservation|undefined{
  const exact=models.find(model=>model.id===modelId);if(exact)return exact;
  for(const model of models){const instance=model.loadedInstances.find(item=>item.id===modelId);if(instance){
    const config=Object.fromEntries(Object.entries(instance.config).sort(([a],[b])=>a.localeCompare(b)));
    return{...model,id:modelId,residency:'loaded',loadedInstances:[instance],metadata:{...model.metadata,parent_model_id:model.id,loaded_instance_id:instance.id,instance_config:instance.config,instance_config_fingerprint:createHash('sha256').update(JSON.stringify(config)).digest('hex')}};
  }}return undefined;
}
export interface CapabilityValidity {
  valid:boolean; state:'tested_pass'|'tested_fail'|'unknown'|'stale'; reasons:string[];
  tested_at:string|null; identity_observed_at:string|null; identity_age_seconds:number|null;
}
interface CurrentIdentity { revision:number; metadata?:Record<string,unknown>|null; observed_at?:string|Date|null }
interface ProbeRecord { state?:string|null; config_revision?:number|null; evidence?:Record<string,unknown>|null; created_at?:string|Date|null }
function date(value:string|Date|null|undefined):string|null { const stamp=value?new Date(value):null;return stamp&&Number.isFinite(stamp.getTime())?stamp.toISOString():null; }
/** A passing probe is bound to the observed server/model identity, not just its URL. */
export function evaluateProbeValidity(probe:ProbeRecord|null,current:CurrentIdentity,expectedRevision=current.revision,now=Date.now()):CapabilityValidity {
  const observed=date(current.observed_at);const result:CapabilityValidity={valid:false,state:'unknown',reasons:[],tested_at:date(probe?.created_at),identity_observed_at:observed,identity_age_seconds:observed?Math.max(0,(now-Date.parse(observed))/1000):null};
  if(!probe?.state){result.reasons.push('probe_not_run');return result;}
  if(current.revision!==expectedRevision||probe.config_revision!==current.revision)result.reasons.push('provider_configuration_changed');
  const evidence=probe.evidence??{};const metadata=current.metadata??{};
  for(const[field,evidenceField]of [['digest','model_digest'],['variant','model_variant'],['server_version','server_version'],['instance_config_fingerprint','model_instance_config_fingerprint']]as const){
    const actual=typeof metadata[field]==='string'?metadata[field]:null;const tested=typeof evidence[evidenceField]==='string'?evidence[evidenceField]:null;
    if(actual!==tested&&(actual!==null||tested!==null)){
      const label=field==='digest'?'model_digest':field==='variant'?'model_variant':field==='server_version'?'provider_server_version':'model_instance_configuration';
      result.reasons.push(tested===null?`${label}_not_bound_by_probe`:actual===null?`${label}_currently_unavailable`:`${label}_changed`);
    }
  }
  if(metadata.catalog==='removed')result.reasons.push('model_removed_from_catalog');
  if(result.reasons.length){result.state='stale';return result;}
  if(probe.state==='tested_pass'){result.state='tested_pass';result.valid=true;}
  else if(probe.state==='tested_fail'){result.state='tested_fail';result.reasons.push('latest_probe_failed');}
  else result.reasons.push('probe_has_no_passing_evidence');
  return result;
}
interface QueryDb { query(sql:string,values?:any[]):Promise<{rows:any[]}> }
/** Passive metadata refresh; never generates text or changes the selected endpoint. */
export async function refreshModelIdentity(db:QueryDb,snapshot:ProviderSnapshot,modelId:string,ownerId:string,adapter:ProviderAdapter,signal?:AbortSignal):Promise<{observed:boolean;reason?:string}>{
  const[catalogResult,versionResult]=await Promise.allSettled([adapter.discoverModels(signal),adapter.getServerVersion?.(signal)??Promise.resolve(null)]);
  const selected=catalogResult.status==='fulfilled'?resolveObservedModel(catalogResult.value,modelId):undefined;
  const version=versionResult.status==='fulfilled'?versionResult.value:null;
  if(!selected){
    if(catalogResult.status==='fulfilled'&&['ollama','lm-studio'].includes(snapshot.adapter))await db.query(`UPDATE models m SET metadata=m.metadata || '{"catalog":"removed"}'::jsonb,observed_at=now() FROM providers p WHERE p.id=m.provider_id AND p.id=$1 AND m.model_id=$2 AND p.revision=$3 AND p.owner_id=$4`,[snapshot.id,modelId,snapshot.revision,ownerId]);
    return{observed:false,reason:catalogResult.status==='rejected'?'identity_discovery_unavailable':'model_identity_not_listed'};
  }
  await db.query(`INSERT INTO models(id,provider_id,model_id,metadata,capabilities,observed_at)
    SELECT $1,id,$3,$4,$5,$6 FROM providers WHERE id=$2 AND revision=$7 AND owner_id=$8
    ON CONFLICT(provider_id,model_id) DO UPDATE SET metadata=models.metadata || excluded.metadata,observed_at=excluded.observed_at`,
  [randomUUID(),snapshot.id,modelId,{...selected.metadata,digest:typeof selected.metadata.digest==='string'?selected.metadata.digest:null,variant:typeof selected.metadata.variant==='string'?selected.metadata.variant:null,server_version:version,catalog:'discovered',identity_config_revision:snapshot.revision},selected.capabilities,selected.observedAt,snapshot.revision,ownerId]);
  return{observed:true};
}
export async function probeValidity(db:QueryDb,providerId:string,modelId:string,revision:number,capability:string):Promise<CapabilityValidity>{
  const row=(await db.query(`SELECT c.state,c.config_revision,c.evidence,c.created_at,p.revision AS current_revision,m.metadata AS current_metadata,m.observed_at AS identity_observed_at
    FROM providers p LEFT JOIN models m ON m.provider_id=p.id AND m.model_id=$2
    LEFT JOIN LATERAL(SELECT state,config_revision,evidence,created_at FROM capability_probes WHERE provider_id=p.id AND model_id=$2 AND capability=$3 ORDER BY created_at DESC,id DESC LIMIT 1)c ON true
    WHERE p.id=$1`,[providerId,modelId,capability])).rows[0];
  if(!row)return{valid:false,state:'unknown',reasons:['provider_unavailable'],tested_at:null,identity_observed_at:null,identity_age_seconds:null};
  return evaluateProbeValidity(row,{revision:row.current_revision,metadata:row.current_metadata,observed_at:row.identity_observed_at},revision);
}
