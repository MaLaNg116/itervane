ALTER TABLE "itervane"."rule_package_reviews" DROP CONSTRAINT "rule_package_review_document";--> statement-breakpoint
ALTER TABLE "itervane"."rule_package_versions" DROP CONSTRAINT "rule_package_version_document";--> statement-breakpoint
ALTER TABLE "itervane"."rule_package_versions" ADD COLUMN "validation_id" uuid;--> statement-breakpoint
ALTER TABLE "itervane"."rule_package_versions" ADD CONSTRAINT "rule_version_candidate_validation_fk" FOREIGN KEY ("validation_id") REFERENCES "itervane"."candidate_validation_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."rule_package_reviews" ADD CONSTRAINT "rule_package_review_document" CHECK (("itervane"."rule_package_reviews"."sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."rule_package_reviews"."version_sha256" ~ '^[a-f0-9]{64}$'
    AND "itervane"."rule_package_reviews"."outcome" IN ('accepted', 'changes_requested') AND "itervane"."rule_package_reviews"."document"->>'formatVersion' = '1'
    AND "itervane"."rule_package_reviews"."document"->>'kind' IN ('design_review', 'candidate_review') AND "itervane"."rule_package_reviews"."document"->>'outcome' = "itervane"."rule_package_reviews"."outcome"
    AND "itervane"."rule_package_reviews"."document"->>'versionId' = "itervane"."rule_package_reviews"."version_id"::text AND "itervane"."rule_package_reviews"."document"->>'versionSha256' = "itervane"."rule_package_reviews"."version_sha256"
    AND "itervane"."rule_package_reviews"."document"->>'reviewedBy' = "itervane"."rule_package_reviews"."reviewed_by"::text AND "itervane"."rule_package_reviews"."document"->>'grantId' = "itervane"."rule_package_reviews"."grant_id"::text
    AND octet_length("itervane"."rule_package_reviews"."document"::text) <= 8192) IS TRUE);--> statement-breakpoint
ALTER TABLE "itervane"."rule_package_versions" ADD CONSTRAINT "rule_package_version_document" CHECK (("itervane"."rule_package_versions"."sha256" ~ '^[a-f0-9]{64}$' AND length("itervane"."rule_package_versions"."version") <= 32
    AND "itervane"."rule_package_versions"."version" ~ '^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$'
    AND "itervane"."rule_package_versions"."document"->>'formatVersion' = '1'
    AND "itervane"."rule_package_versions"."document"->>'packageKey' = "itervane"."rule_package_versions"."package_key" AND "itervane"."rule_package_versions"."document"->>'version' = "itervane"."rule_package_versions"."version"
    AND "itervane"."rule_package_versions"."document"#>>'{scope,kind}' = CASE WHEN "itervane"."rule_package_versions"."project_id" IS NULL THEN 'workspace' ELSE 'project' END
    AND ("itervane"."rule_package_versions"."document"#>>'{scope,projectId}') IS NOT DISTINCT FROM "itervane"."rule_package_versions"."project_id"::text
    AND CASE WHEN "itervane"."rule_package_versions"."document"->>'kind' = 'design_skill' THEN "itervane"."rule_package_versions"."validation_id" IS NULL AND "itervane"."rule_package_versions"."document"->'validation' IS NULL
      ELSE "itervane"."rule_package_versions"."document"->>'kind' IN ('code_rule', 'runbook') AND "itervane"."rule_package_versions"."validation_id" IS NOT NULL
        AND "itervane"."rule_package_versions"."document"#>>'{validation,id}' = "itervane"."rule_package_versions"."validation_id"::text
        AND ("itervane"."rule_package_versions"."project_id" IS NULL OR "itervane"."rule_package_versions"."document"#>>'{validation,projectId}' = "itervane"."rule_package_versions"."project_id"::text)
    END
    AND octet_length("itervane"."rule_package_versions"."document"::text) <= 61440) IS TRUE);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION itervane.guard_rule_package_version() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  package_kind text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_package_version_is_immutable';
  END IF;
  package_kind := NEW.document->>'kind';
  IF NOT EXISTS (
    SELECT 1 FROM itervane.workspace_members owner
    WHERE owner.workspace_id = NEW.workspace_id AND owner.principal_id = NEW.submitted_by AND owner.grant_id = NEW.grant_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_package_import_authority';
  END IF;

  PERFORM 1 FROM itervane.rule_packages package WHERE package.id = NEW.package_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM itervane.rule_package_versions previous WHERE previous.package_id = NEW.package_id
      AND (previous.document->>'kind' <> package_kind
        OR (package_kind <> 'design_skill' AND previous.project_id IS DISTINCT FROM NEW.project_id))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_package_series_conflict';
  END IF;

  IF NEW.validation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM itervane.candidate_validation_results result
    JOIN itervane.rule_extraction_results extraction ON extraction.id = result.candidate_id AND extraction.project_id = result.project_id
    JOIN itervane.projects source ON source.id = result.project_id
    WHERE result.id = NEW.validation_id AND result.sha256 = NEW.document#>>'{validation,sha256}'
      AND source.workspace_id = NEW.workspace_id AND source.id::text = NEW.document#>>'{validation,projectId}'
      AND result.plan_sha256 = NEW.document#>>'{validation,planSha256}' AND result.document->>'status' = 'passed'
      AND result.document#>>'{evidence,kind}' = package_kind
      AND result.document->>'candidateSha256' = NEW.document#>>'{validation,candidateSha256}'
      AND result.document->>'extractionResultSha256' = extraction.sha256
      AND extraction.id::text = NEW.document#>>'{validation,candidateId}' AND extraction.sha256 = NEW.document#>>'{validation,extractionResultSha256}'
      AND extraction.candidate_kind = package_kind AND extraction.document#>'{extraction,result,candidate}' = NEW.document->'candidate'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_package_validation_binding';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION itervane.guard_rule_package_review() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  review_kind text;
  third_check text;
  checks jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_package_review_is_immutable';
  END IF;
  checks := NEW.document->'checks';
  SELECT CASE WHEN version.validation_id IS NULL THEN 'design_review' ELSE 'candidate_review' END INTO review_kind
  FROM itervane.rule_package_versions version
  JOIN itervane.workspace_members owner ON owner.workspace_id = version.workspace_id
  WHERE version.id = NEW.version_id AND version.sha256 = NEW.version_sha256
    AND owner.principal_id = NEW.reviewed_by AND owner.grant_id = NEW.grant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_package_review_authority';
  END IF;
  third_check := CASE review_kind WHEN 'design_review' THEN 'designResources' ELSE 'validationEvidence' END;

  IF NEW.document->>'kind' IS DISTINCT FROM review_kind
    OR jsonb_typeof(checks->'sourceAndLicense') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(checks->'scopeAndGuidance') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(checks->third_check) IS DISTINCT FROM 'boolean'
    OR (checks - ARRAY['sourceAndLicense', 'scopeAndGuidance', third_check]) <> '{}'::jsonb
    OR (NEW.outcome = 'accepted') IS DISTINCT FROM ((
      checks->'sourceAndLicense' = 'true'::jsonb AND checks->'scopeAndGuidance' = 'true'::jsonb
      AND checks->third_check = 'true'::jsonb
    ) IS TRUE)
    OR (NEW.outcome = 'changes_requested' AND coalesce(btrim(NEW.document->>'note'), '') = '') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'rule_package_review_checks';
  END IF;
  RETURN NEW;
END
$$;
