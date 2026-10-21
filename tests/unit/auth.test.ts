import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { hashPassword,verifyPassword } from '../../apps/api/src/auth/password.js';
import { parseMasterKey,createSecretStore } from '../../apps/api/src/core/secrets.js';
import type { Pool } from 'pg';
test('password hashes have independent salts and reject incorrect passwords',async()=>{
 const a=await hashPassword('test-password-at-least-twelve'),b=await hashPassword('test-password-at-least-twelve');
 assert.notEqual(a,b);assert.ok(await verifyPassword('test-password-at-least-twelve',a));assert.equal(await verifyPassword('wrong-password',a),false);
});
test('master key accepts exact canonical 32-byte values only',()=>{
 assert.equal(parseMasterKey(undefined),null);assert.throws(()=>parseMasterKey('bad'));assert.equal(parseMasterKey(randomBytes(32).toString('base64'))!.length,32);
});
test('encrypted secret values are owner-bound and authenticate ciphertext',async()=>{
 let stored:Record<string,unknown>|undefined;
 const db={query:async(sql:string,args:unknown[])=>{if(sql.startsWith('INSERT')){stored={id:args[0],owner_id:args[1],name:args[2],ciphertext:args[3],nonce:args[4],tag:args[5]};return {rows:[]};}return {rows:stored&&stored.owner_id===args[1]?[stored]:[]};}} as unknown as Pool;
 const secrets=createSecretStore(db,randomBytes(32)),id=await secrets.put('owner-1','provider','sensitive-value');
 assert.equal(await secrets.get('owner-1',id),'sensitive-value');assert.ok(!JSON.stringify(stored).includes('sensitive-value'));
 await assert.rejects(secrets.get('owner-2',id));stored!.tag=randomBytes(16).toString('base64');await assert.rejects(secrets.get('owner-1',id));
});
