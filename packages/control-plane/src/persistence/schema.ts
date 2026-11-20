import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import {
  agentRoles, taskStates, type FixtureReleaseManifest, type FixtureReleaseObservation, type InspectionPlan,
  type PreauditRecord, type QualifiedInspectionReceipt, type ReleaseDecision, type ReleaseOperationState,
} from '@itervane/contracts';

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
  grantId: uuid('grant_id').notNull().defaultRandom(),
}, t => [primaryKey({ columns: [t.workspaceId, t.principalId] }), unique('one_workspace_owner').on(t.workspaceId),
  unique('workspace_owner_grant').on(t.grantId)]);

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
  unique('environment_project_application').on(t.id, t.projectId, t.applicationId),
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
  unique('task_project_pair').on(t.id, t.projectId),
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
}, t => [primaryKey({ columns: [t.runId, t.keyHash] }), check('tool_call_status', sql`
  ${t.status} IN ('reserved', 'success', 'business_error', 'infrastructure_error') OR (${t.tool} = 'source.inspect' AND ${t.status} = 'unknown')`)]);

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

export const inspectionAttempts = domain.table('inspection_attempts', {
  requestId: uuid('request_id').primaryKey(),
  taskId: uuid('task_id').notNull(), projectId: uuid('project_id').notNull(),
  runId: uuid('run_id').notNull().references(() => inspectionPlans.runId),
  repositoryId: uuid('repository_id').notNull(), commit: text('commit').notNull(),
  generation: integer('generation').notNull(), fence: integer('fence').notNull(), workerId: uuid('worker_id').notNull(),
  planSha256: text('plan_sha256').notNull(), originSha256: text('origin_sha256').notNull(), imageSha256: text('image_sha256').notNull(),
  workspaceSha256: text('workspace_sha256'),
  state: text('state').$type<'reserved' | 'closed' | 'uncertain' | 'recorded'>().notNull().default('reserved'),
  settledFence: integer('settled_fence'), settledAt: timestamp('settled_at', { withTimezone: true }),
  receiptSha256: text('receipt_sha256'), receipt: jsonb('receipt').$type<QualifiedInspectionReceipt>(),
  createdAt: createdAt(),
}, t => [
  foreignKey({ name: 'inspection_attempt_run_task', columns: [t.runId, t.taskId], foreignColumns: [taskRuns.id, taskRuns.taskId] }),
  foreignKey({ name: 'inspection_attempt_task_project', columns: [t.taskId, t.projectId], foreignColumns: [tasks.id, tasks.projectId] }),
  foreignKey({ name: 'inspection_attempt_repository_project', columns: [t.repositoryId, t.projectId], foreignColumns: [repositories.id, repositories.projectId] }),
  unique('inspection_attempt_per_fence').on(t.runId, t.fence),
  uniqueIndex('inspection_open_attempt_per_run').on(t.runId).where(sql`${t.state} <> 'closed'`),
  check('inspection_attempt_workspace_binding', sql`${t.workspaceSha256} IS NULL OR (
    ${t.workspaceSha256} ~ '^[a-f0-9]{64}$' AND (${t.state} <> 'recorded'
    OR (${t.receipt}#>>'{scope,workspaceSha256}' = ${t.workspaceSha256}) IS TRUE))`),
  check('inspection_attempt_coordinates', sql`
    ${t.generation} > 0 AND ${t.fence} > 0 AND ${t.commit} ~ '^[a-f0-9]{40}$'
    AND ${t.planSha256} ~ '^[a-f0-9]{64}$' AND ${t.originSha256} ~ '^[a-f0-9]{64}$' AND ${t.imageSha256} ~ '^[a-f0-9]{64}$'`),
  check('inspection_attempt_state', sql`(
    (${t.state} = 'reserved' AND ${t.settledFence} IS NULL AND ${t.settledAt} IS NULL)
    OR (${t.state} IN ('closed', 'uncertain', 'recorded') AND ${t.settledFence} >= ${t.fence} AND ${t.settledAt} IS NOT NULL)
  ) IS TRUE`),
  check('inspection_attempt_receipt_binding', sql`(
    (${t.state} <> 'recorded' AND ${t.receipt} IS NULL AND ${t.receiptSha256} IS NULL)
    OR (${t.state} = 'recorded' AND ${t.settledFence} = ${t.fence} AND ${t.receiptSha256} ~ '^[a-f0-9]{64}$'
      AND octet_length(${t.receipt}::text) <= 4202496
      AND ${t.receipt}->>'kind' = 'receipt' AND ${t.receipt}->'cleanupConfirmed' = 'true'::jsonb
      AND ${t.receipt}->'sessionVerified' = 'true'::jsonb AND ${t.receipt}->>'originSha256' = ${t.originSha256}
      AND ${t.receipt}->>'imageSha256' = ${t.imageSha256}
      AND ${t.receipt}#>>'{scope,requestId}' = ${t.requestId}::text
      AND ${t.receipt}#>>'{scope,taskId}' = ${t.taskId}::text AND ${t.receipt}#>>'{scope,runId}' = ${t.runId}::text
      AND ${t.receipt}#>>'{scope,projectId}' = ${t.projectId}::text AND ${t.receipt}#>>'{scope,repositoryId}' = ${t.repositoryId}::text
      AND ${t.receipt}#>>'{scope,commit}' = ${t.commit} AND ${t.receipt}#>>'{scope,planSha256}' = ${t.planSha256}
      AND ${t.receipt}#>>'{scope,fence}' = ${t.fence}::text AND ${t.receipt}#>>'{scope,generation}' = ${t.generation}::text
      AND ${t.receipt}->>'domainId' = ${t.receipt}#>>'{snapshot,runId}'
      AND ${t.receipt}#>>'{snapshot,repositoryId}' = ${t.repositoryId}::text AND ${t.receipt}#>>'{snapshot,commit}' = ${t.commit}
      AND ${t.receipt}#>'{snapshot,offline}' = 'true'::jsonb AND ${t.receipt}#>'{snapshot,readOnly}' = 'true'::jsonb)
  ) IS TRUE`),
]);

