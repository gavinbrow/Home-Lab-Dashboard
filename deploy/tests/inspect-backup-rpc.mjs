import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
const id=process.argv[2];if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('Exact fixture backup UUID required');
const db=new Pool({connectionString:(await readFile('/fixture/config/database-admin-url','utf8')).trim()});
try{
 const rows=(await db.query("SELECT id,path,state,response_status,response_body,delivery_count FROM agent_rpc_requests WHERE job_guard->>'job_id'=$1 ORDER BY created_at",[id])).rows;
 console.log(JSON.stringify(rows.map(row=>({id:row.id,path:row.path,state:row.state,status:row.response_status,deliveries:row.delivery_count,host_state:row.response_body?.state,host_machine:row.response_body?.machine_id,boot_id:row.response_body?.boot_id,capture_id:row.response_body?.id,reason:row.response_body?.reason,error_code:row.response_body?.error?.code})),null,2));
}finally{await db.end();}
