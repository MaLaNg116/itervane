CREATE FUNCTION itervane.guard_formal_release_operation() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM itervane.release_candidates candidate
    WHERE candidate.id = NEW.candidate_id AND candidate.document->>'origin' = 'formal_verification') THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.release_candidates candidate
    JOIN itervane.tasks task ON task.id = candidate.task_id AND task.project_id = candidate.project_id
    JOIN itervane.task_runs run ON run.id = candidate.run_id AND run.task_id = task.id AND run.generation = task.generation
    JOIN itervane.run_runtime runtime ON runtime.run_id = run.id AND runtime.task_id = task.id
    JOIN itervane.projects project ON project.id = candidate.project_id
    JOIN itervane.release_decisions approval ON approval.candidate_id = candidate.id AND approval.version = NEW.approval_version
    JOIN itervane.workspace_members owner ON owner.workspace_id = project.workspace_id AND owner.principal_id = approval.actor_id
    JOIN itervane.formal_release_targets target ON target.environment_id = NEW.environment_id AND target.project_id = candidate.project_id
    JOIN itervane.formal_verification_results result ON result.run_id = run.id
    WHERE candidate.id = NEW.candidate_id AND candidate.environment_id = NEW.environment_id
      AND candidate.requested_by = task.requested_by AND task.state = 'waiting_approval' AND run.state = task.state
      AND runtime.reason = 'release_candidate_ready' AND approval.action = 'confirm' AND approval.grant_id = owner.grant_id
      AND approval.self_confirmed = (approval.actor_id = task.requested_by)
      AND target.revision::text = candidate.document#>>'{target,revision}' AND target.sha256 = candidate.document#>>'{target,mappingSha256}'
      AND result.sha256 = candidate.document#>>'{verification,resultSha256}'
      AND (candidate.document->>'validUntil')::timestamptz > pg_catalog.clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM itervane.release_decisions later WHERE later.candidate_id = candidate.id AND later.version > approval.version)
      AND NOT EXISTS (SELECT 1 FROM itervane.release_candidates newer
        WHERE newer.task_id = task.id AND newer.evidence_version > candidate.evidence_version)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_operation_approval_binding';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_release_operation_approval_binding BEFORE INSERT ON itervane.release_operations
FOR EACH ROW EXECUTE FUNCTION itervane.guard_formal_release_operation();
