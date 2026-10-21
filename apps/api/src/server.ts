import { buildApp } from './app.js';
import { startAgentServer } from './modules/machines/agent-server.js';
const app=await buildApp({logger:true});
const agentApp=await startAgentServer(app.apiContext);
if(agentApp)app.addHook('onClose',async()=>{await agentApp.close();});
for(const signal of ['SIGTERM','SIGINT']as const)process.once(signal,()=>void app.close());
await app.listen({host:process.env.HOST||'127.0.0.1',port:Number(process.env.PORT||3000)});
