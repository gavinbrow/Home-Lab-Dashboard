import type { Pool, PoolClient } from "pg";

/** Commit all state before performing external work. Never await remote I/O in here. */
export async function transaction<T>(db: Pool, body: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await body(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export class LeaseLostError extends Error {
  constructor() { super("Orchestration lease lost; no further work may be dispatched"); }
}
export async function assertOwnedLease(client:PoolClient,job:{id:string;lease_owner:string|null;fence:string}):Promise<void>{
 const result=await client.query(`SELECT j.id FROM jobs j JOIN runtime_control c ON c.singleton=true
  WHERE j.id=$1 AND j.lease_owner=$2 AND j.fence=$3 AND j.lease_until>now()
  AND j.dispatch_epoch=c.dispatch_epoch AND c.dispatch_enabled AND NOT c.restore_mode FOR UPDATE OF j`,[job.id,job.lease_owner,job.fence]);
 if(!result.rowCount)throw new LeaseLostError();
}
