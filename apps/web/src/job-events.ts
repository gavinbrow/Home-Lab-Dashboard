export type EventRecord={id:string;job_id?:string;sequence:string|number;type:string;timestamp:string;payload:unknown};
export function mergeEvents(previous:readonly EventRecord[],incoming:readonly EventRecord[],limit=1000):EventRecord[]{
 const unique=new Map(previous.map(event=>[event.id,event]));for(const event of incoming){if(/^[0-9]+$/.test(event.id)&&!unique.has(event.id))unique.set(event.id,event);}
 return [...unique.values()].sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:BigInt(a.id)>BigInt(b.id)?1:0).slice(-limit);
}
export function assistantTurns(events:readonly EventRecord[]){
 const turns=new Map<string,{id:string;text:string;completed:boolean;provenance?:unknown}>();
 for(const event of events){const payload=event.payload as Record<string,unknown>|null;if(!payload)continue;if(event.type==='assistant.delta'||event.type==='assistant.completed'){const id=String(payload.message_id??'assistant');const old=turns.get(id)??{id,text:'',completed:false};turns.set(id,{...old,text:event.type==='assistant.completed'&&typeof payload.text==='string'?payload.text:old.text+(event.type==='assistant.delta'?String(payload.text??''):''),completed:event.type==='assistant.completed'||old.completed,provenance:payload.provenance??old.provenance});}}
 return [...turns.values()];
}
