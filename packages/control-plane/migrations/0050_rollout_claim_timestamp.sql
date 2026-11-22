CREATE OR REPLACE FUNCTION itervane.guard_formal_release_rollout_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  checked_at timestamptz;
  current_at timestamptz;
  previous_fence integer;
  previous_state text;
  bound record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_rollout_attempt_is_immutable';
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.state <> 'observing' OR (OLD.operation_id, OLD.fence, OLD.worker_id, OLD.created_at, OLD.lease_until)
        IS DISTINCT FROM (NEW.operation_id, NEW.fence, NEW.worker_id, NEW.created_at, NEW.lease_until) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_rollout_attempt_is_immutable';
    END IF;
    IF OLD.lease_until <= pg_catalog.clock_timestamp()
      AND NEW.state = (CASE WHEN OLD.fence = 3 THEN 'manual_review' ELSE 'expired' END) THEN
      RETURN NEW;
    END IF;
    IF NEW.state NOT IN ('verified', 'rejected') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_rollout_attempt_is_immutable';
    END IF;
  END IF;

  SELECT operation.candidate_id, operation.approval_version, task.generation, candidate.fingerprint,
    candidate.document AS manifest, target.document AS mapping, registry.proof AS image, dispatch.proof AS native_update
  INTO bound
  FROM itervane.release_operations operation
  JOIN itervane.release_candidates candidate ON candidate.id = operation.candidate_id AND candidate.document->>'origin' = 'formal_verification'
  JOIN itervane.release_decisions decision ON (decision.candidate_id, decision.version) = (candidate.id, operation.approval_version)
    AND decision.action = 'confirm' AND decision.self_confirmed = (decision.actor_id = candidate.requested_by)
  JOIN itervane.tasks task ON task.id = candidate.task_id AND task.generation::text = candidate.document->>'generation'
    AND task.requested_by = candidate.requested_by AND task.state IN ('reconciling', 'cancel_requested')
  JOIN itervane.task_runs run ON (run.id, run.task_id, run.generation) = (candidate.run_id, task.id, task.generation)
    AND run.state = task.state AND run.wakeup_job_id IS NULL
  JOIN itervane.run_runtime runtime ON (runtime.run_id, runtime.task_id) = (run.id, task.id)
    AND runtime.reason = 'release_komodo_awaiting_rollout'
  JOIN itervane.environments environment ON environment.id = operation.environment_id AND environment.access = 'protected'
  JOIN itervane.formal_release_targets target ON target.environment_id = environment.id
    AND target.revision::text = candidate.document#>>'{target,revision}' AND target.sha256 = candidate.document#>>'{target,mappingSha256}'
    AND target.document->>'rolloutCheckSha256' = candidate.document->>'rolloutCheckSha256'
    AND target.document->>'runtimeConfigSha256' = candidate.document->>'runtimeConfigSha256'
    AND pg_catalog.jsonb_typeof(target.document->'rolloutCheck') = 'object'
  JOIN itervane.formal_release_steps registry ON registry.operation_id = operation.id AND registry.kind = 'registry'
    AND registry.state = 'confirmed' AND registry.proof->>'manifestDigest' = candidate.document#>>'{image,manifestDigest}'
    AND registry.proof->>'configDigest' = candidate.document#>>'{image,configDigest}'
  JOIN itervane.formal_release_steps config ON config.operation_id = operation.id AND config.kind = 'komodo_config' AND config.state = 'confirmed'
  JOIN itervane.formal_release_steps dispatch ON dispatch.operation_id = operation.id AND dispatch.kind = 'komodo_dispatch'
    AND dispatch.state = 'confirmed' AND dispatch.proof->>'status' = 'Complete' AND dispatch.intent = config.intent
    AND dispatch.external_update_id = dispatch.proof->>'updateId'
  WHERE operation.id = NEW.operation_id AND operation.state = 'reconciling' AND operation.wakeup_job_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM itervane.execution_slot slot WHERE slot.task_id = task.id)
  FOR UPDATE OF operation;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_rollout_binding_required';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT attempt.fence, attempt.state INTO previous_fence, previous_state
      FROM itervane.formal_release_rollout_attempts attempt WHERE attempt.operation_id = NEW.operation_id
      ORDER BY attempt.fence DESC LIMIT 1;
    current_at := pg_catalog.clock_timestamp();
    checked_at := pg_catalog.statement_timestamp();
    -- Earlier workers submit a deadline relative to a live clock sample within the statement.
    IF NEW.lease_until > checked_at + interval '45 seconds' THEN
      checked_at := current_at;
    END IF;
    IF NEW.state <> 'observing' OR NEW.fence <> COALESCE(previous_fence, 0) + 1
      OR (previous_fence IS NOT NULL AND previous_state <> 'expired')
      OR NEW.lease_until <= GREATEST(checked_at, current_at) OR NEW.lease_until > checked_at + interval '45 seconds' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_rollout_lease_required';
    END IF;
    NEW.created_at := checked_at;
    RETURN NEW;
  END IF;

  checked_at := pg_catalog.clock_timestamp();
  IF OLD.lease_until <= checked_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_rollout_lease_required';
  END IF;
  IF NEW.state = 'verified' AND (
    bound.native_update->'success' IS DISTINCT FROM 'true'::jsonb
    OR (NEW.proof#>'{runtime,anonymousStatus}' IN ('401'::jsonb, '403'::jsonb)) IS NOT TRUE
    OR (NEW.proof#>>'{runtime,containerId}' ~ '^[a-f0-9]{64}$') IS NOT TRUE
    OR (NEW.proof#>>'{runtime,version}' ~ '^[a-zA-Z0-9_.-]{1,64}$') IS NOT TRUE
    OR NEW.proof IS DISTINCT FROM pg_catalog.jsonb_build_object(
      'version', 1, 'operationId', OLD.operation_id, 'rolloutFence', OLD.fence,
      'candidateId', bound.candidate_id, 'fingerprint', bound.fingerprint, 'decisionVersion', bound.approval_version,
      'generation', bound.generation, 'targetRevision', bound.manifest#>'{target,revision}',
      'mappingSha256', bound.manifest#>>'{target,mappingSha256}', 'manifestDigest', bound.image->>'manifestDigest',
      'update', bound.native_update,
      'runtime', pg_catalog.jsonb_build_object(
        'rolloutCheckSha256', bound.manifest->>'rolloutCheckSha256',
        'containerId', NEW.proof#>>'{runtime,containerId}', 'configDigest', bound.image->>'configDigest',
        'imageReference', bound.image->>'reference', 'runtimeConfigSha256', bound.manifest->>'runtimeConfigSha256',
        'network', bound.mapping#>>'{rolloutCheck,network}', 'anonymousStatus', NEW.proof#>'{runtime,anonymousStatus}',
        'healthStatus', 200, 'version', NEW.proof#>>'{runtime,version}'
      )
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_rollout_proof_mismatch';
  END IF;
  -- A backward clock step can follow a valid claim without changing the lease.
  NEW.completed_at := GREATEST(OLD.created_at, checked_at);
  RETURN NEW;
END;
$$;
