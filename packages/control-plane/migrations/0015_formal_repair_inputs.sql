CREATE TABLE "itervane"."formal_repair_inputs" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"prepared_fence" integer NOT NULL,
	"worker_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "formal_repair_input_binding" CHECK (("itervane"."formal_repair_inputs"."prepared_fence" > 0 AND "itervane"."formal_repair_inputs"."sha256" ~ '^[a-f0-9]{64}$'
  AND "itervane"."formal_repair_inputs"."document"->>'version' = '1' AND "itervane"."formal_repair_inputs"."document"->>'runId' = "itervane"."formal_repair_inputs"."run_id"::text
  AND octet_length("itervane"."formal_repair_inputs"."document"::text) <= 8192) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."formal_repair_inputs" ADD CONSTRAINT "formal_repair_inputs_run_id_formal_audit_results_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."formal_audit_results"("run_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_formal_repair_input() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_repair_input_is_retained';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.execution_slot slot
    JOIN itervane.tasks task ON task.id = slot.task_id
    JOIN itervane.task_runs run ON run.id = slot.run_id AND run.task_id = task.id
    JOIN itervane.formal_audit_inputs input ON input.run_id = run.id AND input.task_id = task.id
    JOIN itervane.formal_audit_results audit ON audit.run_id = run.id AND audit.input_sha256 = input.sha256
    WHERE slot.id = 1 AND run.id = NEW.run_id AND slot.fence = NEW.prepared_fence AND slot.worker_id = NEW.worker_id
      AND slot.lease_until > pg_catalog.clock_timestamp() AND task.state = 'running' AND task.generation = run.generation
      AND audit.document->>'status' = 'completed' AND audit.document->>'reason' = 'audit_complete'
      AND audit.document#>>'{checklist,coverage}' = 'complete' AND audit.document#>'{checklist,hypotheses}' = '[]'::jsonb
      AND pg_catalog.jsonb_typeof(audit.document#>'{checklist,findings}') = 'array'
      AND NEW.document->>'taskId' = task.id::text AND NEW.document->>'projectId' = task.project_id::text
      AND NEW.document->>'generation' = task.generation::text AND NEW.document->>'locale' = task.locale
      AND NEW.document->>'dataClass' = task.data_class AND NEW.document->'source' = input.document->'source'
      AND NEW.document->'inspection' = input.document->'inspection'
      AND NEW.document#>>'{audit,inputSha256}' = input.sha256 AND NEW.document#>>'{audit,resultSha256}' = audit.sha256
      AND NEW.document#>>'{audit,checkpointId}' = audit.checkpoint_id
      AND NEW.document->>'catalogSha256' = input.document#>>'{catalog,sha256}'
      AND NEW.document->'findingIds' = pg_catalog.jsonb_path_query_array(audit.document, '$.checklist.findings[*].id')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_repair_input_authority_or_audit_mismatch';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_repair_input_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.formal_repair_inputs
FOR EACH ROW EXECUTE FUNCTION itervane.guard_formal_repair_input();
