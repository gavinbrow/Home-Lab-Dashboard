import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { generateLocalPki } from './pki.js';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: tsx apps/api/src/modules/machines/pki-init.ts NEW_DIRECTORY [DNS_HOSTNAME]');
const target = resolve(directory);
// Refuse an existing directory; generating a new authority must never silently replace trust.
await mkdir(target, { mode: 0o700 });
const files = await generateLocalPki(process.argv[3] ?? 'localhost');
const dispatch = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
for (const [name, content] of Object.entries({ 'ca.pem': files.ca_pem, 'ca-key.pem': files.ca_key_pem, 'server.pem': files.server_pem, 'server-key.pem': files.server_key_pem, 'dispatch-key.pem': dispatch })) await writeFile(join(target, name), content, { mode: 0o600, flag: 'wx' });
process.stdout.write(`Agent certificates created in ${target}. Restrict this directory to the service account; configure AGENT_* file paths and DISPATCH_SIGNING_KEY_FILE. No trust store was modified.\n`);
