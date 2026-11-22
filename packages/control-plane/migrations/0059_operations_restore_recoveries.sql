CREATE TABLE "itervane"."operations_restore_recoveries" (
	"execution_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"fence" integer NOT NULL,
	"worker_id" uuid NOT NULL,
	"state" text DEFAULT 'observing' NOT NULL,
	"failure" text,
	"proof" jsonb,
	"proof_sha256" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "operations_restore_recoveries_execution_id_attempt_pk" PRIMARY KEY("execution_id","attempt"),
	CONSTRAINT "operations_restore_recovery_fence" UNIQUE("execution_id","fence"),
	CONSTRAINT "operations_restore_recovery_coordinates" CHECK ("itervane"."operations_restore_recoveries"."attempt" BETWEEN 1 AND 3 AND "itervane"."operations_restore_recoveries"."fence" > 0),
	CONSTRAINT "operations_restore_recovery_lifecycle" CHECK (((
    ("itervane"."operations_restore_recoveries"."state" = 'observing' AND "itervane"."operations_restore_recoveries"."completed_at" IS NULL AND "itervane"."operations_restore_recoveries"."failure" IS NULL AND "itervane"."operations_restore_recoveries"."proof" IS NULL AND "itervane"."operations_restore_recoveries"."proof_sha256" IS NULL)
    OR ("itervane"."operations_restore_recoveries"."completed_at" >= "itervane"."operations_restore_recoveries"."created_at" AND (
      ("itervane"."operations_restore_recoveries"."state" = 'verified' AND "itervane"."operations_restore_recoveries"."failure" IS NULL AND jsonb_typeof("itervane"."operations_restore_recoveries"."proof") = 'object'
        AND octet_length("itervane"."operations_restore_recoveries"."proof"::text) <= 4096 AND "itervane"."operations_restore_recoveries"."proof_sha256" ~ '^[a-f0-9]{64}$')
      OR ("itervane"."operations_restore_recoveries"."proof" IS NULL AND "itervane"."operations_restore_recoveries"."proof_sha256" IS NULL AND (
        ("itervane"."operations_restore_recoveries"."state" = 'retry' AND "itervane"."operations_restore_recoveries"."attempt" < 3 AND "itervane"."operations_restore_recoveries"."failure" IN ('update_pending', 'unavailable', 'unhealthy', 'lease_expired'))
        OR ("itervane"."operations_restore_recoveries"."state" = 'manual_review' AND ("itervane"."operations_restore_recoveries"."failure" IN ('target_changed', 'missing_update', 'update_failed')
          OR ("itervane"."operations_restore_recoveries"."attempt" = 3 AND "itervane"."operations_restore_recoveries"."failure" IN ('update_pending', 'unavailable', 'unhealthy', 'lease_expired'))))
      ))
    ))
  ) IS TRUE))
);
--> statement-breakpoint
ALTER TABLE "itervane"."operations_restore_recoveries" ADD CONSTRAINT "operations_restore_recoveries_execution_id_operations_execution_intents_execution_id_fk" FOREIGN KEY ("execution_id") REFERENCES "itervane"."operations_execution_intents"("execution_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_restore_recovery() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  bound record;
  last_attempt record;
  observed jsonb;
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND (
    ROW(NEW.execution_id, NEW.attempt, NEW.fence, NEW.worker_id, NEW.created_at, NEW.completed_at)
      IS DISTINCT FROM ROW(OLD.execution_id, OLD.attempt, OLD.fence, OLD.worker_id, OLD.created_at, OLD.completed_at)
    OR OLD.state <> 'observing' OR NEW.state = 'observing'
  )) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restore_recovery_is_immutable';
  END IF;
  PERFORM 1 FROM itervane.execution_slot WHERE id = 1 FOR UPDATE;
  PERFORM 1 FROM itervane.operations_executions execution
    JOIN itervane.environments environment ON environment.id = execution.environment_id
    WHERE execution.id = NEW.execution_id FOR UPDATE OF environment;
  SELECT GREATEST(intent.created_at, execution.created_at, (
      SELECT MAX(COALESCE(step.recorded_at, step.sent_at)) FROM itervane.operations_restore_steps step WHERE step.execution_id = intent.execution_id
    )) AS intent_time, intent.restore_plan AS plan, intent.restore_plan_sha256 AS plan_sha256,
    execution.environment_id, proposal.document AS proposal, slot.lease_until > clock_timestamp() AS live
  INTO bound
  FROM itervane.operations_execution_intents intent
    JOIN itervane.operations_executions execution ON execution.id = intent.execution_id AND execution.state = 'reserved'
    JOIN itervane.operations_proposals proposal ON proposal.id = execution.proposal_id AND proposal.document#>>'{action,kind}' = 'rollback'
    JOIN itervane.operations_execution_schedules schedule ON schedule.execution_id = execution.id AND schedule.wakeup_job_id IS NULL
    JOIN itervane.tasks task ON task.id = schedule.task_id AND task.state = 'running' AND task.generation = intent.generation
    JOIN itervane.task_runs run ON run.id = schedule.run_id AND run.task_id = task.id AND run.generation = intent.generation
      AND run.state = task.state AND run.role = 'operations'
    JOIN itervane.run_runtime phase ON phase.run_id = run.id AND phase.reason = 'operations_execution_reconciling'
    JOIN itervane.execution_slot slot ON slot.id = 1 AND slot.task_id = task.id AND slot.run_id = run.id
      AND slot.fence = NEW.fence AND slot.worker_id = NEW.worker_id
  WHERE intent.execution_id = NEW.execution_id AND intent.restore_plan IS NOT NULL AND intent.fence < NEW.fence;
  IF NOT FOUND OR bound.live IS DISTINCT FROM (NEW.failure IS DISTINCT FROM 'lease_expired') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restore_recovery_lease_required';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT attempt, fence, state, completed_at INTO last_attempt FROM itervane.operations_restore_recoveries
    WHERE execution_id = NEW.execution_id ORDER BY attempt DESC LIMIT 1;
    IF NEW.state <> 'observing' OR NEW.attempt <> COALESCE(last_attempt.attempt, 0) + 1
      OR (last_attempt.attempt IS NOT NULL AND (last_attempt.state <> 'retry' OR last_attempt.fence >= NEW.fence))
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restore_recovery_attempt_required';
    END IF;
    NEW.created_at := GREATEST(bound.intent_time, last_attempt.completed_at, clock_timestamp());
    RETURN NEW;
  END IF;

  IF NEW.state = 'verified' THEN
    observed := NEW.proof->'runtime';
    IF NOT ((
      NEW.proof->'version' = '1'::jsonb AND NEW.proof->>'executionId' = NEW.execution_id::text
      AND NEW.proof->>'attempt' = NEW.attempt::text AND NEW.proof->>'fence' = NEW.fence::text
      AND NEW.proof->>'planSha256' = bound.plan_sha256 AND NEW.proof->>'restoreOperationId' = bound.plan#>>'{restore,operationId}'
      AND NEW.proof#>>'{update,status}' = 'Complete' AND NEW.proof#>'{update,success}' = 'true'::jsonb
      AND NEW.proof#>>'{update,deploymentId}' = bound.plan#>>'{target,deploymentId}'
      AND NEW.proof#>>'{update,actorId}' = bound.plan#>>'{target,komodo,actorId}'
      AND observed->>'containerId' ~ '^[a-f0-9]{64}$' AND observed->>'containerId' <> bound.plan#>>'{current,containerId}'
      AND observed->>'configDigest' = bound.plan#>>'{restore,configDigest}'
      AND observed->>'runtimeConfigSha256' = bound.plan#>>'{target,runtimeConfigSha256}'
      AND observed->>'rolloutCheckSha256' = bound.plan->>'rolloutCheckSha256'
      AND observed->>'version' = bound.plan#>>'{restore,publishedVersion}'
      AND observed->'anonymousStatus' IN ('401'::jsonb, '403'::jsonb) AND observed->'healthStatus' = '200'::jsonb
      AND EXISTS (
        SELECT 1 FROM itervane.operations_restore_steps sent
        WHERE sent.execution_id = NEW.execution_id AND sent.kind = 'deploy' AND sent.fence < NEW.fence
          AND sent.plan_sha256 = bound.plan_sha256 AND sent.receipt->>'updateId' = NEW.proof#>>'{update,updateId}'
      )
      AND EXISTS (
        SELECT 1 FROM itervane.environments environment
          JOIN itervane.operations_targets enrollment ON enrollment.environment_id = environment.id
          JOIN itervane.formal_release_targets mapping ON mapping.environment_id = environment.id
          JOIN itervane.release_operations prior ON prior.environment_id = environment.id AND prior.state = 'verified_formal'
            AND prior.id::text = NEW.proof->>'restoreOperationId'
          JOIN itervane.formal_release_rollout_attempts archive ON archive.operation_id = prior.id AND archive.state = 'verified'
        WHERE environment.id = bound.environment_id AND environment.access = 'protected'
          AND enrollment.sha256 = bound.proposal#>>'{target,enrollmentSha256}'
          AND mapping.sha256 = bound.plan->>'mappingSha256' AND mapping.revision::text = bound.plan->>'targetRevision'
          AND observed->>'network' = mapping.document#>>'{rolloutCheck,network}'
          AND observed->>'imageReference' = archive.proof#>>'{runtime,imageReference}'
      )
    ) IS TRUE) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restore_recovery_proof_required';
    END IF;
  END IF;
  NEW.completed_at := GREATEST(OLD.created_at, clock_timestamp());
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_restore_recovery_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.operations_restore_recoveries
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_restore_recovery();
--> statement-breakpoint
CREATE FUNCTION itervane.require_restore_recovery_transition() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM itervane.operations_executions execution
      JOIN itervane.operations_execution_schedules schedule ON schedule.execution_id = execution.id
      JOIN itervane.tasks task ON task.id = schedule.task_id
      JOIN itervane.task_runs run ON run.id = schedule.run_id AND run.task_id = task.id AND run.state = task.state AND run.generation = task.generation
      JOIN itervane.run_runtime phase ON phase.run_id = run.id
      JOIN itervane.task_events event ON event.task_id = task.id AND event.sequence = task.version AND event.state = task.state
        AND event.type = 'task.operations_restore_recovery_recorded' AND event.detail->>'executionId' = execution.id::text
        AND event.detail->>'recoveryAttempt' = NEW.attempt::text AND event.detail->>'fence' = NEW.fence::text
        AND event.detail->>'recoverySha256' IS NOT DISTINCT FROM NEW.proof_sha256
    WHERE execution.id = NEW.execution_id AND execution.state = 'reserved'
      AND NOT EXISTS (SELECT 1 FROM itervane.execution_slot slot WHERE slot.task_id = task.id)
      AND (
        (NEW.state = 'verified' AND task.state = 'reconciling' AND phase.reason = 'operations_restore_recovery_verified' AND schedule.wakeup_job_id IS NULL)
        OR (NEW.state = 'retry' AND task.state = 'reconciling' AND phase.reason = 'operations_execution_reconciling' AND schedule.wakeup_job_id IS NOT NULL)
        OR (NEW.state = 'manual_review' AND task.state = 'needs_human' AND phase.reason = 'operations_restore_recovery_manual' AND schedule.wakeup_job_id IS NULL)
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restore_recovery_must_record_outcome';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER operations_restore_recovery_transition AFTER UPDATE ON itervane.operations_restore_recoveries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION itervane.require_restore_recovery_transition();
