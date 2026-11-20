CREATE TABLE "itervane"."formal_audit_inputs" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"inspection_request_id" uuid NOT NULL,
	"prepared_fence" integer NOT NULL,
	"worker_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "formal_audit_input_binding" CHECK (("itervane"."formal_audit_inputs"."prepared_fence" > 0 AND "itervane"."formal_audit_inputs"."sha256" ~ '^[a-f0-9]{64}$'
    AND "itervane"."formal_audit_inputs"."document"->>'version' = '1' AND "itervane"."formal_audit_inputs"."document"->>'taskId' = "itervane"."formal_audit_inputs"."task_id"::text AND "itervane"."formal_audit_inputs"."document"->>'runId' = "itervane"."formal_audit_inputs"."run_id"::text
    AND "itervane"."formal_audit_inputs"."document"->>'projectId' = "itervane"."formal_audit_inputs"."project_id"::text AND "itervane"."formal_audit_inputs"."document"#>>'{inspection,requestId}' = "itervane"."formal_audit_inputs"."inspection_request_id"::text
    AND octet_length("itervane"."formal_audit_inputs"."document"::text) <= 65536) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."formal_audit_inputs" ADD CONSTRAINT "formal_audit_inputs_inspection_request_id_inspection_attempts_request_id_fk" FOREIGN KEY ("inspection_request_id") REFERENCES "itervane"."inspection_attempts"("request_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."formal_audit_inputs" ADD CONSTRAINT "formal_audit_run_task" FOREIGN KEY ("run_id","task_id") REFERENCES "itervane"."task_runs"("id","task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."formal_audit_inputs" ADD CONSTRAINT "formal_audit_task_project" FOREIGN KEY ("task_id","project_id") REFERENCES "itervane"."tasks"("id","project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_formal_audit_input() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_audit_input_is_retained';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.execution_slot slot
    JOIN itervane.tasks task ON task.id = slot.task_id
    JOIN itervane.task_runs run ON run.id = slot.run_id AND run.task_id = task.id
    JOIN itervane.inspection_attempts inspection ON inspection.run_id = run.id AND inspection.task_id = task.id
    WHERE slot.id = 1 AND slot.fence = NEW.prepared_fence AND slot.worker_id = NEW.worker_id
      AND slot.lease_until > pg_catalog.clock_timestamp() AND task.state = 'running'
      AND task.id = NEW.task_id AND run.id = NEW.run_id AND task.project_id = NEW.project_id
      AND run.generation = task.generation AND inspection.generation = task.generation
      AND NEW.document->>'generation' = task.generation::text AND NEW.document->>'locale' = task.locale
      AND NEW.document->>'dataClass' = task.data_class
      AND NEW.document->>'purposeSha256' = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(task.purpose, 'UTF8')), 'hex')
      AND NEW.document#>>'{source,repositoryId}' = task.repository_id::text AND NEW.document#>>'{source,commit}' = task."commit"
      AND inspection.request_id = NEW.inspection_request_id AND inspection.state = 'recorded' AND inspection.workspace_sha256 IS NOT NULL
      AND NEW.document#>>'{inspection,receiptSha256}' = inspection.receipt_sha256
      AND NEW.document#>>'{inspection,planSha256}' = inspection.plan_sha256
      AND NEW.document#>>'{inspection,snapshotSha256}' = inspection.receipt#>>'{snapshot,manifestSha256}'
      AND inspection.receipt#>>'{snapshot,reports,0,status}' = 'completed'
      AND inspection.receipt#>>'{snapshot,reports,1,status}' = 'completed'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_audit_input_authority_or_inspection_mismatch';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_audit_input_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.formal_audit_inputs
FOR EACH ROW EXECUTE FUNCTION itervane.guard_formal_audit_input();
