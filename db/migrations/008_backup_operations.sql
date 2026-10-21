ALTER TABLE backup_runs ADD COLUMN owner_id uuid REFERENCES users(id);
ALTER TABLE backup_runs ADD COLUMN job_id uuid UNIQUE REFERENCES jobs(id);
ALTER TABLE backup_runs ADD COLUMN started_at timestamptz;
ALTER TABLE backup_runs ADD COLUMN completed_at timestamptz;
ALTER TABLE restore_runs ADD COLUMN owner_id uuid REFERENCES users(id);
ALTER TABLE restore_runs ADD COLUMN job_id uuid UNIQUE REFERENCES jobs(id);
ALTER TABLE restore_runs ADD COLUMN started_at timestamptz;
ALTER TABLE restore_runs ADD COLUMN completed_at timestamptz;
CREATE TABLE backup_destinations(id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES users(id),name text NOT NULL,kind text NOT NULL CHECK(kind IN ('restic-local','restic-remote')),repository_ref text NOT NULL,password_ref uuid REFERENCES secrets(id),config jsonb NOT NULL DEFAULT '{}',enabled boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now());
