ALTER TABLE workspace_locks ADD COLUMN rpc_id uuid REFERENCES agent_rpc_requests(id);
