-- Custom SQL migration file, put your code below! --
CREATE FUNCTION itervane.guard_formal_rescan_baseline_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  requested jsonb;
  build jsonb;
  proof jsonb;
BEGIN
  IF NEW.state <> 'recorded' THEN
    RETURN NEW;
  END IF;
  SELECT document#>'{profile,runStandardBaseline}' INTO STRICT requested
  FROM itervane.formal_verification_inputs WHERE run_id = NEW.run_id;
  build := NEW.receipt#>'{snapshot,build}';
  proof := build->'baseline';
  IF NEW.receipt#>'{scope,runStandardBaseline}' IS DISTINCT FROM requested THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'standard_baseline_scope_binding';
  END IF;
  IF requested = 'true'::jsonb AND build->>'status' = 'built' THEN
    IF (proof->>'baselineSha256' = build->>'baselineSha256'
      AND proof->>'distSha256' = build#>>'{dist,sha256}'
      AND CASE proof->>'status'
        WHEN 'blocked' THEN proof->>'code' IN ('runtime_preparation', 'runtime_start', 'baseline_unavailable', 'runtime_cleanup_unproven')
        WHEN 'passed' THEN proof->'appExited' = 'true'::jsonb AND proof->>'runtimeInputsSha256' ~ '^[a-f0-9]{64}$'
        WHEN 'failed' THEN proof->'appExited' = 'true'::jsonb AND proof->>'runtimeInputsSha256' ~ '^[a-f0-9]{64}$'
        ELSE false
      END) IS NOT TRUE THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'standard_baseline_evidence_binding';
    END IF;
  ELSIF proof IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'unexpected_standard_baseline_evidence';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_rescan_baseline_scope BEFORE UPDATE ON itervane.formal_rescan_attempts
FOR EACH ROW EXECUTE FUNCTION itervane.guard_formal_rescan_baseline_scope();
