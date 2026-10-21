import type Guacamole from 'guacamole-common-js';
type GuacamoleApi=typeof Guacamole;
let pending:Promise<GuacamoleApi>|undefined;
export function loadGuacamole():Promise<GuacamoleApi> {
 const existing=(window as unknown as {Guacamole?:GuacamoleApi}).Guacamole;
 if(existing)return Promise.resolve(existing);
 if(!pending)pending=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/vendor/guacamole-common-js-1.6.0.js';script.async=true;script.onload=()=>{const api=(window as unknown as {Guacamole?:GuacamoleApi}).Guacamole;if(api)resolve(api);else reject(new Error('Local Guacamole client did not initialize.'));};script.onerror=()=>{pending=undefined;reject(new Error('Unable to load the pinned local Guacamole client.'));};document.head.appendChild(script);});
 return pending;
}
