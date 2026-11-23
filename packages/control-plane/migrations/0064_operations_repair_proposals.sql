CREATE TABLE "itervane"."operations_repair_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"diagnosis_run_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"release_operation_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"incident_id" uuid,
	"sample_sequence" bigint,
	"proposed_by" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	CONSTRAINT "operations_repair_proposal_per_diagnosis" UNIQUE("diagnosis_run_id"),
	CONSTRAINT "operations_repair_proposal_binding" CHECK (("itervane"."operations_repair_proposals"."fingerprint" ~ '^[a-f0-9]{64}$' AND "itervane"."operations_repair_proposals"."valid_until" > "itervane"."operations_repair_proposals"."created_at"
    AND "itervane"."operations_repair_proposals"."document"->>'version' = '1' AND "itervane"."operations_repair_proposals"."document"#>>'{diagnosis,runId}' = "itervane"."operations_repair_proposals"."diagnosis_run_id"::text
    AND "itervane"."operations_repair_proposals"."document"#>>'{target,environmentId}' = "itervane"."operations_repair_proposals"."environment_id"::text
    AND "itervane"."operations_repair_proposals"."document"#>>'{target,releaseOperationId}' = "itervane"."operations_repair_proposals"."release_operation_id"::text
    AND "itervane"."operations_repair_proposals"."document"#>>'{source,candidateId}' = "itervane"."operations_repair_proposals"."candidate_id"::text
    AND "itervane"."operations_repair_proposals"."document"->>'proposedBy' = "itervane"."operations_repair_proposals"."proposed_by"::text AND "itervane"."operations_repair_proposals"."document"->>'grantId' = "itervane"."operations_repair_proposals"."grant_id"::text
    AND (("itervane"."operations_repair_proposals"."incident_id" IS NULL AND "itervane"."operations_repair_proposals"."sample_sequence" IS NULL AND "itervane"."operations_repair_proposals"."document"->'incident' = 'null'::jsonb)
      OR ("itervane"."operations_repair_proposals"."incident_id" IS NOT NULL AND "itervane"."operations_repair_proposals"."sample_sequence" > 0 AND "itervane"."operations_repair_proposals"."document"#>>'{incident,id}' = "itervane"."operations_repair_proposals"."incident_id"::text
        AND "itervane"."operations_repair_proposals"."document"#>>'{incident,sampleSequence}' = "itervane"."operations_repair_proposals"."sample_sequence"::text))
    AND octet_length("itervane"."operations_repair_proposals"."document"::text) <= 8192) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."operations_repair_proposals" ADD CONSTRAINT "operations_repair_proposals_diagnosis_run_id_operations_diagnosis_results_run_id_fk" FOREIGN KEY ("diagnosis_run_id") REFERENCES "itervane"."operations_diagnosis_results"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_repair_proposals" ADD CONSTRAINT "operations_repair_proposals_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "itervane"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_repair_proposals" ADD CONSTRAINT "operations_repair_proposals_release_operation_id_release_operations_id_fk" FOREIGN KEY ("release_operation_id") REFERENCES "itervane"."release_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_repair_proposals" ADD CONSTRAINT "operations_repair_proposals_candidate_id_release_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "itervane"."release_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_repair_proposals" ADD CONSTRAINT "operations_repair_proposals_proposed_by_principals_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "itervane"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_repair_proposals" ADD CONSTRAINT "operations_repair_proposal_sample_fk" FOREIGN KEY ("sample_sequence","incident_id") REFERENCES "itervane"."operations_health_samples"("sequence","incident_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operations_repair_proposal_incident" ON "itervane"."operations_repair_proposals" USING btree ("incident_id");
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_repair_proposal() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_repair_proposal_is_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.operations_diagnosis_results diagnosis
      JOIN itervane.operations_requests request ON request.run_id = diagnosis.run_id
      JOIN itervane.tasks task_row ON task_row.id = request.task_id AND task_row.state = 'succeeded'
      JOIN itervane.release_operations release ON release.id = request.release_operation_id AND release.state = 'verified_formal'
      JOIN itervane.release_candidates candidate ON candidate.id = release.candidate_id AND candidate.project_id = request.project_id
        AND candidate.environment_id = request.environment_id
      JOIN LATERAL itervane.current_operations_publication(request.environment_id) publication
        ON publication.release_operation_id = release.id
      LEFT JOIN itervane.operations_incident_diagnoses trigger_row ON trigger_row.run_id = diagnosis.run_id
    WHERE diagnosis.run_id = NEW.diagnosis_run_id AND request.environment_id = NEW.environment_id
      AND release.id = NEW.release_operation_id AND candidate.id = NEW.candidate_id
      AND diagnosis.document#>>'{result,recommendation,code}' = 'investigate_code'
      AND diagnosis.sha256 = NEW.document#>>'{diagnosis,sha256}' AND task_row.id::text = NEW.document#>>'{diagnosis,taskId}'
      AND candidate.fingerprint = NEW.document#>>'{source,candidateSha256}'
      AND candidate.document->'source' = NEW.document#>'{source,git}'
      AND publication.restore_execution_id::text IS NOT DISTINCT FROM (NEW.document#>>'{target,restoreExecutionId}')
      AND trigger_row.incident_id IS NOT DISTINCT FROM NEW.incident_id
      AND trigger_row.sample_sequence IS NOT DISTINCT FROM NEW.sample_sequence
      AND NEW.valid_until > clock_timestamp()
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_repair_proposal_basis';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_repair_proposal_guard BEFORE INSERT OR UPDATE OR DELETE ON itervane.operations_repair_proposals
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_repair_proposal();
