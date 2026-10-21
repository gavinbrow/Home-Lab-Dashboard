import { defineConfig } from 'vite';
import { qaCounts } from './qa-counts';
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000';
export default defineConfig({plugins:process.env.HOMELAB_QA_COUNTS==='1'?[qaCounts()]:[],server:{port:5173,proxy:{'/api':{target:apiTarget,ws:true},'/healthz':apiTarget,'/readyz':apiTarget}},build:{outDir:'dist'}});
