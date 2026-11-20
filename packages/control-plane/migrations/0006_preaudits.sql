CREATE TABLE "itervane"."preaudits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"report_sha256" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preaudit_request_unique" UNIQUE("project_id","requested_by","request_key"),
	CONSTRAINT "preaudit_document_binding" CHECK (("itervane"."preaudits"."request_hash" ~ '^[a-f0-9]{64}$' AND "itervane"."preaudits"."report_sha256" ~ '^[a-f0-9]{64}$'
  AND "itervane"."preaudits"."document"->>'id' = "itervane"."preaudits"."id"::text AND "itervane"."preaudits"."document"->>'projectId' = "itervane"."preaudits"."project_id"::text AND "itervane"."preaudits"."document"->>'requestedBy' = "itervane"."preaudits"."requested_by"::text
  AND "itervane"."preaudits"."document"#>>'{evaluation,formalScan}' = 'false' AND "itervane"."preaudits"."document"#>>'{evaluation,releaseEligible}' = 'false'
  AND octet_length("itervane"."preaudits"."document"::text) <= 65536) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."preaudits" ADD CONSTRAINT "preaudits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "itervane"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."preaudits" ADD CONSTRAINT "preaudits_requested_by_principals_id_fk" FOREIGN KEY ("requested_by") REFERENCES "itervane"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "preaudit_project_history" ON "itervane"."preaudits" USING btree ("project_id","created_at","id");
--> statement-breakpoint
-- Metadata-only historical reports are immutable; snapshots do not model this trigger.
CREATE FUNCTION itervane.reject_preaudit_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'preaudit_is_immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER preaudit_immutable BEFORE UPDATE OR DELETE ON itervane.preaudits
FOR EACH ROW EXECUTE FUNCTION itervane.reject_preaudit_mutation();
