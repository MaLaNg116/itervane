CREATE TABLE "itervane"."task_rule_snapshots" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"sha256" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_rule_snapshot_binding" CHECK (("itervane"."task_rule_snapshots"."sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."task_rule_snapshots"."purpose" IN ('delivery', 'operations')
    AND "itervane"."task_rule_snapshots"."document"->>'version' = '1' AND "itervane"."task_rule_snapshots"."document"->>'taskId' = "itervane"."task_rule_snapshots"."task_id"::text
    AND "itervane"."task_rule_snapshots"."document"->>'projectId' = "itervane"."task_rule_snapshots"."project_id"::text AND "itervane"."task_rule_snapshots"."document"->>'purpose' = "itervane"."task_rule_snapshots"."purpose"
    AND jsonb_typeof("itervane"."task_rule_snapshots"."document"->'entries') = 'array' AND octet_length("itervane"."task_rule_snapshots"."document"::text) <= 24576) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."task_rule_snapshots" ADD CONSTRAINT "task_rule_snapshot_project_fk" FOREIGN KEY ("task_id","project_id") REFERENCES "itervane"."tasks"("id","project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION itervane.lock_rule_library(workspace uuid, writing boolean) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  lock_key bigint := hashtextextended('itervane:rule-library:' || workspace::text, 0);
BEGIN
  IF writing THEN
    PERFORM pg_advisory_xact_lock(lock_key);
  ELSE
    PERFORM pg_advisory_xact_lock_shared(lock_key);
  END IF;
END
$$;
--> statement-breakpoint
CREATE FUNCTION itervane.order_rule_package_activation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM itervane.lock_rule_library(package.workspace_id, true) FROM itervane.rule_packages package WHERE package.id = NEW.package_id;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER rule_package_activation_catalog_lock BEFORE INSERT ON itervane.rule_package_activations
FOR EACH ROW EXECUTE FUNCTION itervane.order_rule_package_activation();
--> statement-breakpoint
CREATE FUNCTION itervane.active_rule_references(target_project uuid, task_purpose text) RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(jsonb_agg(selected.entry ORDER BY selected.key COLLATE "C"), '[]'::jsonb)
  FROM (
    SELECT package.key, jsonb_build_object('packageId', package.id, 'packageKey', package.key, 'versionId', version.id,
      'kind', version.document->>'kind', 'versionSha256', version.sha256,
      'reviewSha256', review.sha256, 'sequence', latest.sequence) AS entry
    FROM itervane.projects project
      JOIN itervane.rule_packages package ON package.workspace_id = project.workspace_id
      JOIN LATERAL (
        SELECT activation.* FROM itervane.rule_package_activations activation
        WHERE activation.package_id = package.id ORDER BY activation.sequence DESC LIMIT 1
      ) latest ON latest.action IN ('publish', 'rollback')
      JOIN itervane.rule_package_versions version ON version.id = latest.version_id AND version.package_id = package.id
        AND version.sha256 = latest.version_sha256
      JOIN itervane.rule_package_reviews review ON review.id = latest.review_id AND review.version_id = version.id
        AND review.sha256 = latest.review_sha256 AND review.outcome = 'accepted'
    WHERE project.id = target_project AND (version.project_id IS NULL OR version.project_id = project.id)
      AND CASE task_purpose WHEN 'delivery' THEN version.document->>'kind' IN ('design_skill', 'code_rule')
        WHEN 'operations' THEN version.document->>'kind' = 'runbook' ELSE false END
    ORDER BY package.key COLLATE "C" LIMIT 33
  ) selected
$$;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_task_rule_snapshot() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  workspace uuid;
  active_entries jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'task_rule_snapshot_is_immutable';
  END IF;
  SELECT project.workspace_id INTO workspace FROM itervane.tasks task
    JOIN itervane.projects project ON project.id = task.project_id
    JOIN itervane.task_runs run ON run.task_id = task.id AND run.generation = 1
  WHERE task.id = NEW.task_id AND task.project_id = NEW.project_id AND task.generation = 1 AND task.state = 'queued'
    AND run.state = 'queued' AND ((NEW.purpose = 'delivery' AND run.role = 'audit') OR (NEW.purpose = 'operations' AND run.role = 'operations'));
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'task_rule_snapshot_scope';
  END IF;
  PERFORM itervane.lock_rule_library(workspace, false);
  active_entries := itervane.active_rule_references(NEW.project_id, NEW.purpose);
  IF jsonb_array_length(active_entries) > 32 OR NEW.document->'entries' IS DISTINCT FROM active_entries THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'task_rule_snapshot_activation_binding';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER task_rule_snapshot_guard BEFORE INSERT OR UPDATE OR DELETE ON itervane.task_rule_snapshots
FOR EACH ROW EXECUTE FUNCTION itervane.guard_task_rule_snapshot();
