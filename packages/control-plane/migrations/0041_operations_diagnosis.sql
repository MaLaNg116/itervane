CREATE TABLE "itervane"."operations_diagnosis_inputs" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"input_sha256" text NOT NULL,
	"provider_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_diagnosis_fingerprints" CHECK ("itervane"."operations_diagnosis_inputs"."input_sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."operations_diagnosis_inputs"."provider_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "itervane"."operations_diagnosis_reads" (
	"run_id" uuid NOT NULL,
	"section" text NOT NULL,
	"operation_id" text NOT NULL,
	"worker_id" uuid NOT NULL,
	"fence" integer NOT NULL,
	"attempts" integer NOT NULL,
	"state" text NOT NULL,
	"sha256" text,
	"document" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_at" timestamp with time zone,
	CONSTRAINT "operations_diagnosis_reads_run_id_section_pk" PRIMARY KEY("run_id","section"),
	CONSTRAINT "operations_diagnosis_operation_per_run" UNIQUE("run_id","operation_id"),
	CONSTRAINT "operations_diagnosis_read_shape" CHECK (("itervane"."operations_diagnosis_reads"."section" IN ('container', 'release', 'logs', 'metrics') AND "itervane"."operations_diagnosis_reads"."fence" > 0
    AND "itervane"."operations_diagnosis_reads"."attempts" BETWEEN 1 AND 2 AND "itervane"."operations_diagnosis_reads"."operation_id" ~ '^[a-f0-9]{64}$'
    AND (("itervane"."operations_diagnosis_reads"."state" = 'reserved' AND "itervane"."operations_diagnosis_reads"."document" IS NULL AND "itervane"."operations_diagnosis_reads"."sha256" IS NULL AND "itervane"."operations_diagnosis_reads"."recorded_at" IS NULL)
      OR ("itervane"."operations_diagnosis_reads"."state" = 'recorded' AND "itervane"."operations_diagnosis_reads"."document"->>'kind' = 'operations_section' AND "itervane"."operations_diagnosis_reads"."document"->>'section' = "itervane"."operations_diagnosis_reads"."section"
        AND "itervane"."operations_diagnosis_reads"."document"->>'proofSha256' ~ '^[a-f0-9]{64}$' AND "itervane"."operations_diagnosis_reads"."sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."operations_diagnosis_reads"."recorded_at" >= "itervane"."operations_diagnosis_reads"."created_at"
        AND octet_length("itervane"."operations_diagnosis_reads"."document"::text) <= 4096))) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."operations_diagnosis_inputs" ADD CONSTRAINT "operations_diagnosis_inputs_run_id_operations_requests_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."operations_requests"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_diagnosis_reads" ADD CONSTRAINT "operations_diagnosis_reads_run_id_operations_diagnosis_inputs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."operations_diagnosis_inputs"("run_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_diagnosis_input() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_diagnosis_input_is_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.operations_requests request
      JOIN itervane.task_runs run_row ON run_row.id = request.run_id AND run_row.task_id = request.task_id
      JOIN itervane.tasks task_row ON task_row.id = request.task_id AND task_row.generation = run_row.generation
      JOIN itervane.run_runtime runtime ON runtime.run_id = request.run_id AND runtime.task_id = request.task_id
    WHERE request.run_id = NEW.run_id AND run_row.role = 'operations'
      AND run_row.state = 'queued' AND task_row.state = 'queued' AND runtime.max_tools = 4 AND runtime.tools_used = 0
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_diagnosis_admission_required';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_diagnosis_input_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.operations_diagnosis_inputs
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_diagnosis_input();
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_diagnosis_read() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_diagnosis_read_is_immutable';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.state = 'recorded' OR ROW(NEW.run_id, NEW.section, NEW.operation_id, NEW.created_at)
        IS DISTINCT FROM ROW(OLD.run_id, OLD.section, OLD.operation_id, OLD.created_at) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_diagnosis_read_is_immutable';
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.operations_diagnosis_inputs input
      JOIN itervane.operations_requests request ON request.run_id = input.run_id
      JOIN itervane.task_runs run_row ON run_row.id = request.run_id AND run_row.task_id = request.task_id
      JOIN itervane.tasks task_row ON task_row.id = request.task_id AND task_row.generation = run_row.generation
      JOIN itervane.run_runtime runtime ON runtime.run_id = request.run_id AND runtime.task_id = request.task_id
      JOIN itervane.execution_slot slot ON slot.id = 1 AND slot.task_id = request.task_id AND slot.run_id = request.run_id
      JOIN itervane.operations_targets binding ON binding.environment_id = request.environment_id
    WHERE input.run_id = NEW.run_id AND run_row.role = 'operations'
      AND run_row.state = 'running' AND task_row.state = 'running'
      AND slot.worker_id = NEW.worker_id AND slot.fence = NEW.fence AND slot.lease_until > clock_timestamp()
      AND binding.revision::text = request.document->>'enrollmentRevision' AND binding.sha256 = request.document->>'enrollmentSha256'
      AND runtime.max_tools = 4 AND runtime.tools_used BETWEEN 1 AND runtime.max_tools
      AND runtime.tools_used = (SELECT count(*) FROM itervane.operations_diagnosis_reads WHERE run_id = NEW.run_id)
        + CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE 0 END
      AND (NEW.state = 'reserved' OR CASE WHEN NEW.section = 'release' THEN
          NEW.document#>>'{result,current,operationId}' = request.release_operation_id::text
          AND NEW.document#>>'{result,current,manifestDigest}' = request.document->>'manifestDigest'
        ELSE NEW.document#>>'{result,containerId}' = request.document->>'containerId'
          AND NEW.document#>>'{result,serverId}' = binding.document#>>'{whiskers,serverId}' END)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_diagnosis_read_lease_required';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state = 'reserved' AND NEW.attempts = 1 THEN RETURN NEW; END IF;
  ELSIF (NEW.state = 'reserved' AND NEW.fence > OLD.fence AND NEW.attempts = OLD.attempts + 1)
    OR (NEW.state = 'recorded' AND NEW.fence = OLD.fence AND NEW.worker_id = OLD.worker_id AND NEW.attempts = OLD.attempts) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_diagnosis_read_transition';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_diagnosis_read_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.operations_diagnosis_reads
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_diagnosis_read();
--> statement-breakpoint
CREATE FUNCTION itervane.require_legacy_observation_mode() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM itervane.operations_diagnosis_inputs WHERE run_id = NEW.run_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_diagnosis_settlement_required';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_observation_mode BEFORE INSERT ON itervane.operations_observations
FOR EACH ROW EXECUTE FUNCTION itervane.require_legacy_observation_mode();
