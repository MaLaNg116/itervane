ALTER TABLE "itervane"."formal_release_rollout_attempts" DROP CONSTRAINT "formal_rollout_state";--> statement-breakpoint
ALTER TABLE "itervane"."release_operations" DROP CONSTRAINT "release_operation_state";--> statement-breakpoint
ALTER TABLE "itervane"."formal_release_rollout_attempts" ADD COLUMN "proof" jsonb;--> statement-breakpoint
ALTER TABLE "itervane"."formal_release_rollout_attempts" ADD COLUMN "failure" text;--> statement-breakpoint
ALTER TABLE "itervane"."formal_release_rollout_attempts" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "itervane"."formal_release_rollout_attempts" ADD CONSTRAINT "formal_rollout_outcome" CHECK ((
    ("itervane"."formal_release_rollout_attempts"."state" NOT IN ('verified', 'rejected') AND "itervane"."formal_release_rollout_attempts"."proof" IS NULL AND "itervane"."formal_release_rollout_attempts"."failure" IS NULL AND "itervane"."formal_release_rollout_attempts"."completed_at" IS NULL)
    OR ("itervane"."formal_release_rollout_attempts"."completed_at" >= "itervane"."formal_release_rollout_attempts"."created_at" AND "itervane"."formal_release_rollout_attempts"."completed_at" < "itervane"."formal_release_rollout_attempts"."lease_until" AND (
      ("itervane"."formal_release_rollout_attempts"."state" = 'verified' AND jsonb_typeof("itervane"."formal_release_rollout_attempts"."proof") = 'object' AND octet_length("itervane"."formal_release_rollout_attempts"."proof"::text) <= 8192 AND "itervane"."formal_release_rollout_attempts"."failure" IS NULL)
      OR ("itervane"."formal_release_rollout_attempts"."state" = 'rejected' AND "itervane"."formal_release_rollout_attempts"."proof" IS NULL AND "itervane"."formal_release_rollout_attempts"."failure" IN (
        'release_rollout_update_failed', 'release_rollout_update_changed', 'release_rollout_runtime_changed',
        'release_rollout_ingress_changed', 'release_rollout_health_failed', 'release_rollout_unavailable'
      ))
    ))
  ) IS TRUE);--> statement-breakpoint
ALTER TABLE "itervane"."formal_release_rollout_attempts" ADD CONSTRAINT "formal_rollout_state" CHECK (("itervane"."formal_release_rollout_attempts"."state" IN ('observing', 'verified', 'rejected') OR ("itervane"."formal_release_rollout_attempts"."state" = 'expired' AND "itervane"."formal_release_rollout_attempts"."fence" < 3)
    OR ("itervane"."formal_release_rollout_attempts"."state" = 'manual_review' AND "itervane"."formal_release_rollout_attempts"."fence" = 3)));--> statement-breakpoint
ALTER TABLE "itervane"."release_operations" ADD CONSTRAINT "release_operation_state" CHECK ("itervane"."release_operations"."state" IN ('queued', 'dispatching', 'reconciling', 'verified_fixture', 'verified_formal', 'blocked'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION itervane.guard_formal_release_rollout_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  checked_at timestamptz;
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
    checked_at := pg_catalog.clock_timestamp();
    IF NEW.state <> 'observing' OR NEW.fence <> COALESCE(previous_fence, 0) + 1
      OR (previous_fence IS NOT NULL AND previous_state <> 'expired')
      OR NEW.lease_until <= checked_at OR NEW.lease_until > checked_at + interval '45 seconds' THEN
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
  NEW.completed_at := checked_at;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Both the fixture transitions and the formal write transitions retain their current checks.
CREATE OR REPLACE TRIGGER release_operation_transition BEFORE INSERT OR UPDATE ON itervane.release_operations
FOR EACH ROW WHEN (NEW.state <> 'verified_formal') EXECUTE FUNCTION itervane.enforce_fixture_release_transition();
--> statement-breakpoint
CREATE FUNCTION itervane.guard_formal_rollout_environment_release() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.state = 'reconciling' AND OLD.wakeup_job_id IS NULL AND NEW.wakeup_job_id IS NULL
    AND (NEW.id, NEW.candidate_id, NEW.environment_id, NEW.approval_version, NEW.created_at)
      IS NOT DISTINCT FROM (OLD.id, OLD.candidate_id, OLD.environment_id, OLD.approval_version, OLD.created_at)
    AND EXISTS (
      SELECT 1 FROM itervane.formal_release_rollout_attempts attempt
      WHERE attempt.operation_id = OLD.id AND attempt.state = 'verified' AND attempt.lease_until > pg_catalog.clock_timestamp()
    ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_rollout_evidence_required';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER formal_rollout_environment_release BEFORE INSERT OR UPDATE ON itervane.release_operations
FOR EACH ROW WHEN (NEW.state = 'verified_formal') EXECUTE FUNCTION itervane.guard_formal_rollout_environment_release();
--> statement-breakpoint
CREATE FUNCTION itervane.require_formal_rollout_settlement() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM itervane.release_operations operation
    JOIN itervane.release_candidates candidate ON candidate.id = operation.candidate_id
    JOIN itervane.tasks task ON task.id = candidate.task_id AND task.generation::text = candidate.document->>'generation'
    JOIN itervane.task_runs run ON (run.id, run.task_id, run.generation) = (candidate.run_id, task.id, task.generation)
      AND run.state = task.state AND run.wakeup_job_id IS NULL
    JOIN itervane.run_runtime runtime ON (runtime.run_id, runtime.task_id) = (run.id, task.id)
    JOIN itervane.task_events event ON event.task_id = task.id AND event.sequence = task.version AND event.state = task.state
      AND event.worker_id = NEW.worker_id AND event.detail->>'operationId' = operation.id::text
      AND event.detail->>'rolloutFence' = NEW.fence::text AND event.detail->>'fingerprint' = candidate.fingerprint
      AND event.detail->>'decisionVersion' = operation.approval_version::text
    WHERE operation.id = NEW.operation_id AND (
      (NEW.state = 'verified' AND operation.state = 'verified_formal' AND task.state IN ('succeeded', 'cancelled')
        AND runtime.reason = 'release_rollout_verified' AND event.type = 'task.release_rollout_verified')
      OR (NEW.state = 'rejected' AND operation.state = 'reconciling' AND task.state = 'needs_human'
        AND runtime.reason = 'release_rollout_manual_review' AND event.type = 'task.release_rollout_manual_review'
        AND event.detail->>'reason' = NEW.failure)
    )
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_rollout_settlement_incomplete';
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER require_formal_rollout_settlement AFTER UPDATE ON itervane.formal_release_rollout_attempts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state IN ('verified', 'rejected'))
EXECUTE FUNCTION itervane.require_formal_rollout_settlement();
