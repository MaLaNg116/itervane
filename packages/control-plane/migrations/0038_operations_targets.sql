CREATE TABLE "itervane"."operations_targets" (
	"environment_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"sha256" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_target_binding" CHECK (("itervane"."operations_targets"."revision" > 0 AND "itervane"."operations_targets"."sha256" ~ '^[a-f0-9]{64}$'
    AND "itervane"."operations_targets"."document"->>'environmentId' = "itervane"."operations_targets"."environment_id"::text
    AND jsonb_typeof("itervane"."operations_targets"."document"->'whiskers') = 'object' AND octet_length("itervane"."operations_targets"."document"::text) <= 4096) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."operations_targets" ADD CONSTRAINT "operations_targets_environment_id_formal_release_targets_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "itervane"."formal_release_targets"("environment_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_targets" ADD CONSTRAINT "operations_target_environment_fk" FOREIGN KEY ("environment_id","project_id","application_id") REFERENCES "itervane"."environments"("id","project_id","application_id") ON DELETE no action ON UPDATE no action;