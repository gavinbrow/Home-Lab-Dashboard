import type { Pool } from 'pg';
import { z } from 'zod';

const settingsSchema = z.object({ raw_seconds: z.number().int().min(60).default(7 * 86400), five_minute_seconds: z.number().int().min(300).default(90 * 86400), hourly_seconds: z.number().int().min(3600).default(365 * 86400), batch_size: z.number().int().min(1).max(10000).default(5000) }).refine(v => v.raw_seconds <= v.five_minute_seconds && v.five_minute_seconds <= v.hourly_seconds);
export type TelemetryRetentionOptions = Partial<z.infer<typeof settingsSchema>>;

/** One bounded transaction. Only telemetry bytes/rollups are eligible, never audit/job metadata. */
export async function maintainTelemetry(db: Pool, options: TelemetryRetentionOptions = {}, now = new Date()) {
  const settings = settingsSchema.parse(options);
  if (process.env.RESTORE_MODE === 'true') return { locked: false, raw_deleted: 0, rollups_deleted: 0, skipped: 'restore_mode' };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='15s'");
    const control = await client.query('SELECT restore_mode FROM runtime_control WHERE singleton=true FOR SHARE');
    if (!control.rowCount || control.rows[0].restore_mode) { await client.query('ROLLBACK'); return { locked: false, raw_deleted: 0, rollups_deleted: 0, skipped: 'restore_mode' }; }
    // One maintainer across worker replicas/explicit CLI; no waiting on an existing batch.
    const locked = await client.query('SELECT pg_try_advisory_xact_lock(474345741) AS locked');
    if (!locked.rows[0].locked) { await client.query('ROLLBACK'); return { locked: true, raw_deleted: 0, rollups_deleted: 0 }; }
    const before = new Date(now.getTime() - settings.raw_seconds * 1000);
    const selected = await client.query('SELECT id FROM metric_samples WHERE observed_at<$1 ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2', [before, settings.batch_size]);
    const ids = selected.rows.map(row => row.id);
    if (ids.length) {
      for (const [resolution, seconds, retain] of [['5m', 300, settings.five_minute_seconds], ['1h', 3600, settings.hourly_seconds]] as const) {
        await client.query(`INSERT INTO metric_rollups(machine_id,boot_id,series,device_id,unit,source,kind,resolution,bucket,min,max,mean,count,missing_count,last_observed_at,last_received_at)
          SELECT machine_id,boot_id,series,device_id,unit,source,kind,$2,
            to_timestamp(floor(extract(epoch from observed_at)/$3)*$3),
            min(value) FILTER(WHERE availability='available'), max(value) FILTER(WHERE availability='available'),
            (avg(value::numeric) FILTER(WHERE availability='available'))::double precision,
            count(*) FILTER(WHERE availability='available'),count(*) FILTER(WHERE availability<>'available'),max(observed_at),max(received_at)
          FROM metric_samples WHERE id=ANY($1::bigint[]) AND observed_at >= $4
          GROUP BY machine_id,boot_id,series,device_id,unit,source,kind,to_timestamp(floor(extract(epoch from observed_at)/$3)*$3)
          ORDER BY machine_id,boot_id,series,device_id,unit,source,kind,to_timestamp(floor(extract(epoch from observed_at)/$3)*$3)
          ON CONFLICT(machine_id,boot_id,series,device_id,unit,source,kind,resolution,bucket) DO UPDATE SET
            min=least(metric_rollups.min,EXCLUDED.min),max=greatest(metric_rollups.max,EXCLUDED.max),
            mean=CASE WHEN metric_rollups.count+EXCLUDED.count=0 THEN NULL ELSE
              ((COALESCE(metric_rollups.mean,0)::numeric*metric_rollups.count+COALESCE(EXCLUDED.mean,0)::numeric*EXCLUDED.count)/(metric_rollups.count+EXCLUDED.count))::double precision END,
            count=metric_rollups.count+EXCLUDED.count,missing_count=COALESCE(metric_rollups.missing_count,0)+EXCLUDED.missing_count,
            last_observed_at=greatest(metric_rollups.last_observed_at,EXCLUDED.last_observed_at),last_received_at=greatest(metric_rollups.last_received_at,EXCLUDED.last_received_at)`, [ids, resolution, seconds, new Date(now.getTime() - retain * 1000)]);
      }
      // All retained resolutions are durable before source deletion, atomically with it.
      await client.query('DELETE FROM metric_samples WHERE id=ANY($1::bigint[])', [ids]);
    }
    let expired = 0;
    for (const [resolution, retain, bucketSeconds] of [['5m', settings.five_minute_seconds, 300], ['1h', settings.hourly_seconds, 3600]] as const) {
      const cutoff = new Date(Math.floor((now.getTime() - retain * 1000) / (bucketSeconds * 1000)) * bucketSeconds * 1000);
      const removed = await client.query('DELETE FROM metric_rollups WHERE ctid IN(SELECT ctid FROM metric_rollups WHERE resolution=$1 AND bucket<$2 ORDER BY bucket LIMIT $3) RETURNING 1', [resolution, cutoff, settings.batch_size]);
      expired += removed.rowCount ?? 0;
    }
    if (ids.length || expired) await client.query("INSERT INTO audit_events(actor_id,action,target,outcome,details)VALUES(NULL,'telemetry.retention',NULL,'success',$1::jsonb)", [JSON.stringify({ raw_deleted: ids.length, rollups_deleted: expired, settings })]);
    await client.query('COMMIT');
    return { locked: false, raw_deleted: ids.length, rollups_deleted: expired, batch_limit: settings.batch_size };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export function retentionFromEnvironment(env: NodeJS.ProcessEnv = process.env): TelemetryRetentionOptions {
  const result: TelemetryRetentionOptions = {};
  for (const [key, variable] of [['raw_seconds', 'METRICS_RAW_SECONDS'], ['five_minute_seconds', 'METRICS_FIVE_MINUTE_SECONDS'], ['hourly_seconds', 'METRICS_HOURLY_SECONDS'], ['batch_size', 'METRICS_RETENTION_BATCH_SIZE']] as const) if (env[variable]) result[key] = Number(env[variable]);
  return settingsSchema.parse(result);
}

/** Internal maintenance timer, unrelated to user automations. Call stop before closing the DB. */
export function startTelemetryMaintenance(db: Pool, onError: (error: unknown) => void, env: NodeJS.ProcessEnv = process.env) {
  const options = retentionFromEnvironment(env);
  let running: Promise<unknown> | undefined;
  const run = () => { if (!running) running = maintainTelemetry(db, options).catch(onError).finally(() => { running = undefined; }); };
  const timer = setInterval(run, 60000);
  timer.unref(); run();
  return async () => { clearInterval(timer); await running; };
}

