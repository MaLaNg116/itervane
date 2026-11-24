CREATE TABLE "itervane"."candidate_validation_admissions" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"plan_sha256" text NOT NULL,
	"plan" jsonb NOT NULL,
	CONSTRAINT "candidate_validation_plan" CHECK (("itervane"."candidate_validation_admissions"."plan_sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."candidate_validation_admissions"."plan"->>'version' = '1'
    AND "itervane"."candidate_validation_admissions"."plan"->>'candidateId' = "itervane"."candidate_validation_admissions"."candidate_id"::text AND "itervane"."candidate_validation_admissions"."plan"->>'candidateSha256' ~ '^[a-f0-9]{64}$'
    AND "itervane"."candidate_validation_admissions"."plan"->>'extractionResultSha256' ~ '^[a-f0-9]{64}$' AND "itervane"."candidate_validation_admissions"."plan"->>'kind' IN ('code_rule', 'runbook')
    AND octet_length("itervane"."candidate_validation_admissions"."plan"::text) <= 4096) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "itervane"."candidate_validation_attempts" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"fence" integer NOT NULL,
	"worker_id" uuid NOT NULL,
	"plan_sha256" text NOT NULL,
	"request" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_validation_attempt_run_fence" UNIQUE("run_id","fence"),
	CONSTRAINT "candidate_validation_attempt_binding" CHECK (("itervane"."candidate_validation_attempts"."plan_sha256" ~ '^[a-f0-9]{64}$'
    AND "itervane"."candidate_validation_attempts"."request"->>'requestId' = "itervane"."candidate_validation_attempts"."request_id"::text AND "itervane"."candidate_validation_attempts"."request"->>'runId' = "itervane"."candidate_validation_attempts"."run_id"::text
    AND "itervane"."candidate_validation_attempts"."request"->>'fence' = "itervane"."candidate_validation_attempts"."fence"::text AND "itervane"."candidate_validation_attempts"."fence" > 0
    AND "itervane"."candidate_validation_attempts"."request"->>'version' = '1' AND "itervane"."candidate_validation_attempts"."request"->>'operation' = 'validate_rule_samples'
    AND "itervane"."candidate_validation_attempts"."request"->>'basisSha256' ~ '^[a-f0-9]{64}$' AND "itervane"."candidate_validation_attempts"."request"->>'commandSha256' ~ '^[a-f0-9]{64}$'
    AND octet_length("itervane"."candidate_validation_attempts"."request"::text) <= 4096) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "itervane"."candidate_validation_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"request_id" uuid,
	"plan_sha256" text NOT NULL,
	"sha256" text NOT NULL,
	"fence" integer NOT NULL,
	"worker_id" uuid NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_validation_result_run" UNIQUE("run_id"),
	CONSTRAINT "candidate_validation_result_binding" CHECK (("itervane"."candidate_validation_results"."fence" > 0 AND "itervane"."candidate_validation_results"."plan_sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."candidate_validation_results"."sha256" ~ '^[a-f0-9]{64}$'
    AND "itervane"."candidate_validation_results"."document"->>'version' = '1' AND "itervane"."candidate_validation_results"."document"->>'candidateId' = "itervane"."candidate_validation_results"."candidate_id"::text
    AND "itervane"."candidate_validation_results"."document"->>'runId' = "itervane"."candidate_validation_results"."run_id"::text AND "itervane"."candidate_validation_results"."document"->>'projectId' = "itervane"."candidate_validation_results"."project_id"::text
    AND "itervane"."candidate_validation_results"."document"->>'planSha256' = "itervane"."candidate_validation_results"."plan_sha256" AND "itervane"."candidate_validation_results"."document"->>'status' IN ('passed', 'failed', 'unavailable')
    AND CASE WHEN "itervane"."candidate_validation_results"."document"#>>'{evidence,kind}' = 'code_rule'
      THEN "itervane"."candidate_validation_results"."request_id" IS NOT NULL AND "itervane"."candidate_validation_results"."document"#>>'{evidence,receipt,scope,requestId}' = "itervane"."candidate_validation_results"."request_id"::text
      ELSE "itervane"."candidate_validation_results"."request_id" IS NULL AND "itervane"."candidate_validation_results"."document"#>>'{evidence,kind}' = 'runbook'
    END AND octet_length("itervane"."candidate_validation_results"."document"::text) <= 16384) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."candidate_validation_admissions" ADD CONSTRAINT "candidate_validation_admissions_candidate_id_rule_extraction_results_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "itervane"."rule_extraction_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."candidate_validation_admissions" ADD CONSTRAINT "candidate_validation_admission_task_fk" FOREIGN KEY ("task_id","project_id") REFERENCES "itervane"."tasks"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."candidate_validation_admissions" ADD CONSTRAINT "candidate_validation_admission_run_fk" FOREIGN KEY ("run_id","task_id") REFERENCES "itervane"."task_runs"("id","task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."candidate_validation_attempts" ADD CONSTRAINT "candidate_validation_attempts_run_id_candidate_validation_admissions_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."candidate_validation_admissions"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."candidate_validation_results" ADD CONSTRAINT "candidate_validation_results_run_id_candidate_validation_admissions_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."candidate_validation_admissions"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."candidate_validation_results" ADD CONSTRAINT "candidate_validation_results_candidate_id_rule_extraction_results_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "itervane"."rule_extraction_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."candidate_validation_results" ADD CONSTRAINT "candidate_validation_results_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "itervane"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."candidate_validation_results" ADD CONSTRAINT "candidate_validation_results_request_id_candidate_validation_attempts_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "itervane"."candidate_validation_attempts"("request_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "candidate_validation_result_candidate" ON "itervane"."candidate_validation_results" USING btree ("project_id","candidate_id","created_at","id");
--> statement-breakpoint
CREATE FUNCTION itervane.guard_candidate_validation_admission() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'candidate_validation_admission_is_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.task_runs run JOIN itervane.tasks task ON task.id = run.task_id
    JOIN itervane.rule_extraction_results candidate ON candidate.id = NEW.candidate_id AND candidate.project_id = task.project_id
    JOIN itervane.tasks source ON source.id::text = candidate.document->>'taskId' AND source.project_id = task.project_id
    WHERE run.id = NEW.run_id AND task.id = NEW.task_id AND task.project_id = NEW.project_id
      AND run.role = 'verify' AND run.state = 'queued' AND task.state = 'queued' AND run.generation = 1 AND task.generation = 1
      AND candidate.sha256 = NEW.plan->>'extractionResultSha256' AND candidate.candidate_kind = NEW.plan->>'kind'
      AND source.state = 'succeeded' AND source.repository_id = task.repository_id AND source.commit = task.commit
      AND source.data_class = task.data_class
      AND itervane.rule_extraction_current_grant(task.project_id, task.requested_by, NEW.grant_id)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'candidate_validation_admission_authority';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER candidate_validation_admission_guard BEFORE INSERT OR UPDATE OR DELETE ON itervane.candidate_validation_admissions
FOR EACH ROW EXECUTE FUNCTION itervane.guard_candidate_validation_admission();
--> statement-breakpoint
CREATE FUNCTION itervane.candidate_validation_lease_is_current(run_id uuid, fenced integer, worker_id uuid)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM itervane.execution_slot slot
    JOIN itervane.candidate_validation_admissions admission ON admission.run_id = slot.run_id AND admission.task_id = slot.task_id
    JOIN itervane.tasks task ON task.id = slot.task_id
    JOIN itervane.task_runs run ON run.id = slot.run_id AND run.task_id = task.id
    WHERE slot.id = 1 AND slot.run_id = $1 AND slot.fence = $2 AND slot.worker_id = $3 AND slot.lease_until > clock_timestamp()
      AND run.role = 'verify' AND task.state = 'running' AND run.state = 'running' AND task.generation = 1 AND run.generation = 1
      AND task.project_id = admission.project_id
      AND itervane.rule_extraction_current_grant(task.project_id, task.requested_by, admission.grant_id)
  );
$$;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_candidate_validation_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'candidate_validation_attempt_is_immutable';
  END IF;
  IF NOT itervane.candidate_validation_lease_is_current(NEW.run_id, NEW.fence, NEW.worker_id) OR NOT EXISTS (
    SELECT 1 FROM itervane.candidate_validation_admissions admission WHERE admission.run_id = NEW.run_id
      AND admission.plan_sha256 = NEW.plan_sha256 AND admission.plan->>'kind' = 'code_rule'
      AND admission.task_id::text = NEW.request->>'taskId' AND admission.project_id::text = NEW.request->>'projectId'
      AND NEW.request->>'generation' = '1'
      AND NEW.request->>'runnerImageSha256' = admission.plan#>>'{profile,runnerImageSha256}'
      AND NEW.request->>'engineInputsSha256' = admission.plan#>>'{profile,engineInputsSha256}'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'candidate_validation_attempt_authority';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER candidate_validation_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON itervane.candidate_validation_attempts
FOR EACH ROW EXECUTE FUNCTION itervane.guard_candidate_validation_attempt();
--> statement-breakpoint
CREATE FUNCTION itervane.guard_candidate_validation_result() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'candidate_validation_result_is_immutable';
  END IF;
  IF NOT itervane.candidate_validation_lease_is_current(NEW.run_id, NEW.fence, NEW.worker_id) OR NOT EXISTS (
    SELECT 1 FROM itervane.candidate_validation_admissions admission WHERE admission.run_id = NEW.run_id
      AND admission.task_id::text = NEW.document->>'taskId' AND admission.project_id = NEW.project_id
      AND admission.candidate_id = NEW.candidate_id AND admission.plan_sha256 = NEW.plan_sha256
      AND admission.plan->>'candidateSha256' = NEW.document->>'candidateSha256'
      AND admission.plan->>'extractionResultSha256' = NEW.document->>'extractionResultSha256'
      AND admission.plan->>'kind' = NEW.document#>>'{evidence,kind}'
      AND CASE WHEN admission.plan->>'kind' = 'code_rule' THEN EXISTS (
        SELECT 1 FROM itervane.candidate_validation_attempts attempt WHERE attempt.request_id = NEW.request_id
          AND attempt.run_id = NEW.run_id AND attempt.fence = NEW.fence AND attempt.worker_id = NEW.worker_id
          AND attempt.plan_sha256 = NEW.plan_sha256 AND attempt.request = NEW.document#>'{evidence,receipt,scope}'
          AND attempt.request->>'basisSha256' = NEW.document#>>'{evidence,receipt,proof,result,basisSha256}'
          AND attempt.request->>'commandSha256' = NEW.document#>>'{evidence,receipt,proof,commandSha256}'
          AND attempt.request->>'runnerImageSha256' = NEW.document#>>'{evidence,receipt,imageSha256}'
          AND NEW.document#>'{evidence,receipt,cleanupConfirmed}' = 'true'::jsonb
          AND NEW.document#>'{evidence,receipt,sessionVerified}' = 'true'::jsonb
          AND NEW.document->>'status' = NEW.document#>>'{evidence,receipt,proof,result,status}'
      ) ELSE
        NEW.request_id IS NULL AND admission.plan->>'evaluatorVersion' = NEW.document#>>'{evidence,evaluatorVersion}'
          AND NEW.document->>'status' = NEW.document#>>'{evidence,result,status}'
      END
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'candidate_validation_result_authority';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER candidate_validation_result_guard BEFORE INSERT OR UPDATE OR DELETE ON itervane.candidate_validation_results
FOR EACH ROW EXECUTE FUNCTION itervane.guard_candidate_validation_result();
