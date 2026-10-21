import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '../../core/migrate.js';
import { maintainTelemetry } from './retention.js';

test('retention drills preserve nulls/identity, expire bounded windows, and roll back before source deletion', { skip: !process.env.MACHINE_TEST_DATABASE_URL, timeout: 30000 }, async t => {
  const url = new URL(process.env.MACHINE_TEST_DATABASE_URL!);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only an explicitly configured local disposable database is allowed');
  const admin = new Pool({ connectionString: url.href });
  const name = 'machine_retention_' + randomBytes(8).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  url.pathname = '/' + name;
  const db = new Pool({ connectionString: url.href });
  try {
    await migrate(db);
    const owner = randomUUID(), machine = randomUUID(), job = randomUUID();
    await db.query("INSERT INTO users(id,email,password_hash)VALUES($1,'retention@example.invalid','fixture')", [owner]);
    await db.query("INSERT INTO machines(id,owner_id,name,os)VALUES($1,$2,'Retention fixture','unknown')", [machine, owner]);
    await db.query("INSERT INTO jobs(id,requester_id,idempotency_key,request_hash,context,kind,payload,state,dispatch_epoch) SELECT $1,$2,'retained-metadata','fixture','null'::jsonb,'fixture','{}'::jsonb,'completed',dispatch_epoch FROM runtime_control", [job, owner]);
    await db.query("INSERT INTO job_events(job_id,sequence,type,payload)VALUES($1,1,'retained.fixture','{}'::jsonb)", [job]);
    const now = new Date();
    const options = { raw_seconds: 60, five_minute_seconds: 300, hourly_seconds: 3600, batch_size: 2 };
    let sequence = 0;
    const add = async (ageSeconds: number, value: number | null, source = 'retention-drill', boot = 'boot-a', unit = 'bytes') => db.query("INSERT INTO metric_samples(machine_id,boot_id,sequence,series,device_id,value,unit,availability,reason,source,observed_at,kind)VALUES($1,$2,$3,'fixture','device',$4,$5,$6,$7,$8,$9,'gauge')", [machine, boot, ++sequence, value, unit, value === null ? 'unavailable' : 'available', value === null ? 'sensor_absent' : null, source, new Date(now.getTime() - ageSeconds * 1000)]);
    await t.test('restore gate and bounded compaction retain independent boot/unit/source and missing-only sensors', async () => {
      await add(120, null, 'missing-only');
      await add(120, 20, 'source-a');
      await add(120, 30, 'source-a', 'boot-b');
      await add(120, 40, 'source-a', 'boot-a', 'percent');
      await add(600, 50, 'hourly-only');
      await add(7200, 60, 'expired-source');
      await add(0, 70, 'fresh');
      await db.query('UPDATE runtime_control SET restore_mode=true');
      assert.equal((await maintainTelemetry(db, options, now)).skipped, 'restore_mode');
      assert.equal(Number((await db.query('SELECT count(*) FROM metric_samples')).rows[0].count), 7);
      await db.query('UPDATE runtime_control SET restore_mode=false');
      for (let n = 0; n < 4; n++) {
        const result = await maintainTelemetry(db, options, now);
        assert.ok(result.raw_deleted <= 2);
        assert.ok(result.rollups_deleted <= 4);
      }
      assert.equal(Number((await db.query('SELECT count(*) FROM metric_samples')).rows[0].count), 1);
      const missing = (await db.query("SELECT * FROM metric_rollups WHERE source='missing-only'" )).rows;
      assert.equal(missing.length, 2);
      for (const row of missing) { assert.equal(row.min, null); assert.equal(row.max, null); assert.equal(row.mean, null); assert.equal(row.count, 0); assert.equal(row.missing_count, 1); }
      const distinct = (await db.query("SELECT boot_id,unit,mean FROM metric_rollups WHERE source='source-a' AND resolution='5m' ORDER BY mean")).rows;
      assert.deepEqual(distinct.map(row => row.mean), [20, 30, 40]);
      assert.equal(Number((await db.query("SELECT count(*) FROM metric_rollups WHERE source='hourly-only' AND resolution='5m'")).rows[0].count), 0);
      assert.equal(Number((await db.query("SELECT count(*) FROM metric_rollups WHERE source='hourly-only' AND resolution='1h'")).rows[0].count), 1);
      assert.equal(Number((await db.query("SELECT count(*) FROM metric_rollups WHERE source='expired-source'")).rows[0].count), 0);
    });
    await t.test('hourly persistence failure rolls back five-minute rollup and keeps source rows', async () => {
      await add(120, 80, 'rollback-fixture');
      await db.query("CREATE FUNCTION fail_hourly_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source='rollback-fixture' AND NEW.resolution='1h' THEN RAISE EXCEPTION 'retention_fixture_failure'; END IF; RETURN NEW; END $$");
      await db.query('CREATE TRIGGER fail_hourly_fixture BEFORE INSERT OR UPDATE ON metric_rollups FOR EACH ROW EXECUTE FUNCTION fail_hourly_fixture()');
      await assert.rejects(maintainTelemetry(db, options, now), /retention_fixture_failure/);
      assert.equal(Number((await db.query("SELECT count(*) FROM metric_samples WHERE source='rollback-fixture'")).rows[0].count), 1);
      assert.equal(Number((await db.query("SELECT count(*) FROM metric_rollups WHERE source='rollback-fixture'")).rows[0].count), 0);
      await db.query('DROP TRIGGER fail_hourly_fixture ON metric_rollups');
      await db.query('DROP FUNCTION fail_hourly_fixture()');
      assert.equal((await maintainTelemetry(db, options, now)).raw_deleted, 1);
    });
    await t.test('expiry is bounded and retains jobs, events, machines and audit', async () => {
      const later = new Date(now.getTime() + 7200000);
      for (let n = 0; n < 10; n++) {
        const result = await maintainTelemetry(db, options, later);
        assert.ok(result.raw_deleted <= 2);
        assert.ok(result.rollups_deleted <= 4);
      }
      assert.equal(Number((await db.query('SELECT count(*) FROM metric_rollups')).rows[0].count), 0);
      assert.equal(Number((await db.query('SELECT count(*) FROM metric_samples')).rows[0].count), 0);
      assert.equal(Number((await db.query('SELECT count(*) FROM machines')).rows[0].count), 1);
      assert.equal(Number((await db.query('SELECT count(*) FROM jobs')).rows[0].count), 1);
      assert.equal(Number((await db.query('SELECT count(*) FROM job_events')).rows[0].count), 1);
      assert.ok(Number((await db.query("SELECT count(*) FROM audit_events WHERE action='telemetry.retention'")).rows[0].count) > 0);
    });
  } finally { await db.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); }
});
