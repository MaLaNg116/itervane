CREATE TABLE "itervane"."operations_restart_resumes" (
	"execution_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"actor_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"approval_id" text NOT NULL,
	"call_sha256" text NOT NULL,
	"expected_version" integer NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"worker_id" uuid,
	"fence" integer,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"prepared_at" timestamp with time zone,
	"recorded_at" timestamp with time zone,
	CONSTRAINT "operations_restart_resumes_execution_id_attempt_pk" PRIMARY KEY("execution_id","attempt"),
	CONSTRAINT "operations_restart_resume_key" UNIQUE("execution_id","idempotency_key"),
	CONSTRAINT "operations_restart_resume_identity" CHECK ("itervane"."operations_restart_resumes"."attempt" BETWEEN 1 AND 3 AND "itervane"."operations_restart_resumes"."expected_version" > 0
    AND "itervane"."operations_restart_resumes"."approval_id" ~ '^[a-f0-9]{32}$' AND "itervane"."operations_restart_resumes"."call_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "operations_restart_resume_stage" CHECK ((
    ("itervane"."operations_restart_resumes"."state" IN ('queued', 'blocked') AND "itervane"."operations_restart_resumes"."worker_id" IS NULL AND "itervane"."operations_restart_resumes"."fence" IS NULL AND "itervane"."operations_restart_resumes"."prepared_at" IS NULL
      AND (("itervane"."operations_restart_resumes"."state" = 'queued' AND "itervane"."operations_restart_resumes"."recorded_at" IS NULL) OR ("itervane"."operations_restart_resumes"."state" = 'blocked' AND "itervane"."operations_restart_resumes"."recorded_at" >= "itervane"."operations_restart_resumes"."created_at")))
    OR ("itervane"."operations_restart_resumes"."fence" > 0 AND "itervane"."operations_restart_resumes"."worker_id" IS NOT NULL AND "itervane"."operations_restart_resumes"."prepared_at" >= "itervane"."operations_restart_resumes"."created_at"
      AND (("itervane"."operations_restart_resumes"."state" = 'prepared' AND "itervane"."operations_restart_resumes"."recorded_at" IS NULL)
        OR ("itervane"."operations_restart_resumes"."state" IN ('pending', 'acknowledged', 'unknown') AND "itervane"."operations_restart_resumes"."recorded_at" >= "itervane"."operations_restart_resumes"."prepared_at")))
  ) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."operations_restart_resumes" ADD CONSTRAINT "operations_restart_resumes_execution_id_operations_restart_requests_execution_id_fk" FOREIGN KEY ("execution_id") REFERENCES "itervane"."operations_restart_requests"("execution_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_restart_resumes" ADD CONSTRAINT "operations_restart_resumes_actor_id_principals_id_fk" FOREIGN KEY ("actor_id") REFERENCES "itervane"."principals"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_restart_resume() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  bound record;
  previous record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_resume_is_retained';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW.execution_id, NEW.attempt, NEW.actor_id, NEW.grant_id, NEW.approval_id,
    NEW.call_sha256, NEW.expected_version, NEW.idempotency_key, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.execution_id, OLD.attempt, OLD.actor_id, OLD.grant_id, OLD.approval_id,
        OLD.call_sha256, OLD.expected_version, OLD.idempotency_key, OLD.created_at)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_resume_is_immutable';
  END IF;

  PERFORM 1 FROM itervane.operations_executions execution
    JOIN itervane.environments environment ON environment.id = execution.environment_id
    WHERE execution.id = NEW.execution_id FOR UPDATE OF environment;
  SELECT task.id AS task_id, task.state AS task_state, task.version AS task_version, runtime.reason,
    run.id AS run_id, intent.fence AS initial_fence, approval.actor_id, approval.grant_id, request.received_at,
    (proposal.valid_until > clock_timestamp() AND environment.access = 'protected'
      AND NOT EXISTS (SELECT 1 FROM itervane.operations_decisions withdrawal
        WHERE withdrawal.proposal_id = proposal.id AND withdrawal.version > approval.version)
      AND EXISTS (SELECT 1 FROM itervane.workspace_members owner
        WHERE owner.workspace_id = project.workspace_id AND owner.principal_id = approval.actor_id AND owner.grant_id = approval.grant_id)
      AND mapping.sha256 = proposal.document#>>'{target,mappingSha256}'
      AND target.sha256 = proposal.document#>>'{target,enrollmentSha256}'
    ) AS authorizable
  INTO bound
  FROM itervane.operations_restart_requests request
  JOIN itervane.operations_execution_intents intent ON intent.execution_id = request.execution_id
  JOIN itervane.operations_executions execution ON execution.id = request.execution_id AND execution.state = 'reserved'
  JOIN itervane.operations_proposals proposal ON proposal.id = execution.proposal_id
  JOIN itervane.operations_decisions approval ON approval.proposal_id = proposal.id
    AND approval.version = execution.decision_version AND approval.action = 'confirm'
  JOIN itervane.environments environment ON environment.id = execution.environment_id
  JOIN itervane.projects project ON project.id = environment.project_id
  JOIN itervane.formal_release_targets mapping ON mapping.environment_id = environment.id
  JOIN itervane.operations_targets target ON target.environment_id = environment.id
  JOIN itervane.operations_execution_schedules schedule ON schedule.execution_id = execution.id
  JOIN itervane.tasks task ON task.id = schedule.task_id AND task.generation = intent.generation
  JOIN itervane.task_runs run ON run.id = schedule.run_id AND run.task_id = task.id AND run.generation = task.generation
    AND run.state = task.state AND run.role = 'operations'
  JOIN itervane.run_runtime runtime ON runtime.run_id = run.id AND runtime.task_id = task.id
  WHERE request.execution_id = NEW.execution_id AND request.approval_id = NEW.approval_id
    AND request.call_sha256 = NEW.call_sha256;
  IF NOT FOUND OR (bound.actor_id, bound.grant_id) IS DISTINCT FROM (NEW.actor_id, NEW.grant_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_resume_binding_required';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT attempt, state INTO previous FROM itervane.operations_restart_resumes
      WHERE execution_id = NEW.execution_id ORDER BY attempt DESC LIMIT 1;
    IF NEW.state <> 'queued' OR bound.authorizable IS NOT TRUE
      OR bound.task_state <> 'waiting_approval' OR bound.reason IS DISTINCT FROM 'operations_execution_native_approval'
      OR bound.task_version <> NEW.expected_version OR NEW.attempt <> COALESCE(previous.attempt, 0) + 1
      OR (previous.attempt IS NOT NULL AND previous.state <> 'pending')
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_resume_request_required';
    END IF;
    NEW.created_at := GREATEST(bound.received_at, clock_timestamp());
    RETURN NEW;
  END IF;

  IF OLD.state = 'queued' AND NEW.state = 'blocked' THEN
    NEW.recorded_at := GREATEST(OLD.created_at, clock_timestamp());
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM itervane.execution_slot slot WHERE slot.id = 1 AND slot.task_id = bound.task_id
      AND slot.run_id = bound.run_id AND slot.worker_id = NEW.worker_id AND slot.fence = NEW.fence
      AND slot.fence > bound.initial_fence AND slot.lease_until > clock_timestamp())
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_resume_lease_required';
  END IF;
  IF OLD.state = 'queued' AND NEW.state = 'prepared' AND bound.authorizable
    AND bound.task_state = 'running' AND bound.reason = 'operations_restart_resume_claimed' THEN
    NEW.prepared_at := GREATEST(OLD.created_at, clock_timestamp());
    RETURN NEW;
  END IF;
  IF OLD.state = 'prepared' AND NEW.state IN ('pending', 'acknowledged', 'unknown')
    AND bound.task_state = 'running' AND bound.reason = 'operations_restart_resume_prepared'
    AND (NEW.worker_id, NEW.fence, NEW.prepared_at) IS NOT DISTINCT FROM (OLD.worker_id, OLD.fence, OLD.prepared_at)
  THEN
    NEW.recorded_at := GREATEST(OLD.prepared_at, clock_timestamp());
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_resume_invalid_transition';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_restart_resume_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.operations_restart_resumes
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_restart_resume();
--> statement-breakpoint
CREATE FUNCTION itervane.require_operations_restart_resume_transition() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM itervane.operations_execution_schedules schedule
    JOIN itervane.tasks task ON task.id = schedule.task_id
    JOIN itervane.task_runs run ON run.id = schedule.run_id AND run.task_id = task.id AND run.state = task.state
    JOIN itervane.run_runtime runtime ON runtime.run_id = run.id AND runtime.task_id = task.id
    WHERE schedule.execution_id = NEW.execution_id AND (
      (NEW.state = 'queued' AND task.state = 'queued' AND runtime.reason = 'operations_restart_resume_queued'
        AND schedule.wakeup_job_id IS NOT NULL)
      OR (NEW.state = 'prepared' AND task.state = 'running' AND runtime.reason = 'operations_restart_resume_prepared'
        AND schedule.wakeup_job_id IS NULL)
      OR (NEW.state IN ('pending', 'acknowledged', 'unknown', 'blocked')
        AND NOT EXISTS (SELECT 1 FROM itervane.execution_slot slot WHERE slot.task_id = task.id)
        AND ((NEW.state = 'pending' AND NEW.attempt < 3 AND task.state = 'waiting_approval'
          AND runtime.reason = 'operations_execution_native_approval' AND schedule.wakeup_job_id IS NULL)
          OR (task.state = 'reconciling' AND runtime.reason = 'operations_execution_reconciling' AND schedule.wakeup_job_id IS NOT NULL)))
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_resume_task_must_transition';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER operations_restart_resume_task_transition AFTER INSERT OR UPDATE ON itervane.operations_restart_resumes
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION itervane.require_operations_restart_resume_transition();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION itervane.guard_operations_execution_wakeup() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF ROW(NEW.execution_id, NEW.task_id, NEW.run_id) IS DISTINCT FROM ROW(OLD.execution_id, OLD.task_id, OLD.run_id)
    OR NEW.wakeup_job_id IS NOT DISTINCT FROM OLD.wakeup_job_id
    OR NOT EXISTS (
      SELECT 1 FROM itervane.operations_executions execution
        JOIN itervane.tasks task ON task.id = NEW.task_id
        JOIN itervane.task_runs run ON run.id = NEW.run_id AND run.task_id = task.id AND run.generation = task.generation
        JOIN itervane.run_runtime runtime ON runtime.run_id = run.id AND runtime.task_id = task.id
        LEFT JOIN itervane.operations_execution_intents intent ON intent.execution_id = execution.id
      WHERE execution.id = NEW.execution_id AND task.state = run.state AND run.role = 'operations'
        AND (
          (execution.state = 'blocked' AND NEW.wakeup_job_id IS NULL AND intent.execution_id IS NULL
            AND task.state IN ('cancelled', 'needs_human'))
          OR (execution.state = 'reserved' AND (
            (NEW.wakeup_job_id IS NOT NULL AND (
              (task.state = 'queued' AND runtime.reason = 'operations_execution_queued' AND intent.execution_id IS NULL)
              OR (task.state = 'queued' AND runtime.reason = 'operations_restart_resume_queued' AND intent.execution_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM itervane.operations_restart_resumes resume
                  WHERE resume.execution_id = execution.id AND resume.state = 'queued'))
              OR (task.state = 'reconciling' AND runtime.reason = 'operations_execution_reconciling' AND intent.execution_id IS NOT NULL)))
            OR (NEW.wakeup_job_id IS NULL AND task.state = 'running'
              AND runtime.reason IN ('operations_execution_claimed', 'operations_restart_resume_claimed', 'operations_execution_reconciling')
              AND EXISTS (SELECT 1 FROM itervane.execution_slot slot WHERE slot.id = 1
                AND slot.task_id = task.id AND slot.run_id = run.id AND slot.lease_until > clock_timestamp()))
          ))
        )
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_execution_schedule_invalid_transition';
  END IF;
  RETURN NEW;
END;
$$;
