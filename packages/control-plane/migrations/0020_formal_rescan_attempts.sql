CREATE TABLE "itervane"."formal_rescan_attempts" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"input_sha256" text NOT NULL,
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
	CONSTRAINT "formal_rescan_attempt_per_fence" UNIQUE("run_id","fence"),
	CONSTRAINT "formal_rescan_attempt_coordinates" CHECK ("itervane"."formal_rescan_attempts"."fence" > 0 AND "itervane"."formal_rescan_attempts"."input_sha256" ~ '^[a-f0-9]{64}$'
    AND "itervane"."formal_rescan_attempts"."workspace_sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."formal_rescan_attempts"."image_sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."formal_rescan_attempts"."origin_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "formal_rescan_attempt_state" CHECK ((("itervane"."formal_rescan_attempts"."state" = 'reserved' AND "itervane"."formal_rescan_attempts"."settled_fence" IS NULL
    AND "itervane"."formal_rescan_attempts"."settled_worker_id" IS NULL AND "itervane"."formal_rescan_attempts"."settled_at" IS NULL) OR ("itervane"."formal_rescan_attempts"."state" IN ('closed', 'uncertain', 'recorded')
    AND "itervane"."formal_rescan_attempts"."settled_fence" >= "itervane"."formal_rescan_attempts"."fence" AND "itervane"."formal_rescan_attempts"."settled_worker_id" IS NOT NULL AND "itervane"."formal_rescan_attempts"."settled_at" IS NOT NULL)) IS TRUE),
	CONSTRAINT "formal_rescan_attempt_receipt" CHECK ((("itervane"."formal_rescan_attempts"."state" <> 'recorded' AND "itervane"."formal_rescan_attempts"."receipt_sha256" IS NULL AND "itervane"."formal_rescan_attempts"."receipt" IS NULL) OR (
    "itervane"."formal_rescan_attempts"."state" = 'recorded' AND "itervane"."formal_rescan_attempts"."settled_fence" = "itervane"."formal_rescan_attempts"."fence" AND "itervane"."formal_rescan_attempts"."settled_worker_id" = "itervane"."formal_rescan_attempts"."worker_id"
    AND "itervane"."formal_rescan_attempts"."receipt_sha256" ~ '^[a-f0-9]{64}$' AND octet_length("itervane"."formal_rescan_attempts"."receipt"::text) <= 9437184
    AND "itervane"."formal_rescan_attempts"."receipt"->>'kind' = 'verification_receipt' AND "itervane"."formal_rescan_attempts"."receipt"->'cleanupConfirmed' = 'true'::jsonb
    AND "itervane"."formal_rescan_attempts"."receipt"->'sessionVerified' = 'true'::jsonb AND "itervane"."formal_rescan_attempts"."receipt"->>'originSha256' = "itervane"."formal_rescan_attempts"."origin_sha256"
    AND "itervane"."formal_rescan_attempts"."receipt"->>'imageSha256' = "itervane"."formal_rescan_attempts"."image_sha256" AND "itervane"."formal_rescan_attempts"."receipt"->>'domainId' = "itervane"."formal_rescan_attempts"."receipt"#>>'{snapshot,runId}'
    AND "itervane"."formal_rescan_attempts"."receipt"#>>'{scope,requestId}' = "itervane"."formal_rescan_attempts"."request_id"::text AND "itervane"."formal_rescan_attempts"."receipt"#>>'{scope,runId}' = "itervane"."formal_rescan_attempts"."run_id"::text
    AND "itervane"."formal_rescan_attempts"."receipt"#>>'{scope,fence}' = "itervane"."formal_rescan_attempts"."fence"::text AND "itervane"."formal_rescan_attempts"."receipt"#>>'{scope,workspaceSha256}' = "itervane"."formal_rescan_attempts"."workspace_sha256"
    AND "itervane"."formal_rescan_attempts"."receipt"#>>'{scope,verificationInputSha256}' = "itervane"."formal_rescan_attempts"."input_sha256"
    AND "itervane"."formal_rescan_attempts"."receipt"#>'{snapshot,offline}' = 'true'::jsonb AND "itervane"."formal_rescan_attempts"."receipt"#>'{snapshot,readOnly}' = 'true'::jsonb)) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."formal_rescan_attempts" ADD CONSTRAINT "formal_rescan_attempts_run_id_formal_verification_inputs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."formal_verification_inputs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "formal_rescan_open_attempt" ON "itervane"."formal_rescan_attempts" USING btree ("run_id") WHERE "itervane"."formal_rescan_attempts"."state" <> 'closed';
--> statement-breakpoint
CREATE FUNCTION itervane.guard_formal_rescan_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  settlement_fields text[] := ARRAY['state', 'settled_fence', 'settled_worker_id', 'settled_at', 'receipt', 'receipt_sha256'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_rescan_attempt_is_retained';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'reserved' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_rescan_attempt_must_be_reserved';
    END IF;
  ELSIF (pg_catalog.to_jsonb(OLD) - settlement_fields) IS DISTINCT FROM (pg_catalog.to_jsonb(NEW) - settlement_fields)
    OR NOT (OLD.state = 'reserved' AND NEW.state IN ('recorded', 'closed', 'uncertain')
      OR OLD.state = 'uncertain' AND NEW.state = 'closed' AND NEW.settled_fence > OLD.fence
      AND NEW.settled_fence >= OLD.settled_fence)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_rescan_attempt_transition';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.execution_slot slot
    JOIN itervane.tasks task ON task.id = slot.task_id
    JOIN itervane.task_runs run ON run.id = slot.run_id AND run.task_id = task.id
    JOIN itervane.formal_verification_inputs input ON input.run_id = run.id
    JOIN itervane.inspection_attempts inspection ON inspection.run_id = run.id AND inspection.state = 'recorded'
    WHERE slot.id = 1 AND run.id = NEW.run_id AND task.generation = run.generation
      AND slot.lease_until > pg_catalog.clock_timestamp()
      AND slot.fence = COALESCE(NEW.settled_fence, NEW.fence) AND slot.worker_id = COALESCE(NEW.settled_worker_id, NEW.worker_id)
      AND (task.state = 'running' OR (task.state = 'cancel_requested' AND NEW.state IN ('closed', 'uncertain')))
      AND input.sha256 = NEW.input_sha256 AND NEW.image_sha256 = input.document#>>'{profile,runnerImageSha256}'
      AND inspection.request_id::text = input.document#>>'{inspection,requestId}'
      AND inspection.receipt_sha256 = input.document#>>'{inspection,receiptSha256}' AND inspection.origin_sha256 = NEW.origin_sha256
      AND (NEW.state <> 'recorded' OR (
        NEW.receipt#>>'{scope,operation}' = 'verify_source'
        AND NEW.receipt#>>'{scope,taskId}' = task.id::text AND NEW.receipt#>>'{scope,projectId}' = task.project_id::text
        AND NEW.receipt#>>'{scope,generation}' = task.generation::text
        AND NEW.receipt#>>'{scope,commit}' = task.commit AND NEW.receipt#>>'{scope,repositoryId}' = task.repository_id::text
        AND NEW.receipt#>>'{scope,baseSnapshotSha256}' = input.document#>>'{inspection,snapshotSha256}'
        AND NEW.receipt#>>'{scope,targetManifestSha256}' = input.document#>>'{subject,manifestSha256}'
        AND NEW.receipt#>>'{scope,scannerInputsSha256}' = input.document#>>'{profile,scannerInputsSha256}'
        AND NEW.receipt#>>'{scope,runnerImageSha256}' = input.document#>>'{profile,runnerImageSha256}'
        AND NEW.receipt#>>'{scope,commandSha256}' = NEW.receipt#>>'{snapshot,commandSha256}'
        AND NEW.receipt#>>'{snapshot,verificationInputSha256}' = input.sha256
        AND NEW.receipt#>>'{snapshot,inputsSha256}' = input.document#>>'{profile,scannerInputsSha256}'
        AND NEW.receipt#>>'{snapshot,manifestSha256}' = input.document#>>'{inspection,snapshotSha256}'
        AND NEW.receipt#>>'{snapshot,tree}' = inspection.receipt#>>'{snapshot,tree}'
        AND NEW.receipt->>'commitSha256' = inspection.receipt->>'commitSha256'
        AND (CASE input.document#>>'{subject,kind}'
          WHEN 'original' THEN NEW.receipt#>'{snapshot,target}' = 'null'::jsonb
          WHEN 'repair' THEN NEW.receipt#>>'{snapshot,target,manifestSha256}' = input.document#>>'{subject,manifestSha256}'
            AND NEW.receipt#>>'{snapshot,target,patchSha256}' = input.document#>>'{subject,patchSha256}'
          ELSE false END)
      )) IS TRUE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_rescan_attempt_authority_or_evidence_mismatch';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_rescan_attempt_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.formal_rescan_attempts
FOR EACH ROW EXECUTE FUNCTION itervane.guard_formal_rescan_attempt();
