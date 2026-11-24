CREATE TABLE "itervane"."rule_extraction_admissions" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"case_sha256" text NOT NULL,
	"provider_sha256" text NOT NULL,
	"grant_id" uuid NOT NULL,
	CONSTRAINT "rule_extraction_admission_digests" CHECK ("itervane"."rule_extraction_admissions"."case_sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."rule_extraction_admissions"."provider_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "itervane"."rule_extraction_inputs" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"prepared_fence" integer NOT NULL,
	"worker_id" uuid NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_extraction_input_binding" CHECK (("itervane"."rule_extraction_inputs"."prepared_fence" > 0 AND "itervane"."rule_extraction_inputs"."sha256" ~ '^[a-f0-9]{64}$'
    AND "itervane"."rule_extraction_inputs"."document"->>'version' = '1' AND "itervane"."rule_extraction_inputs"."document"->>'runId' = "itervane"."rule_extraction_inputs"."run_id"::text
    AND "itervane"."rule_extraction_inputs"."document"->>'knowledgeSha256' ~ '^[a-f0-9]{64}$' AND octet_length("itervane"."rule_extraction_inputs"."document"::text) <= 8192) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "itervane"."rule_extraction_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"input_sha256" text NOT NULL,
	"checkpoint_id" text NOT NULL,
	"finalized_fence" integer NOT NULL,
	"worker_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"candidate_key" text,
	"candidate_kind" text,
	"candidate_semantic_sha256" text,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_extraction_finalized_run" UNIQUE("run_id"),
	CONSTRAINT "rule_extraction_candidate_key" UNIQUE("project_id","candidate_key"),
	CONSTRAINT "rule_extraction_candidate_semantics" UNIQUE("project_id","candidate_semantic_sha256"),
	CONSTRAINT "rule_extraction_result_binding" CHECK (("itervane"."rule_extraction_results"."finalized_fence" > 0 AND "itervane"."rule_extraction_results"."sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."rule_extraction_results"."input_sha256" ~ '^[a-f0-9]{64}$'
    AND "itervane"."rule_extraction_results"."document"->>'version' = '1' AND "itervane"."rule_extraction_results"."document"->>'runId' = "itervane"."rule_extraction_results"."run_id"::text AND "itervane"."rule_extraction_results"."document"->>'projectId' = "itervane"."rule_extraction_results"."project_id"::text
    AND "itervane"."rule_extraction_results"."document"->>'inputSha256' = "itervane"."rule_extraction_results"."input_sha256" AND "itervane"."rule_extraction_results"."document"->>'checkpointId' = "itervane"."rule_extraction_results"."checkpoint_id"
    AND octet_length("itervane"."rule_extraction_results"."document"::text) <= 16384
    AND CASE WHEN "itervane"."rule_extraction_results"."document"#>>'{extraction,result,outcome}' = 'candidate' THEN
      "itervane"."rule_extraction_results"."candidate_key" = "itervane"."rule_extraction_results"."document"#>>'{extraction,result,candidate,key}' AND "itervane"."rule_extraction_results"."candidate_kind" = "itervane"."rule_extraction_results"."document"#>>'{extraction,result,candidate,kind}'
      AND "itervane"."rule_extraction_results"."candidate_kind" IN ('code_rule', 'runbook') AND "itervane"."rule_extraction_results"."candidate_semantic_sha256" ~ '^[a-f0-9]{64}$'
      AND "itervane"."rule_extraction_results"."candidate_semantic_sha256" = "itervane"."rule_extraction_results"."document"->>'candidateSemanticSha256'
    ELSE "itervane"."rule_extraction_results"."candidate_key" IS NULL AND "itervane"."rule_extraction_results"."candidate_kind" IS NULL AND "itervane"."rule_extraction_results"."candidate_semantic_sha256" IS NULL
      AND "itervane"."rule_extraction_results"."document"#>>'{extraction,result,outcome}' IN ('retain_case', 'duplicate')
    END) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "itervane"."rule_extraction_runtime" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"input_sha256" text NOT NULL,
	"checkpoint_id" text NOT NULL,
	"checkpoint_step" integer NOT NULL,
	"published_fence" integer NOT NULL,
	"worker_id" uuid NOT NULL,
	CONSTRAINT "rule_extraction_runtime_binding" CHECK ("itervane"."rule_extraction_runtime"."input_sha256" ~ '^[a-f0-9]{64}$'
    AND "itervane"."rule_extraction_runtime"."checkpoint_step" >= -1 AND "itervane"."rule_extraction_runtime"."published_fence" > 0)
);
--> statement-breakpoint
ALTER TABLE "itervane"."checkpoint_write_receipts" DROP CONSTRAINT "checkpoint_write_graph";--> statement-breakpoint
ALTER TABLE "itervane"."rule_extraction_admissions" ADD CONSTRAINT "rule_extraction_admissions_case_id_learning_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "itervane"."learning_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."rule_extraction_admissions" ADD CONSTRAINT "rule_extraction_admission_task_fk" FOREIGN KEY ("task_id","project_id") REFERENCES "itervane"."tasks"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."rule_extraction_admissions" ADD CONSTRAINT "rule_extraction_admission_run_fk" FOREIGN KEY ("run_id","task_id") REFERENCES "itervane"."task_runs"("id","task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."rule_extraction_inputs" ADD CONSTRAINT "rule_extraction_inputs_run_id_rule_extraction_admissions_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."rule_extraction_admissions"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."rule_extraction_results" ADD CONSTRAINT "rule_extraction_results_run_id_rule_extraction_runtime_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."rule_extraction_runtime"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."rule_extraction_results" ADD CONSTRAINT "rule_extraction_results_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "itervane"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."rule_extraction_runtime" ADD CONSTRAINT "rule_extraction_runtime_run_id_rule_extraction_inputs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."rule_extraction_inputs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rule_extraction_candidate_history" ON "itervane"."rule_extraction_results" USING btree ("project_id","candidate_kind","created_at","id");--> statement-breakpoint
ALTER TABLE "itervane"."checkpoint_write_receipts" ADD CONSTRAINT "checkpoint_write_graph" CHECK ("itervane"."checkpoint_write_receipts"."graph" IN ('preflight', 'audit', 'repair', 'verify', 'operations', 'rule-extraction'));
--> statement-breakpoint
CREATE FUNCTION itervane.rule_extraction_current_grant(project_id uuid, actor_id uuid, grant_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM itervane.projects project
    JOIN itervane.workspace_members member ON member.workspace_id = project.workspace_id
    WHERE project.id = $1 AND member.principal_id = $2 AND member.grant_id = $3
    UNION ALL
    SELECT 1 FROM itervane.project_members member
    WHERE member.project_id = $1 AND member.principal_id = $2 AND member.grant_id = $3 AND member.role = 'maintainer'
  );
$$;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_rule_extraction_admission() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_extraction_admission_is_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.task_runs run
    JOIN itervane.tasks task ON task.id = run.task_id
    JOIN itervane.learning_cases source ON source.id = NEW.case_id
    JOIN itervane.tasks sourced ON sourced.id = source.task_id AND sourced.project_id = task.project_id
    WHERE run.id = NEW.run_id AND task.id = NEW.task_id AND task.project_id = NEW.project_id
      AND task.state = 'queued' AND run.state = 'queued' AND run.role = 'rule-extraction'
      AND run.generation = 1 AND task.generation = 1 AND source.project_id = task.project_id
      AND source.sha256 = NEW.case_sha256 AND task.data_class = source.document->>'dataClass'
      AND task.repository_id = sourced.repository_id AND task.commit = sourced.commit
      AND itervane.rule_extraction_current_grant(task.project_id, task.requested_by, NEW.grant_id)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_extraction_admission_authority';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER rule_extraction_admission_guard BEFORE INSERT OR UPDATE OR DELETE ON itervane.rule_extraction_admissions
FOR EACH ROW EXECUTE FUNCTION itervane.guard_rule_extraction_admission();
--> statement-breakpoint
CREATE FUNCTION itervane.rule_extraction_lease_is_current(run_id uuid, fenced integer, worker_id uuid)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM itervane.execution_slot slot
    JOIN itervane.rule_extraction_admissions admission ON admission.run_id = slot.run_id AND admission.task_id = slot.task_id
    JOIN itervane.tasks task ON task.id = slot.task_id
    JOIN itervane.task_runs run ON run.id = slot.run_id AND run.task_id = task.id
    WHERE slot.id = 1 AND slot.run_id = $1 AND slot.fence = $2 AND slot.worker_id = $3 AND slot.lease_until > clock_timestamp()
      AND task.state = 'running' AND run.state = 'running' AND run.role = 'rule-extraction'
      AND task.generation = 1 AND run.generation = 1 AND admission.project_id = task.project_id
      AND itervane.rule_extraction_current_grant(task.project_id, task.requested_by, admission.grant_id)
  );
