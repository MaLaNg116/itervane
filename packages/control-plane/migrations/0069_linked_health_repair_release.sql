CREATE OR REPLACE FUNCTION itervane.guard_formal_rescan_image_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  verification_input jsonb;
  requested jsonb;
  followup_requested boolean;
  baseline jsonb;
  image jsonb;
BEGIN
  IF NEW.state <> 'recorded' THEN
    RETURN NEW;
  END IF;
  SELECT document INTO STRICT verification_input
  FROM itervane.formal_verification_inputs WHERE run_id = NEW.run_id;
  requested := verification_input#>'{profile,ociInputsSha256}';
  followup_requested := verification_input ? 'healthRegression';
  baseline := NEW.receipt#>'{snapshot,build,baseline}';
  image := baseline->'image';
  IF NEW.receipt#>'{scope,healthFollowup}' IS DISTINCT FROM (CASE WHEN followup_requested THEN 'true'::jsonb END)
    OR (baseline ? 'healthFollowup') IS TRUE AND (NOT followup_requested OR baseline->>'status' NOT IN ('passed', 'failed'))
    OR followup_requested AND baseline->>'status' IN ('passed', 'failed')
      AND (baseline#>>'{healthFollowup,status}' IN ('passed', 'unhealthy', 'unavailable')) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'standard_health_followup_evidence_binding';
  END IF;
  IF NEW.receipt#>'{scope,ociInputsSha256}' IS DISTINCT FROM requested THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'standard_image_scope_binding';
  END IF;
  IF requested IS NOT NULL AND baseline->>'status' = 'passed'
    AND (NOT followup_requested OR baseline#>>'{healthFollowup,status}' = 'passed') THEN
    IF (image->'ociInputsSha256' = requested
      AND image->'runtimeInputsSha256' = baseline->'runtimeInputsSha256'
      AND CASE image->>'status'
        WHEN 'blocked' THEN image->>'code' IN ('image_inputs', 'runtime_projection', 'image_compose', 'image_scan')
        WHEN 'scanned' THEN image->>'platform' = 'linux/amd64'
          AND image->>'manifestDigest' ~ '^sha256:[a-f0-9]{64}$'
          AND image->>'configDigest' ~ '^sha256:[a-f0-9]{64}$'
          AND image#>'{scan,imageDigest}' = image->'manifestDigest'
          AND image#>'{scan,configDigest}' = image->'configDigest'
          AND image#>'{scan,database}' = NEW.receipt#>'{snapshot,reports,1,database}'
        ELSE false
      END) IS NOT TRUE THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'standard_image_evidence_binding';
    END IF;
  ELSIF image IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'unexpected_standard_image_evidence';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION itervane.guard_formal_release_candidate() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM itervane.tasks task
    JOIN itervane.task_runs run ON run.task_id = task.id AND run.generation = task.generation AND run.id = NEW.run_id
    JOIN itervane.run_runtime runtime ON runtime.run_id = run.id AND runtime.task_id = task.id
    JOIN itervane.formal_verification_results result ON result.run_id = run.id
    JOIN itervane.formal_verification_inputs input ON input.run_id = run.id AND input.sha256 = result.input_sha256
    JOIN itervane.formal_release_targets target ON target.environment_id = NEW.environment_id
      AND target.project_id = task.project_id AND target.application_id = NEW.application_id
    WHERE task.id = NEW.task_id AND task.project_id = NEW.project_id AND task.requested_by = NEW.requested_by
      AND ((task.state = 'waiting_input' AND runtime.reason = 'verification_observed')
        OR (task.state = 'waiting_approval' AND runtime.reason = 'release_candidate_ready'))
      AND run.state = task.state AND run.generation::text = NEW.document->>'generation'
      AND task.repository_id::text = NEW.document#>>'{source,repositoryId}' AND task.commit = NEW.document#>>'{source,commit}'
      AND result.document->>'status' = 'reviewed' AND result.document#>>'{review,outcome}' = 'observed'
      AND result.document#>>'{archiveVerification,kind}' = 'archive_verified'
      AND result.document#>>'{evidence,source,status}' = 'compared' AND result.document#>>'{evidence,build,status}' = 'built'
      AND result.document#>>'{evidence,baseline,status}' = 'passed' AND result.document#>>'{evidence,image,status}' = 'scanned'
      AND (NOT (input.document ? 'healthRegression') OR (
        input.document#>>'{subject,kind}' = 'repair' AND input.document ? 'healthReproduction'
        AND result.document#>'{evidence,baseline,healthFollowup}' = '{"status":"passed","code":null,"statusCode":200}'::jsonb
      ))
      AND result.sha256 = NEW.document#>>'{verification,resultSha256}'
      AND result.receipt_sha256 = NEW.document#>>'{verification,receiptSha256}'
      AND input.sha256 = NEW.document#>>'{verification,inputSha256}'
      AND input.document->>'catalogSha256' = NEW.document#>>'{verification,catalogSha256}'
      AND input.document#>>'{inspection,snapshotSha256}' = NEW.document->>'originalSnapshotSha256'
      AND input.document#>>'{subject,manifestSha256}' = NEW.document->>'repairedSnapshotSha256'
      AND COALESCE(input.document#>'{subject,patchSha256}', 'null'::jsonb) = NEW.document->'diffSha256'
      AND result.document#>'{evidence,source,introduced}' = '0'::jsonb AND result.document#>'{evidence,source,remaining}' = '0'::jsonb
      AND NEW.document#>'{verification,source}' = (result.document#>'{evidence,source}') - 'status'
      AND NEW.document#>>'{verification,buildSha256}' = result.document#>>'{evidence,build,distSha256}'
      AND NEW.document#>>'{verification,baselineSha256}' = result.document#>>'{evidence,baseline,baselineSha256}'
      AND NEW.document#>>'{image,manifestDigest}' = result.document#>>'{evidence,image,manifestDigest}'
      AND NEW.document#>>'{image,configDigest}' = result.document#>>'{evidence,image,configDigest}'
      AND NEW.document#>>'{image,scanReportSha256}' = result.document#>>'{evidence,image,scanReportSha256}'
      AND NEW.document#>>'{image,scanPolicySha256}' = result.document#>>'{evidence,image,scanPolicySha256}'
      AND NEW.document#>'{image,findings}' = result.document#>'{evidence,image,findings}'
      AND NEW.document#>'{image,archive}' = result.document#>'{archiveVerification,archive}'
      AND NEW.document#>>'{image,runnerImageSha256}' = result.document#>>'{archiveVerification,runnerImageSha256}'
      AND target.revision::text = NEW.document#>>'{target,revision}' AND target.sha256 = NEW.document#>>'{target,mappingSha256}'
      AND target.document->>'verificationProfileSha256' = NEW.document#>>'{verification,profileSha256}'
      AND target.document->>'runtimeConfigSha256' = NEW.document->>'runtimeConfigSha256'
      AND target.document->>'rolloutCheckSha256' = NEW.document->>'rolloutCheckSha256'
      AND target.document->>'recoveryPlanSha256' = NEW.document->>'recoveryPlanSha256'
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements_text(target.document->'blockImageSeverities') AS blocker(severity)
        WHERE ((result.document#>'{evidence,image,findings}')->>blocker.severity)::integer > 0
      )
      AND (NEW.document->>'validUntil')::timestamptz > pg_catalog.clock_timestamp()
      AND (NEW.document->>'validUntil')::timestamptz <= NEW.created_at
        + pg_catalog.make_interval(secs => (target.document->>'approvalTtlSeconds')::integer)
      AND (NEW.document->>'validUntil')::timestamptz <= result.created_at
        + pg_catalog.make_interval(secs => (target.document->>'verificationMaxAgeSeconds')::integer)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_candidate_binding';
  END IF;
  RETURN NEW;
END
$$;
