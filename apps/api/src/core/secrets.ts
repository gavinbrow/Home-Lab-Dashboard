import { createCipheriv,createDecipheriv,randomBytes,randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { SecretStore } from './context.js';
import { HttpError } from './errors.js';
export function parseMasterKey(value:string|undefined):Buffer|null {
 if(!value)return null; const key=Buffer.from(value,'base64');
 if(key.length!==32 || key.toString('base64')!==value)throw new Error('MASTER_KEY must be canonical base64 for 32 random bytes');
 return key;
}
export function createSecretStore(db:Pool,key:Buffer|null):SecretStore {
 return {
  async put(ownerId,name,value){
   if(!key)throw new HttpError(503,'secret_store_unavailable','Configure protected master key');
   const id=randomUUID(),nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
   cipher.setAAD(Buffer.from(`homelab:1:${ownerId}:${id}`));
   const ciphertext=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
   await db.query('INSERT INTO secrets(id,owner_id,name,ciphertext,nonce,tag)VALUES($1,$2,$3,$4,$5,$6)',[id,ownerId,name,ciphertext.toString('base64'),nonce.toString('base64'),cipher.getAuthTag().toString('base64')]);
   return id;
  },
  async get(ownerId,id){
   if(!key)throw new HttpError(503,'secret_store_unavailable','Configure protected master key');
   const result=await db.query('SELECT * FROM secrets WHERE id=$1 AND owner_id=$2',[id,ownerId]);
   if(!result.rows[0])throw new HttpError(404,'secret_not_found','Secret unavailable');
   const row=result.rows[0],decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(row.nonce,'base64'));
   decipher.setAAD(Buffer.from(row.format_version===2?`homelab:2:${ownerId}:${id}:${row.version}`:`homelab:1:${ownerId}:${id}`));decipher.setAuthTag(Buffer.from(row.tag,'base64'));
   return Buffer.concat([decipher.update(Buffer.from(row.ciphertext,'base64')),decipher.final()]).toString('utf8');
  },
  async rotate(ownerId,id,value,expectedVersion){
   if(!key)throw new HttpError(503,'secret_store_unavailable','Configure protected master key');
   const client=await db.connect();
   try{
    await client.query('BEGIN');
    const row=(await client.query('SELECT * FROM secrets WHERE id=$1 AND owner_id=$2 FOR UPDATE',[id,ownerId])).rows[0];
    if(!row)throw new HttpError(404,'secret_not_found','Secret unavailable');
    if(row.version!==expectedVersion)throw new HttpError(409,'secret_version_conflict','Credential was rotated by another request');
    const version=expectedVersion+1,nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
    cipher.setAAD(Buffer.from(`homelab:2:${ownerId}:${id}:${version}`));
    const ciphertext=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
    await client.query('INSERT INTO secret_versions(secret_id,version,ciphertext,nonce,tag,format_version)VALUES($1,$2,$3,$4,$5,$6)',[id,row.version,row.ciphertext,row.nonce,row.tag,row.format_version??1]);
    await client.query('UPDATE secrets SET version=$3,ciphertext=$4,nonce=$5,tag=$6,format_version=2 WHERE id=$1 AND owner_id=$2',[id,ownerId,version,ciphertext.toString('base64'),nonce.toString('base64'),cipher.getAuthTag().toString('base64')]);
    await client.query(`UPDATE remote_sessions SET state='revoked',revoked_at=now() WHERE connection_id IN(SELECT id FROM remote_connections WHERE owner_id=$1 AND credential_ref=$2) AND revoked_at IS NULL`,[ownerId,id]);
    await client.query(`UPDATE remote_connections SET version=version+1,config=((config #- '{sftp,verified_at}')-'observation')||'{"session_mode_verified":false}'::jsonb WHERE owner_id=$1 AND credential_ref=$2`,[ownerId,id]);
    await client.query('COMMIT');return version;
   }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
 };
}
