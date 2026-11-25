import { sql } from 'drizzle-orm';
import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import {
  agentRoles, taskStates, type CandidateValidationPlan, type CandidateValidationRecord, type RulePackageDocument, type TaskRuleSnapshot,
  type FixtureReleaseManifest, type FixtureReleaseObservation, type FormalAuditInput, type FormalAuditResult,
  type LearningCaseDocument, type LearningCaseFacts,
  type FormalReleaseManifest, type FormalReleaseTarget, type FormalRepairContinuation, type FormalRepairInput, type FormalRepairResult,
  type FormalVerificationInput, type FormalVerificationResult, type InspectionPlan, type MaterializedSourceBasis,
  type OperationsDiagnosisObservation, type OperationsDiagnosisReceipt, type OperationsDiagnosisSection,
  type OperationsHealthBinding, type OperationsHealthSignal,
  type OperationsObservationReceipt, type OperationsProposal, type OperationsRepairProposal, type OperationsRequestBinding, type OperationsRestartBaseline,
  type OperationsRestartInstallation, type OperationsRestartRecoveryFailure, type OperationsRestartRecoveryProof, type OperationsRestartRequest,
  type OperationsRestorePlan, type OperationsRestoreRecoveryFailure, type OperationsRestoreRecoveryProof,
  type OperationsTargetInput, type PreauditRecord, type PublishedInspectionBasis, type QualifiedInspectionReceipt,
  type QualifiedOciArchiveVerification, type QualifiedRepairReceipt, type QualifiedRuleValidationRequest,
  type QualifiedVerificationReceipt, type ReleaseDecision, type ReleaseOperationState, type ReleaseRegistryImageProof,
  type ReleaseKomodoCompletion, type ReleaseKomodoConfiguration, type ReleaseKomodoIntent, type ReleaseKomodoUpdate,
  type ReleaseRolloutFailure, type ReleaseRolloutProof, type RuleExtractionInput, type RuleExtractionResultRecord, type RulePackageReviewRecord,
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
}, t => [unique('project_slug_unique').on(t.workspaceId, t.slug), unique('project_workspace_pair').on(t.id, t.workspaceId)]);

export const rulePackages = domain.table('rule_packages', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  key: text('key').notNull(), createdAt: createdAt(),
}, t => [
  unique('rule_package_workspace_key').on(t.workspaceId, t.key),
  unique('rule_package_scope_key').on(t.id, t.workspaceId, t.key),
  check('rule_package_key', sql`${t.key} ~ '^[a-z][a-z0-9-]{0,63}$'`),
]);

