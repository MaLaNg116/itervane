ALTER TABLE "itervane"."operations_executions" DROP CONSTRAINT "operations_execution_lifecycle";--> statement-breakpoint
ALTER TABLE "itervane"."operations_executions" ADD CONSTRAINT "operations_execution_lifecycle" CHECK ((("itervane"."operations_executions"."state" = 'reserved' AND "itervane"."operations_executions"."closed_at" IS NULL AND "itervane"."operations_executions"."blocked_reason" IS NULL)
    OR ("itervane"."operations_executions"."state" = 'blocked' AND "itervane"."operations_executions"."closed_at" >= "itervane"."operations_executions"."created_at" AND "itervane"."operations_executions"."blocked_reason" IN ('approval_revoked', 'proposal_expired', 'restart_not_sent'))) IS TRUE);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION itervane.guard_operations_execution_admission() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_execution_is_retained';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.state <> 'reserved' OR NEW.state <> 'blocked'
      OR ROW(NEW.id, NEW.proposal_id, NEW.proposal_fingerprint, NEW.environment_id, NEW.decision_version, NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id, OLD.proposal_id, OLD.proposal_fingerprint, OLD.environment_id, OLD.decision_version, OLD.created_at)
      OR NEW.closed_at IS NULL OR (
        (NEW.blocked_reason IS DISTINCT FROM 'restart_not_sent' AND NEW.closed_at > clock_timestamp())
        OR (NEW.blocked_reason = 'restart_not_sent' AND NEW.closed_at > GREATEST(OLD.created_at, clock_timestamp()))
      )
      OR NOT (
        (NEW.blocked_reason = 'approval_revoked' AND EXISTS (
          SELECT 1 FROM itervane.operations_decisions decision
            WHERE decision.proposal_id = OLD.proposal_id AND decision.version = 2 AND decision.action = 'revoke'
              AND decision.decided_at = NEW.closed_at
        )) IS TRUE
        OR (NEW.blocked_reason = 'proposal_expired' AND EXISTS (
          SELECT 1 FROM itervane.operations_proposals proposal
            WHERE proposal.id = OLD.proposal_id AND proposal.valid_until <= NEW.closed_at
        )) IS TRUE
        OR (NEW.blocked_reason = 'restart_not_sent' AND EXISTS (
          SELECT 1 FROM itervane.operations_execution_schedules schedule
          JOIN itervane.operations_proposals proposal ON proposal.id = OLD.proposal_id
          JOIN itervane.tasks task ON task.id = schedule.task_id AND task.state = 'running'
          JOIN itervane.task_runs run ON run.id = schedule.run_id AND run.task_id = task.id
            AND run.generation = task.generation AND run.state = 'running' AND run.role = 'operations'
          JOIN itervane.run_runtime runtime ON runtime.run_id = run.id AND runtime.task_id = task.id
          JOIN itervane.execution_slot slot ON slot.id = 1 AND slot.task_id = task.id AND slot.run_id = run.id
          WHERE schedule.execution_id = OLD.id AND schedule.wakeup_job_id IS NULL
            AND runtime.reason = 'operations_execution_claimed' AND slot.lease_until > clock_timestamp()
            AND proposal.document#>>'{action,kind}' = 'restart'
        )) IS TRUE
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_execution_invalid_closure';
    END IF;
    RETURN NEW;
  END IF;

  -- The same task serializes confirmation, reservation and revocation.
  PERFORM task_row.id FROM itervane.operations_proposals proposal
    JOIN itervane.operations_requests request ON request.run_id = proposal.diagnosis_run_id
    JOIN itervane.tasks task_row ON task_row.id = request.task_id
    WHERE proposal.id = NEW.proposal_id FOR UPDATE OF task_row;
  PERFORM 1 FROM itervane.environments WHERE id = NEW.environment_id FOR UPDATE;
  IF NEW.state <> 'reserved' OR NOT EXISTS (
    SELECT 1 FROM itervane.operations_proposals proposal
      JOIN itervane.operations_requests request ON request.run_id = proposal.diagnosis_run_id
      JOIN itervane.task_runs run_row ON run_row.id = request.run_id AND run_row.task_id = request.task_id
      JOIN itervane.tasks task_row ON task_row.id = request.task_id AND task_row.generation = run_row.generation
      JOIN itervane.projects project ON project.id = request.project_id
      JOIN itervane.operations_decisions decision ON decision.proposal_id = proposal.id
        AND decision.version = NEW.decision_version AND decision.action = 'confirm'
      JOIN itervane.workspace_members approver ON approver.workspace_id = project.workspace_id
        AND approver.principal_id = decision.actor_id AND approver.grant_id = decision.grant_id
      JOIN itervane.formal_release_targets mapping ON mapping.environment_id = proposal.environment_id
      JOIN itervane.operations_targets binding ON binding.environment_id = proposal.environment_id
      LEFT JOIN itervane.workspace_members proposing_owner ON proposing_owner.workspace_id = project.workspace_id
        AND proposing_owner.principal_id = proposal.proposed_by
      LEFT JOIN itervane.project_members proposing_member ON proposing_member.project_id = project.id
        AND proposing_member.principal_id = proposal.proposed_by AND proposing_member.role = 'maintainer'
      LEFT JOIN itervane.workspace_members origin_owner ON origin_owner.workspace_id = project.workspace_id
        AND origin_owner.principal_id = task_row.requested_by
      LEFT JOIN itervane.project_members origin_member ON origin_member.project_id = project.id
        AND origin_member.principal_id = task_row.requested_by AND origin_member.role = 'maintainer'
    WHERE proposal.id = NEW.proposal_id AND proposal.environment_id = NEW.environment_id
      AND proposal.fingerprint = NEW.proposal_fingerprint
      AND NEW.created_at BETWEEN decision.decided_at AND clock_timestamp()
      AND proposal.valid_until > NEW.created_at AND proposal.valid_until > clock_timestamp()
      AND task_row.state = 'succeeded' AND run_row.state = 'succeeded' AND run_row.role = 'operations'
      AND COALESCE(proposing_owner.grant_id, proposing_member.grant_id) = proposal.grant_id
      AND COALESCE(origin_owner.grant_id, origin_member.grant_id)::text = request.document->>'grantId'
      AND mapping.revision::text = request.document->>'targetRevision' AND mapping.sha256 = request.document->>'mappingSha256'
      AND binding.revision::text = request.document->>'enrollmentRevision' AND binding.sha256 = request.document->>'enrollmentSha256'
      AND NOT EXISTS (
        SELECT 1 FROM itervane.operations_decisions revoke
          WHERE revoke.proposal_id = proposal.id AND revoke.version > decision.version
      )
      AND request.release_operation_id = (
        SELECT id FROM itervane.release_operations
          WHERE environment_id = proposal.environment_id AND state = 'verified_formal' ORDER BY updated_at DESC, id DESC LIMIT 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM itervane.release_operations
          WHERE environment_id = proposal.environment_id AND state IN ('queued', 'dispatching', 'reconciling')
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_execution_authority_required';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION itervane.require_closed_operations_execution_schedule() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM itervane.operations_execution_schedules schedule
      JOIN itervane.tasks task ON task.id = schedule.task_id
      JOIN itervane.task_runs run ON run.id = schedule.run_id
    WHERE schedule.execution_id = NEW.id AND (
      schedule.wakeup_job_id IS NOT NULL OR task.state <> run.state
      OR (NEW.blocked_reason = 'approval_revoked' AND task.state <> 'cancelled')
      OR (NEW.blocked_reason IN ('proposal_expired', 'restart_not_sent') AND task.state <> 'needs_human')
      OR (NEW.blocked_reason = 'restart_not_sent' AND EXISTS (
        SELECT 1 FROM itervane.execution_slot slot WHERE slot.task_id = task.id
      ))
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_execution_schedule_must_close';
  END IF;
  RETURN NEW;
END;
$$;
