ALTER TABLE "itervane"."inspection_attempts" ADD COLUMN "workspace_sha256" text;--> statement-breakpoint
ALTER TABLE "itervane"."inspection_attempts" ADD CONSTRAINT "inspection_attempt_workspace_binding" CHECK ("itervane"."inspection_attempts"."workspace_sha256" IS NULL OR (
    "itervane"."inspection_attempts"."workspace_sha256" ~ '^[a-f0-9]{64}$' AND ("itervane"."inspection_attempts"."state" <> 'recorded'
    OR ("itervane"."inspection_attempts"."receipt"#>>'{scope,workspaceSha256}' = "itervane"."inspection_attempts"."workspace_sha256") IS TRUE)));
--> statement-breakpoint
CREATE FUNCTION itervane.guard_inspection_workspace() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.workspace_sha256 IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inspection_workspace_required';
    END IF;
  ELSIF NEW.workspace_sha256 IS DISTINCT FROM OLD.workspace_sha256 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inspection_workspace_is_immutable';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER inspection_attempt_workspace BEFORE INSERT OR UPDATE ON itervane.inspection_attempts
FOR EACH ROW EXECUTE FUNCTION itervane.guard_inspection_workspace();
