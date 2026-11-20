import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, integer, jsonb, pgSchema, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { agentRoles, taskStates, type InspectionPlan } from '@itervane/contracts';

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
  locale: text('locale').notNull().default('en'),
}, t => [
  foreignKey({ name: 'task_repository_project_fk', columns: [t.repositoryId, t.projectId], foreignColumns: [repositories.id, repositories.projectId] }),
  unique('task_request_unique').on(t.projectId, t.requestedBy, t.requestKey),
  check('task_version_positive', sql`${t.version} > 0 AND ${t.generation} > 0`),
  check('task_data_class', sql`${t.dataClass} IN ('synthetic', 'public')`),
  check('task_fixed_commit', sql`${t.commit} ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'`),
  check('task_locale', sql`${t.locale} IN ('en', 'zh-CN')`),
]);

export const taskRuns = domain.table('task_runs', {
  id: uuid('id').primaryKey(), taskId: uuid('task_id').notNull().references(() => tasks.id),
  generation: integer('generation').notNull(), role: agentRole('role').notNull(),
  state: taskState('state').notNull().default('queued'), wakeupJobId: uuid('wakeup_job_id'), createdAt: createdAt(),
}, t => [unique('task_run_generation_unique').on(t.taskId, t.generation), unique('task_run_task_pair').on(t.id, t.taskId), check('run_generation_positive', sql`${t.generation} > 0`)]);

export const taskEvents = domain.table('task_events', {
  taskId: uuid('task_id').notNull().references(() => tasks.id), sequence: integer('sequence').notNull(),
  type: text('type').notNull(), state: taskState('state').notNull(),
  actorId: uuid('actor_id').notNull().references(() => principals.id),
  actorKind: text('actor_kind').notNull().default('principal'), workerId: uuid('worker_id'),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}), createdAt: createdAt(),
}, t => [primaryKey({ columns: [t.taskId, t.sequence] }), check('event_sequence_positive', sql`${t.sequence} > 0`),
  check('event_actor_kind', sql`(${t.actorKind} = 'principal' AND ${t.workerId} IS NULL) OR (${t.actorKind} = 'worker' AND ${t.workerId} IS NOT NULL)`)]);

export const executionSlot = domain.table('execution_slot', {
  id: integer('id').primaryKey(), taskId: uuid('task_id').references(() => tasks.id),
  runId: uuid('run_id').references(() => taskRuns.id), workerId: uuid('worker_id'),
  fence: integer('fence').notNull().default(0),
  leaseUntil: timestamp('lease_until', { withTimezone: true }).notNull().default(sql`'-infinity'::timestamptz`),
}, t => [check('one_execution_slot', sql`${t.id} = 1`), check('slot_assignment', sql`
  (${t.taskId} IS NULL AND ${t.runId} IS NULL AND ${t.workerId} IS NULL)
  OR (${t.taskId} IS NOT NULL AND ${t.runId} IS NOT NULL AND ${t.workerId} IS NOT NULL)`)]);

export const runRuntime = domain.table('run_runtime', {
  runId: uuid('run_id').primaryKey().references(() => taskRuns.id),
  taskId: uuid('task_id').notNull().references(() => tasks.id), checkpointId: text('checkpoint_id'),
  checkpointStep: integer('checkpoint_step').notNull().default(-2),
  resumePending: boolean('resume_pending').notNull().default(false), resumeCount: integer('resume_count').notNull().default(0),
  toolsUsed: integer('tools_used').notNull().default(0), maxTools: integer('max_tools').notNull().default(8),
  waitingForTaskId: uuid('waiting_for_task_id').references(() => tasks.id), reason: text('reason'),
}, t => [check('runtime_limits', sql`${t.resumeCount} >= 0 AND ${t.toolsUsed} >= 0 AND ${t.maxTools} BETWEEN 1 AND 32`)]);

export const toolCalls = domain.table('tool_calls', {
  runId: uuid('run_id').notNull().references(() => taskRuns.id), keyHash: text('key_hash').notNull(),
  inputHash: text('input_hash').notNull(), tool: text('tool').notNull(), fence: integer('fence').notNull(),
  status: text('status').notNull(), result: jsonb('result').$type<Record<string, unknown>>(), createdAt: createdAt(),
}, t => [primaryKey({ columns: [t.runId, t.keyHash] }), check('tool_call_status', sql`${t.status} IN ('reserved', 'success', 'business_error', 'infrastructure_error')`)]);

// 底层 saver 与领域事务分离：只有已发布的中间写入才参与恢复。
export const checkpointWrites = domain.table('checkpoint_write_receipts', {
  runId: uuid('run_id').notNull().references(() => taskRuns.id), checkpointId: text('checkpoint_id').notNull(),
  writeHash: text('write_hash').notNull(),
}, t => [primaryKey({ columns: [t.runId, t.checkpointId, t.writeHash] })]);

// A prepared intent is not a fetched snapshot or a completed scan. One immutable policy per logical run.
export const inspectionPlans = domain.table('inspection_plans', {
  runId: uuid('run_id').primaryKey(), taskId: uuid('task_id').notNull().references(() => tasks.id),
  preparedFence: integer('prepared_fence').notNull(), sha256: text('sha256').notNull(),
  document: jsonb('document').$type<InspectionPlan>().notNull(), createdAt: createdAt(),
}, t => [foreignKey({ name: 'inspection_run_task_fk', columns: [t.runId, t.taskId], foreignColumns: [taskRuns.id, taskRuns.taskId] }),
  check('inspection_plan_binding', sql`(${t.preparedFence} > 0 AND ${t.sha256} ~ '^[a-f0-9]{64}$'
  AND ${t.document}->>'taskId' = ${t.taskId}::text AND ${t.document}->>'runId' = ${t.runId}::text AND ${t.document}->>'version' = '1') IS TRUE`)]);
