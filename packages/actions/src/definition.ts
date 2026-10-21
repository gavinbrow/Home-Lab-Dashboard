import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LimitsSchema } from '@homelab/contracts';

const name = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const id = z.uuid();
const parameter = z.discriminatedUnion('type', [
  z.object({ type:z.literal('enum'), values:z.array(z.string().min(1).max(128)).min(1).max(100) }).strict(),
  z.object({ type:z.literal('integer'), minimum:z.number().int().safe(), maximum:z.number().int().safe() }).strict().refine(p=>p.minimum<=p.maximum),
  z.object({ type:z.literal('boolean') }).strict(),
  z.object({ type:z.literal('string'), pattern:z.string().min(2).max(256), max_length:z.number().int().min(1).max(1024) }).strict()
]);
const argument = z.union([z.object({ literal:z.string().max(4096) }).strict(),z.object({ parameter:name }).strict()]);
const blockedExecutables = /^(?:sh|bash|dash|zsh|fish|cmd|powershell|pwsh|systemctl|service|sc|docker|podman|sudo|su|doas)(?:\.exe)?$/i;
const executable = z.string().min(1).max(1024).refine(v=>!/[\x00-\x1f]/.test(v) && (/^\//.test(v)||/^[A-Za-z]:[\\/]/.test(v)), 'Executable must be an absolute host path').refine(v=>!blockedExecutables.test(v.split(/[\\/]/).at(-1)!), 'Shells and administrative commands require a trusted helper');
const command = z.object({ executable, args:z.array(argument).max(100), cwd_policy:z.literal('workspace_root'), env:z.record(name,z.string().max(4096)).default({}).refine(v=>Object.keys(v).length===0,'Custom environment requires an independently approved host environment allowlist') }).strict();
const helper = z.object({ type:z.enum(['systemd','windows_service','docker_container']), target_id:id, operation:z.enum(['status','logs','start','stop','restart']), max_log_bytes:z.number().int().min(1).max(1048576).default(65536) }).strict();
const safePatterns=new Set(['^[A-Za-z0-9_.-]+$','^[A-Za-z0-9 _.-]+$','^[A-Za-z0-9]+$','^[a-z0-9_-]+$']);
export const ActionDefinitionSchema = z.object({
  schema_version:z.literal(1), description:z.string().max(4000).default(''),
  machine_ids:z.array(id).min(1).max(100), profile_ids:z.array(id).max(100).default([]),
  workspace_ids:z.array(id).max(100).default([]), parameters:z.record(name,parameter).default({}),
  command:command.optional(), helper:helper.optional(),
  verification:z.object({ command, expected_exit_code:z.number().int().min(0).max(255).default(0) }).strict().nullable().default(null),
  limits:LimitsSchema, concurrency_limit:z.literal(1).default(1), required_privileges:z.array(z.enum(['workspace_identity','enrolled_service','enrolled_container'])).default(['workspace_identity'])
}).strict().superRefine((d,c)=>{
  if (Boolean(d.command)===Boolean(d.helper)) c.addIssue({code:'custom',message:'Exactly one fixed command or trusted helper is required'});
  if ((d.command||d.verification) && !d.workspace_ids.length) c.addIssue({code:'custom',message:'Commands and verification require explicit allowed workspaces'});
  for(const p of Object.values(d.parameters)) if(p.type==='string') {
    if(!safePatterns.has(p.pattern)) c.addIssue({code:'custom',message:'String pattern must be an approved bounded character class'});
  }
  for(const cmd of [d.command,d.verification?.command]) for(const arg of cmd?.args??[]) if('parameter' in arg && !(arg.parameter in d.parameters)) c.addIssue({code:'custom',message:'Argument references an undeclared parameter'});
});
export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>;
export function resolveParameters(definition:ActionDefinition, input:unknown):Record<string,string> {
  if(!input || typeof input!=='object'||Array.isArray(input)) throw Error('parameters_invalid');
  const values=input as Record<string,unknown>;
  if(Object.keys(values).some(k=>!Object.hasOwn(definition.parameters,k))) throw Error('parameter_unknown');
  const result:Record<string,string>={};
  for(const [key,p] of Object.entries(definition.parameters)) {
    const v=values[key];
    if(p.type==='integer' && (!Number.isSafeInteger(v)||typeof v!=='number'||v<p.minimum||v>p.maximum)) throw Error('parameter_invalid:'+key);
    if(p.type==='boolean' && typeof v!=='boolean') throw Error('parameter_invalid:'+key);
    if(p.type==='enum' && (typeof v!=='string'||!p.values.includes(v))) throw Error('parameter_invalid:'+key);
    if(p.type==='string' && (typeof v!=='string'||v.length>p.max_length||!new RegExp(p.pattern,'u').test(v))) throw Error('parameter_invalid:'+key);
    const text=String(v);
    if(p.type==='string' && text.startsWith('-')) throw Error('parameter_option_injection:'+key);
    if(/[\x00-\x1f;&|`$<>]/.test(text)) throw Error('parameter_unsafe:'+key);
    result[key]=text;
  }
  return result;
}
export function resolveCommand(command:NonNullable<ActionDefinition['command']>, values:Record<string,string>) {
  return {executable:command.executable,args:command.args.map(a=>'literal' in a?a.literal:values[a.parameter]),cwd_policy:command.cwd_policy,env:command.env};
}
export function assertTarget(definition:ActionDefinition,target:{machine_id:string;workspace_id:string|null;profile_id:string|null}) {
  if(!definition.machine_ids.includes(target.machine_id)) throw Error('action_machine_denied');
  if(definition.workspace_ids.length && (!target.workspace_id||!definition.workspace_ids.includes(target.workspace_id))) throw Error('action_workspace_denied');
  if(definition.profile_ids.length && (!target.profile_id||!definition.profile_ids.includes(target.profile_id))) throw Error('action_profile_denied');
}
export function canonicalHash(value:unknown):string {
  const sort=(v:unknown):unknown=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,sort(x)])):v;
  return createHash('sha256').update(JSON.stringify(sort(value))).digest('hex');
}
