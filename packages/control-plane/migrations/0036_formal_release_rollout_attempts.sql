CREATE TABLE "itervane"."formal_release_rollout_attempts" (
	"operation_id" uuid NOT NULL,
	"fence" integer NOT NULL,
	"worker_id" uuid NOT NULL,
	"state" text DEFAULT 'observing' NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "formal_release_rollout_attempts_operation_id_fence_pk" PRIMARY KEY("operation_id","fence"),
	CONSTRAINT "formal_rollout_fence" CHECK ("itervane"."formal_release_rollout_attempts"."fence" BETWEEN 1 AND 3),
	CONSTRAINT "formal_rollout_state" CHECK (("itervane"."formal_release_rollout_attempts"."state" = 'observing' OR ("itervane"."formal_release_rollout_attempts"."state" = 'expired' AND "itervane"."formal_release_rollout_attempts"."fence" < 3)
    OR ("itervane"."formal_release_rollout_attempts"."state" = 'manual_review' AND "itervane"."formal_release_rollout_attempts"."fence" = 3))),
	CONSTRAINT "formal_rollout_lease" CHECK ("itervane"."formal_release_rollout_attempts"."lease_until" > "itervane"."formal_release_rollout_attempts"."created_at"
    AND "itervane"."formal_release_rollout_attempts"."lease_until" <= "itervane"."formal_release_rollout_attempts"."created_at" + interval '45 seconds')
);
--> statement-breakpoint
ALTER TABLE "itervane"."formal_release_rollout_attempts" ADD CONSTRAINT "formal_release_rollout_attempts_operation_id_release_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "itervane"."release_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_formal_rollout_observer" ON "itervane"."formal_release_rollout_attempts" USING btree ((1)) WHERE "itervane"."formal_release_rollout_attempts"."state" = 'observing';
--> statement-breakpoint
CREATE FUNCTION itervane.guard_formal_release_rollout_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  checked_at timestamptz;
  previous_fence integer := 0;
  previous_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_rollout_attempt_is_immutable';
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.state = 'observing'
      AND OLD.lease_until <= pg_catalog.clock_timestamp()
      AND NEW.state = (CASE WHEN OLD.fence = 3 THEN 'manual_review' ELSE 'expired' END)
      AND (OLD.operation_id, OLD.fence, OLD.worker_id, OLD.created_at, OLD.lease_until)
        IS NOT DISTINCT FROM (NEW.operation_id, NEW.fence, NEW.worker_id, NEW.created_at, NEW.lease_until) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_rollout_attempt_is_immutable';
  END IF;

  PERFORM 1
  FROM itervane.release_operations operation
  JOIN itervane.release_candidates candidate ON candidate.id = operation.candidate_id AND candidate.document->>'origin' = 'formal_verification'
  JOIN itervane.release_decisions decision ON (decision.candidate_id, decision.version) = (candidate.id, operation.approval_version)
    AND decision.action = 'confirm' AND decision.self_confirmed = (decision.actor_id = candidate.requested_by)
  JOIN itervane.tasks task ON task.id = candidate.task_id AND task.generation::text = candidate.document->>'generation'
    AND task.state IN ('reconciling', 'cancel_requested')
  JOIN itervane.task_runs run ON (run.id, run.task_id, run.generation) = (candidate.run_id, task.id, task.generation)
    AND run.state = task.state AND run.wakeup_job_id IS NULL
  JOIN itervane.run_runtime runtime ON (runtime.run_id, runtime.task_id) = (run.id, task.id)
    AND runtime.reason = 'release_komodo_awaiting_rollout'
  JOIN itervane.environments environment ON environment.id = operation.environment_id AND environment.access = 'protected'
  JOIN itervane.formal_release_targets target ON target.environment_id = environment.id
    AND target.revision::text = candidate.document#>>'{target,revision}' AND target.sha256 = candidate.document#>>'{target,mappingSha256}'
    AND target.document->>'rolloutCheckSha256' = candidate.document->>'rolloutCheckSha256'
    AND pg_catalog.jsonb_typeof(target.document->'rolloutCheck') = 'object'
  JOIN itervane.formal_release_steps registry ON registry.operation_id = operation.id AND registry.kind = 'registry'
    AND registry.state = 'confirmed'
  JOIN itervane.formal_release_steps dispatch ON dispatch.operation_id = operation.id AND dispatch.kind = 'komodo_dispatch'
    AND dispatch.state = 'confirmed' AND dispatch.proof->>'status' = 'Complete'
    AND dispatch.external_update_id = dispatch.proof->>'updateId'
  WHERE operation.id = NEW.operation_id AND operation.state = 'reconciling' AND operation.wakeup_job_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM itervane.execution_slot slot WHERE slot.task_id = task.id)
  FOR UPDATE OF operation;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_rollout_binding_required';
  END IF;

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
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guard_formal_release_rollout_attempt BEFORE INSERT OR UPDATE OR DELETE
  ON itervane.formal_release_rollout_attempts FOR EACH ROW EXECUTE FUNCTION itervane.guard_formal_release_rollout_attempt();
