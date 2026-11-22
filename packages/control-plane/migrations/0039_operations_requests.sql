CREATE TABLE "itervane"."operations_requests" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"release_operation_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_request_binding" CHECK (("itervane"."operations_requests"."sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."operations_requests"."document"->>'version' = '1'
    AND "itervane"."operations_requests"."document"->>'projectId' = "itervane"."operations_requests"."project_id"::text AND "itervane"."operations_requests"."document"->>'applicationId' = "itervane"."operations_requests"."application_id"::text
    AND "itervane"."operations_requests"."document"->>'environmentId' = "itervane"."operations_requests"."environment_id"::text AND "itervane"."operations_requests"."document"->>'releaseOperationId' = "itervane"."operations_requests"."release_operation_id"::text
    AND octet_length("itervane"."operations_requests"."document"::text) <= 4096) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."operations_requests" ADD CONSTRAINT "operations_requests_release_operation_id_release_operations_id_fk" FOREIGN KEY ("release_operation_id") REFERENCES "itervane"."release_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_requests" ADD CONSTRAINT "operations_request_run_task" FOREIGN KEY ("run_id","task_id") REFERENCES "itervane"."task_runs"("id","task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_requests" ADD CONSTRAINT "operations_request_task_project" FOREIGN KEY ("task_id","project_id") REFERENCES "itervane"."tasks"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_requests" ADD CONSTRAINT "operations_request_environment" FOREIGN KEY ("environment_id","project_id","application_id") REFERENCES "itervane"."environments"("id","project_id","application_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_request() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_request_is_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.task_runs run_row
      JOIN itervane.tasks task_row ON task_row.id = run_row.task_id
      JOIN itervane.release_operations release_row ON release_row.id = NEW.release_operation_id
      JOIN itervane.release_candidates candidate ON candidate.id = release_row.candidate_id
      JOIN itervane.operations_targets binding ON binding.environment_id = NEW.environment_id
    WHERE run_row.id = NEW.run_id AND task_row.id = NEW.task_id AND task_row.project_id = NEW.project_id
      AND run_row.role = 'operations' AND run_row.state = 'queued' AND task_row.state = 'queued'
      AND task_row.generation = run_row.generation AND release_row.state = 'verified_formal'
      AND release_row.environment_id = NEW.environment_id AND candidate.project_id = NEW.project_id
      AND candidate.application_id = NEW.application_id AND candidate.task_id::text = NEW.document->>'releaseTaskId'
      AND task_row.repository_id::text = NEW.document#>>'{source,repositoryId}'
      AND task_row.commit = NEW.document#>>'{source,commit}' AND task_row.data_class = NEW.document->>'dataClass'
      AND binding.revision::text = NEW.document->>'enrollmentRevision' AND binding.sha256 = NEW.document->>'enrollmentSha256'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_request_scope_required';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_request_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.operations_requests
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_request();
