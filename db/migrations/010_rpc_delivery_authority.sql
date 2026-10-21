ALTER TABLE agent_rpc_requests ADD COLUMN job_guard jsonb;
ALTER TABLE agent_rpc_requests ADD COLUMN workspace_guard jsonb;
ALTER TABLE agent_rpc_requests ADD COLUMN scope_grant_id uuid REFERENCES permission_grants(id);
ALTER TABLE agent_rpc_requests ADD COLUMN scope_tool text;
