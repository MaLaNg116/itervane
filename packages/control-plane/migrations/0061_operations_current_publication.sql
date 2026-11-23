-- Both deploy writers consume a global slot fence. Pick the latest settled send before validating the target revision.
CREATE FUNCTION itervane.current_operations_publication(environment_key uuid)
RETURNS TABLE (release_operation_id uuid, restore_execution_id uuid, fence integer, manifest_digest text, runtime jsonb)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT publication.release_operation_id, publication.restore_execution_id,
    publication.fence, publication.manifest_digest, publication.runtime
  FROM (
    SELECT release.id AS release_operation_id, NULL::uuid AS restore_execution_id, dispatch.prepared_fence AS fence,
      rollout.proof->>'manifestDigest' AS manifest_digest, rollout.proof->'runtime' AS runtime
    FROM itervane.release_operations release
      LEFT JOIN itervane.formal_release_steps dispatch ON dispatch.operation_id = release.id
        AND dispatch.kind = 'komodo_dispatch' AND dispatch.state = 'confirmed'
      LEFT JOIN itervane.formal_release_rollout_attempts rollout ON rollout.operation_id = release.id AND rollout.state = 'verified'
    WHERE release.environment_id = environment_key AND release.state = 'verified_formal'
    UNION ALL
    SELECT archived.id, execution.id, sent.fence, intent.restore_plan#>>'{restore,manifestDigest}', receipt.proof->'runtime'
    FROM itervane.operations_executions execution
      JOIN itervane.operations_execution_intents intent ON intent.execution_id = execution.id AND intent.restore_plan IS NOT NULL
      LEFT JOIN itervane.operations_restore_recoveries receipt ON receipt.execution_id = execution.id
        AND receipt.state = 'verified' AND receipt.completed_at = execution.closed_at
      LEFT JOIN itervane.operations_restore_steps sent ON sent.execution_id = execution.id AND sent.kind = 'deploy'
        AND sent.plan_sha256 = intent.restore_plan_sha256 AND sent.fence < receipt.fence
        AND sent.receipt->>'updateId' = receipt.proof#>>'{update,updateId}'
      LEFT JOIN itervane.release_operations archived ON archived.environment_id = execution.environment_id
        AND archived.state = 'verified_formal' AND archived.id::text = receipt.proof->>'restoreOperationId'
    WHERE execution.environment_id = environment_key AND execution.state = 'recovered'
  ) publication
  ORDER BY publication.fence DESC NULLS FIRST, publication.release_operation_id, publication.restore_execution_id
  LIMIT 1
