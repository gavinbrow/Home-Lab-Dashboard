// Opt-in loopback fault proxy for one owned enrolled machine. Never a general gateway.
import https from 'node:https';
import { readFile, writeFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (!/^[a-f0-9-]{36}$/.test(config.machineId) || config.upstreamPort !== 3459 || config.port !== 3469) throw Error('Only the explicitly owned loopback fixture is allowed');
const [key, cert, ca, clientKey, clientCert] = await Promise.all(['serverKey', 'serverCert', 'ca', 'clientKey', 'clientCert'].map(name => readFile(config[name])));
const fingerprint = new X509Certificate(clientCert).fingerprint256;
const server = https.createServer({ key, cert, ca, requestCert: true, rejectUnauthorized: true }, async (request, response) => {
  try {
    if (request.socket.getPeerCertificate().fingerprint256 !== fingerprint || request.method !== 'POST' || !['/agent/v1/poll', '/agent/v1/results', '/agent/v1/telemetry'].includes(request.url)) { response.writeHead(403).end(); return; }
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 4 * 1024 * 1024) throw Error('bounded fixture body exceeded'); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks), body = JSON.parse(bytes.toString('utf8'));
    if (body.machine_id !== config.machineId) { response.writeHead(403).end(); return; }
    const hold = await readFile(config.holdFile, 'utf8').catch(() => '');
    if (request.url === '/agent/v1/results' && hold && body.body?.operation_id && ['received', 'launching', 'running'].includes(body.body.state)) {
      await writeFile(config.evidenceFile, JSON.stringify({ rpc_id: body.id, operation_id: body.body.operation_id, host_state: body.body.state, dropped_at: new Date().toISOString(), fault: 'Host result deliberately not forwarded to real control plane' }));
      response.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"owned_lost_ack_fixture"}'); return;
    }
    const upstream = https.request({ hostname: '127.0.0.1', port: config.upstreamPort, path: request.url, method: 'POST', key: clientKey, cert: clientCert, ca, rejectUnauthorized: true, headers: { 'content-type': 'application/json', 'content-length': bytes.length }, timeout: 20_000 }, incoming => {
      response.writeHead(incoming.statusCode, { 'content-type': incoming.headers['content-type'] ?? 'application/json' }); incoming.pipe(response);
    });
    upstream.on('timeout', () => upstream.destroy(Error('upstream deadline')));
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(503); response.end(); }); upstream.end(bytes);
  } catch { if (!response.headersSent) response.writeHead(400); response.end(); }
});
server.listen(config.port, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
