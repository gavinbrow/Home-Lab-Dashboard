import { ModelPerformance } from './ModelPerformance';
import { useRef, useState, type FormEvent } from 'react';
import { api, json, useResource, when } from './api';
import { Empty, Notice, Panel, ResourceState } from './App';
import { JobDetail } from './Jobs';
import type { Provider, Model } from './Settings';
type Probe = { id:string;model_id:string;capability:string;state:string;effective_state?:string;validity?:{valid:boolean;state:string;reasons:string[];tested_at?:string;identity_age_seconds?:number};stale:boolean;created_at:string;details?:unknown };
type Observation = { model_id:string;kind:string;value:unknown;observed_at:string;source?:string;stale?:boolean;observed_age_seconds?:number };
export function Models() {
  const pendingRequests=useRef(new Map<string,string>());
  const providers = useResource<{items:Provider[]}>('/providers');
  const [providerId, setProviderId] = useState(''); const [query,setQuery]=useState(''); const [favoritesOnly,setFavoritesOnly]=useState(false);
  const [notice,setNotice]=useState(''); const [jobId,setJobId]=useState(''); const [busy,setBusy]=useState(false);
  const provider = providers.data?.items.find(p=>p.id===providerId);
  const models = useResource<{items:Model[]}>(providerId?`/providers/${providerId}/models`:null);
  const probes = useResource<{items:Probe[]}>(providerId?`/providers/${providerId}/capability-tests`:null);
  const observations = useResource<{items:Observation[]}>(providerId?`/providers/${providerId}/observations`:null);
  async function request(suffix:string, parameters:Record<string,unknown>={}) {
    const digest=JSON.stringify([providerId,suffix,parameters]);let key=pendingRequests.current.get(digest);if(!key){key=crypto.randomUUID();pendingRequests.current.set(digest,key);}setBusy(true); setNotice(''); try {
      const result=await api<{job_id:string;state:string}>(`/providers/${providerId}/${suffix}`,{method:'POST',body:JSON.stringify({idempotency_key:key,...parameters})});
      pendingRequests.current.delete(digest);setJobId(result.job_id); setNotice(`Accepted ${result.state} job. Follow its retained result below; acceptance does not establish success.`);
    } catch(e) { setNotice((e as Error).message); } finally {setBusy(false);}
  }
  async function favorite(model:Model) { try {await api(`/providers/${providerId}/favorites`,{method:'PUT',body:JSON.stringify({model_id:model.model_id,favorite:!model.favorite})});models.reload();}catch(e){setNotice((e as Error).message);} }
  async function manual(event:FormEvent<HTMLFormElement>) {event.preventDefault();const form=event.currentTarget;try{await api(`/providers/${providerId}/models/manual`,{method:'POST',body:JSON.stringify({model_id:new FormData(form).get('model_id')})});form.reset();models.reload();setNotice('Exact model ID registered. Availability and capabilities remain unverified until tested.');}catch(e){setNotice((e as Error).message);}}
  return <><Panel title="Models & runtime" action={<button onClick={()=>{models.reload();probes.reload();observations.reload();}} disabled={!providerId}>Refresh observations</button>}>
    <ResourceState resource={providers} empty={providers.data?.items.length===0}>
      <label className="range-label">Provider<select value={providerId} onChange={e=>{setProviderId(e.target.value);setJobId('');setNotice('');}}><option value="">Choose provider</option>{providers.data?.items.map(p=><option key={p.id} value={p.id}>{p.name} · {p.adapter}</option>)}</select></label>
    </ResourceState>
    {provider&&<><p className="mono small muted">{provider.endpoint} · revision {provider.revision} · processing {provider.routing_classification}</p><div className="toolbar"><button disabled={busy} onClick={()=>request('discover')}>Discover catalog</button><button disabled={busy} onClick={()=>request('runtime')}>Observe loaded models</button></div><Notice>Discovery does not run inference. Memory residency, request activity and catalog presence remain separate. Activity from other clients is unknown unless explicitly reported by the provider.</Notice>
    <div className="two-col"><label>Search exact IDs<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Filter catalog"/></label><label className="checkbox"><input type="checkbox" checked={favoritesOnly} onChange={e=>setFavoritesOnly(e.target.checked)}/>Favorites only</label></div>
    <ResourceState resource={models} empty={models.data?.items.length===0}><div className="model-grid">{models.data?.items.filter(m=>m.model_id.toLowerCase().includes(query.toLowerCase())&&(!favoritesOnly||m.favorite)).map(model=><article className="model-card" key={model.model_id}>
      <div className="panel-heading"><span className="eyebrow">EXACT MODEL ID</span><button aria-pressed={!!model.favorite} onClick={()=>favorite(model)}>{model.favorite?'★ Favorite':'☆ Favorite'}</button></div><h3>{model.model_id}</h3>
      <dl><dt>Catalog</dt><dd>{String(model.metadata?.catalog??'Unknown')}{model.catalog_stale&&<span className="badge stale">Stale catalog</span>}</dd><dt>Residency</dt><dd>{String(model.metadata?.residency??'Unknown')}</dd><dt>Observed</dt><dd>{when(model.observed_at)}</dd></dl>
      <details><summary>Capability evidence</summary>{probes.error&&<Notice tone="error">{probes.error.message}</Notice>}{probes.data?.items.filter(p=>p.model_id===model.model_id).map(probe=><div className="list-row" key={probe.id}><div><strong>{probe.capability}</strong><small>{when(probe.created_at)}</small>{probe.validity?.reasons.length? <small>{probe.validity.reasons.join('; ')}</small>:null}</div><span className={`badge ${probe.stale?'stale':probe.state}`}>{probe.effective_state??(probe.stale?'Stale historical result':probe.validity?.valid?probe.state:'Historical '+probe.state+' · current validity unavailable')}</span></div>)}<p className="small muted">Catalog claims: {json(model.capabilities??{})}. Claims do not substitute for probes.</p><div className="toolbar">{['basic_chat','streaming','tools','structured_output','image_input','cancellation'].map(capability=><button key={capability} disabled={busy} onClick={()=>request('capability-tests',{model_id:model.model_id,capability})}>{capability==='cancellation'?'Test client stop':`Test ${capability.replaceAll('_',' ')}`} </button>)}</div><p className="small muted">Explicit tests may load a model and consume compute.</p></details>
      <NativeManagement provider={provider} model={model} busy={busy} request={request}/>
    </article>)}</div></ResourceState>
    <details><summary>Register an exact model ID manually</summary><form className="inline-form" onSubmit={manual}><label>Exact provider model ID<input name="model_id" required maxLength={500}/></label><button>Register ID</button></form></details>
    <details><summary>Latest provider observations</summary><ResourceState resource={observations} empty={observations.data?.items.length===0}>{observations.data?.items.map((o,i)=><div key={i} className="list-row"><div><strong>{o.model_id} · {o.kind}</strong><small>{o.stale?'Stale observation · ':''}{when(o.observed_at)} · {o.source??'Provider observation'}</small><pre className="data-view">{json(o.value??o)}</pre></div></div>)}</ResourceState></details></>}
    {notice&&<Notice>{notice}</Notice>}
  </Panel>{providerId&&<ModelPerformance key={providerId} providerId={providerId}/ >}{jobId&&<JobDetail key={jobId} id={jobId}/>}</>;
}

