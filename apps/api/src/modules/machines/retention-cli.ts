import { Pool } from 'pg';
import { maintainTelemetry, retentionFromEnvironment } from './retention.js';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for telemetry maintenance');
const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try { console.log(JSON.stringify(await maintainTelemetry(db, retentionFromEnvironment()))); } finally { await db.end(); }
