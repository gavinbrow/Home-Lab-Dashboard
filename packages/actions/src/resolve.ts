import type { Pool } from 'pg';
import { z } from 'zod';
import { ProfileDefinitionSchema,type PolicyGrant,type ProfileDefinition } from '@homelab/contracts';
import { authorize } from '@homelab/policy';
import { ActionDefinitionSchema,assertTarget,canonicalHash,resolveCommand,resolveParameters } from './definition.js';

export const ActionSelectionSchema=z.object({revision:z.number().int().positive(),machine_id:z.uuid(),workspace_id:z.uuid().nullable().default(null),profile_id:z.uuid().nullable().default(null),execution_identity_id:z.uuid().nullable().default(null),grant_id:z.uuid(),parameters:z.record(z.string(),z.unknown()).default({}),idempotency_key:z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/)}).strict();
export type ActionSelection=z.infer<typeof ActionSelectionSchema>;
export const actionError=(code:string,message:string,statusCode=403)=>Object.assign(new Error(message),{statusCode,code});
function captureGrant(row:Record<string,unknown>):PolicyGrant {
  const date=(v:unknown)=>v instanceof Date?v.toISOString():typeof v==='string'?v:null;
  return {id:String(row.id),owner_id:String(row.owner_id),revision:Number(row.revision),tools:row.tools as string[],machine_ids:row.machine_ids as string[],workspace_ids:row.workspace_ids as string[],profile_ids:(row.profile_ids??[]) as string[],secret_ids:(row.secret_ids??[]) as string[],expires_at:date(row.expires_at),revoked_at:date(row.revoked_at)};
}
export async function resolveAuthorizedAction(db:Pool,ownerId:string,actionId:string,selection:ActionSelection) {
  const saved=await db.query('SELECT r.definition FROM saved_action_revisions r JOIN saved_actions a ON a.id=r.action_id WHERE a.id=$1 AND a.owner_id=$2 AND r.revision=$3',[actionId,ownerId,selection.revision]);
  if(!saved.rows.length) throw actionError('action_not_found','Saved action revision not found',404);
  const definition=ActionDefinitionSchema.parse(saved.rows[0].definition);
  const requiresCommand=Boolean(definition.command||definition.verification);
  assertTarget(definition,selection);
  const values=resolveParameters(definition,selection.parameters);
  const machine=(await db.query('SELECT id,os,identity_generation FROM machines WHERE id=$1 AND owner_id=$2',[selection.machine_id,ownerId])).rows[0];
  if(!machine) throw actionError('machine_denied','Target machine unavailable');
  const requiredOs=definition.helper?definition.helper.type==='windows_service'?'windows':'linux':definition.command?.executable.startsWith('/')?'linux':'windows';
  if(machine.os!==requiredOs) throw actionError('action_platform_denied','The saved action platform does not match the enrolled machine');
  if(definition.verification && (definition.verification.command.executable.startsWith('/')?'linux':'windows')!==machine.os) throw actionError('verification_platform_denied','Verification executable does not match the enrolled machine');
  let workspaceSnapshot:null|Record<string,unknown>=null;
  if(selection.workspace_id) {
    const ws=(await db.query("SELECT id,machine_id,revision,environment_id,environment_generation,runtime_path FROM workspaces WHERE id=$1 AND owner_id=$2 AND state='active'",[selection.workspace_id,ownerId])).rows[0];
    if(!ws||ws.machine_id!==selection.machine_id) throw actionError('workspace_denied','Workspace unavailable on selected machine');
    workspaceSnapshot=ws;
  }
  let profileSnapshot:null|Record<string,unknown>=null;
  if(selection.profile_id) {
    const profile=(await db.query('SELECT p.current_revision,r.definition FROM agent_profiles p JOIN agent_profile_revisions r ON r.profile_id=p.id AND r.revision=p.current_revision WHERE p.id=$1 AND p.owner_id=$2 AND p.archived_at IS NULL',[selection.profile_id,ownerId])).rows[0];
    if(!profile) throw actionError('profile_denied','Profile unavailable');
    const d=ProfileDefinitionSchema.parse(profile.definition);
    if(!d.tools?.includes('actions.run')||!d.machine_ids?.includes(selection.machine_id)||(selection.workspace_id&&!d.workspace_ids?.includes(selection.workspace_id))) throw actionError('profile_scope_denied','Action outside selected profile scope');
    if(requiresCommand&&!d.tools?.includes('run_command')) throw actionError('profile_command_denied','Fixed command actions also require the profile run_command permission');
    for(const [key,limit] of Object.entries(definition.limits)) {const permitted=d.limits[key as keyof typeof d.limits];if(typeof permitted!=='number'||limit>permitted) throw actionError('profile_limit_exceeded','Action limits exceed selected profile');}
    profileSnapshot={revision:profile.current_revision,definition:d};
  }
  const row=(await db.query('SELECT * FROM permission_grants WHERE id=$1 AND owner_id=$2',[selection.grant_id,ownerId])).rows[0];
  const grant=row?captureGrant(row):null;
  const decision=authorize({actor:{id:ownerId,role:'owner'},tool:'actions.run',machine_id:selection.machine_id,workspace_id:selection.workspace_id,profile_id:selection.profile_id,grant,current_grant:grant});
  if(!decision.allowed) throw actionError(decision.code,decision.reason);
  if(requiresCommand) {
    const commandDecision=authorize({actor:{id:ownerId,role:'owner'},tool:'run_command',machine_id:selection.machine_id,workspace_id:selection.workspace_id,profile_id:selection.profile_id,grant,current_grant:grant});
    if(!commandDecision.allowed) throw actionError('action_command_permission_denied','Fixed command actions require both actions.run and run_command scope');
  }
  let targetSnapshot:null|Record<string,unknown>=null;
  if(definition.helper) {
    const target=(await db.query('SELECT id,kind,config FROM service_targets WHERE id=$1 AND owner_id=$2 AND machine_id=$3',[definition.helper.target_id,ownerId,selection.machine_id])).rows[0];
    if(!target||target.kind!==definition.helper.type) throw actionError('helper_target_denied','Trusted target unavailable');
    if(!target.config?.allowed_operations?.includes(definition.helper.operation)) throw actionError('helper_operation_denied','Operation outside enrolled target scope');
    if(!definition.verification&&['start','stop','restart'].includes(definition.helper.operation)&&!target.config.allowed_operations.includes('status')) throw actionError('helper_verification_denied','A control operation requires an enrolled status postcondition');
    targetSnapshot=target;
  }
  let identityId:string|null=null;
  if(selection.execution_identity_id) {
    const identity=(await db.query('SELECT id,config,restriction_verified FROM execution_identities WHERE id=$1 AND owner_id=$2 AND machine_id=$3',[selection.execution_identity_id,ownerId,selection.machine_id])).rows[0];
    if(!identity?.restriction_verified||!identity.config?.workspace_ids?.includes(selection.workspace_id)) throw actionError('execution_identity_denied','Identity has no verified access to selected workspace');
    identityId=identity.id;
  } else if(selection.workspace_id) {
    const identities=(await db.query('SELECT id FROM execution_identities WHERE owner_id=$1 AND machine_id=$2 AND restriction_verified=true AND config->\'workspace_ids\' ? $3',[ownerId,selection.machine_id,selection.workspace_id])).rows;
    if(identities.length===1) identityId=identities[0].id;
  }
  if(requiresCommand&&profileSnapshot&&identityId&&!(profileSnapshot.definition as ProfileDefinition).execution_identity_ids.includes(identityId)) throw actionError('profile_identity_denied','Execution identity is outside the selected profile scope');
  return {schema_version:1,machine_identity_generations:{[selection.machine_id]:String(machine.identity_generation)},action_id:actionId,action_revision:selection.revision,action_definition:definition,parameters:selection.parameters,machine_id:selection.machine_id,workspace_id:selection.workspace_id,profile_id:selection.profile_id,profile_snapshot:profileSnapshot,execution_identity_id:identityId,grant,workspace_snapshot:workspaceSnapshot,target_snapshot:targetSnapshot,command:definition.command?resolveCommand(definition.command,values):null,helper:definition.helper??null,verification:definition.verification?{command:resolveCommand(definition.verification.command,values),expected_exit_code:definition.verification.expected_exit_code}:null,verification_status:'not_run',limits:definition.limits,concurrency_limit:definition.concurrency_limit,required_privileges:definition.required_privileges,affected_target:definition.helper?.target_id??selection.workspace_id};
}
export type CapturedAction=Awaited<ReturnType<typeof resolveAuthorizedAction>>;
/** Revalidate new launches against both the captured scope and current persisted state. */
export async function revalidateCapturedAction(db:Pool,ownerId:string,captured:CapturedAction):Promise<void> {
  const current=await resolveAuthorizedAction(db,ownerId,captured.action_id,{revision:captured.action_revision,machine_id:captured.machine_id,workspace_id:captured.workspace_id,profile_id:captured.profile_id,execution_identity_id:captured.execution_identity_id,grant_id:captured.grant!.id,parameters:captured.parameters,idempotency_key:'worker-revalidation'});
  const decision=authorize({actor:{id:ownerId,role:'owner'},tool:'actions.run',machine_id:captured.machine_id,workspace_id:captured.workspace_id,profile_id:captured.profile_id,grant:captured.grant,current_grant:current.grant});
  if(!decision.allowed) throw actionError(decision.code,decision.reason);
  if(captured.command||captured.verification) {
    const commandDecision=authorize({actor:{id:ownerId,role:'owner'},tool:'run_command',machine_id:captured.machine_id,workspace_id:captured.workspace_id,profile_id:captured.profile_id,grant:captured.grant,current_grant:current.grant});
    if(!commandDecision.allowed) throw actionError('action_command_permission_denied','Captured and current grants must both permit fixed command execution');
  }
  if(canonicalHash(current.machine_identity_generations)!==canonicalHash(captured.machine_identity_generations)) throw actionError('machine_generation_changed','Machine installation changed since action capture');
  if(canonicalHash(current.action_definition)!==canonicalHash(captured.action_definition)) throw actionError('action_revision_conflict','Captured action revision changed');
  for(const key of ['command','helper','verification','limits','required_privileges'] as const) if(canonicalHash(current[key])!==canonicalHash(captured[key])) throw actionError('action_payload_conflict','Captured resolved action differs from its immutable definition');
  if(canonicalHash(current.workspace_snapshot)!==canonicalHash(captured.workspace_snapshot)) throw actionError('workspace_revision_conflict','Workspace configuration changed');
  if(captured.execution_identity_id!==current.execution_identity_id) throw actionError('execution_identity_changed','Execution identity changed');
  const original=captured.profile_snapshot?.definition as ProfileDefinition|undefined;
  if(original && (!original.tools?.includes('actions.run')||!original.machine_ids?.includes(captured.machine_id)||(captured.workspace_id&&!original.workspace_ids?.includes(captured.workspace_id)))) throw actionError('captured_profile_denied','Action outside captured profile scope');
  if(original&&(captured.command||captured.verification)&&!original.tools?.includes('run_command')) throw actionError('captured_profile_command_denied','Captured profile must permit fixed command execution');
  if(original&&(captured.command||captured.verification)&&captured.execution_identity_id&&!original.execution_identity_ids.includes(captured.execution_identity_id)) throw actionError('captured_profile_identity_denied','Captured profile must permit the fixed execution identity');
}
