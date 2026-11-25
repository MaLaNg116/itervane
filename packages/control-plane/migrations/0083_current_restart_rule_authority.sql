-- Custom SQL migration file, put your code below! --
CREATE FUNCTION itervane.guard_current_restart_rules() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  proposal jsonb;
  diagnosis_run uuid;
  diagnosis_task uuid;
  diagnosis_project uuid;
  workspace uuid;
  pinned_entries jsonb;
  pinned_digest text;
  guidance_digest text;
BEGIN
  IF TG_TABLE_NAME = 'operations_proposals' THEN
    proposal := NEW.document;
    diagnosis_run := NEW.diagnosis_run_id;
  ELSIF TG_TABLE_NAME = 'operations_decisions' THEN
    SELECT operation.document, operation.diagnosis_run_id INTO proposal, diagnosis_run
    FROM itervane.operations_proposals operation WHERE operation.id = NEW.proposal_id;
  ELSE
    SELECT operation.document, operation.diagnosis_run_id INTO proposal, diagnosis_run
    FROM itervane.operations_proposals operation
    JOIN itervane.operations_executions execution ON execution.proposal_id = operation.id
    WHERE execution.id = NEW.execution_id;
  END IF;
  IF proposal#>>'{action,kind}' IS DISTINCT FROM 'restart' THEN RETURN NEW; END IF;

  SELECT request.task_id, request.project_id, project.workspace_id INTO diagnosis_task, diagnosis_project, workspace
  FROM itervane.operations_requests request JOIN itervane.projects project ON project.id = request.project_id
  WHERE request.run_id = diagnosis_run;
  PERFORM itervane.lock_rule_library(workspace, false);
  SELECT snapshot.document->'entries', snapshot.sha256 INTO pinned_entries, pinned_digest
  FROM itervane.task_rule_snapshots snapshot
  WHERE snapshot.task_id = diagnosis_task AND snapshot.project_id = diagnosis_project AND snapshot.purpose = 'operations';
  SELECT evidence.document#>>'{result,runbooks,snapshotSha256}' INTO guidance_digest
  FROM itervane.operations_diagnosis_reads evidence WHERE evidence.run_id = diagnosis_run AND evidence.section = 'release' AND evidence.state = 'recorded';
  IF workspace IS NULL OR
    itervane.active_rule_references(diagnosis_project, 'operations') IS DISTINCT FROM coalesce(pinned_entries, '[]'::jsonb)
    OR (jsonb_array_length(pinned_entries) > 0 AND guidance_digest IS DISTINCT FROM pinned_digest)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_rule_snapshot_changed';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER operations_proposal_current_rules BEFORE INSERT ON itervane.operations_proposals
FOR EACH ROW EXECUTE FUNCTION itervane.guard_current_restart_rules();
--> statement-breakpoint
CREATE TRIGGER operations_confirmation_current_rules BEFORE INSERT ON itervane.operations_decisions
FOR EACH ROW WHEN (NEW.action = 'confirm') EXECUTE FUNCTION itervane.guard_current_restart_rules();
--> statement-breakpoint
CREATE TRIGGER operations_intent_current_rules BEFORE INSERT ON itervane.operations_execution_intents
FOR EACH ROW EXECUTE FUNCTION itervane.guard_current_restart_rules();
--> statement-breakpoint
CREATE TRIGGER operations_restart_resume_current_rules BEFORE UPDATE OF state ON itervane.operations_restart_resumes
FOR EACH ROW WHEN (NEW.state = 'prepared') EXECUTE FUNCTION itervane.guard_current_restart_rules();
