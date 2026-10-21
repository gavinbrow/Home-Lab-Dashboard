import type { PolicyRequest, PolicyDecision, RunContext, Workspace } from '@homelab/contracts';
export function authorize(request:PolicyRequest):PolicyDecision {
  const deny = (code:string, reason:string):PolicyDecision => ({allowed:false,code,reason,policy_revision:request.current_grant?.revision ?? 1});
  if (!request.actor?.id || request.actor.role !== 'owner') return deny('unauthenticated','Owner authentication required');
  if (!request.grant || !request.current_grant) return deny('grant_required','A persisted scope grant is required');
  for (const grant of [request.grant,request.current_grant]) {
    if (grant.owner_id !== request.actor.id) return deny('ownership_denied','Grant belongs to another owner');
    if (grant.revoked_at || (grant.expires_at && (!Number.isFinite(Date.parse(grant.expires_at)) || Date.parse(grant.expires_at)<=Date.now()))) return deny('grant_revoked','Grant revoked or expired');
    if (!grant.tools.includes(request.tool)) return deny('tool_denied','Tool is outside approved scope');
    if (request.machine_id && !grant.machine_ids.includes(request.machine_id)) return deny('machine_denied','Machine is outside approved scope');
    if (request.workspace_id && !grant.workspace_ids.includes(request.workspace_id)) return deny('workspace_denied','Workspace is outside approved scope');
    if (request.profile_id && !grant.profile_ids?.includes(request.profile_id)) return deny('profile_denied','Profile is outside approved scope');
  }
  return {allowed:true,code:'allowed',reason:'Approved by captured and current grants',policy_revision:request.current_grant.revision};
}
export function resolveRunContext(context:RunContext, workspace:Workspace|null):RunContext {
  if (context.workspace_id && !workspace) throw new Error('workspace_required');
  if (workspace) {
    if (workspace.id !== context.workspace_id || workspace.machine_id !== context.execution_machine_id) throw new Error('workspace_machine_mismatch');
    if (workspace.state !== 'active' || workspace.revision !== context.workspace_revision) throw new Error('workspace_revision_conflict');
    if (workspace.instruction_revision !== context.project_instruction_revision) throw new Error('instruction_revision_conflict');
    if (workspace.environment_id !== context.environment_id || workspace.environment_generation !== context.environment_generation) throw new Error('environment_generation_mismatch');
    if (!context.execution_identity_id) throw new Error('execution_identity_required');
  } else if (context.execution_machine_id || context.execution_identity_id || context.environment_id) throw new Error('plain_chat_execution_forbidden');
  return structuredClone(context);
}
