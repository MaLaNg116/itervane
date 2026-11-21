ALTER TABLE "itervane"."release_operations" DROP CONSTRAINT "release_operation_wakeup_queued";--> statement-breakpoint
ALTER TABLE "itervane"."release_operations" ADD CONSTRAINT "release_operation_wakeup_recoverable" CHECK ("itervane"."release_operations"."wakeup_job_id" IS NULL OR "itervane"."release_operations"."state" IN ('queued', 'reconciling'));
--> statement-breakpoint
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
      SELECT runtime.reason, slot.id IS NOT NULL, slot.lease_until > pg_catalog.clock_timestamp(), task.state::text, intent.state
      INTO phase, slot_held, slot_live, task_state, intent_state
      FROM itervane.release_candidates candidate
      JOIN itervane.tasks task ON task.id = candidate.task_id AND task.generation::text = candidate.document->>'generation'
      JOIN itervane.run_runtime runtime ON runtime.run_id = candidate.run_id AND runtime.task_id = candidate.task_id
      LEFT JOIN itervane.execution_slot slot ON slot.run_id = runtime.run_id AND slot.task_id = runtime.task_id
      LEFT JOIN itervane.formal_release_steps intent ON intent.operation_id = NEW.id AND intent.kind = 'registry'
      WHERE candidate.id = NEW.candidate_id;
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
