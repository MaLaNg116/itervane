CREATE TABLE "itervane"."operations_execution_intents" (
	"execution_id" uuid PRIMARY KEY NOT NULL,
	"decision_version" integer NOT NULL,
	"proposal_fingerprint" text NOT NULL,
	"generation" integer NOT NULL,
	"worker_id" uuid NOT NULL,
	"fence" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "operations_execution_intent_binding" CHECK ("itervane"."operations_execution_intents"."decision_version" = 1 AND "itervane"."operations_execution_intents"."generation" = 1
    AND "itervane"."operations_execution_intents"."fence" > 0 AND "itervane"."operations_execution_intents"."proposal_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "itervane"."operations_execution_intents" ADD CONSTRAINT "operations_execution_intent_schedule_fk" FOREIGN KEY ("execution_id") REFERENCES "itervane"."operations_execution_schedules"("execution_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DROP TRIGGER operations_execution_schedule_authority ON itervane.operations_execution_schedules;
--> statement-breakpoint
CREATE TRIGGER operations_execution_schedule_authority BEFORE INSERT OR DELETE ON itervane.operations_execution_schedules
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_execution_schedule();
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_execution_wakeup() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
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
              OR (task.state = 'reconciling' AND runtime.reason = 'operations_execution_reconciling' AND intent.execution_id IS NOT NULL)))
            OR (NEW.wakeup_job_id IS NULL AND task.state = 'running'
              AND runtime.reason IN ('operations_execution_claimed', 'operations_execution_reconciling')
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
--> statement-breakpoint
CREATE TRIGGER operations_execution_wakeup_authority BEFORE UPDATE ON itervane.operations_execution_schedules
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_execution_wakeup();
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_execution_intent() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_execution_intent_is_immutable';
  END IF;
  PERFORM 1 FROM itervane.execution_slot WHERE id = 1 FOR UPDATE;
  PERFORM 1 FROM itervane.operations_executions execution
    JOIN itervane.operations_proposals proposal ON proposal.id = execution.proposal_id
    JOIN itervane.operations_requests request ON request.run_id = proposal.diagnosis_run_id
    JOIN itervane.tasks diagnosis ON diagnosis.id = request.task_id
    WHERE execution.id = NEW.execution_id FOR UPDATE OF diagnosis;
  PERFORM 1 FROM itervane.operations_executions execution
    JOIN itervane.environments environment ON environment.id = execution.environment_id
    WHERE execution.id = NEW.execution_id FOR UPDATE OF environment;
  PERFORM 1 FROM itervane.operations_executions WHERE id = NEW.execution_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.operations_execution_schedules schedule
      JOIN itervane.operations_executions execution ON execution.id = schedule.execution_id
      JOIN itervane.operations_proposals proposal ON proposal.id = execution.proposal_id
      JOIN itervane.operations_requests request ON request.run_id = proposal.diagnosis_run_id
      JOIN itervane.tasks diagnosis ON diagnosis.id = request.task_id AND diagnosis.state = 'succeeded'
      JOIN itervane.environments environment ON environment.id = execution.environment_id AND environment.access = 'protected'
      JOIN itervane.projects project ON project.id = request.project_id AND project.id = environment.project_id
      JOIN itervane.operations_decisions approval ON approval.proposal_id = proposal.id
        AND approval.version = execution.decision_version AND approval.action = 'confirm'
      JOIN itervane.workspace_members approver ON approver.workspace_id = project.workspace_id
        AND approver.principal_id = approval.actor_id AND approver.grant_id = approval.grant_id
      LEFT JOIN itervane.workspace_members proposer_owner ON proposer_owner.workspace_id = project.workspace_id
        AND proposer_owner.principal_id = proposal.proposed_by
      LEFT JOIN itervane.project_members proposer_member ON proposer_member.project_id = project.id
        AND proposer_member.principal_id = proposal.proposed_by AND proposer_member.role = 'maintainer'
      LEFT JOIN itervane.workspace_members requester_owner ON requester_owner.workspace_id = project.workspace_id
        AND requester_owner.principal_id = diagnosis.requested_by
      LEFT JOIN itervane.project_members requester_member ON requester_member.project_id = project.id
        AND requester_member.principal_id = diagnosis.requested_by AND requester_member.role = 'maintainer'
      JOIN itervane.formal_release_targets mapping ON mapping.environment_id = environment.id
      JOIN itervane.operations_targets binding ON binding.environment_id = environment.id
      JOIN itervane.tasks task ON task.id = schedule.task_id AND task.requested_by = approval.actor_id
      JOIN itervane.task_runs run ON run.id = schedule.run_id AND run.task_id = task.id AND run.generation = task.generation
      JOIN itervane.run_runtime runtime ON runtime.run_id = run.id AND runtime.task_id = task.id
      JOIN itervane.execution_slot slot ON slot.id = 1 AND slot.task_id = task.id AND slot.run_id = run.id
    WHERE schedule.execution_id = NEW.execution_id AND schedule.wakeup_job_id IS NULL AND execution.state = 'reserved'
      AND NEW.decision_version = execution.decision_version AND NEW.proposal_fingerprint = execution.proposal_fingerprint
      AND task.generation = NEW.generation AND task.state = 'running' AND run.state = 'running' AND run.role = 'operations'
      AND runtime.reason = 'operations_execution_claimed' AND slot.worker_id = NEW.worker_id
      AND slot.fence = NEW.fence AND slot.lease_until > clock_timestamp() AND proposal.valid_until > clock_timestamp()
      AND COALESCE(proposer_owner.grant_id, proposer_member.grant_id) = proposal.grant_id
      AND COALESCE(requester_owner.grant_id, requester_member.grant_id)::text = request.document->>'grantId'
      AND mapping.revision::text = request.document->>'targetRevision' AND mapping.sha256 = request.document->>'mappingSha256'
      AND binding.revision::text = request.document->>'enrollmentRevision' AND binding.sha256 = request.document->>'enrollmentSha256'
      AND request.release_operation_id = (
        SELECT id FROM itervane.release_operations WHERE environment_id = environment.id AND state = 'verified_formal'
        ORDER BY updated_at DESC, id DESC LIMIT 1
      )
      AND NOT EXISTS (SELECT 1 FROM itervane.operations_decisions revoke
        WHERE revoke.proposal_id = proposal.id AND revoke.version > approval.version)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_execution_intent_authority_required';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_execution_intent_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.operations_execution_intents
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_execution_intent();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION itervane.release_operations_reservation_on_revocation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM itervane.operations_proposals proposal
    JOIN itervane.environments environment ON environment.id = proposal.environment_id
    WHERE proposal.id = NEW.proposal_id FOR UPDATE OF environment;
  UPDATE itervane.operations_executions execution SET state = 'blocked', blocked_reason = 'approval_revoked', closed_at = NEW.decided_at
    WHERE execution.proposal_id = NEW.proposal_id AND execution.state = 'reserved'
      AND NOT EXISTS (SELECT 1 FROM itervane.operations_execution_intents intent WHERE intent.execution_id = execution.id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION itervane.require_unprepared_operations_closure() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM itervane.operations_execution_intents intent WHERE intent.execution_id = NEW.id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_execution_intent_requires_reconciliation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_execution_intent_hold BEFORE UPDATE ON itervane.operations_executions
FOR EACH ROW WHEN (NEW.state = 'blocked') EXECUTE FUNCTION itervane.require_unprepared_operations_closure();
