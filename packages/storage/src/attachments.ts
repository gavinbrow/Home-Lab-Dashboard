import type { Pool } from 'pg';
import { BlobStore } from './blobs.js';
import { sniffMime } from './preview.js';

export type RetainedAttachment = { id: string; filename: string; mime_type: string; sha256: string; bytes: Uint8Array };
/** Ownership-checked data only. The provider adapter must still enforce tested image capability. */
export async function loadRetainedAttachments(db: Pool, store: BlobStore, owner: string, ids: string[], conversationId: string): Promise<RetainedAttachment[]> {
  if (ids.length > 8 || new Set(ids).size !== ids.length) throw new Error('attachment_count_limit');
  if (!(await db.query('SELECT id FROM conversations WHERE id=$1 AND owner_id=$2', [conversationId, owner])).rowCount) throw new Error('attachment_conversation_denied');
  if (!ids.length) return [];
  const rows = (await db.query('SELECT * FROM attachments WHERE id=ANY($1::uuid[]) AND owner_id=$2 AND deleted_at IS NULL AND (conversation_id IS NULL OR conversation_id=$3)', [ids, owner, conversationId])).rows;
  if (rows.length !== ids.length) throw new Error('attachment_not_found_or_forbidden');
  const byId = new Map(rows.map(row => [row.id, row]));
  let total = 0;
  const result: RetainedAttachment[] = [];
  for (const id of ids) {
    const row = byId.get(id)!;
    total += Number(row.size_bytes);
    if (Number(row.size_bytes) > 16 * 1024 * 1024 || total > 32 * 1024 * 1024) throw new Error('attachment_context_quota');
    const bytes = await store.get(row.sha256);
    if (bytes.length !== Number(row.size_bytes) || sniffMime(bytes, row.filename) !== row.mime_type) throw new Error('attachment_integrity_failure');
    result.push({ id, filename: row.filename, mime_type: row.mime_type, sha256: row.sha256, bytes });
  }
  return result;
}
