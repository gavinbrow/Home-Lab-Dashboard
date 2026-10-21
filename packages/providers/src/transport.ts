import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { X509Certificate } from 'node:crypto';
import { Agent, fetch } from 'undici';
import { ProviderError, type ProviderSnapshot } from './types.js';

export interface ProviderTransport {
  request(path: string, body?: unknown, signal?: AbortSignal): Promise<Response>;
}
export function normalizeEndpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ProviderError('invalid-config', 'Provider endpoint must be an absolute URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new ProviderError('invalid-config', 'Endpoint requires HTTP(S), without credentials, query or fragment');
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!['', '/', '/v1'].includes(url.pathname)) throw new ProviderError('invalid-config', 'Endpoint must be the server root or /v1 root');
  return url;
}
const forbidden = new BlockList();
forbidden.addSubnet('169.254.0.0', 16, 'ipv4');
forbidden.addSubnet('224.0.0.0', 4, 'ipv4');
forbidden.addAddress('0.0.0.0', 'ipv4');
forbidden.addSubnet('fe80::', 10, 'ipv6');
forbidden.addSubnet('ff00::', 8, 'ipv6');
forbidden.addAddress('::', 'ipv6');
forbidden.addAddress('fd00:ec2::254','ipv6');
const deprecatedCompatible = new BlockList();deprecatedCompatible.addSubnet('::',96,'ipv6');
function deniedAddress(address: string): boolean {
  // Node's BlockList recognizes IPv4-mapped IPv6, including hexadecimal forms.
  if(isIP(address)===6&&deprecatedCompatible.check(address,'ipv6')&&new URL(`http://[${address}]`).hostname!=='[::1]')return true;
  return forbidden.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}
export async function resolveDestination(snapshot: ProviderSnapshot): Promise<{ address:string;family:number }> {
  const hostname=normalizeEndpoint(snapshot.baseUrl).hostname.replace(/^\[|\]$/g,'');
  const answers = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
  if (!answers.length || answers.some(answer=>deniedAddress(answer.address)||!snapshot.allowedAddresses.includes(answer.address))) throw new ProviderError('destination-denied','Provider DNS does not match its enrolled destination addresses');
  return answers[0]!;
}
/** Enrolled IPs are explicit. DNS is checked and the same answer pinned at connect. */
export function createTransport(snapshot: ProviderSnapshot, resolveCredential: (ref: string) => Promise<string>): ProviderTransport {
  const endpoint = normalizeEndpoint(snapshot.baseUrl);
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, '');
  if (snapshot.privateCaPem) {
    const certificates = snapshot.privateCaPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    try {
      if (snapshot.privateCaPem.length > 131072 || !certificates?.length || /PRIVATE KEY/.test(snapshot.privateCaPem) || certificates.some(pem => !new X509Certificate(pem).ca)) throw new Error();
    } catch { throw new ProviderError('invalid-config', 'Private trust requires a bounded PEM bundle of CA certificates'); }
  }
  if (endpoint.protocol === 'http:' && !snapshot.allowPrivateHttp) throw new ProviderError('destination-denied', 'Plain HTTP requires an explicit trusted endpoint grant');
  if (!snapshot.allowedAddresses.length || snapshot.allowedAddresses.some(ip => !isIP(ip) || deniedAddress(ip)))
    throw new ProviderError('invalid-config', 'Explicit non-metadata destination IP addresses are required');
  if (!Number.isInteger(snapshot.timeoutMs) || snapshot.timeoutMs < 1 || snapshot.timeoutMs > 3_600_000)
    throw new ProviderError('invalid-config', 'Provider timeout is outside the supported range');
  return { async request(path, body, signal) {
    if (!/^\/(api\/|v1\/)[a-zA-Z0-9_\-/.%]+$/.test(path) || path.includes('..')) throw new ProviderError('destination-denied', 'Invalid adapter route');
    const pinned = await resolveDestination(snapshot);
    const dispatcher = new Agent({ connect: { ...(snapshot.privateCaPem ? { ca: snapshot.privateCaPem } : {}), rejectUnauthorized: true, lookup: (_host, options, callback) => {
      if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
      else callback(null, pinned.address, pinned.family);
    } } });
    const headers: Record<string, string> = { accept: 'application/json, text/event-stream' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (snapshot.credentialRef) headers.authorization = `Bearer ${await resolveCredential(snapshot.credentialRef)}`;
    const url = new URL(path, endpoint.origin);
    const requestAbort=new AbortController();const requestSignal=requestAbort.signal;
    const deadline=setTimeout(()=>requestAbort.abort(),snapshot.timeoutMs);
    const cancelFromCaller=()=>requestAbort.abort(signal?.reason);
    signal?.addEventListener('abort',cancelFromCaller,{once:true});if(signal?.aborted)cancelFromCaller();
    const cleanupRequest=()=>{clearTimeout(deadline);signal?.removeEventListener('abort',cancelFromCaller);};
    try {
      const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', dispatcher, signal: requestSignal });
      if (!response.ok) { await response.body?.cancel(); throw new ProviderError('upstream-http', `Provider returned HTTP ${response.status}`, response.status); }
      // Release sockets only after stream is consumed/cancelled, rather than closing early.
      const reader = response.body?.getReader();
      let stopped=false;let streamController:ReadableStreamDefaultController<Uint8Array>|undefined;
      const cleanup=()=>{cleanupRequest();requestSignal.removeEventListener('abort',abortResponse);};
      const abortResponse=()=>{if(stopped)return;stopped=true;cleanup();streamController?.error(new ProviderError('interrupted','Provider stream interrupted'));void reader?.cancel().catch(()=>{});void dispatcher.destroy().catch(()=>{});};
      const stream = reader ? new ReadableStream<Uint8Array>({
        start(controller){streamController=controller;requestSignal.addEventListener('abort',abortResponse,{once:true});if(requestSignal.aborted)abortResponse();},
        async pull(controller) { try { if(stopped)return;const chunk = await reader.read();if(stopped)return;if (chunk.done) {stopped=true;cleanup();controller.close(); await dispatcher.close(); } else controller.enqueue(chunk.value); } catch {if(!stopped){stopped=true;cleanup();controller.error(new ProviderError('interrupted', 'Provider stream interrupted'));}await dispatcher.destroy(); } },
        async cancel() {stopped=true;cleanup();try { await reader.cancel(); } finally { await dispatcher.destroy(); } }
      }) : null;
      if (!reader){cleanupRequest();await dispatcher.close();}
      return new Response(stream, { status: response.status, headers: Object.fromEntries(response.headers.entries()) });
    } catch (error) {cleanupRequest();await dispatcher.destroy(); if (error instanceof ProviderError) throw error; throw new ProviderError('interrupted', 'Provider connection failed or timed out'); }
  } };
}
