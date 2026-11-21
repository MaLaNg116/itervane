-- Custom SQL migration file, put your code below! --
CREATE FUNCTION itervane.guard_formal_rescan_build_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  frozen jsonb;
  profile_sha text;
  proof jsonb;
BEGIN
  IF NEW.state <> 'recorded' THEN
    RETURN NEW;
  END IF;
  SELECT document INTO STRICT frozen
  FROM itervane.formal_verification_inputs WHERE run_id = NEW.run_id;
  profile_sha := frozen#>>'{profile,buildProfileSha256}';
  proof := NEW.receipt#>'{snapshot,build}';
  IF profile_sha IS NULL THEN
    IF proof IS NOT NULL OR NEW.receipt#>'{scope,buildProfileSha256}' IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'unexpected_standard_build_evidence';
    END IF;
  ELSIF (NEW.receipt#>>'{scope,buildProfileSha256}' = profile_sha
    AND proof->>'buildProfileSha256' = profile_sha
    AND proof->>'baselineSha256' = frozen#>>'{profile,baselineSha256}'
    AND proof->>'runId' = NEW.receipt->>'domainId'
    AND proof->>'verificationInputSha256' = NEW.input_sha256
    AND proof->>'subjectManifestSha256' = frozen#>>'{subject,manifestSha256}'
    AND CASE proof->>'status'
      WHEN 'built' THEN proof->'isolationVerified' = 'true'::jsonb AND proof#>>'{dist,sha256}' ~ '^[a-f0-9]{64}$'
      WHEN 'blocked' THEN proof->>'code' IN ('profile_unavailable', 'profile_mismatch', 'scan_incomplete', 'source_layout')
      WHEN 'failed' THEN proof->>'code' IN ('boundary_denied', 'input_invalid', 'offline_install', 'bundle_failed', 'deadline', 'output_invalid')
      ELSE false
    END) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'standard_build_evidence_binding';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_rescan_build_scope BEFORE UPDATE ON itervane.formal_rescan_attempts
FOR EACH ROW EXECUTE FUNCTION itervane.guard_formal_rescan_build_scope();