$$;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_rule_extraction_input() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_extraction_input_is_immutable';
  END IF;
  IF NOT itervane.rule_extraction_lease_is_current(NEW.run_id, NEW.prepared_fence, NEW.worker_id) OR NOT EXISTS (
    SELECT 1 FROM itervane.rule_extraction_admissions admission JOIN itervane.learning_cases source ON source.id = admission.case_id
    WHERE admission.run_id = NEW.run_id AND admission.task_id::text = NEW.document->>'taskId'
      AND admission.project_id::text = NEW.document->>'projectId' AND NEW.document->>'generation' = '1'
      AND admission.case_id::text = NEW.document#>>'{source,caseId}' AND admission.case_sha256 = NEW.document#>>'{source,sha256}'
      AND admission.provider_sha256 = NEW.document->>'providerSha256' AND source.category = NEW.document#>>'{knowledge,category}'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_extraction_input_authority';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER rule_extraction_input_guard BEFORE INSERT OR UPDATE OR DELETE ON itervane.rule_extraction_inputs
FOR EACH ROW EXECUTE FUNCTION itervane.guard_rule_extraction_input();
--> statement-breakpoint
CREATE FUNCTION itervane.guard_rule_extraction_pointer() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND (
    OLD.run_id <> NEW.run_id OR NEW.checkpoint_step <= OLD.checkpoint_step OR NEW.published_fence < OLD.published_fence
    OR EXISTS (SELECT 1 FROM itervane.rule_extraction_results result WHERE result.run_id = OLD.run_id)
  )) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_extraction_pointer_progress';
  END IF;
  IF NOT itervane.rule_extraction_lease_is_current(NEW.run_id, NEW.published_fence, NEW.worker_id) OR NOT EXISTS (
    SELECT 1 FROM itervane.rule_extraction_inputs input WHERE input.run_id = NEW.run_id AND input.sha256 = NEW.input_sha256
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_extraction_pointer_authority';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER rule_extraction_pointer_guard BEFORE INSERT OR UPDATE OR DELETE ON itervane.rule_extraction_runtime
FOR EACH ROW EXECUTE FUNCTION itervane.guard_rule_extraction_pointer();
--> statement-breakpoint
CREATE FUNCTION itervane.guard_rule_extraction_result() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_extraction_result_is_immutable';
  END IF;
  IF NOT itervane.rule_extraction_lease_is_current(NEW.run_id, NEW.finalized_fence, NEW.worker_id) OR NOT EXISTS (
    SELECT 1 FROM itervane.rule_extraction_runtime pointer
    JOIN itervane.rule_extraction_inputs input ON input.run_id = pointer.run_id AND input.sha256 = pointer.input_sha256
    JOIN itervane.rule_extraction_admissions admission ON admission.run_id = pointer.run_id
    WHERE pointer.run_id = NEW.run_id AND pointer.checkpoint_id = NEW.checkpoint_id AND input.sha256 = NEW.input_sha256
      AND pointer.published_fence <= NEW.finalized_fence AND admission.task_id::text = NEW.document->>'taskId'
      AND admission.project_id = NEW.project_id AND NEW.document->>'generation' = '1'
      AND admission.case_id::text = NEW.document#>>'{extraction,caseId}' AND admission.case_sha256 = NEW.document#>>'{extraction,caseSha256}'
      AND input.document->>'knowledgeSha256' = NEW.document#>>'{extraction,knowledgeSha256}'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_extraction_result_authority';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER rule_extraction_result_guard BEFORE INSERT OR UPDATE OR DELETE ON itervane.rule_extraction_results
FOR EACH ROW EXECUTE FUNCTION itervane.guard_rule_extraction_result();