$$;
--> statement-breakpoint
CREATE FUNCTION itervane.bound_operations_runtime(environment_key uuid, binding jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT publication.runtime
  FROM itervane.current_operations_publication(environment_key) publication
  WHERE publication.fence IS NOT NULL
    AND publication.release_operation_id::text = binding->>'releaseOperationId'
    AND to_jsonb(publication.restore_execution_id) IS NOT DISTINCT FROM binding->'restoreExecutionId'
    AND publication.manifest_digest = binding->>'manifestDigest'
    AND publication.runtime->>'containerId' = binding->>'containerId'
    AND publication.runtime->>'configDigest' = binding->>'configDigest'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION itervane.guard_operations_request() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_request_is_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.task_runs run_row
      JOIN itervane.tasks task_row ON task_row.id = run_row.task_id
      JOIN itervane.release_operations release_row ON release_row.id = NEW.release_operation_id
      JOIN itervane.release_candidates candidate ON candidate.id = release_row.candidate_id
      JOIN itervane.operations_targets binding ON binding.environment_id = NEW.environment_id
    WHERE run_row.id = NEW.run_id AND task_row.id = NEW.task_id AND task_row.project_id = NEW.project_id
      AND run_row.role = 'operations' AND run_row.state = 'queued' AND task_row.state = 'queued'
      AND task_row.generation = run_row.generation AND release_row.state = 'verified_formal'
      AND release_row.environment_id = NEW.environment_id AND candidate.project_id = NEW.project_id
      AND candidate.application_id = NEW.application_id AND candidate.task_id::text = NEW.document->>'releaseTaskId'
      AND task_row.repository_id::text = NEW.document#>>'{source,repositoryId}'
      AND task_row.commit = NEW.document#>>'{source,commit}' AND task_row.data_class = NEW.document->>'dataClass'
      AND binding.revision::text = NEW.document->>'enrollmentRevision' AND binding.sha256 = NEW.document->>'enrollmentSha256'
      AND itervane.bound_operations_runtime(NEW.environment_id, NEW.document) IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_request_scope_required';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
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
      AND itervane.bound_operations_runtime(NEW.environment_id, request.document) IS NOT NULL
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
      AND itervane.bound_operations_runtime(proposal.environment_id, request.document) IS NOT NULL
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
    FROM (
      SELECT restart.execution_id, restart.completed_at, restart.worker_id, restart.fence
      FROM itervane.operations_restart_recoveries restart
      WHERE restart.execution_id = OLD.id AND restart.state = 'verified'
      UNION ALL
      SELECT restoration.execution_id, restoration.completed_at, restoration.worker_id, restoration.fence
      FROM itervane.operations_restore_recoveries restoration
        JOIN itervane.operations_proposals proposal ON proposal.id = OLD.proposal_id
      WHERE restoration.execution_id = OLD.id AND restoration.state = 'verified'
        AND itervane.bound_operations_runtime(OLD.environment_id, proposal.document->'target') IS NOT NULL
    ) receipt
      JOIN itervane.operations_execution_schedules schedule ON schedule.execution_id = receipt.execution_id AND schedule.wakeup_job_id IS NULL
      JOIN itervane.execution_slot slot ON slot.id = 1 AND slot.task_id = schedule.task_id AND slot.run_id = schedule.run_id
        AND slot.worker_id = receipt.worker_id AND slot.fence = receipt.fence AND slot.lease_until > clock_timestamp();
    IF NOT FOUND THEN
      IF EXISTS (SELECT 1 FROM itervane.operations_execution_intents intent WHERE intent.execution_id = OLD.id AND intent.restore_plan IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restore_recovery_verified_receipt_required';
      END IF;
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
      AND itervane.bound_operations_runtime(proposal.environment_id, request.document) IS NOT NULL
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
CREATE OR REPLACE FUNCTION itervane.guard_operations_execution_intent() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
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
      AND itervane.bound_operations_runtime(environment.id, request.document) IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM itervane.operations_decisions revoke
        WHERE revoke.proposal_id = proposal.id AND revoke.version > approval.version)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_execution_intent_authority_required';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION itervane.guard_operations_restart_runtime_baseline() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  stopped_start text := NEW.runtime_baseline->>'startedAt';
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.runtime_baseline, NEW.runtime_baseline_sha256) IS DISTINCT FROM ROW(OLD.runtime_baseline, OLD.runtime_baseline_sha256) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_baseline_is_immutable';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT (stopped_start ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{9}Z$'
      AND stopped_start > '1970-01-01T00:00:00.000999999Z'
      AND pg_input_is_valid(stopped_start, 'timestamp with time zone')) IS TRUE
    OR NOT (NEW.runtime_baseline->>'state' IN ('exited', 'dead')) IS TRUE
    OR NOT EXISTS (
      SELECT 1 FROM itervane.operations_executions execution
      JOIN itervane.operations_proposals proposal ON proposal.id = execution.proposal_id
      JOIN LATERAL itervane.bound_operations_runtime(execution.environment_id, proposal.document->'target') publication(runtime)
        ON publication.runtime IS NOT NULL
      WHERE execution.id = NEW.execution_id
        AND NEW.runtime_baseline = jsonb_build_object(
          'containerId', proposal.document#>>'{target,containerId}', 'configDigest', proposal.document#>>'{target,configDigest}',
          'imageReference', publication.runtime->>'imageReference', 'runtimeConfigSha256', publication.runtime->>'runtimeConfigSha256',
          'network', publication.runtime->>'network', 'state', NEW.runtime_baseline->>'state', 'startedAt', stopped_start
        )
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_baseline_runtime_required';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION itervane.guard_operations_restart_recovery() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  intent_time timestamp with time zone;
  live boolean;
  last_attempt record;
  started text;
  runtime jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_recovery_is_retained';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD.state <> 'observing' OR NEW.state = 'observing' OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
    OR ROW(NEW.execution_id, NEW.attempt, NEW.fence, NEW.worker_id, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.execution_id, OLD.attempt, OLD.fence, OLD.worker_id, OLD.created_at)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_recovery_is_immutable';
  END IF;
  PERFORM 1 FROM itervane.execution_slot WHERE id = 1 FOR UPDATE;
  SELECT intent.created_at, slot.lease_until > clock_timestamp() INTO intent_time, live
  FROM itervane.operations_execution_intents intent
    JOIN itervane.operations_executions execution ON execution.id = intent.execution_id AND execution.state = 'reserved'
    JOIN itervane.operations_proposals proposal ON proposal.id = execution.proposal_id AND proposal.document#>>'{action,kind}' = 'restart'
    JOIN itervane.operations_execution_schedules schedule ON schedule.execution_id = execution.id AND schedule.wakeup_job_id IS NULL
    JOIN itervane.tasks task ON task.id = schedule.task_id AND task.state = 'running' AND task.generation = intent.generation
    JOIN itervane.task_runs run ON run.id = schedule.run_id AND run.task_id = task.id AND run.generation = task.generation
      AND run.state = task.state AND run.role = 'operations'
    JOIN itervane.run_runtime phase ON phase.run_id = run.id AND phase.reason = 'operations_execution_reconciling'
    JOIN itervane.execution_slot slot ON slot.id = 1 AND slot.task_id = task.id AND slot.run_id = run.id
      AND slot.fence = NEW.fence AND slot.worker_id = NEW.worker_id
  WHERE intent.execution_id = NEW.execution_id AND intent.fence < NEW.fence;
  IF NOT FOUND OR live IS DISTINCT FROM (NEW.failure IS DISTINCT FROM 'lease_expired') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_recovery_lease_required';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT attempt, fence, state, completed_at INTO last_attempt FROM itervane.operations_restart_recoveries
      WHERE execution_id = NEW.execution_id ORDER BY attempt DESC LIMIT 1;
    IF NEW.state <> 'observing' OR (NOT FOUND AND NEW.attempt <> 1)
      OR (FOUND AND (last_attempt.state <> 'retry' OR NEW.attempt <> last_attempt.attempt + 1 OR NEW.fence <= last_attempt.fence)) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_recovery_attempt_order';
    END IF;
    NEW.created_at := GREATEST(intent_time, last_attempt.completed_at, clock_timestamp());
    RETURN NEW;
  END IF;

  IF NEW.proof IS NOT NULL THEN
    started := NEW.proof#>>'{observation,startedAt}';
    runtime := NEW.proof#>'{observation,runtime}';
    IF NOT (started ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{9}Z$'
          AND pg_input_is_valid(started, 'timestamp with time zone') AND runtime->'anonymousStatus' IN ('401'::jsonb, '403'::jsonb)) IS TRUE
      OR NOT EXISTS (
        SELECT 1 FROM itervane.operations_executions execution
        JOIN itervane.operations_proposals proposal ON proposal.id = execution.proposal_id
        JOIN itervane.operations_restart_requests request ON request.execution_id = execution.id AND request.runtime_baseline IS NOT NULL
        JOIN itervane.operations_targets enrollment ON enrollment.environment_id = execution.environment_id
          AND enrollment.sha256 = proposal.document#>>'{target,enrollmentSha256}'
          AND enrollment.revision::text = proposal.document#>>'{target,enrollmentRevision}'
        JOIN itervane.formal_release_targets mapping ON mapping.environment_id = execution.environment_id
          AND mapping.sha256 = proposal.document#>>'{target,mappingSha256}' AND mapping.revision::text = proposal.document#>>'{target,targetRevision}'
        JOIN LATERAL itervane.bound_operations_runtime(execution.environment_id, proposal.document->'target') publication(published_runtime)
          ON publication.published_runtime IS NOT NULL
        LEFT JOIN LATERAL (
          SELECT resume.* FROM itervane.operations_restart_resumes resume WHERE resume.execution_id = execution.id
            ORDER BY resume.attempt DESC LIMIT 1
        ) native ON true
        WHERE execution.id = NEW.execution_id AND started > request.runtime_baseline->>'startedAt'
          AND runtime = publication.published_runtime || jsonb_build_object('anonymousStatus', runtime->'anonymousStatus')
          AND NEW.proof = jsonb_build_object(
            'version', 1, 'executionId', execution.id, 'releaseOperationId', proposal.document#>>'{target,releaseOperationId}', 'fence', NEW.fence,
            'proposalFingerprint', execution.proposal_fingerprint, 'callSha256', request.call_sha256,
            'runtimeBaselineSha256', request.runtime_baseline_sha256,
            'native', CASE WHEN NEW.state = 'verified' THEN jsonb_build_object('approvalId', request.approval_id, 'attempt', native.attempt) END,
            'observation', jsonb_build_object('runtime', runtime, 'startedAt', started)
          )
          AND (NEW.state <> 'verified' OR (native.state = 'acknowledged' AND native.fence < NEW.fence
            AND native.approval_id = request.approval_id AND native.call_sha256 = request.call_sha256))
          AND NOT EXISTS (SELECT 1 FROM itervane.release_operations concurrent_release WHERE concurrent_release.environment_id = execution.environment_id
            AND concurrent_release.state IN ('queued', 'dispatching', 'reconciling'))
      ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_recovery_evidence_required';
    END IF;
  END IF;
  NEW.completed_at := GREATEST(OLD.created_at, clock_timestamp());
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION itervane.require_restore_recovery_transition() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
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
    WHERE execution.id = NEW.execution_id
      AND NOT EXISTS (SELECT 1 FROM itervane.execution_slot slot WHERE slot.task_id = task.id)
      AND (
        (NEW.state = 'verified' AND execution.state = 'recovered' AND execution.closed_at = NEW.completed_at AND task.state = 'succeeded'
          AND phase.reason = 'operations_restore_recovery_verified' AND schedule.wakeup_job_id IS NULL)
        OR (NEW.state = 'retry' AND execution.state = 'reserved' AND task.state = 'reconciling' AND phase.reason = 'operations_execution_reconciling' AND schedule.wakeup_job_id IS NOT NULL)
        OR (NEW.state = 'manual_review' AND execution.state = 'reserved' AND task.state = 'needs_human' AND phase.reason = 'operations_restore_recovery_manual' AND schedule.wakeup_job_id IS NULL)
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restore_recovery_must_record_outcome';
  END IF;
  RETURN NEW;
END;
$$;
