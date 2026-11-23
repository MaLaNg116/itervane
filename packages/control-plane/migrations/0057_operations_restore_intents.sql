ALTER TABLE "itervane"."operations_execution_intents" ADD COLUMN "restore_plan" jsonb;--> statement-breakpoint
ALTER TABLE "itervane"."operations_execution_intents" ADD COLUMN "restore_plan_sha256" text;--> statement-breakpoint
ALTER TABLE "itervane"."operations_execution_intents" ADD CONSTRAINT "operations_restore_plan_binding" CHECK ((("itervane"."operations_execution_intents"."restore_plan" IS NULL AND "itervane"."operations_execution_intents"."restore_plan_sha256" IS NULL)
    OR ("itervane"."operations_execution_intents"."restore_plan"->>'version' = '1' AND "itervane"."operations_execution_intents"."restore_plan_sha256" ~ '^[a-f0-9]{64}$'
      AND octet_length("itervane"."operations_execution_intents"."restore_plan"::text) <= 4096)) IS TRUE);
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_restore_plan() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  expected jsonb;
BEGIN
  -- The existing BEFORE trigger checks the decision and lease and locks the environment.
  IF NEW.restore_plan IS NULL AND EXISTS (
    SELECT 1 FROM itervane.operations_executions execution
      JOIN itervane.operations_proposals proposal ON proposal.id = execution.proposal_id
    WHERE execution.id = NEW.execution_id AND proposal.document#>>'{action,kind}' = 'restart'
  ) THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_build_object(
    'version', 1, 'environmentId', execution.environment_id, 'targetRevision', mapping.revision,
    'mappingSha256', mapping.sha256, 'rolloutCheckSha256', mapping.document->>'rolloutCheckSha256',
    'target', jsonb_build_object(
      'komodo', mapping.document->'komodo', 'deploymentId', mapping.deployment_id,
      'serverId', mapping.document->>'serverId', 'imageRepository', mapping.document->>'imageRepository',
      'registryOrigin', mapping.document->>'registryOrigin', 'runtimeConfigSha256', mapping.document->>'runtimeConfigSha256'
    ),
    'current', jsonb_build_object(
      'operationId', request.release_operation_id, 'manifestDigest', request.document->>'manifestDigest',
      'configDigest', request.document->>'configDigest', 'containerId', request.document->>'containerId',
      'proofSha256', proposal.document->>'targetProofSha256'
    ),
    'restore', (proposal.document#>'{action,restore}') || jsonb_build_object('publishedVersion', receipt.proof#>>'{runtime,version}')
  ) INTO expected
    FROM itervane.operations_executions execution
    JOIN itervane.operations_proposals proposal ON proposal.id = execution.proposal_id
    JOIN itervane.operations_requests request ON request.run_id = proposal.diagnosis_run_id
    JOIN itervane.formal_release_targets mapping ON mapping.environment_id = execution.environment_id
      AND mapping.project_id = request.project_id AND mapping.application_id = request.application_id
    JOIN itervane.release_operations prior ON prior.environment_id = execution.environment_id
      AND prior.id::text = proposal.document#>>'{action,restore,operationId}' AND prior.state = 'verified_formal'
    JOIN itervane.formal_release_rollout_attempts receipt ON receipt.operation_id = prior.id AND receipt.state = 'verified'
  WHERE execution.id = NEW.execution_id AND proposal.document#>>'{action,kind}' = 'rollback'
    AND receipt.proof->>'mappingSha256' = mapping.sha256 AND receipt.proof->>'targetRevision' = mapping.revision::text
    AND receipt.proof->>'manifestDigest' = proposal.document#>>'{action,restore,manifestDigest}'
    AND receipt.proof#>>'{runtime,configDigest}' = proposal.document#>>'{action,restore,configDigest}'
    AND receipt.proof#>>'{runtime,version}' ~ '^[a-zA-Z0-9_.-]{1,64}$';

  IF NOT FOUND OR NEW.restore_plan IS DISTINCT FROM expected THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restore_plan_authority_required';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_restore_plan_authority AFTER INSERT ON itervane.operations_execution_intents
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_restore_plan();
