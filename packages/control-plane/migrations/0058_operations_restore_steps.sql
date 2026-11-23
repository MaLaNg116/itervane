CREATE TABLE "itervane"."operations_restore_steps" (
	"execution_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"plan_sha256" text NOT NULL,
	"worker_id" uuid NOT NULL,
	"fence" integer NOT NULL,
	"sent_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"receipt" jsonb,
	"recorded_at" timestamp with time zone,
	CONSTRAINT "operations_restore_steps_execution_id_kind_pk" PRIMARY KEY("execution_id","kind"),
	CONSTRAINT "operations_restore_step_binding" CHECK ("itervane"."operations_restore_steps"."kind" IN ('configure', 'deploy') AND "itervane"."operations_restore_steps"."fence" > 0 AND "itervane"."operations_restore_steps"."plan_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "operations_restore_step_receipt" CHECK ((("itervane"."operations_restore_steps"."receipt" IS NULL AND "itervane"."operations_restore_steps"."recorded_at" IS NULL)
    OR (jsonb_typeof("itervane"."operations_restore_steps"."receipt") = 'object' AND octet_length("itervane"."operations_restore_steps"."receipt"::text) <= 4096 AND "itervane"."operations_restore_steps"."recorded_at" >= "itervane"."operations_restore_steps"."sent_at")) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."operations_restore_steps" ADD CONSTRAINT "operations_restore_steps_execution_id_operations_execution_intents_execution_id_fk" FOREIGN KEY ("execution_id") REFERENCES "itervane"."operations_execution_intents"("execution_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operations_restore_native_update" ON "itervane"."operations_restore_steps" USING btree (("receipt"->>'updateId')) WHERE "itervane"."operations_restore_steps"."kind" = 'deploy' AND "itervane"."operations_restore_steps"."receipt" IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_restore_step() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  bound record;
  expected_image text;
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND (
    ROW(NEW.execution_id, NEW.kind, NEW.plan_sha256, NEW.worker_id, NEW.fence, NEW.sent_at, NEW.recorded_at)
      IS DISTINCT FROM ROW(OLD.execution_id, OLD.kind, OLD.plan_sha256, OLD.worker_id, OLD.fence, OLD.sent_at, OLD.recorded_at)
    OR OLD.receipt IS NOT NULL OR NEW.receipt IS NULL
  )) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restore_step_is_immutable';
  END IF;

  PERFORM 1 FROM itervane.execution_slot WHERE id = 1 FOR UPDATE;
  PERFORM 1 FROM itervane.operations_executions execution
    JOIN itervane.environments environment ON environment.id = execution.environment_id
    WHERE execution.id = NEW.execution_id FOR UPDATE OF environment;
  SELECT intent.restore_plan AS plan, intent.created_at AS intent_time, execution.environment_id, execution.decision_version,
    proposal.id AS proposal_id, proposal.valid_until, proposal.document, request.project_id, request.application_id,
    diagnosis.requested_by AS requester_id, approval.actor_id, approval.grant_id AS approver_grant_id
  INTO bound
  FROM itervane.operations_execution_intents intent
    JOIN itervane.operations_executions execution ON execution.id = intent.execution_id AND execution.state = 'reserved'
    JOIN itervane.operations_proposals proposal ON proposal.id = execution.proposal_id AND proposal.document#>>'{action,kind}' = 'rollback'
    JOIN itervane.operations_requests request ON request.run_id = proposal.diagnosis_run_id
    JOIN itervane.tasks diagnosis ON diagnosis.id = request.task_id AND diagnosis.state = 'succeeded'
    JOIN itervane.operations_decisions approval ON approval.proposal_id = proposal.id AND approval.version = intent.decision_version
      AND approval.action = 'confirm'
    JOIN itervane.operations_execution_schedules schedule ON schedule.execution_id = intent.execution_id AND schedule.wakeup_job_id IS NULL
    JOIN itervane.tasks task ON task.id = schedule.task_id AND task.generation = intent.generation AND task.state = 'running'
    JOIN itervane.task_runs run ON run.id = schedule.run_id AND run.task_id = task.id AND run.generation = intent.generation
      AND run.role = 'operations' AND run.state = task.state
    JOIN itervane.run_runtime runtime ON runtime.run_id = run.id AND runtime.task_id = task.id
      AND runtime.reason = 'operations_execution_dispatch_intended'
    JOIN itervane.execution_slot slot ON slot.id = 1 AND slot.task_id = task.id AND slot.run_id = run.id
      AND slot.worker_id = intent.worker_id AND slot.fence = intent.fence AND slot.lease_until > clock_timestamp()
  WHERE intent.execution_id = NEW.execution_id AND intent.restore_plan IS NOT NULL AND intent.restore_plan_sha256 = NEW.plan_sha256
    AND intent.worker_id = NEW.worker_id AND intent.fence = NEW.fence;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restore_step_lease_required';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.receipt IS NOT NULL OR NEW.recorded_at IS NOT NULL OR bound.valid_until <= clock_timestamp()
      OR EXISTS (
        SELECT 1 FROM itervane.operations_decisions decision
        WHERE decision.proposal_id = bound.proposal_id AND decision.version > bound.decision_version
      )
      OR NOT EXISTS (
        SELECT 1 FROM itervane.environments environment
          JOIN itervane.projects project ON project.id = environment.project_id
          JOIN itervane.workspace_members approver ON approver.workspace_id = project.workspace_id
            AND approver.principal_id = bound.actor_id AND approver.grant_id = bound.approver_grant_id
          JOIN itervane.formal_release_targets mapping ON mapping.environment_id = environment.id
          JOIN itervane.operations_targets enrollment ON enrollment.environment_id = environment.id
          LEFT JOIN itervane.workspace_members proposer_owner ON proposer_owner.workspace_id = project.workspace_id
            AND proposer_owner.principal_id::text = bound.document->>'proposedBy'
          LEFT JOIN itervane.project_members proposer_member ON proposer_member.project_id = project.id
            AND proposer_member.principal_id::text = bound.document->>'proposedBy' AND proposer_member.role = 'maintainer'
          LEFT JOIN itervane.workspace_members requester_owner ON requester_owner.workspace_id = project.workspace_id
            AND requester_owner.principal_id = bound.requester_id
          LEFT JOIN itervane.project_members requester_member ON requester_member.project_id = project.id
            AND requester_member.principal_id = bound.requester_id AND requester_member.role = 'maintainer'
        WHERE environment.id = bound.environment_id AND environment.access = 'protected'
          AND environment.project_id = bound.project_id AND environment.application_id = bound.application_id
          AND mapping.sha256 = bound.plan->>'mappingSha256' AND mapping.revision::text = bound.plan->>'targetRevision'
          AND enrollment.sha256 = bound.document#>>'{target,enrollmentSha256}'
          AND COALESCE(proposer_owner.grant_id, proposer_member.grant_id)::text = bound.document->>'grantId'
          AND COALESCE(requester_owner.grant_id, requester_member.grant_id)::text = bound.document#>>'{target,grantId}'
      )
      OR (NEW.kind = 'deploy' AND NOT EXISTS (
        SELECT 1 FROM itervane.operations_restore_steps configuration
        WHERE configuration.execution_id = NEW.execution_id AND configuration.kind = 'configure'
          AND configuration.worker_id = NEW.worker_id AND configuration.fence = NEW.fence AND configuration.receipt IS NOT NULL
      ))
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restore_step_send_authority_required';
    END IF;
    NEW.sent_at := GREATEST(bound.intent_time, clock_timestamp());
  ELSE
    IF NEW.kind = 'configure' THEN
      SELECT attempt.proof#>>'{runtime,imageReference}' INTO expected_image
      FROM itervane.formal_release_rollout_attempts attempt
      WHERE attempt.operation_id::text = bound.plan#>>'{restore,operationId}' AND attempt.state = 'verified';
      IF expected_image IS NULL OR NEW.receipt IS DISTINCT FROM jsonb_build_object(
        'deploymentId', bound.plan#>>'{target,deploymentId}', 'serverId', bound.plan#>>'{target,serverId}',
        'runtimeConfigSha256', bound.plan#>>'{target,runtimeConfigSha256}', 'imageReference', expected_image
      ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restore_configuration_receipt_required';
      END IF;
    ELSIF NOT ((
      NEW.receipt->>'deploymentId' = bound.plan#>>'{target,deploymentId}'
      AND NEW.receipt->>'actorId' = bound.plan#>>'{target,komodo,actorId}'
      AND NEW.receipt->>'updateId' ~ '^[a-f0-9]{24}$'
      AND NEW.receipt->>'status' IN ('Queued', 'InProgress', 'Complete')
      AND jsonb_typeof(NEW.receipt->'success') = 'boolean'
      AND NOT EXISTS (
        SELECT 1 FROM itervane.formal_release_steps step
        WHERE step.kind = 'komodo_dispatch' AND step.external_update_id = NEW.receipt->>'updateId'
          AND step.intent->>'origin' = bound.plan#>>'{target,komodo,origin}'
      )
    ) IS TRUE) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restore_deploy_receipt_required';
    END IF;
    NEW.recorded_at := GREATEST(OLD.sent_at, clock_timestamp());
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_restore_step_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.operations_restore_steps
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_restore_step();
