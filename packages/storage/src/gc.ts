import { randomUUID } from 'node:crypto';
import { lstat,mkdir,rename,unlink,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool,PoolClient } from 'pg';
import { assertHash } from './path.js';
import type { BlobStore } from './blobs.js';

async function cut(client:PoolClient) {
  const control=(await client.query('SELECT maintenance_mode,restore_mode FROM runtime_control WHERE singleton=true FOR SHARE')).rows[0];
  if(!control||control.maintenance_mode||control.restore_mode) throw new Error('blob_gc_maintenance_blocked');
  if((await client.query("SELECT id FROM jobs WHERE kind='operations.backup' AND state NOT IN ('completed','failed','cancelled') LIMIT 1")).rowCount) throw new Error('blob_gc_backup_active');
}
async function durableUnlink(path:string){try{const st=await lstat(path);if(!st.isFile()||st.isSymbolicLink())throw new Error('unsafe_gc_target');await unlink(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
/** Two-phase, reference-fenced collection. A committed nonlive marker precedes rename.
 * Publication triggers reject nonlive hashes; republishing bytes must hold the same fence.
 */
export async function collectBlobs(db:Pool,store:BlobStore,options:{minimumAgeMs?:number;quarantineAgeMs?:number;limit?:number;now?:Date}={}) {
  const now=options.now??new Date(),age=options.minimumAgeMs??86400000,grace=options.quarantineAgeMs??86400000,limit=Math.min(500,options.limit??100);
  if(age<60000||grace<60000||limit<1) throw new Error('invalid_gc_bounds');
  await mkdir(store.root,{recursive:true,mode:0o700});
  const root=await lstat(store.root);if(!root.isDirectory()||root.isSymbolicLink())throw new Error('unsafe_artifact_root');
  const quarantine=join(store.root,'.gc');await mkdir(quarantine,{recursive:true,mode:0o700});
  const qs=await lstat(quarantine);if(!qs.isDirectory()||qs.isSymbolicLink())throw new Error('unsafe_gc_directory');
  // Register old orphan publications, using their actual age. Active stages are never candidates.
  const discovery=await db.connect();
  try {await discovery.query('BEGIN');await cut(discovery);
  let scanned=0;
  discoveryScan: for(const shard of (await readdir(store.root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    if(!shard.isDirectory()||!/^[a-f0-9]{2}$/.test(shard.name))continue;
    for(const entry of (await readdir(join(store.root,shard.name),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      if(!entry.isFile()||!/^[a-f0-9]{64}$/.test(entry.name)||!entry.name.startsWith(shard.name))continue;
      if(++scanned>100000)break discoveryScan;
      let stat;try{stat=await lstat(join(store.root,shard.name,entry.name));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      await discovery.query("SELECT pg_advisory_xact_lock(hashtextextended('homelab-blob:'||$1,0))",[entry.name]);
      await discovery.query('INSERT INTO blob_objects(hash,size_bytes,created_at,last_published_at) VALUES($1,$2,$3,$3) ON CONFLICT DO NOTHING',[entry.name,stat.size,stat.mtime]);
      // A failed revival of a deleted tombstone can leave a new unreferenced source.
      await discovery.query("UPDATE blob_objects SET state='quarantining',quarantine_path=$2,quarantined_at=$3 WHERE hash=$1 AND state<>'live' AND quarantine_path IS NULL",[entry.name,`${entry.name}.${randomUUID()}`,now]);
    }
  }
  await discovery.query('COMMIT');}catch(error){await discovery.query('ROLLBACK');throw error;}finally{discovery.release();}
  const candidates=(await db.query("SELECT hash FROM blob_objects WHERE (state<>'live' AND quarantine_path IS NOT NULL) OR (state='live' AND last_published_at<$1) ORDER BY created_at LIMIT $2",[new Date(now.getTime()-age),limit])).rows;
  const result={quarantined:[] as string[],deleted:[] as string[],retained:[] as string[]};
  for(const item of candidates) {
    const hash=assertHash(item.hash),client=await db.connect();let row:any;
    try {
      await client.query('BEGIN');await cut(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('homelab-blob:'||$1,0))",[hash]);
      row=(await client.query('SELECT * FROM blob_objects WHERE hash=$1 FOR UPDATE',[hash])).rows[0];
      if(!row||(await client.query('SELECT 1 FROM blob_references WHERE hash=$1 LIMIT 1',[hash])).rowCount|| (row.state==='live'&&row.last_published_at.getTime()>now.getTime()-age)) {await client.query('COMMIT');result.retained.push(hash);continue;}
      if(row.state==='live') {
        const path=`${hash}.${randomUUID()}`;
        await client.query("UPDATE blob_objects SET state='quarantining',quarantine_path=$2,quarantined_at=$3 WHERE hash=$1",[hash,path,now]);
        row={...row,state:'quarantining',quarantine_path:path,quarantined_at:now};
      }
      await client.query('COMMIT');
      // Reclaim under the fence again after the durable marker. A publisher may have revived it.
      await client.query('BEGIN');await cut(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('homelab-blob:'||$1,0))",[hash]);
      const current=(await client.query('SELECT * FROM blob_objects WHERE hash=$1 FOR UPDATE',[hash])).rows[0];
      if(!current||current.state==='live'||current.quarantine_path!==row.quarantine_path||(await client.query('SELECT 1 FROM blob_references WHERE hash=$1 LIMIT 1',[hash])).rowCount){await client.query('COMMIT');continue;}
      if(!new RegExp(`^${hash}\\.[a-f0-9-]{36}$`).test(current.quarantine_path))throw new Error('unsafe_gc_path');
      const target=join(quarantine,current.quarantine_path),source=join(store.root,hash.slice(0,2),hash);
      if(current.state==='quarantining') {
        try {const st=await lstat(source);if(!st.isFile()||st.isSymbolicLink())throw new Error('unsafe_gc_source');await rename(source,target);}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        await client.query("UPDATE blob_objects SET state='quarantined' WHERE hash=$1",[hash]);result.quarantined.push(hash);
      } else if(current.quarantined_at.getTime()<=now.getTime()-grace) {
        await durableUnlink(target);
        // A publisher can crash after linking bytes but before committing revival.
        // Both names remain nonlive and unreferenced under this hash fence.
        await durableUnlink(source);
        // Retain the nonlive tombstone: late metadata cannot resurrect missing bytes.
        await client.query('UPDATE blob_objects SET quarantine_path=NULL WHERE hash=$1',[hash]);result.deleted.push(hash);
      }
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  return result;
}
