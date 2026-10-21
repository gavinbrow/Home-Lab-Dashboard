ALTER TABLE agent_certificates ADD COLUMN certificate_pem text;
ALTER TABLE agent_certificates ADD COLUMN public_key_fingerprint text;
ALTER TABLE agent_certificates ADD COLUMN fingerprint_sha256 text UNIQUE;
ALTER TABLE agent_certificates ADD COLUMN issued_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE machines ADD COLUMN last_seen_at timestamptz;
ALTER TABLE machines ADD COLUMN boot_id text;
ALTER TABLE machines ADD COLUMN agent_version text;
ALTER TABLE machines ADD COLUMN inventory jsonb NOT NULL DEFAULT '{}';
CREATE TABLE agent_boot_sequences(machine_id uuid NOT NULL REFERENCES machines(id),boot_id text NOT NULL,last_sequence bigint NOT NULL,last_observed_at timestamptz NOT NULL,PRIMARY KEY(machine_id,boot_id));
CREATE TABLE agent_telemetry_batches(machine_id uuid NOT NULL REFERENCES machines(id),boot_id text NOT NULL,sequence bigint NOT NULL,payload_hash text NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(machine_id,boot_id,sequence));
ALTER TABLE metric_samples ADD COLUMN collection_interval_seconds double precision;
ALTER TABLE metric_samples ADD COLUMN kind text NOT NULL DEFAULT 'gauge';
ALTER TABLE conversations ADD COLUMN archived_at timestamptz;
ALTER TABLE jobs ADD COLUMN previous_job_id uuid REFERENCES jobs(id);
ALTER TABLE runtime_control ADD COLUMN maintenance_mode boolean NOT NULL DEFAULT false;
ALTER TABLE provider_runtime_pools ADD COLUMN max_queue integer NOT NULL DEFAULT 100 CHECK(max_queue>=0);
CREATE TABLE agent_rpc_requests(
 id uuid PRIMARY KEY,machine_id uuid NOT NULL REFERENCES machines(id),request_hash text NOT NULL,
 method text NOT NULL CHECK(method IN ('GET','POST','PUT','DELETE')),path text NOT NULL,body jsonb,
 authorization_json jsonb NOT NULL,created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,dispatch_epoch uuid NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','leased','responded','expired','outcome_unknown')),
 lease_until timestamptz,delivery_count integer NOT NULL DEFAULT 0,
 response_status integer,response_body jsonb,response_hash text,responded_at timestamptz
);
CREATE INDEX agent_rpc_poll_idx ON agent_rpc_requests(machine_id,state,expires_at,created_at);
CREATE UNIQUE INDEX workspaces_registered_root_idx ON workspaces(machine_id,canonical_root) WHERE state<>'unregistered';
CREATE TABLE attachments(id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES users(id),conversation_id uuid REFERENCES conversations(id),workspace_id uuid REFERENCES workspaces(id),filename text NOT NULL,mime_type text NOT NULL,size_bytes bigint NOT NULL CHECK(size_bytes>=0),sha256 text NOT NULL,storage_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz);
