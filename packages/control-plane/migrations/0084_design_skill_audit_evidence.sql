CREATE FUNCTION itervane.guard_design_skill_audit_input() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  guidance jsonb := NEW.document->'designGuidance';
  pinned_sha256 text;
  pinned_references jsonb;
  input_references jsonb;
BEGIN
  SELECT snapshot.sha256, (SELECT jsonb_agg(entry ORDER BY position)
    FROM jsonb_array_elements(snapshot.document->'entries') WITH ORDINALITY AS pinned(entry, position)
    WHERE entry->>'kind' = 'design_skill')
  INTO pinned_sha256, pinned_references
  FROM itervane.task_rule_snapshots snapshot
  WHERE snapshot.task_id = NEW.task_id AND snapshot.project_id = NEW.project_id AND snapshot.purpose = 'delivery';

  IF pinned_references IS NULL AND guidance IS NULL THEN RETURN NEW; END IF;
  IF pinned_references IS NULL OR jsonb_typeof(guidance->'entries') IS DISTINCT FROM 'array'
    OR guidance->>'snapshotSha256' IS DISTINCT FROM pinned_sha256 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_audit_design_snapshot_binding';
  END IF;
  SELECT jsonb_agg(entry->'reference' ORDER BY position) INTO input_references
  FROM jsonb_array_elements(guidance->'entries') WITH ORDINALITY AS bound(entry, position);
  IF input_references IS DISTINCT FROM pinned_references THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_audit_design_snapshot_binding';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_audit_input_design_skills BEFORE INSERT ON itervane.formal_audit_inputs
FOR EACH ROW EXECUTE FUNCTION itervane.guard_design_skill_audit_input();
--> statement-breakpoint
CREATE FUNCTION itervane.guard_design_skill_audit_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  guidance jsonb;
BEGIN
  SELECT input.document->'designGuidance' INTO guidance
  FROM itervane.formal_audit_inputs input WHERE input.run_id = NEW.run_id AND input.sha256 = NEW.input_sha256;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.document->'evidence') AS evidence(item)
    LEFT JOIN LATERAL jsonb_array_elements(guidance->'entries') AS pinned(entry)
      ON item->>'kind' = 'rule' AND item->>'ruleId' = entry->>'ruleId'
    WHERE (item ? 'designSkill' OR entry IS NOT NULL)
      AND (entry IS NULL OR item->>'sha256' IS DISTINCT FROM entry#>>'{reference,versionSha256}'
        OR item->'designSkill' IS DISTINCT FROM jsonb_build_object('authority', 'advisory',
          'snapshotSha256', guidance->'snapshotSha256', 'reference', entry->'reference', 'version', entry->'version'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_audit_design_evidence_binding';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER formal_audit_result_design_skills BEFORE INSERT ON itervane.formal_audit_results
FOR EACH ROW EXECUTE FUNCTION itervane.guard_design_skill_audit_evidence();
