CREATE TABLE "itervane"."operations_execution_schedules" (
	"execution_id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"wakeup_job_id" uuid,
	CONSTRAINT "operations_execution_scheduled_task" UNIQUE("task_id"),
	CONSTRAINT "operations_execution_scheduled_wakeup" UNIQUE("wakeup_job_id")
);
--> statement-breakpoint
ALTER TABLE "itervane"."operations_execution_schedules" ADD CONSTRAINT "operations_execution_schedules_execution_id_operations_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "itervane"."operations_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_execution_schedules" ADD CONSTRAINT "operations_execution_scheduled_run_fk" FOREIGN KEY ("run_id","task_id") REFERENCES "itervane"."task_runs"("id","task_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_execution_schedule() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_execution_schedule_is_retained';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.execution_id, NEW.task_id, NEW.run_id) IS DISTINCT FROM ROW(OLD.execution_id, OLD.task_id, OLD.run_id)
      OR OLD.wakeup_job_id IS NULL OR NEW.wakeup_job_id IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM itervane.operations_executions WHERE id = NEW.execution_id AND state = 'blocked')
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_execution_schedule_invalid_transition';
    END IF;
    RETURN NEW;
  END IF;

  PERFORM 1 FROM itervane.operations_executions WHERE id = NEW.execution_id FOR UPDATE;
  IF NEW.wakeup_job_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM itervane.operations_executions execution
      JOIN itervane.operations_proposals proposal ON proposal.id = execution.proposal_id
      JOIN itervane.operations_requests diagnosis ON diagnosis.run_id = proposal.diagnosis_run_id
      JOIN itervane.tasks source_task ON source_task.id = diagnosis.task_id
      JOIN itervane.operations_decisions approval ON approval.proposal_id = proposal.id
        AND approval.version = execution.decision_version AND approval.action = 'confirm'
      JOIN itervane.tasks task ON task.id = NEW.task_id AND task.project_id = diagnosis.project_id
      JOIN itervane.task_runs run ON run.id = NEW.run_id AND run.task_id = task.id AND run.generation = task.generation
      JOIN itervane.run_runtime runtime ON runtime.run_id = run.id AND runtime.task_id = task.id
    WHERE execution.id = NEW.execution_id AND execution.state = 'reserved'
      AND proposal.valid_until > clock_timestamp() AND task.id <> diagnosis.task_id
      AND task.requested_by = approval.actor_id AND task.request_key = execution.id::text
      AND task.request_hash = execution.proposal_fingerprint AND task.generation = 1
      AND task.repository_id::text = diagnosis.document#>>'{source,repositoryId}'
      AND task.commit = diagnosis.document#>>'{source,commit}'
      AND task.data_class = diagnosis.document->>'dataClass' AND task.locale = source_task.locale
      AND task.state = 'queued' AND run.state = 'queued' AND run.role = 'operations'
      AND run.wakeup_job_id IS NULL AND runtime.reason = 'operations_execution_queued'
      AND NOT EXISTS (SELECT 1 FROM itervane.operations_requests WHERE run_id = run.id)
      AND NOT EXISTS (SELECT 1 FROM itervane.operations_decisions later
        WHERE later.proposal_id = proposal.id AND later.version > approval.version)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_execution_schedule_binding';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_execution_schedule_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.operations_execution_schedules
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_execution_schedule();
--> statement-breakpoint
CREATE FUNCTION itervane.require_closed_operations_execution_schedule() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM itervane.operations_execution_schedules schedule
      JOIN itervane.tasks task ON task.id = schedule.task_id
      JOIN itervane.task_runs run ON run.id = schedule.run_id
    WHERE schedule.execution_id = NEW.id AND (
      schedule.wakeup_job_id IS NOT NULL OR task.state <> run.state
      OR (NEW.blocked_reason = 'approval_revoked' AND task.state <> 'cancelled')
      OR (NEW.blocked_reason = 'proposal_expired' AND task.state <> 'needs_human')
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_execution_schedule_must_close';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER operations_execution_schedule_closure AFTER UPDATE ON itervane.operations_executions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state = 'blocked')
EXECUTE FUNCTION itervane.require_closed_operations_execution_schedule();
