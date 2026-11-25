-- Custom SQL migration file, put your code below! --
CREATE FUNCTION itervane.guard_current_release_rules() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  release_task uuid;
  release_project uuid;
  release_run uuid;
  manifest jsonb;
  workspace uuid;
  pinned_entries jsonb;
  pinned_digest text;
  code_inspection_digest text;
  bound_digest text;
BEGIN
  IF TG_TABLE_NAME = 'release_candidates' THEN
    release_task := NEW.task_id;
    release_project := NEW.project_id;
    release_run := NEW.run_id;
    manifest := NEW.document;
  ELSIF TG_TABLE_NAME = 'release_decisions' THEN
    SELECT task_id, project_id, run_id, document INTO release_task, release_project, release_run, manifest
    FROM itervane.release_candidates WHERE id = NEW.candidate_id;
  ELSE
    SELECT candidate.task_id, candidate.project_id, candidate.run_id, candidate.document
    INTO release_task, release_project, release_run, manifest
    FROM itervane.release_candidates candidate
    JOIN itervane.release_operations operation ON operation.candidate_id = candidate.id
    WHERE operation.id = NEW.operation_id;
  END IF;
  IF manifest->>'origin' IS DISTINCT FROM 'formal_verification' THEN RETURN NEW; END IF;

  SELECT workspace_id INTO workspace FROM itervane.projects WHERE id = release_project;
  PERFORM itervane.lock_rule_library(workspace, false);
  SELECT snapshot.document->'entries', snapshot.sha256 INTO pinned_entries, pinned_digest
  FROM itervane.task_rule_snapshots snapshot
  WHERE snapshot.task_id = release_task AND snapshot.project_id = release_project AND snapshot.purpose = 'delivery';
  SELECT input.document#>>'{publishedCode,snapshotSha256}' INTO code_inspection_digest
  FROM itervane.formal_verification_inputs input WHERE input.run_id = release_run;
  bound_digest := manifest#>>'{verification,ruleSnapshotSha256}';

  IF workspace IS NULL OR
    itervane.active_rule_references(release_project, 'delivery') IS DISTINCT FROM COALESCE(pinned_entries, '[]'::jsonb)
    OR ((TG_TABLE_NAME = 'release_candidates' OR bound_digest IS NOT NULL) AND bound_digest IS DISTINCT FROM pinned_digest)
    OR code_inspection_digest IS DISTINCT FROM (CASE WHEN jsonb_path_exists(pinned_entries, '$[*] ? (@.kind == "code_rule")')
      THEN pinned_digest ELSE NULL END)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_rule_snapshot_changed';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER release_candidate_rules BEFORE INSERT ON itervane.release_candidates
FOR EACH ROW WHEN (NEW.document->>'origin' = 'formal_verification') EXECUTE FUNCTION itervane.guard_current_release_rules();
--> statement-breakpoint
CREATE TRIGGER release_confirmation_rules BEFORE INSERT ON itervane.release_decisions
FOR EACH ROW WHEN (NEW.action = 'confirm') EXECUTE FUNCTION itervane.guard_current_release_rules();
--> statement-breakpoint
CREATE TRIGGER release_send_intent_rules BEFORE INSERT ON itervane.formal_release_steps
FOR EACH ROW WHEN (NEW.kind IN ('registry', 'komodo_config', 'komodo_dispatch')) EXECUTE FUNCTION itervane.guard_current_release_rules();
