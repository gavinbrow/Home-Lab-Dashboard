import type { FastifyInstance } from 'fastify';
import type { Workspace, Checkpoint } from '@homelab/contracts';
import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { relativePath, sha256, withWorkspaceWriter, type WorkspaceFileAdapter } from '@homelab/storage';
import type { ApiContext } from '../../core/context.js';

const Id = z.uuid(), Hash = z.string().regex(/^[a-f0-9]{64}$/), CHUNK = 1048576;
function fail(code: string, statusCode = 409): never { throw Object.assign(new Error(code), { code, statusCode }); }
function childId(value: string) { const h = createHash('sha256').update(value).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`; }
export async function registerTransfers(app: FastifyInstance, context: ApiContext, deps: {
  workspace(owner: string,id: string): Promise<Workspace>;
  grant(owner: string,id: string,ws: Workspace,tool: string): Promise<unknown>;
  adapter(grant?: string,tool?: string): WorkspaceFileAdapter;
  capture(ws: Workspace,reason: string,snapshot?: undefined,grant?: string,tool?: string): Promise<Checkpoint>;
}) {
  async function session(owner: string, ws: Workspace, id: string) {
    const row = (await context.db.query('SELECT * FROM upload_sessions WHERE id=$1 AND owner_id=$2 AND workspace_id=$3',[Id.parse(id),owner,ws.id])).rows[0];
    if (!row) fail('upload_not_found',404);
    return row;
  }
  async function status(row: Record<string, any>) {
    const chunks = (await context.db.query('SELECT "offset",size_bytes,sha256 FROM upload_chunks WHERE session_id=$1 ORDER BY "offset"',[row.id])).rows;
    let contiguous = 0; for (const part of chunks) { if (Number(part.offset) !== contiguous) break; contiguous += Number(part.size_bytes); }
    return { id:row.id,upload_id:row.id,path:row.path,state:row.state,commit_operation_id:row.commit_operation_id??null,total_bytes:Number(row.total_bytes),received_bytes:contiguous,received_ranges:chunks.map(c=>({offset:Number(c.offset),size_bytes:Number(c.size_bytes),sha256:c.sha256})),sha256:row.target_sha256,chunk_bytes:CHUNK,expires_at:row.expires_at };
  }
  app.post<{Params:{id:string}}>('/projects/:id/uploads',async request=>{
    const body=z.object({operation_id:Id,grant_id:Id,path:z.string(),total_bytes:z.number().int().min(0).max(1073741824),sha256:Hash,expected_sha256:Hash.nullable()}).parse(request.body);
    relativePath(body.path); const ws=await deps.workspace(request.actor!.id,request.params.id);
    await deps.grant(request.actor!.id,body.grant_id,ws,'file.write');
    if(body.total_bytes>ws.quota_bytes) fail('upload_quota_exceeded',413);
    const files=deps.adapter(body.grant_id,'file.write'); if(!files.beginUpload) fail('capability_unavailable',503);
    const result=await context.db.query("INSERT INTO upload_sessions(id,owner_id,workspace_id,path,expected_sha256,target_sha256,total_bytes,grant_id,operation_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$1,now()+interval '24 hours') ON CONFLICT(id) DO NOTHING RETURNING *",[body.operation_id,request.actor!.id,ws.id,body.path,body.expected_sha256,body.sha256,body.total_bytes,body.grant_id]);
    const row=result.rows[0]??await session(request.actor!.id,ws,body.operation_id);
    if(Date.parse(row.expires_at)<Date.now())fail('upload_expired');
    if(row.path!==body.path||row.expected_sha256!==body.expected_sha256||row.target_sha256!==body.sha256||Number(row.total_bytes)!==body.total_bytes||row.grant_id!==body.grant_id) fail('idempotency_conflict');
    if(row.state==='uploading') await files.beginUpload(ws,{upload_id:row.id,path:row.path,total_bytes:Number(row.total_bytes),sha256:row.target_sha256,expected_sha256:row.expected_sha256},{operation_id:body.operation_id,scope_grant_id:body.grant_id});
    return status(row);
  });
  app.get<{Params:{id:string;uploadId:string}}>('/projects/:id/uploads/:uploadId',async request=>{
    const q=z.object({grant_id:Id}).parse(request.query),ws=await deps.workspace(request.actor!.id,request.params.id);
    await deps.grant(request.actor!.id,q.grant_id,ws,'file.write');
    return status(await session(request.actor!.id,ws,request.params.uploadId));
  });
  app.put<{Params:{id:string;uploadId:string}}>('/projects/:id/uploads/:uploadId/chunks',async request=>{
    const b=z.object({grant_id:Id,offset:z.number().int().min(0),content_base64:z.string().max(1398104),sha256:Hash}).parse(request.body);
    const ws=await deps.workspace(request.actor!.id,request.params.id);await deps.grant(request.actor!.id,b.grant_id,ws,'file.write');
    const row=await session(request.actor!.id,ws,request.params.uploadId), bytes=Buffer.from(b.content_base64,'base64');
    if(row.state!=='uploading'||Date.parse(row.expires_at)<Date.now()) fail('upload_inactive');
    if(bytes.toString('base64')!==b.content_base64||sha256(bytes)!==b.sha256||b.offset%CHUNK!==0||bytes.length!==Math.min(CHUNK,Number(row.total_bytes)-b.offset)||!bytes.length) fail('invalid_upload_chunk',400);
    const files=deps.adapter(b.grant_id,'file.write');if(!files.uploadChunk) fail('capability_unavailable',503);
    await files.uploadChunk(ws,row.id,{offset:b.offset,bytes,sha256:b.sha256},{operation_id:childId(`${row.id}:${b.offset}:${b.sha256}`),scope_grant_id:b.grant_id});
    const old=(await context.db.query('INSERT INTO upload_chunks(session_id,"offset",size_bytes,sha256) VALUES($1,$2,$3,$4) ON CONFLICT(session_id,"offset") DO UPDATE SET sha256=upload_chunks.sha256 RETURNING sha256,size_bytes',[row.id,b.offset,bytes.length,b.sha256])).rows[0];
    if(old.sha256!==b.sha256||Number(old.size_bytes)!==bytes.length) fail('idempotency_conflict');
    return status(row);
  });
  app.post<{Params:{id:string;uploadId:string}}>('/projects/:id/uploads/:uploadId/complete',async request=>{
    const b=z.object({operation_id:Id,grant_id:Id}).parse(request.body),ws=await deps.workspace(request.actor!.id,request.params.id);
    await deps.grant(request.actor!.id,b.grant_id,ws,'file.write');const row=await session(request.actor!.id,ws,request.params.uploadId);
    if(row.commit_operation_id&&row.commit_operation_id!==b.operation_id) fail('idempotency_conflict');
    if(row.state==='completed') return {state:'completed',upload_id:row.id,sha256:row.target_sha256,size_bytes:Number(row.total_bytes)};
    if(!['uploading','committing','outcome_unknown'].includes(row.state)||(await status(row)).received_bytes!==Number(row.total_bytes)) fail('upload_incomplete');
    const claimed=await context.db.query("UPDATE upload_sessions SET commit_operation_id=$2,state='committing' WHERE id=$1 AND (commit_operation_id IS NULL OR commit_operation_id=$2) RETURNING id",[row.id,b.operation_id]);if(!claimed.rowCount) fail('idempotency_conflict');
    const files=deps.adapter(b.grant_id,'file.write');if(!files.completeUpload) fail('capability_unavailable',503);
    return withWorkspaceWriter(context.db,ws,request.actor!.id,'upload.complete',async mutation=>{
      await deps.capture(ws,`pre-upload:${b.operation_id}`,undefined,b.grant_id,'file.write');
      try {
        const receipt=await files.completeUpload!(ws,row.id,{...mutation,scope_grant_id:b.grant_id});
        const result=receipt.result as {sha256?:string;size_bytes?:number};
        if(result.sha256!==row.target_sha256||result.size_bytes!==Number(row.total_bytes)) fail('host_upload_verification_failed');
        await context.db.query("UPDATE upload_sessions SET state='completed',received_bytes=total_bytes WHERE id=$1",[row.id]);
        await context.audit(request.actor!.id,'file.upload',ws.id,'completed',{upload_id:row.id,operation_id:b.operation_id,path:row.path,sha256:row.target_sha256});
        return {state:'completed',upload_id:row.id,...result};
      }catch(error){await context.db.query('UPDATE upload_sessions SET state=$2 WHERE id=$1',[row.id,(error as {code?:string}).code==='content_conflict'?'failed':'outcome_unknown']);throw error;}
    },{operationId:b.operation_id});
  });
  app.delete<{Params:{id:string;uploadId:string}}>('/projects/:id/uploads/:uploadId',async request=>{
    const b=z.object({operation_id:Id,grant_id:Id.optional()}).parse(request.body),ws=await deps.workspace(request.actor!.id,request.params.id),row=await session(request.actor!.id,ws,request.params.uploadId);
    if(!['uploading','cancelled','failed'].includes(row.state)) fail('upload_publication_requires_reconciliation');
    const files=deps.adapter();if(!files.cancelUpload) fail('capability_unavailable',503);
    await files.cancelUpload(ws,row.id,{operation_id:b.operation_id});
    await context.db.query("UPDATE upload_sessions SET state='cancelled' WHERE id=$1 AND state IN ('uploading','failed')",[row.id]);return {id:row.id,state:'cancelled'};
  });
  app.get<{Params:{id:string}}>('/projects/:id/files/metadata',async request=>{
    const q=z.object({path:z.string(),grant_id:Id}).parse(request.query),ws=await deps.workspace(request.actor!.id,request.params.id);relativePath(q.path);await deps.grant(request.actor!.id,q.grant_id,ws,'file.read');
    const files=deps.adapter(q.grant_id,'file.read');if(!files.manifest) fail('capability_unavailable',503);const source=await files.manifest(ws);
    const entry=source.manifest.find(e=>e.path===q.path);if(!entry||entry.kind!=='file') fail('file_not_found',404);return {...entry,total_bytes:entry.size_bytes};
  });
  app.get<{Params:{id:string}}>('/projects/:id/files/range',async request=>{
    const q=z.object({path:z.string(),grant_id:Id,offset:z.coerce.number().int().min(0),length:z.coerce.number().int().min(1).max(CHUNK)}).parse(request.query),ws=await deps.workspace(request.actor!.id,request.params.id);relativePath(q.path);await deps.grant(request.actor!.id,q.grant_id,ws,'file.read');
    const files=deps.adapter(q.grant_id,'file.read');if(!files.readRange) fail('capability_unavailable',503);const {bytes,...meta}=await files.readRange(ws,q.path,q.offset,q.length);return {...meta,content_base64:Buffer.from(bytes).toString('base64')};
  });
}

