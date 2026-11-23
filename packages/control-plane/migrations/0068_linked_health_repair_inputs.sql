CREATE OR REPLACE FUNCTION itervane.guard_formal_audit_input() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_audit_input_is_retained';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.execution_slot slot
    JOIN itervane.tasks task ON task.id = slot.task_id
    JOIN itervane.task_runs run ON run.id = slot.run_id AND run.task_id = task.id
    JOIN itervane.inspection_attempts inspection ON inspection.run_id = run.id AND inspection.task_id = task.id
    LEFT JOIN itervane.formal_repair_retries continuation ON continuation.run_id = run.id AND continuation.document->>'kind' = 'linked_health'
    WHERE slot.id = 1 AND slot.fence = NEW.prepared_fence AND slot.worker_id = NEW.worker_id
      AND slot.lease_until > pg_catalog.clock_timestamp() AND task.state = 'running'
      AND task.id = NEW.task_id AND run.id = NEW.run_id AND task.project_id = NEW.project_id
      AND run.generation = task.generation AND inspection.generation = task.generation
      AND NEW.document->>'generation' = task.generation::text AND NEW.document->>'locale' = task.locale
      AND NEW.document->>'dataClass' = task.data_class
      AND (NEW.document->'healthReproduction') IS NOT DISTINCT FROM (continuation.document->'previous')
      AND (continuation.run_id IS NULL OR continuation.document->>'baseSnapshotSha256' = NEW.document#>>'{inspection,snapshotSha256}')
      AND NEW.document->>'purposeSha256' = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(task.purpose, 'UTF8')), 'hex')
      AND NEW.document#>>'{source,repositoryId}' = task.repository_id::text AND NEW.document#>>'{source,commit}' = task."commit"
      AND inspection.request_id = NEW.inspection_request_id AND inspection.state = 'recorded' AND inspection.workspace_sha256 IS NOT NULL
      AND NEW.document#>>'{inspection,receiptSha256}' = inspection.receipt_sha256
      AND NEW.document#>>'{inspection,planSha256}' = inspection.plan_sha256
      AND NEW.document#>>'{inspection,snapshotSha256}' = inspection.receipt#>>'{snapshot,manifestSha256}'
      AND inspection.receipt#>>'{snapshot,reports,0,status}' = 'completed'
      AND inspection.receipt#>>'{snapshot,reports,1,status}' = 'completed'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_audit_input_authority_or_inspection_mismatch';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION itervane.guard_formal_repair_input() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_repair_input_is_retained';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.execution_slot slot
    JOIN itervane.tasks task ON task.id = slot.task_id
    JOIN itervane.task_runs run ON run.id = slot.run_id AND run.task_id = task.id
    JOIN itervane.formal_audit_inputs input ON input.run_id = run.id AND input.task_id = task.id
    JOIN itervane.formal_audit_results audit ON audit.run_id = run.id AND audit.input_sha256 = input.sha256
    WHERE slot.id = 1 AND run.id = NEW.run_id AND slot.fence = NEW.prepared_fence AND slot.worker_id = NEW.worker_id
      AND slot.lease_until > pg_catalog.clock_timestamp() AND task.state = 'running' AND task.generation = run.generation
      AND audit.document->>'status' = 'completed' AND audit.document->>'reason' = 'audit_complete'
      AND audit.document#>>'{checklist,coverage}' = 'complete' AND audit.document#>'{checklist,hypotheses}' = '[]'::jsonb
      AND pg_catalog.jsonb_typeof(audit.document#>'{checklist,findings}') = 'array'
      AND NEW.document->>'taskId' = task.id::text AND NEW.document->>'projectId' = task.project_id::text
      AND NEW.document->>'generation' = task.generation::text AND NEW.document->>'locale' = task.locale
      AND NEW.document->>'dataClass' = task.data_class AND NEW.document->'source' = input.document->'source'
      AND NEW.document->'inspection' = input.document->'inspection'
      AND NEW.document#>>'{audit,inputSha256}' = input.sha256 AND NEW.document#>>'{audit,resultSha256}' = audit.sha256
      AND NEW.document#>>'{audit,checkpointId}' = audit.checkpoint_id
      AND NEW.document->>'catalogSha256' = input.document#>>'{catalog,sha256}'
      AND NEW.document->'healthReproduction' IS NOT DISTINCT FROM input.document->'healthReproduction'
      AND CASE WHEN input.document ? 'healthReproduction' THEN
        audit.document#>'{checklist,findings}' = '[]'::jsonb
        AND NEW.document->'findingIds' = jsonb_build_array(input.document#>>'{healthReproduction,receiptSha256}')
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(audit.document->'evidence') entry
          WHERE entry->>'kind' = 'health_reproduction' AND entry->'reproduction' = input.document->'healthReproduction'
            AND (audit.document#>'{checklist,evidenceIds}') ? (entry->>'id')
        )
      ELSE NEW.document->'findingIds' = pg_catalog.jsonb_path_query_array(audit.document, '$.checklist.findings[*].id') END
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_repair_input_authority_or_audit_mismatch';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION itervane.guard_formal_verification_input() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_verification_input_is_retained';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.execution_slot slot
    JOIN itervane.tasks task ON task.id = slot.task_id
    JOIN itervane.task_runs run ON run.id = slot.run_id AND run.task_id = task.id
    JOIN itervane.formal_repair_inputs handoff ON handoff.run_id = run.id
    JOIN itervane.inspection_attempts scan ON scan.run_id = run.id AND scan.state = 'recorded'
    LEFT JOIN itervane.formal_repair_results repair ON repair.run_id = run.id
    LEFT JOIN itervane.formal_repair_attempts attempt ON attempt.request_id = repair.request_id AND attempt.state = 'recorded'
    LEFT JOIN itervane.formal_repair_operations operation ON operation.operation_id = attempt.operation_id
    WHERE slot.id = 1 AND run.id = NEW.run_id AND slot.fence = NEW.prepared_fence AND slot.worker_id = NEW.worker_id
      AND slot.lease_until > pg_catalog.clock_timestamp() AND task.state = 'running' AND task.generation = run.generation
      AND NEW.document->>'taskId' = task.id::text AND NEW.document->>'projectId' = task.project_id::text
      AND NEW.document->>'generation' = task.generation::text AND NEW.document->>'locale' = task.locale
      AND NEW.document->>'dataClass' = task.data_class AND NEW.document->'source' = handoff.document->'source'
      AND NEW.document->'inspection' = handoff.document->'inspection' AND NEW.document->'audit' = handoff.document->'audit'
      AND NEW.document->>'catalogSha256' = handoff.document->>'catalogSha256'
      AND NEW.document->'healthReproduction' IS NOT DISTINCT FROM handoff.document->'healthReproduction'
      AND scan.request_id::text = NEW.document#>>'{inspection,requestId}' AND scan.receipt_sha256 = NEW.document#>>'{inspection,receiptSha256}'
      AND NOT pg_catalog.jsonb_path_exists(scan.receipt, '$.snapshot.reports[*] ? (@.status != "completed")')
      AND (CASE NEW.document#>>'{subject,kind}'
        WHEN 'original' THEN repair.run_id IS NULL AND handoff.document->'findingIds' = '[]'::jsonb
          AND NOT pg_catalog.jsonb_path_exists(scan.receipt, '$.snapshot.reports[*].findings[0]')
          AND NEW.document#>>'{subject,manifestSha256}' = NEW.document#>>'{inspection,snapshotSha256}'
        WHEN 'repair' THEN repair.document->>'status' = 'candidate_ready'
          AND CASE WHEN handoff.document ? 'healthReproduction' THEN
            NOT pg_catalog.jsonb_path_exists(scan.receipt, '$.snapshot.reports[*].findings[0]')
            AND NEW.document->'healthRegression' = handoff.document#>'{healthReproduction,regression}'
            AND operation.command::jsonb#>>'{workspace,healthReproductionSha256}' = handoff.document#>>'{healthReproduction,receiptSha256}'
          ELSE pg_catalog.jsonb_path_exists(scan.receipt, '$.snapshot.reports[*].findings[0]') END
          AND handoff.sha256 = NEW.document#>>'{subject,inputSha256}' AND repair.sha256 = NEW.document#>>'{subject,resultSha256}'
          AND repair.checkpoint_id = NEW.document#>>'{subject,checkpointId}'
          AND attempt.request_id::text = NEW.document#>>'{subject,requestId}' AND attempt.receipt_sha256 = NEW.document#>>'{subject,receiptSha256}'
          AND operation.run_id = NEW.run_id AND operation.operation_id::text = NEW.document#>>'{subject,operationId}'
          AND operation.command_sha256 = NEW.document#>>'{subject,commandSha256}'
          AND repair.document#>>'{candidate,patchSha256}' = NEW.document#>>'{subject,patchSha256}'
          AND repair.document#>>'{candidate,manifestSha256}' = NEW.document#>>'{subject,manifestSha256}'
        ELSE false END) IS TRUE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_verification_input_authority_or_source_mismatch';
  END IF;
  RETURN NEW;
END
$$;
