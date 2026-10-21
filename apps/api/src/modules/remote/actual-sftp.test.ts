import assert from 'node:assert/strict';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import test from 'node:test';
import { verifySftpConfinement,withSftp } from './sftp.js';

test('actual OpenSSH Linux chroot fixture: root marker, outside-canary denial and exclusive hash round trip',{
  skip:process.env.HOMELAB_SFTP_FIXTURE!=='1'?'Opt in only on isolated homelab-ops-wave2 fixture network':false,timeout:30_000,
},async()=>{
  const row={id:randomUUID(),machine_id:randomUUID(),credential_ref:randomUUID(),version:1,config:{hostname:'fixture-sftp',port:2222,username:'sftpfixture',host_key_fingerprints:[process.env.HOMELAB_SFTP_HOST_KEY!],account_scope:'sftp_chroot',sftp:{type:'openssh_chroot' as const,virtual_root:'/' as const,host_root:'/srv/fixture-jail',operator_verified_sshd_chroot:true as const,root_marker_path:'root-marker',root_marker_sha256:createHash('sha256').update('homelab-isolated-sftp-root\n').digest('hex'),outside_canary_path:'/outside-root-canary',operator_verified_outside_canary_exists:true as const,verification_directory:'data',verified_at:new Date().toISOString()}}};
  const context={secrets:{put:async()=>'',get:async()=>JSON.stringify({password:'isolated-fixture-only'})}};
  const verified=await verifySftpConfinement(context,row,'fixture-owner');assert.equal(verified.scope,'entire_attested_openssh_chroot');
  await withSftp(context,row,'fixture-owner',false,async(files,sftp)=>{
    const path=`data/test-${randomUUID()}`,data=randomBytes(512);
    try{
      await files.create(path,data);assert.deepEqual(await files.read(path),data);
      await assert.rejects(files.create(path,data));
      await assert.rejects(files.read('../outside-root-canary'));
      await assert.rejects(files.read('outside-root-canary'));
      assert.ok((await files.list('.')).every(entry=>['data','root-marker'].includes(entry.name)));
    }finally{await new Promise<void>((resolve,reject)=>sftp.unlink(`/${path}`,error=>error?reject(error):resolve()));}
  });
});
