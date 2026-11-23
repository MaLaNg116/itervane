ALTER TABLE "itervane"."inspection_attempts" ADD COLUMN "materialized_from" jsonb;--> statement-breakpoint
ALTER TABLE "itervane"."inspection_attempts" ADD CONSTRAINT "inspection_attempt_materialized_binding" CHECK ((("itervane"."inspection_attempts"."materialized_from" IS NULL OR (
    "itervane"."inspection_attempts"."materialized_from"->>'commit' ~ '^[a-f0-9]{40}$' AND "itervane"."inspection_attempts"."materialized_from"->>'commit' <> "itervane"."inspection_attempts"."commit"
    AND "itervane"."inspection_attempts"."materialized_from"->>'baseSnapshotSha256' ~ '^[a-f0-9]{64}$' AND octet_length("itervane"."inspection_attempts"."materialized_from"::text) <= 512))
    AND ("itervane"."inspection_attempts"."state" <> 'recorded' OR "itervane"."inspection_attempts"."receipt"#>'{scope,materializedFrom}' IS NOT DISTINCT FROM "itervane"."inspection_attempts"."materialized_from")) IS TRUE);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION itervane.guard_inspection_workspace() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.workspace_sha256 IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inspection_workspace_required';
    END IF;
  ELSIF NEW.workspace_sha256 IS DISTINCT FROM OLD.workspace_sha256 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inspection_workspace_is_immutable';
  ELSIF NEW.materialized_from IS DISTINCT FROM OLD.materialized_from THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inspection_materialized_basis_is_immutable';
  END IF;
  RETURN NEW;
END
$$;
