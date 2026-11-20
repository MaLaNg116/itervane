ALTER TABLE "itervane"."task_events" DROP CONSTRAINT "event_actor_kind";--> statement-breakpoint
ALTER TABLE "itervane"."task_events" ALTER COLUMN "actor_kind" SET DEFAULT 'principal';--> statement-breakpoint
UPDATE "itervane"."task_events" SET "actor_kind" = 'principal' WHERE "actor_kind" = 'human';--> statement-breakpoint
ALTER TABLE "itervane"."task_events" ADD CONSTRAINT "event_actor_kind" CHECK (("itervane"."task_events"."actor_kind" = 'principal' AND "itervane"."task_events"."worker_id" IS NULL) OR ("itervane"."task_events"."actor_kind" = 'worker' AND "itervane"."task_events"."worker_id" IS NOT NULL));
