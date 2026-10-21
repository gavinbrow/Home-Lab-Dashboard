import {writeFile}from'node:fs/promises';
import {createProviderAdapter,ProviderError}from'../src/index.js';
import {colorProbeImage}from'../src/images.js';
const[endpoint,model,output]=process.argv.slice(2);if(!endpoint||!model||!output||new URL(endpoint).hostname!=='127.0.0.1')throw new Error('Explicit isolated loopback endpoint,model,evidence output required');
const adapter=createProviderAdapter({id:'isolated',revision:1,adapter:'ollama',baseUrl:endpoint,runtimePoolId:'isolated',routing:'local',allowedAddresses:['127.0.0.1'],allowPrivateHttp:true,timeoutMs:30000},{resolveCredential:async()=>{throw new Error('No credentials permitted');}});
const evidence:any={scope:'actual text-only model image capability rejection; not vision-support proof',endpoint,model,observed_at:new Date().toISOString()};
try{for await(const _ of adapter.streamChat({model,messages:[{role:'user',content:'What color is the image?',images:[colorProbeImage('red')]}],thinking:false,maxOutputTokens:16})){}evidence.capability_state='request_accepted_not_verified';}
catch(error){evidence.capability_state='tested_fail';evidence.error_code=error instanceof ProviderError?error.code:'unknown';evidence.http_status=error instanceof ProviderError?error.status:null;}
await writeFile(output,JSON.stringify(evidence,null,2)+'\n');process.stdout.write(JSON.stringify(evidence)+'\n');
