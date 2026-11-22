CREATE TABLE "itervane"."operations_executions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"proposal_id" uuid NOT NULL,
	"proposal_fingerprint" text NOT NULL,
	"environment_id" uuid NOT NULL,
	"decision_version" integer NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"blocked_reason" text,
	CONSTRAINT "operations_execution_per_proposal" UNIQUE("proposal_id"),
	CONSTRAINT "operations_execution_binding" CHECK ("itervane"."operations_executions"."decision_version" = 1 AND "itervane"."operations_executions"."proposal_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "operations_execution_lifecycle" CHECK ((("itervane"."operations_executions"."state" = 'reserved' AND "itervane"."operations_executions"."closed_at" IS NULL AND "itervane"."operations_executions"."blocked_reason" IS NULL)
    OR ("itervane"."operations_executions"."state" = 'blocked' AND "itervane"."operations_executions"."closed_at" >= "itervane"."operations_executions"."created_at" AND "itervane"."operations_executions"."blocked_reason" IN ('approval_revoked', 'proposal_expired'))) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."operations_executions" ADD CONSTRAINT "operations_executions_proposal_id_operations_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "itervane"."operations_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_executions" ADD CONSTRAINT "operations_executions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "itervane"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_executions" ADD CONSTRAINT "operations_execution_decision_fk" FOREIGN KEY ("proposal_id","decision_version") REFERENCES "itervane"."operations_decisions"("proposal_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operations_execution_environment_hold" ON "itervane"."operations_executions" USING btree ("environment_id") WHERE "itervane"."operations_executions"."state" = 'reserved';
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_execution_admission() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_execution_is_retained';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.state <> 'reserved' OR NEW.state <> 'blocked'
      OR ROW(NEW.id, NEW.proposal_id, NEW.proposal_fingerprint, NEW.environment_id, NEW.decision_version, NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id, OLD.proposal_id, OLD.proposal_fingerprint, OLD.environment_id, OLD.decision_version, OLD.created_at)
      OR NEW.closed_at IS NULL OR NEW.closed_at > clock_timestamp()
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
--> statement-breakpoint
CREATE TRIGGER operations_execution_admission BEFORE INSERT OR UPDATE OR DELETE ON itervane.operations_executions
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_execution_admission();
--> statement-breakpoint
CREATE FUNCTION itervane.release_operations_reservation_on_revocation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  UPDATE itervane.operations_executions SET state = 'blocked', blocked_reason = 'approval_revoked', closed_at = NEW.decided_at
    WHERE proposal_id = NEW.proposal_id AND state = 'reserved';
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_execution_revocation AFTER INSERT ON itervane.operations_decisions
FOR EACH ROW WHEN (NEW.action = 'revoke') EXECUTE FUNCTION itervane.release_operations_reservation_on_revocation();
--> statement-breakpoint
CREATE FUNCTION itervane.guard_release_against_operations_hold() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM itervane.environments WHERE id = NEW.environment_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM itervane.operations_executions WHERE environment_id = NEW.environment_id AND state = 'reserved') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'release_environment_reserved_by_operations';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER release_operation_operations_hold BEFORE INSERT ON itervane.release_operations
FOR EACH ROW EXECUTE FUNCTION itervane.guard_release_against_operations_hold();
