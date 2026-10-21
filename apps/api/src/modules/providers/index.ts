import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createTransport, normalizeEndpoint,evaluateProbeValidity, type ProviderSnapshot } from '@homelab/providers';
import type { ApiContext } from '../../core/context.js';
import { submitJob } from '@homelab/worker';

const configSchema = z.object({ allowed_addresses: z.array(z.string().max(64)).min(1).max(32), allow_private_http: z.boolean().default(false), timeout_ms: z.number().int().min(1).max(3_600_000).default(120_000), private_ca_pem: z.string().min(1).max(131072).optional(),max_model_concurrency:z.number().int().min(1).max(128).default(1),context_length:z.number().int().min(256).max(4194304).optional(),observation_max_age_seconds:z.number().int().min(15).max(86400).default(300) });
const providerSchema = z.object({ name: z.string().trim().min(1).max(120), adapter: z.enum(['openai-compatible', 'ollama', 'lm-studio', 'vllm']), endpoint: z.string().url().max(2000), runtime_pool_id: z.string().uuid().optional(), routing_classification: z.enum(['local','remote','unknown']).default('unknown'), config: configSchema, credential: z.string().min(1).max(16_384).optional(), revision: z.number().int().positive().optional() });
const publicColumns = 'id,name,adapter,endpoint,revision,runtime_pool_id,routing_classification,config,credential_ref IS NOT NULL AS credential_configured,created_at,updated_at';
export function providerSnapshot(row: any): ProviderSnapshot {
  const config = configSchema.parse(row.config);
  return { id: row.id, revision: row.revision, adapter: row.adapter, baseUrl: row.endpoint, runtimePoolId: row.runtime_pool_id,
    ...(row.credential_ref ? { credentialRef: row.credential_ref } : {}), routing: row.routing_classification,
    allowedAddresses: config.allowed_addresses, allowPrivateHttp: config.allow_private_http, timeoutMs: config.timeout_ms,maxModelConcurrency:config.max_model_concurrency,
    ...(config.private_ca_pem ? { privateCaPem: config.private_ca_pem } : {}),...(config.context_length?{contextLength:config.context_length}:{}) };
}
export default async function register(app: FastifyInstance, context: ApiContext): Promise<void> {
  app.get('/provider-runtime-pools',async request=>({items:(await context.db.query('SELECT id,name,max_concurrency,max_queue FROM provider_runtime_pools WHERE owner_id=$1 ORDER BY name',[request.actor!.id])).rows}));
  app.put('/provider-runtime-pools/:id',async(request,reply)=>{
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const input=z.object({name:z.string().trim().min(1).max(120),max_concurrency:z.number().int().min(1).max(128),max_queue:z.number().int().min(0).max(10000)}).parse(request.body);
    const client=await context.db.connect();
    try{
      await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`provider:${id}`]);
      const updated=await client.query('UPDATE provider_runtime_pools SET name=$3,max_concurrency=$4,max_queue=$5 WHERE id=$1 AND owner_id=$2 RETURNING id,name,max_concurrency,max_queue',[id,request.actor!.id,input.name,input.max_concurrency,input.max_queue]);
      if(!updated.rowCount)return reply.code(404).send({error:{code:'not_found',message:'Runtime pool not found'}});
      await client.query('INSERT INTO audit_events(actor_id,action,target,outcome) VALUES($1,$2,$3,$4)',[request.actor!.id,'provider.pool.update',id,'success']);await client.query('COMMIT');return updated.rows[0];
    }catch(error){await client.query('ROLLBACK');throw error;}finally{await client.query('ROLLBACK');client.release();}
  });
  for (const [suffix, kind] of [['discover','provider.discovery'],['runtime','provider.runtime'],['connection-tests','provider.connectivity'],['capability-tests','provider.probe'],['management','provider.management']] as const) {
    app.post(`/providers/:id/${suffix}`, async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const input = z.object({ idempotency_key: z.string().min(1).max(200), model_id: z.string().min(1).max(500).optional(), capability: z.enum(['basic_chat','streaming','tools','structured_output','image_input','cancellation']).optional(), action: z.enum(['load','unload','download','download-status']).optional(), instance_id: z.string().max(500).optional(), download_job_id: z.string().max(500).optional(), load_settings:z.object({context_length:z.number().int().min(1).max(4194304).optional(),eval_batch_size:z.number().int().min(1).max(65536).optional(),flash_attention:z.boolean().optional()}).optional() }).parse(request.body);
      const row = (await context.db.query('SELECT * FROM providers WHERE id=$1 AND owner_id=$2', [id, request.actor!.id])).rows[0];
      if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'Provider not found' } });
      if (kind === 'provider.probe' && (!input.model_id || !input.capability)) return reply.code(400).send({ error: { code: 'invalid_probe', message: 'Select an exact model and capability test' } });
      if (kind === 'provider.management' && !input.action) return reply.code(400).send({ error: { code: 'invalid_management', message: 'Select an explicit management action' } });
      if(kind==='provider.management'&&input.action!=='download-status'&&!input.model_id)return reply.code(400).send({error:{code:'model_required',message:'Select the exact catalog model for this management action'}});
      if(kind==='provider.management'&&input.action==='unload'&&row.adapter==='lm-studio'&&!input.instance_id)return reply.code(400).send({error:{code:'instance_required',message:'Select the observed loaded instance to unload'}});
      if(kind==='provider.management'&&input.action==='download-status'&&!input.download_job_id)return reply.code(400).send({error:{code:'download_job_required',message:'Select the provider download job to inspect'}});
      if (kind === 'provider.management' && !['lm-studio','ollama'].includes(row.adapter)) return reply.code(422).send({ error: { code: 'unsupported', message: 'Management is unavailable for this adapter version' } });
      const { idempotency_key, ...parameters } = input;
      const job = await submitJob(context.db, { requester_id: request.actor!.id, idempotency_key, context: null, kind,
        payload: { provider: providerSnapshot(row), ...parameters }, modifies_workspace: false });
      await context.audit(request.actor!.id, kind, id, 'queued'); return reply.code(202).send({ job_id: job.id, state: job.state });
    });
  }
  app.get('/providers', async request => ({ items: (await context.db.query(`SELECT ${publicColumns} FROM providers WHERE owner_id=$1 ORDER BY name LIMIT 500`, [request.actor!.id])).rows }));
  app.get('/providers/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await context.db.query(`SELECT ${publicColumns} FROM providers WHERE id=$1 AND owner_id=$2`, [id, request.actor!.id]);
    return result.rows[0] ?? reply.code(404).send({ error: { code: 'not_found', message: 'Provider not found' } });
  });
  app.post('/providers', async (request, reply) => {
    const input = providerSchema.parse(request.body); const actor = request.actor!.id;
    const endpoint = normalizeEndpoint(input.endpoint).href.replace(/\/$/, ''); const id = randomUUID();
    createTransport(providerSnapshot({ ...input, id, endpoint, revision: 1, runtime_pool_id: input.runtime_pool_id ?? id }), async () => '');
    const client = await context.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`provider:${actor}:${new URL(endpoint).origin}`]);
      let pool = input.runtime_pool_id;
      if (pool) {
        const result = await client.query('SELECT id FROM provider_runtime_pools WHERE id=$1 AND owner_id=$2', [pool, actor]);
        if (!result.rowCount) return reply.code(400).send({ error: { code: 'invalid_pool', message: 'Runtime pool is not owned by this actor' } });
      } else { pool = randomUUID(); await client.query('INSERT INTO provider_runtime_pools(id,owner_id,name) VALUES($1,$2,$3)', [pool, actor, input.name]); }
      // Reuse the existing endpoint pool so creating another alias cannot bypass capacity.
      const same = await client.query("SELECT runtime_pool_id FROM providers WHERE owner_id=$1 AND regexp_replace(endpoint,'/v1/?$','')=$2 LIMIT 1", [actor, new URL(endpoint).origin]);
      if (same.rows[0]) pool = same.rows[0].runtime_pool_id;
      const secret = input.credential ? await context.secrets.put(actor, `Provider ${id}`, input.credential) : null;
      const result = await client.query(`INSERT INTO providers(id,owner_id,name,adapter,endpoint,credential_ref,runtime_pool_id,routing_classification,config) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${publicColumns}`, [id, actor, input.name, input.adapter, endpoint, secret, pool, input.routing_classification, input.config]);
      await client.query('INSERT INTO audit_events(actor_id,action,target,outcome) VALUES($1,$2,$3,$4)', [actor, 'provider.create', id, 'success']);
      await client.query('COMMIT'); return reply.code(201).send(result.rows[0]);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { await client.query('ROLLBACK'); client.release(); }
  });
  app.put('/providers/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params); const input = providerSchema.parse(request.body); const actor = request.actor!.id;
    if (!input.revision) return reply.code(400).send({ error: { code: 'revision_required', message: 'Current configuration revision is required' } });
    const endpoint = normalizeEndpoint(input.endpoint).href.replace(/\/$/, '');
    createTransport(providerSnapshot({ ...input, id, endpoint, runtime_pool_id: input.runtime_pool_id ?? id }), async () => '');
    const old = await context.db.query('SELECT * FROM providers WHERE id=$1 AND owner_id=$2', [id, actor]);
    if (!old.rows[0]) return reply.code(404).send({ error: { code: 'not_found', message: 'Provider not found' } });
    let pool = input.runtime_pool_id ?? old.rows[0].runtime_pool_id;
    if (!(await context.db.query('SELECT id FROM provider_runtime_pools WHERE id=$1 AND owner_id=$2', [pool, actor])).rowCount) return reply.code(400).send({ error: { code: 'invalid_pool', message: 'Runtime pool not found' } });
    const secret = input.credential ? await context.secrets.put(actor, `Provider ${id}`, input.credential) : old.rows[0].credential_ref;
    const client = await context.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`provider:${actor}:${new URL(endpoint).origin}`]);
      const same = await client.query("SELECT runtime_pool_id FROM providers WHERE owner_id=$1 AND regexp_replace(endpoint,'/v1/?$','')=$2 AND id<>$3 LIMIT 1", [actor, new URL(endpoint).origin, id]);
      if (same.rows[0]) pool = same.rows[0].runtime_pool_id;
      const result = await client.query(`UPDATE providers SET name=$3,adapter=$4,endpoint=$5,credential_ref=$6,runtime_pool_id=$7,routing_classification=$8,config=$9,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2 AND revision=$10 RETURNING ${publicColumns}`, [id, actor, input.name, input.adapter, endpoint, secret, pool, input.routing_classification, input.config, input.revision]);
      if (!result.rowCount) return reply.code(409).send({ error: { code: 'revision_conflict', message: 'Provider configuration changed; reload before saving' } });
      await client.query('INSERT INTO audit_events(actor_id,action,target,outcome) VALUES($1,$2,$3,$4)', [actor, 'provider.update', id, 'success']);
      await client.query('COMMIT'); return result.rows[0];
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { await client.query('ROLLBACK'); client.release(); }
  });
  app.get('/models', async request => ({ items: (await context.db.query(`SELECT m.*,p.name AS provider_name,p.routing_classification,
    EXTRACT(EPOCH FROM now()-m.observed_at)::double precision AS observed_age_seconds,
    now()-m.observed_at>COALESCE((p.config->>'observation_max_age_seconds')::integer,300)*interval '1 second' AS catalog_stale,
    EXISTS(SELECT 1 FROM model_favorites f WHERE f.owner_id=$1 AND f.provider_id=m.provider_id AND f.model_id=m.model_id) AS favorite FROM models m JOIN providers p ON p.id=m.provider_id WHERE p.owner_id=$1 ORDER BY p.name,m.model_id LIMIT 1000`, [request.actor!.id])).rows }));
  app.get('/providers/:id/models', async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return { items: (await context.db.query(`SELECT m.*,EXTRACT(EPOCH FROM now()-m.observed_at)::double precision AS observed_age_seconds,
      now()-m.observed_at>COALESCE((p.config->>'observation_max_age_seconds')::integer,300)*interval '1 second' AS catalog_stale,
      EXISTS(SELECT 1 FROM model_favorites f WHERE f.owner_id=$2 AND f.provider_id=m.provider_id AND f.model_id=m.model_id) AS favorite FROM models m JOIN providers p ON p.id=m.provider_id WHERE p.id=$1 AND p.owner_id=$2 ORDER BY m.model_id LIMIT 1000`, [id, request.actor!.id])).rows };
  });
  app.get('/providers/:id/capability-tests', async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const rows=(await context.db.query(`SELECT DISTINCT ON(c.model_id,c.capability) c.*,p.revision AS current_revision,m.metadata AS current_metadata,m.observed_at AS identity_observed_at
      FROM capability_probes c JOIN providers p ON p.id=c.provider_id LEFT JOIN models m ON m.provider_id=p.id AND m.model_id=c.model_id
      WHERE p.id=$1 AND p.owner_id=$2 ORDER BY c.model_id,c.capability,c.created_at DESC,c.id DESC LIMIT 1000`,[id,request.actor!.id])).rows;
    return{items:rows.map(row=>{const{current_revision,current_metadata,identity_observed_at,...probe}=row;const validity=evaluateProbeValidity(probe,{revision:current_revision,metadata:current_metadata,observed_at:identity_observed_at});return{...probe,stale:validity.state==='stale',effective_state:validity.state,validity};})};
  });
  app.get('/providers/:id/observations', async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return { items: (await context.db.query(`SELECT DISTINCT ON(o.model_id,o.kind) o.*,
      EXTRACT(EPOCH FROM now()-o.observed_at)::double precision AS observed_age_seconds,
      (o.value->>'config_revision') IS DISTINCT FROM p.revision::text OR now()-o.observed_at>COALESCE((p.config->>'observation_max_age_seconds')::integer,300)*interval '1 second' AS stale
      FROM model_observations o JOIN providers p ON p.id=o.provider_id
      WHERE p.id=$1 AND p.owner_id=$2 ORDER BY o.model_id,o.kind,o.observed_at DESC LIMIT 1000`, [id, request.actor!.id])).rows };
  });
  app.get('/providers/:id/activity',async(request,reply)=>{
    const{id}=z.object({id:z.string().uuid()}).parse(request.params);const actor=request.actor!.id;
    const provider=(await context.db.query('SELECT runtime_pool_id FROM providers WHERE id=$1 AND owner_id=$2',[id,actor])).rows[0];
    if(!provider)return reply.code(404).send({error:{code:'not_found',message:'Provider not found'}});
    const pool=provider.runtime_pool_id;
    const reservations=(await context.db.query("SELECT COUNT(*) FILTER(WHERE state='held')::int AS dashboard_reserved_slots,COUNT(*) FILTER(WHERE state='uncertain')::int AS dashboard_uncertain_slots FROM resource_reservations WHERE resource_type='provider' AND resource_id=$1",[pool])).rows[0];
    const queued=(await context.db.query(`SELECT COUNT(*)::int AS count FROM jobs j WHERE j.requester_id=$1 AND j.state IN('queued','waiting')
      AND COALESCE(j.payload->'provider_snapshot'->>'runtimePoolId',j.payload->'provider'->>'runtimePoolId')=$2
      AND NOT EXISTS(SELECT 1 FROM resource_reservations r WHERE r.job_id=j.id AND r.resource_type='provider' AND r.state IN('held','uncertain'))`,[actor,pool])).rows[0];
    return{...reservations,dashboard_queued_jobs:queued.count,provider_active_requests:null,runtime_pool_id:pool,observed_at:new Date().toISOString(),source:'dashboard_postgresql_ledger',external_activity:'unknown'};
  });
  app.get('/providers/:id/performance',async request=>{
    const{id}=z.object({id:z.string().uuid()}).parse(request.params);
    return{items:(await context.db.query(`SELECT i.id,i.job_id,i.model_id,i.state,i.metrics,i.created_at,i.completed_at FROM inference_requests i JOIN providers p ON p.id=i.provider_id
      WHERE p.id=$1 AND p.owner_id=$2 ORDER BY i.created_at DESC LIMIT 100`,[id,request.actor!.id])).rows};
  });
  app.post('/providers/:id/models/manual', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params); const input = z.object({ model_id: z.string().min(1).max(500) }).parse(request.body);
    const result = await context.db.query("INSERT INTO models(id,provider_id,model_id,metadata,capabilities) SELECT $1,id,$3,'{\"catalog\":\"manual\",\"residency\":\"unknown\"}'::jsonb,'{}'::jsonb FROM providers WHERE id=$2 AND owner_id=$4 ON CONFLICT(provider_id,model_id) DO UPDATE SET model_id=excluded.model_id RETURNING *", [randomUUID(), id, input.model_id, request.actor!.id]);
    if (!result.rowCount) return reply.code(404).send({ error: { code: 'not_found', message: 'Provider not found' } });
    await context.audit(request.actor!.id, 'model.register', id, 'success'); return reply.code(201).send(result.rows[0]);
  });
  app.put('/providers/:id/favorites', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params); const input = z.object({ model_id: z.string().min(1).max(500), favorite: z.boolean() }).parse(request.body); const actor = request.actor!.id;
    if (!(await context.db.query('SELECT id FROM providers WHERE id=$1 AND owner_id=$2', [id, actor])).rowCount) return reply.code(404).send({ error: { code: 'not_found', message: 'Provider not found' } });
    if (input.favorite) await context.db.query('INSERT INTO model_favorites(owner_id,provider_id,model_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [actor,id,input.model_id]);
    else await context.db.query('DELETE FROM model_favorites WHERE owner_id=$1 AND provider_id=$2 AND model_id=$3', [actor,id,input.model_id]);
    await context.audit(actor, 'model.favorite', id, 'success'); return { model_id: input.model_id, favorite: input.favorite };
  });
}
