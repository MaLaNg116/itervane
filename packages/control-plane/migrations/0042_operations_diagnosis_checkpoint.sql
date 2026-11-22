CREATE TABLE "itervane"."operations_diagnosis_runtime" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"input_sha256" text NOT NULL,
	"checkpoint_id" text NOT NULL,
	"checkpoint_step" integer NOT NULL,
	"published_fence" integer NOT NULL,
	"worker_id" uuid NOT NULL,
	CONSTRAINT "operations_diagnosis_runtime_binding" CHECK ("itervane"."operations_diagnosis_runtime"."input_sha256" ~ '^[a-f0-9]{64}$'
  AND char_length("itervane"."operations_diagnosis_runtime"."checkpoint_id") BETWEEN 1 AND 128 AND "itervane"."operations_diagnosis_runtime"."checkpoint_step" >= -1 AND "itervane"."operations_diagnosis_runtime"."published_fence" > 0)
);
--> statement-breakpoint
ALTER TABLE "itervane"."checkpoint_write_receipts" DROP CONSTRAINT "checkpoint_write_graph";--> statement-breakpoint
ALTER TABLE "itervane"."operations_diagnosis_runtime" ADD CONSTRAINT "operations_diagnosis_runtime_run_id_operations_diagnosis_inputs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."operations_diagnosis_inputs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."checkpoint_write_receipts" ADD CONSTRAINT "checkpoint_write_graph" CHECK ("itervane"."checkpoint_write_receipts"."graph" IN ('preflight', 'audit', 'repair', 'verify', 'operations'));
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_diagnosis_pointer() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_diagnosis_pointer_is_retained';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    ROW(NEW.run_id, NEW.input_sha256) IS DISTINCT FROM ROW(OLD.run_id, OLD.input_sha256)
    OR NEW.checkpoint_id = OLD.checkpoint_id OR NEW.checkpoint_step <= OLD.checkpoint_step
    OR NEW.published_fence < OLD.published_fence
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_diagnosis_pointer_regression';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.operations_diagnosis_inputs input
      JOIN itervane.operations_requests request ON request.run_id = input.run_id
      JOIN itervane.task_runs run_row ON run_row.id = request.run_id AND run_row.task_id = request.task_id
      JOIN itervane.tasks task_row ON task_row.id = request.task_id AND task_row.generation = run_row.generation
      JOIN itervane.execution_slot slot ON slot.id = 1 AND slot.task_id = request.task_id AND slot.run_id = request.run_id
      JOIN itervane.operations_targets binding ON binding.environment_id = request.environment_id
    WHERE input.run_id = NEW.run_id AND input.input_sha256 = NEW.input_sha256
      AND run_row.role = 'operations' AND run_row.state = 'running' AND task_row.state = 'running'
      AND slot.worker_id = NEW.worker_id AND slot.fence = NEW.published_fence AND slot.lease_until > clock_timestamp()
      AND binding.revision::text = request.document->>'enrollmentRevision' AND binding.sha256 = request.document->>'enrollmentSha256'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_diagnosis_pointer_lease_required';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_diagnosis_pointer_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.operations_diagnosis_runtime
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_diagnosis_pointer();
