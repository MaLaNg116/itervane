CREATE TABLE "itervane"."release_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"evidence_version" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_candidate_evidence_version" UNIQUE("task_id","evidence_version"),
	CONSTRAINT "release_candidate_binding" CHECK (("itervane"."release_candidates"."evidence_version" > 0 AND "itervane"."release_candidates"."fingerprint" ~ '^[a-f0-9]{64}$'
    AND "itervane"."release_candidates"."document"->>'version' = '1' AND "itervane"."release_candidates"."document"->>'origin' = 'trusted_fixture'
    AND "itervane"."release_candidates"."document"->'releaseEligible' = 'false'::jsonb
    AND "itervane"."release_candidates"."document"->>'evidenceVersion' = "itervane"."release_candidates"."evidence_version"::text
    AND "itervane"."release_candidates"."document"->>'projectId' = "itervane"."release_candidates"."project_id"::text AND "itervane"."release_candidates"."document"->>'taskId' = "itervane"."release_candidates"."task_id"::text
    AND "itervane"."release_candidates"."document"->>'runId' = "itervane"."release_candidates"."run_id"::text
    AND "itervane"."release_candidates"."document"#>>'{target,applicationId}' = "itervane"."release_candidates"."application_id"::text
    AND "itervane"."release_candidates"."document"#>>'{target,environmentId}' = "itervane"."release_candidates"."environment_id"::text
    AND octet_length("itervane"."release_candidates"."document"::text) <= 8192) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "itervane"."release_decisions" (
	"candidate_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"actor_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"action" text NOT NULL,
	"self_confirmed" boolean NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	CONSTRAINT "release_decisions_candidate_id_version_pk" PRIMARY KEY("candidate_id","version"),
	CONSTRAINT "release_decision_request" UNIQUE("candidate_id","actor_id","idempotency_key"),
	CONSTRAINT "release_decision_action_version" CHECK (("itervane"."release_decisions"."version" = 1 AND "itervane"."release_decisions"."action" IN ('confirm', 'reject'))
    OR ("itervane"."release_decisions"."version" = 2 AND "itervane"."release_decisions"."action" = 'revoke')),
	CONSTRAINT "release_decision_self_confirmed" CHECK (NOT "itervane"."release_decisions"."self_confirmed" OR "itervane"."release_decisions"."action" = 'confirm')
);
--> statement-breakpoint
ALTER TABLE "itervane"."workspace_members" ADD COLUMN "grant_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "itervane"."environments" ADD CONSTRAINT "environment_project_application" UNIQUE("id","project_id","application_id");--> statement-breakpoint
ALTER TABLE "itervane"."tasks" ADD CONSTRAINT "task_project_pair" UNIQUE("id","project_id");--> statement-breakpoint
ALTER TABLE "itervane"."release_candidates" ADD CONSTRAINT "release_candidates_requested_by_principals_id_fk" FOREIGN KEY ("requested_by") REFERENCES "itervane"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."release_candidates" ADD CONSTRAINT "release_candidate_task_project_fk" FOREIGN KEY ("task_id","project_id") REFERENCES "itervane"."tasks"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."release_candidates" ADD CONSTRAINT "release_candidate_run_task_fk" FOREIGN KEY ("run_id","task_id") REFERENCES "itervane"."task_runs"("id","task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."release_candidates" ADD CONSTRAINT "release_candidate_environment_scope_fk" FOREIGN KEY ("environment_id","project_id","application_id") REFERENCES "itervane"."environments"("id","project_id","application_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."release_decisions" ADD CONSTRAINT "release_decisions_candidate_id_release_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "itervane"."release_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."release_decisions" ADD CONSTRAINT "release_decisions_actor_id_principals_id_fk" FOREIGN KEY ("actor_id") REFERENCES "itervane"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."workspace_members" ADD CONSTRAINT "workspace_owner_grant" UNIQUE("grant_id");
--> statement-breakpoint
-- Historical records are append-only. Drizzle snapshots track their table shapes.
CREATE FUNCTION itervane.reject_release_record_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'release_record_is_immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER release_candidates_immutable BEFORE UPDATE OR DELETE ON itervane.release_candidates
FOR EACH ROW EXECUTE FUNCTION itervane.reject_release_record_mutation();
--> statement-breakpoint
CREATE TRIGGER release_decisions_immutable BEFORE UPDATE OR DELETE ON itervane.release_decisions
FOR EACH ROW EXECUTE FUNCTION itervane.reject_release_record_mutation();
