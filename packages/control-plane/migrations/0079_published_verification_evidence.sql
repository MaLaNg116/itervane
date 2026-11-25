ALTER TABLE "itervane"."formal_rescan_attempts" DROP CONSTRAINT "formal_rescan_attempt_receipt";--> statement-breakpoint
ALTER TABLE "itervane"."formal_rescan_attempts" ADD CONSTRAINT "formal_rescan_attempt_receipt" CHECK ((("itervane"."formal_rescan_attempts"."state" <> 'recorded' AND "itervane"."formal_rescan_attempts"."receipt_sha256" IS NULL AND "itervane"."formal_rescan_attempts"."receipt" IS NULL) OR (
    "itervane"."formal_rescan_attempts"."state" = 'recorded' AND "itervane"."formal_rescan_attempts"."settled_fence" = "itervane"."formal_rescan_attempts"."fence" AND "itervane"."formal_rescan_attempts"."settled_worker_id" = "itervane"."formal_rescan_attempts"."worker_id"
    AND "itervane"."formal_rescan_attempts"."receipt_sha256" ~ '^[a-f0-9]{64}$' AND octet_length("itervane"."formal_rescan_attempts"."receipt"::text)
      <= CASE WHEN "itervane"."formal_rescan_attempts"."receipt"#>>'{scope,publishedCodeRuleSetSha256}' IS NULL THEN 9437184 ELSE 18874368 END
    AND "itervane"."formal_rescan_attempts"."receipt"->>'kind' = 'verification_receipt' AND "itervane"."formal_rescan_attempts"."receipt"->'cleanupConfirmed' = 'true'::jsonb
    AND "itervane"."formal_rescan_attempts"."receipt"->'sessionVerified' = 'true'::jsonb AND "itervane"."formal_rescan_attempts"."receipt"->>'originSha256' = "itervane"."formal_rescan_attempts"."origin_sha256"
    AND "itervane"."formal_rescan_attempts"."receipt"->>'imageSha256' = "itervane"."formal_rescan_attempts"."image_sha256" AND "itervane"."formal_rescan_attempts"."receipt"->>'domainId' = "itervane"."formal_rescan_attempts"."receipt"#>>'{snapshot,runId}'
    AND "itervane"."formal_rescan_attempts"."receipt"#>>'{scope,requestId}' = "itervane"."formal_rescan_attempts"."request_id"::text AND "itervane"."formal_rescan_attempts"."receipt"#>>'{scope,runId}' = "itervane"."formal_rescan_attempts"."run_id"::text
    AND "itervane"."formal_rescan_attempts"."receipt"#>>'{scope,fence}' = "itervane"."formal_rescan_attempts"."fence"::text AND "itervane"."formal_rescan_attempts"."receipt"#>>'{scope,workspaceSha256}' = "itervane"."formal_rescan_attempts"."workspace_sha256"
    AND "itervane"."formal_rescan_attempts"."receipt"#>>'{scope,verificationInputSha256}' = "itervane"."formal_rescan_attempts"."input_sha256"
    AND "itervane"."formal_rescan_attempts"."receipt"#>'{snapshot,offline}' = 'true'::jsonb AND "itervane"."formal_rescan_attempts"."receipt"#>'{snapshot,readOnly}' = 'true'::jsonb)) IS TRUE);
--> statement-breakpoint
CREATE FUNCTION itervane.guard_published_verification_input() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  inspection_code jsonb;
  binding jsonb := NEW.document->'publishedCode';
BEGIN
  SELECT scan.receipt#>'{snapshot,publishedCode,scan}' INTO inspection_code
  FROM itervane.inspection_attempts scan
  WHERE scan.run_id = NEW.run_id AND scan.state = 'recorded'
    AND scan.request_id::text = NEW.document#>>'{inspection,requestId}';
  IF NOT FOUND OR (binding IS NULL) <> (inspection_code IS NULL)
    OR (binding IS NOT NULL AND (
      jsonb_typeof(binding) = 'object'
      AND binding->>'snapshotSha256' = inspection_code#>>'{document,basis,snapshotSha256}'
      AND binding->>'inspectionScanSha256' = inspection_code->>'sha256'
      AND binding->>'ruleSetSha256' ~ '^[a-f0-9]{64}$'
      AND NOT jsonb_path_exists(inspection_code, '$.document.reports[*] ? (@.status == "unavailable")')
    ) IS NOT TRUE)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'published_verification_input_binding';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_verification_published_code BEFORE INSERT ON itervane.formal_verification_inputs
FOR EACH ROW EXECUTE FUNCTION itervane.guard_published_verification_input();
--> statement-breakpoint
CREATE FUNCTION itervane.guard_published_rescan_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  binding jsonb;
  inspection_domain text;
  proof jsonb := NEW.receipt#>'{snapshot,publishedCode}';
  scope_rule_set text := NEW.receipt#>>'{scope,publishedCodeRuleSetSha256}';
BEGIN
  SELECT input.document->'publishedCode', scan.receipt->>'domainId' INTO binding, inspection_domain
  FROM itervane.formal_verification_inputs input
  JOIN itervane.inspection_attempts scan ON scan.run_id = input.run_id AND scan.state = 'recorded'
    AND scan.request_id::text = input.document#>>'{inspection,requestId}'
  WHERE input.run_id = NEW.run_id AND input.sha256 = NEW.input_sha256;
  IF NOT FOUND OR scope_rule_set IS DISTINCT FROM binding->>'ruleSetSha256'
    OR (binding IS NULL) <> (proof IS NULL)
    OR (binding IS NOT NULL AND (
      proof#>>'{scan,document,basis,snapshotSha256}' = binding->>'snapshotSha256'
      AND proof#>>'{scan,document,basis,ruleSetSha256}' = scope_rule_set
      AND proof#>>'{scan,document,basis,manifestSha256}' = NEW.receipt#>>'{scope,targetManifestSha256}'
      AND proof#>>'{scan,document,basis,profile,runnerImageSha256}' = NEW.image_sha256
      AND NEW.receipt->>'domainId' <> inspection_domain
    ) IS NOT TRUE)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'published_rescan_evidence_binding';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_rescan_published_code BEFORE UPDATE ON itervane.formal_rescan_attempts
FOR EACH ROW WHEN (NEW.state = 'recorded') EXECUTE FUNCTION itervane.guard_published_rescan_evidence();
