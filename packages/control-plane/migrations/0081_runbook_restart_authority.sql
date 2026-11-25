ALTER TABLE "itervane"."operations_restart_recoveries" DROP CONSTRAINT "operations_restart_recovery_lifecycle";--> statement-breakpoint
ALTER TABLE "itervane"."operations_restart_recoveries" ADD CONSTRAINT "operations_restart_recovery_lifecycle" CHECK ((
    ("itervane"."operations_restart_recoveries"."state" = 'observing' AND "itervane"."operations_restart_recoveries"."completed_at" IS NULL AND "itervane"."operations_restart_recoveries"."failure" IS NULL AND "itervane"."operations_restart_recoveries"."proof" IS NULL)
    OR ("itervane"."operations_restart_recoveries"."completed_at" >= "itervane"."operations_restart_recoveries"."created_at" AND (
      ("itervane"."operations_restart_recoveries"."state" = 'verified' AND "itervane"."operations_restart_recoveries"."failure" IS NULL AND "itervane"."operations_restart_recoveries"."proof" IS NOT NULL)
      OR ("itervane"."operations_restart_recoveries"."state" = 'retry' AND "itervane"."operations_restart_recoveries"."attempt" < 3 AND "itervane"."operations_restart_recoveries"."failure" IN ('unhealthy', 'unavailable', 'lease_expired') AND "itervane"."operations_restart_recoveries"."proof" IS NULL)
      OR ("itervane"."operations_restart_recoveries"."state" = 'manual_review' AND (
        ("itervane"."operations_restart_recoveries"."failure" = 'native_unconfirmed' AND "itervane"."operations_restart_recoveries"."proof" IS NOT NULL)
        OR ("itervane"."operations_restart_recoveries"."failure" IN ('missing_evidence', 'target_changed', 'unhealthy') AND "itervane"."operations_restart_recoveries"."proof" IS NULL)
        OR ("itervane"."operations_restart_recoveries"."attempt" = 3 AND "itervane"."operations_restart_recoveries"."failure" IN ('unavailable', 'lease_expired') AND "itervane"."operations_restart_recoveries"."proof" IS NULL)
      ))
    ))) IS TRUE);
--> statement-breakpoint
CREATE FUNCTION itervane.guard_restart_runbook_proposal() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  observed_state text;
  guidance jsonb;
  fact_id text;
  cited jsonb;
  selected jsonb;
  expected jsonb;
BEGIN
  IF NEW.document#>>'{action,kind}' = 'restart' THEN
    SELECT observed.document#>>'{observation,state}', evidence.document#>'{result,runbooks}',
      fact->>'evidenceId', diagnosis.document#>'{result,recommendation,evidenceIds}'
    INTO observed_state, guidance, fact_id, cited
    FROM itervane.operations_diagnosis_results diagnosis
    JOIN itervane.operations_observations observed ON observed.run_id = diagnosis.run_id
    JOIN itervane.operations_diagnosis_reads evidence ON evidence.run_id = diagnosis.run_id AND evidence.section = 'release' AND evidence.state = 'recorded'
    CROSS JOIN LATERAL jsonb_array_elements(diagnosis.document#>'{result,facts}') fact
    WHERE diagnosis.run_id = NEW.diagnosis_run_id AND fact->>'section' = 'release';
    selected := guidance->'byState'->observed_state;
    IF selected->>'status' = 'ambiguous' OR (selected->>'status' = 'available' AND (cited ? fact_id) IS NOT TRUE) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_runbook_citation';
    END IF;
    IF selected->>'status' = 'available' THEN
      expected := jsonb_build_object('snapshotSha256', guidance->>'snapshotSha256', 'evidenceId', fact_id,
        'observedState', observed_state, 'selection', selected);
    END IF;
  END IF;
  IF NEW.document->'runbook' IS DISTINCT FROM expected THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_runbook_proposal_binding';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER operations_restart_runbook_proposal BEFORE INSERT ON itervane.operations_proposals
FOR EACH ROW EXECUTE FUNCTION itervane.guard_restart_runbook_proposal();
--> statement-breakpoint
CREATE FUNCTION itervane.guard_restart_runbook_effect() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  binding jsonb;
  baseline jsonb;
  used integer;
BEGIN
  SELECT proposal.document->'runbook' INTO binding
  FROM itervane.operations_executions execution
  JOIN itervane.operations_proposals proposal ON proposal.id = execution.proposal_id
  WHERE execution.id = NEW.execution_id;
  IF binding IS NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'operations_restart_requests' THEN
    baseline := NEW.runtime_baseline;
  ELSE
    SELECT runtime_baseline INTO baseline FROM itervane.operations_restart_requests WHERE execution_id = NEW.execution_id;
  END IF;
  SELECT count(*) INTO used FROM itervane.operations_restart_resumes
  WHERE execution_id = NEW.execution_id AND state IN ('prepared', 'acknowledged', 'unknown');
  IF (baseline->>'state' = binding->>'observedState' AND used < (binding#>>'{selection,controls,maxNativeAttempts}')::integer) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_runbook_effect_binding';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER operations_restart_runbook_request BEFORE INSERT ON itervane.operations_restart_requests
FOR EACH ROW EXECUTE FUNCTION itervane.guard_restart_runbook_effect();
--> statement-breakpoint
CREATE TRIGGER operations_restart_runbook_resume BEFORE UPDATE OF state ON itervane.operations_restart_resumes
FOR EACH ROW WHEN (NEW.state = 'prepared') EXECUTE FUNCTION itervane.guard_restart_runbook_effect();
--> statement-breakpoint
CREATE FUNCTION itervane.guard_restart_runbook_health() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  uses_runbook boolean;
BEGIN
  SELECT proposal.document ? 'runbook' INTO uses_runbook
  FROM itervane.operations_executions execution
  JOIN itervane.operations_proposals proposal ON proposal.id = execution.proposal_id
  WHERE execution.id = NEW.execution_id;
  IF (NEW.state = 'retry' AND uses_runbook) OR (NEW.state = 'manual_review' AND NEW.attempt < 3 AND uses_runbook IS NOT TRUE) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_runbook_health_stop';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER operations_restart_runbook_health BEFORE UPDATE ON itervane.operations_restart_recoveries
FOR EACH ROW WHEN (NEW.failure = 'unhealthy') EXECUTE FUNCTION itervane.guard_restart_runbook_health();
