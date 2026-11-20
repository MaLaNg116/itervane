CREATE TABLE "itervane"."inspection_attempts" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"commit" text NOT NULL,
	"generation" integer NOT NULL,
	"fence" integer NOT NULL,
	"worker_id" uuid NOT NULL,
	"plan_sha256" text NOT NULL,
	"origin_sha256" text NOT NULL,
	"image_sha256" text NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"settled_fence" integer,
	"settled_at" timestamp with time zone,
	"receipt_sha256" text,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inspection_attempt_per_fence" UNIQUE("run_id","fence"),
	CONSTRAINT "inspection_attempt_coordinates" CHECK (
    "itervane"."inspection_attempts"."generation" > 0 AND "itervane"."inspection_attempts"."fence" > 0 AND "itervane"."inspection_attempts"."commit" ~ '^[a-f0-9]{40}$'
    AND "itervane"."inspection_attempts"."plan_sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."inspection_attempts"."origin_sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."inspection_attempts"."image_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "inspection_attempt_state" CHECK ((
    ("itervane"."inspection_attempts"."state" = 'reserved' AND "itervane"."inspection_attempts"."settled_fence" IS NULL AND "itervane"."inspection_attempts"."settled_at" IS NULL)
    OR ("itervane"."inspection_attempts"."state" IN ('closed', 'uncertain', 'recorded') AND "itervane"."inspection_attempts"."settled_fence" >= "itervane"."inspection_attempts"."fence" AND "itervane"."inspection_attempts"."settled_at" IS NOT NULL)
  ) IS TRUE),
	CONSTRAINT "inspection_attempt_receipt_binding" CHECK ((
    ("itervane"."inspection_attempts"."state" <> 'recorded' AND "itervane"."inspection_attempts"."receipt" IS NULL AND "itervane"."inspection_attempts"."receipt_sha256" IS NULL)
    OR ("itervane"."inspection_attempts"."state" = 'recorded' AND "itervane"."inspection_attempts"."settled_fence" = "itervane"."inspection_attempts"."fence" AND "itervane"."inspection_attempts"."receipt_sha256" ~ '^[a-f0-9]{64}$'
      AND octet_length("itervane"."inspection_attempts"."receipt"::text) <= 4202496
      AND "itervane"."inspection_attempts"."receipt"->>'kind' = 'receipt' AND "itervane"."inspection_attempts"."receipt"->'cleanupConfirmed' = 'true'::jsonb
      AND "itervane"."inspection_attempts"."receipt"->'sessionVerified' = 'true'::jsonb AND "itervane"."inspection_attempts"."receipt"->>'originSha256' = "itervane"."inspection_attempts"."origin_sha256"
      AND "itervane"."inspection_attempts"."receipt"->>'imageSha256' = "itervane"."inspection_attempts"."image_sha256"
      AND "itervane"."inspection_attempts"."receipt"#>>'{scope,requestId}' = "itervane"."inspection_attempts"."request_id"::text
      AND "itervane"."inspection_attempts"."receipt"#>>'{scope,taskId}' = "itervane"."inspection_attempts"."task_id"::text AND "itervane"."inspection_attempts"."receipt"#>>'{scope,runId}' = "itervane"."inspection_attempts"."run_id"::text
      AND "itervane"."inspection_attempts"."receipt"#>>'{scope,projectId}' = "itervane"."inspection_attempts"."project_id"::text AND "itervane"."inspection_attempts"."receipt"#>>'{scope,repositoryId}' = "itervane"."inspection_attempts"."repository_id"::text
      AND "itervane"."inspection_attempts"."receipt"#>>'{scope,commit}' = "itervane"."inspection_attempts"."commit" AND "itervane"."inspection_attempts"."receipt"#>>'{scope,planSha256}' = "itervane"."inspection_attempts"."plan_sha256"
      AND "itervane"."inspection_attempts"."receipt"#>>'{scope,fence}' = "itervane"."inspection_attempts"."fence"::text AND "itervane"."inspection_attempts"."receipt"#>>'{scope,generation}' = "itervane"."inspection_attempts"."generation"::text
      AND "itervane"."inspection_attempts"."receipt"->>'domainId' = "itervane"."inspection_attempts"."receipt"#>>'{snapshot,runId}'
      AND "itervane"."inspection_attempts"."receipt"#>>'{snapshot,repositoryId}' = "itervane"."inspection_attempts"."repository_id"::text AND "itervane"."inspection_attempts"."receipt"#>>'{snapshot,commit}' = "itervane"."inspection_attempts"."commit"
      AND "itervane"."inspection_attempts"."receipt"#>'{snapshot,offline}' = 'true'::jsonb AND "itervane"."inspection_attempts"."receipt"#>'{snapshot,readOnly}' = 'true'::jsonb)
  ) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."inspection_attempts" ADD CONSTRAINT "inspection_attempts_run_id_inspection_plans_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."inspection_plans"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."inspection_attempts" ADD CONSTRAINT "inspection_attempt_run_task" FOREIGN KEY ("run_id","task_id") REFERENCES "itervane"."task_runs"("id","task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."inspection_attempts" ADD CONSTRAINT "inspection_attempt_task_project" FOREIGN KEY ("task_id","project_id") REFERENCES "itervane"."tasks"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."inspection_attempts" ADD CONSTRAINT "inspection_attempt_repository_project" FOREIGN KEY ("repository_id","project_id") REFERENCES "itervane"."repositories"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inspection_open_attempt_per_run" ON "itervane"."inspection_attempts" USING btree ("run_id") WHERE "itervane"."inspection_attempts"."state" <> 'closed';
--> statement-breakpoint
CREATE FUNCTION itervane.guard_inspection_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inspection_attempt_is_retained';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'reserved' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inspection_attempt_not_reserved';
    END IF;
  ELSE
    IF (NEW.request_id, NEW.task_id, NEW.project_id, NEW.run_id, NEW.repository_id, NEW."commit",
        NEW.generation, NEW.fence, NEW.worker_id, NEW.plan_sha256, NEW.origin_sha256, NEW.image_sha256, NEW.created_at)
      IS DISTINCT FROM
       (OLD.request_id, OLD.task_id, OLD.project_id, OLD.run_id, OLD.repository_id, OLD."commit",
        OLD.generation, OLD.fence, OLD.worker_id, OLD.plan_sha256, OLD.origin_sha256, OLD.image_sha256, OLD.created_at) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inspection_attempt_binding_is_immutable';
    END IF;
    IF NOT ((OLD.state = 'reserved' AND NEW.state IN ('closed', 'uncertain', 'recorded'))
        OR (OLD.state = 'uncertain' AND NEW.state = 'closed')) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inspection_attempt_transition_rejected';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM itervane.execution_slot slot
    JOIN itervane.tasks task ON task.id = slot.task_id
    JOIN itervane.task_runs run ON run.id = slot.run_id AND run.task_id = task.id
    JOIN itervane.inspection_plans plan ON plan.run_id = run.id AND plan.task_id = task.id
    JOIN itervane.repositories repo ON repo.id = task.repository_id AND repo.project_id = task.project_id
    WHERE slot.id = 1 AND slot.task_id = NEW.task_id AND slot.run_id = NEW.run_id
      AND slot.lease_until > pg_catalog.clock_timestamp() AND task.generation = NEW.generation
      AND run.generation = NEW.generation AND task.project_id = NEW.project_id
      AND task.repository_id = NEW.repository_id AND task."commit" = NEW."commit"
      AND plan.sha256 = NEW.plan_sha256
      AND NEW.origin_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(repo.url, 'UTF8')), 'hex')
      AND (
        (NEW.state IN ('reserved', 'recorded') AND task.state = 'running' AND slot.fence = NEW.fence AND slot.worker_id = NEW.worker_id)
        OR (NEW.state IN ('closed', 'uncertain') AND task.state IN ('running', 'cancel_requested') AND slot.fence = NEW.settled_fence)
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inspection_attempt_authority_lost';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER inspection_attempt_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.inspection_attempts
FOR EACH ROW EXECUTE FUNCTION itervane.guard_inspection_attempt();