export const rulePackageVersions = domain.table('rule_package_versions', {
  id: uuid('id').primaryKey().defaultRandom(), packageId: uuid('package_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(), packageKey: text('package_key').notNull(),
  projectId: uuid('project_id'), version: text('version').notNull(), sha256: text('sha256').notNull(),
  submittedBy: uuid('submitted_by').notNull().references(() => principals.id), grantId: uuid('grant_id').notNull(),
  validationId: uuid('validation_id'), document: jsonb('document').$type<RulePackageDocument>().notNull(), createdAt: createdAt(),
}, t => [
  foreignKey({ name: 'rule_version_package_scope_fk', columns: [t.packageId, t.workspaceId, t.packageKey],
    foreignColumns: [rulePackages.id, rulePackages.workspaceId, rulePackages.key] }),
  foreignKey({ name: 'rule_version_project_scope_fk', columns: [t.projectId, t.workspaceId], foreignColumns: [projects.id, projects.workspaceId] }),
  foreignKey({ name: 'rule_version_candidate_validation_fk', columns: [t.validationId], foreignColumns: [candidateValidationResults.id] }),
  unique('rule_package_version_unique').on(t.packageId, t.version),
  index('rule_package_workspace_history').on(t.workspaceId, t.createdAt, t.id),
  check('rule_package_version_document', sql`(${t.sha256} ~ '^[a-f0-9]{64}$' AND length(${t.version}) <= 32
    AND ${t.version} ~ '^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$'
    AND ${t.document}->>'formatVersion' = '1'
    AND ${t.document}->>'packageKey' = ${t.packageKey} AND ${t.document}->>'version' = ${t.version}
    AND ${t.document}#>>'{scope,kind}' = CASE WHEN ${t.projectId} IS NULL THEN 'workspace' ELSE 'project' END
    AND (${t.document}#>>'{scope,projectId}') IS NOT DISTINCT FROM ${t.projectId}::text
    AND CASE WHEN ${t.document}->>'kind' = 'design_skill' THEN ${t.validationId} IS NULL AND ${t.document}->'validation' IS NULL
      ELSE ${t.document}->>'kind' IN ('code_rule', 'runbook') AND ${t.validationId} IS NOT NULL
        AND ${t.document}#>>'{validation,id}' = ${t.validationId}::text
        AND (${t.projectId} IS NULL OR ${t.document}#>>'{validation,projectId}' = ${t.projectId}::text)
    END
    AND octet_length(${t.document}::text) <= 61440) IS TRUE`),
]);

export const rulePackageReviews = domain.table('rule_package_reviews', {
  id: uuid('id').primaryKey().defaultRandom(), versionId: uuid('version_id').notNull().references(() => rulePackageVersions.id),
  versionSha256: text('version_sha256').notNull(), sha256: text('sha256').notNull(),
  reviewedBy: uuid('reviewed_by').notNull().references(() => principals.id), grantId: uuid('grant_id').notNull(),
  outcome: text('outcome').$type<RulePackageReviewRecord['outcome']>().notNull(),
  document: jsonb('document').$type<RulePackageReviewRecord>().notNull(), createdAt: createdAt(),
}, t => [
  unique('rule_package_review_grant').on(t.versionId, t.grantId),
  check('rule_package_review_document', sql`(${t.sha256} ~ '^[a-f0-9]{64}$' AND ${t.versionSha256} ~ '^[a-f0-9]{64}$'
    AND ${t.outcome} IN ('accepted', 'changes_requested') AND ${t.document}->>'formatVersion' = '1'
    AND ${t.document}->>'kind' IN ('design_review', 'candidate_review') AND ${t.document}->>'outcome' = ${t.outcome}
    AND ${t.document}->>'versionId' = ${t.versionId}::text AND ${t.document}->>'versionSha256' = ${t.versionSha256}
    AND ${t.document}->>'reviewedBy' = ${t.reviewedBy}::text AND ${t.document}->>'grantId' = ${t.grantId}::text
    AND octet_length(${t.document}::text) <= 8192) IS TRUE`),
]);

export const rulePackageActivations = domain.table('rule_package_activations', {
  packageId: uuid('package_id').notNull().references(() => rulePackages.id), sequence: integer('sequence').notNull(),
  versionId: uuid('version_id').notNull().references(() => rulePackageVersions.id), versionSha256: text('version_sha256').notNull(),
  reviewId: uuid('review_id').references(() => rulePackageReviews.id), reviewSha256: text('review_sha256'),
  action: text('action').$type<'publish' | 'rollback' | 'withdraw'>().notNull(),
  recordedBy: uuid('recorded_by').notNull().references(() => principals.id), grantId: uuid('grant_id').notNull(),
  requestKey: uuid('request_key').notNull(), requestSha256: text('request_sha256').notNull(), createdAt: createdAt(),
}, t => [
  primaryKey({ columns: [t.packageId, t.sequence] }),
  unique('rule_package_activation_request').on(t.packageId, t.requestKey),
  check('rule_package_activation_binding', sql`(${t.sequence} > 0 AND ${t.versionSha256} ~ '^[a-f0-9]{64}$'
    AND ${t.requestSha256} ~ '^[a-f0-9]{64}$' AND CASE WHEN ${t.action} = 'withdraw'
      THEN ${t.reviewId} IS NULL AND ${t.reviewSha256} IS NULL
      ELSE ${t.action} IN ('publish', 'rollback') AND ${t.reviewId} IS NOT NULL AND ${t.reviewSha256} ~ '^[a-f0-9]{64}$'
    END) IS TRUE`),
]);

export const projectMembers = domain.table('project_members', {
  projectId: uuid('project_id').notNull().references(() => projects.id),
  principalId: uuid('principal_id').notNull().references(() => principals.id), role: text('role').notNull(),
  grantId: uuid('grant_id').notNull().defaultRandom(),
}, t => [primaryKey({ columns: [t.projectId, t.principalId] }), unique('project_member_grant').on(t.grantId),
  check('project_role', sql`${t.role} IN ('maintainer', 'viewer')`)]);

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

export const taskRuleSnapshots = domain.table('task_rule_snapshots', {
  taskId: uuid('task_id').primaryKey(), projectId: uuid('project_id').notNull(),
  purpose: text('purpose').$type<TaskRuleSnapshot['purpose']>().notNull(), sha256: text('sha256').notNull(),
  document: jsonb('document').$type<TaskRuleSnapshot>().notNull(), createdAt: createdAt(),
}, t => [
  foreignKey({ name: 'task_rule_snapshot_project_fk', columns: [t.taskId, t.projectId], foreignColumns: [tasks.id, tasks.projectId] }),
  check('task_rule_snapshot_binding', sql`(${t.sha256} ~ '^[a-f0-9]{64}$' AND ${t.purpose} IN ('delivery', 'operations')
    AND ${t.document}->>'version' = '1' AND ${t.document}->>'taskId' = ${t.taskId}::text
    AND ${t.document}->>'projectId' = ${t.projectId}::text AND ${t.document}->>'purpose' = ${t.purpose}
    AND jsonb_typeof(${t.document}->'entries') = 'array' AND octet_length(${t.document}::text) <= 24576) IS TRUE`),
]);

export const learningCases = domain.table('learning_cases', {
  id: uuid('id').primaryKey().defaultRandom(), projectId: uuid('project_id').notNull(),
  taskId: uuid('task_id').notNull(), runId: uuid('run_id').notNull(),
  category: text('category').$type<LearningCaseFacts['category']>().notNull(),
  evidenceSha256: text('evidence_sha256').notNull(), sha256: text('sha256').notNull(),
  capturedBy: uuid('captured_by').notNull().references(() => principals.id), grantId: uuid('grant_id').notNull(),
  document: jsonb('document').$type<LearningCaseDocument>().notNull(), createdAt: createdAt(),
}, t => [
  foreignKey({ name: 'learning_case_task_project_fk', columns: [t.taskId, t.projectId], foreignColumns: [tasks.id, tasks.projectId] }),
  foreignKey({ name: 'learning_case_run_task_fk', columns: [t.runId, t.taskId], foreignColumns: [taskRuns.id, taskRuns.taskId] }),
  unique('learning_case_run_unique').on(t.runId),
  index('learning_case_project_history').on(t.projectId, t.createdAt, t.id),
  index('learning_case_similar_history').on(t.projectId, t.category, t.createdAt, t.id),
  check('learning_case_document', sql`(${t.sha256} ~ '^[a-f0-9]{64}$' AND ${t.evidenceSha256} ~ '^[a-f0-9]{64}$'
    AND ${t.category} IN ('resolved_source_findings', 'reproduced_health_failure', 'recovered_stopped_instance')
    AND ${t.document}->>'version' = '1' AND ${t.document}->>'projectId' = ${t.projectId}::text
    AND ${t.document}->>'taskId' = ${t.taskId}::text AND ${t.document}->>'runId' = ${t.runId}::text
    AND ${t.document}->>'evidenceSha256' = ${t.evidenceSha256} AND ${t.document}#>>'{facts,category}' = ${t.category}
    AND octet_length(${t.document}::text) <= 4096) IS TRUE`),
]);

export const ruleExtractionAdmissions = domain.table('rule_extraction_admissions', {
  runId: uuid('run_id').primaryKey(), taskId: uuid('task_id').notNull(),
  projectId: uuid('project_id').notNull(), caseId: uuid('case_id').notNull().references(() => learningCases.id),
  caseSha256: text('case_sha256').notNull(), providerSha256: text('provider_sha256').notNull(), grantId: uuid('grant_id').notNull(),
}, t => [
  foreignKey({ name: 'rule_extraction_admission_task_fk', columns: [t.taskId, t.projectId], foreignColumns: [tasks.id, tasks.projectId] }),
  foreignKey({ name: 'rule_extraction_admission_run_fk', columns: [t.runId, t.taskId], foreignColumns: [taskRuns.id, taskRuns.taskId] }),
  check('rule_extraction_admission_digests', sql`${t.caseSha256} ~ '^[a-f0-9]{64}$' AND ${t.providerSha256} ~ '^[a-f0-9]{64}$'`),
]);

export const ruleExtractionInputs = domain.table('rule_extraction_inputs', {
  runId: uuid('run_id').primaryKey().references(() => ruleExtractionAdmissions.runId),
  sha256: text('sha256').notNull(), preparedFence: integer('prepared_fence').notNull(),
  workerId: uuid('worker_id').notNull(), document: jsonb('document').$type<RuleExtractionInput>().notNull(),
  createdAt: createdAt(),
}, t => [
  check('rule_extraction_input_binding', sql`(${t.preparedFence} > 0 AND ${t.sha256} ~ '^[a-f0-9]{64}$'
    AND ${t.document}->>'version' = '1' AND ${t.document}->>'runId' = ${t.runId}::text
    AND ${t.document}->>'knowledgeSha256' ~ '^[a-f0-9]{64}$' AND octet_length(${t.document}::text) <= 8192) IS TRUE`),
]);

export const ruleExtractionRuntime = domain.table('rule_extraction_runtime', {
  runId: uuid('run_id').primaryKey().references(() => ruleExtractionInputs.runId), inputSha256: text('input_sha256').notNull(),
  checkpointId: text('checkpoint_id').notNull(), checkpointStep: integer('checkpoint_step').notNull(),
  publishedFence: integer('published_fence').notNull(), workerId: uuid('worker_id').notNull(),
}, t => [
  check('rule_extraction_runtime_binding', sql`${t.inputSha256} ~ '^[a-f0-9]{64}$'
    AND ${t.checkpointStep} >= -1 AND ${t.publishedFence} > 0`),
]);

export const ruleExtractionResults = domain.table('rule_extraction_results', {
  id: uuid('id').primaryKey().defaultRandom(), runId: uuid('run_id').notNull().references(() => ruleExtractionRuntime.runId),
  projectId: uuid('project_id').notNull().references(() => projects.id), inputSha256: text('input_sha256').notNull(),
  checkpointId: text('checkpoint_id').notNull(), finalizedFence: integer('finalized_fence').notNull(), workerId: uuid('worker_id').notNull(),
  sha256: text('sha256').notNull(), candidateKey: text('candidate_key'), candidateKind: text('candidate_kind').$type<'code_rule' | 'runbook'>(),
  candidateSemanticSha256: text('candidate_semantic_sha256'), document: jsonb('document').$type<RuleExtractionResultRecord>().notNull(), createdAt: createdAt(),
}, t => [
  unique('rule_extraction_finalized_run').on(t.runId),
  unique('rule_extraction_candidate_key').on(t.projectId, t.candidateKey),
  unique('rule_extraction_candidate_semantics').on(t.projectId, t.candidateSemanticSha256),
  index('rule_extraction_candidate_history').on(t.projectId, t.candidateKind, t.createdAt, t.id),
  check('rule_extraction_result_binding', sql`(${t.finalizedFence} > 0 AND ${t.sha256} ~ '^[a-f0-9]{64}$' AND ${t.inputSha256} ~ '^[a-f0-9]{64}$'
    AND ${t.document}->>'version' = '1' AND ${t.document}->>'runId' = ${t.runId}::text AND ${t.document}->>'projectId' = ${t.projectId}::text
    AND ${t.document}->>'inputSha256' = ${t.inputSha256} AND ${t.document}->>'checkpointId' = ${t.checkpointId}
    AND octet_length(${t.document}::text) <= 16384
    AND CASE WHEN ${t.document}#>>'{extraction,result,outcome}' = 'candidate' THEN
      ${t.candidateKey} = ${t.document}#>>'{extraction,result,candidate,key}' AND ${t.candidateKind} = ${t.document}#>>'{extraction,result,candidate,kind}'
      AND ${t.candidateKind} IN ('code_rule', 'runbook') AND ${t.candidateSemanticSha256} ~ '^[a-f0-9]{64}$'
      AND ${t.candidateSemanticSha256} = ${t.document}->>'candidateSemanticSha256'
    ELSE ${t.candidateKey} IS NULL AND ${t.candidateKind} IS NULL AND ${t.candidateSemanticSha256} IS NULL
      AND ${t.document}#>>'{extraction,result,outcome}' IN ('retain_case', 'duplicate')
    END) IS TRUE`),
]);

export const candidateValidationAdmissions = domain.table('candidate_validation_admissions', {
  runId: uuid('run_id').primaryKey(), taskId: uuid('task_id').notNull(), projectId: uuid('project_id').notNull(),
  candidateId: uuid('candidate_id').notNull().references(() => ruleExtractionResults.id), grantId: uuid('grant_id').notNull(),
  planSha256: text('plan_sha256').notNull(), plan: jsonb('plan').$type<CandidateValidationPlan>().notNull(),
}, t => [
  foreignKey({ name: 'candidate_validation_admission_task_fk', columns: [t.taskId, t.projectId], foreignColumns: [tasks.id, tasks.projectId] }),
  foreignKey({ name: 'candidate_validation_admission_run_fk', columns: [t.runId, t.taskId], foreignColumns: [taskRuns.id, taskRuns.taskId] }),
  check('candidate_validation_plan', sql`(${t.planSha256} ~ '^[a-f0-9]{64}$' AND ${t.plan}->>'version' = '1'
    AND ${t.plan}->>'candidateId' = ${t.candidateId}::text AND ${t.plan}->>'candidateSha256' ~ '^[a-f0-9]{64}$'
    AND ${t.plan}->>'extractionResultSha256' ~ '^[a-f0-9]{64}$' AND ${t.plan}->>'kind' IN ('code_rule', 'runbook')
    AND octet_length(${t.plan}::text) <= 4096) IS TRUE`),
]);

export const candidateValidationAttempts = domain.table('candidate_validation_attempts', {
  requestId: uuid('request_id').primaryKey(), runId: uuid('run_id').notNull().references(() => candidateValidationAdmissions.runId),
  fence: integer('fence').notNull(), workerId: uuid('worker_id').notNull(), planSha256: text('plan_sha256').notNull(),
  request: jsonb('request').$type<QualifiedRuleValidationRequest>().notNull(), createdAt: createdAt(),
}, t => [
  unique('candidate_validation_attempt_run_fence').on(t.runId, t.fence),
  check('candidate_validation_attempt_binding', sql`(${t.planSha256} ~ '^[a-f0-9]{64}$'
    AND ${t.request}->>'requestId' = ${t.requestId}::text AND ${t.request}->>'runId' = ${t.runId}::text
    AND ${t.request}->>'fence' = ${t.fence}::text AND ${t.fence} > 0
    AND ${t.request}->>'version' = '1' AND ${t.request}->>'operation' = 'validate_rule_samples'
    AND ${t.request}->>'basisSha256' ~ '^[a-f0-9]{64}$' AND ${t.request}->>'commandSha256' ~ '^[a-f0-9]{64}$'
    AND octet_length(${t.request}::text) <= 4096) IS TRUE`),
]);

export const candidateValidationResults = domain.table('candidate_validation_results', {
  id: uuid('id').primaryKey().defaultRandom(), runId: uuid('run_id').notNull().references(() => candidateValidationAdmissions.runId),
  candidateId: uuid('candidate_id').notNull().references(() => ruleExtractionResults.id), projectId: uuid('project_id').notNull().references(() => projects.id),
  requestId: uuid('request_id').references(() => candidateValidationAttempts.requestId),
  planSha256: text('plan_sha256').notNull(), sha256: text('sha256').notNull(), fence: integer('fence').notNull(), workerId: uuid('worker_id').notNull(),
  document: jsonb('document').$type<CandidateValidationRecord>().notNull(), createdAt: createdAt(),
}, t => [
  unique('candidate_validation_result_run').on(t.runId),
  index('candidate_validation_result_candidate').on(t.projectId, t.candidateId, t.createdAt, t.id),
  check('candidate_validation_result_binding', sql`(${t.fence} > 0 AND ${t.planSha256} ~ '^[a-f0-9]{64}$' AND ${t.sha256} ~ '^[a-f0-9]{64}$'
    AND ${t.document}->>'version' = '1' AND ${t.document}->>'candidateId' = ${t.candidateId}::text
    AND ${t.document}->>'runId' = ${t.runId}::text AND ${t.document}->>'projectId' = ${t.projectId}::text
    AND ${t.document}->>'planSha256' = ${t.planSha256} AND ${t.document}->>'status' IN ('passed', 'failed', 'unavailable')
    AND CASE WHEN ${t.document}#>>'{evidence,kind}' = 'code_rule'
      THEN ${t.requestId} IS NOT NULL AND ${t.document}#>>'{evidence,receipt,scope,requestId}' = ${t.requestId}::text
      ELSE ${t.requestId} IS NULL AND ${t.document}#>>'{evidence,kind}' = 'runbook'
    END AND octet_length(${t.document}::text) <= 16384) IS TRUE`),
]);

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
  runId: uuid('run_id').notNull().references(() => taskRuns.id),
  graph: text('graph').$type<'preflight' | 'audit' | 'repair' | 'verify' | 'operations' | 'rule-extraction'>().notNull().default('preflight'),
  checkpointId: text('checkpoint_id').notNull(),
  writeHash: text('write_hash').notNull(),
}, t => [primaryKey({ columns: [t.runId, t.graph, t.checkpointId, t.writeHash] }),
  check('checkpoint_write_graph', sql`${t.graph} IN ('preflight', 'audit', 'repair', 'verify', 'operations', 'rule-extraction')`)]);

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
  materializedFrom: jsonb('materialized_from').$type<MaterializedSourceBasis>(),
  publishedCode: jsonb('published_code').$type<PublishedInspectionBasis>(),
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
  check('inspection_attempt_materialized_binding', sql`((${t.materializedFrom} IS NULL OR (
    ${t.materializedFrom}->>'commit' ~ '^[a-f0-9]{40}$' AND ${t.materializedFrom}->>'commit' <> ${t.commit}
    AND ${t.materializedFrom}->>'baseSnapshotSha256' ~ '^[a-f0-9]{64}$' AND octet_length(${t.materializedFrom}::text) <= 512))
    AND (${t.state} <> 'recorded' OR ${t.receipt}#>'{scope,materializedFrom}' IS NOT DISTINCT FROM ${t.materializedFrom})) IS TRUE`),
  check('inspection_attempt_published_code_binding', sql`((${t.publishedCode} IS NULL OR (
    ${t.publishedCode}->>'snapshotSha256' ~ '^[a-f0-9]{64}$'
    AND ${t.publishedCode}#>>'{binding,commandSha256}' ~ '^[a-f0-9]{64}$'
    AND ${t.publishedCode}#>>'{binding,runnerImageSha256}' = ${t.imageSha256}
    AND ${t.publishedCode}#>>'{profile,runnerImageSha256}' = ${t.imageSha256}
    AND ${t.publishedCode}#>>'{profile,engine}' = 'semgrep_ce'
    AND ${t.publishedCode}#>>'{profile,engineInputsSha256}' ~ '^[a-f0-9]{64}$'
    AND octet_length(${t.publishedCode}::text) <= 2048))
    AND (${t.state} <> 'recorded' OR (${t.receipt}#>'{scope,publishedCode}' IS NOT DISTINCT FROM ${t.publishedCode}->'binding'
      AND ${t.receipt}#>>'{snapshot,publishedCode,commandSha256}' IS NOT DISTINCT FROM ${t.publishedCode}#>>'{binding,commandSha256}'
      AND ${t.receipt}#>>'{snapshot,publishedCode,scan,document,basis,snapshotSha256}' IS NOT DISTINCT FROM ${t.publishedCode}->>'snapshotSha256'))) IS TRUE`),
  check('inspection_attempt_state', sql`(
    (${t.state} = 'reserved' AND ${t.settledFence} IS NULL AND ${t.settledAt} IS NULL)
    OR (${t.state} IN ('closed', 'uncertain', 'recorded') AND ${t.settledFence} >= ${t.fence} AND ${t.settledAt} IS NOT NULL)
  ) IS TRUE`),
  check('inspection_attempt_receipt_binding', sql`(
    (${t.state} <> 'recorded' AND ${t.receipt} IS NULL AND ${t.receiptSha256} IS NULL)
    OR (${t.state} = 'recorded' AND ${t.settledFence} = ${t.fence} AND ${t.receiptSha256} ~ '^[a-f0-9]{64}$'
      AND octet_length(${t.receipt}::text) <= CASE WHEN ${t.publishedCode} IS NULL THEN 4202496 ELSE 13631488 END
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

export const formalAuditInputs = domain.table('formal_audit_inputs', {
  runId: uuid('run_id').primaryKey(), taskId: uuid('task_id').notNull(), projectId: uuid('project_id').notNull(),
  inspectionRequestId: uuid('inspection_request_id').notNull().references(() => inspectionAttempts.requestId),
  preparedFence: integer('prepared_fence').notNull(), workerId: uuid('worker_id').notNull(),
  sha256: text('sha256').notNull(), document: jsonb('document').$type<FormalAuditInput>().notNull(), createdAt: createdAt(),
}, t => [
  foreignKey({ name: 'formal_audit_run_task', columns: [t.runId, t.taskId], foreignColumns: [taskRuns.id, taskRuns.taskId] }),
  foreignKey({ name: 'formal_audit_task_project', columns: [t.taskId, t.projectId], foreignColumns: [tasks.id, tasks.projectId] }),
  check('formal_audit_input_binding', sql`(${t.preparedFence} > 0 AND ${t.sha256} ~ '^[a-f0-9]{64}$'
    AND ${t.document}->>'version' = '1' AND ${t.document}->>'taskId' = ${t.taskId}::text AND ${t.document}->>'runId' = ${t.runId}::text
    AND ${t.document}->>'projectId' = ${t.projectId}::text AND ${t.document}#>>'{inspection,requestId}' = ${t.inspectionRequestId}::text
    AND octet_length(${t.document}::text) <= 65536) IS TRUE`),
]);

export const formalAuditRuntime = domain.table('formal_audit_runtime', {
  runId: uuid('run_id').primaryKey().references(() => formalAuditInputs.runId), inputSha256: text('input_sha256').notNull(),
  checkpointId: text('checkpoint_id').notNull(), checkpointStep: integer('checkpoint_step').notNull(),
  publishedFence: integer('published_fence').notNull(), workerId: uuid('worker_id').notNull(),
}, t => [check('formal_audit_runtime_binding', sql`${t.inputSha256} ~ '^[a-f0-9]{64}$' AND ${t.checkpointStep} >= -1 AND ${t.publishedFence} > 0`)]);

export const formalAuditResults = domain.table('formal_audit_results', {
  runId: uuid('run_id').primaryKey().references(() => formalAuditRuntime.runId),
  inputSha256: text('input_sha256').notNull(), checkpointId: text('checkpoint_id').notNull(),
  finalizedFence: integer('finalized_fence').notNull(), workerId: uuid('worker_id').notNull(),
  sha256: text('sha256').notNull(), document: jsonb('document').$type<FormalAuditResult>().notNull(), createdAt: createdAt(),
}, t => [check('formal_audit_result_binding', sql`(${t.finalizedFence} > 0 AND ${t.sha256} ~ '^[a-f0-9]{64}$' AND ${t.inputSha256} ~ '^[a-f0-9]{64}$'
  AND ${t.document}->>'version' = '1' AND ${t.document}->>'runId' = ${t.runId}::text
  AND ${t.document}->>'inputSha256' = ${t.inputSha256} AND ${t.document}->>'checkpointId' = ${t.checkpointId}
  AND octet_length(${t.document}::text) <= 98304) IS TRUE`)]);

export const formalRepairInputs = domain.table('formal_repair_inputs', {
  runId: uuid('run_id').primaryKey().references(() => formalAuditResults.runId),
  preparedFence: integer('prepared_fence').notNull(), workerId: uuid('worker_id').notNull(),
  sha256: text('sha256').notNull(), document: jsonb('document').$type<FormalRepairInput>().notNull(), createdAt: createdAt(),
}, t => [check('formal_repair_input_binding', sql`(${t.preparedFence} > 0 AND ${t.sha256} ~ '^[a-f0-9]{64}$'
  AND ${t.document}->>'version' = '1' AND ${t.document}->>'runId' = ${t.runId}::text
  AND octet_length(${t.document}::text) <= 8192) IS TRUE`)]);

export const formalRepairRuntime = domain.table('formal_repair_runtime', {
  runId: uuid('run_id').primaryKey().references(() => formalRepairInputs.runId), inputSha256: text('input_sha256').notNull(),
  checkpointId: text('checkpoint_id').notNull(), checkpointStep: integer('checkpoint_step').notNull(),
  publishedFence: integer('published_fence').notNull(), workerId: uuid('worker_id').notNull(),
}, t => [check('formal_repair_runtime_binding', sql`${t.inputSha256} ~ '^[a-f0-9]{64}$' AND ${t.checkpointStep} >= -1 AND ${t.publishedFence} > 0`)]);

export const formalRepairOperations = domain.table('formal_repair_operations', {
  operationId: uuid('operation_id').primaryKey(),
  runId: uuid('run_id').notNull().references(() => formalRepairInputs.runId),
  callKeySha256: text('call_key_sha256').notNull(), inputSha256: text('input_sha256').notNull(),
  commandSha256: text('command_sha256').notNull(), command: text('command').notNull(),
  findingIds: jsonb('finding_ids').$type<string[]>().notNull(),
  preparedFence: integer('prepared_fence').notNull(), workerId: uuid('worker_id').notNull(), createdAt: createdAt(),
}, t => [
  unique('formal_repair_operation_call').on(t.runId, t.callKeySha256),
  check('formal_repair_operation_command', sql`(${t.preparedFence} > 0 AND ${t.callKeySha256} ~ '^[a-f0-9]{64}$'
    AND ${t.inputSha256} ~ '^[a-f0-9]{64}$' AND octet_length(${t.command}) BETWEEN 1 AND 2097152
    AND ${t.commandSha256} = encode(sha256(convert_to(${t.command}, 'UTF8')), 'hex')
    AND ${t.command}::jsonb#>>'{workspace,operationId}' = ${t.operationId}::text
    AND ${t.command}::jsonb#>>'{workspace,repairInputSha256}' = ${t.inputSha256}
    AND jsonb_typeof(${t.findingIds}) = 'array' AND jsonb_array_length(${t.findingIds}) BETWEEN 1 AND 32) IS TRUE`),
]);

export const formalRepairAttempts = domain.table('formal_repair_attempts', {
  requestId: uuid('request_id').primaryKey(),
  operationId: uuid('operation_id').notNull().references(() => formalRepairOperations.operationId),
  fence: integer('fence').notNull(), workerId: uuid('worker_id').notNull(),
  workspaceSha256: text('workspace_sha256').notNull(), imageSha256: text('image_sha256').notNull(),
  originSha256: text('origin_sha256').notNull(),
  state: text('state').$type<'reserved' | 'closed' | 'uncertain' | 'recorded'>().notNull().default('reserved'),
  settledFence: integer('settled_fence'), settledWorkerId: uuid('settled_worker_id'),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  receiptSha256: text('receipt_sha256'), receipt: jsonb('receipt').$type<QualifiedRepairReceipt>(),
  createdAt: createdAt(),
}, t => [
  unique('formal_repair_attempt_per_fence').on(t.operationId, t.fence),
  uniqueIndex('formal_repair_open_attempt').on(t.operationId).where(sql`${t.state} <> 'closed'`),
  check('formal_repair_attempt_coordinates', sql`${t.fence} > 0 AND ${t.workspaceSha256} ~ '^[a-f0-9]{64}$'
    AND ${t.imageSha256} ~ '^[a-f0-9]{64}$' AND ${t.originSha256} ~ '^[a-f0-9]{64}$'`),
  check('formal_repair_attempt_state', sql`(
    (${t.state} = 'reserved' AND ${t.settledFence} IS NULL AND ${t.settledWorkerId} IS NULL AND ${t.settledAt} IS NULL)
    OR (${t.state} IN ('closed', 'uncertain', 'recorded') AND ${t.settledFence} >= ${t.fence}
      AND ${t.settledWorkerId} IS NOT NULL AND ${t.settledAt} IS NOT NULL)) IS TRUE`),
  check('formal_repair_attempt_receipt', sql`(
    (${t.state} <> 'recorded' AND ${t.receipt} IS NULL AND ${t.receiptSha256} IS NULL)
    OR (${t.state} = 'recorded' AND ${t.settledFence} = ${t.fence} AND ${t.settledWorkerId} = ${t.workerId}
      AND ${t.receiptSha256} ~ '^[a-f0-9]{64}$' AND octet_length(${t.receipt}::text) <= 32768
      AND ${t.receipt}->>'kind' = 'repair_receipt' AND ${t.receipt}->'cleanupConfirmed' = 'true'::jsonb
      AND ${t.receipt}->'sessionVerified' = 'true'::jsonb AND ${t.receipt}->>'originSha256' = ${t.originSha256}
      AND ${t.receipt}->>'imageSha256' = ${t.imageSha256}
      AND ${t.receipt}#>>'{scope,requestId}' = ${t.requestId}::text AND ${t.receipt}#>>'{scope,operationId}' = ${t.operationId}::text
      AND ${t.receipt}#>>'{scope,workspaceSha256}' = ${t.workspaceSha256} AND ${t.receipt}#>>'{scope,fence}' = ${t.fence}::text
      AND ${t.receipt}->>'domainId' = ${t.receipt}#>>'{snapshot,runId}'
      AND ${t.receipt}#>'{snapshot,offline}' = 'true'::jsonb AND ${t.receipt}#>'{snapshot,readOnly}' = 'true'::jsonb)
  ) IS TRUE`),
]);

export const formalRepairResults = domain.table('formal_repair_results', {
  runId: uuid('run_id').primaryKey().references(() => formalRepairRuntime.runId),
  inputSha256: text('input_sha256').notNull(), checkpointId: text('checkpoint_id').notNull(),
  requestId: uuid('request_id').references(() => formalRepairAttempts.requestId),
  finalizedFence: integer('finalized_fence').notNull(), workerId: uuid('worker_id').notNull(),
  sha256: text('sha256').notNull(), document: jsonb('document').$type<FormalRepairResult>().notNull(), createdAt: createdAt(),
}, t => [check('formal_repair_result_binding', sql`(${t.finalizedFence} > 0 AND ${t.sha256} ~ '^[a-f0-9]{64}$'
  AND ${t.inputSha256} ~ '^[a-f0-9]{64}$' AND ${t.document}->>'version' = '1' AND ${t.document}->>'runId' = ${t.runId}::text
  AND ${t.document}->>'inputSha256' = ${t.inputSha256} AND ${t.document}->>'checkpointId' = ${t.checkpointId}
  AND ${t.document}->'releaseEligible' = 'false'::jsonb AND octet_length(${t.document}::text) <= 16384
  AND ((${t.requestId} IS NOT NULL AND ${t.document}->>'status' = 'candidate_ready' AND ${t.document}->>'reason' = 'repair_complete'
      AND jsonb_typeof(${t.document}->'candidate') = 'object')
    OR (${t.requestId} IS NULL AND ${t.document}->>'status' = 'requires_human' AND ${t.document}->'candidate' = 'null'::jsonb))) IS TRUE`)]);

export const formalVerificationInputs = domain.table('formal_verification_inputs', {
  runId: uuid('run_id').primaryKey().references(() => formalRepairInputs.runId),
  preparedFence: integer('prepared_fence').notNull(), workerId: uuid('worker_id').notNull(),
  sha256: text('sha256').notNull(), document: jsonb('document').$type<FormalVerificationInput>().notNull(), createdAt: createdAt(),
}, t => [check('formal_verification_input_binding', sql`(${t.preparedFence} > 0 AND ${t.sha256} ~ '^[a-f0-9]{64}$'
  AND ${t.document}->>'version' = '1' AND ${t.document}->>'runId' = ${t.runId}::text
  AND octet_length(${t.document}::text) <= 8192) IS TRUE`)]);

export const formalVerificationRuntime = domain.table('formal_verification_runtime', {
  runId: uuid('run_id').primaryKey().references(() => formalVerificationInputs.runId),
  inputSha256: text('input_sha256').notNull(), receiptSha256: text('receipt_sha256').notNull(),
  checkpointId: text('checkpoint_id').notNull(), checkpointStep: integer('checkpoint_step').notNull(),
  publishedFence: integer('published_fence').notNull(), workerId: uuid('worker_id').notNull(),
}, t => [check('formal_verification_runtime_binding', sql`${t.inputSha256} ~ '^[a-f0-9]{64}$'
  AND ${t.receiptSha256} ~ '^[a-f0-9]{64}$' AND ${t.checkpointStep} >= -1 AND ${t.publishedFence} > 0`)]);

export const formalRescanAttempts = domain.table('formal_rescan_attempts', {
  requestId: uuid('request_id').primaryKey(),
  runId: uuid('run_id').notNull().references(() => formalVerificationInputs.runId),
  inputSha256: text('input_sha256').notNull(), fence: integer('fence').notNull(), workerId: uuid('worker_id').notNull(),
  workspaceSha256: text('workspace_sha256').notNull(), imageSha256: text('image_sha256').notNull(),
  originSha256: text('origin_sha256').notNull(),
  state: text('state').$type<'reserved' | 'uncertain' | 'closed' | 'recorded'>().notNull().default('reserved'),
  settledFence: integer('settled_fence'), settledWorkerId: uuid('settled_worker_id'), settledAt: timestamp('settled_at', { withTimezone: true }),
  receiptSha256: text('receipt_sha256'), receipt: jsonb('receipt').$type<QualifiedVerificationReceipt>(), createdAt: createdAt(),
}, t => [
  unique('formal_rescan_attempt_per_fence').on(t.runId, t.fence),
  uniqueIndex('formal_rescan_open_attempt').on(t.runId).where(sql`${t.state} <> 'closed'`),
  check('formal_rescan_attempt_coordinates', sql`${t.fence} > 0 AND ${t.inputSha256} ~ '^[a-f0-9]{64}$'
    AND ${t.workspaceSha256} ~ '^[a-f0-9]{64}$' AND ${t.imageSha256} ~ '^[a-f0-9]{64}$' AND ${t.originSha256} ~ '^[a-f0-9]{64}$'`),
  check('formal_rescan_attempt_state', sql`((${t.state} = 'reserved' AND ${t.settledFence} IS NULL
    AND ${t.settledWorkerId} IS NULL AND ${t.settledAt} IS NULL) OR (${t.state} IN ('closed', 'uncertain', 'recorded')
    AND ${t.settledFence} >= ${t.fence} AND ${t.settledWorkerId} IS NOT NULL AND ${t.settledAt} IS NOT NULL)) IS TRUE`),
  check('formal_rescan_attempt_receipt', sql`((${t.state} <> 'recorded' AND ${t.receiptSha256} IS NULL AND ${t.receipt} IS NULL) OR (
    ${t.state} = 'recorded' AND ${t.settledFence} = ${t.fence} AND ${t.settledWorkerId} = ${t.workerId}
    AND ${t.receiptSha256} ~ '^[a-f0-9]{64}$' AND octet_length(${t.receipt}::text)
      <= CASE WHEN ${t.receipt}#>>'{scope,publishedCodeRuleSetSha256}' IS NULL THEN 9437184 ELSE 18874368 END
    AND ${t.receipt}->>'kind' = 'verification_receipt' AND ${t.receipt}->'cleanupConfirmed' = 'true'::jsonb
    AND ${t.receipt}->'sessionVerified' = 'true'::jsonb AND ${t.receipt}->>'originSha256' = ${t.originSha256}
    AND ${t.receipt}->>'imageSha256' = ${t.imageSha256} AND ${t.receipt}->>'domainId' = ${t.receipt}#>>'{snapshot,runId}'
    AND ${t.receipt}#>>'{scope,requestId}' = ${t.requestId}::text AND ${t.receipt}#>>'{scope,runId}' = ${t.runId}::text
    AND ${t.receipt}#>>'{scope,fence}' = ${t.fence}::text AND ${t.receipt}#>>'{scope,workspaceSha256}' = ${t.workspaceSha256}
    AND ${t.receipt}#>>'{scope,verificationInputSha256}' = ${t.inputSha256}
    AND ${t.receipt}#>'{snapshot,offline}' = 'true'::jsonb AND ${t.receipt}#>'{snapshot,readOnly}' = 'true'::jsonb)) IS TRUE`),
]);

export const formalVerificationResults = domain.table('formal_verification_results', {
  runId: uuid('run_id').primaryKey().references(() => formalVerificationRuntime.runId),
  requestId: uuid('request_id').notNull().references(() => formalRescanAttempts.requestId),
  inputSha256: text('input_sha256').notNull(), receiptSha256: text('receipt_sha256').notNull(), checkpointId: text('checkpoint_id').notNull(),
  finalizedFence: integer('finalized_fence').notNull(), workerId: uuid('worker_id').notNull(),
  sha256: text('sha256').notNull(), document: jsonb('document').$type<FormalVerificationResult>().notNull(), createdAt: createdAt(),
}, t => [check('formal_verification_result_binding', sql`(${t.finalizedFence} > 0 AND ${t.sha256} ~ '^[a-f0-9]{64}$'
  AND ${t.inputSha256} ~ '^[a-f0-9]{64}$' AND ${t.receiptSha256} ~ '^[a-f0-9]{64}$'
  AND ${t.document}->>'version' = '1' AND ${t.document}->>'runId' = ${t.runId}::text AND ${t.document}->>'requestId' = ${t.requestId}::text
  AND ${t.document}->>'inputSha256' = ${t.inputSha256} AND ${t.document}->>'receiptSha256' = ${t.receiptSha256}
  AND ${t.document}->>'checkpointId' = ${t.checkpointId} AND ${t.document}->'releaseEligible' = 'false'::jsonb
  AND octet_length(${t.document}::text) <= 16384
  AND ((${t.document}->>'status' = 'reviewed' AND jsonb_typeof(${t.document}->'review') = 'object')
    OR (${t.document}->>'status' = 'requires_human' AND ${t.document}->'review' = 'null'::jsonb))) IS TRUE`)]);

export const formalRepairRetries = domain.table('formal_repair_retries', {
  taskId: uuid('task_id').primaryKey().references(() => tasks.id),
  previousRunId: uuid('previous_run_id').notNull().references(() => formalVerificationResults.runId),
  runId: uuid('run_id').notNull(),
  grantId: uuid('grant_id').notNull(), workerId: uuid('worker_id').notNull(), preparedFence: integer('prepared_fence').notNull(),
  sha256: text('sha256').notNull(), document: jsonb('document').$type<FormalRepairContinuation>().notNull(), createdAt: createdAt(),
}, t => [
  unique('formal_repair_retry_run').on(t.runId),
  foreignKey({ name: 'formal_repair_retry_task_run_fk', columns: [t.runId, t.taskId], foreignColumns: [taskRuns.id, taskRuns.taskId] }),
  check('formal_repair_retry_binding', sql`(${t.preparedFence} > 0 AND ${t.sha256} ~ '^[a-f0-9]{64}$'
    AND ${t.document}->>'version' = '1' AND ${t.document}->>'taskId' = ${t.taskId}::text AND ${t.document}->>'runId' = ${t.runId}::text
    AND ${t.document}#>>'{previous,previousRunId}' = ${t.previousRunId}::text AND ${t.previousRunId} <> ${t.runId}
    AND octet_length(${t.document}::text) <= 8192) IS TRUE`),
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

export const formalReleaseTargets = domain.table('formal_release_targets', {
  environmentId: uuid('environment_id').primaryKey(), projectId: uuid('project_id').notNull(), applicationId: uuid('application_id').notNull(),
  deploymentId: text('deployment_id').notNull(), revision: integer('revision').notNull(),
  sha256: text('sha256').notNull(), document: jsonb('document').$type<FormalReleaseTarget>().notNull(), createdAt: createdAt(),
}, t => [
  foreignKey({ name: 'formal_release_target_environment_fk', columns: [t.environmentId, t.projectId, t.applicationId],
    foreignColumns: [environments.id, environments.projectId, environments.applicationId] }),
  unique('formal_release_target_deployment_unique').on(t.deploymentId),
  check('formal_release_target_binding', sql`(${t.revision} > 0 AND ${t.sha256} ~ '^[a-f0-9]{64}$'
    AND ${t.deploymentId} ~ '^[a-f0-9]{24}$' AND ${t.document}->>'deploymentId' = ${t.deploymentId}
    AND ${t.document}->>'environmentId' = ${t.environmentId}::text AND octet_length(${t.document}::text) <= 4096) IS TRUE`),
]);

export const operationsTargets = domain.table('operations_targets', {
  environmentId: uuid('environment_id').primaryKey().references(() => formalReleaseTargets.environmentId),
  projectId: uuid('project_id').notNull(), applicationId: uuid('application_id').notNull(),
  revision: integer('revision').notNull(), sha256: text('sha256').notNull(),
  document: jsonb('document').$type<OperationsTargetInput>().notNull(), createdAt: createdAt(),
}, t => [
  foreignKey({ name: 'operations_target_environment_fk', columns: [t.environmentId, t.projectId, t.applicationId],
    foreignColumns: [environments.id, environments.projectId, environments.applicationId] }),
  check('operations_target_binding', sql`(${t.revision} > 0 AND ${t.sha256} ~ '^[a-f0-9]{64}$'
    AND ${t.document}->>'environmentId' = ${t.environmentId}::text
    AND jsonb_typeof(${t.document}->'whiskers') = 'object' AND octet_length(${t.document}::text) <= 4096) IS TRUE`),
]);

export const operationsRestartInstallations = domain.table('operations_restart_installations', {
  id: uuid('id').primaryKey(),
  environmentId: uuid('environment_id').notNull().references(() => operationsTargets.environmentId),
  enrollmentSha256: text('enrollment_sha256').notNull(),
  installationSha256: text('installation_sha256').notNull(),
  credentialSha256: text('credential_sha256').notNull(),
  document: jsonb('document').$type<OperationsRestartInstallation>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
}, t => [
  unique('operations_restart_writer_credential').on(t.credentialSha256),
  uniqueIndex('operations_restart_writer_active').on(t.environmentId).where(sql`${t.retiredAt} IS NULL`),
  check('operations_restart_writer_binding', sql`(${t.enrollmentSha256} ~ '^[a-f0-9]{64}$' AND ${t.installationSha256} ~ '^[a-f0-9]{64}$'
    AND ${t.credentialSha256} ~ '^[a-f0-9]{64}$' AND ${t.document}->>'version' = '1'
    AND ${t.document}->>'installationId' = ${t.id}::text AND ${t.document}->>'environmentId' = ${t.environmentId}::text
    AND ${t.document}->>'enrollmentSha256' = ${t.enrollmentSha256}
    AND ${t.document}->>'credentialSha256' = ${t.credentialSha256}
    AND ${t.document}->>'policySha256' ~ '^[a-f0-9]{64}$' AND ${t.document}->>'rolesSha256' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(${t.document}->'whiskers') = 'object' AND octet_length(${t.document}::text) <= 4096) IS TRUE`),
  check('operations_restart_writer_retirement', sql`${t.retiredAt} IS NULL OR ${t.retiredAt} >= ${t.createdAt}`),
]);

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
  document: jsonb('document').$type<FixtureReleaseManifest | FormalReleaseManifest>().notNull(),
  createdAt: createdAt(),
}, t => [
  foreignKey({ name: 'release_candidate_task_project_fk', columns: [t.taskId, t.projectId], foreignColumns: [tasks.id, tasks.projectId] }),
  foreignKey({ name: 'release_candidate_run_task_fk', columns: [t.runId, t.taskId], foreignColumns: [taskRuns.id, taskRuns.taskId] }),
  foreignKey({ name: 'release_candidate_environment_scope_fk', columns: [t.environmentId, t.projectId, t.applicationId],
    foreignColumns: [environments.id, environments.projectId, environments.applicationId] }),
  unique('release_candidate_evidence_version').on(t.taskId, t.evidenceVersion),
  unique('release_candidate_environment_pair').on(t.id, t.environmentId),
  check('release_candidate_binding', sql`(${t.evidenceVersion} > 0 AND ${t.fingerprint} ~ '^[a-f0-9]{64}$'
    AND ${t.document}->>'version' = '1' AND ${t.document}->>'origin' IN ('trusted_fixture', 'formal_verification')
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
  wakeupJobId: uuid('wakeup_job_id'),
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
  unique('release_operation_wakeup_unique').on(t.wakeupJobId),
  uniqueIndex('release_operation_environment_hold').on(t.environmentId).where(sql`${t.state} IN ('dispatching', 'reconciling')`),
  check('release_operation_single_approval', sql`${t.approvalVersion} = 1`),
  check('release_operation_state', sql`${t.state} IN ('queued', 'dispatching', 'reconciling', 'verified_fixture', 'verified_formal', 'blocked')`),
  check('release_operation_wakeup_recoverable', sql`${t.wakeupJobId} IS NULL OR ${t.state} IN ('queued', 'reconciling')`),
  check('release_operation_observation', sql`(
    (${t.state} <> 'verified_fixture' AND ${t.observation} IS NULL) OR
    (${t.state} = 'verified_fixture' AND ${t.observation}->>'origin' = 'trusted_fixture'
      AND ${t.observation}->>'operationId' = ${t.id}::text
      AND ${t.observation}->>'environmentId' = ${t.environmentId}::text
      AND ${t.observation}->'healthy' = 'true'::jsonb AND ${t.observation}->'accessProtected' = 'true'::jsonb
      AND octet_length(${t.observation}::text) <= 4096)
  ) IS TRUE`),
]);

export const operationsRequests = domain.table('operations_requests', {
  runId: uuid('run_id').primaryKey(), taskId: uuid('task_id').notNull(), projectId: uuid('project_id').notNull(),
  applicationId: uuid('application_id').notNull(), environmentId: uuid('environment_id').notNull(),
  releaseOperationId: uuid('release_operation_id').notNull().references(() => releaseOperations.id),
  sha256: text('sha256').notNull(), document: jsonb('document').$type<OperationsRequestBinding>().notNull(), createdAt: createdAt(),
}, t => [
  foreignKey({ name: 'operations_request_run_task', columns: [t.runId, t.taskId], foreignColumns: [taskRuns.id, taskRuns.taskId] }),
  foreignKey({ name: 'operations_request_task_project', columns: [t.taskId, t.projectId], foreignColumns: [tasks.id, tasks.projectId] }),
  foreignKey({ name: 'operations_request_environment', columns: [t.environmentId, t.projectId, t.applicationId],
    foreignColumns: [environments.id, environments.projectId, environments.applicationId] }),
  check('operations_request_binding', sql`(${t.sha256} ~ '^[a-f0-9]{64}$' AND ${t.document}->>'version' = '1'
    AND ${t.document}->>'projectId' = ${t.projectId}::text AND ${t.document}->>'applicationId' = ${t.applicationId}::text
    AND ${t.document}->>'environmentId' = ${t.environmentId}::text AND ${t.document}->>'releaseOperationId' = ${t.releaseOperationId}::text
    AND octet_length(${t.document}::text) <= 4096) IS TRUE`),
]);

export const operationsObservations = domain.table('operations_observations', {
  runId: uuid('run_id').primaryKey().references(() => operationsRequests.runId),
  workerId: uuid('worker_id').notNull(), fence: integer('fence').notNull(), bindingSha256: text('binding_sha256').notNull(),
  sha256: text('sha256').notNull(), document: jsonb('document').$type<OperationsObservationReceipt>().notNull(), createdAt: createdAt(),
}, t => [check('operations_observation_binding', sql`(${t.fence} > 0 AND ${t.bindingSha256} ~ '^[a-f0-9]{64}$' AND ${t.sha256} ~ '^[a-f0-9]{64}$'
  AND ${t.document}->>'version' = '1' AND ${t.document}->>'runId' = ${t.runId}::text AND ${t.document}->>'fence' = ${t.fence}::text
  AND ${t.document}->>'bindingSha256' = ${t.bindingSha256} AND octet_length(${t.document}::text) <= 4096) IS TRUE`)]);

export const operationsDiagnosisInputs = domain.table('operations_diagnosis_inputs', {
  runId: uuid('run_id').primaryKey().references(() => operationsRequests.runId),
  inputSha256: text('input_sha256').notNull(), providerSha256: text('provider_sha256').notNull(), createdAt: createdAt(),
}, t => [check('operations_diagnosis_fingerprints', sql`${t.inputSha256} ~ '^[a-f0-9]{64}$' AND ${t.providerSha256} ~ '^[a-f0-9]{64}$'`)]);

export const operationsDiagnosisRuntime = domain.table('operations_diagnosis_runtime', {
  runId: uuid('run_id').primaryKey().references(() => operationsDiagnosisInputs.runId),
  inputSha256: text('input_sha256').notNull(), checkpointId: text('checkpoint_id').notNull(),
  checkpointStep: integer('checkpoint_step').notNull(), publishedFence: integer('published_fence').notNull(),
  workerId: uuid('worker_id').notNull(),
}, t => [check('operations_diagnosis_runtime_binding', sql`${t.inputSha256} ~ '^[a-f0-9]{64}$'
  AND char_length(${t.checkpointId}) BETWEEN 1 AND 128 AND ${t.checkpointStep} >= -1 AND ${t.publishedFence} > 0`)]);

export const operationsDiagnosisReads = domain.table('operations_diagnosis_reads', {
  runId: uuid('run_id').notNull().references(() => operationsDiagnosisInputs.runId),
  section: text('section').$type<OperationsDiagnosisSection>().notNull(), operationId: text('operation_id').notNull(),
  workerId: uuid('worker_id').notNull(), fence: integer('fence').notNull(), attempts: integer('attempts').notNull(),
  state: text('state').$type<'reserved' | 'recorded'>().notNull(), sha256: text('sha256'),
  document: jsonb('document').$type<OperationsDiagnosisObservation>(),
  createdAt: createdAt(), recordedAt: timestamp('recorded_at', { withTimezone: true }),
}, t => [
  primaryKey({ columns: [t.runId, t.section] }),
  unique('operations_diagnosis_operation_per_run').on(t.runId, t.operationId),
  check('operations_diagnosis_read_shape', sql`(${t.section} IN ('container', 'release', 'logs', 'metrics') AND ${t.fence} > 0
    AND ${t.attempts} BETWEEN 1 AND 2 AND ${t.operationId} ~ '^[a-f0-9]{64}$'
    AND ((${t.state} = 'reserved' AND ${t.document} IS NULL AND ${t.sha256} IS NULL AND ${t.recordedAt} IS NULL)
      OR (${t.state} = 'recorded' AND ${t.document}->>'kind' = 'operations_section' AND ${t.document}->>'section' = ${t.section}
        AND ${t.document}->>'proofSha256' ~ '^[a-f0-9]{64}$' AND ${t.sha256} ~ '^[a-f0-9]{64}$' AND ${t.recordedAt} >= ${t.createdAt}
        AND octet_length(${t.document}::text) <= 4096))) IS TRUE`),
]);

export const operationsDiagnosisResults = domain.table('operations_diagnosis_results', {
  runId: uuid('run_id').primaryKey().references(() => operationsDiagnosisRuntime.runId),
  workerId: uuid('worker_id').notNull(), fence: integer('fence').notNull(), checkpointId: text('checkpoint_id').notNull(),
  sha256: text('sha256').notNull(), document: jsonb('document').$type<OperationsDiagnosisReceipt>().notNull(), createdAt: createdAt(),
}, t => [check('operations_diagnosis_result_binding', sql`(${t.fence} > 0 AND ${t.sha256} ~ '^[a-f0-9]{64}$'
  AND ${t.document}->>'version' = '1' AND ${t.document}->>'runId' = ${t.runId}::text AND ${t.document}->>'fence' = ${t.fence}::text
  AND ${t.document}->>'checkpointId' = ${t.checkpointId} AND ${t.document}->>'observationSha256' ~ '^[a-f0-9]{64}$'
  AND octet_length(${t.document}::text) <= 8192) IS TRUE`)]);

export const operationsProposals = domain.table('operations_proposals', {
  id: uuid('id').primaryKey(), diagnosisRunId: uuid('diagnosis_run_id').notNull().references(() => operationsDiagnosisResults.runId),
  environmentId: uuid('environment_id').notNull().references(() => environments.id),
  proposedBy: uuid('proposed_by').notNull().references(() => principals.id), grantId: uuid('grant_id').notNull(),
  fingerprint: text('fingerprint').notNull(), document: jsonb('document').$type<OperationsProposal>().notNull(),
  createdAt: createdAt(), validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
}, t => [
  unique('operations_proposal_per_diagnosis').on(t.diagnosisRunId),
  check('operations_proposal_binding', sql`(${t.createdAt} < ${t.validUntil} AND ${t.fingerprint} ~ '^[a-f0-9]{64}$'
    AND ${t.document}->>'version' = '1' AND ${t.document}#>>'{diagnosis,runId}' = ${t.diagnosisRunId}::text
    AND ${t.document}#>>'{target,environmentId}' = ${t.environmentId}::text
    AND ${t.document}->>'proposedBy' = ${t.proposedBy}::text AND ${t.document}->>'grantId' = ${t.grantId}::text
    AND ${t.document}#>>'{action,kind}' IN ('restart', 'rollback')
    AND ${t.document}->>'targetProofSha256' ~ '^[a-f0-9]{64}$' AND octet_length(${t.document}::text) <= 8192) IS TRUE`),
]);

export const operationsDecisions = domain.table('operations_decisions', {
  proposalId: uuid('proposal_id').notNull().references(() => operationsProposals.id),
  version: integer('version').notNull(), actorId: uuid('actor_id').notNull().references(() => principals.id),
  grantId: uuid('grant_id').notNull(), idempotencyKey: uuid('idempotency_key').notNull(),
  action: text('action').$type<ReleaseDecision>().notNull(), selfConfirmed: boolean('self_confirmed').notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
}, t => [
  primaryKey({ columns: [t.proposalId, t.version] }),
  unique('operations_decision_request').on(t.proposalId, t.actorId, t.idempotencyKey),
  check('operations_decision_action_version', sql`(${t.version} = 1 AND ${t.action} IN ('confirm', 'reject'))
    OR (${t.version} = 2 AND ${t.action} = 'revoke')`),
  check('operations_decision_self_confirmed', sql`NOT ${t.selfConfirmed} OR ${t.action} = 'confirm'`),
]);

export const operationsExecutions = domain.table('operations_executions', {
  id: uuid('id').primaryKey(),
  proposalId: uuid('proposal_id').notNull().references(() => operationsProposals.id),
  proposalFingerprint: text('proposal_fingerprint').notNull(),
  environmentId: uuid('environment_id').notNull().references(() => environments.id),
  decisionVersion: integer('decision_version').notNull(),
  state: text('state').$type<'reserved' | 'blocked' | 'recovered'>().notNull(),
  createdAt: createdAt(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  blockedReason: text('blocked_reason').$type<'approval_revoked' | 'proposal_expired' | 'restart_not_sent'>(),
}, t => [
  unique('operations_execution_per_proposal').on(t.proposalId),
  uniqueIndex('operations_execution_environment_hold').on(t.environmentId).where(sql`${t.state} = 'reserved'`),
  foreignKey({ name: 'operations_execution_decision_fk', columns: [t.proposalId, t.decisionVersion],
    foreignColumns: [operationsDecisions.proposalId, operationsDecisions.version] }),
  check('operations_execution_binding', sql`${t.decisionVersion} = 1 AND ${t.proposalFingerprint} ~ '^[a-f0-9]{64}$'`),
  check('operations_execution_lifecycle', sql`((${t.state} = 'reserved' AND ${t.closedAt} IS NULL AND ${t.blockedReason} IS NULL)
    OR (${t.state} = 'blocked' AND ${t.closedAt} >= ${t.createdAt} AND ${t.blockedReason} IN ('approval_revoked', 'proposal_expired', 'restart_not_sent'))
    OR (${t.state} = 'recovered' AND ${t.closedAt} >= ${t.createdAt} AND ${t.blockedReason} IS NULL)) IS TRUE`),
]);

export const operationsExecutionSchedules = domain.table('operations_execution_schedules', {
  executionId: uuid('execution_id').primaryKey().references(() => operationsExecutions.id),
  taskId: uuid('task_id').notNull(),
  runId: uuid('run_id').notNull(),
  wakeupJobId: uuid('wakeup_job_id'),
}, t => [
  unique('operations_execution_scheduled_task').on(t.taskId),
  unique('operations_execution_scheduled_wakeup').on(t.wakeupJobId),
  foreignKey({ name: 'operations_execution_scheduled_run_fk', columns: [t.runId, t.taskId],
    foreignColumns: [taskRuns.id, taskRuns.taskId] }),
]);

export const operationsExecutionIntents = domain.table('operations_execution_intents', {
  executionId: uuid('execution_id').primaryKey(),
  decisionVersion: integer('decision_version').notNull(),
  proposalFingerprint: text('proposal_fingerprint').notNull(),
  generation: integer('generation').notNull(),
  workerId: uuid('worker_id').notNull(),
  fence: integer('fence').notNull(),
  restorePlan: jsonb('restore_plan').$type<OperationsRestorePlan>(),
  restorePlanSha256: text('restore_plan_sha256'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [
  foreignKey({ name: 'operations_execution_intent_schedule_fk', columns: [t.executionId],
    foreignColumns: [operationsExecutionSchedules.executionId] }),
  check('operations_execution_intent_binding', sql`${t.decisionVersion} = 1 AND ${t.generation} = 1
    AND ${t.fence} > 0 AND ${t.proposalFingerprint} ~ '^[a-f0-9]{64}$'`),
  check('operations_restore_plan_binding', sql`((${t.restorePlan} IS NULL AND ${t.restorePlanSha256} IS NULL)
    OR (${t.restorePlan}->>'version' = '1' AND ${t.restorePlanSha256} ~ '^[a-f0-9]{64}$'
      AND octet_length(${t.restorePlan}::text) <= 4096)) IS TRUE`),
]);

export const operationsRestoreSteps = domain.table('operations_restore_steps', {
  executionId: uuid('execution_id').notNull().references(() => operationsExecutionIntents.executionId),
  kind: text('kind').$type<'configure' | 'deploy'>().notNull(),
  planSha256: text('plan_sha256').notNull(),
  workerId: uuid('worker_id').notNull(),
  fence: integer('fence').notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  receipt: jsonb('receipt').$type<ReleaseKomodoConfiguration | ReleaseKomodoUpdate>(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }),
}, t => [
  primaryKey({ columns: [t.executionId, t.kind] }),
  uniqueIndex('operations_restore_native_update').on(sql`(${t.receipt}->>'updateId')`).where(sql`${t.kind} = 'deploy' AND ${t.receipt} IS NOT NULL`),
  check('operations_restore_step_binding', sql`${t.kind} IN ('configure', 'deploy') AND ${t.fence} > 0 AND ${t.planSha256} ~ '^[a-f0-9]{64}$'`),
  check('operations_restore_step_receipt', sql`((${t.receipt} IS NULL AND ${t.recordedAt} IS NULL)
    OR (jsonb_typeof(${t.receipt}) = 'object' AND octet_length(${t.receipt}::text) <= 4096 AND ${t.recordedAt} >= ${t.sentAt})) IS TRUE`),
]);

export const operationsRestoreRecoveries = domain.table('operations_restore_recoveries', {
  executionId: uuid('execution_id').notNull().references(() => operationsExecutionIntents.executionId),
  attempt: integer('attempt').notNull(),
  fence: integer('fence').notNull(),
  workerId: uuid('worker_id').notNull(),
  state: text('state').$type<'observing' | 'verified' | 'retry' | 'manual_review'>().notNull().default('observing'),
  failure: text('failure').$type<OperationsRestoreRecoveryFailure>(),
  proof: jsonb('proof').$type<OperationsRestoreRecoveryProof>(),
  proofSha256: text('proof_sha256'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, t => [
  primaryKey({ columns: [t.executionId, t.attempt] }),
  unique('operations_restore_recovery_fence').on(t.executionId, t.fence),
  check('operations_restore_recovery_coordinates', sql`${t.attempt} BETWEEN 1 AND 3 AND ${t.fence} > 0`),
  check('operations_restore_recovery_lifecycle', sql`((
    (${t.state} = 'observing' AND ${t.completedAt} IS NULL AND ${t.failure} IS NULL AND ${t.proof} IS NULL AND ${t.proofSha256} IS NULL)
    OR (${t.completedAt} >= ${t.createdAt} AND (
      (${t.state} = 'verified' AND ${t.failure} IS NULL AND jsonb_typeof(${t.proof}) = 'object'
        AND octet_length(${t.proof}::text) <= 4096 AND ${t.proofSha256} ~ '^[a-f0-9]{64}$')
      OR (${t.proof} IS NULL AND ${t.proofSha256} IS NULL AND (
        (${t.state} = 'retry' AND ${t.attempt} < 3 AND ${t.failure} IN ('update_pending', 'unavailable', 'unhealthy', 'lease_expired'))
        OR (${t.state} = 'manual_review' AND (${t.failure} IN ('target_changed', 'missing_update', 'update_failed')
          OR (${t.attempt} = 3 AND ${t.failure} IN ('update_pending', 'unavailable', 'unhealthy', 'lease_expired'))))
      ))
    ))
  ) IS TRUE)`),
]);

export const operationsRestartRequests = domain.table('operations_restart_requests', {
  executionId: uuid('execution_id').primaryKey(),
  callSha256: text('call_sha256').notNull(),
  document: jsonb('document').$type<OperationsRestartRequest>().notNull(),
  runtimeBaseline: jsonb('runtime_baseline').$type<OperationsRestartBaseline>(),
  runtimeBaselineSha256: text('runtime_baseline_sha256'),
  writerInstallationId: uuid('writer_installation_id').references(() => operationsRestartInstallations.id),
  approvalId: text('approval_id'),
  receivedAt: timestamp('received_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [
  foreignKey({ name: 'operations_restart_request_intent_fk', columns: [t.executionId], foreignColumns: [operationsExecutionIntents.executionId] }),
  unique('operations_restart_native_approval').on(t.approvalId),
  check('operations_restart_request_binding', sql`(${t.callSha256} ~ '^[a-f0-9]{64}$'
    AND ${t.document}->>'credentialSha256' ~ '^[a-f0-9]{64}$') IS TRUE`),
  check('operations_restart_baseline_binding', sql`((${t.runtimeBaseline} IS NULL AND ${t.runtimeBaselineSha256} IS NULL)
    OR (jsonb_typeof(${t.runtimeBaseline}) = 'object' AND octet_length(${t.runtimeBaseline}::text) <= 2048
      AND ${t.runtimeBaselineSha256} ~ '^[a-f0-9]{64}$')) IS TRUE`),
  check('operations_restart_request_receipt', sql`((${t.approvalId} IS NULL AND ${t.receivedAt} IS NULL)
    OR (${t.approvalId} ~ '^[a-f0-9]{32}$' AND ${t.receivedAt} >= ${t.createdAt})) IS TRUE`),
]);

export const operationsRestartResumes = domain.table('operations_restart_resumes', {
  executionId: uuid('execution_id').notNull().references(() => operationsRestartRequests.executionId),
  attempt: integer('attempt').notNull(),
  actorId: uuid('actor_id').notNull().references(() => principals.id),
  grantId: uuid('grant_id').notNull(),
  approvalId: text('approval_id').notNull(),
  callSha256: text('call_sha256').notNull(),
  expectedVersion: integer('expected_version').notNull(),
  idempotencyKey: uuid('idempotency_key').notNull(),
  state: text('state').$type<'queued' | 'prepared' | 'pending' | 'acknowledged' | 'unknown' | 'blocked'>().notNull().default('queued'),
  workerId: uuid('worker_id'),
  fence: integer('fence'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  preparedAt: timestamp('prepared_at', { withTimezone: true }),
  recordedAt: timestamp('recorded_at', { withTimezone: true }),
}, t => [
  primaryKey({ columns: [t.executionId, t.attempt] }),
  unique('operations_restart_resume_key').on(t.executionId, t.idempotencyKey),
  check('operations_restart_resume_identity', sql`${t.attempt} BETWEEN 1 AND 3 AND ${t.expectedVersion} > 0
    AND ${t.approvalId} ~ '^[a-f0-9]{32}$' AND ${t.callSha256} ~ '^[a-f0-9]{64}$'`),
  check('operations_restart_resume_stage', sql`(
    (${t.state} IN ('queued', 'blocked') AND ${t.workerId} IS NULL AND ${t.fence} IS NULL AND ${t.preparedAt} IS NULL
      AND ((${t.state} = 'queued' AND ${t.recordedAt} IS NULL) OR (${t.state} = 'blocked' AND ${t.recordedAt} >= ${t.createdAt})))
    OR (${t.fence} > 0 AND ${t.workerId} IS NOT NULL AND ${t.preparedAt} >= ${t.createdAt}
      AND ((${t.state} = 'prepared' AND ${t.recordedAt} IS NULL)
        OR (${t.state} IN ('pending', 'acknowledged', 'unknown') AND ${t.recordedAt} >= ${t.preparedAt})))
  ) IS TRUE`),
]);

export const operationsRestartRecoveries = domain.table('operations_restart_recoveries', {
  executionId: uuid('execution_id').notNull().references(() => operationsExecutionIntents.executionId),
  attempt: integer('attempt').notNull(), fence: integer('fence').notNull(), workerId: uuid('worker_id').notNull(),
  state: text('state').$type<'observing' | 'retry' | 'manual_review' | 'verified'>().notNull().default('observing'),
  failure: text('failure').$type<OperationsRestartRecoveryFailure>(),
  proof: jsonb('proof').$type<OperationsRestartRecoveryProof>(), proofSha256: text('proof_sha256'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, t => [
  primaryKey({ columns: [t.executionId, t.attempt] }),
  unique('operations_restart_recovery_fence').on(t.executionId, t.fence),
  check('operations_restart_recovery_scope', sql`${t.attempt} BETWEEN 1 AND 3 AND ${t.fence} > 0`),
  check('operations_restart_recovery_proof', sql`((${t.proof} IS NULL AND ${t.proofSha256} IS NULL)
    OR (jsonb_typeof(${t.proof}) = 'object' AND octet_length(${t.proof}::text) <= 4096
      AND ${t.proofSha256} ~ '^[a-f0-9]{64}$')) IS TRUE`),
  check('operations_restart_recovery_lifecycle', sql`(
    (${t.state} = 'observing' AND ${t.completedAt} IS NULL AND ${t.failure} IS NULL AND ${t.proof} IS NULL)
    OR (${t.completedAt} >= ${t.createdAt} AND (
      (${t.state} = 'verified' AND ${t.failure} IS NULL AND ${t.proof} IS NOT NULL)
      OR (${t.state} = 'retry' AND ${t.attempt} < 3 AND ${t.failure} IN ('unhealthy', 'unavailable', 'lease_expired') AND ${t.proof} IS NULL)
      OR (${t.state} = 'manual_review' AND (
        (${t.failure} = 'native_unconfirmed' AND ${t.proof} IS NOT NULL)
        OR (${t.failure} IN ('missing_evidence', 'target_changed') AND ${t.proof} IS NULL)
        OR (${t.attempt} = 3 AND ${t.failure} IN ('unhealthy', 'unavailable', 'lease_expired') AND ${t.proof} IS NULL)
      ))
    ))) IS TRUE`),
]);

export const operationsHealthProbeSequence = domain.sequence('operations_health_probe_sequence', { maxValue: Number.MAX_SAFE_INTEGER });

export const operationsIncidents = domain.table('operations_incidents', {
  id: uuid('id').primaryKey().defaultRandom(),
  environmentId: uuid('environment_id').notNull().references(() => environments.id),
  bindingSha256: text('binding_sha256').notNull(),
  binding: jsonb('binding').$type<OperationsHealthBinding>().notNull(),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
  lastUnhealthyAt: timestamp('last_unhealthy_at', { withTimezone: true }).notNull(),
  unhealthySamples: integer('unhealthy_samples').notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedReason: text('closed_reason').$type<'recovered' | 'target_changed'>(),
  diagnosisStoppedAt: timestamp('diagnosis_stopped_at', { withTimezone: true }),
  diagnosisStopReason: text('diagnosis_stop_reason').$type<'attempt_limit' | 'task_stopped' | 'operator_stopped'>(),
  diagnosisStoppedBy: uuid('diagnosis_stopped_by').references(() => principals.id),
  diagnosisStopGrantId: uuid('diagnosis_stop_grant_id'),
}, t => [
  unique('operations_incident_scope').on(t.id, t.environmentId, t.bindingSha256),
  uniqueIndex('operations_incident_active_environment').on(t.environmentId).where(sql`${t.closedAt} IS NULL`),
  check('operations_incident_binding', sql`(${t.bindingSha256} ~ '^[a-f0-9]{64}$'
    AND ${t.binding}->>'version' = '1' AND ${t.binding}->>'environmentId' = ${t.environmentId}::text
    AND octet_length(${t.binding}::text) <= 2048) IS TRUE`),
  check('operations_incident_lifecycle', sql`(${t.unhealthySamples} > 0 AND ${t.lastUnhealthyAt} >= ${t.openedAt} AND (
    (${t.closedAt} IS NULL AND ${t.closedReason} IS NULL)
    OR (${t.closedAt} >= ${t.lastUnhealthyAt} AND ${t.closedReason} IN ('recovered', 'target_changed'))
  )) IS TRUE`),
  check('operations_incident_diagnosis_stop', sql`((
    ${t.diagnosisStoppedAt} IS NULL AND ${t.diagnosisStopReason} IS NULL
  ) OR (${t.diagnosisStoppedAt} >= ${t.openedAt} AND ${t.diagnosisStopReason} IN ('attempt_limit', 'task_stopped', 'operator_stopped'))) IS TRUE`),
  check('operations_incident_operator_record', sql`((
    ${t.diagnosisStoppedBy} IS NULL AND ${t.diagnosisStopGrantId} IS NULL
  ) OR (${t.diagnosisStopReason} = 'operator_stopped' AND ${t.diagnosisStoppedBy} IS NOT NULL AND ${t.diagnosisStopGrantId} IS NOT NULL)) IS TRUE`),
]);

export const operationsHealthSamples = domain.table('operations_health_samples', {
  sequence: bigint('sequence', { mode: 'number' }).primaryKey(),
  environmentId: uuid('environment_id').notNull().references(() => environments.id),
  bindingSha256: text('binding_sha256').notNull(),
  binding: jsonb('binding').$type<OperationsHealthBinding>().notNull(),
  signal: jsonb('signal').$type<OperationsHealthSignal>().notNull(),
  incidentId: uuid('incident_id'),
  probeStartedAt: timestamp('probe_started_at', { withTimezone: true }).notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
}, t => [
  index('operations_health_samples_environment_sequence').on(t.environmentId, t.sequence),
  unique('operations_health_sample_incident').on(t.sequence, t.incidentId),
  foreignKey({ name: 'operations_health_sample_incident_fk', columns: [t.incidentId, t.environmentId, t.bindingSha256],
    foreignColumns: [operationsIncidents.id, operationsIncidents.environmentId, operationsIncidents.bindingSha256] }),
  check('operations_health_sample_binding', sql`(${t.sequence} > 0 AND ${t.bindingSha256} ~ '^[a-f0-9]{64}$'
    AND ${t.binding}->>'version' = '1' AND ${t.binding}->>'environmentId' = ${t.environmentId}::text
    AND octet_length(${t.binding}::text) <= 2048 AND ${t.recordedAt} >= ${t.probeStartedAt}) IS TRUE`),
  check('operations_health_sample_signal', sql`(${t.signal}->>'evidenceSha256' ~ '^[a-f0-9]{64}$'
    AND octet_length(${t.signal}::text) <= 512 AND (
      (${t.signal}->>'status' = 'healthy' AND NOT (${t.signal} ? 'reason'))
      OR (${t.signal}->>'status' = 'unhealthy' AND ${t.incidentId} IS NOT NULL
        AND ${t.signal}->>'reason' IN ('runtime_stopped', 'application_unhealthy'))
      OR (${t.signal}->>'status' = 'unavailable'
        AND ${t.signal}->>'reason' IN ('ingress_unavailable', 'probe_identity', 'komodo_unavailable', 'target_changed'))
    )) IS TRUE`),
]);

export const operationsIncidentMonitors = domain.table('operations_incident_monitors', {
  id: uuid('id').primaryKey().defaultRandom(),
  environmentId: uuid('environment_id').notNull().references(() => environments.id),
  principalId: uuid('principal_id').notNull().references(() => principals.id),
  grantId: uuid('grant_id').notNull(),
  enrollmentSha256: text('enrollment_sha256').notNull(),
  mappingSha256: text('mapping_sha256').notNull(),
  providerSha256: text('provider_sha256').notNull(),
  locale: text('locale').notNull().$type<'en' | 'zh-CN'>(),
  createdAt: createdAt(),
  validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, t => [
  unique('operations_incident_monitor_scope').on(t.id, t.environmentId),
  uniqueIndex('operations_incident_active_monitor').on(t.environmentId).where(sql`${t.revokedAt} IS NULL`),
  check('operations_incident_monitor_policy', sql`${t.locale} IN ('en', 'zh-CN')
    AND ${t.enrollmentSha256} ~ '^[a-f0-9]{64}$' AND ${t.mappingSha256} ~ '^[a-f0-9]{64}$'
    AND ${t.providerSha256} ~ '^[a-f0-9]{64}$' AND ${t.validUntil} > ${t.createdAt}
    AND (${t.revokedAt} IS NULL OR ${t.revokedAt} >= ${t.createdAt})`),
]);

export const operationsIncidentDiagnoses = domain.table('operations_incident_diagnoses', {
  incidentId: uuid('incident_id').notNull(), environmentId: uuid('environment_id').notNull(),
  bindingSha256: text('binding_sha256').notNull(), monitorId: uuid('monitor_id').notNull(),
  attempt: integer('attempt').notNull(),
  sampleSequence: bigint('sample_sequence', { mode: 'number' }).notNull(),
  taskId: uuid('task_id').notNull(),
  runId: uuid('run_id').notNull().references(() => operationsDiagnosisInputs.runId),
  admittedAt: timestamp('admitted_at', { withTimezone: true }).notNull(),
}, t => [
  primaryKey({ columns: [t.incidentId, t.attempt] }),
  unique('operations_incident_diagnosis_run').on(t.runId),
  unique('operations_incident_diagnosis_sample').on(t.sampleSequence),
  index('operations_incident_diagnosis_environment_time').on(t.environmentId, t.admittedAt, t.sampleSequence),
  foreignKey({ name: 'operations_incident_diagnosis_scope_fk', columns: [t.incidentId, t.environmentId, t.bindingSha256],
    foreignColumns: [operationsIncidents.id, operationsIncidents.environmentId, operationsIncidents.bindingSha256] }),
  foreignKey({ name: 'operations_incident_diagnosis_sample_fk', columns: [t.sampleSequence, t.incidentId],
    foreignColumns: [operationsHealthSamples.sequence, operationsHealthSamples.incidentId] }),
  foreignKey({ name: 'operations_incident_diagnosis_monitor_fk', columns: [t.monitorId, t.environmentId],
    foreignColumns: [operationsIncidentMonitors.id, operationsIncidentMonitors.environmentId] }),
  foreignKey({ name: 'operations_incident_diagnosis_task_fk', columns: [t.runId, t.taskId], foreignColumns: [taskRuns.id, taskRuns.taskId] }),
  check('operations_incident_diagnosis_budget', sql`${t.attempt} BETWEEN 1 AND 3`),
]);

export const operationsRepairProposals = domain.table('operations_repair_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  diagnosisRunId: uuid('diagnosis_run_id').notNull().references(() => operationsDiagnosisResults.runId),
  environmentId: uuid('environment_id').notNull().references(() => environments.id),
  releaseOperationId: uuid('release_operation_id').notNull().references(() => releaseOperations.id),
  candidateId: uuid('candidate_id').notNull().references(() => releaseCandidates.id),
  incidentId: uuid('incident_id'), sampleSequence: bigint('sample_sequence', { mode: 'number' }),
  proposedBy: uuid('proposed_by').notNull().references(() => principals.id), grantId: uuid('grant_id').notNull(),
  fingerprint: text('fingerprint').notNull(), document: jsonb('document').$type<OperationsRepairProposal>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
}, t => [
  unique('operations_repair_proposal_per_diagnosis').on(t.diagnosisRunId),
  index('operations_repair_proposal_incident').on(t.incidentId),
  foreignKey({ name: 'operations_repair_proposal_sample_fk', columns: [t.sampleSequence, t.incidentId],
    foreignColumns: [operationsHealthSamples.sequence, operationsHealthSamples.incidentId] }),
  check('operations_repair_proposal_binding', sql`(${t.fingerprint} ~ '^[a-f0-9]{64}$' AND ${t.validUntil} > ${t.createdAt}
    AND ${t.document}->>'version' = '1' AND ${t.document}#>>'{diagnosis,runId}' = ${t.diagnosisRunId}::text
    AND ${t.document}#>>'{target,environmentId}' = ${t.environmentId}::text
    AND ${t.document}#>>'{target,releaseOperationId}' = ${t.releaseOperationId}::text
    AND ${t.document}#>>'{source,candidateId}' = ${t.candidateId}::text
    AND ${t.document}->>'proposedBy' = ${t.proposedBy}::text AND ${t.document}->>'grantId' = ${t.grantId}::text
    AND ((${t.incidentId} IS NULL AND ${t.sampleSequence} IS NULL AND ${t.document}->'incident' = 'null'::jsonb)
      OR (${t.incidentId} IS NOT NULL AND ${t.sampleSequence} > 0 AND ${t.document}#>>'{incident,id}' = ${t.incidentId}::text
        AND ${t.document}#>>'{incident,sampleSequence}' = ${t.sampleSequence}::text))
    AND octet_length(${t.document}::text) <= 8192) IS TRUE`),
]);

export const operationsRepairAdmissions = domain.table('operations_repair_admissions', {
  proposalId: uuid('proposal_id').primaryKey().references(() => operationsRepairProposals.id),
  taskId: uuid('task_id').notNull(), runId: uuid('run_id').notNull(),
  actorId: uuid('actor_id').notNull().references(() => principals.id), grantId: uuid('grant_id').notNull(),
  requestSha256: text('request_sha256').notNull(), sourceCommit: text('source_commit').notNull(),
  selfConfirmed: boolean('self_confirmed').notNull(), confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull(),
}, t => [
  unique('operations_repair_admission_per_task').on(t.taskId),
  foreignKey({ name: 'operations_repair_admission_task_fk', columns: [t.runId, t.taskId], foreignColumns: [taskRuns.id, taskRuns.taskId] }),
  check('operations_repair_admission_binding', sql`${t.requestSha256} ~ '^[a-f0-9]{64}$' AND ${t.sourceCommit} ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'`),
]);

export const formalReleaseSteps = domain.table('formal_release_steps', {
  operationId: uuid('operation_id').notNull().references(() => releaseOperations.id),
  kind: text('kind').$type<'archive' | 'registry' | 'komodo_config' | 'komodo_dispatch'>().notNull(),
  preparedFence: integer('prepared_fence').notNull(),
  preparedBy: uuid('prepared_by').notNull(),
  state: text('state').$type<'prepared' | 'confirmed' | 'uncertain'>().notNull().default('prepared'),
  proof: jsonb('proof').$type<QualifiedOciArchiveVerification | ReleaseRegistryImageProof
    | ReleaseKomodoConfiguration | ReleaseKomodoCompletion>(),
  intent: jsonb('intent').$type<ReleaseKomodoIntent>(),
  externalUpdateId: text('external_update_id'),
  settledFence: integer('settled_fence'),
  settledBy: uuid('settled_by'),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  createdAt: createdAt(),
}, t => [
  primaryKey({ columns: [t.operationId, t.kind, t.preparedFence] }),
  uniqueIndex('formal_release_single_registry_intent').on(t.operationId).where(sql`${t.kind} = 'registry'`),
  uniqueIndex('formal_release_single_komodo_intent').on(t.operationId, t.kind)
    .where(sql`${t.kind} IN ('komodo_config', 'komodo_dispatch')`),
  uniqueIndex('formal_release_komodo_update_unique').on(sql`(${t.intent}->>'origin')`, t.externalUpdateId)
    .where(sql`${t.kind} = 'komodo_dispatch' AND ${t.externalUpdateId} IS NOT NULL`),
  check('formal_release_step_kind', sql`${t.kind} IN ('archive', 'registry', 'komodo_config', 'komodo_dispatch') AND ${t.preparedFence} > 0`),
  check('formal_release_step_intent', sql`(
    (${t.kind} IN ('archive', 'registry') AND ${t.intent} IS NULL)
    OR (${t.kind} IN ('komodo_config', 'komodo_dispatch') AND jsonb_typeof(${t.intent}) = 'object'
      AND octet_length(${t.intent}::text) <= 8192)
  ) IS TRUE`),
  check('formal_release_step_update_id', sql`(
    (${t.externalUpdateId} IS NULL AND (${t.kind} <> 'komodo_dispatch' OR ${t.state} <> 'confirmed'))
    OR (${t.kind} = 'komodo_dispatch' AND ${t.externalUpdateId} ~ '^[0-9a-f]{24}$')
  ) IS TRUE`),
  check('formal_release_step_state', sql`(
    (${t.state} = 'prepared' AND ${t.proof} IS NULL AND ${t.settledFence} IS NULL AND ${t.settledBy} IS NULL AND ${t.settledAt} IS NULL)
    OR (${t.state} IN ('confirmed', 'uncertain') AND ${t.settledFence} >= ${t.preparedFence}
      AND ${t.settledBy} IS NOT NULL AND ${t.settledAt} IS NOT NULL AND (
        (${t.state} = 'confirmed' AND ${t.proof} IS NOT NULL AND octet_length(${t.proof}::text) <= 8192)
        OR (${t.kind} = 'registry' AND ${t.state} = 'uncertain' AND ${t.proof} IS NULL)
      ))
  ) IS TRUE`),
]);

export const formalReleaseRolloutAttempts = domain.table('formal_release_rollout_attempts', {
  operationId: uuid('operation_id').notNull().references(() => releaseOperations.id),
  fence: integer('fence').notNull(),
  workerId: uuid('worker_id').notNull(),
  state: text('state').$type<'observing' | 'expired' | 'manual_review' | 'verified' | 'rejected'>().notNull().default('observing'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }).notNull(),
  proof: jsonb('proof').$type<ReleaseRolloutProof>(),
  failure: text('failure').$type<ReleaseRolloutFailure>(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: createdAt(),
}, t => [
  primaryKey({ columns: [t.operationId, t.fence] }),
  uniqueIndex('one_formal_rollout_observer').on(sql`(1)`).where(sql`${t.state} = 'observing'`),
  check('formal_rollout_fence', sql`${t.fence} BETWEEN 1 AND 3`),
  check('formal_rollout_state', sql`(${t.state} IN ('observing', 'verified', 'rejected') OR (${t.state} = 'expired' AND ${t.fence} < 3)
    OR (${t.state} = 'manual_review' AND ${t.fence} = 3))`),
  check('formal_rollout_lease', sql`${t.leaseUntil} > ${t.createdAt}
    AND ${t.leaseUntil} <= ${t.createdAt} + interval '45 seconds'`),
  check('formal_rollout_outcome', sql`(
    (${t.state} NOT IN ('verified', 'rejected') AND ${t.proof} IS NULL AND ${t.failure} IS NULL AND ${t.completedAt} IS NULL)
    OR (${t.completedAt} >= ${t.createdAt} AND ${t.completedAt} < ${t.leaseUntil} AND (
      (${t.state} = 'verified' AND jsonb_typeof(${t.proof}) = 'object' AND octet_length(${t.proof}::text) <= 8192 AND ${t.failure} IS NULL)
      OR (${t.state} = 'rejected' AND ${t.proof} IS NULL AND ${t.failure} IN (
        'release_rollout_update_failed', 'release_rollout_update_changed', 'release_rollout_runtime_changed',
        'release_rollout_ingress_changed', 'release_rollout_health_failed', 'release_rollout_unavailable'
      ))
    ))
  ) IS TRUE`),
]);
