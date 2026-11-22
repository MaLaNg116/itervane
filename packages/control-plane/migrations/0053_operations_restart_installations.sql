CREATE TABLE "itervane"."operations_restart_installations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"environment_id" uuid NOT NULL,
	"enrollment_sha256" text NOT NULL,
	"installation_sha256" text NOT NULL,
	"credential_sha256" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "operations_restart_writer_credential" UNIQUE("credential_sha256"),
	CONSTRAINT "operations_restart_writer_binding" CHECK (("itervane"."operations_restart_installations"."enrollment_sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."operations_restart_installations"."installation_sha256" ~ '^[a-f0-9]{64}$'
    AND "itervane"."operations_restart_installations"."credential_sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."operations_restart_installations"."document"->>'version' = '1'
    AND "itervane"."operations_restart_installations"."document"->>'installationId' = "itervane"."operations_restart_installations"."id"::text AND "itervane"."operations_restart_installations"."document"->>'environmentId' = "itervane"."operations_restart_installations"."environment_id"::text
    AND "itervane"."operations_restart_installations"."document"->>'enrollmentSha256' = "itervane"."operations_restart_installations"."enrollment_sha256"
    AND "itervane"."operations_restart_installations"."document"->>'credentialSha256' = "itervane"."operations_restart_installations"."credential_sha256"
    AND "itervane"."operations_restart_installations"."document"->>'policySha256' ~ '^[a-f0-9]{64}$' AND "itervane"."operations_restart_installations"."document"->>'rolesSha256' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof("itervane"."operations_restart_installations"."document"->'whiskers') = 'object' AND octet_length("itervane"."operations_restart_installations"."document"::text) <= 4096) IS TRUE),
	CONSTRAINT "operations_restart_writer_retirement" CHECK ("itervane"."operations_restart_installations"."retired_at" IS NULL OR "itervane"."operations_restart_installations"."retired_at" >= "itervane"."operations_restart_installations"."created_at")
);
--> statement-breakpoint
ALTER TABLE "itervane"."operations_restart_requests" ADD COLUMN "writer_installation_id" uuid;--> statement-breakpoint
ALTER TABLE "itervane"."operations_restart_installations" ADD CONSTRAINT "operations_restart_installations_environment_id_operations_targets_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "itervane"."operations_targets"("environment_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operations_restart_writer_active" ON "itervane"."operations_restart_installations" USING btree ("environment_id") WHERE "itervane"."operations_restart_installations"."retired_at" IS NULL;--> statement-breakpoint
ALTER TABLE "itervane"."operations_restart_requests" ADD CONSTRAINT "operations_restart_requests_writer_installation_id_operations_restart_installations_id_fk" FOREIGN KEY ("writer_installation_id") REFERENCES "itervane"."operations_restart_installations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_restart_installation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_writer_is_retained';
  END IF;

  PERFORM 1 FROM itervane.environments WHERE id = NEW.environment_id FOR UPDATE;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.environment_id, NEW.enrollment_sha256, NEW.installation_sha256, NEW.credential_sha256, NEW.document, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.environment_id, OLD.enrollment_sha256, OLD.installation_sha256, OLD.credential_sha256, OLD.document, OLD.created_at)
      OR OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_writer_is_immutable';
    END IF;
    NEW.retired_at := GREATEST(OLD.created_at, clock_timestamp());
    RETURN NEW;
  END IF;

  IF NEW.retired_at IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM itervane.operations_targets target
      JOIN itervane.environments environment ON environment.id = target.environment_id AND environment.access = 'protected'
      JOIN itervane.formal_release_targets release ON release.environment_id = target.environment_id
    WHERE target.environment_id = NEW.environment_id AND target.sha256 = NEW.enrollment_sha256
      AND target.document->'whiskers' = NEW.document->'whiskers'
      AND release.sha256 = target.document->>'releaseTargetSha256'
      AND release.revision::text = target.document->>'releaseTargetRevision'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_writer_target_required';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_restart_installation_authority BEFORE INSERT OR UPDATE OR DELETE ON itervane.operations_restart_installations
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_restart_installation();
--> statement-breakpoint
CREATE FUNCTION itervane.has_current_operations_restart_writer(execution_key uuid, installation_key uuid, request jsonb)
RETURNS boolean LANGUAGE sql SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM itervane.operations_executions execution
    JOIN itervane.operations_proposals proposal ON proposal.id = execution.proposal_id
    JOIN itervane.operations_targets target ON target.environment_id = execution.environment_id
    JOIN itervane.operations_restart_installations writer ON writer.environment_id = execution.environment_id
      AND writer.enrollment_sha256 = target.sha256 AND writer.retired_at IS NULL
    WHERE execution.id = execution_key AND writer.id = installation_key
      AND writer.enrollment_sha256 = proposal.document#>>'{target,enrollmentSha256}'
      AND writer.document->'whiskers' = target.document->'whiskers'
      AND writer.credential_sha256 = request->>'credentialSha256'
      AND writer.document#>>'{whiskers,origin}' = request#>>'{target,origin}'
      AND writer.document#>>'{whiskers,serverId}' = request#>>'{target,serverId}'
  );
$$;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_restart_request_writer() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.writer_installation_id IS DISTINCT FROM OLD.writer_installation_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_request_writer_is_immutable';
    END IF;
  ELSIF NOT itervane.has_current_operations_restart_writer(NEW.execution_id, NEW.writer_installation_id, NEW.document) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_request_writer_required';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_restart_request_writer BEFORE INSERT OR UPDATE ON itervane.operations_restart_requests
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_restart_request_writer();
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_restart_resume_writer() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW.state = 'prepared') AND NOT EXISTS (
    SELECT 1 FROM itervane.operations_restart_requests request WHERE request.execution_id = NEW.execution_id
    AND itervane.has_current_operations_restart_writer(request.execution_id, request.writer_installation_id, request.document)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_restart_resume_writer_required';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_restart_resume_writer BEFORE INSERT OR UPDATE ON itervane.operations_restart_resumes
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_restart_resume_writer();
