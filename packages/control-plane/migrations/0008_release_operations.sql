CREATE TABLE "itervane"."release_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"approval_version" integer NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"observation" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_operation_candidate_unique" UNIQUE("candidate_id"),
	CONSTRAINT "release_operation_single_approval" CHECK ("itervane"."release_operations"."approval_version" = 1),
	CONSTRAINT "release_operation_state" CHECK ("itervane"."release_operations"."state" IN ('queued', 'dispatching', 'reconciling', 'verified_fixture', 'blocked')),
	CONSTRAINT "release_operation_observation" CHECK ((
    ("itervane"."release_operations"."state" <> 'verified_fixture' AND "itervane"."release_operations"."observation" IS NULL) OR
    ("itervane"."release_operations"."state" = 'verified_fixture' AND "itervane"."release_operations"."observation"->>'origin' = 'trusted_fixture'
      AND "itervane"."release_operations"."observation"->>'operationId' = "itervane"."release_operations"."id"::text
      AND "itervane"."release_operations"."observation"->>'environmentId' = "itervane"."release_operations"."environment_id"::text
      AND "itervane"."release_operations"."observation"->'healthy' = 'true'::jsonb AND "itervane"."release_operations"."observation"->'accessProtected' = 'true'::jsonb
      AND octet_length("itervane"."release_operations"."observation"::text) <= 4096)
  ) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."release_candidates" ADD CONSTRAINT "release_candidate_environment_pair" UNIQUE("id","environment_id");--> statement-breakpoint
ALTER TABLE "itervane"."release_operations" ADD CONSTRAINT "release_operation_candidate_scope_fk" FOREIGN KEY ("candidate_id","environment_id") REFERENCES "itervane"."release_candidates"("id","environment_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."release_operations" ADD CONSTRAINT "release_operation_decision_fk" FOREIGN KEY ("candidate_id","approval_version") REFERENCES "itervane"."release_decisions"("candidate_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "release_operation_environment_hold" ON "itervane"."release_operations" USING btree ("environment_id") WHERE "itervane"."release_operations"."state" IN ('dispatching', 'reconciling');
--> statement-breakpoint
-- Preserve both the immutable binding and the history of a one-time reservation.
CREATE FUNCTION itervane.enforce_fixture_release_transition() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state = 'queued' THEN
      RETURN NEW;
    END IF;
  ELSIF (NEW.id, NEW.candidate_id, NEW.environment_id, NEW.approval_version, NEW.created_at)
      IS NOT DISTINCT FROM (OLD.id, OLD.candidate_id, OLD.environment_id, OLD.approval_version, OLD.created_at)
    AND ((OLD.state = 'queued' AND NEW.state IN ('dispatching', 'blocked'))
      OR (OLD.state = 'dispatching' AND NEW.state IN ('reconciling', 'verified_fixture'))
      OR (OLD.state = 'reconciling' AND NEW.state = 'verified_fixture')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid_fixture_release_transition';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER release_operation_transition BEFORE INSERT OR UPDATE ON itervane.release_operations
FOR EACH ROW EXECUTE FUNCTION itervane.enforce_fixture_release_transition();
--> statement-breakpoint
CREATE TRIGGER release_operation_immutable_delete BEFORE DELETE ON itervane.release_operations
FOR EACH ROW EXECUTE FUNCTION itervane.reject_release_record_mutation();
