CREATE TABLE "itervane"."formal_verification_results" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"input_sha256" text NOT NULL,
	"receipt_sha256" text NOT NULL,
	"checkpoint_id" text NOT NULL,
	"finalized_fence" integer NOT NULL,
	"worker_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "formal_verification_result_binding" CHECK (("itervane"."formal_verification_results"."finalized_fence" > 0 AND "itervane"."formal_verification_results"."sha256" ~ '^[a-f0-9]{64}$'
  AND "itervane"."formal_verification_results"."input_sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."formal_verification_results"."receipt_sha256" ~ '^[a-f0-9]{64}$'
  AND "itervane"."formal_verification_results"."document"->>'version' = '1' AND "itervane"."formal_verification_results"."document"->>'runId' = "itervane"."formal_verification_results"."run_id"::text AND "itervane"."formal_verification_results"."document"->>'requestId' = "itervane"."formal_verification_results"."request_id"::text
  AND "itervane"."formal_verification_results"."document"->>'inputSha256' = "itervane"."formal_verification_results"."input_sha256" AND "itervane"."formal_verification_results"."document"->>'receiptSha256' = "itervane"."formal_verification_results"."receipt_sha256"
  AND "itervane"."formal_verification_results"."document"->>'checkpointId' = "itervane"."formal_verification_results"."checkpoint_id" AND "itervane"."formal_verification_results"."document"->'releaseEligible' = 'false'::jsonb
  AND octet_length("itervane"."formal_verification_results"."document"::text) <= 16384
  AND (("itervane"."formal_verification_results"."document"->>'status' = 'reviewed' AND jsonb_typeof("itervane"."formal_verification_results"."document"->'review') = 'object')
    OR ("itervane"."formal_verification_results"."document"->>'status' = 'requires_human' AND "itervane"."formal_verification_results"."document"->'review' = 'null'::jsonb))) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."formal_verification_results" ADD CONSTRAINT "formal_verification_results_run_id_formal_verification_runtime_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."formal_verification_runtime"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."formal_verification_results" ADD CONSTRAINT "formal_verification_results_request_id_formal_rescan_attempts_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "itervane"."formal_rescan_attempts"("request_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_formal_verification_result() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_verification_result_is_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.execution_slot slot
    JOIN itervane.tasks task ON task.id = slot.task_id
    JOIN itervane.task_runs run ON run.id = slot.run_id AND run.task_id = task.id
    JOIN itervane.run_runtime runtime ON runtime.run_id = run.id AND runtime.task_id = task.id
    JOIN itervane.formal_verification_inputs input ON input.run_id = run.id
    JOIN itervane.formal_verification_runtime pointer ON pointer.run_id = run.id AND pointer.input_sha256 = input.sha256
    JOIN itervane.formal_rescan_attempts attempt ON attempt.run_id = run.id AND attempt.input_sha256 = input.sha256
    WHERE slot.id = 1 AND slot.run_id = NEW.run_id AND slot.fence = NEW.finalized_fence AND slot.worker_id = NEW.worker_id
      AND slot.lease_until > pg_catalog.clock_timestamp() AND task.state = 'running' AND run.generation = task.generation
      AND runtime.reason = 'verification_pending' AND input.sha256 = NEW.input_sha256
      AND task.id::text = NEW.document->>'taskId' AND task.project_id::text = NEW.document->>'projectId'
      AND task.generation::text = NEW.document->>'generation' AND task.locale = NEW.document->>'locale'
      AND pointer.checkpoint_id = NEW.checkpoint_id AND pointer.receipt_sha256 = NEW.receipt_sha256
      AND attempt.state = 'recorded' AND attempt.request_id = NEW.request_id AND attempt.receipt_sha256 = NEW.receipt_sha256
      AND input.document#>>'{subject,manifestSha256}' = NEW.document#>>'{evidence,binding,subjectManifestSha256}'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_verification_result_authority_lost';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_verification_result_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.formal_verification_results
FOR EACH ROW EXECUTE FUNCTION itervane.guard_formal_verification_result();
--> statement-breakpoint
CREATE FUNCTION itervane.guard_finalized_verification_pointer() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM itervane.formal_verification_results WHERE run_id = OLD.run_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_verification_pointer_is_final';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_verification_pointer_final BEFORE UPDATE ON itervane.formal_verification_runtime
FOR EACH ROW EXECUTE FUNCTION itervane.guard_finalized_verification_pointer();
