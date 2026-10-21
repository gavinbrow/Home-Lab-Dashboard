ALTER TABLE jobs ADD COLUMN last_heartbeat_at timestamptz;
CREATE TABLE terminal_sessions (
 id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES users(id),workspace_id uuid NOT NULL REFERENCES workspaces(id),
 job_id uuid NOT NULL UNIQUE REFERENCES jobs(id),operation_id uuid REFERENCES operations(id),machine_id uuid NOT NULL REFERENCES machines(id),
 auth_session_id uuid NOT NULL REFERENCES sessions(id),state text NOT NULL DEFAULT 'queued',fence bigint NOT NULL DEFAULT 0,
 active_connection_id uuid,last_output_offset bigint NOT NULL DEFAULT 0 CHECK(last_output_offset>=0),metadata jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),ended_at timestamptz
);
CREATE TABLE terminal_tickets(id uuid PRIMARY KEY,terminal_id uuid NOT NULL REFERENCES terminal_sessions(id),auth_session_id uuid NOT NULL REFERENCES sessions(id),token_hash text NOT NULL UNIQUE,expires_at timestamptz NOT NULL,consumed_at timestamptz);
CREATE INDEX terminal_sessions_owner ON terminal_sessions(owner_id,created_at DESC);
