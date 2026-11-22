CREATE TABLE "itervane"."operations_restart_recoveries" (
	"execution_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"fence" integer NOT NULL,
	"worker_id" uuid NOT NULL,
	"state" text DEFAULT 'observing' NOT NULL,
	"failure" text,
	"proof" jsonb,
	"proof_sha256" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "operations_restart_recoveries_execution_id_attempt_pk" PRIMARY KEY("execution_id","attempt"),
	CONSTRAINT "operations_restart_recovery_fence" UNIQUE("execution_id","fence"),
	CONSTRAINT "operations_restart_recovery_scope" CHECK ("itervane"."operations_restart_recoveries"."attempt" BETWEEN 1 AND 3 AND "itervane"."operations_restart_recoveries"."fence" > 0),
	CONSTRAINT "operations_restart_recovery_proof" CHECK ((("itervane"."operations_restart_recoveries"."proof" IS NULL AND "itervane"."operations_restart_recoveries"."proof_sha256" IS NULL)
    OR (jsonb_typeof("itervane"."operations_restart_recoveries"."proof") = 'object' AND octet_length("itervane"."operations_restart_recoveries"."proof"::text) <= 4096
      AND "itervane"."operations_restart_recoveries"."proof_sha256" ~ '^[a-f0-9]{64}$')) IS TRUE),
	CONSTRAINT "operations_restart_recovery_lifecycle" CHECK ((
    ("itervane"."operations_restart_recoveries"."state" = 'observing' AND "itervane"."operations_restart_recoveries"."completed_at" IS NULL AND "itervane"."operations_restart_recoveries"."failure" IS NULL AND "itervane"."operations_restart_recoveries"."proof" IS NULL)
    OR ("itervane"."operations_restart_recoveries"."completed_at" >= "itervane"."operations_restart_recoveries"."created_at" AND (
      ("itervane"."operations_restart_recoveries"."state" = 'verified' AND "itervane"."operations_restart_recoveries"."failure" IS NULL AND "itervane"."operations_restart_recoveries"."proof" IS NOT NULL)
      OR ("itervane"."operations_restart_recoveries"."state" = 'retry' AND "itervane"."operations_restart_recoveries"."attempt" < 3 AND "itervane"."operations_restart_recoveries"."failure" IN ('unhealthy', 'unavailable', 'lease_expired') AND "itervane"."operations_restart_recoveries"."proof" IS NULL)
      OR ("itervane"."operations_restart_recoveries"."state" = 'manual_review' AND (
        ("itervane"."operations_restart_recoveries"."failure" = 'native_unconfirmed' AND "itervane"."operations_restart_recoveries"."proof" IS NOT NULL)
        OR ("itervane"."operations_restart_recoveries"."failure" IN ('missing_evidence', 'target_changed') AND "itervane"."operations_restart_recoveries"."proof" IS NULL)
        OR ("itervane"."operations_restart_recoveries"."attempt" = 3 AND "itervane"."operations_restart_recoveries"."failure" IN ('unhealthy', 'unavailable', 'lease_expired') AND "itervane"."operations_restart_recoveries"."proof" IS NULL)
      ))
    ))) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."operations_executions" DROP CONSTRAINT "operations_execution_lifecycle";--> statement-breakpoint
ALTER TABLE "itervane"."operations_restart_recoveries" ADD CONSTRAINT "operations_restart_recoveries_execution_id_operations_execution_intents_execution_id_fk" FOREIGN KEY ("execution_id") REFERENCES "itervane"."operations_execution_intents"("execution_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_executions" ADD CONSTRAINT "operations_execution_lifecycle" CHECK ((("itervane"."operations_executions"."state" = 'reserved' AND "itervane"."operations_executions"."closed_at" IS NULL AND "itervane"."operations_executions"."blocked_reason" IS NULL)
    OR ("itervane"."operations_executions"."state" = 'blocked' AND "itervane"."operations_executions"."closed_at" >= "itervane"."operations_executions"."created_at" AND "itervane"."operations_executions"."blocked_reason" IN ('approval_revoked', 'proposal_expired', 'restart_not_sent'))
    OR ("itervane"."operations_executions"."state" = 'recovered' AND "itervane"."operations_executions"."closed_at" >= "itervane"."operations_executions"."created_at" AND "itervane"."operations_executions"."blocked_reason" IS NULL)) IS TRUE);
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_restart_recovery() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
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
        JOIN itervane.release_operations release ON release.environment_id = execution.environment_id
          AND release.id::text = proposal.document#>>'{target,releaseOperationId}' AND release.state = 'verified_formal'
        JOIN itervane.formal_release_rollout_attempts rollout ON rollout.operation_id = release.id AND rollout.state = 'verified'
        LEFT JOIN LATERAL (
          SELECT resume.* FROM itervane.operations_restart_resumes resume WHERE resume.execution_id = execution.id
            ORDER BY resume.attempt DESC LIMIT 1
        ) native ON true
        WHERE execution.id = NEW.execution_id AND started > request.runtime_baseline->>'startedAt'
          AND runtime = (rollout.proof->'runtime') || jsonb_build_object('anonymousStatus', runtime->'anonymousStatus')
          AND NEW.proof = jsonb_build_object(
            'version', 1, 'executionId', execution.id, 'releaseOperationId', release.id, 'fence', NEW.fence,
            'proposalFingerprint', execution.proposal_fingerprint, 'callSha256', request.call_sha256,
            'runtimeBaselineSha256', request.runtime_baseline_sha256,
            'native', CASE WHEN NEW.state = 'verified' THEN jsonb_build_object('approvalId', request.approval_id, 'attempt', native.attempt) END,
            'observation', jsonb_build_object('runtime', runtime, 'startedAt', started)
          )
          AND (NEW.state <> 'verified' OR (native.state = 'acknowledged' AND native.fence < NEW.fence
            AND native.approval_id = request.approval_id AND native.call_sha256 = request.call_sha256))
          AND NOT EXISTS (SELECT 1 FROM itervane.release_operations concurrent_release WHERE concurrent_release.environment_id = execution.environment_id
            AND concurrent_release.state IN ('queued', 'dispatching', 'reconciling'))
          AND release.id = (SELECT newest.id FROM itervane.release_operations newest WHERE newest.environment_id = execution.environment_id
            AND newest.state = 'verified_formal' ORDER BY newest.updated_at DESC, newest.id DESC LIMIT 1)
      ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_recovery_evidence_required';
    END IF;
  END IF;
  NEW.completed_at := GREATEST(OLD.created_at, clock_timestamp());
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_restart_recovery_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.operations_restart_recoveries
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_restart_recovery();
--> statement-breakpoint
CREATE FUNCTION itervane.require_restart_recovery_transition() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM itervane.operations_executions execution
      JOIN itervane.operations_execution_schedules schedule ON schedule.execution_id = execution.id
      JOIN itervane.tasks task ON task.id = schedule.task_id
      JOIN itervane.task_runs run ON run.id = schedule.run_id AND run.task_id = task.id AND run.state = task.state AND run.generation = task.generation
      JOIN itervane.run_runtime phase ON phase.run_id = run.id
      JOIN itervane.task_events event ON event.task_id = task.id AND event.sequence = task.version AND event.state = task.state
        AND event.type = 'task.operations_restart_recovery_recorded' AND event.detail->>'executionId' = execution.id::text
        AND event.detail->>'recoveryAttempt' = NEW.attempt::text AND event.detail->>'recoverySha256' IS NOT DISTINCT FROM NEW.proof_sha256
    WHERE execution.id = NEW.execution_id AND NOT EXISTS (SELECT 1 FROM itervane.execution_slot slot WHERE slot.task_id = task.id)
      AND (
        (NEW.state = 'verified' AND execution.state = 'recovered' AND execution.closed_at = NEW.completed_at AND task.state = 'succeeded'
          AND phase.reason = 'operations_restart_recovery_verified' AND schedule.wakeup_job_id IS NULL)
        OR (NEW.state = 'retry' AND execution.state = 'reserved' AND task.state = 'reconciling'
          AND phase.reason = 'operations_execution_reconciling' AND schedule.wakeup_job_id IS NOT NULL)
        OR (NEW.state = 'manual_review' AND execution.state = 'reserved' AND task.state = 'needs_human'
          AND phase.reason = 'operations_restart_recovery_manual' AND schedule.wakeup_job_id IS NULL)
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_recovery_must_settle';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER operations_restart_recovery_transition AFTER UPDATE ON itervane.operations_restart_recoveries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION itervane.require_restart_recovery_transition();
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
