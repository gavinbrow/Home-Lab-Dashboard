import { Socket, isIP } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { createProviderAdapter } from './index.js';
import { createTransport, normalizeEndpoint, resolveDestination } from './transport.js';
import { ProviderError,type ProviderSnapshot } from './types.js';
export async function testProviderConnectivity(snapshot:ProviderSnapshot,resolveCredential:(ref:string)=>Promise<string>,signal?:AbortSignal) {
  const tests:{test:string;state:'pass'|'fail'|'unknown'|'not_applicable';reason?:string}[]=[];
  createTransport(snapshot,resolveCredential);const endpoint=normalizeEndpoint(snapshot.baseUrl);let address:{address:string;family:number};
  try{address=await resolveDestination(snapshot);tests.push({test:'dns',state:'pass'});}catch{tests.push({test:'dns',state:'fail',reason:'resolution_failed_or_destination_not_enrolled'});return{tests};}
  async function connection(tls:boolean):Promise<void>{
    const host=endpoint.hostname.replace(/^\[|\]$/g,'');const port=Number(endpoint.port)||(endpoint.protocol==='https:'?443:80);
    await new Promise<void>((resolve,reject)=>{
      const socket=tls?connectTls({host:address.address,port,servername:isIP(host)?undefined:host,rejectUnauthorized:true,...(snapshot.privateCaPem?{ca:snapshot.privateCaPem}:{})}):new Socket();
      const abort=()=>done(new Error('aborted'));const done=(error?:Error)=>{signal?.removeEventListener('abort',abort);socket.removeAllListeners();socket.destroy();error?reject(error):resolve();};
      socket.setTimeout(Math.min(snapshot.timeoutMs,15000),()=>done(new Error('timeout')));socket.once('error',done);socket.once(tls?'secureConnect':'connect',()=>done());
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();else if(!tls)(socket as Socket).connect(port,address.address);
    });
  }
  try{await connection(false);tests.push({test:'connection',state:'pass'});}catch{tests.push({test:'connection',state:'fail',reason:'tcp_connection_failed'});return{tests};}
  if(endpoint.protocol==='https:'){try{await connection(true);tests.push({test:'tls',state:'pass'});}catch{tests.push({test:'tls',state:'fail',reason:'certificate_or_tls_handshake_failed'});return{tests};}}
  else tests.push({test:'tls',state:'not_applicable',reason:'explicit_trusted_http_configuration'});
  try{await createProviderAdapter(snapshot,{resolveCredential}).discoverModels(signal);tests.push({test:'authentication',state:'pass'},{test:'discovery',state:'pass'});}
  catch(error){
    if(error instanceof ProviderError&&[401,403].includes(error.status??0))tests.push({test:'authentication',state:'fail',reason:'credentials_rejected'},{test:'discovery',state:'unknown'});
    else tests.push({test:'authentication',state:'unknown',reason:'catalog_did_not_establish_authentication'},{test:'discovery',state:'fail',reason:error instanceof ProviderError&&error.status===404?'discovery_route_unavailable':'catalog_request_failed'});
  }
  return{tests};
}
