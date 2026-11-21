CREATE TABLE "itervane"."formal_release_steps" (
	"operation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"prepared_fence" integer NOT NULL,
	"prepared_by" uuid NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"proof" jsonb,
	"settled_fence" integer,
	"settled_by" uuid,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "formal_release_steps_operation_id_kind_prepared_fence_pk" PRIMARY KEY("operation_id","kind","prepared_fence"),
	CONSTRAINT "formal_release_step_kind" CHECK ("itervane"."formal_release_steps"."kind" IN ('archive', 'registry') AND "itervane"."formal_release_steps"."prepared_fence" > 0),
	CONSTRAINT "formal_release_step_state" CHECK ((
    ("itervane"."formal_release_steps"."state" = 'prepared' AND "itervane"."formal_release_steps"."proof" IS NULL AND "itervane"."formal_release_steps"."settled_fence" IS NULL AND "itervane"."formal_release_steps"."settled_by" IS NULL AND "itervane"."formal_release_steps"."settled_at" IS NULL)
    OR ("itervane"."formal_release_steps"."state" IN ('confirmed', 'uncertain') AND "itervane"."formal_release_steps"."settled_fence" >= "itervane"."formal_release_steps"."prepared_fence"
      AND "itervane"."formal_release_steps"."settled_by" IS NOT NULL AND "itervane"."formal_release_steps"."settled_at" IS NOT NULL AND (
        ("itervane"."formal_release_steps"."state" = 'confirmed' AND "itervane"."formal_release_steps"."proof" IS NOT NULL AND octet_length("itervane"."formal_release_steps"."proof"::text) <= 8192)
        OR ("itervane"."formal_release_steps"."kind" = 'registry' AND "itervane"."formal_release_steps"."state" = 'uncertain' AND "itervane"."formal_release_steps"."proof" IS NULL)
      ))
  ) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."formal_release_steps" ADD CONSTRAINT "formal_release_steps_operation_id_release_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "itervane"."release_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "formal_release_single_registry_intent" ON "itervane"."formal_release_steps" USING btree ("operation_id") WHERE "itervane"."formal_release_steps"."kind" = 'registry';
--> statement-breakpoint
CREATE FUNCTION itervane.guard_formal_release_step() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  manifest jsonb;
  mapping jsonb;
  bound_candidate_id uuid;
  bound_decision_version integer;
  bound_workspace_id uuid;
  current_state text;
  current_phase text;
  current_fence integer;
  current_worker uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_step_is_immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    (OLD.operation_id, OLD.kind, OLD.prepared_fence, OLD.prepared_by, OLD.created_at)
      IS DISTINCT FROM (NEW.operation_id, NEW.kind, NEW.prepared_fence, NEW.prepared_by, NEW.created_at)
    OR OLD.state = 'confirmed'
    OR (OLD.kind = 'archive' AND (NEW.state <> 'confirmed' OR NEW.settled_fence <> OLD.prepared_fence))
    OR (OLD.kind = 'registry' AND NEW.state NOT IN ('confirmed', 'uncertain'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_step_is_immutable';
  END IF;

  SELECT candidate.document, target.document, candidate.id, operation.approval_version, project.workspace_id,
    task.state::text, runtime.reason, slot.fence, slot.worker_id
  INTO manifest, mapping, bound_candidate_id, bound_decision_version, bound_workspace_id,
    current_state, current_phase, current_fence, current_worker
  FROM itervane.release_operations operation
  JOIN itervane.release_candidates candidate ON candidate.id = operation.candidate_id AND candidate.environment_id = operation.environment_id
  JOIN itervane.tasks task ON task.id = candidate.task_id AND task.project_id = candidate.project_id
    AND task.requested_by = candidate.requested_by AND task.generation::text = candidate.document->>'generation'
  JOIN itervane.projects project ON project.id = task.project_id
  JOIN itervane.task_runs run ON run.id = candidate.run_id AND run.task_id = task.id AND run.generation = task.generation AND run.state = task.state
  JOIN itervane.run_runtime runtime ON runtime.run_id = run.id AND runtime.task_id = task.id
  JOIN itervane.execution_slot slot ON slot.task_id = task.id AND slot.run_id = run.id
  LEFT JOIN itervane.formal_release_targets target ON target.environment_id = operation.environment_id AND target.project_id = task.project_id
    AND target.application_id = candidate.application_id AND target.sha256 = candidate.document#>>'{target,mappingSha256}'
    AND target.revision::text = candidate.document#>>'{target,revision}'
  WHERE operation.id = NEW.operation_id AND candidate.document->>'origin' = 'formal_verification'
    AND operation.state IN ('dispatching', 'reconciling') AND slot.lease_until > pg_catalog.clock_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_step_authority';
  END IF;

  IF TG_OP = 'INSERT' OR NEW.kind = 'archive' THEN
    IF current_phase IS DISTINCT FROM 'release_claimed' OR current_state <> 'running' OR mapping IS NULL
      OR (manifest->>'validUntil')::timestamptz <= pg_catalog.clock_timestamp()
      OR NOT EXISTS (
        SELECT 1 FROM itervane.release_decisions decision
        JOIN itervane.workspace_members owner ON owner.principal_id = decision.actor_id AND owner.grant_id = decision.grant_id
        WHERE decision.candidate_id = bound_candidate_id AND decision.version = bound_decision_version AND decision.action = 'confirm'
          AND owner.workspace_id = bound_workspace_id AND NOT EXISTS (
            SELECT 1 FROM itervane.release_decisions later
            WHERE later.candidate_id = decision.candidate_id AND later.version > decision.version
          )
      ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_step_authority';
    END IF;
  ELSIF current_phase NOT IN ('release_registry_prepared', 'release_registry_reconciling')
    OR current_phase IS NULL OR current_state NOT IN ('running', 'cancel_requested') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_step_authority';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'prepared' OR (NEW.prepared_fence, NEW.prepared_by) IS DISTINCT FROM (current_fence, current_worker) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_step_authority';
    END IF;
    IF NEW.kind = 'registry' AND NOT EXISTS (
      SELECT 1 FROM itervane.formal_release_steps archive
      WHERE archive.operation_id = NEW.operation_id AND archive.kind = 'archive' AND archive.state = 'confirmed'
        AND archive.prepared_fence = current_fence AND archive.settled_fence = current_fence
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_archive_required';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.settled_fence, NEW.settled_by) IS DISTINCT FROM (current_fence, current_worker) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_step_authority';
  END IF;
  IF NEW.state = 'confirmed' AND (
    NEW.proof->'archive' IS DISTINCT FROM manifest#>'{image,archive}'
    OR (NEW.kind = 'archive' AND (
      NEW.proof->>'kind' IS DISTINCT FROM 'archive_verified' OR NEW.proof->'version' IS DISTINCT FROM '1'::jsonb
      OR NEW.proof->>'runnerImageSha256' IS DISTINCT FROM manifest#>>'{image,runnerImageSha256}'
    ))
    OR (NEW.kind = 'registry' AND (
      mapping->>'registryOrigin' IS NULL OR NEW.proof->>'registryOrigin' IS DISTINCT FROM mapping->>'registryOrigin'
      OR NEW.proof->>'repository' IS DISTINCT FROM mapping->>'imageRepository'
      OR NEW.proof->>'manifestDigest' IS DISTINCT FROM manifest#>>'{image,manifestDigest}'
      OR NEW.proof->>'configDigest' IS DISTINCT FROM manifest#>>'{image,configDigest}'
    ))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'formal_release_step_proof_mismatch';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER formal_release_step_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.formal_release_steps
FOR EACH ROW EXECUTE FUNCTION itervane.guard_formal_release_step();
