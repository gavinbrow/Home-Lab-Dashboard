import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { runInNewContext } from 'node:vm';

interface Parser { oninstruction:((opcode:string,args:string[])=>void)|null;receive(data:string):void }
interface GuacamoleLibrary { Parser:{new():Parser;toInstruction(elements:string[]):string} }
let library:GuacamoleLibrary|undefined;
function officialParser():GuacamoleLibrary {
  if(!library){
    // The same reviewed Apache 1.6.0 artifact used by the browser. The VM has
    // no network, process or filesystem bindings; only Parser is instantiated.
    const sandbox:Record<string,unknown>={window:{}};
    runInNewContext(readFileSync(resolve('apps/web/public/vendor/guacamole-common-js-1.6.0.js'),'utf8'),sandbox,{timeout:1000});
    library=sandbox.Guacamole as GuacamoleLibrary;
  }
  return library;
}

/** Isolated test client only: ACK real sync frames so guacd idle handling
 * cannot masquerade as authoritative lease revocation during long tests. */
export function monitorGuacamoleFixture(reader:ReadableStreamDefaultReader<Uint8Array>,write:(data:string)=>Promise<void>){
  const guacamole=officialParser(),parser=new guacamole.Parser(),decoder=new StringDecoder('utf8');
  const state={closed:false,acknowledgements:0,lastAckAt:0,keepAlives:0,lastKeepAliveAt:0,readyAt:0,displayFrames:0,error:null as unknown};
  let readyResolve!:()=>void,readyReject!:(error:unknown)=>void,writes=Promise.resolve();
  const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  parser.oninstruction=(opcode,args)=>{
    if(opcode==='size'||opcode==='sync'){state.displayFrames++;if(!state.readyAt)state.readyAt=Date.now();readyResolve();}
    // Official Client.js1.6 replies with timestamp only; server frame-count
    // metadata is not reflected into the client sync instruction.
    if(opcode==='sync')writes=writes.then(()=>write(guacamole.Parser.toInstruction(['sync',args[0]]))).then(()=>{
      state.acknowledgements++;state.lastAckAt=Date.now();
    });
  };
  // Official Client.js1.6 sends nop every five seconds even when a quiet
  // display produces no new sync frames. Do not confuse silence with death.
  const keepAlive=setInterval(()=>{
    if(state.closed)return;
    writes=writes.then(()=>write(guacamole.Parser.toInstruction(['nop']))).then(()=>{
      state.keepAlives++;state.lastKeepAliveAt=Date.now();
    }).catch(error=>{state.error=error;void reader.cancel().catch(()=>{});throw error;});
    void writes.catch(()=>{});
  },5000);keepAlive.unref();
  const done=(async()=>{
    try{
      while(true){const item=await reader.read();if(item.done)break;parser.receive(decoder.write(Buffer.from(item.value)));await writes;}
    }catch(error){state.error=error;throw error;}
    finally{clearInterval(keepAlive);state.closed=true;if(!state.displayFrames)readyReject(state.error||new Error('Fixture closed before a display instruction'));}
  })();
  void ready.catch(()=>{});void done.catch(()=>{});
  return {state,ready,done};
}
