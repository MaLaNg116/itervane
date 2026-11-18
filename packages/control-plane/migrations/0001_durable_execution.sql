CREATE TABLE "itervane"."execution_slot" (
	"id" integer PRIMARY KEY NOT NULL,
	"task_id" uuid,
	"run_id" uuid,
	"worker_id" uuid,
	"fence" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone DEFAULT '-infinity'::timestamptz NOT NULL,
	CONSTRAINT "one_execution_slot" CHECK ("itervane"."execution_slot"."id" = 1),
	CONSTRAINT "slot_assignment" CHECK (
  ("itervane"."execution_slot"."task_id" IS NULL AND "itervane"."execution_slot"."run_id" IS NULL AND "itervane"."execution_slot"."worker_id" IS NULL)
  OR ("itervane"."execution_slot"."task_id" IS NOT NULL AND "itervane"."execution_slot"."run_id" IS NOT NULL AND "itervane"."execution_slot"."worker_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "itervane"."run_runtime" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"checkpoint_id" text,
	"resume_pending" boolean DEFAULT false NOT NULL,
	"resume_count" integer DEFAULT 0 NOT NULL,
	"tools_used" integer DEFAULT 0 NOT NULL,
	"max_tools" integer DEFAULT 8 NOT NULL,
	"waiting_for_task_id" uuid,
	"reason" text,
	CONSTRAINT "runtime_limits" CHECK ("itervane"."run_runtime"."resume_count" >= 0 AND "itervane"."run_runtime"."tools_used" >= 0 AND "itervane"."run_runtime"."max_tools" BETWEEN 1 AND 32)
);
--> statement-breakpoint
CREATE TABLE "itervane"."tool_calls" (
	"run_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"input_hash" text NOT NULL,
	"tool" text NOT NULL,
	"fence" integer NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_calls_run_id_key_hash_pk" PRIMARY KEY("run_id","key_hash"),
	CONSTRAINT "tool_call_status" CHECK ("itervane"."tool_calls"."status" IN ('reserved', 'success', 'business_error', 'infrastructure_error'))
);
--> statement-breakpoint
ALTER TABLE "itervane"."task_events" ADD COLUMN "actor_kind" text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "itervane"."task_events" ADD COLUMN "worker_id" uuid;--> statement-breakpoint
ALTER TABLE "itervane"."tasks" ADD COLUMN "locale" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "itervane"."execution_slot" ADD CONSTRAINT "execution_slot_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "itervane"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."execution_slot" ADD CONSTRAINT "execution_slot_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."task_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."run_runtime" ADD CONSTRAINT "run_runtime_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."task_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."run_runtime" ADD CONSTRAINT "run_runtime_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "itervane"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."run_runtime" ADD CONSTRAINT "run_runtime_waiting_for_task_id_tasks_id_fk" FOREIGN KEY ("waiting_for_task_id") REFERENCES "itervane"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."tool_calls" ADD CONSTRAINT "tool_calls_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."task_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."task_events" ADD CONSTRAINT "event_actor_kind" CHECK (("itervane"."task_events"."actor_kind" = 'human' AND "itervane"."task_events"."worker_id" IS NULL) OR ("itervane"."task_events"."actor_kind" = 'worker' AND "itervane"."task_events"."worker_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "itervane"."tasks" ADD CONSTRAINT "task_locale" CHECK ("itervane"."tasks"."locale" IN ('en', 'zh-CN'));--> statement-breakpoint
INSERT INTO "itervane"."execution_slot" ("id") VALUES (1);--> statement-breakpoint
INSERT INTO "itervane"."run_runtime" ("run_id", "task_id") SELECT "id", "task_id" FROM "itervane"."task_runs";
