CREATE TABLE "itervane"."formal_repair_results" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"input_sha256" text NOT NULL,
	"checkpoint_id" text NOT NULL,
	"request_id" uuid,
	"finalized_fence" integer NOT NULL,
	"worker_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "formal_repair_result_binding" CHECK (("itervane"."formal_repair_results"."finalized_fence" > 0 AND "itervane"."formal_repair_results"."sha256" ~ '^[a-f0-9]{64}$'
  AND "itervane"."formal_repair_results"."input_sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."formal_repair_results"."document"->>'version' = '1' AND "itervane"."formal_repair_results"."document"->>'runId' = "itervane"."formal_repair_results"."run_id"::text
  AND "itervane"."formal_repair_results"."document"->>'inputSha256' = "itervane"."formal_repair_results"."input_sha256" AND "itervane"."formal_repair_results"."document"->>'checkpointId' = "itervane"."formal_repair_results"."checkpoint_id"
  AND "itervane"."formal_repair_results"."document"->'releaseEligible' = 'false'::jsonb AND octet_length("itervane"."formal_repair_results"."document"::text) <= 16384
  AND (("itervane"."formal_repair_results"."request_id" IS NOT NULL AND "itervane"."formal_repair_results"."document"->>'status' = 'candidate_ready' AND "itervane"."formal_repair_results"."document"->>'reason' = 'repair_complete'
      AND jsonb_typeof("itervane"."formal_repair_results"."document"->'candidate') = 'object')
    OR ("itervane"."formal_repair_results"."request_id" IS NULL AND "itervane"."formal_repair_results"."document"->>'status' = 'requires_human' AND "itervane"."formal_repair_results"."document"->'candidate' = 'null'::jsonb))) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."formal_repair_results" ADD CONSTRAINT "formal_repair_results_run_id_formal_repair_runtime_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."formal_repair_runtime"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."formal_repair_results" ADD CONSTRAINT "formal_repair_results_request_id_formal_repair_attempts_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "itervane"."formal_repair_attempts"("request_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_formal_repair_result() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_repair_result_is_retained';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.execution_slot slot
    JOIN itervane.tasks task ON task.id = slot.task_id
    JOIN itervane.task_runs run ON run.id = slot.run_id AND run.task_id = task.id
    JOIN itervane.formal_repair_inputs input ON input.run_id = run.id
    JOIN itervane.formal_repair_runtime pointer ON pointer.run_id = run.id
    WHERE slot.id = 1 AND run.id = NEW.run_id AND slot.fence = NEW.finalized_fence AND slot.worker_id = NEW.worker_id
      AND slot.lease_until > pg_catalog.clock_timestamp() AND task.state = 'running' AND task.generation = run.generation
      AND input.sha256 = NEW.input_sha256 AND pointer.input_sha256 = input.sha256 AND pointer.checkpoint_id = NEW.checkpoint_id
      AND NEW.document->>'taskId' = task.id::text AND NEW.document->>'projectId' = task.project_id::text
      AND NEW.document->>'generation' = task.generation::text AND NEW.document->>'locale' = task.locale
      AND NEW.document->>'auditResultSha256' = input.document#>>'{audit,resultSha256}'
      AND NEW.document->>'baseSnapshotSha256' = input.document#>>'{inspection,snapshotSha256}'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_repair_result_authority_or_checkpoint_mismatch';
  END IF;
  IF NEW.request_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM itervane.formal_repair_attempts attempt
    JOIN itervane.formal_repair_operations operation ON operation.operation_id = attempt.operation_id
    WHERE attempt.request_id = NEW.request_id AND attempt.state = 'recorded' AND attempt.settled_fence <= NEW.finalized_fence
      AND operation.run_id = NEW.run_id AND operation.input_sha256 = NEW.input_sha256
      AND NEW.document#>>'{candidate,operationId}' = operation.operation_id::text
      AND NEW.document#>>'{candidate,receiptSha256}' = attempt.receipt_sha256
      AND NEW.document#>>'{candidate,patchSha256}' = attempt.receipt#>>'{snapshot,candidate,patchSha256}'
      AND NEW.document#>>'{candidate,manifestSha256}' = attempt.receipt#>>'{snapshot,candidate,candidateManifestSha256}'
      AND NEW.document#>'{candidate,changes}' = attempt.receipt#>'{snapshot,candidate,changes}'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_repair_result_receipt_mismatch';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_repair_result_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.formal_repair_results
FOR EACH ROW EXECUTE FUNCTION itervane.guard_formal_repair_result();
--> statement-breakpoint
CREATE FUNCTION itervane.guard_final_repair_checkpoint() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM itervane.formal_repair_results WHERE run_id = OLD.run_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_repair_checkpoint_already_finalized';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_repair_checkpoint_finalized BEFORE UPDATE ON itervane.formal_repair_runtime
FOR EACH ROW EXECUTE FUNCTION itervane.guard_final_repair_checkpoint();
