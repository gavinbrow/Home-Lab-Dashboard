import { useEffect, useRef, useState } from 'react';
import type GuacamoleType from 'guacamole-common-js';
import { loadGuacamole } from './guacamole-loader';
import { api, getCsrf } from './api';
import { Notice } from './App';
export type DesktopLaunch={id:string;ticket:string;expires_at:string;session_mode:string;session_mode_verified:boolean};
export function Desktop({launch,machine,onClose}:{launch:DesktopLaunch;machine:string;onClose:()=>void}) {
 const container=useRef<HTMLDivElement>(null);const[status,setStatus]=useState('Attaching authorized desktop session…');
 useEffect(()=>{
  let active=true;let client:InstanceType<typeof GuacamoleType.Client>|undefined;let keyboard:InstanceType<typeof GuacamoleType.Keyboard>|undefined;
  const resize=()=>{if(client&&container.current)client.sendSize(Math.max(320,Math.floor(container.current.clientWidth)),Math.max(240,Math.floor(container.current.clientHeight)));};
  loadGuacamole().then(async Guacamole=>{if(!active)return;const result=await api<{tunnel_path:string}>(`/desktop-sessions/${launch.id}/attach`,{method:'POST',body:JSON.stringify({ticket:launch.ticket,width:Math.max(320,Math.floor(container.current?.clientWidth??1024)),height:Math.max(240,Math.floor(container.current?.clientHeight??768))})});
   if(!active)return;const socket=new URL(`${result.tunnel_path}/websocket`,location.origin);socket.protocol=location.protocol==='https:'?'wss:':'ws:';
   const tunnel=new Guacamole.ChainedTunnel(new Guacamole.WebSocketTunnel(socket.href),new Guacamole.HTTPTunnel(`${result.tunnel_path}/http`,false,{'X-CSRF-Token':getCsrf()}));
   client=new Guacamole.Client(tunnel);const display=client.getDisplay().getElement();container.current?.appendChild(display);
   client.onerror=error=>setStatus(`Desktop error: ${error.message??error.code}`);client.onstatechange=state=>setStatus(({0:'Idle',1:'Connecting…',2:'Waiting for desktop…',3:'Connected',4:'Disconnecting…',5:'Disconnected'} as Record<number,string>)[state]??`Connection state ${state}`);
   const mouse=new Guacamole.Mouse(display);mouse.onmousedown=mouse.onmouseup=mouse.onmousemove=state=>client?.sendMouseState(state);
   keyboard=new Guacamole.Keyboard(container.current!);keyboard.onkeydown=keysym=>{client?.sendKeyEvent(1,keysym);return false;};keyboard.onkeyup=keysym=>client?.sendKeyEvent(0,keysym);
   client.connect('');resize();container.current?.focus();
  }).catch(e=>{if(active)setStatus((e as Error).message);});
  const observer=new ResizeObserver(resize);if(container.current)observer.observe(container.current);
  return()=>{active=false;observer.disconnect();keyboard?.reset();client?.disconnect();container.current?.replaceChildren();void api(`/desktop-sessions/${launch.id}/revoke`,{method:'POST'}).catch(()=>{});};
 },[launch]);
 return <section className="desktop-panel"><div className="panel-heading"><h3>{machine} · {launch.session_mode_verified?launch.session_mode.replaceAll('_',' '):'Session behavior unverified'}</h3><button onClick={onClose}>Disconnect desktop</button></div><Notice>{status}. {launch.session_mode_verified?'':'An operator must observe the local display before physical-screen or remote-session behavior can be verified.'}</Notice><div ref={container} tabIndex={0} className="desktop-display" aria-label={`Interactive desktop for ${machine}`}/><p className="small muted">Focus the desktop for keyboard input. Disconnect revokes this interactive session; it does not cancel durable jobs.</p></section>;
}
