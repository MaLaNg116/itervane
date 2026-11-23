CREATE TABLE "itervane"."operations_repair_admissions" (
	"proposal_id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"request_sha256" text NOT NULL,
	"source_commit" text NOT NULL,
	"self_confirmed" boolean NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operations_repair_admission_per_task" UNIQUE("task_id"),
	CONSTRAINT "operations_repair_admission_binding" CHECK ("itervane"."operations_repair_admissions"."request_sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."operations_repair_admissions"."source_commit" ~ '^([a-f0-9]{40}|[a-f0-9]{64})$')
);
--> statement-breakpoint
ALTER TABLE "itervane"."operations_repair_admissions" ADD CONSTRAINT "operations_repair_admissions_proposal_id_operations_repair_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "itervane"."operations_repair_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_repair_admissions" ADD CONSTRAINT "operations_repair_admissions_actor_id_principals_id_fk" FOREIGN KEY ("actor_id") REFERENCES "itervane"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_repair_admissions" ADD CONSTRAINT "operations_repair_admission_task_fk" FOREIGN KEY ("run_id","task_id") REFERENCES "itervane"."task_runs"("id","task_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_repair_admission() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_repair_admission_is_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.operations_repair_proposals proposal
      JOIN itervane.operations_requests request ON request.run_id = proposal.diagnosis_run_id
      JOIN itervane.tasks task_row ON task_row.id = NEW.task_id AND task_row.project_id = request.project_id
      JOIN itervane.task_runs run_row ON run_row.id = NEW.run_id AND run_row.task_id = task_row.id
      JOIN itervane.projects project ON project.id = task_row.project_id
      JOIN itervane.workspace_members owner_grant ON owner_grant.workspace_id = project.workspace_id
        AND owner_grant.principal_id = NEW.actor_id AND owner_grant.grant_id = NEW.grant_id
    WHERE proposal.id = NEW.proposal_id AND run_row.generation = 1 AND run_row.role = 'audit' AND task_row.state = 'queued'
      AND task_row.requested_by = NEW.actor_id AND task_row.request_hash = NEW.request_sha256
      AND task_row.repository_id::text = proposal.document#>>'{source,git,repositoryId}'
      AND task_row.data_class = proposal.document#>>'{source,dataClass}' AND task_row.commit = NEW.source_commit
      AND (proposal.document#>>'{source,patchSha256}' IS NULL) = (NEW.source_commit = proposal.document#>>'{source,git,commit}')
      AND NEW.self_confirmed = (proposal.proposed_by = NEW.actor_id)
      AND proposal.created_at <= NEW.confirmed_at AND proposal.valid_until > clock_timestamp()
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_repair_admission_basis';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_repair_admission_guard BEFORE INSERT OR UPDATE OR DELETE ON itervane.operations_repair_admissions
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_repair_admission();
