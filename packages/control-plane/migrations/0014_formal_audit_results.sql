CREATE TABLE "itervane"."formal_audit_results" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"input_sha256" text NOT NULL,
	"checkpoint_id" text NOT NULL,
	"finalized_fence" integer NOT NULL,
	"worker_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "formal_audit_result_binding" CHECK (("itervane"."formal_audit_results"."finalized_fence" > 0 AND "itervane"."formal_audit_results"."sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."formal_audit_results"."input_sha256" ~ '^[a-f0-9]{64}$'
  AND "itervane"."formal_audit_results"."document"->>'version' = '1' AND "itervane"."formal_audit_results"."document"->>'runId' = "itervane"."formal_audit_results"."run_id"::text
  AND "itervane"."formal_audit_results"."document"->>'inputSha256' = "itervane"."formal_audit_results"."input_sha256" AND "itervane"."formal_audit_results"."document"->>'checkpointId' = "itervane"."formal_audit_results"."checkpoint_id"
  AND octet_length("itervane"."formal_audit_results"."document"::text) <= 98304) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."formal_audit_results" ADD CONSTRAINT "formal_audit_results_run_id_formal_audit_runtime_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."formal_audit_runtime"("run_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_formal_audit_result() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_audit_result_is_retained';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.execution_slot slot
    JOIN itervane.tasks task ON task.id = slot.task_id
    JOIN itervane.task_runs run ON run.id = slot.run_id AND run.task_id = task.id
    JOIN itervane.formal_audit_inputs input ON input.run_id = run.id AND input.task_id = task.id
    JOIN itervane.formal_audit_runtime pointer ON pointer.run_id = input.run_id
    WHERE slot.id = 1 AND run.id = NEW.run_id AND slot.fence = NEW.finalized_fence AND slot.worker_id = NEW.worker_id
      AND slot.lease_until > pg_catalog.clock_timestamp() AND task.state = 'running' AND task.generation = run.generation
      AND input.sha256 = NEW.input_sha256 AND pointer.input_sha256 = input.sha256 AND pointer.checkpoint_id = NEW.checkpoint_id
      AND NEW.document->>'taskId' = task.id::text AND NEW.document->>'projectId' = task.project_id::text
      AND NEW.document->>'generation' = task.generation::text AND NEW.document->>'locale' = task.locale
      AND NEW.document->>'inspectionSha256' = input.document#>>'{inspection,receiptSha256}'
      AND NEW.document->>'snapshotSha256' = input.document#>>'{inspection,snapshotSha256}'
      AND NEW.document->>'catalogSha256' = input.document#>>'{catalog,sha256}'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_audit_result_authority_or_checkpoint_mismatch';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_audit_result_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.formal_audit_results
FOR EACH ROW EXECUTE FUNCTION itervane.guard_formal_audit_result();
--> statement-breakpoint
CREATE FUNCTION itervane.guard_final_audit_checkpoint() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM itervane.formal_audit_results WHERE run_id = OLD.run_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_audit_checkpoint_already_finalized';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_audit_checkpoint_finalized BEFORE UPDATE ON itervane.formal_audit_runtime
FOR EACH ROW EXECUTE FUNCTION itervane.guard_final_audit_checkpoint();
