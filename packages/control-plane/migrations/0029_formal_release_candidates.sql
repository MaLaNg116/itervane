CREATE TABLE "itervane"."formal_release_targets" (
	"environment_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"deployment_id" text NOT NULL,
	"revision" integer NOT NULL,
	"sha256" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "formal_release_target_deployment_unique" UNIQUE("deployment_id"),
	CONSTRAINT "formal_release_target_binding" CHECK (("itervane"."formal_release_targets"."revision" > 0 AND "itervane"."formal_release_targets"."sha256" ~ '^[a-f0-9]{64}$'
    AND "itervane"."formal_release_targets"."deployment_id" ~ '^[a-f0-9]{24}$' AND "itervane"."formal_release_targets"."document"->>'deploymentId' = "itervane"."formal_release_targets"."deployment_id"
    AND "itervane"."formal_release_targets"."document"->>'environmentId' = "itervane"."formal_release_targets"."environment_id"::text AND octet_length("itervane"."formal_release_targets"."document"::text) <= 4096) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."release_candidates" DROP CONSTRAINT "release_candidate_binding";--> statement-breakpoint
ALTER TABLE "itervane"."formal_release_targets" ADD CONSTRAINT "formal_release_target_environment_fk" FOREIGN KEY ("environment_id","project_id","application_id") REFERENCES "itervane"."environments"("id","project_id","application_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."release_candidates" ADD CONSTRAINT "release_candidate_binding" CHECK (("itervane"."release_candidates"."evidence_version" > 0 AND "itervane"."release_candidates"."fingerprint" ~ '^[a-f0-9]{64}$'
    AND "itervane"."release_candidates"."document"->>'version' = '1' AND "itervane"."release_candidates"."document"->>'origin' IN ('trusted_fixture', 'formal_verification')
    AND "itervane"."release_candidates"."document"->'releaseEligible' = 'false'::jsonb
    AND "itervane"."release_candidates"."document"->>'evidenceVersion' = "itervane"."release_candidates"."evidence_version"::text
    AND "itervane"."release_candidates"."document"->>'projectId' = "itervane"."release_candidates"."project_id"::text AND "itervane"."release_candidates"."document"->>'taskId' = "itervane"."release_candidates"."task_id"::text
    AND "itervane"."release_candidates"."document"->>'runId' = "itervane"."release_candidates"."run_id"::text
    AND "itervane"."release_candidates"."document"#>>'{target,applicationId}' = "itervane"."release_candidates"."application_id"::text
    AND "itervane"."release_candidates"."document"#>>'{target,environmentId}' = "itervane"."release_candidates"."environment_id"::text
    AND octet_length("itervane"."release_candidates"."document"::text) <= 8192) IS TRUE);
--> statement-breakpoint
CREATE FUNCTION itervane.guard_release_target_revision() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.revision = 1 THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE'
    AND (NEW.environment_id, NEW.project_id, NEW.application_id, NEW.created_at)
      IS NOT DISTINCT FROM (OLD.environment_id, OLD.project_id, OLD.application_id, OLD.created_at)
    AND NEW.revision = OLD.revision + 1 AND NEW.sha256 <> OLD.sha256 AND NEW.document <> OLD.document THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_target_revision';
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_release_target_revision BEFORE INSERT OR UPDATE OR DELETE ON itervane.formal_release_targets
FOR EACH ROW EXECUTE FUNCTION itervane.guard_release_target_revision();
--> statement-breakpoint
CREATE FUNCTION itervane.guard_formal_release_candidate() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM itervane.tasks task
    JOIN itervane.task_runs run ON run.task_id = task.id AND run.generation = task.generation AND run.id = NEW.run_id
    JOIN itervane.run_runtime runtime ON runtime.run_id = run.id AND runtime.task_id = task.id
    JOIN itervane.formal_verification_results result ON result.run_id = run.id
    JOIN itervane.formal_verification_inputs input ON input.run_id = run.id AND input.sha256 = result.input_sha256
    JOIN itervane.formal_release_targets target ON target.environment_id = NEW.environment_id
      AND target.project_id = task.project_id AND target.application_id = NEW.application_id
    WHERE task.id = NEW.task_id AND task.project_id = NEW.project_id AND task.requested_by = NEW.requested_by
      AND ((task.state = 'waiting_input' AND runtime.reason = 'verification_observed')
        OR (task.state = 'waiting_approval' AND runtime.reason = 'release_candidate_ready'))
      AND run.state = task.state AND run.generation::text = NEW.document->>'generation'
      AND task.repository_id::text = NEW.document#>>'{source,repositoryId}' AND task.commit = NEW.document#>>'{source,commit}'
      AND result.document->>'status' = 'reviewed' AND result.document#>>'{review,outcome}' = 'observed'
      AND result.document#>>'{archiveVerification,kind}' = 'archive_verified'
      AND result.document#>>'{evidence,source,status}' = 'compared' AND result.document#>>'{evidence,build,status}' = 'built'
      AND result.document#>>'{evidence,baseline,status}' = 'passed' AND result.document#>>'{evidence,image,status}' = 'scanned'
      AND result.sha256 = NEW.document#>>'{verification,resultSha256}'
      AND result.receipt_sha256 = NEW.document#>>'{verification,receiptSha256}'
      AND input.sha256 = NEW.document#>>'{verification,inputSha256}'
      AND input.document->>'catalogSha256' = NEW.document#>>'{verification,catalogSha256}'
      AND input.document#>>'{inspection,snapshotSha256}' = NEW.document->>'originalSnapshotSha256'
      AND input.document#>>'{subject,manifestSha256}' = NEW.document->>'repairedSnapshotSha256'
      AND COALESCE(input.document#>'{subject,patchSha256}', 'null'::jsonb) = NEW.document->'diffSha256'
      AND result.document#>'{evidence,source,introduced}' = '0'::jsonb AND result.document#>'{evidence,source,remaining}' = '0'::jsonb
      AND NEW.document#>'{verification,source}' = (result.document#>'{evidence,source}') - 'status'
      AND NEW.document#>>'{verification,buildSha256}' = result.document#>>'{evidence,build,distSha256}'
      AND NEW.document#>>'{verification,baselineSha256}' = result.document#>>'{evidence,baseline,baselineSha256}'
      AND NEW.document#>>'{image,manifestDigest}' = result.document#>>'{evidence,image,manifestDigest}'
      AND NEW.document#>>'{image,configDigest}' = result.document#>>'{evidence,image,configDigest}'
      AND NEW.document#>>'{image,scanReportSha256}' = result.document#>>'{evidence,image,scanReportSha256}'
      AND NEW.document#>>'{image,scanPolicySha256}' = result.document#>>'{evidence,image,scanPolicySha256}'
      AND NEW.document#>'{image,findings}' = result.document#>'{evidence,image,findings}'
      AND NEW.document#>'{image,archive}' = result.document#>'{archiveVerification,archive}'
      AND NEW.document#>>'{image,runnerImageSha256}' = result.document#>>'{archiveVerification,runnerImageSha256}'
      AND target.revision::text = NEW.document#>>'{target,revision}' AND target.sha256 = NEW.document#>>'{target,mappingSha256}'
      AND target.document->>'verificationProfileSha256' = NEW.document#>>'{verification,profileSha256}'
      AND target.document->>'runtimeConfigSha256' = NEW.document->>'runtimeConfigSha256'
      AND target.document->>'rolloutCheckSha256' = NEW.document->>'rolloutCheckSha256'
      AND target.document->>'recoveryPlanSha256' = NEW.document->>'recoveryPlanSha256'
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements_text(target.document->'blockImageSeverities') AS blocker(severity)
        WHERE ((result.document#>'{evidence,image,findings}')->>blocker.severity)::integer > 0
      )
      AND (NEW.document->>'validUntil')::timestamptz > pg_catalog.clock_timestamp()
      AND (NEW.document->>'validUntil')::timestamptz <= NEW.created_at
        + pg_catalog.make_interval(secs => (target.document->>'approvalTtlSeconds')::integer)
      AND (NEW.document->>'validUntil')::timestamptz <= result.created_at
        + pg_catalog.make_interval(secs => (target.document->>'verificationMaxAgeSeconds')::integer)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_candidate_binding';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_release_candidate_binding BEFORE INSERT ON itervane.release_candidates
FOR EACH ROW WHEN (NEW.document->>'origin' = 'formal_verification') EXECUTE FUNCTION itervane.guard_formal_release_candidate();
