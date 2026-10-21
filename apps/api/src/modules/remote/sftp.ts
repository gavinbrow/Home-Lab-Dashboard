import { createHash,randomBytes,randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { SFTPWrapper } from 'ssh2';
import { z } from 'zod';
import { IdSchema } from '@homelab/contracts';
import type { ApiContext } from '../../core/context.js';
import { RemoteError } from './security.js';
import { ConfinedSftp,connectSsh,relativeSftpPath,type SshCredential,type SshConnection } from './ssh.js';
import { assertRemoteEnabled } from './lifecycle.js';

/** Supported boundary is the entire OpenSSH chroot namespace. A subdirectory
 * of an unrestricted account is deliberately not accepted as confinement. */
export const sftpPolicySchema=z.object({
  type:z.literal('openssh_chroot'),virtual_root:z.literal('/'),
  host_root:z.string().min(2).max(2048).startsWith('/'),
  operator_verified_sshd_chroot:z.literal(true),
  root_marker_path:z.string().min(1).max(2048),root_marker_sha256:z.string().regex(/^[a-f0-9]{64}$/),
  outside_canary_path:z.string().min(2).max(2048).startsWith('/'),
  operator_verified_outside_canary_exists:z.literal(true),
  verification_directory:z.string().min(1).max(2048),verified_at:z.string().datetime().optional(),
}).strict().superRefine((value,ctx)=>{
  try{relativeSftpPath(value.root_marker_path);relativeSftpPath(value.verification_directory);}catch{ctx.addIssue({code:'custom',message:'Marker and verification directory must be root-relative paths'});}
});
type Policy=z.infer<typeof sftpPolicySchema>;
type SftpRow={id:string;machine_id:string;config:{hostname:string;port:number;username:string;host_key_fingerprints:string[];account_scope?:string;sftp?:Policy};credential_ref:string;version:number};
const digest=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const configOf=(row:SftpRow):SshConnection=>({hostname:row.config.hostname,port:row.config.port,username:row.config.username,hostKeyFingerprints:row.config.host_key_fingerprints,sftpRoot:'/',sftpConfinementVerified:true});

async function assertJail(sftp:SFTPWrapper,files:ConfinedSftp,policy:Policy):Promise<void> {
  const marker=await files.read(policy.root_marker_path);
  if(digest(marker)!==policy.root_marker_sha256)throw new RemoteError('SFTP_ROOT_MARKER_MISMATCH',409);
  await new Promise<void>((resolve,reject)=>sftp.stat(policy.outside_canary_path,error=>{
    if(error&&[2,3].includes(Number((error as Error&{code?:number}).code)))resolve();
    else reject(new RemoteError('SFTP_OUTSIDE_CANARY_NOT_DENIED',409));
  }));
}

export async function withSftp<T>(context:Pick<ApiContext,'secrets'>,row:SftpRow,ownerId:string,verify:boolean,action:(files:ConfinedSftp,sftp:SFTPWrapper,policy:Policy)=>Promise<T>):Promise<T> {
  const policy=sftpPolicySchema.parse(row.config.sftp);
  if(row.config.account_scope!=='sftp_chroot')throw new RemoteError('SFTP_ACCOUNT_SCOPE_INVALID',409);
  if(!verify&&(!policy.verified_at||Date.now()-Date.parse(policy.verified_at)>24*60*60_000))throw new RemoteError('SFTP_CONFINEMENT_TEST_REQUIRED',409);
  const credentials=JSON.parse(await context.secrets.get(ownerId,row.credential_ref)) as SshCredential;
  const client=await connectSsh(configOf(row),credentials);
  const timer=setTimeout(()=>client.destroy(),30_000);timer.unref();
  try{
    const sftp=await new Promise<SFTPWrapper>((resolve,reject)=>client.sftp((error,value)=>error?reject(new RemoteError('SFTP_UNAVAILABLE',502)):resolve(value)));
    const files=await ConfinedSftp.open(client,configOf(row));
    try{await assertJail(sftp,files,policy);return await action(files,sftp,policy);}finally{files.close();sftp.end();}
  }finally{clearTimeout(timer);client.destroy();}
}

export async function verifySftpConfinement(context:Pick<ApiContext,'secrets'>,row:SftpRow,ownerId:string):Promise<{sha256:string;scope:string}> {
  return withSftp(context,row,ownerId,true,async(files,sftp,policy)=>{
    const path=`${relativeSftpPath(policy.verification_directory)}/.homelab-probe-${randomUUID()}`;
    const data=randomBytes(128);let created=false;
    try{
      await files.create(path,data);created=true;
      if(digest(await files.read(path))!==digest(data))throw new RemoteError('SFTP_HASH_ROUND_TRIP_FAILED',502);
      return {sha256:digest(data),scope:'entire_attested_openssh_chroot'};
    }finally{
      if(created)await new Promise<void>((resolve,reject)=>sftp.unlink(`/${path}`,error=>error?reject(new RemoteError('SFTP_PROBE_CLEANUP_FAILED',502)):resolve()));
    }
  });
}

export async function registerSftp(app:FastifyInstance,context:ApiContext):Promise<void> {
  const owned=async(id:string,ownerId:string):Promise<SftpRow>=>{
    await assertRemoteEnabled(context);
    const row=(await context.db.query<SftpRow>(`SELECT r.* FROM remote_connections r JOIN machines m ON m.id=r.machine_id AND m.owner_id=r.owner_id
      WHERE r.id=$1 AND r.owner_id=$2 AND r.kind='ssh' AND COALESCE(r.config->>'enabled','true')='true'`,[id,ownerId])).rows[0];
    if(!row)throw new RemoteError('SFTP_CONNECTION_NOT_FOUND',404);return row;
  };
  app.post('/remote/connections/:id/sftp-test',async request=>{
    const id=IdSchema.parse((request.params as {id:string}).id),row=await owned(id,request.actor!.id);
    const result=await verifySftpConfinement(context,row,request.actor!.id);
    const verifiedAt=new Date().toISOString();
    const updated=await context.db.query(`UPDATE remote_connections SET config=jsonb_set(config,'{sftp,verified_at}',to_jsonb($3::text)) WHERE id=$1 AND owner_id=$2 AND version=$4 RETURNING id`,[id,request.actor!.id,verifiedAt,row.version]);
    if(!updated.rowCount)throw new RemoteError('SFTP_CONNECTION_CHANGED',409);
    await context.db.query(`UPDATE machines SET capabilities=jsonb_set(capabilities,'{sftp}',$3::jsonb),updated_at=now() WHERE id=$1 AND owner_id=$2`,[row.machine_id,request.actor!.id,JSON.stringify({supported:true,configured:true,permitted:true,health_state:'healthy',observed_at:verifiedAt,last_test_at:verifiedAt,last_success_at:verifiedAt,reason:'Pinned SSH/SFTP marker, known-outside-canary denial, bounded hash round trip and cleanup passed for operator-attested OpenSSH chroot. Scope is the entire jail.'})]);
    await context.audit(request.actor!.id,'remote.sftp.confinement_test',id,'passed',{...result,operator_attested_chroot:true});
    return {...result,verified_at:verifiedAt,expires_at:new Date(Date.parse(verifiedAt)+24*60*60_000).toISOString(),operator_attested_chroot:true};
  });
  app.get('/remote/connections/:id/files',async request=>{
    const row=await owned(IdSchema.parse((request.params as {id:string}).id),request.actor!.id);
    const query=z.object({path:z.string().max(2048).default('.'),operation:z.enum(['list','read']).default('list')}).strict().parse(request.query);
    return withSftp(context,row,request.actor!.id,false,async files=>query.operation==='list'?{items:await files.list(query.path)}:{encoding:'base64',data:(await files.read(query.path)).toString('base64')});
  });
  app.post('/remote/connections/:id/files',async request=>{
    if(context.config.restoreMode)throw new RemoteError('RESTORE_MODE_REMOTE_DISABLED',503);
    const row=await owned(IdSchema.parse((request.params as {id:string}).id),request.actor!.id);
    const body=z.object({path:z.string().min(1).max(2048),data:z.string().max(1_398_104),encoding:z.literal('base64')}).strict().parse(request.body);
    if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.data))throw new RemoteError('SFTP_UPLOAD_ENCODING_INVALID',400);
    const bytes=Buffer.from(body.data,'base64');
    await withSftp(context,row,request.actor!.id,false,files=>files.create(body.path,bytes));
    await context.audit(request.actor!.id,'remote.sftp.create',row.id,'created',{path:body.path,bytes:bytes.length,sha256:digest(bytes)});
    return {path:body.path,size_bytes:bytes.length,sha256:digest(bytes)};
  });
}
