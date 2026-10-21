import { mkdir, open, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

const [root, operationInput, durationInput = '180'] = process.argv.slice(2);
// The trusted supervisor supplies this value; the model cannot choose or expand env.
const operationId = operationInput === 'trusted-operation' ? process.env.HOMELAB_OPERATION_ID : operationInput;
const duration = Number(durationInput);
if (!root || !isAbsolute(root) || !/^[A-Za-z0-9_-]{1,120}$/.test(operationId ?? '') || !Number.isInteger(duration) || duration < 1 || duration > 600) {
  throw new Error('Usage: node survival-fixture.mjs ABSOLUTE_DISPOSABLE_ROOT OPERATION_ID [SECONDS:1..600]');
}
await mkdir(root, { recursive: true });
const counter = await open(join(root, 'execution-counter.ndjson'), 'a');
try {
  await counter.write(`${JSON.stringify({ operationId, pid: process.pid, startedAt: new Date().toISOString() })}\n`);
  await counter.sync();
} finally { await counter.close(); }
for (let sequence = 1; sequence <= duration; sequence++) {
  // The durable log envelope already binds operationId; keep the model result compact.
  console.log(JSON.stringify({ sequence }));
  await new Promise(resolve => setTimeout(resolve, 1000));
}
const report = Buffer.from(`Operation ${operationId} completed ${duration} seconds.\n`, 'utf8');
const binary = Buffer.from(Array.from({length: 256}, (_, index) => index));
await writeFile(join(root, 'sentinel-report.txt'), report);
await writeFile(join(root, 'sentinel-binary.bin'), binary);
const outputs = [['sentinel-report.txt', report], ['sentinel-binary.bin', binary]].map(([path, bytes]) => ({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
await writeFile(join(root, `${operationId}-manifest.json`), `${JSON.stringify({operationId, outputs}, null, 2)}\n`);
console.log(JSON.stringify({ operationId, completed: true, outputs }));
