ALTER TABLE "itervane"."inspection_attempts" DROP CONSTRAINT "inspection_attempt_receipt_binding";--> statement-breakpoint
ALTER TABLE "itervane"."inspection_attempts" ADD COLUMN "published_code" jsonb;--> statement-breakpoint
ALTER TABLE "itervane"."inspection_attempts" ADD CONSTRAINT "inspection_attempt_published_code_binding" CHECK ((("itervane"."inspection_attempts"."published_code" IS NULL OR (
    "itervane"."inspection_attempts"."published_code"->>'snapshotSha256' ~ '^[a-f0-9]{64}$'
    AND "itervane"."inspection_attempts"."published_code"#>>'{binding,commandSha256}' ~ '^[a-f0-9]{64}$'
    AND "itervane"."inspection_attempts"."published_code"#>>'{binding,runnerImageSha256}' = "itervane"."inspection_attempts"."image_sha256"
    AND "itervane"."inspection_attempts"."published_code"#>>'{profile,runnerImageSha256}' = "itervane"."inspection_attempts"."image_sha256"
    AND "itervane"."inspection_attempts"."published_code"#>>'{profile,engine}' = 'semgrep_ce'
    AND "itervane"."inspection_attempts"."published_code"#>>'{profile,engineInputsSha256}' ~ '^[a-f0-9]{64}$'
    AND octet_length("itervane"."inspection_attempts"."published_code"::text) <= 2048))
    AND ("itervane"."inspection_attempts"."state" <> 'recorded' OR ("itervane"."inspection_attempts"."receipt"#>'{scope,publishedCode}' IS NOT DISTINCT FROM "itervane"."inspection_attempts"."published_code"->'binding'
      AND "itervane"."inspection_attempts"."receipt"#>>'{snapshot,publishedCode,commandSha256}' IS NOT DISTINCT FROM "itervane"."inspection_attempts"."published_code"#>>'{binding,commandSha256}'
      AND "itervane"."inspection_attempts"."receipt"#>>'{snapshot,publishedCode,scan,document,basis,snapshotSha256}' IS NOT DISTINCT FROM "itervane"."inspection_attempts"."published_code"->>'snapshotSha256'))) IS TRUE);--> statement-breakpoint
ALTER TABLE "itervane"."inspection_attempts" ADD CONSTRAINT "inspection_attempt_receipt_binding" CHECK ((
    ("itervane"."inspection_attempts"."state" <> 'recorded' AND "itervane"."inspection_attempts"."receipt" IS NULL AND "itervane"."inspection_attempts"."receipt_sha256" IS NULL)
    OR ("itervane"."inspection_attempts"."state" = 'recorded' AND "itervane"."inspection_attempts"."settled_fence" = "itervane"."inspection_attempts"."fence" AND "itervane"."inspection_attempts"."receipt_sha256" ~ '^[a-f0-9]{64}$'
      AND octet_length("itervane"."inspection_attempts"."receipt"::text) <= CASE WHEN "itervane"."inspection_attempts"."published_code" IS NULL THEN 4202496 ELSE 13631488 END
      AND "itervane"."inspection_attempts"."receipt"->>'kind' = 'receipt' AND "itervane"."inspection_attempts"."receipt"->'cleanupConfirmed' = 'true'::jsonb
      AND "itervane"."inspection_attempts"."receipt"->'sessionVerified' = 'true'::jsonb AND "itervane"."inspection_attempts"."receipt"->>'originSha256' = "itervane"."inspection_attempts"."origin_sha256"
      AND "itervane"."inspection_attempts"."receipt"->>'imageSha256' = "itervane"."inspection_attempts"."image_sha256"
      AND "itervane"."inspection_attempts"."receipt"#>>'{scope,requestId}' = "itervane"."inspection_attempts"."request_id"::text
      AND "itervane"."inspection_attempts"."receipt"#>>'{scope,taskId}' = "itervane"."inspection_attempts"."task_id"::text AND "itervane"."inspection_attempts"."receipt"#>>'{scope,runId}' = "itervane"."inspection_attempts"."run_id"::text
      AND "itervane"."inspection_attempts"."receipt"#>>'{scope,projectId}' = "itervane"."inspection_attempts"."project_id"::text AND "itervane"."inspection_attempts"."receipt"#>>'{scope,repositoryId}' = "itervane"."inspection_attempts"."repository_id"::text
      AND "itervane"."inspection_attempts"."receipt"#>>'{scope,commit}' = "itervane"."inspection_attempts"."commit" AND "itervane"."inspection_attempts"."receipt"#>>'{scope,planSha256}' = "itervane"."inspection_attempts"."plan_sha256"
      AND "itervane"."inspection_attempts"."receipt"#>>'{scope,fence}' = "itervane"."inspection_attempts"."fence"::text AND "itervane"."inspection_attempts"."receipt"#>>'{scope,generation}' = "itervane"."inspection_attempts"."generation"::text
      AND "itervane"."inspection_attempts"."receipt"->>'domainId' = "itervane"."inspection_attempts"."receipt"#>>'{snapshot,runId}'
      AND "itervane"."inspection_attempts"."receipt"#>>'{snapshot,repositoryId}' = "itervane"."inspection_attempts"."repository_id"::text AND "itervane"."inspection_attempts"."receipt"#>>'{snapshot,commit}' = "itervane"."inspection_attempts"."commit"
      AND "itervane"."inspection_attempts"."receipt"#>'{snapshot,offline}' = 'true'::jsonb AND "itervane"."inspection_attempts"."receipt"#>'{snapshot,readOnly}' = 'true'::jsonb)
  ) IS TRUE);
--> statement-breakpoint
CREATE FUNCTION itervane.guard_inspection_published_code() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  pinned_sha256 text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.published_code IS DISTINCT FROM OLD.published_code THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inspection_published_code_is_immutable';
    END IF;
    RETURN NEW;
  END IF;
  SELECT snapshot.sha256 INTO pinned_sha256
  FROM itervane.task_rule_snapshots snapshot
  WHERE snapshot.task_id = NEW.task_id AND snapshot.project_id = NEW.project_id AND snapshot.purpose = 'delivery'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(snapshot.document->'entries') entry WHERE entry->>'kind' = 'code_rule');
  IF pinned_sha256 IS DISTINCT FROM NEW.published_code->>'snapshotSha256' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inspection_published_code_snapshot_binding';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER inspection_attempt_published_code BEFORE INSERT OR UPDATE ON itervane.inspection_attempts
FOR EACH ROW EXECUTE FUNCTION itervane.guard_inspection_published_code();