export const preaudits = domain.table('preaudits', {
  id: uuid('id').primaryKey(), projectId: uuid('project_id').notNull().references(() => projects.id),
  requestedBy: uuid('requested_by').notNull().references(() => principals.id), requestKey: uuid('request_key').notNull(),
  requestHash: text('request_hash').notNull(), reportSha256: text('report_sha256').notNull(),
  document: jsonb('document').$type<PreauditRecord>().notNull(), createdAt: createdAt(),
}, t => [unique('preaudit_request_unique').on(t.projectId, t.requestedBy, t.requestKey), index('preaudit_project_history').on(t.projectId, t.createdAt, t.id),
  check('preaudit_document_binding', sql`(${t.requestHash} ~ '^[a-f0-9]{64}$' AND ${t.reportSha256} ~ '^[a-f0-9]{64}$'
  AND ${t.document}->>'id' = ${t.id}::text AND ${t.document}->>'projectId' = ${t.projectId}::text AND ${t.document}->>'requestedBy' = ${t.requestedBy}::text
  AND ${t.document}#>>'{evaluation,formalScan}' = 'false' AND ${t.document}#>>'{evaluation,releaseEligible}' = 'false'
  AND octet_length(${t.document}::text) <= 65536) IS TRUE`)]);

export const releaseCandidates = domain.table('release_candidates', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id').notNull(),
  taskId: uuid('task_id').notNull(),
  runId: uuid('run_id').notNull(),
  applicationId: uuid('application_id').notNull(),
  environmentId: uuid('environment_id').notNull(),
  requestedBy: uuid('requested_by').notNull().references(() => principals.id),
  evidenceVersion: integer('evidence_version').notNull(),
  fingerprint: text('fingerprint').notNull(),
  document: jsonb('document').$type<FixtureReleaseManifest>().notNull(),
  createdAt: createdAt(),
}, t => [
  foreignKey({ name: 'release_candidate_task_project_fk', columns: [t.taskId, t.projectId], foreignColumns: [tasks.id, tasks.projectId] }),
  foreignKey({ name: 'release_candidate_run_task_fk', columns: [t.runId, t.taskId], foreignColumns: [taskRuns.id, taskRuns.taskId] }),
  foreignKey({ name: 'release_candidate_environment_scope_fk', columns: [t.environmentId, t.projectId, t.applicationId],
    foreignColumns: [environments.id, environments.projectId, environments.applicationId] }),
  unique('release_candidate_evidence_version').on(t.taskId, t.evidenceVersion),
  unique('release_candidate_environment_pair').on(t.id, t.environmentId),
  check('release_candidate_binding', sql`(${t.evidenceVersion} > 0 AND ${t.fingerprint} ~ '^[a-f0-9]{64}$'
    AND ${t.document}->>'version' = '1' AND ${t.document}->>'origin' = 'trusted_fixture'
    AND ${t.document}->'releaseEligible' = 'false'::jsonb
    AND ${t.document}->>'evidenceVersion' = ${t.evidenceVersion}::text
    AND ${t.document}->>'projectId' = ${t.projectId}::text AND ${t.document}->>'taskId' = ${t.taskId}::text
    AND ${t.document}->>'runId' = ${t.runId}::text
    AND ${t.document}#>>'{target,applicationId}' = ${t.applicationId}::text
    AND ${t.document}#>>'{target,environmentId}' = ${t.environmentId}::text
    AND octet_length(${t.document}::text) <= 8192) IS TRUE`),
]);

