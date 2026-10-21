ALTER TABLE blob_objects ADD COLUMN last_published_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE upload_sessions ADD COLUMN commit_operation_id uuid;
ALTER TABLE upload_sessions ADD COLUMN details jsonb NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX upload_commit_operation ON upload_sessions(commit_operation_id) WHERE commit_operation_id IS NOT NULL;
-- Frozen admitted payloads and retained tool/inference evidence remain references
-- even when the original attachment metadata has subsequently been purged.
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['jobs','job_steps','inference_requests','operations'] LOOP
  EXECUTE format('CREATE TRIGGER publish_blob_refs AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION publish_metadata_blobs()',name);
  EXECUTE format('INSERT INTO blob_objects(hash) SELECT DISTINCT h FROM %I t CROSS JOIN LATERAL metadata_blob_hashes(to_jsonb(t)) h ON CONFLICT DO NOTHING',name);
  EXECUTE format('INSERT INTO blob_references(owner_kind,owner_id,hash) SELECT %L,t.id::text,h FROM %I t CROSS JOIN LATERAL metadata_blob_hashes(to_jsonb(t)) h ON CONFLICT DO NOTHING',name,name);
 END LOOP;
END $$;
