import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BlobStore, sniffMime, sha256 } from '@homelab/storage';
import type { ApiContext } from '../../core/context.js';

function failure(code: string, message: string, statusCode = 400): never { throw Object.assign(new Error(message), { code, statusCode }); }
const Id = z.uuid();
export async function registerAttachments(app: FastifyInstance, context: ApiContext, store: BlobStore): Promise<void> {
  async function owns(owner: string, conversationId?: string, workspaceId?: string) {
    if (conversationId && !(await context.db.query('SELECT id FROM conversations WHERE id=$1 AND owner_id=$2', [conversationId, owner])).rowCount) failure('not_found', 'Conversation not found.', 404);
    if (workspaceId && !(await context.db.query('SELECT id FROM workspaces WHERE id=$1 AND owner_id=$2', [workspaceId, owner])).rowCount) failure('not_found', 'Workspace not found.', 404);
  }
  app.post('/attachments', { bodyLimit: 24 * 1024 * 1024 }, async request => {
    const body = z.object({ filename: z.string().min(1).max(240).regex(/^[^\x00-\x1f\x7f/\\]+$/u), content_base64: z.string().max(24 * 1024 * 1024), conversation_id: Id.optional(), workspace_id: Id.optional(), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).parse(request.body);
    const owner = request.actor!.id;
    await owns(owner, body.conversation_id, body.workspace_id);
    const bytes = Buffer.from(body.content_base64, 'base64');
    if (bytes.toString('base64') !== body.content_base64) failure('invalid_base64', 'Upload canonical base64 bytes.');
    if (bytes.byteLength > 16 * 1024 * 1024) failure('attachment_too_large', 'Attachment exceeds 16 MiB.', 413);
    if (body.expected_sha256 && sha256(bytes) !== body.expected_sha256) failure('checksum_mismatch', 'Attachment bytes do not match the supplied hash.', 409);
    const mime = sniffMime(bytes, body.filename);
    let blob: { hash: string; size: number };
    const id = randomUUID();
    const client = await context.db.connect();
    let result;
    try {
      await client.query('BEGIN');
      const control=(await client.query('SELECT maintenance_mode,restore_mode FROM runtime_control WHERE singleton=true FOR SHARE')).rows[0];
      if(!control||control.maintenance_mode||control.restore_mode)failure('maintenance_mode','Attachment publication is unavailable during maintenance or restore.',409);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`attachment:${owner}`]);
      // Soft deletion retains immutable bytes for job/history references, so it
      // cannot free quota until reference-aware GC actually removes the data.
      const usage = (await client.query('SELECT COALESCE(SUM(size_bytes),0) AS bytes,COUNT(*) AS count FROM attachments WHERE owner_id=$1', [owner])).rows[0];
      if (Number(usage.bytes) + bytes.byteLength > 512 * 1024 * 1024 || Number(usage.count) >= 1000) failure('attachment_quota_exceeded', 'Retained attachments exceed the owner quota.', 413);
      blob = await store.put(bytes, body.expected_sha256,client);
      result = (await client.query('INSERT INTO attachments(id,owner_id,conversation_id,workspace_id,filename,mime_type,size_bytes,sha256,storage_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *', [id, owner, body.conversation_id ?? null, body.workspace_id ?? null, body.filename, mime, blob.size, blob.hash])).rows[0];
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    await context.audit(owner, 'attachment.upload', id, 'completed', { sha256: blob.hash, size_bytes: blob.size, mime_type: mime });
    return { ...result, size_bytes: Number(result.size_bytes), download_url: `/api/v1/attachments/${id}/download` };
  });
  app.get('/attachments', async request => {
    const query = z.object({ conversation_id: Id.optional(), workspace_id: Id.optional(),include_deleted:z.enum(['true','false']).default('false') }).parse(request.query);
    await owns(request.actor!.id, query.conversation_id, query.workspace_id);
    const result = await context.db.query('SELECT * FROM attachments WHERE owner_id=$1 AND ($4::boolean OR deleted_at IS NULL) AND ($2::uuid IS NULL OR conversation_id=$2) AND ($3::uuid IS NULL OR workspace_id=$3) ORDER BY created_at DESC LIMIT 100', [request.actor!.id, query.conversation_id ?? null, query.workspace_id ?? null,query.include_deleted==='true']);
    return { items: result.rows.map(row => ({ ...row, size_bytes: Number(row.size_bytes), download_url: `/api/v1/attachments/${row.id}/download` })) };
  });
  app.get<{ Params: { id: string } }>('/attachments/:id/download', async (request, reply) => {
    const row = (await context.db.query('SELECT * FROM attachments WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL', [Id.parse(request.params.id), request.actor!.id])).rows[0];
    if (!row) failure('not_found', 'Attachment not found.', 404);
    const bytes = await store.get(row.sha256);
    reply.header('Content-Type', 'application/octet-stream').header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, no-store').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`);
    return reply.send(bytes);
  });
  app.delete<{ Params: { id: string } }>('/attachments/:id', async request => {
    const client=await context.db.connect();
    try{await client.query('BEGIN');const control=(await client.query('SELECT maintenance_mode,restore_mode FROM runtime_control WHERE singleton=true FOR SHARE')).rows[0];if(!control||control.maintenance_mode||control.restore_mode)failure('maintenance_mode','Attachment changes are unavailable during maintenance or restore.',409);
      const result = await client.query('UPDATE attachments SET deleted_at=COALESCE(deleted_at,now()) WHERE id=$1 AND owner_id=$2 RETURNING id', [Id.parse(request.params.id), request.actor!.id]);
      if (!result.rowCount) failure('not_found', 'Attachment not found.', 404);
      await client.query('INSERT INTO audit_events(actor_id,action,target,outcome,details)VALUES($1,$2,$3,$4,$5::jsonb)',[request.actor!.id,'attachment.delete',request.params.id,'completed',JSON.stringify({immutable_blob_retained_until_reference_aware_gc:true})]);await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    return { id: request.params.id, deleted: true };
  });
  app.delete<{Params:{id:string}}>('/attachments/:id/purge',async request=>{
    if(request.actor?.role!=='owner')failure('ownership_denied','Owner authorization is required.',403);
    const b=z.object({confirm:z.literal(true),expected_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.body);
    const client=await context.db.connect();let referenced=false;
    try{await client.query('BEGIN');const control=(await client.query('SELECT maintenance_mode,restore_mode FROM runtime_control WHERE singleton=true FOR SHARE')).rows[0];if(!control||control.maintenance_mode||control.restore_mode)failure('maintenance_mode','Retention changes are unavailable during maintenance or restore.',409);
      const row=(await client.query('SELECT * FROM attachments WHERE id=$1 AND owner_id=$2 FOR UPDATE',[Id.parse(request.params.id),request.actor.id])).rows[0];
      if(!row)failure('not_found','Attachment not found.',404);if(!row.deleted_at||row.sha256!==b.expected_sha256)failure('content_conflict','Soft-delete and review this exact attachment before removing library metadata.',409);
      await client.query('DELETE FROM attachments WHERE id=$1',[row.id]);referenced=!!(await client.query('SELECT 1 FROM blob_references WHERE hash=$1 LIMIT 1',[row.sha256])).rowCount;
      await client.query('INSERT INTO audit_events(actor_id,action,target,outcome,details)VALUES($1,$2,$3,$4,$5::jsonb)',[request.actor.id,'attachment.purge',row.id,'completed',JSON.stringify({sha256:row.sha256,other_references_retained:referenced})]);await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    return {id:request.params.id,library_metadata_removed:true,other_references_retained:referenced,bytes:'Retained by frozen history and queued work, or eligible after garbage collection grace periods.'};
  });
}
