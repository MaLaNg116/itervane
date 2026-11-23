CREATE TABLE "itervane"."operations_incident_diagnoses" (
	"incident_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"binding_sha256" text NOT NULL,
	"monitor_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"sample_sequence" bigint NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"admitted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operations_incident_diagnoses_incident_id_attempt_pk" PRIMARY KEY("incident_id","attempt"),
	CONSTRAINT "operations_incident_diagnosis_run" UNIQUE("run_id"),
	CONSTRAINT "operations_incident_diagnosis_sample" UNIQUE("sample_sequence"),
	CONSTRAINT "operations_incident_diagnosis_budget" CHECK ("itervane"."operations_incident_diagnoses"."attempt" BETWEEN 1 AND 3)
);
--> statement-breakpoint
CREATE TABLE "itervane"."operations_incident_monitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"enrollment_sha256" text NOT NULL,
	"mapping_sha256" text NOT NULL,
	"provider_sha256" text NOT NULL,
	"locale" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "operations_incident_monitor_scope" UNIQUE("id","environment_id"),
	CONSTRAINT "operations_incident_monitor_policy" CHECK ("itervane"."operations_incident_monitors"."locale" IN ('en', 'zh-CN')
    AND "itervane"."operations_incident_monitors"."enrollment_sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."operations_incident_monitors"."mapping_sha256" ~ '^[a-f0-9]{64}$'
    AND "itervane"."operations_incident_monitors"."provider_sha256" ~ '^[a-f0-9]{64}$' AND "itervane"."operations_incident_monitors"."valid_until" > "itervane"."operations_incident_monitors"."created_at"
    AND ("itervane"."operations_incident_monitors"."revoked_at" IS NULL OR "itervane"."operations_incident_monitors"."revoked_at" >= "itervane"."operations_incident_monitors"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "itervane"."operations_incidents" ADD COLUMN "diagnosis_stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "itervane"."operations_incidents" ADD COLUMN "diagnosis_stop_reason" text;--> statement-breakpoint
ALTER TABLE "itervane"."operations_health_samples" ADD CONSTRAINT "operations_health_sample_incident" UNIQUE("sequence","incident_id");--> statement-breakpoint
ALTER TABLE "itervane"."operations_incident_diagnoses" ADD CONSTRAINT "operations_incident_diagnoses_run_id_operations_diagnosis_inputs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "itervane"."operations_diagnosis_inputs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_incident_diagnoses" ADD CONSTRAINT "operations_incident_diagnosis_scope_fk" FOREIGN KEY ("incident_id","environment_id","binding_sha256") REFERENCES "itervane"."operations_incidents"("id","environment_id","binding_sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_incident_diagnoses" ADD CONSTRAINT "operations_incident_diagnosis_sample_fk" FOREIGN KEY ("sample_sequence","incident_id") REFERENCES "itervane"."operations_health_samples"("sequence","incident_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_incident_diagnoses" ADD CONSTRAINT "operations_incident_diagnosis_monitor_fk" FOREIGN KEY ("monitor_id","environment_id") REFERENCES "itervane"."operations_incident_monitors"("id","environment_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_incident_diagnoses" ADD CONSTRAINT "operations_incident_diagnosis_task_fk" FOREIGN KEY ("run_id","task_id") REFERENCES "itervane"."task_runs"("id","task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_incident_monitors" ADD CONSTRAINT "operations_incident_monitors_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "itervane"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."operations_incident_monitors" ADD CONSTRAINT "operations_incident_monitors_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "itervane"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operations_incident_diagnosis_environment_time" ON "itervane"."operations_incident_diagnoses" USING btree ("environment_id","admitted_at","sample_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "operations_incident_active_monitor" ON "itervane"."operations_incident_monitors" USING btree ("environment_id") WHERE "itervane"."operations_incident_monitors"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "itervane"."operations_incidents" ADD CONSTRAINT "operations_incident_diagnosis_stop" CHECK (((
    "itervane"."operations_incidents"."diagnosis_stopped_at" IS NULL AND "itervane"."operations_incidents"."diagnosis_stop_reason" IS NULL
  ) OR ("itervane"."operations_incidents"."diagnosis_stopped_at" >= "itervane"."operations_incidents"."opened_at" AND "itervane"."operations_incidents"."diagnosis_stop_reason" IN ('attempt_limit', 'task_stopped', 'operator_stopped'))) IS TRUE);
