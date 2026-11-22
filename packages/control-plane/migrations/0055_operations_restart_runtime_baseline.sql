ALTER TABLE "itervane"."operations_restart_requests" ADD COLUMN "runtime_baseline" jsonb;--> statement-breakpoint
ALTER TABLE "itervane"."operations_restart_requests" ADD COLUMN "runtime_baseline_sha256" text;--> statement-breakpoint
ALTER TABLE "itervane"."operations_restart_requests" ADD CONSTRAINT "operations_restart_baseline_binding" CHECK ((("itervane"."operations_restart_requests"."runtime_baseline" IS NULL AND "itervane"."operations_restart_requests"."runtime_baseline_sha256" IS NULL)
    OR (jsonb_typeof("itervane"."operations_restart_requests"."runtime_baseline") = 'object' AND octet_length("itervane"."operations_restart_requests"."runtime_baseline"::text) <= 2048
      AND "itervane"."operations_restart_requests"."runtime_baseline_sha256" ~ '^[a-f0-9]{64}$')) IS TRUE);
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_restart_runtime_baseline() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  stopped_start text := NEW.runtime_baseline->>'startedAt';
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.runtime_baseline, NEW.runtime_baseline_sha256) IS DISTINCT FROM ROW(OLD.runtime_baseline, OLD.runtime_baseline_sha256) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_baseline_is_immutable';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT (stopped_start ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{9}Z$'
      AND stopped_start > '1970-01-01T00:00:00.000999999Z'
      AND pg_input_is_valid(stopped_start, 'timestamp with time zone')) IS TRUE
    OR NOT (NEW.runtime_baseline->>'state' IN ('exited', 'dead')) IS TRUE
    OR NOT EXISTS (
      SELECT 1 FROM itervane.operations_executions execution
      JOIN itervane.operations_proposals proposal ON proposal.id = execution.proposal_id
      JOIN itervane.release_operations release ON release.id::text = proposal.document#>>'{target,releaseOperationId}'
        AND release.environment_id = execution.environment_id AND release.state = 'verified_formal'
      JOIN itervane.formal_release_rollout_attempts rollout ON rollout.operation_id = release.id AND rollout.state = 'verified'
      WHERE execution.id = NEW.execution_id
        AND NEW.runtime_baseline = jsonb_build_object(
          'containerId', proposal.document#>>'{target,containerId}', 'configDigest', proposal.document#>>'{target,configDigest}',
          'imageReference', rollout.proof#>>'{runtime,imageReference}', 'runtimeConfigSha256', rollout.proof#>>'{runtime,runtimeConfigSha256}',
          'network', rollout.proof#>>'{runtime,network}', 'state', NEW.runtime_baseline->>'state', 'startedAt', stopped_start
        )
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_baseline_runtime_required';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_restart_runtime_baseline BEFORE INSERT OR UPDATE ON itervane.operations_restart_requests
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_restart_runtime_baseline();
