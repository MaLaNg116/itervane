CREATE TABLE "itervane"."rule_package_activations" (
	"package_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"version_id" uuid NOT NULL,
	"version_sha256" text NOT NULL,
	"review_id" uuid,
	"review_sha256" text,
	"action" text NOT NULL,
	"recorded_by" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"request_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_package_activations_package_id_sequence_pk" PRIMARY KEY("package_id","sequence"),
	CONSTRAINT "rule_package_activation_request" UNIQUE("package_id","request_key"),
	CONSTRAINT "rule_package_activation_binding" CHECK (("itervane"."rule_package_activations"."sequence" > 0 AND "itervane"."rule_package_activations"."version_sha256" ~ '^[a-f0-9]{64}$'
    AND "itervane"."rule_package_activations"."request_sha256" ~ '^[a-f0-9]{64}$' AND CASE WHEN "itervane"."rule_package_activations"."action" = 'withdraw'
      THEN "itervane"."rule_package_activations"."review_id" IS NULL AND "itervane"."rule_package_activations"."review_sha256" IS NULL
      ELSE "itervane"."rule_package_activations"."action" IN ('publish', 'rollback') AND "itervane"."rule_package_activations"."review_id" IS NOT NULL AND "itervane"."rule_package_activations"."review_sha256" ~ '^[a-f0-9]{64}$'
    END) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "itervane"."rule_package_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"version_sha256" text NOT NULL,
	"sha256" text NOT NULL,
	"reviewed_by" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_package_review_grant" UNIQUE("version_id","grant_id"),
	CONSTRAINT "rule_package_review_document" CHECK (("itervane"."rule_package_reviews"."sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."rule_package_reviews"."version_sha256" ~ '^[a-f0-9]{64}$'
    AND "itervane"."rule_package_reviews"."outcome" IN ('accepted', 'changes_requested') AND "itervane"."rule_package_reviews"."document"->>'formatVersion' = '1'
    AND "itervane"."rule_package_reviews"."document"->>'kind' = 'design_review' AND "itervane"."rule_package_reviews"."document"->>'outcome' = "itervane"."rule_package_reviews"."outcome"
    AND "itervane"."rule_package_reviews"."document"->>'versionId' = "itervane"."rule_package_reviews"."version_id"::text AND "itervane"."rule_package_reviews"."document"->>'versionSha256' = "itervane"."rule_package_reviews"."version_sha256"
    AND "itervane"."rule_package_reviews"."document"->>'reviewedBy' = "itervane"."rule_package_reviews"."reviewed_by"::text AND "itervane"."rule_package_reviews"."document"->>'grantId' = "itervane"."rule_package_reviews"."grant_id"::text
    AND octet_length("itervane"."rule_package_reviews"."document"::text) <= 8192) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."rule_package_activations" ADD CONSTRAINT "rule_package_activations_package_id_rule_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "itervane"."rule_packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."rule_package_activations" ADD CONSTRAINT "rule_package_activations_version_id_rule_package_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "itervane"."rule_package_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."rule_package_activations" ADD CONSTRAINT "rule_package_activations_review_id_rule_package_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "itervane"."rule_package_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."rule_package_activations" ADD CONSTRAINT "rule_package_activations_recorded_by_principals_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "itervane"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."rule_package_reviews" ADD CONSTRAINT "rule_package_reviews_version_id_rule_package_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "itervane"."rule_package_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."rule_package_reviews" ADD CONSTRAINT "rule_package_reviews_reviewed_by_principals_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "itervane"."principals"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_rule_package_review() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_package_review_is_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.rule_package_versions version
    JOIN itervane.workspace_members owner ON owner.workspace_id = version.workspace_id
    WHERE version.id = NEW.version_id AND version.sha256 = NEW.version_sha256
      AND owner.principal_id = NEW.reviewed_by AND owner.grant_id = NEW.grant_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_package_review_authority';
  END IF;
  IF jsonb_typeof(NEW.document#>'{checks,sourceAndLicense}') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(NEW.document#>'{checks,scopeAndGuidance}') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(NEW.document#>'{checks,designResources}') IS DISTINCT FROM 'boolean'
    OR (NEW.outcome = 'accepted') IS DISTINCT FROM ((
      NEW.document#>'{checks,sourceAndLicense}' = 'true'::jsonb
      AND NEW.document#>'{checks,scopeAndGuidance}' = 'true'::jsonb
      AND NEW.document#>'{checks,designResources}' = 'true'::jsonb
    ) IS TRUE)
    OR (NEW.outcome = 'changes_requested' AND coalesce(btrim(NEW.document->>'note'), '') = '') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_package_review_checks';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER rule_package_review_guard BEFORE INSERT OR UPDATE OR DELETE ON itervane.rule_package_reviews
FOR EACH ROW EXECUTE FUNCTION itervane.guard_rule_package_review();
--> statement-breakpoint
CREATE FUNCTION itervane.guard_rule_package_activation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  workspace uuid;
  prior_sequence integer;
  active_version uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_package_activation_is_immutable';
  END IF;
  SELECT package.workspace_id INTO workspace FROM itervane.rule_packages package WHERE package.id = NEW.package_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.rule_package_versions version
    JOIN itervane.workspace_members owner ON owner.workspace_id = version.workspace_id
    WHERE version.id = NEW.version_id AND version.package_id = NEW.package_id AND version.workspace_id = workspace
      AND version.sha256 = NEW.version_sha256 AND owner.principal_id = NEW.recorded_by AND owner.grant_id = NEW.grant_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_package_activation_authority';
  END IF;
  SELECT sequence, CASE WHEN action <> 'withdraw' THEN version_id END INTO prior_sequence, active_version
    FROM itervane.rule_package_activations WHERE package_id = NEW.package_id ORDER BY sequence DESC LIMIT 1;
  IF NEW.sequence <> coalesce(prior_sequence, 0) + 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_package_activation_sequence';
  END IF;
  IF NEW.action = 'withdraw' THEN
    IF active_version IS DISTINCT FROM NEW.version_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_package_activation_target';
    END IF;
  ELSE
    IF active_version IS NOT DISTINCT FROM NEW.version_id OR (NEW.action = 'rollback' AND (active_version IS NULL OR NOT EXISTS (
      SELECT 1 FROM itervane.rule_package_activations previous
      WHERE previous.package_id = NEW.package_id AND previous.version_id = NEW.version_id AND previous.action <> 'withdraw'
    ))) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_package_activation_target';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM itervane.rule_package_reviews review WHERE review.id = NEW.review_id AND review.sha256 = NEW.review_sha256
        AND review.version_id = NEW.version_id AND review.version_sha256 = NEW.version_sha256 AND review.outcome = 'accepted'
        AND review.reviewed_by = NEW.recorded_by AND review.grant_id = NEW.grant_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_package_activation_review';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER rule_package_activation_guard BEFORE INSERT OR UPDATE OR DELETE ON itervane.rule_package_activations
FOR EACH ROW EXECUTE FUNCTION itervane.guard_rule_package_activation();
