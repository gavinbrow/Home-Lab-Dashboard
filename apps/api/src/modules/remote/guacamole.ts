import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { RemoteError } from './security.js';

export interface GuacamoleSettings { baseUrl:string; key:Buffer }
export async function guacamoleSettings():Promise<GuacamoleSettings|null> {
  const source = process.env.GUACAMOLE_INTERNAL_URL;
  if (!source) return null;
  const url = new URL(source.endsWith('/') ? source : `${source}/`);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new RemoteError('GUACAMOLE_CONFIGURATION_INVALID',503);
  const hex = (process.env.GUACAMOLE_JSON_KEY_FILE ? await readFile(process.env.GUACAMOLE_JSON_KEY_FILE,'utf8') : process.env.GUACAMOLE_JSON_KEY || '').trim();
  if (!/^[a-fA-F0-9]{32}$/.test(hex)) return null;
  return {baseUrl:url.href,key:Buffer.from(hex,'hex')};
}

async function boundedText(response:Response,limit:number):Promise<string> {
  if (!response.ok || !response.body) throw new RemoteError('GUACAMOLE_UPSTREAM_FAILED',502);
  const chunks:Buffer[]=[];let length=0;
  for await (const chunk of Readable.fromWeb(response.body as never)) {
    length+=chunk.length;
    if(length>limit)throw new RemoteError('GUACAMOLE_UPSTREAM_RESPONSE_INVALID',502);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Stock 1.6.0 HTTP tunnel adapter. Upstream authentication tokens occur only
 * in POST bodies; tunnel tokens only in headers. Neither reaches browsers.
 */
export class GuacamoleHttpSession {
  private readonly controllers = new Set<AbortController>();
  private tunnelId:string|undefined;
  private tunnelToken:string|undefined;
  private closed=false;
  private readSequence=0;
  private queuedBytes=0;
  private writes:Promise<void>=Promise.resolve();
  private readonly consumers=new Set<()=>void>();
  constructor(private readonly settings:GuacamoleSettings){}
  get isClosed():boolean{return this.closed;}
  onClose(callback:()=>void):()=>void {if(this.closed)callback();else this.consumers.add(callback);return()=>this.consumers.delete(callback);}
  private async request(path:string,options:RequestInit={},timeout=30_000,finishAfterClose=false):Promise<Response> {
    if(this.closed)throw new RemoteError('DESKTOP_SESSION_CLOSED',410);
    const controller=new AbortController();if(!finishAfterClose)this.controllers.add(controller);
    const timer=setTimeout(()=>controller.abort(),timeout);timer.unref();
    try {
      const response=await fetch(new URL(path,this.settings.baseUrl),{...options,redirect:'error',signal:controller.signal});
      // Streaming read callers own body consumption. Timeout continues through the body.
      if(response.body) {
        const reader=response.body.getReader();
        const clean=()=>{clearTimeout(timer);this.controllers.delete(controller);};
        const body=new ReadableStream<Uint8Array>({
          async pull(out){try{const item=await reader.read();if(item.done){clean();out.close();}else{timer.refresh();out.enqueue(item.value);}}catch(error){clean();out.error(error);}},
          async cancel(){controller.abort();clean();await reader.cancel().catch(()=>{});},
        });
        return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
      }
      clearTimeout(timer);this.controllers.delete(controller);return response;
    } catch {clearTimeout(timer);this.controllers.delete(controller);throw new RemoteError('GUACAMOLE_UPSTREAM_FAILED',502);}
  }
  async connect(encryptedJson:string,sessionId:string,width=1280,height=800):Promise<void> {
    const response=await this.request('api/tokens',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({data:encryptedJson}).toString()},15_000);
    const auth:unknown=JSON.parse(await boundedText(response,16_384));
    const token=auth && typeof auth==='object' ? (auth as Record<string,unknown>).authToken : null;
    if(typeof token!=='string'||token.length>4096)throw new RemoteError('GUACAMOLE_AUTH_FAILED',502);
    const connected=await this.request('tunnel?connect',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({token,GUAC_ID:sessionId,GUAC_TYPE:'c',GUAC_DATA_SOURCE:'json',GUAC_WIDTH:String(width),GUAC_HEIGHT:String(height),GUAC_DPI:'96',GUAC_IMAGE:'image/png'}).toString()},20_000,true);
    const tunnelToken=connected.headers.get('Guacamole-Tunnel-Token');
    const id=(await boundedText(connected,128)).trim();
    if(!/^[a-f0-9-]{36}$/i.test(id)||!tunnelToken||tunnelToken.length>256)throw new RemoteError('GUACAMOLE_TUNNEL_INVALID',502);
    this.tunnelId=id;this.tunnelToken=tunnelToken;
    if(this.closed){await this.disconnectUpstream();throw new RemoteError('DESKTOP_SESSION_CLOSED',410);}
  }
  async read():Promise<Readable> {
    if(!this.tunnelId||!this.tunnelToken)throw new RemoteError('DESKTOP_NOT_CONNECTED',409);
    const response=await this.request(`tunnel?read:${this.tunnelId}:${this.readSequence++}`,{headers:{'Guacamole-Tunnel-Token':this.tunnelToken}},60_000);
    if(!response.ok||!response.body)throw new RemoteError('DESKTOP_TUNNEL_READ_FAILED',502);
    return Readable.fromWeb(response.body as never);
  }
  write(data:string):Promise<void> {
    const bytes=Buffer.byteLength(data);
    if(bytes>65_536||this.queuedBytes+bytes>262_144)throw new RemoteError('DESKTOP_BACKPRESSURE',413);
    this.queuedBytes+=bytes;
    const work=this.writes.then(async()=>{
      if(!this.tunnelId||!this.tunnelToken)throw new RemoteError('DESKTOP_NOT_CONNECTED',409);
      const response=await this.request(`tunnel?write:${this.tunnelId}`,{method:'POST',headers:{'Content-Type':'application/octet-stream','Guacamole-Tunnel-Token':this.tunnelToken},body:data},10_000);
      if(!response.ok)throw new RemoteError('DESKTOP_TUNNEL_WRITE_FAILED',502);
      await response.body?.cancel();
    }).finally(()=>{this.queuedBytes-=bytes;});
    this.writes=work.catch(()=>{});return work;
  }
  close():void {
    if(this.closed)return;
    this.closed=true;
    for(const controller of this.controllers)controller.abort();
    this.controllers.clear();
    for(const callback of this.consumers){try{callback();}catch{}}
    this.consumers.clear();
    void this.disconnectUpstream();
  }
  private async disconnectUpstream():Promise<void> {
    if(!this.tunnelId||!this.tunnelToken)return;
    // The protocol disconnect is supported by guacd; read abort additionally
    // makes GuacamoleHTTPTunnelServlet close/deregister on output IOException.
    try{await fetch(new URL(`tunnel?write:${this.tunnelId}`,this.settings.baseUrl),{method:'POST',redirect:'error',
      headers:{'Content-Type':'application/octet-stream','Guacamole-Tunnel-Token':this.tunnelToken},body:'10.disconnect;',signal:AbortSignal.timeout(2000)});}catch{}
    this.tunnelToken=undefined;this.tunnelId=undefined;
  }
}
