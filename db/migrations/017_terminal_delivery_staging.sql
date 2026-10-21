ALTER TABLE agent_rpc_requests ADD COLUMN sensitive_payload boolean NOT NULL DEFAULT false;
ALTER TABLE agent_rpc_requests ADD COLUMN payload_expires_at timestamptz;
ALTER TABLE agent_rpc_requests ADD COLUMN payload_scrubbed_at timestamptz;
CREATE INDEX terminal_delivery_expiry ON agent_rpc_requests(payload_expires_at) WHERE sensitive_payload=true AND payload_scrubbed_at IS NULL;
-- Existing terminal delivery caches were not covered by transcript opt-in.
-- Keep immutable digests, status, IDs and delivery evidence, not their bytes.
UPDATE agent_rpc_requests SET sensitive_payload=true,payload_expires_at=now(),payload_scrubbed_at=now(),body='null'::jsonb,response_body='null'::jsonb,state=CASE WHEN state IN('queued','leased') THEN CASE WHEN delivery_count>0 THEN 'outcome_unknown' ELSE 'expired' END ELSE state END,lease_until=NULL WHERE path ~ '^/v1/terminals(/|$)';
