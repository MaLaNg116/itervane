-- Custom SQL migration file, put your code below! --
CREATE FUNCTION itervane.guard_operations_runbook_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  pinned_sha256 text;
  pinned_entries jsonb;
  guidance jsonb := NEW.document#>'{result,runbooks}';
BEGIN
  SELECT snapshot.sha256, snapshot.document->'entries' INTO pinned_sha256, pinned_entries
  FROM itervane.operations_requests request
  JOIN itervane.task_rule_snapshots snapshot ON snapshot.task_id = request.task_id AND snapshot.purpose = 'operations'
  WHERE request.run_id = NEW.run_id AND jsonb_array_length(snapshot.document->'entries') > 0;

  IF (pinned_sha256 IS NULL) <> (guidance IS NULL)
    OR pinned_sha256 IS DISTINCT FROM guidance->>'snapshotSha256'
    OR (guidance IS NOT NULL AND (jsonb_typeof(guidance->'byState') = 'object' AND guidance->>'version' = '1') IS NOT TRUE)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_runbook_snapshot_binding';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_each(guidance->'byState') AS choice(state, entry)
    WHERE choice.entry->>'status' = 'available' AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(pinned_entries) pinned WHERE pinned = choice.entry->'rule'
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_runbook_choice_binding';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER operations_runbook_evidence BEFORE UPDATE ON itervane.operations_diagnosis_reads
FOR EACH ROW WHEN (NEW.section = 'release' AND NEW.state = 'recorded') EXECUTE FUNCTION itervane.guard_operations_runbook_evidence();
