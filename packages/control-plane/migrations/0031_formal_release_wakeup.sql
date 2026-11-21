ALTER TABLE "itervane"."release_operations" ADD COLUMN "wakeup_job_id" uuid;--> statement-breakpoint
ALTER TABLE "itervane"."release_operations" ADD CONSTRAINT "release_operation_wakeup_unique" UNIQUE("wakeup_job_id");--> statement-breakpoint
ALTER TABLE "itervane"."release_operations" ADD CONSTRAINT "release_operation_wakeup_queued" CHECK ("itervane"."release_operations"."wakeup_job_id" IS NULL OR "itervane"."release_operations"."state" = 'queued');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION itervane.enforce_fixture_release_transition() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  formal boolean := EXISTS (
    SELECT 1 FROM itervane.release_candidates candidate
    WHERE candidate.id = NEW.candidate_id AND candidate.document->>'origin' = 'formal_verification'
  );
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
      -- Only a claim that still owns the slot and has no recorded downstream intent is recoverable here.
      IF OLD.state = 'dispatching' AND (
        NEW.state = 'blocked' OR (NEW.state = 'queued' AND NEW.wakeup_job_id IS NOT NULL)
      ) AND EXISTS (
        SELECT 1 FROM itervane.release_candidates candidate
        JOIN itervane.run_runtime runtime ON runtime.run_id = candidate.run_id AND runtime.task_id = candidate.task_id
        JOIN itervane.execution_slot slot ON slot.run_id = runtime.run_id AND slot.task_id = runtime.task_id
        WHERE candidate.id = NEW.candidate_id AND runtime.reason = 'release_claimed'
      ) THEN RETURN NEW; END IF;
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
UPDATE itervane.release_operations operation
SET wakeup_job_id = operation.id
FROM itervane.release_candidates candidate
WHERE candidate.id = operation.candidate_id AND candidate.document->>'origin' = 'formal_verification'
  AND operation.state = 'queued';
