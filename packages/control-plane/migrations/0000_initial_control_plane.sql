CREATE SCHEMA "itervane";
--> statement-breakpoint
CREATE TYPE "itervane"."agent_role" AS ENUM('audit', 'repair', 'verify', 'operations', 'rule-extraction');--> statement-breakpoint
CREATE TYPE "itervane"."task_state" AS ENUM('queued', 'running', 'waiting_approval', 'waiting_input', 'reconciling', 'succeeded', 'failed', 'cancel_requested', 'cancelled', 'needs_human');--> statement-breakpoint
CREATE TABLE "itervane"."applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_project_pair" UNIQUE("id","project_id"),
	CONSTRAINT "application_name_unique" UNIQUE("project_id","name")
);
--> statement-breakpoint
CREATE TABLE "itervane"."environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"name" text NOT NULL,
	"access" text DEFAULT 'protected' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_name_unique" UNIQUE("application_id","name"),
	CONSTRAINT "environment_protected" CHECK ("itervane"."environments"."access" = 'protected')
);
--> statement-breakpoint
CREATE TABLE "itervane"."principals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principal_identity_unique" UNIQUE("issuer","subject")
);
--> statement-breakpoint
CREATE TABLE "itervane"."project_members" (
	"project_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "project_members_project_id_principal_id_pk" PRIMARY KEY("project_id","principal_id"),
	CONSTRAINT "project_role" CHECK ("itervane"."project_members"."role" IN ('maintainer', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "itervane"."projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_slug_unique" UNIQUE("workspace_id","slug")
);
--> statement-breakpoint
CREATE TABLE "itervane"."repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_project_pair" UNIQUE("id","project_id"),
	CONSTRAINT "repository_url_unique" UNIQUE("project_id","url")
);
--> statement-breakpoint
CREATE TABLE "itervane"."task_events" (
	"task_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"state" "itervane"."task_state" NOT NULL,
	"actor_id" uuid NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_events_task_id_sequence_pk" PRIMARY KEY("task_id","sequence"),
	CONSTRAINT "event_sequence_positive" CHECK ("itervane"."task_events"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "itervane"."task_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"role" "itervane"."agent_role" NOT NULL,
	"state" "itervane"."task_state" DEFAULT 'queued' NOT NULL,
	"wakeup_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_run_generation_unique" UNIQUE("task_id","generation"),
	CONSTRAINT "run_generation_positive" CHECK ("itervane"."task_runs"."generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "itervane"."tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"commit" text NOT NULL,
	"purpose" text NOT NULL,
	"data_class" text NOT NULL,
	"request_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"state" "itervane"."task_state" DEFAULT 'queued' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_request_unique" UNIQUE("project_id","requested_by","request_key"),
	CONSTRAINT "task_version_positive" CHECK ("itervane"."tasks"."version" > 0 AND "itervane"."tasks"."generation" > 0),
	CONSTRAINT "task_data_class" CHECK ("itervane"."tasks"."data_class" IN ('synthetic', 'public')),
	CONSTRAINT "task_fixed_commit" CHECK ("itervane"."tasks"."commit" ~ '^([a-f0-9]{40}|[a-f0-9]{64})$')
);
--> statement-breakpoint
CREATE TABLE "itervane"."workspace_members" (
	"workspace_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_principal_id_pk" PRIMARY KEY("workspace_id","principal_id"),
	CONSTRAINT "one_workspace_owner" UNIQUE("workspace_id")
);
--> statement-breakpoint
CREATE TABLE "itervane"."workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "one_workspace" UNIQUE("singleton"),
	CONSTRAINT "workspace_singleton" CHECK ("itervane"."workspaces"."singleton" = true)
);
--> statement-breakpoint
ALTER TABLE "itervane"."applications" ADD CONSTRAINT "applications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "itervane"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "itervane"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."environments" ADD CONSTRAINT "environment_application_project_fk" FOREIGN KEY ("application_id","project_id") REFERENCES "itervane"."applications"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "itervane"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."project_members" ADD CONSTRAINT "project_members_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "itervane"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "itervane"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."repositories" ADD CONSTRAINT "repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "itervane"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "itervane"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."task_events" ADD CONSTRAINT "task_events_actor_id_principals_id_fk" FOREIGN KEY ("actor_id") REFERENCES "itervane"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."task_runs" ADD CONSTRAINT "task_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "itervane"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "itervane"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."tasks" ADD CONSTRAINT "tasks_requested_by_principals_id_fk" FOREIGN KEY ("requested_by") REFERENCES "itervane"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."tasks" ADD CONSTRAINT "task_repository_project_fk" FOREIGN KEY ("repository_id","project_id") REFERENCES "itervane"."repositories"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "itervane"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itervane"."workspace_members" ADD CONSTRAINT "workspace_members_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "itervane"."principals"("id") ON DELETE no action ON UPDATE no action;