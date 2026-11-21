CREATE TABLE "itervane"."formal_repair_attempts" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"fence" integer NOT NULL,
	"worker_id" uuid NOT NULL,
	"workspace_sha256" text NOT NULL,
	"image_sha256" text NOT NULL,
	"origin_sha256" text NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"settled_fence" integer,
	"settled_worker_id" uuid,
	"settled_at" timestamp with time zone,
	"receipt_sha256" text,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "formal_repair_attempt_per_fence" UNIQUE("operation_id","fence"),
	CONSTRAINT "formal_repair_attempt_coordinates" CHECK ("itervane"."formal_repair_attempts"."fence" > 0 AND "itervane"."formal_repair_attempts"."workspace_sha256" ~ '^[a-f0-9]{64}$'
    AND "itervane"."formal_repair_attempts"."image_sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."formal_repair_attempts"."origin_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "formal_repair_attempt_state" CHECK ((
    ("itervane"."formal_repair_attempts"."state" = 'reserved' AND "itervane"."formal_repair_attempts"."settled_fence" IS NULL AND "itervane"."formal_repair_attempts"."settled_worker_id" IS NULL AND "itervane"."formal_repair_attempts"."settled_at" IS NULL)
    OR ("itervane"."formal_repair_attempts"."state" IN ('closed', 'uncertain', 'recorded') AND "itervane"."formal_repair_attempts"."settled_fence" >= "itervane"."formal_repair_attempts"."fence"
      AND "itervane"."formal_repair_attempts"."settled_worker_id" IS NOT NULL AND "itervane"."formal_repair_attempts"."settled_at" IS NOT NULL)) IS TRUE),
	CONSTRAINT "formal_repair_attempt_receipt" CHECK ((
    ("itervane"."formal_repair_attempts"."state" <> 'recorded' AND "itervane"."formal_repair_attempts"."receipt" IS NULL AND "itervane"."formal_repair_attempts"."receipt_sha256" IS NULL)
    OR ("itervane"."formal_repair_attempts"."state" = 'recorded' AND "itervane"."formal_repair_attempts"."settled_fence" = "itervane"."formal_repair_attempts"."fence" AND "itervane"."formal_repair_attempts"."settled_worker_id" = "itervane"."formal_repair_attempts"."worker_id"
      AND "itervane"."formal_repair_attempts"."receipt_sha256" ~ '^[a-f0-9]{64}$' AND octet_length("itervane"."formal_repair_attempts"."receipt"::text) <= 32768
      AND "itervane"."formal_repair_attempts"."receipt"->>'kind' = 'repair_receipt' AND "itervane"."formal_repair_attempts"."receipt"->'cleanupConfirmed' = 'true'::jsonb
      AND "itervane"."formal_repair_attempts"."receipt"->'sessionVerified' = 'true'::jsonb AND "itervane"."formal_repair_attempts"."receipt"->>'originSha256' = "itervane"."formal_repair_attempts"."origin_sha256"
      AND "itervane"."formal_repair_attempts"."receipt"->>'imageSha256' = "itervane"."formal_repair_attempts"."image_sha256"
      AND "itervane"."formal_repair_attempts"."receipt"#>>'{scope,requestId}' = "itervane"."formal_repair_attempts"."request_id"::text AND "itervane"."formal_repair_attempts"."receipt"#>>'{scope,operationId}' = "itervane"."formal_repair_attempts"."operation_id"::text
      AND "itervane"."formal_repair_attempts"."receipt"#>>'{scope,workspaceSha256}' = "itervane"."formal_repair_attempts"."workspace_sha256" AND "itervane"."formal_repair_attempts"."receipt"#>>'{scope,fence}' = "itervane"."formal_repair_attempts"."fence"::text
      AND "itervane"."formal_repair_attempts"."receipt"->>'domainId' = "itervane"."formal_repair_attempts"."receipt"#>>'{snapshot,runId}'
      AND "itervane"."formal_repair_attempts"."receipt"#>'{snapshot,offline}' = 'true'::jsonb AND "itervane"."formal_repair_attempts"."receipt"#>'{snapshot,readOnly}' = 'true'::jsonb)
  ) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "itervane"."formal_repair_operations" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"call_key_sha256" text NOT NULL,
	"input_sha256" text NOT NULL,
	"command_sha256" text NOT NULL,
	"command" text NOT NULL,
	"finding_ids" jsonb NOT NULL,
	"prepared_fence" integer NOT NULL,
	"worker_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "formal_repair_operation_call" UNIQUE("run_id","call_key_sha256"),
	CONSTRAINT "formal_repair_operation_command" CHECK (("itervane"."formal_repair_operations"."prepared_fence" > 0 AND "itervane"."formal_repair_operations"."call_key_sha256" ~ '^[a-f0-9]{64}$'
    AND "itervane"."formal_repair_operations"."input_sha256" ~ '^[a-f0-9]{64}$' AND octet_length("itervane"."formal_repair_operations"."command") BETWEEN 1 AND 2097152
    AND "itervane"."formal_repair_operations"."command_sha256" = encode(sha256(convert_to("itervane"."formal_repair_operations"."command", 'UTF8')), 'hex')
    AND "itervane"."formal_repair_operations"."command"::jsonb#>>'{workspace,operationId}' = "itervane"."formal_repair_operations"."operation_id"::text
    AND "itervane"."formal_repair_operations"."command"::jsonb#>>'{workspace,repairInputSha256}' = "itervane"."formal_repair_operations"."input_sha256"
    AND jsonb_typeof("itervane"."formal_repair_operations"."finding_ids") = 'array' AND jsonb_array_length("itervane"."formal_repair_operations"."finding_ids") BETWEEN 1 AND 32) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."formal_repair_attempts" ADD CONSTRAINT "formal_repair_attempts_operation_id_formal_repair_operations_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "itervane"."formal_repair_operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."formal_repair_operations" ADD CONSTRAINT "formal_repair_operations_run_id_formal_repair_inputs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."formal_repair_inputs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "formal_repair_open_attempt" ON "itervane"."formal_repair_attempts" USING btree ("operation_id") WHERE "itervane"."formal_repair_attempts"."state" <> 'closed';
--> statement-breakpoint
CREATE FUNCTION itervane.guard_formal_repair_operation() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  command_document jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_repair_operation_is_retained';
  END IF;
  command_document := NEW.command::jsonb;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.execution_slot slot
    JOIN itervane.tasks task ON task.id = slot.task_id
    JOIN itervane.task_runs run ON run.id = slot.run_id AND run.task_id = task.id
    JOIN itervane.formal_repair_inputs input ON input.run_id = run.id
    WHERE slot.id = 1 AND run.id = NEW.run_id AND slot.fence = NEW.prepared_fence AND slot.worker_id = NEW.worker_id
      AND slot.lease_until > pg_catalog.clock_timestamp() AND task.state = 'running' AND task.generation = run.generation
      AND input.sha256 = NEW.input_sha256 AND NEW.finding_ids <@ (input.document->'findingIds')
      AND command_document#>'{workspace,source}' = input.document->'source'
      AND command_document#>>'{workspace,baseSnapshotSha256}' = input.document#>>'{inspection,snapshotSha256}'
      AND command_document#>>'{patch,baseSnapshotSha256}' = input.document#>>'{inspection,snapshotSha256}'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_repair_operation_authority_or_input_mismatch';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_repair_operation_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.formal_repair_operations
FOR EACH ROW EXECUTE FUNCTION itervane.guard_formal_repair_operation();
--> statement-breakpoint
CREATE FUNCTION itervane.guard_formal_repair_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  settlement_fields text[] := ARRAY['state', 'settled_fence', 'settled_worker_id', 'settled_at', 'receipt', 'receipt_sha256'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_repair_attempt_is_retained';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'reserved' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_repair_attempt_must_be_reserved';
    END IF;
  ELSIF (pg_catalog.to_jsonb(OLD) - settlement_fields) IS DISTINCT FROM (pg_catalog.to_jsonb(NEW) - settlement_fields)
    OR NOT (OLD.state = 'reserved' AND NEW.state IN ('recorded', 'closed', 'uncertain')
      OR OLD.state = 'uncertain' AND NEW.state = 'closed' AND NEW.settled_fence > OLD.fence AND NEW.settled_fence >= OLD.settled_fence)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_repair_attempt_transition';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.execution_slot slot
    JOIN itervane.tasks task ON task.id = slot.task_id
    JOIN itervane.task_runs run ON run.id = slot.run_id AND run.task_id = task.id
    JOIN itervane.formal_repair_operations operation ON operation.run_id = run.id
    JOIN itervane.formal_repair_inputs input ON input.run_id = run.id AND input.sha256 = operation.input_sha256
    JOIN itervane.formal_audit_inputs audit ON audit.run_id = run.id
    JOIN itervane.inspection_attempts inspection ON inspection.request_id = audit.inspection_request_id
    WHERE slot.id = 1 AND operation.operation_id = NEW.operation_id AND task.generation = run.generation
      AND slot.lease_until > pg_catalog.clock_timestamp()
      AND slot.fence = COALESCE(NEW.settled_fence, NEW.fence) AND slot.worker_id = COALESCE(NEW.settled_worker_id, NEW.worker_id)
      AND (task.state = 'running' OR (task.state = 'cancel_requested' AND NEW.state IN ('closed', 'uncertain')))
      AND inspection.state = 'recorded' AND inspection.receipt_sha256 = input.document#>>'{inspection,receiptSha256}'
      AND inspection.origin_sha256 = NEW.origin_sha256
      AND (NEW.state <> 'recorded' OR (
        NEW.receipt#>>'{scope,runId}' = run.id::text AND NEW.receipt#>>'{scope,taskId}' = task.id::text
        AND NEW.receipt#>>'{scope,projectId}' = task.project_id::text AND NEW.receipt#>>'{scope,generation}' = run.generation::text
        AND NEW.receipt#>>'{scope,repositoryId}' = task.repository_id::text AND NEW.receipt#>>'{scope,commit}' = task.commit
        AND NEW.receipt#>>'{scope,repairInputSha256}' = input.sha256
        AND NEW.receipt#>>'{scope,commandSha256}' = operation.command_sha256
        AND NEW.receipt#>>'{scope,commandBytes}' = pg_catalog.octet_length(operation.command)::text
        AND NEW.receipt#>>'{scope,baseSnapshotSha256}' = input.document#>>'{inspection,snapshotSha256}'
        AND NEW.receipt->>'commitSha256' = inspection.receipt->>'commitSha256'
        AND NEW.receipt#>>'{snapshot,tree}' = inspection.receipt#>>'{snapshot,tree}'
        AND NEW.receipt#>>'{snapshot,files}' = inspection.receipt#>>'{snapshot,files}'
        AND NEW.receipt#>>'{snapshot,manifestSha256}' = input.document#>>'{inspection,snapshotSha256}'
        AND NEW.receipt#>>'{snapshot,commandSha256}' = operation.command_sha256
        AND NEW.receipt#>>'{snapshot,candidate,operationId}' = operation.operation_id::text
        AND NEW.receipt#>>'{snapshot,candidate,repairInputSha256}' = input.sha256
        AND NEW.receipt#>>'{snapshot,candidate,baseSnapshotSha256}' = input.document#>>'{inspection,snapshotSha256}'
      ))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_repair_attempt_authority_or_receipt_mismatch';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_repair_attempt_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.formal_repair_attempts
FOR EACH ROW EXECUTE FUNCTION itervane.guard_formal_repair_attempt();
