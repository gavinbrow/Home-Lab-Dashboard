import { RunContextSchema, type RunContext, type Workspace } from '@homelab/contracts';
import type { Provider, Profile } from './Settings';
/** Rebinding is only a draft for an explicit next run; it never mutates history. */
export function currentContextDraft(saved:unknown, providers:Provider[],profiles:Profile[],workspaces:Workspace[]):RunContext {
 const previous=RunContextSchema.parse(saved);
 const provider=providers.find(value=>value.id===previous.provider_id);if(!provider)throw new Error('The saved provider is unavailable. Choose a configured provider explicitly.');
 const profile=previous.profile_id?profiles.find(value=>value.id===previous.profile_id):undefined;if(previous.profile_id&&!profile)throw new Error('The saved profile is archived or unavailable. Choose another profile explicitly.');
 const workspace=previous.workspace_id?workspaces.find(value=>value.id===previous.workspace_id):undefined;if(previous.workspace_id&&!workspace)throw new Error('The saved workspace is unavailable. Select a registered workspace explicitly.');
 if(workspace?.state!=='active'&&workspace)throw new Error('The saved workspace is archived. Reactivate it or choose another workspace explicitly.');
 return {...previous,provider_config_revision:provider.revision,provider_adapter:provider.adapter,provider_endpoint:provider.endpoint,profile_revision:profile?.current_revision??null,workspace_revision:workspace?.revision??null,environment_id:workspace?.environment_id??null,environment_generation:workspace?.environment_generation??null,project_instruction_revision:workspace?.instruction_revision??null,limits:profile?.definition.limits??previous.limits};
}
