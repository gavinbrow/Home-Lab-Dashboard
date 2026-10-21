import type { Pool } from 'pg';
import {ProfileDefinitionSchema,type RunContext,type ProfileDefinition as CanonicalProfile} from '@homelab/contracts';
import {authorize} from '@homelab/policy';
/** Capture before preparing execution authority; never retarget a historical job. */
export async function captureMachineGenerations(db:Pool,owner:string,machineIds:(string|null|undefined)[]):Promise<Record<string,string>>{const ids=[...new Set(machineIds.filter((id):id is string=>!!id))];if(!ids.length)return {};const rows=(await db.query('SELECT id,identity_generation FROM machines WHERE id=ANY($1::uuid[]) AND owner_id=$2',[ids,owner])).rows;if(rows.length!==ids.length)throw new Error('machine_scope_unavailable');return Object.fromEntries(rows.map(row=>[row.id,row.identity_generation]));}
export function expectedMachineGeneration(job:{payload:Record<string,unknown>},machineId:string):string{const value=(job.payload.machine_identity_generations as Record<string,string>|undefined)?.[machineId];if(!value)throw new Error('machine_generation_not_captured');return value;}
export type ProfileDefinition=Pick<CanonicalProfile,'instructions'|'tools'|'machine_ids'|'workspace_ids'|'required_capabilities'|'limits'>&Partial<Omit<CanonicalProfile,'instructions'|'tools'|'machine_ids'|'workspace_ids'|'required_capabilities'|'limits'>>;
export function wireGrant(grant:import('@homelab/contracts').PolicyGrant):import('@homelab/contracts').PolicyGrant{return {id:grant.id,owner_id:grant.owner_id,revision:grant.revision,tools:[...grant.tools],machine_ids:[...grant.machine_ids],workspace_ids:[...grant.workspace_ids],...(grant.profile_ids?{profile_ids:[...grant.profile_ids]}:{}),...(grant.secret_ids?{secret_ids:[...grant.secret_ids]}:{}),expires_at:grant.expires_at?new Date(grant.expires_at).toISOString():null,revoked_at:grant.revoked_at?new Date(grant.revoked_at).toISOString():null};}
export async function assertCurrentGrant(db:Pick<Pool,'query'>,owner:string,context:{execution_machine_id?:string|null;workspace_id?:string|null;profile_id?:string|null},tool:string,grant:import('@homelab/contracts').PolicyGrant){const current=(await db.query('SELECT * FROM permission_grants WHERE id=$1 AND owner_id=$2 FOR SHARE',[grant.id,owner])).rows[0];const decision=authorize({actor:{id:owner,role:'owner'},tool,machine_id:context.execution_machine_id,workspace_id:context.workspace_id,profile_id:context.profile_id,grant,current_grant:current});if(!decision.allowed)throw new Error(decision.code);return current;}
export type ScopeContext=Pick<RunContext,'execution_machine_id'|'execution_identity_id'|'workspace_id'|'limits'>&Partial<Pick<RunContext,'provider_id'|'model_id'>>;
export function checkProfile(definition:ProfileDefinition,context:ScopeContext,tool?:string):void{
 for(const key of ['max_total_tokens','max_generated_file_bytes'] as const)if(definition.limits[key]!==undefined&&context.limits[key]===undefined)throw new Error(`profile_required_${key}_missing`);
 if(context.execution_machine_id&&!definition.machine_ids.includes(context.execution_machine_id))throw new Error('profile_machine_denied');
 if(context.workspace_id&&!definition.workspace_ids.includes(context.workspace_id))throw new Error('profile_workspace_denied');
 if(tool&&!definition.tools.includes(tool))throw new Error('profile_tool_denied');
 if(tool&&['run_command','actions.run'].includes(tool)&&context.execution_identity_id&&!definition.execution_identity_ids?.includes(context.execution_identity_id))throw new Error('profile_identity_denied');
 if(context.provider_id&&definition.allowed_models?.length&&!definition.allowed_models.some(model=>model.provider_id===context.provider_id&&model.model_id===context.model_id))throw new Error('profile_model_denied');
 for(const key of Object.keys(context.limits) as (keyof RunContext['limits'])[]){const requested=context.limits[key],allowed=definition.limits[key];if(requested!==undefined&&(allowed===undefined||requested>allowed))throw new Error('profile_limit_exceeded');}
}
export async function resolveProfile(db:Pick<Pool,'query'>,owner:string,context:ScopeContext&Pick<RunContext,'profile_id'|'profile_revision'>,tool?:string,captured?:ProfileDefinition):Promise<ProfileDefinition|null>{
 if(!context.profile_id)return null;
 const selected=(await db.query(`SELECT r.definition,c.definition AS current_definition FROM agent_profiles p
  JOIN agent_profile_revisions r ON r.profile_id=p.id AND r.revision=$2
  JOIN agent_profile_revisions c ON c.profile_id=p.id AND c.revision=p.current_revision
  WHERE p.id=$1 AND p.owner_id=$3 AND p.archived_at IS NULL FOR SHARE OF p,r,c`,[context.profile_id,context.profile_revision,owner])).rows[0];
 if(!selected)throw new Error('profile_unavailable');
 const initial=ProfileDefinitionSchema.parse(captured??selected.definition),current=ProfileDefinitionSchema.parse(selected.current_definition);
 for(const definition of [initial,current])checkProfile(definition,context,tool);
 const checks=new Map([...(initial.verification_commands??[]),...(current.verification_commands??[])].map(command=>[JSON.stringify(command),command]));
 return {...initial,tools:initial.tools.filter(tool=>current.tools.includes(tool)),required_capabilities:[...new Set([...initial.required_capabilities,...current.required_capabilities])],required_verification:initial.required_verification||current.required_verification,verification_commands:[...checks.values()]};
}
export async function assertProviderScope(db:Pick<Pool,'query'>,owner:string,context:RunContext,profile:ProfileDefinition|null,snapshot:{credentialRef?:string;routing:string},grant?:import('@homelab/contracts').PolicyGrant):Promise<void>{
 if(grant){
  const current=await assertCurrentGrant(db,owner,context,'agent.run',grant);
  if(snapshot.credentialRef&&(!grant.secret_ids?.includes(snapshot.credentialRef)||!current.secret_ids?.includes(snapshot.credentialRef)))throw new Error('grant_secret_denied');
 }
 if(!profile)return;
 const currentRow=(await db.query('SELECT r.definition FROM agent_profiles p JOIN agent_profile_revisions r ON r.profile_id=p.id AND r.revision=p.current_revision WHERE p.id=$1 AND p.owner_id=$2 AND p.archived_at IS NULL',[context.profile_id,owner])).rows[0];
 if(!currentRow)throw new Error('profile_unavailable');
 const current=ProfileDefinitionSchema.parse(currentRow.definition);
 for(const p of [profile,current]){
  if(p.remote_provider_policy==='local_only'&&snapshot.routing!=='local')throw new Error('profile_requires_local_provider');
  if(p.remote_provider_policy==='deny'&&snapshot.routing!=='local')throw new Error('profile_remote_provider_denied');
  if(snapshot.credentialRef&&!p.secret_ids?.includes(snapshot.credentialRef))throw new Error('profile_secret_denied');
 }
}
