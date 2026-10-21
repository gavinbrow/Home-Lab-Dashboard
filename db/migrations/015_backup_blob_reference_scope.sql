-- Forward correction: backup archive hashes refer to external sealed storage.
-- Only explicit central blob_refs are retained in the central BlobStore registry.
CREATE OR REPLACE FUNCTION publish_metadata_blobs() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE document jsonb; owner text; digest text;
BEGIN
 IF TG_OP='DELETE' THEN document=to_jsonb(OLD); ELSE document=to_jsonb(NEW); END IF;
 owner=document->>'id';
 IF TG_TABLE_NAME='backup_runs' THEN document=jsonb_build_object('blob_refs',COALESCE(document#>'{manifest,blob_refs}','[]'::jsonb)); END IF;
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

UPDATE backup_runs SET manifest=manifest;
