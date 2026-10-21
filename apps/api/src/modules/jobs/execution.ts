import {ExecutionContextSchema,type ExecutionContext,type PolicyGrant} from '@homelab/contracts';
import type {ApiContext} from '../../core/context.js';
import {resolveProfile,wireGrant,captureMachineGenerations} from '@homelab/worker/authority';
import type {Actor} from '@homelab/contracts';
export function executionError(code:string,statusCode=409):never{throw Object.assign(new Error(code),{code,statusCode});}
/** Capture only a currently owned, approved execution binding. No inference fields are synthesized. */
export async function captureExecution(context:ApiContext,actor:Actor,input:ExecutionContext,grantId:string,tools:string[]){
 const run=ExecutionContextSchema.parse(input);
 if(!run.workspace_id||!run.execution_machine_id||!run.execution_identity_id)executionError('execution_context_required',400);
 const machine_identity_generations=await captureMachineGenerations(context.db,actor.id,[run.execution_machine_id]);
 const workspace=(await context.db.query('SELECT * FROM workspaces WHERE id=$1 AND owner_id=$2',[run.workspace_id,actor.id])).rows[0];
 if(!workspace||workspace.state!=='active'||workspace.machine_id!==run.execution_machine_id||workspace.revision!==run.workspace_revision||workspace.environment_id!==run.environment_id||workspace.environment_generation!==run.environment_generation||workspace.instruction_revision!==run.project_instruction_revision)executionError('workspace_revision_conflict');
 const identity=(await context.db.query('SELECT * FROM execution_identities WHERE id=$1 AND owner_id=$2 AND machine_id=$3',[run.execution_identity_id,actor.id,run.execution_machine_id])).rows[0];
 if(!identity?.restriction_verified||!identity.config?.workspace_ids?.includes(workspace.id))executionError('execution_identity_unverified');
 const grant=(await context.db.query<PolicyGrant>('SELECT * FROM permission_grants WHERE id=$1 AND owner_id=$2',[grantId,actor.id])).rows[0];
 if(!grant||grant.revision!==run.policy_revision)executionError('policy_revision_conflict');
 let profile=null;
 for(const tool of tools){const decision=context.policy({actor,tool,machine_id:run.execution_machine_id,workspace_id:workspace.id,profile_id:run.profile_id,grant,current_grant:grant});if(!decision.allowed)executionError(decision.code,403);profile=await resolveProfile(context.db,actor.id,run,tool);}
 return {execution_context:run,grant:wireGrant(grant),profile_snapshot:profile,machine_identity_generations};
}
