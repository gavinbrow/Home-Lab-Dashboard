import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {z} from 'zod';
const absolute=z.string().min(1).max(4096).refine(isAbsolute,'Absolute configured path required');
export const destinationConfigSchema=z.object({schema_version:z.literal(1),destinations:z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),z.object({
 label:z.string().min(1).max(200),repository:z.string().min(1).max(4096),password_file:absolute,
 staging_root:absolute,key_root:absolute,ca_root:absolute,separate_device:z.boolean().default(false),
}).strict())}).strict();
export type DestinationConfig=z.infer<typeof destinationConfigSchema>['destinations'][string];
export async function configuredDestinations(){
 if(!process.env.BACKUP_DESTINATIONS_FILE)return null;
 return destinationConfigSchema.parse(JSON.parse(await readFile(process.env.BACKUP_DESTINATIONS_FILE,'utf8')));
}
export function publicRun(row:Record<string,any>){
 const manifest=row.manifest??{};
 return {id:row.id,job_id:row.job_id,status:row.status,created_at:row.created_at,started_at:row.started_at,completed_at:row.completed_at,
  manifest:{schema_version:1,phase:manifest.phase??'unknown',coverage:manifest.coverage??'unknown',encrypted:manifest.encrypted===true,
   repository_read_check:manifest.repository_read_check??'NOT RUN',restore_drill:manifest.restore_drill??'NOT RUN',
   components:(manifest.components??[]).map((item:any)=>({id:item.id,kind:item.kind,status:item.status??(item.consistent===true?'captured':'incomplete'),workspace_id:item.workspace_id,workspace_ids:item.workspace_ids,machine_id:item.machine_id,consistency:item.consistency??(item.consistent===true?'quiesced':'best_effort'),encrypted:item.encrypted===true,covers_journal:item.covers_journal===true})),
   gaps:(manifest.gaps??[]).map((item:any)=>typeof item==='string'?{code:item}:{code:item.code,workspace_id:item.workspace_id,machine_id:item.machine_id}),
   snapshot_id:manifest.snapshot_id??null,backup_set_id:manifest.backup_set_id??null}};
}
