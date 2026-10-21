ALTER TABLE runtime_control ADD COLUMN maintenance_job_id uuid REFERENCES jobs(id);
ALTER TABLE agent_rpc_requests ADD COLUMN maintenance_capture boolean NOT NULL DEFAULT false;
