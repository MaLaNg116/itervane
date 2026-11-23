ALTER TABLE "itervane"."operations_incidents" ADD COLUMN "diagnosis_stopped_by" uuid;--> statement-breakpoint
ALTER TABLE "itervane"."operations_incidents" ADD COLUMN "diagnosis_stop_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "itervane"."operations_incidents" ADD CONSTRAINT "operations_incidents_diagnosis_stopped_by_principals_id_fk" FOREIGN KEY ("diagnosis_stopped_by") REFERENCES "itervane"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_incidents" ADD CONSTRAINT "operations_incident_operator_record" CHECK (((
    "itervane"."operations_incidents"."diagnosis_stopped_by" IS NULL AND "itervane"."operations_incidents"."diagnosis_stop_grant_id" IS NULL
  ) OR ("itervane"."operations_incidents"."diagnosis_stop_reason" = 'operator_stopped' AND "itervane"."operations_incidents"."diagnosis_stopped_by" IS NOT NULL AND "itervane"."operations_incidents"."diagnosis_stop_grant_id" IS NOT NULL)) IS TRUE);
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_incident_stop() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.diagnosis_stopped_at IS NOT NULL AND ROW(NEW.diagnosis_stopped_at, NEW.diagnosis_stop_reason,
      NEW.diagnosis_stopped_by, NEW.diagnosis_stop_grant_id) IS DISTINCT FROM
    ROW(OLD.diagnosis_stopped_at, OLD.diagnosis_stop_reason, OLD.diagnosis_stopped_by, OLD.diagnosis_stop_grant_id)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_incident_stop_is_immutable';
  END IF;
  IF OLD.diagnosis_stopped_at IS NULL AND NEW.diagnosis_stop_reason = 'operator_stopped' THEN
    IF OLD.closed_at IS NOT NULL OR NEW.closed_at IS NOT NULL OR
      ROW(OLD.environment_id, OLD.binding_sha256) IS DISTINCT FROM ROW(NEW.environment_id, NEW.binding_sha256)
      OR NOT EXISTS (
        SELECT 1 FROM itervane.environments environment
        JOIN itervane.projects project ON project.id = environment.project_id
        JOIN itervane.workspace_members owner ON owner.workspace_id = project.workspace_id
        WHERE environment.id = OLD.environment_id AND environment.access = 'protected'
          AND owner.principal_id = NEW.diagnosis_stopped_by AND owner.grant_id = NEW.diagnosis_stop_grant_id
      ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_incident_stop_authority';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER operations_incident_stop_authority BEFORE UPDATE ON itervane.operations_incidents
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_incident_stop();
