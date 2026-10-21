import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createProviderAdapter } from './index.js';
import { colorProbeImage } from './images.js';
import { testProviderConnectivity } from './connectivity.js';
import { resolveObservedModel } from './capabilities.js';
import { ProviderError, type ChatRequest, type ProviderSnapshot, type ManagementAction } from './types.js';
// Structural boundary avoids making the adapter package depend on orchestration.
interface Runtime {
  db: { query(sql: string, values?: any[]): Promise<{ rows: any[]; rowCount: number | null }> };
  signal: AbortSignal; assertLease(): Promise<void>; cancelled(): Promise<boolean>;
  appendEvent(type: string, payload: unknown): Promise<void>;
  complete(result: unknown): Promise<void>; interrupt(reason: string): Promise<void>;
  fail?(reason: string): Promise<void>;
}
interface ProviderJob { id: string; requester_id: string; kind: string; payload: Record<string, any> }
export async function executeProviderJob(job: ProviderJob, runtime: Runtime, resolveCredential: (owner: string, ref: string) => Promise<string>): Promise<void> {
  const snapshot = job.payload.provider as ProviderSnapshot;
  const adapter = createProviderAdapter(snapshot, { resolveCredential: ref => resolveCredential(job.requester_id, ref) });
  await runtime.assertLease();
  if(job.kind==='provider.connectivity') { const result=await testProviderConnectivity(snapshot,ref=>resolveCredential(job.requester_id,ref),runtime.signal);await runtime.assertLease();await runtime.appendEvent('provider.connectivity',result);await runtime.complete(result);return; }
  if (job.kind === 'provider.discovery') {
    const serverVersion = await adapter.getServerVersion?.(runtime.signal).catch(()=>null) ?? null;
    const models = await adapter.discoverModels(runtime.signal); await runtime.assertLease();
    // Snapshot revision prevents an old endpoint's catalog from overwriting new configuration.
    for (const model of models) {
      await runtime.db.query(`INSERT INTO models(id,provider_id,model_id,metadata,capabilities,observed_at)
        SELECT $1,id,$3,$4,$5,$6 FROM providers WHERE id=$2 AND revision=$7 AND owner_id=$8
        ON CONFLICT(provider_id,model_id) DO UPDATE SET metadata=excluded.metadata,observed_at=excluded.observed_at`,
      [randomUUID(), snapshot.id, model.id, { ...model.metadata, catalog: 'discovered', source: model.source, residency: model.residency, server_version: serverVersion }, model.capabilities, model.observedAt, snapshot.revision, job.requester_id]);
    }
    await runtime.db.query(`UPDATE models m SET metadata=m.metadata || '{"catalog":"removed"}'::jsonb
      FROM providers p WHERE p.id=m.provider_id AND p.id=$1 AND p.revision=$2 AND p.owner_id=$3
      AND NOT (m.model_id=ANY($4::text[])) AND m.metadata->>'catalog'<>'manual'`, [snapshot.id,snapshot.revision,job.requester_id,models.map(model=>model.id)]);
    await runtime.appendEvent('provider.discovery', { count: models.length, provider_id: snapshot.id, config_revision: snapshot.revision });
    await runtime.complete({ discovered_models: models.length }); return;
  }
  if (job.kind === 'provider.runtime') {
    const observation = await adapter.getRuntimeState(runtime.signal); await runtime.assertLease();
    for (const model of observation.models) await runtime.db.query('INSERT INTO model_observations(provider_id,model_id,kind,value,source,observed_at) VALUES($1,$2,$3,$4,$5,$6)', [snapshot.id,model.id,'residency',{residency:model.residency,loaded_instances:model.loadedInstances,config_revision:snapshot.revision},model.source,observation.observedAt]);
    if (snapshot.adapter==='ollama' || observation.residency==='unknown') {
      await runtime.db.query(`INSERT INTO model_observations(provider_id,model_id,kind,value,source,observed_at)
        SELECT m.provider_id,m.model_id,'residency',$4,$5,$6 FROM models m JOIN providers p ON p.id=m.provider_id
        WHERE m.provider_id=$1 AND p.revision=$2 AND NOT(m.model_id=ANY($3::text[]))`, [snapshot.id,snapshot.revision,observation.models.map(model=>model.id),
        {residency:observation.residency==='known'?'unloaded':'unknown',loaded_instances:[],config_revision:snapshot.revision,reason:observation.reason??null},snapshot.adapter==='ollama'?'/api/ps':'adapter_contract',observation.observedAt]);
    }
    await runtime.complete(observation); return;
  }
  let probeIdentity:{model_digest:string|null;model_variant:string|null;model_instance_config_fingerprint:string|null;server_version:string|null;observed_at:string}|null=null;
  if(job.kind==='provider.probe'){
    const serverVersion=await adapter.getServerVersion?.(runtime.signal).catch(()=>null)??null;
    const catalog=await adapter.discoverModels(runtime.signal).catch(()=>null);
    const selected=catalog?resolveObservedModel(catalog,job.payload.model_id):undefined;
    probeIdentity={model_digest:typeof selected?.metadata.digest==='string'?selected.metadata.digest:null,model_variant:typeof selected?.metadata.variant==='string'?selected.metadata.variant:null,model_instance_config_fingerprint:typeof selected?.metadata.instance_config_fingerprint==='string'?selected.metadata.instance_config_fingerprint:null,server_version:serverVersion,observed_at:new Date().toISOString()};
    if(selected)await runtime.db.query(`INSERT INTO models(id,provider_id,model_id,metadata,capabilities,observed_at)
      SELECT $1,id,$3,$4,$5,$6 FROM providers WHERE id=$2 AND revision=$7 AND owner_id=$8
      ON CONFLICT(provider_id,model_id) DO UPDATE SET metadata=models.metadata || excluded.metadata,observed_at=excluded.observed_at`,
    [randomUUID(),snapshot.id,selected.id,{...selected.metadata,digest:probeIdentity.model_digest,variant:probeIdentity.model_variant,server_version:serverVersion,catalog:'discovered',identity_config_revision:snapshot.revision},selected.capabilities,probeIdentity.observed_at,snapshot.revision,job.requester_id]);
    await runtime.assertLease();
  }
  const previous = await runtime.db.query("SELECT id FROM job_events WHERE job_id=$1 AND type='provider.request.started' LIMIT 1", [job.id]);
  if (previous.rowCount) { await runtime.interrupt('provider_outcome_unknown_no_automatic_replay'); return; }
  if (await runtime.cancelled()) { await runtime.interrupt('provider_request_cancelled_before_dispatch'); return; }
  await runtime.appendEvent('provider.request.started', { provider_id: snapshot.id, config_revision: snapshot.revision, kind: job.kind });
  await runtime.assertLease();
  if (job.kind === 'provider.management') {
    let result:Record<string,unknown>;
    try{result = await adapter.manage(job.payload.action as ManagementAction, { model: job.payload.model_id, instanceId: job.payload.instance_id, jobId: job.payload.download_job_id,
      settings:job.payload.load_settings ? {contextLength:job.payload.load_settings.context_length,evalBatchSize:job.payload.load_settings.eval_batch_size,flashAttention:job.payload.load_settings.flash_attention}:undefined,
      onProgress:async progress=>{await runtime.assertLease();await runtime.appendEvent('provider.download.progress',progress);} }, runtime.signal);}catch(error){
      const known=error instanceof ProviderError&&(error.responseComplete||['invalid-config','unsupported','destination-denied'].includes(error.code)||error.code==='upstream-http'&&[400,401,403,404,422].includes(error.status??0));
      if(known&&runtime.fail){await runtime.fail('provider_management_rejected');return;}throw error;
    }
    const deadline = Date.now() + snapshot.timeoutMs;
    while (result.status === 'downloading' || result.status === 'paused') {
      await runtime.appendEvent('provider.download.progress', result);
      if (!result.job_id || Date.now() >= deadline || await runtime.cancelled()) { await runtime.interrupt('provider_download_stop_unconfirmed'); return; }
      await delay(1000, undefined, { signal: runtime.signal }); await runtime.assertLease();
      result = await adapter.manage('download-status', { jobId: String(result.job_id) }, runtime.signal);
    }
    if (result.status === 'failed') { await runtime.appendEvent('provider.management.failed', {status:'failed'}); if(runtime.fail) await runtime.fail('provider_management_failed'); else await runtime.interrupt('provider_management_failed'); return; }
    await runtime.assertLease(); await runtime.complete(result); return;
  }
  if (job.kind !== 'provider.probe') throw new Error('Unsupported provider job kind');
  const capability = job.payload.capability as string; const nonce = randomUUID().replace(/-/g,'').slice(0,8);
  const schema = { type: 'object', properties: { nonce: { type: 'string', const: nonce } }, required: ['nonce'], additionalProperties: false };
  const request: ChatRequest = { model: job.payload.model_id, messages: [{ role: 'user', content: `Reply with exactly this nonce: ${nonce}` }], maxOutputTokens: 128, thinking:false,...(snapshot.contextLength?{contextLength:snapshot.contextLength}:{}) };
  if (capability === 'tools') {
    request.tools = [{ type: 'function', function: { name: 'echo_nonce', description: 'Echo the provided word.', parameters: {type:'object',properties:{nonce:{type:'string',description:'The word to echo'}},required:['nonce'],additionalProperties:false} } }];
    request.messages[0]!.content = `Use the echo_nonce tool to echo the word ${nonce}. After receiving the result, reply with that word.`;
  }
  if (capability === 'structured_output') { request.jsonSchema = schema; request.messages[0]!.content = `Return a JSON object with nonce equal to ${nonce}.`; }
  const firstColor = Math.random() < 0.5 ? 'red' : 'blue';
  const expectedColors = firstColor === 'red' ? 'red,blue' : 'blue,red';
  if (capability === 'image_input') {
    request.messages[0] = { role:'user',content:'Name the dominant color of the first image, then of the second image. Return only the two lowercase color names separated by a comma.',images:[colorProbeImage(firstColor),colorProbeImage(firstColor==='red'?'blue':'red')] };
  }
  const probeAbort = new AbortController();
  const signal = capability === 'cancellation' ? AbortSignal.any([runtime.signal,probeAbort.signal]) : runtime.signal;
  if (capability === 'cancellation') request.messages[0]!.content = 'Count upwards from one, one number per line, until you reach 100. Do not summarize.';
  let clientStopped = false;
  let text = ''; let textEvents = 0; let final: any = null; let state = 'tested_fail'; let reason = 'expected_nonce_missing';
  try {
    for await (const event of adapter.streamChat(request, { signal })) {
      if (event.type === 'text') { text += event.text; textEvents++; if (capability === 'cancellation') { clientStopped=true; probeAbort.abort(); break; } } else final = event;
    }
    if (capability === 'tools') {
      if (final?.toolCalls?.length !== 1 || final.rejectedToolCalls?.length || final.toolCalls[0].name !== 'echo_nonce' || final.toolCalls[0].arguments.nonce !== nonce) throw new Error('tool_call_missing_or_invalid');
      request.messages.push({ role: 'assistant', content: text, toolCalls: final.toolCalls });
      for (const call of final.toolCalls) request.messages.push({ role: 'tool', content: JSON.stringify({ nonce }), toolCallId: call.id, toolName: call.name });
      text = '';
      for await (const event of adapter.streamChat(request, { signal: runtime.signal })) { if (event.type === 'text') text += event.text; else final = event; }
    }
    let pass = text.includes(nonce);
    if (capability === 'image_input') pass = text.trim().toLowerCase().replace(/\s/g,'') === expectedColors;
    if (capability === 'cancellation') pass = clientStopped;
    if (capability === 'streaming') pass = pass && textEvents > 1;
    if (capability === 'structured_output') { const value = JSON.parse(text); pass = value.nonce === nonce && Object.keys(value).length === 1; }
    if (pass) { state = 'tested_pass'; reason = 'nonce_verified'; }
  } catch (error) {
    if (clientStopped && !runtime.signal.aborted) { state='tested_pass';reason='client_delivery_stop_observed'; }
    else if (runtime.signal.aborted || error instanceof ProviderError && !error.responseComplete && ['interrupted','invalid-response'].includes(error.code)) {
      await runtime.interrupt('provider_outcome_unknown'); return;
    } else reason = 'provider_or_probe_validation_failed';
  }
  await runtime.assertLease();
  await runtime.db.query('INSERT INTO capability_probes(id,owner_id,provider_id,model_id,capability,state,config_revision,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(),job.requester_id,snapshot.id,request.model,capability,state,snapshot.revision,{probe_version:3,reason,requested_model:request.model,resolved_model:final?.resolvedModel??null,...probeIdentity,text_events:textEvents,live_provider:true,metrics:final?.usage??null,...(capability==='image_input'?{fixture:'two_generated_solid_color_pngs',expected:expectedColors,scope:'image_smoke_test_only'}:{}),...(capability==='cancellation'?{client_stop:clientStopped?'observed':'not_observed',provider_stop:'unconfirmed'}:{})}]);
  if (clientStopped) { await runtime.interrupt('client_stop_observed_provider_stop_unconfirmed'); return; }
  await runtime.complete({ capability, state, reason, config_revision: snapshot.revision });
}
