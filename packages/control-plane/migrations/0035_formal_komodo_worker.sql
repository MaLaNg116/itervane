-- Guard the durable handoff, write lease and independent native observations.
CREATE OR REPLACE FUNCTION itervane.enforce_fixture_release_transition() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  formal boolean := EXISTS (
    SELECT 1 FROM itervane.release_candidates candidate
    WHERE candidate.id = NEW.candidate_id AND candidate.document->>'origin' = 'formal_verification'
  );
  phase text;
  slot_held boolean;
  slot_live boolean;
  task_state text;
  intent_state text;
  config_state text;
  dispatch_state text;
  dispatch_update text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state = 'queued' AND (
      (formal AND NEW.wakeup_job_id IS NOT DISTINCT FROM NEW.id)
      OR (NOT formal AND NEW.wakeup_job_id IS NULL)
    ) THEN RETURN NEW; END IF;
  ELSIF (NEW.id, NEW.candidate_id, NEW.environment_id, NEW.approval_version, NEW.created_at)
      IS NOT DISTINCT FROM (OLD.id, OLD.candidate_id, OLD.environment_id, OLD.approval_version, OLD.created_at) THEN
    IF formal THEN
      IF OLD.state = 'queued' AND (
        (NEW.state = 'queued' AND NEW.wakeup_job_id IS NOT NULL AND NEW.wakeup_job_id IS DISTINCT FROM OLD.wakeup_job_id)
        OR NEW.state IN ('dispatching', 'blocked')
      ) THEN RETURN NEW; END IF;
      SELECT runtime.reason, slot.id IS NOT NULL, slot.lease_until > pg_catalog.clock_timestamp(),
        task.state::text, intent.state, config.state, dispatch.state, dispatch.external_update_id
      INTO phase, slot_held, slot_live, task_state, intent_state, config_state, dispatch_state, dispatch_update
      FROM itervane.release_candidates candidate
      JOIN itervane.tasks task ON task.id = candidate.task_id AND task.generation::text = candidate.document->>'generation'
      JOIN itervane.run_runtime runtime ON runtime.run_id = candidate.run_id AND runtime.task_id = candidate.task_id
      LEFT JOIN itervane.execution_slot slot ON slot.run_id = runtime.run_id AND slot.task_id = runtime.task_id
      LEFT JOIN itervane.formal_release_steps intent ON intent.operation_id = NEW.id AND intent.kind = 'registry'
      LEFT JOIN itervane.formal_release_steps config ON config.operation_id = NEW.id AND config.kind = 'komodo_config'
      LEFT JOIN itervane.formal_release_steps dispatch ON dispatch.operation_id = NEW.id AND dispatch.kind = 'komodo_dispatch'
      WHERE candidate.id = NEW.candidate_id;

      IF intent_state = 'confirmed' AND phase IN (
        'release_komodo_ready', 'release_komodo_config_prepared', 'release_komodo_configured',
        'release_komodo_dispatch_prepared', 'release_komodo_update_recorded',
        'release_komodo_dispatch_observed', 'release_komodo_reconciling'
      ) AND OLD.state IN ('dispatching', 'reconciling') THEN
        -- A new write lease is claimed separately from the Registry or Komodo observation lease.
        IF OLD.state = 'reconciling' AND phase = 'release_komodo_ready' AND OLD.wakeup_job_id IS NOT NULL
          AND NEW.state = 'dispatching' AND NEW.wakeup_job_id IS NULL AND slot_live AND task_state = 'reconciling'
          AND dispatch_state IS NULL AND (config_state IS NULL OR config_state = 'confirmed') THEN RETURN NEW; END IF;
        IF NEW.state = 'blocked' AND NEW.wakeup_job_id IS NULL
          AND dispatch_state IS NULL AND (config_state IS NULL OR config_state = 'confirmed')
          AND ((phase = 'release_komodo_ready' AND (slot_held OR OLD.wakeup_job_id IS NOT NULL))
            OR (phase IN ('release_komodo_configured', 'release_komodo_reconciling') AND slot_held)) THEN RETURN NEW; END IF;
        IF NEW.state = 'reconciling' THEN
          IF NEW.wakeup_job_id IS NOT NULL AND NEW.wakeup_job_id IS DISTINCT FROM OLD.wakeup_job_id
            AND (slot_held OR (OLD.state = 'reconciling' AND OLD.wakeup_job_id IS NOT NULL
              AND phase IN ('release_komodo_ready', 'release_komodo_reconciling'))) THEN RETURN NEW; END IF;
          IF NEW.wakeup_job_id IS NULL AND OLD.state = 'dispatching' AND slot_held
            AND (config_state = 'prepared' OR dispatch_state IS NOT NULL) THEN RETURN NEW; END IF;
          IF NEW.wakeup_job_id IS NULL AND OLD.state = 'reconciling' AND OLD.wakeup_job_id IS NOT NULL
            AND phase = 'release_komodo_reconciling' AND slot_live
            AND ((dispatch_state = 'prepared' AND dispatch_update IS NOT NULL)
              OR (dispatch_state IS NULL AND config_state = 'prepared')) THEN RETURN NEW; END IF;
        END IF;
      END IF;

      IF OLD.state = 'dispatching' AND slot_held THEN
        IF phase = 'release_claimed' AND intent_state IS NULL AND (
          NEW.state = 'blocked' OR (NEW.state = 'queued' AND NEW.wakeup_job_id IS NOT NULL)
        ) THEN RETURN NEW; END IF;
        IF phase IN ('release_registry_prepared', 'release_registry_verified') AND intent_state IS NOT NULL
          AND NEW.state = 'reconciling' THEN RETURN NEW; END IF;
        IF phase = 'release_registry_verified' AND intent_state = 'confirmed' AND slot_live
          AND NEW.state = 'blocked' AND task_state = 'cancel_requested' THEN RETURN NEW; END IF;
      END IF;
      IF OLD.state = 'reconciling' AND intent_state IS NOT NULL THEN
        IF phase = 'release_registry_reconciling' AND NEW.state = 'reconciling' AND NEW.wakeup_job_id IS DISTINCT FROM OLD.wakeup_job_id
          AND (NEW.wakeup_job_id IS NOT NULL OR slot_live) THEN RETURN NEW; END IF;
        IF phase = 'release_registry_verified' AND intent_state = 'confirmed' AND slot_live
          AND (NEW.state = 'dispatching' OR (NEW.state = 'blocked' AND task_state = 'cancel_requested')) THEN RETURN NEW; END IF;
      END IF;
    ELSIF NEW.wakeup_job_id IS NULL AND (
      (OLD.state = 'queued' AND NEW.state IN ('dispatching', 'blocked'))
      OR (OLD.state = 'dispatching' AND NEW.state IN ('reconciling', 'verified_fixture'))
      OR (OLD.state = 'reconciling' AND NEW.state = 'verified_fixture')
    ) THEN RETURN NEW;
    END IF;
  END IF;
  IF formal THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid_formal_release_transition';
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid_fixture_release_transition';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION itervane.guard_formal_release_step() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  manifest jsonb;
  mapping jsonb;
  bound_candidate_id uuid;
  bound_decision_version integer;
  bound_workspace_id uuid;
  current_state text;
  current_phase text;
  current_fence integer;
  current_worker uuid;
  komodo_step boolean;
  may_prepare boolean;
  registry_reference text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_step_is_immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    (OLD.operation_id, OLD.kind, OLD.prepared_fence, OLD.prepared_by, OLD.created_at, OLD.intent)
      IS DISTINCT FROM (NEW.operation_id, NEW.kind, NEW.prepared_fence, NEW.prepared_by, NEW.created_at, NEW.intent)
    OR (OLD.external_update_id IS NOT NULL AND OLD.external_update_id IS DISTINCT FROM NEW.external_update_id)
    OR OLD.state = 'confirmed'
    OR (OLD.kind = 'archive' AND (NEW.state <> 'confirmed' OR NEW.settled_fence <> OLD.prepared_fence))
    OR (OLD.kind = 'registry' AND NEW.state NOT IN ('confirmed', 'uncertain'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_step_is_immutable';
  END IF;

  SELECT candidate.document, target.document, candidate.id, operation.approval_version, project.workspace_id,
    task.state::text, runtime.reason, slot.fence, slot.worker_id
  INTO manifest, mapping, bound_candidate_id, bound_decision_version, bound_workspace_id,
    current_state, current_phase, current_fence, current_worker
  FROM itervane.release_operations operation
  JOIN itervane.environments environment ON environment.id = operation.environment_id AND environment.access = 'protected'
  JOIN itervane.release_candidates candidate ON candidate.id = operation.candidate_id AND candidate.environment_id = operation.environment_id
  JOIN itervane.tasks task ON task.id = candidate.task_id AND task.project_id = candidate.project_id
    AND task.requested_by = candidate.requested_by AND task.generation::text = candidate.document->>'generation'
  JOIN itervane.projects project ON project.id = task.project_id
  JOIN itervane.task_runs run ON run.id = candidate.run_id AND run.task_id = task.id AND run.generation = task.generation AND run.state = task.state
  JOIN itervane.run_runtime runtime ON runtime.run_id = run.id AND runtime.task_id = task.id
  JOIN itervane.execution_slot slot ON slot.task_id = task.id AND slot.run_id = run.id
  LEFT JOIN itervane.formal_release_targets target ON target.environment_id = operation.environment_id AND target.project_id = task.project_id
    AND target.application_id = candidate.application_id AND target.sha256 = candidate.document#>>'{target,mappingSha256}'
    AND target.revision::text = candidate.document#>>'{target,revision}'
  WHERE operation.id = NEW.operation_id AND candidate.document->>'origin' = 'formal_verification'
    AND operation.state IN ('dispatching', 'reconciling') AND operation.wakeup_job_id IS NULL
    AND slot.lease_until > pg_catalog.clock_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_step_authority';
  END IF;

  komodo_step := NEW.kind IN ('komodo_config', 'komodo_dispatch');
  IF TG_OP = 'INSERT' OR NEW.kind = 'archive' THEN
    may_prepare := CASE NEW.kind
      WHEN 'komodo_config' THEN current_phase IN ('release_registry_verified', 'release_komodo_ready')
      WHEN 'komodo_dispatch' THEN current_phase IN ('release_komodo_configured', 'release_komodo_ready')
      ELSE current_phase = 'release_claimed'
    END;
    IF may_prepare IS NOT TRUE OR current_state <> 'running' OR mapping IS NULL
      OR (manifest->>'validUntil')::timestamptz <= pg_catalog.clock_timestamp()
      OR NOT EXISTS (
        SELECT 1 FROM itervane.release_decisions decision
        JOIN itervane.workspace_members owner ON owner.principal_id = decision.actor_id AND owner.grant_id = decision.grant_id
        WHERE decision.candidate_id = bound_candidate_id AND decision.version = bound_decision_version AND decision.action = 'confirm'
          AND owner.workspace_id = bound_workspace_id AND NOT EXISTS (
            SELECT 1 FROM itervane.release_decisions later
            WHERE later.candidate_id = decision.candidate_id AND later.version > decision.version
          )
      ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_step_authority';
    END IF;
  ELSIF NOT komodo_step AND (current_phase NOT IN ('release_registry_prepared', 'release_registry_reconciling')
    OR current_phase IS NULL OR current_state NOT IN ('running', 'cancel_requested')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_step_authority';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'prepared' OR NEW.external_update_id IS NOT NULL
      OR (NEW.prepared_fence, NEW.prepared_by) IS DISTINCT FROM (current_fence, current_worker) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_step_authority';
    END IF;
    IF NEW.kind = 'registry' AND NOT EXISTS (
      SELECT 1 FROM itervane.formal_release_steps archive
      WHERE archive.operation_id = NEW.operation_id AND archive.kind = 'archive' AND archive.state = 'confirmed'
        AND archive.prepared_fence = current_fence AND archive.settled_fence = current_fence
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_archive_required';
    END IF;
    IF komodo_step THEN
      SELECT registry.proof->>'reference' INTO registry_reference FROM itervane.formal_release_steps registry
      WHERE registry.operation_id = NEW.operation_id AND registry.kind = 'registry' AND registry.state = 'confirmed'
        AND CASE current_phase
          WHEN 'release_registry_verified' THEN registry.prepared_fence = current_fence AND registry.prepared_by = current_worker
          WHEN 'release_komodo_ready' THEN registry.settled_fence < current_fence
          ELSE registry.settled_fence <= current_fence
        END;
      IF registry_reference IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_registry_required';
      END IF;
      IF mapping#>>'{komodo,origin}' IS NULL OR mapping#>>'{komodo,actorId}' IS NULL
        OR (NEW.intent->>'previousImageSha256' ~ '^[a-f0-9]{64}$') IS NOT TRUE
        OR NEW.intent IS DISTINCT FROM pg_catalog.jsonb_build_object(
          'origin', mapping#>>'{komodo,origin}', 'actorId', mapping#>>'{komodo,actorId}',
          'revision', manifest#>'{target,revision}', 'mappingSha256', manifest#>>'{target,mappingSha256}',
          'deploymentId', mapping->>'deploymentId', 'serverId', mapping->>'serverId',
          'runtimeConfigSha256', manifest->>'runtimeConfigSha256', 'imageReference', registry_reference,
          'previousImageSha256', NEW.intent->>'previousImageSha256'
        ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_step_intent_mismatch';
      END IF;
      IF NEW.kind = 'komodo_dispatch' AND NOT EXISTS (
        SELECT 1 FROM itervane.formal_release_steps config
        WHERE config.operation_id = NEW.operation_id AND config.kind = 'komodo_config'
          AND config.state = 'confirmed' AND config.intent = NEW.intent
      ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_komodo_config_required';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF komodo_step THEN
    IF mapping IS NULL OR current_state NOT IN ('running', 'cancel_requested')
      OR (current_phase = 'release_komodo_reconciling' AND NEW.prepared_fence >= current_fence)
      OR (current_phase IS DISTINCT FROM 'release_komodo_reconciling'
        AND (NEW.prepared_fence, NEW.prepared_by) IS DISTINCT FROM (current_fence, current_worker)) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_step_authority';
    END IF;
    IF NEW.kind = 'komodo_dispatch' AND current_phase = 'release_komodo_dispatch_prepared'
      AND OLD.external_update_id IS NULL AND NEW.external_update_id IS NOT NULL AND NEW.state = 'prepared' THEN
      RETURN NEW;
    END IF;
    IF NEW.state <> 'confirmed' OR (NEW.settled_fence, NEW.settled_by) IS DISTINCT FROM (current_fence, current_worker) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_step_authority';
    END IF;
    IF NEW.kind = 'komodo_config' AND current_phase IN ('release_komodo_config_prepared', 'release_komodo_reconciling')
      AND NEW.proof = pg_catalog.jsonb_build_object(
        'deploymentId', NEW.intent->>'deploymentId', 'serverId', NEW.intent->>'serverId',
        'runtimeConfigSha256', NEW.intent->>'runtimeConfigSha256', 'imageReference', NEW.intent->>'imageReference'
      ) THEN
      RETURN NEW;
    END IF;
    IF NEW.kind = 'komodo_dispatch' AND current_phase IN ('release_komodo_update_recorded', 'release_komodo_reconciling')
      AND OLD.external_update_id IS NOT NULL AND pg_catalog.jsonb_typeof(NEW.proof->'success') = 'boolean'
      AND NEW.proof = pg_catalog.jsonb_build_object(
        'updateId', OLD.external_update_id, 'deploymentId', NEW.intent->>'deploymentId',
        'actorId', NEW.intent->>'actorId', 'status', 'Complete', 'success', NEW.proof->'success'
      ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_step_proof_mismatch';
  END IF;

  IF (NEW.settled_fence, NEW.settled_by) IS DISTINCT FROM (current_fence, current_worker) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_step_authority';
  END IF;
  IF NEW.state = 'confirmed' AND (
    NEW.proof->'archive' IS DISTINCT FROM manifest#>'{image,archive}'
    OR (NEW.kind = 'archive' AND (
      NEW.proof->>'kind' IS DISTINCT FROM 'archive_verified' OR NEW.proof->'version' IS DISTINCT FROM '1'::jsonb
      OR NEW.proof->>'runnerImageSha256' IS DISTINCT FROM manifest#>>'{image,runnerImageSha256}'
    ))
    OR (NEW.kind = 'registry' AND (
      mapping->>'registryOrigin' IS NULL OR NEW.proof->>'registryOrigin' IS DISTINCT FROM mapping->>'registryOrigin'
      OR NEW.proof->>'repository' IS DISTINCT FROM mapping->>'imageRepository'
      OR NEW.proof->>'manifestDigest' IS DISTINCT FROM manifest#>>'{image,manifestDigest}'
      OR NEW.proof->>'configDigest' IS DISTINCT FROM manifest#>>'{image,configDigest}'
    ))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_step_proof_mismatch';
  END IF;
  RETURN NEW;
END;
$$;
