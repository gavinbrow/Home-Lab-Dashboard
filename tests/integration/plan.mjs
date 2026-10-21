import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Planning is deliberately offline. This executable never authenticates, contacts
// hosts, executes faults, or converts local fixture checks into release PASS.
const mapping = JSON.parse(await readFile(new URL('./acceptance-map.json', import.meta.url), 'utf8'));
const configIndex = process.argv.indexOf('--config');
const config = configIndex >= 0
  ? JSON.parse(await readFile(process.argv[configIndex + 1], 'utf8'))
  : null;
const requiredInventory = ['controlPlane', 'linuxMachine', 'windowsMachine', 'provider', 'linuxWorkspace', 'windowsWorkspace', 'containerWorkspace', 'backupDestination'];
if (mapping.tests.length !== 23 || new Set(mapping.tests.map(t => t.id)).size !== 23) throw new Error('Acceptance map must contain exactly 23 unique tests');
for (let index = 1; index <= 17; index++) {
  const requirement = `R${String(index).padStart(2, '0')}`;
  if (!mapping.tests.some(test => test.requirements.includes(requirement))) throw new Error(`Unmapped ${requirement}`);
}
if (config) {
  const permitted = new Set(['schemaVersion', 'deploymentMode', 'baseUrl', 'allowedOrigin', 'inventory']);
  if (Object.keys(config).some(key => !permitted.has(key))) throw new Error('Unexpected config field; use secret references outside this sanitized file');
  if (config.schemaVersion !== 1 || config.deploymentMode !== 'live') throw new Error('Only schema 1 live configuration is eligible');
  const target = new URL(config.baseUrl);
  if (target.username || target.password || target.search || target.hash || target.origin !== config.allowedOrigin) throw new Error('Endpoint must match enrolled origin and contain no URL credentials, query, or fragment');
  if (target.protocol !== 'https:') throw new Error('Real acceptance requires HTTPS');
}
const missing = requiredInventory.filter(key => !config?.inventory?.[key]);
const reason = missing.length ? `Missing real inventory: ${missing.join(', ')}` : 'Real scenario execution/evidence has not been recorded';
console.log(JSON.stringify({
  schemaVersion: 1,
  source: fileURLToPath(new URL('./acceptance-map.json', import.meta.url)),
  evidenceScope: 'offline-planning-only',
  networkContacted: false,
  releaseStatus: 'BLOCKED',
  tests: mapping.tests.map(test => ({...test, outcome: 'BLOCKED', reason, evidence: []}))
}, null, 2));
