import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, integer, jsonb, pgSchema, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { agentRoles, taskStates } from '@itervane/contracts';

export const domain = pgSchema('itervane');
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
export const taskState = domain.enum('task_state', taskStates);
export const agentRole = domain.enum('agent_role', agentRoles);

export const principals = domain.table('principals', {
  id: uuid('id').primaryKey().defaultRandom(), issuer: text('issuer').notNull(), subject: text('subject').notNull(),
  createdAt: createdAt(),
}, t => [unique('principal_identity_unique').on(t.issuer, t.subject)]);

export const workspaces = domain.table('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(), singleton: boolean('singleton').notNull().default(true),
  name: text('name').notNull(), createdAt: createdAt(),
}, t => [unique('one_workspace').on(t.singleton), check('workspace_singleton', sql`${t.singleton} = true`)]);

export const workspaceMembers = domain.table('workspace_members', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  principalId: uuid('principal_id').notNull().references(() => principals.id),
}, t => [primaryKey({ columns: [t.workspaceId, t.principalId] }), unique('one_workspace_owner').on(t.workspaceId)]);

export const projects = domain.table('projects', {
  id: uuid('id').primaryKey().defaultRandom(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(), slug: text('slug').notNull(), createdAt: createdAt(),
}, t => [unique('project_slug_unique').on(t.workspaceId, t.slug)]);

export const projectMembers = domain.table('project_members', {
  projectId: uuid('project_id').notNull().references(() => projects.id),
  principalId: uuid('principal_id').notNull().references(() => principals.id), role: text('role').notNull(),
}, t => [primaryKey({ columns: [t.projectId, t.principalId] }), check('project_role', sql`${t.role} IN ('maintainer', 'viewer')`)]);

export const repositories = domain.table('repositories', {
  id: uuid('id').primaryKey().defaultRandom(), projectId: uuid('project_id').notNull().references(() => projects.id),
  name: text('name').notNull(), url: text('url').notNull(), createdAt: createdAt(),
}, t => [unique('repository_project_pair').on(t.id, t.projectId), unique('repository_url_unique').on(t.projectId, t.url)]);

export const applications = domain.table('applications', {
  id: uuid('id').primaryKey().defaultRandom(), projectId: uuid('project_id').notNull().references(() => projects.id),
  name: text('name').notNull(), createdAt: createdAt(),
}, t => [unique('application_project_pair').on(t.id, t.projectId), unique('application_name_unique').on(t.projectId, t.name)]);

export const environments = domain.table('environments', {
  id: uuid('id').primaryKey().defaultRandom(), projectId: uuid('project_id').notNull().references(() => projects.id),
  applicationId: uuid('application_id').notNull(), name: text('name').notNull(),
  access: text('access').notNull().default('protected'), createdAt: createdAt(),
}, t => [
  foreignKey({ name: 'environment_application_project_fk', columns: [t.applicationId, t.projectId], foreignColumns: [applications.id, applications.projectId] }),
  unique('environment_name_unique').on(t.applicationId, t.name), check('environment_protected', sql`${t.access} = 'protected'`),
]);

export const tasks = domain.table('tasks', {
  id: uuid('id').primaryKey(), projectId: uuid('project_id').notNull().references(() => projects.id),
  repositoryId: uuid('repository_id').notNull(), requestedBy: uuid('requested_by').notNull().references(() => principals.id),
  commit: text('commit').notNull(), purpose: text('purpose').notNull(), dataClass: text('data_class').notNull(),
  requestKey: text('request_key').notNull(), requestHash: text('request_hash').notNull(),
  state: taskState('state').notNull().default('queued'), version: integer('version').notNull().default(1),
  generation: integer('generation').notNull().default(1), createdAt: createdAt(),
}, t => [
  foreignKey({ name: 'task_repository_project_fk', columns: [t.repositoryId, t.projectId], foreignColumns: [repositories.id, repositories.projectId] }),
  unique('task_request_unique').on(t.projectId, t.requestedBy, t.requestKey),
  check('task_version_positive', sql`${t.version} > 0 AND ${t.generation} > 0`),
  check('task_data_class', sql`${t.dataClass} IN ('synthetic', 'public')`),
  check('task_fixed_commit', sql`${t.commit} ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'`),
]);

export const taskRuns = domain.table('task_runs', {
  id: uuid('id').primaryKey(), taskId: uuid('task_id').notNull().references(() => tasks.id),
  generation: integer('generation').notNull(), role: agentRole('role').notNull(),
  state: taskState('state').notNull().default('queued'), wakeupJobId: uuid('wakeup_job_id'), createdAt: createdAt(),
}, t => [unique('task_run_generation_unique').on(t.taskId, t.generation), check('run_generation_positive', sql`${t.generation} > 0`)]);

export const taskEvents = domain.table('task_events', {
  taskId: uuid('task_id').notNull().references(() => tasks.id), sequence: integer('sequence').notNull(),
  type: text('type').notNull(), state: taskState('state').notNull(),
  actorId: uuid('actor_id').notNull().references(() => principals.id),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}), createdAt: createdAt(),
}, t => [primaryKey({ columns: [t.taskId, t.sequence] }), check('event_sequence_positive', sql`${t.sequence} > 0`)]);
