import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import type { Actor, JsonValue } from '@homelab/contracts';
import { authorize } from '@homelab/policy';
import type { WorkspaceFileAdapter } from '@homelab/storage';
import type { AgentBroker } from '@homelab/transport';
export interface SecretStore { put(ownerId:string, name:string, value:string):Promise<string>; get(ownerId:string,id:string):Promise<string>;rotate?:(ownerId:string,id:string,value:string,expectedVersion:number)=>Promise<number>; }
export interface ApiContext {
  db:Pool;
  secrets:SecretStore;
  policy:typeof authorize;
  workspaceFiles?:WorkspaceFileAdapter;
  agentBroker?:AgentBroker;
  config:{ origin:string; cookieSecure:boolean; artifactRoot:string; dispatchEnabled:boolean; restoreMode:boolean };
  audit:(actorId:string|null,action:string,target:string|null,outcome:string,details?:JsonValue)=>Promise<void>;
}
export type ApiModule = (app:FastifyInstance,context:ApiContext)=>Promise<void>;
declare module 'fastify' { interface FastifyRequest { actor:Actor|null; sessionId:string|null; } interface FastifyInstance {apiContext:ApiContext;} }
