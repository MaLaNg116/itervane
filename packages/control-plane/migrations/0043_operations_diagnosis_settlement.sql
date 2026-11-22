CREATE TABLE "itervane"."operations_diagnosis_results" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"worker_id" uuid NOT NULL,
	"fence" integer NOT NULL,
	"checkpoint_id" text NOT NULL,
	"sha256" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_diagnosis_result_binding" CHECK (("itervane"."operations_diagnosis_results"."fence" > 0 AND "itervane"."operations_diagnosis_results"."sha256" ~ '^[a-f0-9]{64}$'
  AND "itervane"."operations_diagnosis_results"."document"->>'version' = '1' AND "itervane"."operations_diagnosis_results"."document"->>'runId' = "itervane"."operations_diagnosis_results"."run_id"::text AND "itervane"."operations_diagnosis_results"."document"->>'fence' = "itervane"."operations_diagnosis_results"."fence"::text
  AND "itervane"."operations_diagnosis_results"."document"->>'checkpointId' = "itervane"."operations_diagnosis_results"."checkpoint_id" AND "itervane"."operations_diagnosis_results"."document"->>'observationSha256' ~ '^[a-f0-9]{64}$'
  AND octet_length("itervane"."operations_diagnosis_results"."document"::text) <= 8192) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."operations_diagnosis_results" ADD CONSTRAINT "operations_diagnosis_results_run_id_operations_diagnosis_runtime_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."operations_diagnosis_runtime"("run_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_diagnosis_result() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_diagnosis_result_is_immutable';
  END IF;
  IF jsonb_typeof(NEW.document->'reads') IS DISTINCT FROM 'array'
    OR NOT EXISTS (
      SELECT 1 FROM itervane.operations_diagnosis_runtime pointer
        JOIN itervane.operations_diagnosis_inputs input ON input.run_id = pointer.run_id AND input.input_sha256 = pointer.input_sha256
        JOIN itervane.operations_requests request ON request.run_id = input.run_id
        JOIN itervane.task_runs run_row ON run_row.id = request.run_id AND run_row.task_id = request.task_id
        JOIN itervane.tasks task_row ON task_row.id = request.task_id AND task_row.generation = run_row.generation
        JOIN itervane.execution_slot slot ON slot.id = 1 AND slot.task_id = request.task_id AND slot.run_id = request.run_id
        JOIN itervane.run_runtime runtime ON runtime.run_id = request.run_id AND runtime.task_id = request.task_id
        JOIN itervane.operations_targets binding ON binding.environment_id = request.environment_id
      WHERE pointer.run_id = NEW.run_id AND pointer.checkpoint_id = NEW.checkpoint_id AND pointer.published_fence <= NEW.fence
        AND input.input_sha256 = NEW.document->>'inputSha256' AND input.provider_sha256 = NEW.document->>'providerSha256'
        AND request.sha256 = NEW.document->>'requestSha256' AND request.task_id::text = NEW.document->>'taskId'
        AND run_row.role = 'operations' AND run_row.state = 'running' AND task_row.state = 'running'
        AND slot.worker_id = NEW.worker_id AND slot.fence = NEW.fence AND slot.lease_until > clock_timestamp()
        AND binding.revision::text = request.document->>'enrollmentRevision' AND binding.sha256 = request.document->>'enrollmentSha256'
        AND runtime.tools_used BETWEEN 2 AND runtime.max_tools
        AND runtime.tools_used = jsonb_array_length(NEW.document->'reads')
        AND runtime.tools_used = (SELECT count(*) FROM itervane.operations_diagnosis_reads WHERE run_id = NEW.run_id)
        AND NOT EXISTS (
          SELECT 1 FROM itervane.operations_diagnosis_reads evidence
          WHERE evidence.run_id = NEW.run_id AND (evidence.state <> 'recorded' OR NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(NEW.document->'reads') AS claimed(value)
            WHERE claimed.value->>'section' = evidence.section AND claimed.value->>'operationId' = evidence.operation_id
              AND claimed.value->>'readSha256' = evidence.sha256
          ))
        )
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_diagnosis_result_authority_or_evidence';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_diagnosis_result_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.operations_diagnosis_results
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_diagnosis_result();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION itervane.require_legacy_observation_mode() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM itervane.operations_diagnosis_inputs WHERE run_id = NEW.run_id)
    AND NOT EXISTS (
      SELECT 1 FROM itervane.operations_diagnosis_results result
        JOIN itervane.operations_diagnosis_reads evidence ON evidence.run_id = result.run_id AND evidence.section = 'container'
      WHERE result.run_id = NEW.run_id AND result.fence = NEW.fence AND result.worker_id = NEW.worker_id
        AND result.document->>'observationSha256' = NEW.sha256 AND evidence.state = 'recorded'
        AND evidence.document->'result' = NEW.document->'observation'
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_diagnosis_settlement_required';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION itervane.require_operations_diagnosis_completion() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM itervane.operations_requests request
      JOIN itervane.task_runs run_row ON run_row.id = request.run_id AND run_row.task_id = request.task_id
      JOIN itervane.tasks task_row ON task_row.id = request.task_id AND task_row.generation = run_row.generation
      JOIN itervane.operations_diagnosis_runtime pointer ON pointer.run_id = run_row.id AND pointer.checkpoint_id = NEW.checkpoint_id
      JOIN itervane.operations_observations observation ON observation.run_id = pointer.run_id AND observation.fence = NEW.fence
        AND observation.worker_id = NEW.worker_id AND observation.sha256 = NEW.document->>'observationSha256'
      JOIN itervane.task_events event ON event.task_id = task_row.id AND event.sequence = task_row.version
    WHERE request.run_id = NEW.run_id AND run_row.state = 'succeeded' AND task_row.state = 'succeeded'
      AND event.type = 'task.operations_observed' AND event.state = 'succeeded' AND event.worker_id = NEW.worker_id
      AND event.detail->>'diagnosisSha256' = NEW.sha256 AND event.detail->>'observationSha256' = observation.sha256
      AND NOT EXISTS (SELECT 1 FROM itervane.execution_slot WHERE id = 1 AND run_id = NEW.run_id)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_diagnosis_completion_required';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER operations_diagnosis_completion AFTER INSERT ON itervane.operations_diagnosis_results
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION itervane.require_operations_diagnosis_completion();
