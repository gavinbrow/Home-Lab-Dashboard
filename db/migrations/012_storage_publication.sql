CREATE TABLE blob_objects(hash text PRIMARY KEY CHECK(hash ~ '^[a-f0-9]{64}$'),size_bytes bigint NOT NULL DEFAULT 0 CHECK(size_bytes>=0),state text NOT NULL DEFAULT 'live' CHECK(state IN('live','quarantining','quarantined')),quarantine_path text,quarantined_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE blob_references(owner_kind text NOT NULL,owner_id text NOT NULL,hash text NOT NULL REFERENCES blob_objects(hash),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_kind,owner_id,hash));
CREATE INDEX blob_references_hash ON blob_references(hash);
CREATE FUNCTION guard_blob_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('homelab-blob:'||NEW.hash,0));
 IF NOT EXISTS(SELECT 1 FROM blob_objects WHERE hash=NEW.hash AND state='live') THEN RAISE EXCEPTION 'blob_not_live'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER blob_reference_guard BEFORE INSERT OR UPDATE ON blob_references FOR EACH ROW EXECUTE FUNCTION guard_blob_reference();
CREATE FUNCTION metadata_blob_hashes(value jsonb) RETURNS SETOF text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item record; child jsonb;
BEGIN
 IF jsonb_typeof(value)='array' THEN
  FOR child IN SELECT * FROM jsonb_array_elements(value) LOOP RETURN QUERY SELECT * FROM metadata_blob_hashes(child); END LOOP;
 ELSIF jsonb_typeof(value)='object' THEN
  FOR item IN SELECT * FROM jsonb_each(value) LOOP
   IF item.key IN('sha256','manifest_hash','before_hash','after_hash','blob_hash') AND jsonb_typeof(item.value)='string' AND (item.value#>>'{}') ~ '^[a-f0-9]{64}$' THEN RETURN NEXT item.value#>>'{}';
   ELSIF jsonb_typeof(item.value) IN('array','object') THEN RETURN QUERY SELECT * FROM metadata_blob_hashes(item.value); END IF;
  END LOOP;
 END IF;
END $$;
CREATE FUNCTION publish_metadata_blobs() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE document jsonb; owner text; digest text;
BEGIN
 IF TG_OP='DELETE' THEN document=to_jsonb(OLD); ELSE document=to_jsonb(NEW); END IF;
 owner=document->>'id';
 -- Lock all affected hashes in deterministic order, including old references.
 FOR digest IN SELECT hash FROM blob_references WHERE owner_kind=TG_TABLE_NAME AND owner_id=owner UNION SELECT * FROM metadata_blob_hashes(document) ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('homelab-blob:'||digest,0));
 END LOOP;
 DELETE FROM blob_references WHERE owner_kind=TG_TABLE_NAME AND owner_id=owner;
 IF TG_OP<>'DELETE' THEN
  FOR digest IN SELECT DISTINCT * FROM metadata_blob_hashes(document) ORDER BY 1 LOOP
   INSERT INTO blob_objects(hash) VALUES(digest) ON CONFLICT DO NOTHING;
   INSERT INTO blob_references(owner_kind,owner_id,hash) VALUES(TG_TABLE_NAME,owner,digest);
  END LOOP;
 END IF;
 RETURN NULL;
END $$;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['artifacts','checkpoints','attachments','log_segments','file_changes','messages','backup_runs'] LOOP
  EXECUTE format('CREATE TRIGGER publish_blob_refs AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION publish_metadata_blobs()',name);
  EXECUTE format('INSERT INTO blob_objects(hash) SELECT DISTINCT h FROM %I t CROSS JOIN LATERAL metadata_blob_hashes(to_jsonb(t)) h ON CONFLICT DO NOTHING',name);
  EXECUTE format('INSERT INTO blob_references(owner_kind,owner_id,hash) SELECT %L,t.id::text,h FROM %I t CROSS JOIN LATERAL metadata_blob_hashes(to_jsonb(t)) h ON CONFLICT DO NOTHING',name,name);
 END LOOP;
END $$;
CREATE TABLE upload_sessions(id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES users(id),workspace_id uuid NOT NULL REFERENCES workspaces(id),path text NOT NULL,expected_sha256 text,target_sha256 text NOT NULL,total_bytes bigint NOT NULL CHECK(total_bytes>=0),received_bytes bigint NOT NULL DEFAULT 0 CHECK(received_bytes>=0 AND received_bytes<=total_bytes),state text NOT NULL DEFAULT 'uploading',grant_id uuid NOT NULL REFERENCES permission_grants(id),operation_id uuid NOT NULL UNIQUE,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL);
CREATE TABLE upload_chunks(session_id uuid NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,"offset" bigint NOT NULL CHECK("offset">=0),size_bytes bigint NOT NULL CHECK(size_bytes>0),sha256 text NOT NULL,PRIMARY KEY(session_id,"offset"));
CREATE TABLE storage_recovery_reviews(id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES users(id),workspace_id uuid NOT NULL REFERENCES workspaces(id),original_operation_id uuid NOT NULL,expected_manifest_hash text NOT NULL,plan_hash text NOT NULL,expires_at timestamptz NOT NULL,used_at timestamptz,details jsonb NOT NULL DEFAULT '{}');
