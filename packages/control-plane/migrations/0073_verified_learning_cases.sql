CREATE TABLE "itervane"."learning_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"category" text NOT NULL,
	"evidence_sha256" text NOT NULL,
	"sha256" text NOT NULL,
	"captured_by" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_case_run_unique" UNIQUE("run_id"),
	CONSTRAINT "learning_case_document" CHECK (("itervane"."learning_cases"."sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."learning_cases"."evidence_sha256" ~ '^[a-f0-9]{64}$'
    AND "itervane"."learning_cases"."category" IN ('resolved_source_findings', 'reproduced_health_failure', 'recovered_stopped_instance')
    AND "itervane"."learning_cases"."document"->>'version' = '1' AND "itervane"."learning_cases"."document"->>'projectId' = "itervane"."learning_cases"."project_id"::text
    AND "itervane"."learning_cases"."document"->>'taskId' = "itervane"."learning_cases"."task_id"::text AND "itervane"."learning_cases"."document"->>'runId' = "itervane"."learning_cases"."run_id"::text
    AND "itervane"."learning_cases"."document"->>'evidenceSha256' = "itervane"."learning_cases"."evidence_sha256" AND "itervane"."learning_cases"."document"#>>'{facts,category}' = "itervane"."learning_cases"."category"
    AND octet_length("itervane"."learning_cases"."document"::text) <= 4096) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."learning_cases" ADD CONSTRAINT "learning_cases_captured_by_principals_id_fk" FOREIGN KEY ("captured_by") REFERENCES "itervane"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."learning_cases" ADD CONSTRAINT "learning_case_task_project_fk" FOREIGN KEY ("task_id","project_id") REFERENCES "itervane"."tasks"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."learning_cases" ADD CONSTRAINT "learning_case_run_task_fk" FOREIGN KEY ("run_id","task_id") REFERENCES "itervane"."task_runs"("id","task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learning_case_project_history" ON "itervane"."learning_cases" USING btree ("project_id","created_at","id");--> statement-breakpoint
CREATE INDEX "learning_case_similar_history" ON "itervane"."learning_cases" USING btree ("project_id","category","created_at","id");
--> statement-breakpoint
CREATE FUNCTION itervane.guard_learning_case() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  source_role text;
  source_state text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'learning_case_is_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.projects project
    JOIN itervane.workspace_members member ON member.workspace_id = project.workspace_id
    WHERE project.id = NEW.project_id AND member.principal_id = NEW.captured_by AND member.grant_id = NEW.grant_id
    UNION ALL
    SELECT 1 FROM itervane.project_members member
    WHERE member.project_id = NEW.project_id AND member.principal_id = NEW.captured_by
      AND member.grant_id = NEW.grant_id AND member.role = 'maintainer'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'learning_case_authority';
  END IF;

  SELECT run.role::text, task.state::text INTO source_role, source_state
    FROM itervane.task_runs run JOIN itervane.tasks task ON task.id = run.task_id AND task.generation = run.generation
    WHERE run.id = NEW.run_id AND task.id = NEW.task_id AND task.project_id = NEW.project_id
      AND run.generation::text = NEW.document->>'generation' AND task.data_class = NEW.document->>'dataClass';
  IF NEW.category = 'recovered_stopped_instance' THEN
    IF source_role IS DISTINCT FROM 'operations' OR source_state IS DISTINCT FROM 'succeeded' OR NOT EXISTS (
      SELECT 1 FROM itervane.operations_diagnosis_results diagnosis
      JOIN itervane.operations_proposals proposal ON proposal.diagnosis_run_id = diagnosis.run_id
      JOIN itervane.operations_executions execution ON execution.proposal_id = proposal.id AND execution.state = 'recovered'
      JOIN itervane.operations_execution_schedules schedule ON schedule.execution_id = execution.id
      JOIN itervane.operations_restart_recoveries recovery ON recovery.execution_id = execution.id AND recovery.state = 'verified'
      WHERE diagnosis.run_id = NEW.run_id AND recovery.proof_sha256 = NEW.evidence_sha256
        AND diagnosis.sha256 = NEW.document#>>'{facts,diagnosisSha256}' AND proposal.fingerprint = NEW.document#>>'{facts,proposalSha256}'
        AND execution.id::text = NEW.document#>>'{facts,executionId}' AND schedule.task_id::text = NEW.document#>>'{facts,actionTaskId}'
        AND recovery.proof->>'releaseOperationId' = NEW.document#>>'{facts,releaseOperationId}'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'learning_case_evidence';
    END IF;
  ELSIF source_role IS NULL OR source_role = 'operations' OR source_state NOT IN ('waiting_input', 'waiting_approval', 'succeeded') OR NOT EXISTS (
    SELECT 1 FROM itervane.formal_verification_results result
    JOIN itervane.formal_verification_inputs input ON input.run_id = result.run_id
    WHERE result.run_id = NEW.run_id AND result.sha256 = NEW.evidence_sha256
      AND result.receipt_sha256 = NEW.document#>>'{facts,verificationReceiptSha256}'
      AND result.document#>>'{review,outcome}' = 'observed'
      AND input.document#>>'{subject,kind}' = 'repair' AND input.document#>>'{subject,patchSha256}' = NEW.document#>>'{facts,patchSha256}'
      AND input.document#>>'{inspection,snapshotSha256}' = NEW.document#>>'{facts,originalSnapshotSha256}'
      AND input.document#>>'{subject,manifestSha256}' = NEW.document#>>'{facts,repairedSnapshotSha256}'
      AND ((result.document#>'{evidence,source}') - 'status'::text) = (NEW.document#>'{facts,sourceComparison}')
      AND CASE WHEN NEW.category = 'reproduced_health_failure'
        THEN input.document#>>'{healthReproduction,receiptSha256}' = NEW.document#>>'{facts,reproductionSha256}'
        ELSE input.document->'healthReproduction' IS NULL AND (result.document#>>'{evidence,source,resolved}')::integer > 0
      END
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'learning_case_evidence';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER learning_case_guard BEFORE INSERT OR UPDATE OR DELETE ON itervane.learning_cases
FOR EACH ROW EXECUTE FUNCTION itervane.guard_learning_case();
