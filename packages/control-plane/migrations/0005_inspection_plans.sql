CREATE TABLE "itervane"."inspection_plans" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"prepared_fence" integer NOT NULL,
	"sha256" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inspection_plan_binding" CHECK (("itervane"."inspection_plans"."prepared_fence" > 0 AND "itervane"."inspection_plans"."sha256" ~ '^[a-f0-9]{64}$'
  AND "itervane"."inspection_plans"."document"->>'taskId' = "itervane"."inspection_plans"."task_id"::text AND "itervane"."inspection_plans"."document"->>'runId' = "itervane"."inspection_plans"."run_id"::text AND "itervane"."inspection_plans"."document"->>'version' = '1') IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."inspection_plans" ADD CONSTRAINT "inspection_plans_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "itervane"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."task_runs" ADD CONSTRAINT "task_run_task_pair" UNIQUE("id","task_id");
--> statement-breakpoint
ALTER TABLE "itervane"."inspection_plans" ADD CONSTRAINT "inspection_run_task_fk" FOREIGN KEY ("run_id","task_id") REFERENCES "itervane"."task_runs"("id","task_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Drizzle snapshots do not model triggers. This deliberately freezes prepared policy at the database boundary.
CREATE FUNCTION itervane.reject_inspection_plan_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inspection_plan_is_immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inspection_plan_immutable BEFORE UPDATE OR DELETE ON itervane.inspection_plans
FOR EACH ROW EXECUTE FUNCTION itervane.reject_inspection_plan_mutation();
