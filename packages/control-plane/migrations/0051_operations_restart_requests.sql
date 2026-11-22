CREATE TABLE "itervane"."operations_restart_requests" (
	"execution_id" uuid PRIMARY KEY NOT NULL,
	"call_sha256" text NOT NULL,
	"document" jsonb NOT NULL,
	"approval_id" text,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "operations_restart_native_approval" UNIQUE("approval_id"),
	CONSTRAINT "operations_restart_request_binding" CHECK (("itervane"."operations_restart_requests"."call_sha256" ~ '^[a-f0-9]{64}$'
    AND "itervane"."operations_restart_requests"."document"->>'credentialSha256' ~ '^[a-f0-9]{64}$') IS TRUE),
	CONSTRAINT "operations_restart_request_receipt" CHECK ((("itervane"."operations_restart_requests"."approval_id" IS NULL AND "itervane"."operations_restart_requests"."received_at" IS NULL)
    OR ("itervane"."operations_restart_requests"."approval_id" ~ '^[a-f0-9]{32}$' AND "itervane"."operations_restart_requests"."received_at" >= "itervane"."operations_restart_requests"."created_at")) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."operations_restart_requests" ADD CONSTRAINT "operations_restart_request_intent_fk" FOREIGN KEY ("execution_id") REFERENCES "itervane"."operations_execution_intents"("execution_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_restart_request() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  bound record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_request_is_retained';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    ROW(NEW.execution_id, NEW.call_sha256, NEW.document, NEW.created_at, NEW.received_at)
      IS DISTINCT FROM ROW(OLD.execution_id, OLD.call_sha256, OLD.document, OLD.created_at, OLD.received_at)
    OR OLD.approval_id IS NOT NULL OR NEW.approval_id IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_request_is_immutable';
  END IF;

  PERFORM 1 FROM itervane.execution_slot WHERE id = 1 FOR UPDATE;
  PERFORM 1 FROM itervane.operations_executions execution
    JOIN itervane.environments environment ON environment.id = execution.environment_id
    WHERE execution.id = NEW.execution_id FOR UPDATE OF environment;
  SELECT proposal.id AS proposal_id, proposal.document AS proposal, proposal.valid_until, execution.environment_id,
    execution.decision_version, intent.created_at AS intent_time
  INTO bound
  FROM itervane.operations_execution_intents intent
  JOIN itervane.operations_executions execution ON execution.id = intent.execution_id AND execution.state = 'reserved'
  JOIN itervane.operations_proposals proposal ON proposal.id = execution.proposal_id
    AND proposal.document#>>'{action,kind}' = 'restart'
  JOIN itervane.operations_execution_schedules schedule ON schedule.execution_id = intent.execution_id AND schedule.wakeup_job_id IS NULL
  JOIN itervane.tasks task ON task.id = schedule.task_id AND task.generation = intent.generation AND task.state = 'running'
  JOIN itervane.task_runs run ON run.id = schedule.run_id AND run.task_id = task.id AND run.generation = task.generation
    AND run.state = task.state AND run.role = 'operations'
  JOIN itervane.run_runtime runtime ON runtime.run_id = run.id AND runtime.task_id = task.id
    AND runtime.reason = 'operations_execution_dispatch_intended'
  JOIN itervane.execution_slot slot ON slot.id = 1 AND slot.task_id = task.id AND slot.run_id = run.id
    AND slot.worker_id = intent.worker_id AND slot.fence = intent.fence AND slot.lease_until > clock_timestamp()
  WHERE intent.execution_id = NEW.execution_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_request_lease_required';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.approval_id IS NOT NULL OR NEW.received_at IS NOT NULL OR bound.valid_until <= clock_timestamp()
      OR EXISTS (SELECT 1 FROM itervane.operations_decisions decision
        WHERE decision.proposal_id = bound.proposal_id AND decision.version > bound.decision_version)
      OR NOT EXISTS (
        SELECT 1 FROM itervane.operations_targets target
        JOIN itervane.environments environment ON environment.id = target.environment_id AND environment.access = 'protected'
        WHERE target.environment_id = bound.environment_id
          AND target.sha256 = bound.proposal#>>'{target,enrollmentSha256}'
          AND NEW.document = jsonb_build_object(
            'version', 1, 'tool', 'restart_container', 'credentialSha256', NEW.document->>'credentialSha256',
            'target', jsonb_build_object(
              'origin', target.document#>>'{whiskers,origin}', 'serverId', target.document#>>'{whiskers,serverId}',
              'containerId', bound.proposal#>>'{target,containerId}'
            )
          )
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_request_binding_required';
    END IF;
    NEW.created_at := GREATEST(bound.intent_time, clock_timestamp());
  ELSE
    -- A response may arrive after approval was revoked. Keep the receipt while continuing to hold the environment.
    NEW.received_at := GREATEST(OLD.created_at, clock_timestamp());
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_restart_request_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.operations_restart_requests
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_restart_request();
--> statement-breakpoint
CREATE FUNCTION itervane.require_operations_restart_pause() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM itervane.operations_execution_schedules schedule
    JOIN itervane.operations_execution_intents intent ON intent.execution_id = schedule.execution_id
    JOIN itervane.tasks task ON task.id = schedule.task_id
    JOIN itervane.task_runs run ON run.id = schedule.run_id AND run.task_id = task.id AND run.generation = intent.generation
      AND run.state = task.state AND run.role = 'operations'
    JOIN itervane.run_runtime runtime ON runtime.run_id = run.id AND runtime.task_id = task.id
    JOIN itervane.task_events event ON event.task_id = task.id AND event.sequence = task.version AND event.state = task.state
      AND event.type = 'task.operations_execution_native_approval' AND event.worker_id = intent.worker_id
    WHERE schedule.execution_id = NEW.execution_id AND (
      (task.state = 'waiting_approval' AND runtime.reason = 'operations_execution_native_approval' AND schedule.wakeup_job_id IS NULL)
      OR (task.state = 'reconciling' AND runtime.reason = 'operations_execution_reconciling' AND schedule.wakeup_job_id IS NOT NULL)
    )
      AND event.detail->>'nativeApprovalId' = NEW.approval_id AND event.detail->>'nativeCallSha256' = NEW.call_sha256
      AND event.detail->>'executionId' = NEW.execution_id::text AND event.detail->>'fence' = intent.fence::text
      AND NOT EXISTS (SELECT 1 FROM itervane.execution_slot slot WHERE slot.task_id = task.id)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_approval_must_pause';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER operations_restart_approval_pause AFTER UPDATE ON itervane.operations_restart_requests
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.approval_id IS NULL AND NEW.approval_id IS NOT NULL)
EXECUTE FUNCTION itervane.require_operations_restart_pause();
