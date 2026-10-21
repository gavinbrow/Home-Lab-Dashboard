/** Server-clock orchestration intervals; host elapsed time is separate receipt evidence. */
export function jobTiming(job:any,events:{type:string;payload:any;created_at:Date|string}[],now=new Date()){
 const start=new Date(job.created_at).getTime(),end=job.ended_at?new Date(job.ended_at).getTime():now.getTime();
 const sums={queue_ms:0,active_ms:0,waiting_ms:0,unconfirmed_ms:0};let state='queued',at=start;
 const add=(until:number)=>{const elapsed=Math.max(0,Math.min(until,end)-at);if(state==='queued')sums.queue_ms+=elapsed;else if(state==='waiting')sums.waiting_ms+=elapsed;else if(state==='running'||state==='cancelling')sums.active_ms+=elapsed;at=Math.max(at,Math.min(until,end));};
 for(const event of events)if(event.type==='job.state'){add(new Date(event.created_at).getTime());state=event.payload.state;}
 const heartbeat=job.last_heartbeat_at?new Date(job.last_heartbeat_at).getTime():null,live=['running','cancelling'].includes(state)&&!job.ended_at;
 const confirmed=live&&heartbeat!==null&&now.getTime()-heartbeat<15000&&job.last_lease_until&&new Date(job.last_lease_until).getTime()>now.getTime();
 if(live&&!confirmed){add(Math.max(at,heartbeat??at));sums.unconfirmed_ms+=Math.max(0,end-at);at=end;}else add(end);
 for(const event of events)if(event.type==='job.uncertainty'){const gap=Math.max(0,new Date(event.payload.until).getTime()-new Date(event.payload.since).getTime()),shift=Math.min(gap,sums.active_ms);sums.active_ms-=shift;sums.unconfirmed_ms+=shift;}
 return {...sums,wall_ms:Math.max(0,end-start),as_of:now.toISOString(),last_verified_at:job.last_heartbeat_at??null,active_confirmed:!!confirmed,scope:'orchestration',host_process_duration_source:'operation_receipts'};
}
