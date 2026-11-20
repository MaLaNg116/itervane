CREATE TABLE "itervane"."formal_repair_runtime" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"input_sha256" text NOT NULL,
	"checkpoint_id" text NOT NULL,
	"checkpoint_step" integer NOT NULL,
	"published_fence" integer NOT NULL,
	"worker_id" uuid NOT NULL,
	CONSTRAINT "formal_repair_runtime_binding" CHECK ("itervane"."formal_repair_runtime"."input_sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."formal_repair_runtime"."checkpoint_step" >= -1 AND "itervane"."formal_repair_runtime"."published_fence" > 0)
);
--> statement-breakpoint
ALTER TABLE "itervane"."checkpoint_write_receipts" DROP CONSTRAINT "checkpoint_write_graph";--> statement-breakpoint
ALTER TABLE "itervane"."formal_repair_runtime" ADD CONSTRAINT "formal_repair_runtime_run_id_formal_repair_inputs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."formal_repair_inputs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."checkpoint_write_receipts" ADD CONSTRAINT "checkpoint_write_graph" CHECK ("itervane"."checkpoint_write_receipts"."graph" IN ('preflight', 'audit', 'repair'));
--> statement-breakpoint
CREATE FUNCTION itervane.guard_formal_repair_pointer() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_repair_pointer_is_retained';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    (NEW.run_id, NEW.input_sha256) IS DISTINCT FROM (OLD.run_id, OLD.input_sha256)
    OR NEW.checkpoint_step <= OLD.checkpoint_step
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_repair_pointer_regression';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.execution_slot slot
    JOIN itervane.formal_repair_inputs input ON input.run_id = slot.run_id
    JOIN itervane.tasks task ON task.id = slot.task_id
    JOIN itervane.task_runs run ON run.id = slot.run_id AND run.task_id = task.id
    WHERE slot.id = 1 AND slot.run_id = NEW.run_id AND slot.fence = NEW.published_fence AND slot.worker_id = NEW.worker_id
      AND slot.lease_until > pg_catalog.clock_timestamp() AND task.state = 'running' AND run.generation = task.generation
      AND input.sha256 = NEW.input_sha256 AND input.document->>'generation' = task.generation::text
      AND input.document->>'taskId' = task.id::text AND input.document->>'projectId' = task.project_id::text
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_repair_pointer_authority_lost';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_repair_pointer_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.formal_repair_runtime
FOR EACH ROW EXECUTE FUNCTION itervane.guard_formal_repair_pointer();
