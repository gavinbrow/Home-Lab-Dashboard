import type { Plugin } from 'vite';
/** Opt-in, development-only aggregate counters. No headers, IDs, URLs or bodies retained. */
export function qaCounts():Plugin {
 const counts={api_total:0,machine_metrics:0,machine_inventory:0};
 return {name:'homelab-qa-counts',apply:'serve',configureServer(server){server.middlewares.use((request,response,next)=>{
  const path=request.url?.split('?')[0]??'';
  if(path==='/__qa/request-counts'){response.setHeader('Content-Type','application/json');response.setHeader('Cache-Control','no-store');response.end(JSON.stringify({as_of:new Date().toISOString(),counts}));return;}
  if(path.startsWith('/api/'))counts.api_total++;
  if(/^\/api\/v1\/machines\/[^/]+\/metrics$/.test(path))counts.machine_metrics++;
  if(path==='/api/v1/machines')counts.machine_inventory++;
  next();
 });}};
}
