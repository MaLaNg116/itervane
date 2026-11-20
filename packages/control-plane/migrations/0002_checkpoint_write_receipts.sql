CREATE TABLE "itervane"."checkpoint_write_receipts" (
	"run_id" uuid NOT NULL,
	"checkpoint_id" text NOT NULL,
	"write_hash" text NOT NULL,
	CONSTRAINT "checkpoint_write_receipts_run_id_checkpoint_id_write_hash_pk" PRIMARY KEY("run_id","checkpoint_id","write_hash")
);
--> statement-breakpoint
ALTER TABLE "itervane"."checkpoint_write_receipts" ADD CONSTRAINT "checkpoint_write_receipts_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."task_runs"("id") ON DELETE no action ON UPDATE no action;