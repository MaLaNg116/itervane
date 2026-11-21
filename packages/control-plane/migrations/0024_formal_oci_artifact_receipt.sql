CREATE FUNCTION itervane.guard_formal_rescan_artifact_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  requested jsonb;
  image jsonb;
  archive jsonb;
BEGIN
  IF NEW.state <> 'recorded' THEN
    RETURN NEW;
  END IF;
  SELECT document#>'{profile,retainStandardImage}' INTO STRICT requested
  FROM itervane.formal_verification_inputs WHERE run_id = NEW.run_id;
  image := NEW.receipt#>'{snapshot,build,baseline,image}';
  archive := image->'archive';
  IF NEW.receipt#>'{scope,retainStandardImage}' IS DISTINCT FROM requested THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'standard_artifact_scope_binding';
  END IF;
  IF requested = 'true'::jsonb AND image->>'status' = 'scanned' THEN
    IF (archive->>'format' = 'oci-layout-tar'
      AND archive->>'sha256' ~ '^[a-f0-9]{64}$'
      AND CASE WHEN jsonb_typeof(archive->'bytes') = 'number' THEN
        archive->>'bytes' ~ '^[1-9][0-9]{0,8}$' AND (archive->>'bytes')::numeric <= 209715200
      ELSE false END) IS NOT TRUE THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'standard_artifact_evidence_binding';
    END IF;
  ELSIF archive IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'unexpected_standard_artifact_evidence';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_rescan_artifact_scope BEFORE UPDATE ON itervane.formal_rescan_attempts
FOR EACH ROW EXECUTE FUNCTION itervane.guard_formal_rescan_artifact_scope();
