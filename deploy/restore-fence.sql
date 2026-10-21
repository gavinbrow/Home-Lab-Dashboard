-- Apply before starting any restored API/worker. Authentication and dispatch
-- fences commit together; physical operation/writer uncertainty is preserved.
BEGIN;
UPDATE runtime_control SET dispatch_enabled=false,restore_mode=true,
 maintenance_mode=false,maintenance_job_id=NULL,dispatch_epoch=gen_random_uuid()
 WHERE singleton;
UPDATE agent_rpc_requests SET state='outcome_unknown',lease_until=NULL
 WHERE state IN ('queued','leased');
UPDATE sessions SET revoked_at=COALESCE(revoked_at,now());
UPDATE remote_sessions SET revoked_at=COALESCE(revoked_at,now()),state='closed',
 ticket_consumed_at=COALESCE(ticket_consumed_at,now());
UPDATE terminal_tickets SET consumed_at=COALESCE(consumed_at,now()),expires_at=LEAST(expires_at,now());
UPDATE terminal_sessions SET active_connection_id=NULL,fence=fence+1,
 state=CASE WHEN state='exited' THEN state ELSE 'outcome_unknown' END,
 metadata=metadata||jsonb_build_object('restore_previous_transport_state',state,'restore_transport_revoked_at',now(),'process_outcome_preserved',true),updated_at=now();
-- Terminal input fingerprints and signatures are enumerable for short inputs.
-- Keep ID/status tombstones, not original byte hashes, even for pre-018 sets.
UPDATE agent_rpc_requests SET body='null'::jsonb,response_body='null'::jsonb,
 request_hash='terminal-redacted:'||id::text,
 response_hash=CASE WHEN response_hash IS NULL THEN NULL ELSE 'terminal-redacted:'||id::text END,
 authorization_json='{"key_id":"terminal-redacted","signature":""}'::jsonb
 WHERE path ~ '^/v1/terminals(/|$)';
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='agent_rpc_requests' AND column_name='sensitive_payload') THEN
  EXECUTE 'UPDATE agent_rpc_requests SET sensitive_payload=true,payload_expires_at=now(),payload_scrubbed_at=now() WHERE path ~ ''^/v1/terminals(/|$)''';
 END IF;
END $$;
INSERT INTO audit_events(actor_id,action,target,outcome,details)
 VALUES(NULL,'restore.security_fence','runtime_control','success',
 '{"browser_sessions_revoked":true,"remote_sessions_closed":true,"terminal_tickets_consumed":true,"terminal_connections_detached":true,"operation_and_writer_state_preserved":true}'::jsonb);
COMMIT;
SELECT row_to_json(r) FROM runtime_control r WHERE singleton;
