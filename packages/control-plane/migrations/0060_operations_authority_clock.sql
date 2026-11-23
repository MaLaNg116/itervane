-- Approval, reservation and revocation retain the order of their persisted prerequisites.
CREATE OR REPLACE FUNCTION itervane.guard_operations_proposal() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_proposal_is_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.operations_diagnosis_results diagnosis
      JOIN itervane.operations_requests request ON request.run_id = diagnosis.run_id
      JOIN itervane.operations_observations observed ON observed.run_id = request.run_id
      JOIN itervane.task_runs run_row ON run_row.id = request.run_id AND run_row.task_id = request.task_id
      JOIN itervane.tasks task_row ON task_row.id = request.task_id AND task_row.generation = run_row.generation
      JOIN itervane.projects project ON project.id = request.project_id
      JOIN itervane.operations_targets binding ON binding.environment_id = request.environment_id
      JOIN itervane.formal_release_targets mapping ON mapping.environment_id = request.environment_id
      LEFT JOIN itervane.workspace_members owner_grant ON owner_grant.workspace_id = project.workspace_id
        AND owner_grant.principal_id = NEW.proposed_by
      LEFT JOIN itervane.project_members project_grant ON project_grant.project_id = project.id
        AND project_grant.principal_id = NEW.proposed_by AND project_grant.role = 'maintainer'
      LEFT JOIN itervane.workspace_members origin_owner ON origin_owner.workspace_id = project.workspace_id
        AND origin_owner.principal_id = task_row.requested_by
      LEFT JOIN itervane.project_members origin_member ON origin_member.project_id = project.id
        AND origin_member.principal_id = task_row.requested_by AND origin_member.role = 'maintainer'
    WHERE diagnosis.run_id = NEW.diagnosis_run_id AND diagnosis.sha256 = NEW.document#>>'{diagnosis,sha256}'
      AND request.task_id::text = NEW.document#>>'{diagnosis,taskId}'
      AND observed.document#>>'{observation,observedAt}' = NEW.document#>>'{diagnosis,observedAt}'
      AND request.environment_id = NEW.environment_id AND request.document = NEW.document->'target'
      AND run_row.role = 'operations' AND run_row.state = 'succeeded' AND task_row.state = 'succeeded'
      AND COALESCE(owner_grant.grant_id, project_grant.grant_id) = NEW.grant_id
      AND COALESCE(origin_owner.grant_id, origin_member.grant_id)::text = request.document->>'grantId'
      AND mapping.revision::text = request.document->>'targetRevision' AND mapping.sha256 = request.document->>'mappingSha256'
      AND binding.revision::text = request.document->>'enrollmentRevision' AND binding.sha256 = request.document->>'enrollmentSha256'
      AND NEW.created_at BETWEEN date_trunc('milliseconds', diagnosis.created_at)
        AND GREATEST(date_trunc('milliseconds', diagnosis.created_at), clock_timestamp())
      AND NEW.valid_until = (NEW.document->>'validUntil')::timestamptz AND NEW.valid_until > clock_timestamp()
      AND NEW.valid_until <= diagnosis.created_at + (mapping.document->>'approvalTtlSeconds')::integer * interval '1 second'
      AND request.release_operation_id = (
        SELECT id FROM itervane.release_operations
        WHERE environment_id = NEW.environment_id AND state = 'verified_formal' ORDER BY updated_at DESC, id DESC LIMIT 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM itervane.release_operations
        WHERE environment_id = NEW.environment_id AND state IN ('queued', 'dispatching', 'reconciling')
      )
      AND (
        (NEW.document#>>'{action,kind}' = 'restart' AND diagnosis.document#>>'{result,recommendation,code}' = 'review_restart'
          AND observed.document#>>'{observation,state}' IN ('exited', 'dead'))
        OR
        (NEW.document#>>'{action,kind}' = 'rollback' AND diagnosis.document#>>'{result,recommendation,code}' = 'review_rollback'
          AND observed.document#>>'{observation,state}' IN ('exited', 'dead')
          AND diagnosis.document#>>'{result,previousReleaseOperationId}' = NEW.document#>>'{action,restore,operationId}'
          AND EXISTS (
            SELECT 1 FROM itervane.release_operations previous
              JOIN itervane.release_candidates candidate ON candidate.id = previous.candidate_id
            WHERE previous.environment_id = NEW.environment_id AND previous.state = 'verified_formal'
              AND previous.id::text = NEW.document#>>'{action,restore,operationId}'
              AND candidate.document#>>'{target,mappingSha256}' = mapping.sha256
              AND candidate.document#>>'{image,manifestDigest}' = NEW.document#>>'{action,restore,manifestDigest}'
              AND candidate.document#>>'{image,configDigest}' = NEW.document#>>'{action,restore,configDigest}'
              AND candidate.document#>>'{image,manifestDigest}' <> request.document->>'manifestDigest'
          )
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_proposal_authority_or_evidence';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION itervane.guard_operations_decision() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  prerequisite timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_decision_is_immutable';
  END IF;
  SELECT GREATEST(proposal.created_at, (
    SELECT MAX(previous.decided_at) FROM itervane.operations_decisions previous
    WHERE previous.proposal_id = NEW.proposal_id AND previous.version < NEW.version
  ), (
    SELECT execution.created_at FROM itervane.operations_executions execution WHERE execution.proposal_id = NEW.proposal_id
  )) INTO prerequisite
  FROM itervane.operations_proposals proposal WHERE proposal.id = NEW.proposal_id;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.operations_proposals proposal
      JOIN itervane.operations_requests request ON request.run_id = proposal.diagnosis_run_id
      JOIN itervane.projects project ON project.id = request.project_id
      JOIN itervane.workspace_members owner_grant ON owner_grant.workspace_id = project.workspace_id
        AND owner_grant.principal_id = NEW.actor_id AND owner_grant.grant_id = NEW.grant_id
    WHERE proposal.id = NEW.proposal_id AND NEW.decided_at BETWEEN prerequisite AND GREATEST(prerequisite, clock_timestamp())
      AND NEW.self_confirmed = (NEW.action = 'confirm' AND NEW.actor_id = proposal.proposed_by)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_decision_owner_required';
  END IF;
  IF NEW.action = 'revoke' THEN
    IF EXISTS (SELECT 1 FROM itervane.operations_decisions WHERE proposal_id = NEW.proposal_id AND version = 1 AND action = 'confirm') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_decision_confirmation_required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.operations_proposals proposal
      JOIN itervane.operations_requests request ON request.run_id = proposal.diagnosis_run_id
      JOIN itervane.task_runs run_row ON run_row.id = request.run_id AND run_row.task_id = request.task_id
      JOIN itervane.tasks task_row ON task_row.id = request.task_id AND task_row.generation = run_row.generation
      JOIN itervane.projects project ON project.id = request.project_id
      JOIN itervane.operations_targets binding ON binding.environment_id = request.environment_id
      JOIN itervane.formal_release_targets mapping ON mapping.environment_id = request.environment_id
      LEFT JOIN itervane.workspace_members proposing_owner ON proposing_owner.workspace_id = project.workspace_id
        AND proposing_owner.principal_id = proposal.proposed_by
      LEFT JOIN itervane.project_members proposing_member ON proposing_member.project_id = project.id
        AND proposing_member.principal_id = proposal.proposed_by AND proposing_member.role = 'maintainer'
      LEFT JOIN itervane.workspace_members origin_owner ON origin_owner.workspace_id = project.workspace_id
        AND origin_owner.principal_id = task_row.requested_by
      LEFT JOIN itervane.project_members origin_member ON origin_member.project_id = project.id
        AND origin_member.principal_id = task_row.requested_by AND origin_member.role = 'maintainer'
    WHERE proposal.id = NEW.proposal_id AND proposal.valid_until > clock_timestamp() AND proposal.valid_until > NEW.decided_at
      AND task_row.state = 'succeeded' AND run_row.state = 'succeeded' AND run_row.role = 'operations'
      AND COALESCE(proposing_owner.grant_id, proposing_member.grant_id) = proposal.grant_id
      AND COALESCE(origin_owner.grant_id, origin_member.grant_id)::text = request.document->>'grantId'
      AND mapping.revision::text = request.document->>'targetRevision' AND mapping.sha256 = request.document->>'mappingSha256'
      AND binding.revision::text = request.document->>'enrollmentRevision' AND binding.sha256 = request.document->>'enrollmentSha256'
      AND request.release_operation_id = (
        SELECT id FROM itervane.release_operations
        WHERE environment_id = proposal.environment_id AND state = 'verified_formal' ORDER BY updated_at DESC, id DESC LIMIT 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM itervane.release_operations
        WHERE environment_id = proposal.environment_id AND state IN ('queued', 'dispatching', 'reconciling')
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_decision_proposal_inoperative';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION itervane.guard_operations_execution_admission() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_execution_is_retained';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.state = 'recovered' THEN
    IF OLD.state <> 'reserved' OR NEW.blocked_reason IS NOT NULL
      OR ROW(NEW.id, NEW.proposal_id, NEW.proposal_fingerprint, NEW.environment_id, NEW.decision_version, NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id, OLD.proposal_id, OLD.proposal_fingerprint, OLD.environment_id, OLD.decision_version, OLD.created_at)
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_recovery_invalid_closure';
    END IF;
    SELECT receipt.completed_at INTO NEW.closed_at
    FROM itervane.operations_restart_recoveries receipt
      JOIN itervane.operations_execution_schedules schedule ON schedule.execution_id = receipt.execution_id AND schedule.wakeup_job_id IS NULL
      JOIN itervane.execution_slot slot ON slot.id = 1 AND slot.task_id = schedule.task_id AND slot.run_id = schedule.run_id
        AND slot.worker_id = receipt.worker_id AND slot.fence = receipt.fence AND slot.lease_until > clock_timestamp()
    WHERE receipt.execution_id = OLD.id AND receipt.state = 'verified';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_recovery_verified_receipt_required';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.state <> 'reserved' OR NEW.state <> 'blocked'
      OR ROW(NEW.id, NEW.proposal_id, NEW.proposal_fingerprint, NEW.environment_id, NEW.decision_version, NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id, OLD.proposal_id, OLD.proposal_fingerprint, OLD.environment_id, OLD.decision_version, OLD.created_at)
      OR NEW.closed_at IS NULL OR (
        (NEW.blocked_reason = 'proposal_expired' AND NEW.closed_at > clock_timestamp())
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
      AND NEW.created_at BETWEEN decision.decided_at AND GREATEST(decision.decided_at, clock_timestamp())
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