function NativeManagement({provider,model,busy,request}:{provider:Provider;model:Model;busy:boolean;request:(suffix:string,parameters?:Record<string,unknown>)=>Promise<void>}) {
 const[instanceId,setInstanceId]=useState('');const[downloadId,setDownloadId]=useState('');
 return <details><summary>Native model management</summary>{['ollama','lm-studio'].includes(provider.adapter)?<><p className="small muted">Changes this provider. Dashboard reservations protect known requests; external clients may remain active. Cancellation probes establish client delivery stop, while provider termination stays separately unconfirmed.</p>{provider.adapter==='lm-studio'&&<label>Exact loaded instance ID for unload<input value={instanceId} onChange={e=>setInstanceId(e.target.value)} placeholder="Copy the observed loaded-instance ID"/></label>}<div className="toolbar"><button disabled={busy} onClick={()=>request('management',{action:'load',model_id:model.model_id})}>Load</button><button disabled={busy||(provider.adapter==='lm-studio'&&!instanceId)} onClick={()=>request('management',{action:'unload',model_id:model.model_id,...(instanceId?{instance_id:instanceId}:{})})}>Unload exact model / instance</button><button disabled={busy} onClick={()=>request('management',{action:'download',model_id:model.model_id})}>Download</button></div>{provider.adapter==='lm-studio'&&<><label>Native download job ID<input value={downloadId} onChange={e=>setDownloadId(e.target.value)}/></label><button disabled={busy||!downloadId} onClick={()=>request('management',{action:'download-status',download_job_id:downloadId})}>Check native download status</button></>}</>:<Notice>This adapter does not expose native load/unload/download operations.</Notice>}</details>;
}
