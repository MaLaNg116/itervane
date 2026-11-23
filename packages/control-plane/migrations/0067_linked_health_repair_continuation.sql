CREATE OR REPLACE FUNCTION itervane.guard_formal_repair_retry() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_repair_retry_is_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM itervane.execution_slot slot
    JOIN itervane.tasks task ON task.id = slot.task_id
    JOIN itervane.projects project ON project.id = task.project_id
    JOIN itervane.task_runs parent ON parent.id = slot.run_id AND parent.task_id = task.id
    JOIN itervane.task_runs child ON child.id = NEW.run_id AND child.task_id = task.id
    JOIN itervane.formal_verification_results result ON result.run_id = parent.id
    JOIN itervane.formal_verification_inputs input ON input.run_id = parent.id AND input.sha256 = result.input_sha256
    LEFT JOIN itervane.formal_repair_results repair ON repair.run_id = parent.id AND repair.sha256 = input.document#>>'{subject,resultSha256}'
    WHERE slot.id = 1 AND task.id = NEW.task_id AND task.state = 'running' AND parent.state = 'running'
      AND parent.id = NEW.previous_run_id AND parent.generation = task.generation
      AND child.generation = parent.generation + 1 AND child.role = 'audit' AND child.state = 'queued' AND child.wakeup_job_id IS NULL
      AND slot.fence = NEW.prepared_fence AND slot.worker_id = NEW.worker_id AND slot.lease_until > pg_catalog.clock_timestamp()
      AND result.document->>'status' = 'reviewed' AND result.finalized_fence = NEW.prepared_fence AND result.worker_id = NEW.worker_id
      AND NEW.document->>'projectId' = task.project_id::text AND NEW.document->>'generation' = child.generation::text
      AND NEW.document#>>'{source,repositoryId}' = task.repository_id::text AND NEW.document#>>'{source,commit}' = task.commit
      AND NEW.document->>'baseSnapshotSha256' = input.document#>>'{inspection,snapshotSha256}'
      AND NEW.document->>'catalogSha256' = input.document->>'catalogSha256'
      AND NEW.document#>>'{previous,verificationResultSha256}' = result.sha256
      AND NEW.document#>>'{previous,receiptSha256}' = result.receipt_sha256
      AND (
        EXISTS (SELECT 1 FROM itervane.workspace_members owner
          WHERE owner.workspace_id = project.workspace_id AND owner.principal_id = task.requested_by AND owner.grant_id = NEW.grant_id)
        OR EXISTS (SELECT 1 FROM itervane.project_members member
          WHERE member.project_id = task.project_id AND member.principal_id = task.requested_by AND member.role = 'maintainer' AND member.grant_id = NEW.grant_id)
      )
      AND CASE
        WHEN NEW.document->>'kind' = 'linked_health' THEN
          parent.generation = 1 AND input.document#>>'{subject,kind}' = 'original' AND repair.run_id IS NULL
          AND NEW.document#>>'{previous,subjectManifestSha256}' = input.document#>>'{subject,manifestSha256}'
          AND NEW.document#>'{previous,regression}' = input.document->'healthRegression'
          AND result.document#>>'{review,outcome}' = 'checks_failed'
          AND result.document#>'{evidence,source}' = '{"status":"compared","introduced":0,"remaining":0,"resolved":0}'::jsonb
          AND result.document#>>'{evidence,build,status}' = 'built'
          AND result.document#>>'{evidence,baseline,status}' = 'passed'
          AND result.document#>'{evidence,baseline,healthFollowup}' = '{"status":"unhealthy","code":"application_unhealthy","statusCode":503}'::jsonb
          AND EXISTS (
            SELECT 1 FROM itervane.operations_repair_admissions admission
            JOIN itervane.operations_repair_proposals proposal ON proposal.id = admission.proposal_id
            JOIN itervane.operations_health_samples sample
              ON sample.sequence::text = input.document#>>'{healthRegression,sampleSequence}'
            WHERE admission.task_id = task.id AND admission.run_id = parent.id AND admission.grant_id = NEW.grant_id
              AND admission.actor_id = task.requested_by AND admission.source_commit = task.commit
              AND proposal.id::text = input.document#>>'{healthRegression,proposalId}'
              AND proposal.document#>>'{diagnosis,sha256}' = input.document#>>'{healthRegression,diagnosisSha256}'
              AND proposal.document#>>'{target,publicationProofSha256}' = input.document#>>'{healthRegression,publicationProofSha256}'
              AND proposal.document#>>'{incident,id}' = input.document#>>'{healthRegression,incidentId}'
              AND proposal.document#>>'{incident,sampleSequence}' = sample.sequence::text AND sample.incident_id::text = proposal.document#>>'{incident,id}'
              AND sample.binding = proposal.document->'target' AND sample.signal->>'status' = 'unhealthy'
              AND sample.signal->>'reason' = 'application_unhealthy'
              AND sample.signal->>'evidenceSha256' = input.document#>>'{healthRegression,sampleEvidenceSha256}'
          )
        WHEN NOT (NEW.document ? 'kind') THEN
          input.document#>>'{subject,kind}' = 'repair' AND repair.document->>'status' = 'candidate_ready'
          AND NEW.document#>>'{previous,candidateManifestSha256}' = input.document#>>'{subject,manifestSha256}'
          AND NEW.document#>>'{previous,patchSha256}' = input.document#>>'{subject,patchSha256}'
          AND NEW.document#>>'{previous,operationId}' = input.document#>>'{subject,operationId}'
          AND NEW.document#>>'{previous,patchShape,files}' = pg_catalog.jsonb_array_length(repair.document#>'{candidate,changes}')::text
          AND NEW.document#>>'{previous,failure,outcome}' = result.document#>>'{review,outcome}'
          AND (
            (result.document#>>'{review,outcome}' = 'source_findings'
              AND result.document#>>'{evidence,source,status}' = 'compared'
              AND (NEW.document#>'{previous,failure}') - 'outcome' = (result.document#>'{evidence,source}') - 'status')
            OR (result.document#>>'{review,outcome}' = 'checks_failed'
              AND (NEW.document#>'{previous,failure}') - 'outcome' = jsonb_build_object(
                'buildCode', CASE WHEN result.document#>>'{evidence,build,status}' = 'failed' THEN result.document#>>'{evidence,build,code}' END,
                'checks', CASE WHEN result.document#>>'{evidence,baseline,status}' = 'failed' THEN result.document#>'{evidence,baseline,failures}'
                  ELSE '[]'::jsonb END))
          )
        ELSE false END
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_repair_retry_authority_or_evidence_mismatch';
  END IF;
  RETURN NEW;
END
$$;
