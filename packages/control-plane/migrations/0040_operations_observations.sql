CREATE TABLE "itervane"."operations_observations" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"worker_id" uuid NOT NULL,
	"fence" integer NOT NULL,
	"binding_sha256" text NOT NULL,
	"sha256" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_observation_binding" CHECK (("itervane"."operations_observations"."fence" > 0 AND "itervane"."operations_observations"."binding_sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."operations_observations"."sha256" ~ '^[a-f0-9]{64}$'
  AND "itervane"."operations_observations"."document"->>'version' = '1' AND "itervane"."operations_observations"."document"->>'runId' = "itervane"."operations_observations"."run_id"::text AND "itervane"."operations_observations"."document"->>'fence' = "itervane"."operations_observations"."fence"::text
  AND "itervane"."operations_observations"."document"->>'bindingSha256' = "itervane"."operations_observations"."binding_sha256" AND octet_length("itervane"."operations_observations"."document"::text) <= 4096) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."operations_observations" ADD CONSTRAINT "operations_observations_run_id_operations_requests_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."operations_requests"("run_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_observation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_observation_is_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.operations_requests request
      JOIN itervane.task_runs run_row ON run_row.id = request.run_id
      JOIN itervane.tasks task_row ON task_row.id = request.task_id
      JOIN itervane.run_runtime runtime ON runtime.run_id = request.run_id
      JOIN itervane.execution_slot slot ON slot.id = 1 AND slot.task_id = request.task_id AND slot.run_id = request.run_id
      JOIN itervane.operations_targets binding ON binding.environment_id = request.environment_id
    WHERE request.run_id = NEW.run_id AND request.sha256 = NEW.binding_sha256
      AND request.task_id::text = NEW.document->>'taskId' AND request.release_operation_id::text = NEW.document->>'releaseOperationId'
      AND request.document->>'containerId' = NEW.document#>>'{observation,containerId}'
      AND binding.document#>>'{whiskers,serverId}' = NEW.document#>>'{observation,serverId}'
      AND binding.revision::text = request.document->>'enrollmentRevision' AND binding.sha256 = request.document->>'enrollmentSha256'
      AND run_row.role = 'operations' AND run_row.generation = task_row.generation
      AND run_row.state = 'running' AND task_row.state = 'running'
      AND runtime.tools_used BETWEEN 1 AND runtime.max_tools
      AND slot.worker_id = NEW.worker_id AND slot.fence = NEW.fence AND slot.lease_until > clock_timestamp()
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_observation_lease_required';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_observation_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.operations_observations
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_observation();
--> statement-breakpoint
CREATE FUNCTION itervane.require_operations_observation_completion() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM itervane.operations_requests request
      JOIN itervane.task_runs run_row ON run_row.id = request.run_id
      JOIN itervane.tasks task_row ON task_row.id = request.task_id
      JOIN itervane.task_events event ON event.task_id = task_row.id AND event.sequence = task_row.version
    WHERE request.run_id = NEW.run_id AND run_row.state = 'succeeded' AND task_row.state = 'succeeded'
      AND event.type = 'task.operations_observed' AND event.state = 'succeeded' AND event.worker_id = NEW.worker_id
      AND event.detail->>'observationSha256' = NEW.sha256 AND event.detail->>'fence' = NEW.fence::text
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_observation_completion_required';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER operations_observation_completion AFTER INSERT ON itervane.operations_observations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION itervane.require_operations_observation_completion();
