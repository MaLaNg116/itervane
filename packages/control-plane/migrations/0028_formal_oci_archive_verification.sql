CREATE FUNCTION itervane.guard_formal_verification_archive() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM itervane.formal_verification_inputs input
    JOIN itervane.formal_rescan_attempts attempt ON attempt.run_id = input.run_id AND attempt.input_sha256 = input.sha256
    WHERE input.run_id = NEW.run_id AND input.sha256 = NEW.input_sha256
      AND attempt.request_id = NEW.request_id AND attempt.state = 'recorded' AND attempt.receipt_sha256 = NEW.receipt_sha256
      AND NEW.document->>'status' = 'reviewed' AND NEW.document#>>'{review,outcome}' = 'observed'
      AND NEW.document#>>'{archiveVerification,kind}' = 'archive_verified'
      AND NEW.document#>'{archiveVerification,version}' = '1'::jsonb
      AND NEW.document#>>'{archiveVerification,runnerImageSha256}' = input.document#>>'{profile,runnerImageSha256}'
      AND NEW.document#>>'{archiveVerification,runnerImageSha256}' = attempt.image_sha256
      AND NEW.document#>>'{evidence,image,status}' = 'scanned'
      AND pg_catalog.jsonb_typeof(NEW.document#>'{archiveVerification,archive}') = 'object'
      AND NEW.document#>'{archiveVerification,archive}' = NEW.document#>'{evidence,image,archive}'
      AND NEW.document#>'{archiveVerification,archive}' = attempt.receipt#>'{snapshot,build,baseline,image,archive}'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_verification_archive_binding';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_verification_archive_binding BEFORE INSERT ON itervane.formal_verification_results
FOR EACH ROW WHEN (NEW.document ? 'archiveVerification') EXECUTE FUNCTION itervane.guard_formal_verification_archive();
