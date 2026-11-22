CREATE SEQUENCE "itervane"."operations_health_probe_sequence" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9007199254740991 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "itervane"."operations_health_samples" (
	"sequence" bigint PRIMARY KEY NOT NULL,
	"environment_id" uuid NOT NULL,
	"binding_sha256" text NOT NULL,
	"binding" jsonb NOT NULL,
	"signal" jsonb NOT NULL,
	"incident_id" uuid,
	"probe_started_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operations_health_sample_binding" CHECK (("itervane"."operations_health_samples"."sequence" > 0 AND "itervane"."operations_health_samples"."binding_sha256" ~ '^[a-f0-9]{64}$'
    AND "itervane"."operations_health_samples"."binding"->>'version' = '1' AND "itervane"."operations_health_samples"."binding"->>'environmentId' = "itervane"."operations_health_samples"."environment_id"::text
    AND octet_length("itervane"."operations_health_samples"."binding"::text) <= 2048 AND "itervane"."operations_health_samples"."recorded_at" >= "itervane"."operations_health_samples"."probe_started_at") IS TRUE),
	CONSTRAINT "operations_health_sample_signal" CHECK (("itervane"."operations_health_samples"."signal"->>'evidenceSha256' ~ '^[a-f0-9]{64}$'
    AND octet_length("itervane"."operations_health_samples"."signal"::text) <= 512 AND (
      ("itervane"."operations_health_samples"."signal"->>'status' = 'healthy' AND NOT ("itervane"."operations_health_samples"."signal" ? 'reason'))
      OR ("itervane"."operations_health_samples"."signal"->>'status' = 'unhealthy' AND "itervane"."operations_health_samples"."incident_id" IS NOT NULL
        AND "itervane"."operations_health_samples"."signal"->>'reason' IN ('runtime_stopped', 'application_unhealthy'))
      OR ("itervane"."operations_health_samples"."signal"->>'status' = 'unavailable'
        AND "itervane"."operations_health_samples"."signal"->>'reason' IN ('ingress_unavailable', 'probe_identity', 'komodo_unavailable', 'target_changed'))
    )) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "itervane"."operations_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"binding_sha256" text NOT NULL,
	"binding" jsonb NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"last_unhealthy_at" timestamp with time zone NOT NULL,
	"unhealthy_samples" integer NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_reason" text,
	CONSTRAINT "operations_incident_scope" UNIQUE("id","environment_id","binding_sha256"),
	CONSTRAINT "operations_incident_binding" CHECK (("itervane"."operations_incidents"."binding_sha256" ~ '^[a-f0-9]{64}$'
    AND "itervane"."operations_incidents"."binding"->>'version' = '1' AND "itervane"."operations_incidents"."binding"->>'environmentId' = "itervane"."operations_incidents"."environment_id"::text
    AND octet_length("itervane"."operations_incidents"."binding"::text) <= 2048) IS TRUE),
	CONSTRAINT "operations_incident_lifecycle" CHECK (("itervane"."operations_incidents"."unhealthy_samples" > 0 AND "itervane"."operations_incidents"."last_unhealthy_at" >= "itervane"."operations_incidents"."opened_at" AND (
    ("itervane"."operations_incidents"."closed_at" IS NULL AND "itervane"."operations_incidents"."closed_reason" IS NULL)
    OR ("itervane"."operations_incidents"."closed_at" >= "itervane"."operations_incidents"."last_unhealthy_at" AND "itervane"."operations_incidents"."closed_reason" IN ('recovered', 'target_changed'))
  )) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "itervane"."operations_health_samples" ADD CONSTRAINT "operations_health_samples_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "itervane"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_health_samples" ADD CONSTRAINT "operations_health_sample_incident_fk" FOREIGN KEY ("incident_id","environment_id","binding_sha256") REFERENCES "itervane"."operations_incidents"("id","environment_id","binding_sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_incidents" ADD CONSTRAINT "operations_incidents_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "itervane"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operations_health_samples_environment_sequence" ON "itervane"."operations_health_samples" USING btree ("environment_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "operations_incident_active_environment" ON "itervane"."operations_incidents" USING btree ("environment_id") WHERE "itervane"."operations_incidents"."closed_at" IS NULL;
--> statement-breakpoint
CREATE FUNCTION itervane.guard_operations_health_sample() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'operations_health_sample_is_immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_health_sample_immutable BEFORE UPDATE OR DELETE ON itervane.operations_health_samples
FOR EACH ROW EXECUTE FUNCTION itervane.guard_operations_health_sample();
