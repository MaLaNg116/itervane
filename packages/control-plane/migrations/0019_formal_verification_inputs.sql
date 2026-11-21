CREATE TABLE "itervane"."formal_verification_inputs" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"prepared_fence" integer NOT NULL,
	"worker_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "formal_verification_input_binding" CHECK (("itervane"."formal_verification_inputs"."prepared_fence" > 0 AND "itervane"."formal_verification_inputs"."sha256" ~ '^[a-f0-9]{64}$'
  AND "itervane"."formal_verification_inputs"."document"->>'version' = '1' AND "itervane"."formal_verification_inputs"."document"->>'runId' = "itervane"."formal_verification_inputs"."run_id"::text
  AND octet_length("itervane"."formal_verification_inputs"."document"::text) <= 8192) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."formal_verification_inputs" ADD CONSTRAINT "formal_verification_inputs_run_id_formal_repair_inputs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."formal_repair_inputs"("run_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_formal_verification_input() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_verification_input_is_retained';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.execution_slot slot
    JOIN itervane.tasks task ON task.id = slot.task_id
    JOIN itervane.task_runs run ON run.id = slot.run_id AND run.task_id = task.id
    JOIN itervane.formal_repair_inputs handoff ON handoff.run_id = run.id
    JOIN itervane.inspection_attempts scan ON scan.run_id = run.id AND scan.state = 'recorded'
    LEFT JOIN itervane.formal_repair_results repair ON repair.run_id = run.id
    LEFT JOIN itervane.formal_repair_attempts attempt ON attempt.request_id = repair.request_id AND attempt.state = 'recorded'
    LEFT JOIN itervane.formal_repair_operations operation ON operation.operation_id = attempt.operation_id
    WHERE slot.id = 1 AND run.id = NEW.run_id AND slot.fence = NEW.prepared_fence AND slot.worker_id = NEW.worker_id
      AND slot.lease_until > pg_catalog.clock_timestamp() AND task.state = 'running' AND task.generation = run.generation
      AND NEW.document->>'taskId' = task.id::text AND NEW.document->>'projectId' = task.project_id::text
      AND NEW.document->>'generation' = task.generation::text AND NEW.document->>'locale' = task.locale
      AND NEW.document->>'dataClass' = task.data_class AND NEW.document->'source' = handoff.document->'source'
      AND NEW.document->'inspection' = handoff.document->'inspection' AND NEW.document->'audit' = handoff.document->'audit'
      AND NEW.document->>'catalogSha256' = handoff.document->>'catalogSha256'
      AND scan.request_id::text = NEW.document#>>'{inspection,requestId}' AND scan.receipt_sha256 = NEW.document#>>'{inspection,receiptSha256}'
      AND NOT pg_catalog.jsonb_path_exists(scan.receipt, '$.snapshot.reports[*] ? (@.status != "completed")')
      AND (CASE NEW.document#>>'{subject,kind}'
        WHEN 'original' THEN repair.run_id IS NULL AND handoff.document->'findingIds' = '[]'::jsonb
          AND NOT pg_catalog.jsonb_path_exists(scan.receipt, '$.snapshot.reports[*].findings[0]')
          AND NEW.document#>>'{subject,manifestSha256}' = NEW.document#>>'{inspection,snapshotSha256}'
        WHEN 'repair' THEN repair.document->>'status' = 'candidate_ready'
          AND pg_catalog.jsonb_path_exists(scan.receipt, '$.snapshot.reports[*].findings[0]')
          AND handoff.sha256 = NEW.document#>>'{subject,inputSha256}' AND repair.sha256 = NEW.document#>>'{subject,resultSha256}'
          AND repair.checkpoint_id = NEW.document#>>'{subject,checkpointId}'
          AND attempt.request_id::text = NEW.document#>>'{subject,requestId}' AND attempt.receipt_sha256 = NEW.document#>>'{subject,receiptSha256}'
          AND operation.run_id = NEW.run_id AND operation.operation_id::text = NEW.document#>>'{subject,operationId}'
          AND operation.command_sha256 = NEW.document#>>'{subject,commandSha256}'
          AND repair.document#>>'{candidate,patchSha256}' = NEW.document#>>'{subject,patchSha256}'
          AND repair.document#>>'{candidate,manifestSha256}' = NEW.document#>>'{subject,manifestSha256}'
        ELSE false END) IS TRUE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_verification_input_authority_or_source_mismatch';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_verification_input_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.formal_verification_inputs
FOR EACH ROW EXECUTE FUNCTION itervane.guard_formal_verification_input();
