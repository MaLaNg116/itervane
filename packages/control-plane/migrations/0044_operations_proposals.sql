CREATE TABLE "itervane"."operations_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"diagnosis_run_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"proposed_by" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	CONSTRAINT "operations_proposal_per_diagnosis" UNIQUE("diagnosis_run_id"),
	CONSTRAINT "operations_proposal_binding" CHECK (("itervane"."operations_proposals"."created_at" < "itervane"."operations_proposals"."valid_until" AND "itervane"."operations_proposals"."fingerprint" ~ '^[a-f0-9]{64}$'
    AND "itervane"."operations_proposals"."document"->>'version' = '1' AND "itervane"."operations_proposals"."document"#>>'{diagnosis,runId}' = "itervane"."operations_proposals"."diagnosis_run_id"::text
    AND "itervane"."operations_proposals"."document"#>>'{target,environmentId}' = "itervane"."operations_proposals"."environment_id"::text
    AND "itervane"."operations_proposals"."document"->>'proposedBy' = "itervane"."operations_proposals"."proposed_by"::text AND "itervane"."operations_proposals"."document"->>'grantId' = "itervane"."operations_proposals"."grant_id"::text
    AND "itervane"."operations_proposals"."document"#>>'{action,kind}' IN ('restart', 'rollback')
    AND "itervane"."operations_proposals"."document"->>'targetProofSha256' ~ '^[a-f0-9]{64}$' AND octet_length("itervane"."operations_proposals"."document"::text) <= 8192) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."operations_proposals" ADD CONSTRAINT "operations_proposals_diagnosis_run_id_operations_diagnosis_results_run_id_fk" FOREIGN KEY ("diagnosis_run_id") REFERENCES "itervane"."operations_diagnosis_results"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_proposals" ADD CONSTRAINT "operations_proposals_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "itervane"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_proposals" ADD CONSTRAINT "operations_proposals_proposed_by_principals_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "itervane"."principals"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_proposal() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_proposal_is_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.operations_diagnosis_results diagnosis
      JOIN itervane.operations_requests request ON request.run_id = diagnosis.run_id
      JOIN itervane.operations_observations observed ON observed.run_id = request.run_id
      JOIN itervane.task_runs run_row ON run_row.id = request.run_id AND run_row.task_id = request.task_id
      JOIN itervane.tasks task_row ON task_row.id = request.task_id AND task_row.generation = run_row.generation
      JOIN itervane.projects project ON project.id = request.project_id
      JOIN itervane.operations_targets binding ON binding.environment_id = request.environment_id
      JOIN itervane.formal_release_targets mapping ON mapping.environment_id = request.environment_id
      LEFT JOIN itervane.workspace_members owner_grant ON owner_grant.workspace_id = project.workspace_id
        AND owner_grant.principal_id = NEW.proposed_by
      LEFT JOIN itervane.project_members project_grant ON project_grant.project_id = project.id
        AND project_grant.principal_id = NEW.proposed_by AND project_grant.role = 'maintainer'
      LEFT JOIN itervane.workspace_members origin_owner ON origin_owner.workspace_id = project.workspace_id
        AND origin_owner.principal_id = task_row.requested_by
      LEFT JOIN itervane.project_members origin_member ON origin_member.project_id = project.id
        AND origin_member.principal_id = task_row.requested_by AND origin_member.role = 'maintainer'
    WHERE diagnosis.run_id = NEW.diagnosis_run_id AND diagnosis.sha256 = NEW.document#>>'{diagnosis,sha256}'
      AND request.task_id::text = NEW.document#>>'{diagnosis,taskId}'
      AND observed.document#>>'{observation,observedAt}' = NEW.document#>>'{diagnosis,observedAt}'
      AND request.environment_id = NEW.environment_id AND request.document = NEW.document->'target'
      AND run_row.role = 'operations' AND run_row.state = 'succeeded' AND task_row.state = 'succeeded'
      AND COALESCE(owner_grant.grant_id, project_grant.grant_id) = NEW.grant_id
      AND COALESCE(origin_owner.grant_id, origin_member.grant_id)::text = request.document->>'grantId'
      AND mapping.revision::text = request.document->>'targetRevision' AND mapping.sha256 = request.document->>'mappingSha256'
      AND binding.revision::text = request.document->>'enrollmentRevision' AND binding.sha256 = request.document->>'enrollmentSha256'
      AND NEW.created_at >= diagnosis.created_at AND NEW.created_at <= clock_timestamp()
      AND NEW.valid_until = (NEW.document->>'validUntil')::timestamptz AND NEW.valid_until > clock_timestamp()
      AND NEW.valid_until <= diagnosis.created_at + (mapping.document->>'approvalTtlSeconds')::integer * interval '1 second'
      AND request.release_operation_id = (
        SELECT id FROM itervane.release_operations
        WHERE environment_id = NEW.environment_id AND state = 'verified_formal' ORDER BY updated_at DESC, id DESC LIMIT 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM itervane.release_operations
        WHERE environment_id = NEW.environment_id AND state IN ('queued', 'dispatching', 'reconciling')
      )
      AND (
        (NEW.document#>>'{action,kind}' = 'restart' AND diagnosis.document#>>'{result,recommendation,code}' = 'review_restart'
          AND observed.document#>>'{observation,state}' IN ('exited', 'dead'))
        OR
        (NEW.document#>>'{action,kind}' = 'rollback' AND diagnosis.document#>>'{result,recommendation,code}' = 'review_rollback'
          AND observed.document#>>'{observation,state}' IN ('exited', 'dead')
          AND diagnosis.document#>>'{result,previousReleaseOperationId}' = NEW.document#>>'{action,restore,operationId}'
          AND EXISTS (
            SELECT 1 FROM itervane.release_operations previous
              JOIN itervane.release_candidates candidate ON candidate.id = previous.candidate_id
            WHERE previous.environment_id = NEW.environment_id AND previous.state = 'verified_formal'
              AND previous.id::text = NEW.document#>>'{action,restore,operationId}'
              AND candidate.document#>>'{target,mappingSha256}' = mapping.sha256
              AND candidate.document#>>'{image,manifestDigest}' = NEW.document#>>'{action,restore,manifestDigest}'
              AND candidate.document#>>'{image,configDigest}' = NEW.document#>>'{action,restore,configDigest}'
              AND candidate.document#>>'{image,manifestDigest}' <> request.document->>'manifestDigest'
          )
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_proposal_authority_or_evidence';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_proposal_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.operations_proposals
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_proposal();
