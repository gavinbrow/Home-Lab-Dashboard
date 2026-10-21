import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const password=readFileSync('/run/secrets/postgres_admin_password','utf8').trim();
const env={...process.env,HOMELAB_LOCAL_PG_URL:`postgresql://postgres:${encodeURIComponent(password)}@postgres:5432/postgres`};
const result=spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','--test',
  'apps/api/src/modules/remote/gateway.test.ts'],{env,stdio:'inherit'});
process.exit(result.status??1);
