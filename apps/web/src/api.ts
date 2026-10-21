import { useCallback, useEffect, useState } from 'react';
import type { ApiError } from '@homelab/contracts';
let csrfToken = '';
export const getCsrf = () => csrfToken;
export const setCsrf = (token: string) => { csrfToken = token; };
export class HttpError extends Error { constructor(public status:number,public code:string,message:string,public details?:unknown){ super(message+(details&&typeof details==='object'&&'outcome_unknown'in details&&(details as {outcome_unknown:unknown}).outcome_unknown?' Outcome unknown: retain this operation and reconcile it before attempting a new mutation.':'')+(details&&typeof details==='object'&&'rpc_id'in details&&typeof (details as {rpc_id:unknown}).rpc_id==='string'?' Host request ID: '+(details as {rpc_id:string}).rpc_id:'')); } }
export async function api<T>(path:string, init:RequestInit={}):Promise<T>{
 const headers = new Headers(init.headers); if(init.body) headers.set('Content-Type','application/json');
 if(init.method && !['GET','HEAD'].includes(init.method)) headers.set('X-CSRF-Token',csrfToken);
 const response=await fetch(path.startsWith('/health')||path.startsWith('/ready')?path:`/api/v1${path}`,{...init,headers,credentials:'same-origin'});
 if(!response.ok){if(response.status===401)window.dispatchEvent(new Event('homelab-session-expired'));const body=await response.json().catch(()=>null) as ApiError|null; throw new HttpError(response.status,body?.error?.code??'http_error',body?.error?.message??`Request failed (${response.status})`,body?.error?.details);}
 if(response.status===204)return undefined as T; return response.json() as Promise<T>;
}
export function useResource<T>(path:string|null){
 const [snapshot,setSnapshot]=useState<{path:string|null;data?:T;error?:Error;loading:boolean}>({path:null,loading:false}); const [version,setVersion]=useState(0);
 const reload=useCallback(()=>setVersion(n=>n+1),[]);
 useEffect(()=>{window.addEventListener('homelab-refresh-resources',reload);return()=>window.removeEventListener('homelab-refresh-resources',reload);},[reload]);
 useEffect(()=>{if(!path){setSnapshot({path:null,loading:false});return;}let alive=true;const controller=new AbortController();setSnapshot(previous=>({path,data:previous.path===path?previous.data:undefined,loading:true}));api<T>(path,{signal:controller.signal}).then(value=>{if(alive)setSnapshot({path,data:value,loading:false});}).catch(error=>{if(alive)setSnapshot(previous=>({path,data:previous.path===path?previous.data:undefined,error,loading:false}));});return()=>{alive=false;controller.abort();};},[path,version]);
 const current=snapshot.path===path;
 return {data:current?snapshot.data:undefined,error:current?snapshot.error:undefined,loading:!!path&&(!current||snapshot.loading),reload};
}
export const json = (value:unknown)=>JSON.stringify(value,null,2);
export const when = (value?:string|null)=>value?new Date(value).toLocaleString():'Not observed';