export const releaseDecisions = domain.table('release_decisions', {
  candidateId: uuid('candidate_id').notNull().references(() => releaseCandidates.id),
  version: integer('version').notNull(),
  actorId: uuid('actor_id').notNull().references(() => principals.id),
  // Retained after the workspace membership is deleted.
  grantId: uuid('grant_id').notNull(),
  idempotencyKey: uuid('idempotency_key').notNull(),
  action: text('action').$type<ReleaseDecision>().notNull(),
  selfConfirmed: boolean('self_confirmed').notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
}, t => [
  primaryKey({ columns: [t.candidateId, t.version] }),
  unique('release_decision_request').on(t.candidateId, t.actorId, t.idempotencyKey),
  check('release_decision_action_version', sql`(${t.version} = 1 AND ${t.action} IN ('confirm', 'reject'))
    OR (${t.version} = 2 AND ${t.action} = 'revoke')`),
  check('release_decision_self_confirmed', sql`NOT ${t.selfConfirmed} OR ${t.action} = 'confirm'`),
]);

export const releaseOperations = domain.table('release_operations', {
  id: uuid('id').primaryKey(),
  candidateId: uuid('candidate_id').notNull(),
  environmentId: uuid('environment_id').notNull(),
  approvalVersion: integer('approval_version').notNull(),
  state: text('state').$type<ReleaseOperationState>().notNull().default('queued'),
  observation: jsonb('observation').$type<FixtureReleaseObservation>(),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  foreignKey({ name: 'release_operation_candidate_scope_fk', columns: [t.candidateId, t.environmentId],
    foreignColumns: [releaseCandidates.id, releaseCandidates.environmentId] }),
  foreignKey({ name: 'release_operation_decision_fk', columns: [t.candidateId, t.approvalVersion],
    foreignColumns: [releaseDecisions.candidateId, releaseDecisions.version] }),
  unique('release_operation_candidate_unique').on(t.candidateId),
  uniqueIndex('release_operation_environment_hold').on(t.environmentId).where(sql`${t.state} IN ('dispatching', 'reconciling')`),
  check('release_operation_single_approval', sql`${t.approvalVersion} = 1`),
  check('release_operation_state', sql`${t.state} IN ('queued', 'dispatching', 'reconciling', 'verified_fixture', 'blocked')`),
  check('release_operation_observation', sql`(
    (${t.state} <> 'verified_fixture' AND ${t.observation} IS NULL) OR
    (${t.state} = 'verified_fixture' AND ${t.observation}->>'origin' = 'trusted_fixture'
      AND ${t.observation}->>'operationId' = ${t.id}::text
      AND ${t.observation}->>'environmentId' = ${t.environmentId}::text
      AND ${t.observation}->'healthy' = 'true'::jsonb AND ${t.observation}->'accessProtected' = 'true'::jsonb
      AND octet_length(${t.observation}::text) <= 4096)
  ) IS TRUE`),
]);
