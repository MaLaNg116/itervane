CREATE TABLE "itervane"."formal_repair_retries" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"previous_run_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"prepared_fence" integer NOT NULL,
	"sha256" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "formal_repair_retry_run" UNIQUE("run_id"),
	CONSTRAINT "formal_repair_retry_binding" CHECK (("itervane"."formal_repair_retries"."prepared_fence" > 0 AND "itervane"."formal_repair_retries"."sha256" ~ '^[a-f0-9]{64}$'
    AND "itervane"."formal_repair_retries"."document"->>'version' = '1' AND "itervane"."formal_repair_retries"."document"->>'taskId' = "itervane"."formal_repair_retries"."task_id"::text AND "itervane"."formal_repair_retries"."document"->>'runId' = "itervane"."formal_repair_retries"."run_id"::text
    AND "itervane"."formal_repair_retries"."document"#>>'{previous,previousRunId}' = "itervane"."formal_repair_retries"."previous_run_id"::text AND "itervane"."formal_repair_retries"."previous_run_id" <> "itervane"."formal_repair_retries"."run_id"
    AND octet_length("itervane"."formal_repair_retries"."document"::text) <= 8192) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."project_members" ADD COLUMN "grant_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "itervane"."formal_repair_retries" ADD CONSTRAINT "formal_repair_retries_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "itervane"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."formal_repair_retries" ADD CONSTRAINT "formal_repair_retries_previous_run_id_formal_verification_results_run_id_fk" FOREIGN KEY ("previous_run_id") REFERENCES "itervane"."formal_verification_results"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."formal_repair_retries" ADD CONSTRAINT "formal_repair_retry_task_run_fk" FOREIGN KEY ("run_id","task_id") REFERENCES "itervane"."task_runs"("id","task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."project_members" ADD CONSTRAINT "project_member_grant" UNIQUE("grant_id");
--> statement-breakpoint
CREATE FUNCTION itervane.rotate_project_member_grant() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (NEW.project_id, NEW.principal_id, NEW.role) IS DISTINCT FROM (OLD.project_id, OLD.principal_id, OLD.role) THEN
    NEW.grant_id := pg_catalog.gen_random_uuid();
  ELSE
    NEW.grant_id := OLD.grant_id;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER project_member_grant_version BEFORE UPDATE ON itervane.project_members
FOR EACH ROW EXECUTE FUNCTION itervane.rotate_project_member_grant();
--> statement-breakpoint
CREATE FUNCTION itervane.guard_formal_repair_retry() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_repair_retry_is_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.execution_slot slot
    JOIN itervane.tasks task ON task.id = slot.task_id
    JOIN itervane.projects project ON project.id = task.project_id
    JOIN itervane.task_runs parent ON parent.id = slot.run_id AND parent.task_id = task.id
    JOIN itervane.task_runs child ON child.id = NEW.run_id AND child.task_id = task.id
    JOIN itervane.formal_verification_results result ON result.run_id = parent.id
    JOIN itervane.formal_verification_inputs input ON input.run_id = parent.id AND input.sha256 = result.input_sha256
    JOIN itervane.formal_repair_results repair ON repair.run_id = parent.id AND repair.sha256 = input.document#>>'{subject,resultSha256}'
    WHERE slot.id = 1 AND task.id = NEW.task_id AND task.state = 'running' AND parent.state = 'running'
      AND parent.id = NEW.previous_run_id AND parent.generation = task.generation
      AND child.generation = parent.generation + 1 AND child.role = 'audit' AND child.state = 'queued' AND child.wakeup_job_id IS NULL
      AND slot.fence = NEW.prepared_fence AND slot.worker_id = NEW.worker_id AND slot.lease_until > pg_catalog.clock_timestamp()
      AND result.document->>'status' = 'reviewed' AND result.finalized_fence = NEW.prepared_fence AND result.worker_id = NEW.worker_id
      AND NEW.document->>'projectId' = task.project_id::text AND NEW.document->>'generation' = child.generation::text
      AND NEW.document#>>'{source,repositoryId}' = task.repository_id::text AND NEW.document#>>'{source,commit}' = task.commit
      AND NEW.document->>'baseSnapshotSha256' = input.document#>>'{inspection,snapshotSha256}'
      AND NEW.document->>'catalogSha256' = input.document->>'catalogSha256'
      AND NEW.document#>>'{previous,verificationResultSha256}' = result.sha256
      AND NEW.document#>>'{previous,receiptSha256}' = result.receipt_sha256
      AND input.document#>>'{subject,kind}' = 'repair' AND repair.document->>'status' = 'candidate_ready'
      AND NEW.document#>>'{previous,candidateManifestSha256}' = input.document#>>'{subject,manifestSha256}'
      AND NEW.document#>>'{previous,patchSha256}' = input.document#>>'{subject,patchSha256}'
      AND NEW.document#>>'{previous,operationId}' = input.document#>>'{subject,operationId}'
      AND NEW.document#>>'{previous,patchShape,files}' = pg_catalog.jsonb_array_length(repair.document#>'{candidate,changes}')::text
      AND NEW.document#>>'{previous,failure,outcome}' = result.document#>>'{review,outcome}'
      AND (
        (result.document#>>'{review,outcome}' = 'source_findings'
          AND result.document#>>'{evidence,source,status}' = 'compared'
          AND (NEW.document#>'{previous,failure}') - 'outcome' = (result.document#>'{evidence,source}') - 'status')
        OR (result.document#>>'{review,outcome}' = 'checks_failed'
          AND (NEW.document#>'{previous,failure}') - 'outcome' = jsonb_build_object(
            'buildCode', CASE WHEN result.document#>>'{evidence,build,status}' = 'failed' THEN result.document#>>'{evidence,build,code}' END,
            'checks', CASE WHEN result.document#>>'{evidence,baseline,status}' = 'failed' THEN result.document#>'{evidence,baseline,failures}'
              ELSE '[]'::jsonb END))
      )
      AND (
        EXISTS (SELECT 1 FROM itervane.workspace_members owner
          WHERE owner.workspace_id = project.workspace_id AND owner.principal_id = task.requested_by AND owner.grant_id = NEW.grant_id)
        OR EXISTS (SELECT 1 FROM itervane.project_members member
          WHERE member.project_id = task.project_id AND member.principal_id = task.requested_by AND member.role = 'maintainer' AND member.grant_id = NEW.grant_id)
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_repair_retry_authority_or_evidence_mismatch';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_repair_retry_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.formal_repair_retries
FOR EACH ROW EXECUTE FUNCTION itervane.guard_formal_repair_retry();
