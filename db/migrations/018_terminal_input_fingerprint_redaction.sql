-- Public hashes and Ed25519 signatures of one-character input frames are
-- enumerable. Terminal delivery tombstones retain IDs/status, not those proofs.
-- Durable operation hashes for launched processes remain in operations.
UPDATE agent_rpc_requests SET request_hash='terminal-redacted:'||id::text,response_hash=CASE WHEN response_hash IS NULL THEN NULL ELSE 'terminal-redacted:'||id::text END,authorization_json='{"key_id":"terminal-redacted","signature":""}'::jsonb,body='null'::jsonb,response_body='null'::jsonb,payload_scrubbed_at=now(),payload_expires_at=now(),state=CASE WHEN state IN('queued','leased') THEN CASE WHEN delivery_count>0 THEN 'outcome_unknown' ELSE 'expired' END ELSE state END,lease_until=NULL WHERE sensitive_payload=true;
