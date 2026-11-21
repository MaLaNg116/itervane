CREATE FUNCTION itervane.guard_formal_rescan_image_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  requested jsonb;
  baseline jsonb;
  image jsonb;
BEGIN
  IF NEW.state <> 'recorded' THEN
    RETURN NEW;
  END IF;
  SELECT document#>'{profile,ociInputsSha256}' INTO STRICT requested
  FROM itervane.formal_verification_inputs WHERE run_id = NEW.run_id;
  baseline := NEW.receipt#>'{snapshot,build,baseline}';
  image := baseline->'image';
  IF NEW.receipt#>'{scope,ociInputsSha256}' IS DISTINCT FROM requested THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'standard_image_scope_binding';
  END IF;
  IF requested IS NOT NULL AND baseline->>'status' = 'passed' THEN
    IF (image->'ociInputsSha256' = requested
      AND image->'runtimeInputsSha256' = baseline->'runtimeInputsSha256'
      AND CASE image->>'status'
        WHEN 'blocked' THEN image->>'code' IN ('image_inputs', 'runtime_projection', 'image_compose', 'image_scan')
        WHEN 'scanned' THEN image->>'platform' = 'linux/amd64'
          AND image->>'manifestDigest' ~ '^sha256:[a-f0-9]{64}$'
          AND image->>'configDigest' ~ '^sha256:[a-f0-9]{64}$'
          AND image#>'{scan,imageDigest}' = image->'manifestDigest'
          AND image#>'{scan,configDigest}' = image->'configDigest'
          AND image#>'{scan,database}' = NEW.receipt#>'{snapshot,reports,1,database}'
        ELSE false
      END) IS NOT TRUE THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'standard_image_evidence_binding';
    END IF;
  ELSIF image IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'unexpected_standard_image_evidence';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_rescan_image_scope BEFORE UPDATE ON itervane.formal_rescan_attempts
FOR EACH ROW EXECUTE FUNCTION itervane.guard_formal_rescan_image_scope();
