import { z } from 'zod';
import { createPool } from '../core/db.js';
import { hashPassword } from './password.js';
// Local administrator procedure only. Never expose this through HTTP.
const email=z.email().parse(process.env.RECOVERY_EMAIL).toLowerCase();
const password=z.string().min(16).max(1024).parse(process.env.RECOVERY_PASSWORD);
const db=createPool(),client=await db.connect();
try {
 await client.query('BEGIN');
 const updated=await client.query('UPDATE users SET password_hash=$1 WHERE email=$2 RETURNING id',[await hashPassword(password),email]);
 if(!updated.rows[0])throw new Error('Owner account unavailable');
 const id=updated.rows[0].id;
 await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[id]);
 await client.query("INSERT INTO audit_events(actor_id,action,target,outcome)VALUES($1,'auth.local_recovery',$2,'success')",[id,id]);
 await client.query('COMMIT');console.log('Owner credential reset; previous sessions revoked.');
}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await db.end();}
