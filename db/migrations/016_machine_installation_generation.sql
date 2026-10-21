ALTER TABLE machines ADD COLUMN identity_generation uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE agent_rpc_requests ADD COLUMN machine_identity_generation uuid;
-- Applied legacy envelopes have no trustworthy installation snapshot. Preserve
-- all receipts and ambiguous delivery evidence, and never silently rebind them.
UPDATE agent_rpc_requests SET state=CASE WHEN delivery_count>0 THEN 'outcome_unknown' ELSE 'expired' END,lease_until=NULL WHERE state IN('queued','leased');
