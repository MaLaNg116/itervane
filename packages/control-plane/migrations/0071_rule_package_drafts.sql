CREATE TABLE "itervane"."rule_package_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"package_key" text NOT NULL,
	"project_id" uuid,
	"version" text NOT NULL,
	"sha256" text NOT NULL,
	"submitted_by" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_package_version_unique" UNIQUE("package_id","version"),
	CONSTRAINT "rule_package_version_document" CHECK (("itervane"."rule_package_versions"."sha256" ~ '^[a-f0-9]{64}$' AND length("itervane"."rule_package_versions"."version") <= 32
    AND "itervane"."rule_package_versions"."version" ~ '^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$'
    AND "itervane"."rule_package_versions"."document"->>'formatVersion' = '1' AND "itervane"."rule_package_versions"."document"->>'kind' = 'design_skill'
    AND "itervane"."rule_package_versions"."document"->>'packageKey' = "itervane"."rule_package_versions"."package_key" AND "itervane"."rule_package_versions"."document"->>'version' = "itervane"."rule_package_versions"."version"
    AND "itervane"."rule_package_versions"."document"#>>'{scope,kind}' = CASE WHEN "itervane"."rule_package_versions"."project_id" IS NULL THEN 'workspace' ELSE 'project' END
    AND ("itervane"."rule_package_versions"."document"#>>'{scope,projectId}') IS NOT DISTINCT FROM "itervane"."rule_package_versions"."project_id"::text
    AND octet_length("itervane"."rule_package_versions"."document"::text) <= 61440) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "itervane"."rule_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_package_workspace_key" UNIQUE("workspace_id","key"),
	CONSTRAINT "rule_package_scope_key" UNIQUE("id","workspace_id","key"),
	CONSTRAINT "rule_package_key" CHECK ("itervane"."rule_packages"."key" ~ '^[a-z][a-z0-9-]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "itervane"."projects" ADD CONSTRAINT "project_workspace_pair" UNIQUE("id","workspace_id");--> statement-breakpoint
ALTER TABLE "itervane"."rule_package_versions" ADD CONSTRAINT "rule_package_versions_submitted_by_principals_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "itervane"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."rule_package_versions" ADD CONSTRAINT "rule_version_package_scope_fk" FOREIGN KEY ("package_id","workspace_id","package_key") REFERENCES "itervane"."rule_packages"("id","workspace_id","key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."rule_package_versions" ADD CONSTRAINT "rule_version_project_scope_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "itervane"."projects"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."rule_packages" ADD CONSTRAINT "rule_packages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "itervane"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rule_package_workspace_history" ON "itervane"."rule_package_versions" USING btree ("workspace_id","created_at","id");
--> statement-breakpoint
CREATE FUNCTION itervane.guard_rule_package_version() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_package_version_is_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.workspace_members owner
    WHERE owner.workspace_id = NEW.workspace_id AND owner.principal_id = NEW.submitted_by AND owner.grant_id = NEW.grant_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_package_import_authority';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER rule_package_version_guard BEFORE INSERT OR UPDATE OR DELETE ON itervane.rule_package_versions
FOR EACH ROW EXECUTE FUNCTION itervane.guard_rule_package_version();
