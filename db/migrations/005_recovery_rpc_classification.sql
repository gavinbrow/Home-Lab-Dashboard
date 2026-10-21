ALTER TABLE agent_rpc_requests ADD COLUMN recovery_read boolean NOT NULL DEFAULT false;
ALTER TABLE agent_rpc_requests ADD COLUMN safety_cancel boolean NOT NULL DEFAULT false;
