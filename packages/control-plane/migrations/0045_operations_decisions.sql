CREATE TABLE "itervane"."operations_decisions" (
	"proposal_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"actor_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"action" text NOT NULL,
	"self_confirmed" boolean NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operations_decisions_proposal_id_version_pk" PRIMARY KEY("proposal_id","version"),
	CONSTRAINT "operations_decision_request" UNIQUE("proposal_id","actor_id","idempotency_key"),
	CONSTRAINT "operations_decision_action_version" CHECK (("itervane"."operations_decisions"."version" = 1 AND "itervane"."operations_decisions"."action" IN ('confirm', 'reject'))
    OR ("itervane"."operations_decisions"."version" = 2 AND "itervane"."operations_decisions"."action" = 'revoke')),
	CONSTRAINT "operations_decision_self_confirmed" CHECK (NOT "itervane"."operations_decisions"."self_confirmed" OR "itervane"."operations_decisions"."action" = 'confirm')
);
--> statement-breakpoint
ALTER TABLE "itervane"."operations_decisions" ADD CONSTRAINT "operations_decisions_proposal_id_operations_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "itervane"."operations_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_decisions" ADD CONSTRAINT "operations_decisions_actor_id_principals_id_fk" FOREIGN KEY ("actor_id") REFERENCES "itervane"."principals"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_decision() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_decision_is_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.operations_proposals proposal
      JOIN itervane.operations_requests request ON request.run_id = proposal.diagnosis_run_id
      JOIN itervane.projects project ON project.id = request.project_id
      JOIN itervane.workspace_members owner_grant ON owner_grant.workspace_id = project.workspace_id
        AND owner_grant.principal_id = NEW.actor_id AND owner_grant.grant_id = NEW.grant_id
    WHERE proposal.id = NEW.proposal_id AND NEW.decided_at BETWEEN proposal.created_at AND clock_timestamp()
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
      AND request.release_operation_id = (
        SELECT id FROM itervane.release_operations
        WHERE environment_id = proposal.environment_id AND state = 'verified_formal' ORDER BY updated_at DESC, id DESC LIMIT 1
      )
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
CREATE TRIGGER operations_decision_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.operations_decisions
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_decision();
