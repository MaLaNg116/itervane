import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { AgentEvidence } from '@itervane/agent';
import { createFormalOperations, createFormalVerification } from '@itervane/agent';
import { admissionDtoSchema, apiErrorSchema, finishOperationsInputSchema, fixtureReleaseManifestSchema, formalAuditDtoSchema, formalAuditInputSchema, formalAuditResultSchema, formalRepairDtoSchema, formalRepairInputSchema, formalRepairPatchDtoSchema,
  formalReleaseCandidateDtoSchema, formalReleaseOptionsSchema, formalReleaseResultSchema, formalReleaseTargetSchema, formalReleaseViewSchema, formalRepairRetryContextSchema,
  formalVerificationResultSchema, operationsDiagnosisReceiptSchema, operationsLaunchViewSchema, operationsObservationViewSchema,
  operationsProposalViewSchema, operationsRestartBaselineSchema, operationsRestartExecutionViewSchema, operationsRestartRecoveryProofSchema,
  operationsRestartRequestSchema, operationsRestartSubmissionSchema, operationsRestoreExecutionViewSchema, operationsRestorePlanSchema, operationsRestoreRecoveryProofSchema,
  candidateValidationViewSchema, learningCaseCaptureResultSchema, learningCasesViewSchema, ruleExtractionViewSchema, operationsIncidentsViewSchema, operationsIncidentStopResultSchema,
  rulePackageActivationResultSchema, rulePackageActivationViewSchema, rulePackageImportResultSchema,
  operationsRepairViewSchema, operationsSubmissionSchema, standardHealthRepairPath, taskDtoSchema,
  taskIncidentViewSchema, taskRuleSnapshotViewSchema, translate,
  verificationViewSchema,
  whiskersRestartImageDigest,
  qualifiedInspectionResponseSchema, qualifiedRepairObservationRequestSchema, qualifiedRepairRequestSchema, qualifiedScanReportsSchema, type QualifiedInspectionReceipt,
  type FormalReleaseManifest, type FormalReleaseTarget, type NpmUpgradeApproval, type OperationsDiagnosisObservation, type OperationsDiagnosisSection,
  type OperationsHealthSignal, type OperationsRestartInstallation,
  type QualifiedInspectionRequest, type QualifiedRepairObservationReceipt, type QualifiedRepairReceipt,
  type QualifiedStandardImageProof, type QualifiedVerificationReceipt, type RepairPatch, type StandardVerificationProfile, type TaskDto } from '@itervane/contracts';
import type { ModelAdapter } from '@itervane/model';
import { canonicalRepairCommand, canonicalRepairObservation, canonicalRuleValidationCommand, canonicalVerificationCommand, preparePublishedCodeScan, prepareQualifiedRuleValidationRequest, prepareQualifiedVerificationRequest,
  scannerProfiles, sha256, verifyQualifiedVerificationReceipt } from '@itervane/runner';
import { npmFixtureApproval, npmFixtureFiles, npmFixturePaths } from '../../../verification/src/agent/npm-repair-fixture.js';
import { chooseOperationsSection, operationsDecision, scriptedOperations } from '../../../verification/src/agent/operations-fixture.js';
import { scriptedVerification } from '../../../verification/src/agent/verification-fixture.js';
import { extractionFixtureCall } from '../../../verification/src/agent/rule-extraction-fixture.js';
import { createApi } from '../../src/api.js';
import { CandidateValidationService } from '../../src/service/candidate-validations.js';
import type { CandidateValidationOptions } from '../../src/runtime/candidate-validation.js';
import { createIdentityVerifier, type VerifiedIdentity } from '../../src/auth/identity.js';
import { runtimeConfig, workerConfig, type OperationsWorkflowScope } from '../../src/config.js';
import { formalReleaseQueue, operationsExecutionQueue, operationsRestoreQueue, queueName } from '../../src/persistence/database.js';
import { formalAuditInputs, formalAuditResults, formalReleaseRolloutAttempts, formalReleaseSteps, formalRepairAttempts, formalRepairInputs, formalRepairOperations, formalRepairResults, formalRepairRetries,
  formalRepairRuntime, formalRescanAttempts, formalVerificationInputs, formalVerificationResults, formalVerificationRuntime, inspectionAttempts,
  operationsDecisions, operationsDiagnosisInputs, operationsDiagnosisReads, operationsDiagnosisResults,
  operationsDiagnosisRuntime, operationsExecutionIntents, operationsExecutions, operationsExecutionSchedules, operationsHealthSamples,
  operationsIncidentDiagnoses, operationsIncidentMonitors, operationsIncidents, operationsObservations,
  operationsProposals, operationsRepairAdmissions, operationsRepairProposals, operationsRequests, operationsRestartInstallations,
  operationsRestartRecoveries, operationsRestartRequests, operationsRestartResumes,
  operationsRestoreRecoveries, operationsRestoreSteps, operationsTargets,
  principals, projectMembers, releaseCandidates, releaseDecisions, releaseOperations, repositories, runRuntime,
  taskEvents, taskRuns, tasks as taskRecords, workspaceMembers } from '../../src/persistence/schema.js';
import { ExecutionCoordinator } from '../../src/runtime/coordinator.js';
import { configuredAuditModel, runFormalAudit } from '../../src/runtime/formal-audit.js';
import { FormalKomodoSteps } from '../../src/runtime/formal-komodo-steps.js';
import { runFormalOperations } from '../../src/runtime/formal-operations.js';
import { runFormalRepair } from '../../src/runtime/formal-repair.js';
import { FormalReleaseCoordinator } from '../../src/runtime/formal-release-claim.js';
import { FormalReleaseSteps } from '../../src/runtime/formal-release-steps.js';
import { FormalReleaseWorker } from '../../src/runtime/formal-release-worker.js';
import { FormalRolloutCoordinator } from '../../src/runtime/formal-rollout-claim.js';
import { OperationsRestoreWorker } from '../../src/runtime/operations-restore-worker.js';
import { OperationsRestoreRecoveryWorker } from '../../src/runtime/operations-restore-recovery-worker.js';
import type { KomodoReleaseClient } from '../../src/runtime/release-komodo.js';
import { FormalRolloutWorker } from '../../src/runtime/formal-rollout-worker.js';
import { createInstalledApi } from '../../src/runtime/installed-api.js';
import { runFormalRescan, type RescanRunner } from '../../src/runtime/formal-rescan.js';
import { runFormalVerification, type FormalVerificationOptions } from '../../src/runtime/formal-verification.js';
import { appendEvent, BudgetExhausted, clearSlot, ExecutionLost, type ExecutionScope } from '../../src/runtime/authority.js';
import { GuardedCheckpointer } from '../../src/runtime/checkpointer.js';
import { FormalRepairExecution, type RepairRunner } from '../../src/runtime/repair-execution.js';
import { observeFormalRepairTargets, type RepairObservationRunner } from '../../src/runtime/repair-observation.js';
import { ReleaseRehearsal } from '../../src/runtime/release-rehearsal.js';
import type { ReleaseRegistryPublisher } from '../../src/runtime/release-registry.js';
import { ReleaseIngressError } from '../../src/runtime/release-traefik.js';
import { ToolGateway } from '../../src/runtime/tools.js';
import { prepareFormalVerificationInput } from '../../src/runtime/verification-input.js';
import { projectVerificationEvidence } from '../../src/runtime/verification-evidence.js';
import { DurableWorker } from '../../src/runtime/worker.js';
import { OperationsEvidenceStore } from '../../src/runtime/operations-evidence-store.js';
import { runOperationsObservation } from '../../src/runtime/operations-execution.js';
import { OperationsExecutionCoordinator } from '../../src/runtime/operations-execution-lease.js';
import { OperationsRestartWorker } from '../../src/runtime/operations-restart-worker.js';
import { OperationsRestartRecoveryWorker } from '../../src/runtime/operations-restart-recovery-worker.js';
import { holdOperationsAcknowledgement } from '../native/operations-acknowledgement-barrier.js';
import { RestartQueueWorker } from '../../src/runtime/installed-restart-worker.js';
import { RestoreQueueWorker } from '../../src/runtime/installed-restore-worker.js';
import type { InspectionRunner } from '../../src/runtime/source-inspection.js';
import { requireActor } from '../../src/service/access.js';
import { bootstrapOwner, ResourceService } from '../../src/service/resources.js';
import { InspectionService, prepareInspection } from '../../src/service/inspections.js';
import { RulePackageActivationService } from '../../src/service/rule-package-activations.js';
import { LearningCaseService } from '../../src/service/learning-cases.js';
import { RuleExtractionService } from '../../src/service/rule-extraction.js';
import { FormalAuditService, prepareFormalAuditInput } from '../../src/service/formal-audit.js';
import { prepareFormalRepairInput } from '../../src/service/formal-repair.js';
import { FormalReleaseService } from '../../src/service/formal-release.js';
import { readOperationsDeployment } from '../../src/service/operations-deployment.js';
import { OperationsDecisionService } from '../../src/service/operations-decisions.js';
import { OperationsExecutionAdmission } from '../../src/service/operations-execution-admission.js';
import { OperationsHealthJournal } from '../../src/service/operations-health.js';
import { changeOperationsIncidentMonitor } from '../../src/service/operations-incident-monitor.js';
import { OperationsIncidentScheduler } from '../../src/service/operations-incident-scheduler.js';
import { OperationsObservationViewService } from '../../src/service/operations-observation-view.js';
import { OperationsProposalService, readOperationsProposal } from '../../src/service/operations-proposals.js';
import { OperationsRepairAdmission } from '../../src/service/operations-repair-admission.js';
import { OperationsRepairProposalService, readOperationsRepairProposal } from '../../src/service/operations-repair-proposals.js';
import { changeOperationsRestartInstallation } from '../../src/service/operations-restart-installations.js';
import { freezeOperationsRequest, readOperationsDiagnosis, readOperationsRequest } from '../../src/service/operations-requests.js';
import { readOperationsObservationTarget, readOperationsReleaseEvidence, registerOperationsTarget } from '../../src/service/operations-targets.js';
import { publishFormalRepair } from '../../src/service/repair-result.js';
import { verificationProfileFingerprint } from '../../src/service/repair-retry.js';
import { fingerprintRolloutCheck, readInstalledReleaseTarget, registerReleaseTarget } from '../../src/service/release-targets.js';
import { ReleaseCandidateService } from '../../src/service/releases.js';
import { TaskService } from '../../src/service/tasks.js';
import { VerificationViewService } from '../../src/service/verification-view.js';
import { databaseFixture } from '../helpers/database.js';
import { identityFixture } from '../helpers/identity.js';
import { auditFixtureKey, auditFixtureModel, auditProtocolFixture } from '../native/audit-provider.js';

let database: Awaited<ReturnType<typeof databaseFixture>>; let issuer: Awaited<ReturnType<typeof identityFixture>>;
let identity: VerifiedIdentity; let coordinator: ExecutionCoordinator; let task: Awaited<ReturnType<TaskService['admit']>>['task'];
const origin = 'https://example.invalid/inspection.git';
const imageSha256 = 'a'.repeat(64);
const workspaceSha256 = 'd'.repeat(64);
const verificationProfile = { id: 'standard-web-fixture', baselineSha256: sha256('protected baseline'),
  policySha256: sha256('verification policy'), scannerInputsSha256: sha256('verification scanners'), runnerImageSha256: imageSha256 };
const standardVerificationProfile: StandardVerificationProfile = { ...verificationProfile, buildProfileSha256: sha256('protected build profile'),
  runStandardBaseline: true, ociInputsSha256: sha256('frozen OCI inputs'), retainStandardImage: true };
const clearRepairHandoff = () => database.admin.query(
  'TRUNCATE itervane.formal_repair_retries, itervane.formal_verification_results, itervane.formal_verification_runtime, itervane.formal_rescan_attempts, itervane.formal_verification_inputs, '
  + 'itervane.formal_repair_results, itervane.formal_repair_attempts, '
  + 'itervane.formal_repair_operations, itervane.formal_repair_runtime, itervane.formal_repair_inputs',
);
beforeAll(async () => { database = await databaseFixture(); issuer = await identityFixture(); });
beforeEach(async () => {
  await database.reset(); await bootstrapOwner(database.storage, { issuer: issuer.config.issuer, subject: 'owner' });
  identity = await createIdentityVerifier(issuer.config)(await issuer.token());
  const resources = new ResourceService(database.storage); const project = await resources.createProject(identity, { name: 'Inspection', slug: 'inspection' });
  const repository = await resources.registerRepository(identity, project.id, { name: 'Source', url: origin });
  task = (await new TaskService(database.storage).admit(identity, { projectId: project.id, source: { repositoryId: repository.id, commit: 'f'.repeat(40) },
    purpose: 'Plan only', dataClass: 'synthetic', locale: 'zh-CN', idempotencyKey: randomUUID() })).task;
  coordinator = new ExecutionCoordinator(database.storage);
});
afterAll(async () => { await issuer?.close(); await database?.close(); });
async function claim() {
  const job = await vi.waitFor(async () => {
    const [ready] = await database.storage.boss.fetch(queueName);
    if (!ready) throw new Error('Waiting for inspection job');
    return ready;
  }, { timeout: 5_000, interval: 50 });
  const scope = await coordinator.claim(job, randomUUID()); if (!scope) throw new Error('Missing scope'); return scope;
}

it('persists one immutable blocked plan across competing tool calls and service replacement without claiming source or scan evidence', async () => {
  const service = new InspectionService(database.storage);
  expect(await service.get(identity, task.id)).toMatchObject({ status: 'not_prepared', plan: null, sourceFetched: false, scanCompleted: false });
  const scope = await claim(); const gateway = new ToolGateway(coordinator);
  const results = await Promise.all([gateway.call(scope, 'source.inspect', {}, 'first'), gateway.call(scope, 'source.inspect', {}, 'second')]);
  expect(results).toEqual(Array(2).fill({ status: 'business_error', code: 'runner_unavailable', retryable: false }));
  expect((await database.admin.query('SELECT * FROM itervane.inspection_plans')).rowCount).toBe(1);
  const plan = await service.get(identity, task.id);
  expect(plan).toMatchObject({ status: 'blocked', requestedSource: task.source, snapshotVerified: false, scanCompleted: false, plan: { document: { taskId: task.id, runId: scope.runId } } });
  expect(await new InspectionService(database.storage).get(identity, task.id)).toEqual(plan);
  await expect(database.storage.pool.query("UPDATE itervane.inspection_plans SET sha256=repeat('a',64)")).rejects.toMatchObject({ code: '23514' });
  await expect(database.storage.pool.query('DELETE FROM itervane.inspection_plans')).rejects.toMatchObject({ code: '23514' });
});

it('rolls back plan creation with its fenced transaction and rejects a missing or mismatched domain binding', async () => {
  const scope = await claim();
  await expect(coordinator.withLease(scope, async (tx, current) => { await prepareInspection(tx, current.task, scope.runId, scope.fence); throw new Error('injected rollback'); })).rejects.toThrow('injected rollback');
  expect((await database.admin.query('SELECT * FROM itervane.inspection_plans')).rowCount).toBe(0);
  await expect(database.admin.query('INSERT INTO itervane.inspection_plans(run_id,task_id,prepared_fence,sha256,document) VALUES($1,$2,1,$3,$4)', [scope.runId, task.id, 'a'.repeat(64), {}])).rejects.toMatchObject({ code: '23514' });
});

it('does not prepare a plan after cancellation', async () => {
  const scope = await claim(); await new TaskService(database.storage).cancel(identity, task.id, { expectedVersion: 2 });
  await expect(new ToolGateway(coordinator).call(scope, 'source.inspect', {}, 'cancelled')).rejects.toBeInstanceOf(ExecutionLost);
  expect((await database.admin.query('SELECT * FROM itervane.inspection_plans')).rowCount).toBe(0);
});

it('refuses the expired fence and lets only its recovered owner prepare the same logical run', async () => {
  const old = await claim(); await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
  await coordinator.reconcile(randomUUID()); const current = await claim();
  expect(current.fence).toBeGreaterThan(old.fence);
  await expect(new ToolGateway(coordinator).call(old, 'source.inspect', {}, 'expired')).rejects.toBeInstanceOf(ExecutionLost);
  expect((await database.admin.query('SELECT * FROM itervane.inspection_plans')).rowCount).toBe(0);
  await new ToolGateway(coordinator).call(current, 'source.inspect', {}, 'recovered');
  expect((await database.admin.query('SELECT prepared_fence FROM itervane.inspection_plans')).rows[0]?.prepared_fence).toBe(current.fence);
});

it('enforces current project permission for both preparing and reading the plan', async () => {
  const scope = await claim(); await database.admin.query('DELETE FROM itervane.workspace_members');
  await expect(new ToolGateway(coordinator).call(scope, 'source.inspect', {}, 'revoked')).rejects.toMatchObject({ code: 'not_found' });
  await expect(new InspectionService(database.storage).get(identity, task.id)).rejects.toMatchObject({ code: 'not_found' });
  expect((await database.admin.query('SELECT * FROM itervane.inspection_plans')).rowCount).toBe(0);
});

function testReceipt(request: QualifiedInspectionRequest, partial = false, findingPath?: string, approval?: NpmUpgradeApproval) {
  const { origin, ...scope } = request;
  const domainId = randomUUID();
  const manifestSha256 = 'b'.repeat(64);
  const npmFinding = approval && {
    id: sha256(JSON.stringify(['trivy', manifestSha256, approval.advisoryId, npmFixturePaths.lock, null, approval.name, approval.installedVersion])),
    severity: 'high', ruleId: approval.advisoryId, path: npmFixturePaths.lock, line: null,
    npm: { name: approval.name, installedVersion: approval.installedVersion, fixedVersions: [approval.fixedVersion] },
  };
  const receipt = qualifiedInspectionResponseSchema.parse({
    kind: 'receipt', scope, domainId, imageSha256, originSha256: sha256(origin), commitSha256: 'c'.repeat(64),
    cleanupConfirmed: true, sessionVerified: true,
    snapshot: { runId: domainId, repositoryId: scope.repositoryId, commit: scope.commit, tree: 'd'.repeat(40),
      manifestSha256, files: 1, totalBytes: 42, inputsSha256: 'e'.repeat(64), readOnly: true, offline: true,
      reports: scannerProfiles.map(({ scanner, version, policySha256 }) => ({
        scanner, version, policySha256, snapshotSha256: manifestSha256,
        findings: scanner === 'gitleaks' && findingPath ? [{
          id: sha256(JSON.stringify([scanner, manifestSha256, 'fixture-pattern', findingPath, 3])),
          severity: 'unknown', ruleId: 'fixture-pattern', path: findingPath, line: 3,
        }] : scanner === 'trivy' && npmFinding ? [npmFinding] : [],
        status: partial && scanner === 'trivy' ? 'unsupported' : 'completed',
        reason: partial && scanner === 'trivy' ? 'missing_inventory' : null,
        database: scanner === 'trivy' && !partial ? { sha256: 'f'.repeat(64), updatedAt: new Date().toISOString() } : null,
      })),
    },
  });
  if (receipt.kind !== 'receipt') throw new Error('Invalid test receipt');
  return receipt;
}

const fixtureFindingPath = 'sensitive-location-placeholder.txt';
function auditTurn(name: string, input: unknown) {
  return { text: '', calls: [{ id: 'fixture-call', name, input }], tokenUsage: 30 };
}

const concludeAudit: ModelAdapter['complete'] = async ({ conversation }) => {
  const initial = conversation[0];
  if (initial?.kind !== 'user') throw new Error('Missing audit context');
  const { observations } = JSON.parse(initial.text) as { observations: AgentEvidence[] };
  const scans = observations.flatMap(({ id, data }) => data.kind === 'scan' ? [{ ...data, id }] : []);
  const missing = (['gitleaks', 'trivy'] as const).find(scanner => !scans.some(scan => scan.scanner === scanner));
  if (missing) return auditTurn('read_scan', { scanner: missing });
  return auditTurn('finish_role', { summary: '固定扫描证据已核对。', evidenceIds: scans.map(scan => scan.id),
    explanations: scans.flatMap(scan => scan.findings.map(finding => ({ findingId: finding.id, impact: '可能含敏感值。', suggestion: '请所有者核对范围。' }))),
  });
};

function auditModel(complete = concludeAudit) {
  return { adapter: { protocol: 'anthropic' as const, complete }, providerSha256: sha256('approved-audit-model') };
}

function completedRunner(finding?: string, partial = false) {
  return inspectionRunner(async (request, authorize) => { await authorize(); return testReceipt(request, partial, finding); });
}

async function claimAfterAudit() {
  // Exercise the worker-side evidence services under a real lease without dispatching another worker.
  await database.admin.query("UPDATE itervane.tasks SET state='queued' WHERE id=$1", [task.id]);
  await database.admin.query("UPDATE itervane.task_runs SET state='queued' WHERE task_id=$1", [task.id]);
  await coordinator.reconcile(randomUUID());
  return claim();
}

async function processAdmittedTestTask(worker: DurableWorker) {
  const deadline = performance.now() + 5_000;
  do {
    if (await worker.tick()) return;
    await delay(40);
  } while (performance.now() < deadline);
  throw new Error('The admitted test task did not receive a wakeup');
}

const extractionModel = () => auditModel(async request => {
  const context = request.conversation[0];
  if (context?.kind !== 'user') throw new Error('Missing extraction context');
  const { observations, role } = JSON.parse(context.text) as { observations: AgentEvidence[]; role: string };
  expect(role).toBe('rule-extraction');
  const { name, input } = extractionFixtureCall(observations);
  return auditTurn(name, input);
});

async function processExtraction(task: TaskDto, model = extractionModel()) {
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { auditModel: model });
  try { await processAdmittedTestTask(worker); } finally { await worker.close(); }
  return new RuleExtractionService(database.storage).get(identity, task.id, 'zh-CN');
}

const validationProfile = {
  version: 1, engine: 'semgrep_ce', engineVersion: '1.170.0', engineInputsSha256: sha256('candidate test tool'),
  runnerImageSha256: sha256('candidate test image'),
} as const;

function codeValidationOptions(mode: 'passed' | 'false_positive' | 'wrong_fence' | 'blocked' | 'expired') {
  const workspaceSha256 = sha256('candidate test workspace');
  const runner: NonNullable<CandidateValidationOptions['code']>['runner'] = {
    async observe() { return { version: 1, kind: 'status', state: mode === 'blocked' ? 'blocked' : 'idle',
      workspaceSha256, imageSha256: validationProfile.runnerImageSha256 }; },
    async validateRuleSamples(coordinates, candidate, reference, profile, authorize) {
      await authorize();
      if (mode === 'expired') {
        await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second' WHERE run_id=$1",
          [coordinates.runId]);
      }
      const command = canonicalRuleValidationCommand(candidate, reference, profile);
      const scope = prepareQualifiedRuleValidationRequest(coordinates, command);
      return {
        kind: 'rule_samples_receipt', scope: mode === 'wrong_fence' ? { ...scope, fence: scope.fence + 1 } : scope,
        imageSha256: validationProfile.runnerImageSha256, domainId: randomUUID(), cleanupConfirmed: true, sessionVerified: true,
        proof: { version: 1, commandSha256: scope.commandSha256, result: { version: 1, basisSha256: scope.basisSha256,
          status: mode === 'false_positive' ? 'failed' : 'passed',
          samples: command.prepared.basis.samples.map(sample => ({ ...sample, status: 'checked',
            reportSha256: sha256(sample.name), matches: sample.name === 'violation' || (sample.name === 'lookalike' && mode === 'false_positive') ? 1 : 0,
          })),
        } },
      };
    },
  };
  return { code: { runner, profile: validationProfile } };
}

async function processCandidateValidation(task: TaskDto, options: CandidateValidationOptions) {
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { candidateValidation: options });
  try { await processAdmittedTestTask(worker); } finally { await worker.close(); }
  return new CandidateValidationService(database.storage).get(identity, task.id, 'zh-CN');
}

async function assertCandidatePublication(checked: NonNullable<ReturnType<typeof candidateValidationViewSchema.parse>['result']>,
  portalClientId: string, failedId?: string) {
  const { projectId, candidateId, taskId, evidence } = checked.document;
  const project = await new ResourceService(database.storage).createProject(identity, { name: 'Second project', slug: 'second-project' });
  const app = createApi(database.storage, { ...issuer.config, portalClientId }, { logger: false });
  const library = '/v1/rule-packages';
  const path = (source = projectId) => `/v1/projects/${source}/rule-candidates/${candidateId}/package-drafts`;
  const base = { packageKey: 'validated-case', version: '1.0.0', scope: 'project', validationId: checked.id, validationSha256: checked.sha256,
    source: { name: 'Test case', license: 'Apache-2.0' }, text: { en: { title: 'New rule', description: 'Verified candidate' },
      'zh-CN': { title: '新规则', description: '已验证的候选' } } };
  try {
    const bearer = await issuer.token('owner', { azp: portalClientId });
    const owner = await issuer.token();
    const post = (url: string, payload: object, actor = bearer, locale = 'zh-CN') => app.inject({ url, method: 'POST', payload,
      headers: { authorization: `Bearer ${actor}`, 'accept-language': locale } });
    expect((await post(path(), base, owner)).statusCode).toBe(403);
    expect((await post(path(project.id), base)).statusCode).toBe(404);
    expect((await post(path(), { ...base, validationSha256: sha256('another proof') })).statusCode).toBe(409);
    expect((await post(path(), { ...base, candidate: {} })).statusCode).toBe(400);
    if (failedId) expect((await post(path(), { ...base, validationId: failedId })).statusCode).toBe(409);
    const [first, second] = await Promise.all([post(path(), base), post(path(), base, bearer, 'en')]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 201]);
    const draft = rulePackageImportResultSchema.parse(first.json()).version;
    const retried = rulePackageImportResultSchema.parse(second.json()).version;
    expect(retried).toMatchObject({ versionId: draft.versionId, sha256: draft.sha256, text: base.text.en });
    expect(draft).toMatchObject({ kind: evidence.kind, reviewState: 'draft', text: base.text['zh-CN'],
      document: { scope: { kind: 'project', projectId }, validation: { id: checked.id, sha256: checked.sha256, taskId, projectId, candidateId } } });
    expect((await post(path(), { ...base, version: '2.0.0', scope: 'workspace' })).statusCode).toBe(409);

    const packagePath = `${library}/${draft.packageId}`;
    const reviewPath = (versionId: string) => `${packagePath}/versions/${versionId}/review`;
    const activationPath = `${packagePath}/activation`;
    const checks = { sourceAndLicense: true, scopeAndGuidance: true, validationEvidence: true };
    const publish = (version: typeof draft, reviewSha256: string, expectedSequence: number, action = 'publish') =>
      post(activationPath, { action, versionId: version.versionId, versionSha256: version.sha256, reviewSha256,
        expectedSequence, idempotencyKey: randomUUID() });
    expect((await publish(draft, sha256('unreviewed'), 0)).statusCode).toBe(409);
    expect((await post(reviewPath(draft.versionId), { versionSha256: draft.sha256, checks: {
      sourceAndLicense: true, scopeAndGuidance: true, designResources: true,
    } })).statusCode).toBe(400);
    const accepted = await post(reviewPath(draft.versionId), { versionSha256: draft.sha256, checks });
    expect(accepted.statusCode).toBe(201);
    const review = rulePackageImportResultSchema.parse(accepted.json()).version.review!;
    expect(review.checks).toEqual(checks);
    expect((await publish(draft, sha256('changed review'), 0)).statusCode).toBe(409);
    const published = await Promise.all([publish(draft, review.sha256, 0), publish(draft, review.sha256, 0)]);
    expect(published.map(result => result.statusCode).sort()).toEqual([201, 409]);
    const activation = rulePackageActivationResultSchema.parse(published.find(result => result.statusCode === 201)!.json());
    expect(activation.state.current).toMatchObject({ sequence: 1, versionId: draft.versionId, reviewSha256: review.sha256 });

    const runtime = database.storage.pool;
    await expect(runtime.query(`INSERT INTO itervane.rule_package_versions
      (package_id,workspace_id,package_key,project_id,version,sha256,submitted_by,grant_id,document,validation_id)
      SELECT package_id,workspace_id,package_key,project_id,'9.0.0',sha256,submitted_by,grant_id,
        jsonb_set(jsonb_set(document,'{version}','"9.0.0"'),'{candidate,key}','"substituted"'),validation_id
      FROM itervane.rule_package_versions WHERE id=$1`, [draft.versionId]))
      .rejects.toMatchObject({ code: '23514', message: 'rule_package_validation_binding' });

    const newerResponse = await post(path(), { ...base, version: '1.1.0' });
    expect(newerResponse.statusCode).toBe(201);
    const newer = rulePackageImportResultSchema.parse(newerResponse.json()).version;
    const newerReview = rulePackageImportResultSchema.parse((await post(reviewPath(newer.versionId), { versionSha256: newer.sha256, checks })).json()).version.review!;
    expect((await publish(newer, newerReview.sha256, 1)).statusCode).toBe(201);
    const rolledBack = await publish(draft, review.sha256, 2, 'rollback');
    expect(rolledBack.statusCode).toBe(201);
    expect(rulePackageActivationResultSchema.parse(rolledBack.json()).state.history.map(record => record.versionId))
      .toEqual([draft.versionId, newer.versionId, draft.versionId]);

    const workspace = await post(path(), { ...base, packageKey: 'workspace-validated-case', scope: 'workspace' });
    expect(workspace.statusCode).toBe(201);
    expect(rulePackageImportResultSchema.parse(workspace.json()).version.document.scope).toEqual({ kind: 'workspace' });
    const current = await app.inject({ url: activationPath, headers: { authorization: `Bearer ${bearer}` } });
    expect(rulePackageActivationViewSchema.parse(current.json()).current?.versionId).toBe(draft.versionId);
    return draft;
  } finally { await app.close(); }
}

async function repairReady() {
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { runner: completedRunner(fixtureFindingPath), auditModel: auditModel() });
  try { await processAdmittedTestTask(worker); } finally { await worker.close(); }
  const [inspection] = await database.storage.db.select().from(inspectionAttempts);
  const [repair] = await database.storage.db.select().from(formalRepairInputs);
  if (!inspection?.receipt || !repair?.document.findingIds.length) {
    const { rows: [runtime] } = await database.admin.query<{ reason: string }>(
      'SELECT reason FROM itervane.run_runtime WHERE run_id=$1', [task.runId]);
    throw new Error(`Missing repair fixture basis (${runtime?.reason ?? 'no phase'})`);
  }
  const original = 'Public sample\n';
  const patch: RepairPatch = {
    version: 1, baseSnapshotSha256: repair.document.inspection.snapshotSha256,
    files: [{ path: fixtureFindingPath, beforeSha256: sha256(original),
      edits: [{ startByte: Buffer.byteLength(original), endByte: Buffer.byteLength(original), replacement: 'Reviewed.\n' }] }],
  };
  return { scope: await claimAfterAudit(), scan: inspection.receipt, original,
    proposal: { callKeySha256: sha256('repair call'), findingIds: repair.document.findingIds, patch } };
}

function repairReceipt(scan: QualifiedInspectionReceipt, request: Parameters<RepairRunner['repair']>[0],
  workspace: Parameters<RepairRunner['repair']>[1], patch: RepairPatch, original: string | Readonly<Record<string, string>>): QualifiedRepairReceipt {
  const command = canonicalRepairCommand(workspace, patch);
  const { origin: registered, ...scope } = qualifiedRepairRequestSchema.parse({ ...request, operation: 'apply_repair',
    commandSha256: sha256(command.bytes), commandBytes: command.bytes.length });
  const domainId = randomUUID();
  const changes = patch.files.map(file => {
    const bytes = Buffer.from(typeof original === 'string' ? original : original[file.path]!);
    let modified = bytes;
    for (const edit of file.edits.toReversed()) {
      modified = Buffer.concat([modified.subarray(0, edit.startByte), Buffer.from(edit.replacement), modified.subarray(edit.endByte)]);
    }
    return { path: file.path, beforeSha256: file.beforeSha256, afterSha256: sha256(modified), beforeBytes: bytes.length,
      afterBytes: modified.length, edits: file.edits.length };
  });
  return {
    kind: 'repair_receipt', scope, domainId, imageSha256, originSha256: sha256(registered), commitSha256: scan.commitSha256,
    cleanupConfirmed: true, sessionVerified: true,
    snapshot: {
      runId: domainId, repositoryId: scope.repositoryId, commit: scope.commit, tree: scan.snapshot.tree, files: scan.snapshot.files,
      manifestSha256: scope.baseSnapshotSha256, commandSha256: scope.commandSha256, readOnly: true, offline: true,
      candidate: { version: 1, operationId: scope.operationId, repairInputSha256: scope.repairInputSha256,
        baseSnapshotSha256: scope.baseSnapshotSha256, workspaceSha256: command.workspaceSha256, patchSha256: command.patchSha256,
        candidateManifestSha256: sha256(JSON.stringify(changes)), changes },
    },
  };
}

const idleRepairRunner = () => ({ kind: 'status' as const, version: 1 as const, state: 'idle' as const, workspaceSha256, imageSha256 });

function repairObservationReceipt(scan: QualifiedInspectionReceipt, raw: Parameters<RepairObservationRunner['observeRepair']>[0],
  workspace: Parameters<RepairObservationRunner['observeRepair']>[1], targets: Parameters<RepairObservationRunner['observeRepair']>[2],
  original: string, range: QualifiedRepairObservationReceipt['snapshot']['observation']['targets'][number]['range'] = null
): QualifiedRepairObservationReceipt {
  const command = canonicalRepairObservation({ workspace, targets });
  const { origin: registered, ...request } = qualifiedRepairObservationRequestSchema.parse({ ...raw, operation: 'observe_repair',
    commandSha256: sha256(command.bytes), commandBytes: command.bytes.length });
  const domainId = randomUUID();
  return {
    kind: 'repair_observation', scope: request, domainId, imageSha256, originSha256: sha256(registered), commitSha256: scan.commitSha256,
    cleanupConfirmed: true, sessionVerified: true, snapshot: {
      runId: domainId, repositoryId: request.repositoryId, commit: request.commit, tree: scan.snapshot.tree, files: scan.snapshot.files,
      manifestSha256: workspace.baseSnapshotSha256, commandSha256: request.commandSha256, readOnly: true, offline: true,
      observation: { version: 1, operationId: workspace.operationId, repairInputSha256: workspace.repairInputSha256,
        baseSnapshotSha256: workspace.baseSnapshotSha256, targets: targets.map(target => ({
          ...target, status: 'text', file: { bytes: Buffer.byteLength(original), sha256: sha256(original) }, range, templates: [],
          ...('kind' in target ? { sourceText: original } : {}),
        })) },
    },
  };
}

it('observes only published audit targets while the current project grant survives', async () => {
  const { scope, proposal, scan, original } = await repairReady();
  let revoke = false;
  let blockedPulse = false;
  const observeRepair = vi.fn<RepairObservationRunner['observeRepair']>(async (raw, workspace, targets, authorize) => {
    await authorize();
    if (revoke) {
      const [grant] = (await database.admin.query('DELETE FROM itervane.workspace_members RETURNING workspace_id, principal_id')).rows;
      try { await authorize(); } catch { blockedPulse = true; }
      await database.admin.query('INSERT INTO itervane.workspace_members(workspace_id,principal_id) VALUES($1,$2)', [grant.workspace_id, grant.principal_id]);
    }
    return repairObservationReceipt(scan, raw, workspace, targets, original);
  });
  const options = { runner: { observe: async () => idleRepairRunner(), observeRepair }, protectedPaths: [] };
  await expect(observeFormalRepairTargets(coordinator, scope, [sha256('foreign finding')], options)).rejects.toMatchObject({ code: 'forbidden' });
  expect(observeRepair).not.toHaveBeenCalled();
  const observation = await observeFormalRepairTargets(coordinator, scope, proposal.findingIds, options);
  expect(observation).toMatchObject({ kind: 'repair_observation', scope: { runId: scope.runId, fence: scope.fence },
    snapshot: { observation: { targets: [{ findingId: proposal.findingIds[0], path: fixtureFindingPath, line: 3, scanner: 'gitleaks' }] } } });
  expect(await database.storage.db.select().from(formalRepairOperations)).toEqual([]);
  revoke = true;
  await expect(observeFormalRepairTargets(coordinator, scope, proposal.findingIds, options)).rejects.toMatchObject({ code: 'not_found' });
  expect(blockedPulse).toBe(true);
  expect(observeRepair).toHaveBeenCalledTimes(2);
});

it('binds a reviewed npm pair to the recorded scan and prevents partial edits, policy substitution and replay after revocation', async () => {
  const runner = inspectionRunner(async (request, authorize) => {
    await authorize();
    return testReceipt(request, false, undefined, npmFixtureApproval);
  });
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { runner, auditModel: auditModel() });
  try { await worker.tick(); } finally { await worker.close(); }
  const [inspection] = await database.storage.db.select().from(inspectionAttempts);
  const [input] = await database.storage.db.select().from(formalRepairInputs);
  if (!input || !inspection?.receipt) throw new Error('Missing npm fixture audit');
  const scan = inspection.receipt;
  const scope = await claimAfterAudit();
  const [findingId] = input.document.findingIds;
  expect(findingId).toBe(scan.snapshot.reports.find(report => report.scanner === 'trivy')?.findings[0]?.id);
  const files = npmFixtureFiles();
  const originals = Object.fromEntries(files.map(({ path, original }) => [path, original]));
  const patch = { version: 1 as const, baseSnapshotSha256: input.document.inspection.snapshotSha256,
    files: files.map(({ path, original, edits }) => ({ path, beforeSha256: sha256(original), edits })) };
  const proposal = { callKeySha256: sha256('npm repair'), findingIds: [findingId!], patch };
  const pair = [{ findingId, lockPath: npmFixturePaths.lock, approval: npmFixtureApproval }];
  const repair = vi.fn<RepairRunner['repair']>(async (request, workspace, appliedPatch, authorize) => {
    await authorize();
    expect(workspace.npmRepairs).toEqual(pair);
    return repairReceipt(scan, request, workspace, appliedPatch, originals);
  });
  const observeRepair = vi.fn<RepairObservationRunner['observeRepair']>(async (request, workspace, targets, authorize) => {
    await authorize();
    const receipt = repairObservationReceipt(scan, request, workspace, targets, '');
    expect(workspace.npmRepairs).toEqual(pair);
    for (const target of receipt.snapshot.observation.targets) {
      const file = files.find(entry => entry.path === target.path)!;
      const { name, installedVersion, fixedVersion } = npmFixtureApproval;
      target.file = { sha256: sha256(file.original), bytes: Buffer.byteLength(file.original) };
      target.npm = { name, installedVersion, fixedVersion, edits: file.edits };
    }
    return receipt;
  });
  const options = { runner: { observe: async () => idleRepairRunner(), repair, observeRepair }, protectedPaths: [], npmApprovals: [npmFixtureApproval] };
  const execution = new FormalRepairExecution(coordinator, options);
  const unapproved = new FormalRepairExecution(coordinator, { ...options, npmApprovals: [] });
  const stale = new FormalRepairExecution(coordinator, { ...options, npmApprovals: [{ ...npmFixtureApproval, fixedVersion: '4.17.22' }] });
  const protectedExecution = new FormalRepairExecution(coordinator, { ...options, protectedPaths: [npmFixturePaths.manifest] });
  await expect(unapproved.apply(scope, proposal)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(stale.apply(scope, proposal)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(protectedExecution.apply(scope, proposal)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(execution.apply(scope, { ...proposal, patch: { ...patch, files: patch.files.slice(0, 1) } })).rejects.toMatchObject({ code: 'forbidden' });
  expect(repair).not.toHaveBeenCalled();
  expect(await database.storage.db.select().from(formalRepairOperations)).toEqual([]);
  await expect(observeFormalRepairTargets(coordinator, scope, proposal.findingIds, options)).resolves.toMatchObject({ kind: 'repair_observation' });
  const applied = await execution.apply(scope, proposal);
  expect(applied).toMatchObject({ kind: 'repair_receipt', snapshot: { candidate: { changes: files.map(({ path, expected }) =>
    ({ path, afterSha256: sha256(expected) })) } } });
  expect(await execution.apply(scope, proposal)).toEqual(applied);
  const altered = new FormalRepairExecution(coordinator, { ...options, npmApprovals: [{ ...npmFixtureApproval, integrity: `sha512-${'A'.repeat(86)}==` }] });
  await expect(altered.apply(scope, proposal)).rejects.toMatchObject({ code: 'idempotency_conflict' });
  await expect(unapproved.apply(scope, proposal)).rejects.toMatchObject({ code: 'forbidden' });
  expect(repair).toHaveBeenCalledTimes(1);
  const [stored] = await database.storage.db.select().from(formalRepairOperations);
  expect(JSON.parse(stored!.command)).toMatchObject({ workspace: { npmRepairs: pair } });
});

it('uses the recorded mutation after a new worker claims a reserved repair whose checkpoint result was lost', async () => {
  const { scope, proposal, scan } = await repairReady();
  const prefix = 'fixture=one\nfixture2=two\n';
  const line = 'fixture3=public\n';
  const replacement = '# Replaced fixture line\n';
  const original = prefix + line;
  const range = { startByte: Buffer.byteLength(prefix), endByte: Buffer.byteLength(original), sha256: sha256(line) };
  const signal = new AbortController();
  const retired = new ExecutionLost();
  const observeRepair = vi.fn<RepairObservationRunner['observeRepair']>(async (request, workspace, targets, authorize) => {
    await authorize();
    return repairObservationReceipt(scan, request, workspace, targets, original, range);
  });
  const repair = vi.fn<RepairRunner['repair']>(async (request, workspace, patch, authorize) => {
    await authorize();
    expect(patch.files).toEqual([{ path: fixtureFindingPath, beforeSha256: sha256(original),
      edits: [{ startByte: range.startByte, endByte: range.endByte, replacement }] }]);
    return repairReceipt(scan, request, workspace, patch, original);
  });
  const complete = vi.fn<ModelAdapter['complete']>(async ({ conversation }) => {
    const context = conversation[0];
    if (context?.kind !== 'user') throw new Error('Missing repair context');
    const { observations } = JSON.parse(context.text) as { observations: AgentEvidence[] };
    const candidate = observations.find(item => item.data.kind === 'repair_candidate');
    if (candidate) return auditTurn('finish_role', { summary: '已按观测区间修改。', evidenceId: candidate.id });
    const target = observations.find(item => item.data.kind === 'repair_targets');
    if (!target || target.data.kind !== 'repair_targets') return auditTurn('read_repair_targets', { findingIds: proposal.findingIds });
    const { startByte, endByte } = target.data.observation.targets[0]!.range!;
    return auditTurn('apply_repair_patch', {
      observationId: target.id, targets: [{ targetIndex: 0, edits: [{ startByte, endByte, replacement }] }],
    });
  });
  const options = { runner: { observe: async () => idleRepairRunner(), observeRepair, repair }, protectedPaths: [] };
  const storage = PostgresSaver.fromConnString(database.runtimeUrl, { schema: 'itervane_checkpoint' });
  const saveWrites = storage.putWrites.bind(storage);
  const intercept = vi.spyOn(storage, 'putWrites').mockImplementation(async (config, writes, taskId, path) => {
    if (writes.some(([channel, value]) => channel === 'state' && JSON.stringify(value).includes('"kind":"repair_candidate"'))) {
      signal.abort(retired);
    }
    await saveWrites(config, writes, taskId, path);
  });
  try {
    await expect(runFormalRepair(coordinator, scope, storage, auditModel(complete), options, signal.signal)).rejects.toBe(retired);
    intercept.mockRestore();
    const [before] = await database.storage.db.select().from(formalRepairAttempts);
    expect(before).toMatchObject({ state: 'recorded', settledFence: scope.fence });
    expect(complete).toHaveBeenCalledTimes(2);
    await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
    await coordinator.reconcile(randomUUID());
    const replacementScope = await claim();
    const report = await runFormalRepair(coordinator, replacementScope, storage, auditModel(complete), options, new AbortController().signal);
    expect(replacementScope.fence).toBeGreaterThan(scope.fence);
    expect(report).toMatchObject({ reason: 'repair_complete', releaseEligible: false, usage: { turns: 3, toolCalls: 2 },
      formalRepair: { operationId: before!.operationId, receiptSha256: before!.receiptSha256 },
    });
    expect(await database.storage.db.select().from(formalRepairAttempts)).toEqual([before]);
    const [operation] = await database.storage.db.select().from(formalRepairOperations);
    expect(operation).toMatchObject({ callKeySha256: sha256(`${report.bindingSha256}:2`), operationId: before!.operationId });
    const [pointer] = await database.storage.db.select().from(formalRepairRuntime);
    expect(pointer).toMatchObject({ checkpointId: report.checkpointId, publishedFence: replacementScope.fence });
    expect(observeRepair).toHaveBeenCalledTimes(1);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(3);

    const publish = (outcome = report, lease = replacementScope) => coordinator.withLease(lease, (tx, { task: current }) =>
      publishFormalRepair(tx, current, lease, outcome, 'anthropic', new AbortController().signal));
    await expect(publish(report, scope)).rejects.toBeInstanceOf(ExecutionLost);
    await expect(publish({ ...report, checkpointId: randomUUID() })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(publish({ ...report, formalRepair: { ...report.formalRepair!, receiptSha256: sha256('different receipt') } }))
      .rejects.toThrow('formal_repair_candidate_evidence');
    await database.admin.query("ALTER TABLE itervane.task_events ADD CONSTRAINT injected_repair_event_failure CHECK(type <> 'task.repair_recorded') NOT VALID");
    try {
      await expect(publish()).rejects.toMatchObject({ cause: { constraint: 'injected_repair_event_failure' } });
      expect(await database.storage.db.select().from(formalRepairResults)).toEqual([]);
      expect(await new TaskService(database.storage).get(identity, task.id)).toMatchObject({ state: 'running' });
    } finally { await database.admin.query('ALTER TABLE itervane.task_events DROP CONSTRAINT injected_repair_event_failure'); }
    const result = await publish();
    expect(result.document).toMatchObject({ status: 'candidate_ready', releaseEligible: false, candidate: {
      operationId: before!.operationId, receiptSha256: before!.receiptSha256, manifestSha256: report.formalRepair!.candidateManifestSha256,
    } });
    expect((await database.storage.db.select().from(formalRepairResults))[0]).toMatchObject({
      requestId: before!.requestId, checkpointId: report.checkpointId, sha256: result.sha256, finalizedFence: replacementScope.fence,
    });
    expect(await new TaskService(database.storage).get(identity, task.id)).toMatchObject({ state: 'waiting_input' });
    const detail = (await database.admin.query("SELECT detail FROM itervane.task_events WHERE type='task.repair_recorded'")).rows;
    expect(detail).toEqual([{ detail: { reason: 'repair_ready', runId: scope.runId, repairResultSha256: result.sha256 } }]);
    await expect(database.storage.db.delete(formalRepairResults)).rejects
      .toMatchObject({ cause: { code: '23514', message: 'formal_repair_result_is_retained' } });
  } finally { intercept.mockRestore(); await storage.end(); }
});

it.each(['continuous', 'reclaimed', 'existing audit', 'verified candidate'] as const)('continues a sealed audit into a repair candidate through the ordinary queue (%s)', async mode => {
  const prefix = 'header=fixture\nkeep=on\n';
  const line = 'REMOVE=public\n';
  const original = prefix + line;
  const range = { startByte: Buffer.byteLength(prefix), endByte: Buffer.byteLength(original), sha256: sha256(line) };
  let scan: QualifiedInspectionReceipt | undefined;
  let candidate: QualifiedRepairReceipt['snapshot']['candidate'] | undefined;
  const inspect = vi.fn<InspectionRunner['inspect']>(async (request, authorize) => {
    await authorize();
    scan = testReceipt(request, false, fixtureFindingPath);
    return scan;
  });
  const observeRepair = vi.fn<RepairObservationRunner['observeRepair']>(async (request, workspace, targets, authorize) => {
    await authorize();
    return repairObservationReceipt(scan!, request, workspace, targets, original, range);
  });
  const repair = vi.fn<RepairRunner['repair']>(async (request, workspace, patch, authorize) => {
    await authorize();
    const receipt = repairReceipt(scan!, request, workspace, patch, original);
    candidate = receipt.snapshot.candidate;
    return receipt;
  });
  const verify = vi.fn<RescanRunner['verify']>(async (coordinates, input, patch, authorize) => {
    await authorize();
    if (input.subject.kind !== 'repair' || !candidate || !patch) throw new Error('Missing frozen repair candidate');
    const request = prepareQualifiedVerificationRequest(coordinates, canonicalVerificationCommand({ input, repair: patch }));
    return standardVerificationReceipt(scan!, request, input, false, candidate);
  });
  const completeAudit = vi.fn(concludeAudit);
  const completeRepair = vi.fn<ModelAdapter['complete']>(async ({ conversation }) => {
    const context = conversation[0];
    if (context?.kind !== 'user') throw new Error('Missing repair context');
    const { observations, handoff } = JSON.parse(context.text) as { observations: AgentEvidence[]; handoff: { findings: Array<{ id: string }> } };
    const candidate = observations.find(item => item.data.kind === 'repair_candidate');
    if (candidate) return auditTurn('finish_role', { evidenceId: candidate.id, summary: '已清理示例配置项。' });
    const target = observations.find(item => item.data.kind === 'repair_targets');
    if (!target || target.data.kind !== 'repair_targets') return auditTurn('read_repair_targets', { findingIds: handoff.findings.map(item => item.id) });
    return auditTurn('apply_repair_patch', { observationId: target.id, targets: [{ targetIndex: 0,
      edits: [{ startByte: range.startByte, endByte: range.endByte, replacement: '' }],
    }] });
  });
  const model = auditModel(request => {
    const context = request.conversation[0];
    const role = context?.kind === 'user' ? JSON.parse(context.text).role : undefined;
    if (role === 'verify') return scriptedVerification('zh-CN').complete(request);
    return (role === 'repair' ? completeRepair : completeAudit)(request);
  });
  const source = inspectionRunner(inspect);
  const tasks = new TaskService(database.storage);
  if (mode === 'reclaimed') {
    const scanWorker = new DurableWorker(database.storage, database.runtimeUrl, { runner: source });
    try { expect(await scanWorker.tick()).toBe(true); } finally { await scanWorker.close(); }
    const current = await tasks.get(identity, task.id);
    await tasks.resume(identity, task.id, { expectedVersion: current.version });
    const scope = await claim();
    const storage = PostgresSaver.fromConnString(database.runtimeUrl, { schema: 'itervane_checkpoint' });
    try {
      await expect(runFormalAudit(coordinator, scope, storage, model, new AbortController().signal, true)).resolves.toBe('repair_pending');
    } finally { await storage.end(); }
    expect(await tasks.get(identity, task.id)).toMatchObject({ state: 'running' });
    await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
  }
  if (mode === 'existing audit') {
    const auditOnly = new DurableWorker(database.storage, database.runtimeUrl, { runner: source, auditModel: model });
    try {
      expect(await auditOnly.tick()).toBe(true);
      const audited = await tasks.get(identity, task.id);
      expect((await tasks.events(identity, task.id, 50)).at(-1)).toMatchObject({ reason: 'audit_ready' });
      // An audit recorded before the repair handoff migration can enter repair as well.
      await clearRepairHandoff();
      await tasks.resume(identity, task.id, { expectedVersion: audited.version });
      expect(await auditOnly.tick()).toBe(true);
      const deferred = await tasks.get(identity, task.id);
      expect((await tasks.events(identity, task.id, 50)).at(-1)).toMatchObject({ reason: 'repair_deferred' });
      expect(deferred.state).toBe('waiting_input');
      await tasks.resume(identity, task.id, { expectedVersion: deferred.version });
    } finally { await auditOnly.close(); }
  }
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { runner: source, auditModel: model,
    repair: { runner: { observe: async () => idleRepairRunner(), observeRepair, repair }, protectedPaths: [] },
    ...(mode === 'verified candidate' ? { verification: { runner: { verify, observe: async () => idleRepairRunner() },
      profile: standardVerificationProfile } } : {}),
  });
  try { expect(await worker.tick()).toBe(true); } finally { await worker.close(); }
  const [result] = await database.storage.db.select().from(formalRepairResults);
  const [audit] = await database.storage.db.select().from(formalAuditResults);
  const events = await tasks.events(identity, task.id, 50, 'zh-CN');
  expect(result?.document, JSON.stringify({ reason: events.at(-1)?.reason, auditCalls: completeAudit.mock.calls.length,
    repairCalls: completeRepair.mock.calls.length, observationCalls: observeRepair.mock.calls.length, patchCalls: repair.mock.calls.length,
  })).toMatchObject({ status: 'candidate_ready', auditResultSha256: audit?.sha256, releaseEligible: false,
    candidate: { changes: [{ path: fixtureFindingPath, beforeSha256: sha256(original), afterSha256: sha256(prefix) }] },
  });
  expect(await tasks.get(identity, task.id)).toMatchObject({ runId: task.runId, state: 'waiting_input' });
  expect(result!.finalizedFence).toBe(audit!.finalizedFence + (mode === 'reclaimed' ? 1 : mode === 'existing audit' ? 2 : 0));
  if (mode === 'verified candidate') {
    expect(events.at(-2)).toMatchObject({ type: 'task.repair_recorded', reason: 'verification_pending', state: 'running' });
    expect(events.at(-1)).toMatchObject({ type: 'task.verification_recorded', reason: 'verification_observed', state: 'waiting_input' });
    const [verified] = await database.storage.db.select().from(formalVerificationResults);
    expect(verified).toMatchObject({ finalizedFence: result!.finalizedFence, document: { status: 'reviewed', releaseEligible: false,
      evidence: { binding: { subjectManifestSha256: candidate?.candidateManifestSha256 }, source: { resolved: 1, remaining: 0 } },
      review: { outcome: 'observed' } } });
    expect(verify).toHaveBeenCalledTimes(1);
  } else {
    expect(events.at(-1)).toMatchObject({ type: 'task.repair_recorded', reason: 'repair_ready',
      reasonMessage: '修复候选已就绪，等待独立复验。',
    });
    expect(verify).not.toHaveBeenCalled();
  }
  expect(inspect).toHaveBeenCalledTimes(1);
  expect(observeRepair).toHaveBeenCalledTimes(1);
  expect(repair).toHaveBeenCalledTimes(1);
  expect(completeAudit).toHaveBeenCalledTimes(3);
  expect(completeRepair).toHaveBeenCalledTimes(3);
  if (mode === 'continuous') {
    const publicUrl = 'https://itervane.example';
    const api = createApi(database.storage, { ...issuer.config, publicUrl }, { logger: false });
    const client = new Client({ name: 'repair-reader', version: '0.0.0' });
    try {
      const address = await api.listen({ host: '127.0.0.1', port: 0 });
      const token = await issuer.token('owner', { aud: `${publicUrl}/mcp`, scope: 'itervane:read' });
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        requestInit: { headers: { Authorization: `Bearer ${token}`, 'Accept-Language': 'zh-CN' } },
      }));
      const observed = await client.callTool({ name: 'get_repair', arguments: { taskId: task.id } });
      expect(observed.isError).not.toBe(true);
      const view = formalRepairDtoSchema.parse(observed.structuredContent);
      const url = `/v1/tasks/${task.id}/repair`;
      const authorization = `Bearer ${await issuer.token()}`;
      const zh = await api.inject({ url, headers: { authorization, 'Accept-Language': 'zh-CN' } });
      const en = await api.inject({ url, headers: { authorization, 'Accept-Language': 'en' } });
      expect(zh.statusCode).toBe(200);
      expect(zh.json()).toEqual(view);
      expect(en.json()).toMatchObject({ status: 'recorded', locale: 'en', result: result!.document,
        message: 'The candidate patch is recorded and ready for independent verification.',
      });
      const patchUrl = `${url}/patch?expectedSha256=${result!.sha256}`;
      const exported = await api.inject({ url: patchUrl, headers: { authorization } });
      expect(exported.statusCode).toBe(200);
      expect(exported.headers['cache-control']).toBe('no-store');
      const { patch, patchSha256 } = formalRepairPatchDtoSchema.parse(exported.json());
      expect(patchSha256).toBe(sha256(JSON.stringify(patch)));
      expect(patch.files).toEqual([{ path: fixtureFindingPath, beforeSha256: sha256(original),
        edits: [{ startByte: range.startByte, endByte: range.endByte, replacement: '' }],
      }]);
      expect(exported.body).not.toContain(line.trim());
      expect(JSON.stringify(view)).not.toContain('"replacement"');
      const scope = await claimAfterAudit();
      const prepare = () => coordinator.withLease(scope, (tx, current) => prepareFormalVerificationInput(tx, current.task, scope, verificationProfile));
      const frozen = await prepare();
      expect(frozen.document).toMatchObject({ runId: task.runId, audit: { resultSha256: audit!.sha256 }, profile: verificationProfile,
        subject: { kind: 'repair', resultSha256: result!.sha256, requestId: result!.requestId, patchSha256 },
      });
      const [operation] = await database.storage.db.select().from(formalRepairOperations);
      expect(frozen.document.subject).toMatchObject({ commandSha256: operation!.commandSha256, operationId: operation!.operationId });
      expect(JSON.stringify(frozen.document)).not.toContain('"replacement"');
      await expect(prepare()).resolves.toEqual(frozen);
      await expect(database.storage.db.insert(formalVerificationInputs).values({
        runId: scope.runId, preparedFence: scope.fence, workerId: scope.workerId, sha256: frozen.sha256,
        document: { ...frozen.document, subject: { ...frozen.document.subject, manifestSha256: sha256('substituted candidate') } },
      })).rejects.toMatchObject({ cause: { code: '23514', message: 'formal_verification_input_authority_or_source_mismatch' } });
      expect((await api.inject({ url: `${url}/patch?expectedSha256=${sha256('different result')}`, headers: { authorization } })).statusCode).toBe(409);
      const principal = randomUUID();
      await database.admin.query('INSERT INTO itervane.principals(id,issuer,subject) VALUES($1,$2,$3)', [principal, issuer.config.issuer, 'viewer']);
      await database.admin.query("INSERT INTO itervane.project_members(project_id,principal_id,role) VALUES($1,$2,'viewer')", [task.projectId, principal]);
      const viewer = { authorization: `Bearer ${await issuer.token('viewer')}` };
      expect((await api.inject({ url, headers: viewer })).statusCode).toBe(200);
      expect((await api.inject({ url: patchUrl, headers: viewer })).statusCode).toBe(403);
      await database.admin.query('DELETE FROM itervane.workspace_members');
      expect((await api.inject({ url: patchUrl, headers: { authorization } })).statusCode).toBe(404);
      expect((await client.callTool({ name: 'get_repair', arguments: { taskId: task.id } })).isError).toBe(true);
      await expect(prepare()).rejects.toMatchObject({ code: 'not_found' });
    } finally { await client.close(); await api.close(); }
  }
});

it('retains the audited source when there are no findings and does not queue a repair', async () => {
  const observeRepair = vi.fn<RepairObservationRunner['observeRepair']>();
  const repair = vi.fn<RepairRunner['repair']>();
  const worker = new DurableWorker(database.storage, database.runtimeUrl, {
    runner: completedRunner(), auditModel: auditModel(),
    repair: { runner: { observe: async () => idleRepairRunner(), observeRepair, repair }, protectedPaths: [] },
  });
  const tasks = new TaskService(database.storage);
  try {
    await processAdmittedTestTask(worker);
    const waiting = await tasks.get(identity, task.id);
    expect(waiting.state).toBe('waiting_input');
    await expect(tasks.resume(identity, task.id, { expectedVersion: waiting.version })).rejects.toMatchObject({ code: 'unsupported_state' });
  } finally { await worker.close(); }
  expect(observeRepair).not.toHaveBeenCalled();
  expect(repair).not.toHaveBeenCalled();
  const scope = await claimAfterAudit();
  const prepare = (lease: ExecutionScope, profile = verificationProfile) =>
    coordinator.withLease(lease, (tx, current) => prepareFormalVerificationInput(tx, current.task, lease, profile));
  const [first, duplicate] = await Promise.all([prepare(scope), prepare(scope)]);
  expect(duplicate).toEqual(first);
  expect(first.document.subject).toEqual({ kind: 'original', manifestSha256: first.document.inspection.snapshotSha256 });
  expect(first.sha256).toBe(sha256(JSON.stringify(first.document)));
  await expect(prepare(scope, { ...verificationProfile, policySha256: sha256('changed policy') })).rejects.toMatchObject({ code: 'conflict' });
  await expect(database.storage.db.delete(formalVerificationInputs)).rejects
    .toMatchObject({ cause: { code: '23514', message: 'formal_verification_input_is_retained' } });
  await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
  await coordinator.reconcile(randomUUID());
  const current = await claim();
  await expect(prepare(scope)).rejects.toBeInstanceOf(ExecutionLost);
  await expect(prepare(current)).resolves.toEqual(first);
  expect(await database.storage.db.select().from(formalVerificationInputs)).toHaveLength(1);
});

it('recovers an uncertain rescan only on the original idle Runner and retains the checked receipt', async () => {
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { runner: completedRunner(), auditModel: auditModel() });
  try { expect(await worker.tick()).toBe(true); } finally { await worker.close(); }
  const scope = await claimAfterAudit();
  const [inspection] = await database.storage.db.select().from(inspectionAttempts);
  const original = qualifiedInspectionResponseSchema.parse(inspection?.receipt);
  if (original.kind !== 'receipt') throw new Error('Missing original inspection');
  const { publishedCode: _inspectionCode, ...originalSnapshot } = original.snapshot;
  let status = idleRepairRunner();
  const verify = vi.fn<RescanRunner['verify']>(async (coordinates, input, repair, authorize) => {
    await authorize();
    const { origin: _origin, ...bound } = prepareQualifiedVerificationRequest(coordinates, canonicalVerificationCommand({ input, repair }));
    if (bound.fence === scope.fence) {
      return { kind: 'rejected', requestId: bound.requestId, domainId: null, code: 'cleanup_unproven', cleanup: 'unknown' };
    }
    const domainId = randomUUID();
    return { kind: 'verification_receipt', scope: bound, domainId, commitSha256: original.commitSha256,
      imageSha256, originSha256: original.originSha256, cleanupConfirmed: true, sessionVerified: true,
      snapshot: { ...originalSnapshot, runId: domainId, inputsSha256: bound.scannerInputsSha256, target: null,
        commandSha256: bound.commandSha256, verificationInputSha256: bound.verificationInputSha256 },
    };
  });
  const run = (lease: ExecutionScope) => runFormalRescan(coordinator, lease, verificationProfile, { observe: async () => status, verify });
  const unknown = await run(scope);
  expect(unknown).toMatchObject({ kind: 'rejected', code: 'cleanup_unproven' });
  expect(await run(scope)).toEqual(unknown);
  expect(verify).toHaveBeenCalledTimes(1);
  await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
  await coordinator.reconcile(randomUUID());
  const recovered = await claim();
  await expect(run(scope)).rejects.toBeInstanceOf(ExecutionLost);
  status = { ...status, workspaceSha256: sha256('different Runner workspace') };
  expect(await run(recovered)).toEqual(unknown);
  expect(verify).toHaveBeenCalledTimes(1);
  status = idleRepairRunner();
  const result = await run(recovered);
  if (result.kind !== 'scanned') throw new Error('Missing recovered rescan');
  expect(result.comparison).toEqual({ status: 'compared', groups: [], totals: { introduced: 0, resolved: 0, remaining: 0 } });
  expect(await run(recovered)).toEqual(result);
  expect(verify).toHaveBeenCalledTimes(2);
  const attempts = await database.storage.db.select().from(formalRescanAttempts);
  expect(attempts).toHaveLength(2);
  expect(attempts).toEqual(expect.arrayContaining([
    expect.objectContaining({ fence: scope.fence, state: 'closed', settledFence: recovered.fence, receipt: null }),
    expect.objectContaining({ fence: recovered.fence, state: 'recorded', receipt: result.receipt, receiptSha256: sha256(JSON.stringify(result.receipt)) }),
  ]));
  await expect(database.storage.db.delete(formalRescanAttempts)).rejects
    .toMatchObject({ cause: { code: '23514', message: 'formal_rescan_attempt_is_retained' } });
  await database.admin.query('DELETE FROM itervane.workspace_members');
  await expect(run(recovered)).rejects.toMatchObject({ code: 'not_found' });
  expect(verify).toHaveBeenCalledTimes(2);
});

async function assertVerificationRecovery(scope: ExecutionScope, options: FormalVerificationOptions, evidence: Extract<
  Awaited<ReturnType<typeof runFormalRescan>>, { kind: 'scanned' }>['evidence']) {
  const [stored] = await database.storage.db.select().from(formalVerificationInputs).where(eq(formalVerificationInputs.runId, scope.runId));
  if (!stored) throw new Error('Missing formal verification input');
  const { receiptSha256 } = evidence.binding;
  const verification = { inputSha256: stored.sha256, receiptSha256 };
  const saver = PostgresSaver.fromConnString(database.runtimeUrl, { schema: 'itervane_checkpoint' });
  const signal = new AbortController().signal;
  try {
    const wrong = new GuardedCheckpointer(coordinator, scope, saver, {
      verification: { ...verification, receiptSha256: sha256('unrecorded receipt') },
    });
    await expect(wrong.getTuple({ configurable: { thread_id: wrong.threadId } })).rejects.toBeInstanceOf(ExecutionLost);
    const checkpointer = new GuardedCheckpointer(coordinator, scope, saver, { verification });
    const scripted = scriptedVerification(stored.document.locale);
    const complete = vi.fn(scripted.complete);
    const model = { adapter: { ...scripted, complete }, providerSha256: sha256('verification provider') };
    const agent = createFormalVerification({
      input: stored, evidence, checkpointer, model: model.adapter, providerSha256: model.providerSha256,
      authorize: () => coordinator.withLease(scope, async () => true),
    });
    expect(await agent.run({ pauseAfter: 'decision' })).toMatchObject({ status: 'paused', usage: { turns: 1, toolCalls: 0 } });
    expect(await agent.run({ pauseAfter: 'reservation' })).toMatchObject({ status: 'paused', usage: { turns: 1, toolCalls: 1 } });
    const checkpoint = await checkpointer.getTuple({ configurable: { thread_id: checkpointer.threadId } });
    expect(checkpoint?.checkpoint.channel_values.state).toMatchObject({ pending: 'observation', usage: { toolCalls: 1 } });

    await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
    await coordinator.reconcile(randomUUID());
    const recovered = await claim();
    await expect(checkpointer.getTuple({ configurable: { thread_id: checkpointer.threadId } })).rejects.toBeInstanceOf(ExecutionLost);
    const resumed = await runFormalVerification(coordinator, recovered, saver, model, options, signal);
    expect(resumed).toMatchObject({ kind: 'reviewed', evidence, report: {
      status: 'completed', role: 'verify', releaseEligible: false, usage: { turns: 5, toolCalls: 4 },
      formalVerification: { outcome: 'observed', receiptSha256 },
    } });
    const [pointer] = await database.storage.db.select().from(formalVerificationRuntime)
      .where(eq(formalVerificationRuntime.runId, scope.runId));
    expect(pointer).toMatchObject({ receiptSha256, inputSha256: stored.sha256, publishedFence: recovered.fence, workerId: recovered.workerId });
    expect(await runFormalVerification(coordinator, recovered, saver, model, options, signal)).toEqual(resumed);
    expect(complete).toHaveBeenCalledTimes(5);
    await database.admin.query('DELETE FROM itervane.workspace_members');
    await expect(runFormalVerification(coordinator, recovered, saver, model, options, signal)).rejects.toMatchObject({ code: 'not_found' });
    expect(complete).toHaveBeenCalledTimes(5);
  } finally { await saver.end(); }
}

function standardVerificationReceipt(original: QualifiedInspectionReceipt, request: ReturnType<typeof prepareQualifiedVerificationRequest>,
  input: Parameters<RescanRunner['verify']>[1], regression = false, candidate?: QualifiedRepairReceipt['snapshot']['candidate'],
  imageVariant = ''): QualifiedVerificationReceipt {
  const { origin: _origin, ...bound } = request;
  const domainId = randomUUID();
  const profile = input.profile;
  if (!profile.buildProfileSha256) throw new Error('Missing build profile');
  const runtimeInputs = sha256('runtime inputs');
  const databaseEvidence = original.snapshot.reports[1].database;
  if (!databaseEvidence) throw new Error('Missing source database evidence');
  const imageDigest = 'sha256:' + sha256('OCI manifest' + imageVariant);
  const configDigest = 'sha256:' + sha256('OCI config' + imageVariant);
  const image: QualifiedStandardImageProof | undefined = profile.ociInputsSha256 && !regression ? {
    version: 1, status: 'scanned', ociInputsSha256: profile.ociInputsSha256, runtimeInputsSha256: runtimeInputs,
    platform: 'linux/amd64', manifestDigest: imageDigest, configDigest,
    baseManifestDigest: 'sha256:' + sha256('base'), appLayerDigest: 'sha256:' + sha256('app layer' + imageVariant),
    runtimeLayerSha256: sha256('runtime layer'), scan: {
      scanner: 'trivy', version: '0.76.2', imageDigest, configDigest, osPackages: 1, npmPackages: 1,
      findings: [{ class: 'lang-pkgs', advisory: 'FIXTURE-1', package: 'test-module', version: '1.2.3', severity: 'MEDIUM' }],
      policySha256: sha256('protected image scan'), reportSha256: sha256('image report'), database: databaseEvidence,
    },
    ...(profile.retainStandardImage ? { archive: { format: 'oci-layout-tar' as const, sha256: sha256('retained bytes' + imageVariant), bytes: 613 } } : {}),
  } : undefined;
  const target = candidate ? {
    manifestSha256: candidate.candidateManifestSha256, patchSha256: candidate.patchSha256,
    totalBytes: original.snapshot.totalBytes + candidate.changes.reduce((sum, change) => sum + change.afterBytes - change.beforeBytes, 0),
    reports: qualifiedScanReportsSchema.parse(original.snapshot.reports.map(report => ({
      ...report, snapshotSha256: candidate.candidateManifestSha256, findings: [],
    }))),
  } : null;
  const dist = { sha256: sha256('measured build'), files: 3, bytes: 220 };
  const { publishedCode: _inspectionCode, ...originalSnapshot } = original.snapshot;
  return {
    kind: 'verification_receipt', scope: bound, domainId, commitSha256: original.commitSha256, imageSha256,
    originSha256: original.originSha256, cleanupConfirmed: true, sessionVerified: true,
    snapshot: {
      ...originalSnapshot, runId: domainId, inputsSha256: bound.scannerInputsSha256, target,
      commandSha256: bound.commandSha256, verificationInputSha256: bound.verificationInputSha256,
      build: {
        status: 'built', version: 1, runId: domainId, buildProfileSha256: profile.buildProfileSha256,
        verificationInputSha256: bound.verificationInputSha256, baselineSha256: profile.baselineSha256,
        subjectManifestSha256: input.subject.manifestSha256, projectionSha256: sha256('staged projection'),
        isolationVerified: true, dist,
        ...(profile.runStandardBaseline ? { baseline: {
          version: 1 as const, status: regression ? 'failed' as const : 'passed' as const, appExited: true as const,
          runtimeInputsSha256: runtimeInputs, baselineSha256: profile.baselineSha256, distSha256: dist.sha256,
          checks: (['health', 'version', 'synthetic_data', 'page', 'compiled_asset'] as const).map(id => regression && id === 'health'
            ? { id, status: 'failed' as const, code: 'unexpected_status' as const, statusCode: 503 }
            : { id, status: 'passed' as const, code: null, statusCode: 200 }),
          ...(image ? { image } : {}),
        } } : {}),
      },
    },
  };
}

it.each(['build', 'baseline', 'image', 'artifact'] as const)('binds the standard %s proof to the frozen candidate in the lease transaction', async stage => {
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { runner: completedRunner(), auditModel: auditModel() });
  try { expect(await worker.tick()).toBe(true); } finally { await worker.close(); }
  const scope = await claimAfterAudit();
  const [inspection] = await database.storage.db.select().from(inspectionAttempts);
  const original = qualifiedInspectionResponseSchema.parse(inspection?.receipt);
  if (original.kind !== 'receipt') throw new Error('Missing original inspection');
  const ociInputs = stage === 'image' || stage === 'artifact' ? standardVerificationProfile.ociInputsSha256 : undefined;
  const profile = { ...verificationProfile, buildProfileSha256: standardVerificationProfile.buildProfileSha256,
    ...(stage !== 'build' ? { runStandardBaseline: true as const } : {}),
    ...(ociInputs ? { ociInputsSha256: ociInputs } : {}),
    ...(stage === 'artifact' ? { retainStandardImage: true as const } : {}),
  };
  const verify = vi.fn<RescanRunner['verify']>(async (coordinates, input, repair, authorize) => {
    await authorize();
    const command = canonicalVerificationCommand({ input, repair });
    const request = prepareQualifiedVerificationRequest(coordinates, command);
    const receipt = standardVerificationReceipt(original, request, input);
    const image = receipt.snapshot.build?.status === 'built' && receipt.snapshot.build.baseline?.status === 'passed'
      ? receipt.snapshot.build.baseline.image : undefined;
    const forged = structuredClone(receipt);
    const build = forged.snapshot.build;
    if (build?.status !== 'built') throw new Error('Missing build fixture');
    if (stage === 'artifact' && build.baseline?.status === 'passed' && build.baseline.image?.status === 'scanned') {
      delete build.baseline.image.archive;
    } else if (build.baseline?.status === 'passed' && build.baseline.image) {
      build.baseline.image.ociInputsSha256 = sha256('changed image inputs');
    } else if (build.baseline) build.baseline.distSha256 = sha256('changed distribution');
    else build.baselineSha256 = sha256('changed protected baseline');
    const binding = stage === 'artifact' ? 'image_archive' : stage;
    expect(() => verifyQualifiedVerificationReceipt(forged, request, command)).toThrow(`runner_standard_${binding}_binding`);
    await expect(database.storage.db.update(formalRescanAttempts).set({
      state: 'recorded', settledFence: scope.fence, settledWorkerId: scope.workerId, settledAt: new Date(),
      receipt: forged, receiptSha256: sha256(JSON.stringify(forged)),
    }).where(eq(formalRescanAttempts.requestId, request.requestId))).rejects
      .toMatchObject({ cause: { code: '23514', message: `standard_${stage}_evidence_binding` } });
    if (stage === 'image' && image && build.baseline?.status === 'passed') {
      const substituted = structuredClone(image);
      if (substituted.status !== 'scanned') throw new Error('Missing scanned image');
      substituted.scan.imageDigest = 'sha256:' + sha256('unrelated manifest');
      build.baseline.image = substituted;
      await expect(database.storage.db.update(formalRescanAttempts).set({
        state: 'recorded', settledFence: scope.fence, settledWorkerId: scope.workerId, settledAt: new Date(),
        receipt: forged, receiptSha256: sha256(JSON.stringify(forged)),
      }).where(eq(formalRescanAttempts.requestId, request.requestId))).rejects
        .toMatchObject({ cause: { code: '23514', message: 'standard_image_evidence_binding' } });
    }
    return receipt;
  });
  const rescan = () => runFormalRescan(coordinator, scope, profile, { observe: async () => idleRepairRunner(), verify });
  const result = await rescan();
  expect(result).toMatchObject({ kind: 'scanned', receipt: { snapshot: { build: { status: 'built', isolationVerified: true } } } });
  if (result.kind !== 'scanned') throw new Error('Missing formal rescan result');
  const originalBuild = result.receipt.snapshot.build;
  const image = originalBuild?.status === 'built' && originalBuild.baseline?.status === 'passed' ? originalBuild.baseline.image : undefined;
  expect(result.evidence).toMatchObject({
    binding: { taskId: scope.taskId, runId: scope.runId, projectId: original.scope.projectId,
      verificationInputSha256: result.receipt.scope.verificationInputSha256, receiptSha256: sha256(JSON.stringify(result.receipt)) },
    source: { status: 'compared', introduced: 0, remaining: 0, resolved: 0 },
    build: { status: 'built', distSha256: sha256('measured build') },
    baseline: { status: stage === 'build' ? 'not_requested' : 'passed' },
    image: ociInputs ? { status: 'scanned', manifestDigest: 'sha256:' + sha256('OCI manifest'), findings: { medium: 1 },
      archive: image?.status === 'scanned' ? image.archive ?? null : null }
      : { status: 'not_requested' },
  });
  expect(JSON.stringify(result.evidence)).not.toContain('test-module');
  if (stage === 'artifact') {
    const failed = structuredClone(result.receipt);
    const build = failed.snapshot.build;
    if (build?.status !== 'built' || build.baseline?.status !== 'passed') throw new Error('Missing baseline');
    build.baseline.status = 'failed';
    delete build.baseline.image;
    build.baseline.checks[0] = { id: 'health', status: 'failed', code: 'unexpected_status', statusCode: 503 };
    expect(projectVerificationEvidence(failed, result.comparison)).toMatchObject({
      baseline: { status: 'failed', failures: [{ id: 'health', statusCode: 503 }] }, image: { status: 'not_reached' },
    });
  }
  if (stage !== 'build') {
    expect(result).toMatchObject({ receipt: { snapshot: { build: { baseline: { status: 'passed', appExited: true } } } } });
  }
  if (image) expect(result).toMatchObject({ receipt: { snapshot: { build: { baseline: { image } } } } });
  expect(await rescan()).toEqual(result);
  if (stage === 'artifact') {
    await assertVerificationRecovery(scope, { profile, runner: { observe: async () => idleRepairRunner(), verify } }, result.evidence);
  }
  expect(verify).toHaveBeenCalledTimes(1);
});

it.each(['healthy', 'archive unavailable', 'archive mismatch', 'regression', 'reclaimed', 'profile changed', 'revoked', 'cleanup unknown', 'event blocked'] as const)(
  'continues the frozen source into verification through the ordinary queue (%s)', async mode => {
    const scan = vi.fn<InspectionRunner['inspect']>(async (request, authorize) => { await authorize(); return testReceipt(request); });
    const started = Promise.withResolvers<void>();
    const replacing = ['reclaimed', 'profile changed', 'revoked'].includes(mode);
    let observes = 0;
    const observe = async (signal?: AbortSignal) => {
      if (replacing && ++observes === 1) {
        started.resolve();
        await delay(30_000, undefined, { signal });
      }
      return idleRepairRunner();
    };
    const verify = vi.fn<RescanRunner['verify']>(async (coordinates, input, repair, authorize) => {
      await authorize();
      const [stored] = await database.storage.db.select().from(inspectionAttempts);
      const original = qualifiedInspectionResponseSchema.parse(stored?.receipt);
      if (original.kind !== 'receipt') throw new Error('Missing verified original');
      const request = prepareQualifiedVerificationRequest(coordinates, canonicalVerificationCommand({ input, repair }));
      if (mode === 'cleanup unknown') return {
        kind: 'rejected', requestId: request.requestId, domainId: null, code: 'cleanup_unproven', cleanup: 'unknown',
      };
      return standardVerificationReceipt(original, request, input, mode === 'regression');
    });
    const auditing = vi.fn(concludeAudit);
    const reviewing = vi.fn(scriptedVerification('zh-CN').complete);
    const model = auditModel(request => {
      const context = request.conversation[0];
      return (context?.kind === 'user' && JSON.parse(context.text).role === 'verify' ? reviewing : auditing)(request);
    });
    const runner = inspectionRunner(scan);
    const tasks = new TaskService(database.storage);
    const verifyArchive = vi.fn<NonNullable<FormalVerificationOptions['runner']['verifyArchive']>>(async archive =>
      mode === 'archive unavailable' ? null : { kind: 'archive_verified', version: 1, runnerImageSha256: imageSha256, archive });
    const openWorker = (profile: StandardVerificationProfile) => new DurableWorker(database.storage, database.runtimeUrl, {
      runner, auditModel: model, verification: { runner: { observe, verify, verifyArchive }, profile },
    });
    if (mode === 'event blocked') {
      await database.admin.query("ALTER TABLE itervane.task_events ADD CONSTRAINT injected_verification_event_failure CHECK(type <> 'task.verification_recorded') NOT VALID");
    }
    if (mode === 'archive mismatch') {
      await database.admin.query(`CREATE FUNCTION itervane.substitute_test_archive() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          NEW.document = jsonb_set(NEW.document, '{archiveVerification,archive,bytes}', '1');
          RETURN NEW;
        END $$;
        CREATE TRIGGER a_injected_archive_mismatch BEFORE INSERT ON itervane.formal_verification_results
        FOR EACH ROW EXECUTE FUNCTION itervane.substitute_test_archive()`);
    }
    const first = openWorker(standardVerificationProfile);
    try {
      const tick = first.tick();
      if (replacing) {
        await Promise.race([started.promise, tick.then(() => { throw new Error('Worker failed before verification handoff'); })]);
        const [input] = await database.storage.db.select().from(formalVerificationInputs);
        expect(input?.document).toMatchObject({ subject: { kind: 'original' }, profile: standardVerificationProfile });
        expect((await tasks.events(identity, task.id, 20)).at(-1)).toMatchObject({ type: 'task.audit_recorded', reason: 'verification_pending' });
        await first.close();
        await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
        if (mode === 'revoked') await database.admin.query('DELETE FROM itervane.workspace_members');
        const profile = mode === 'profile changed'
          ? { ...standardVerificationProfile, policySha256: sha256('new profile') } : standardVerificationProfile;
        const replacement = openWorker(profile);
        try { expect(await replacement.tick()).toBe(true); } finally { await replacement.close(); }
      }
      expect(await tick).toBe(true);
    } finally {
      await first.close();
      if (mode === 'event blocked') await database.admin.query('ALTER TABLE itervane.task_events DROP CONSTRAINT injected_verification_event_failure');
      if (mode === 'archive mismatch') await database.admin.query(`DROP TRIGGER a_injected_archive_mismatch ON itervane.formal_verification_results;
        DROP FUNCTION itervane.substitute_test_archive()`);
    }

    expect(scan).toHaveBeenCalledTimes(1);
    expect(auditing).toHaveBeenCalledTimes(3);
    const records = await database.storage.db.select().from(formalVerificationResults);
    if (mode === 'event blocked' || mode === 'archive mismatch') {
      expect(records).toEqual([]);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(reviewing).toHaveBeenCalledTimes(5);
      expect(verifyArchive).toHaveBeenCalledTimes(1);
      const [receipt] = await database.storage.db.select().from(formalRescanAttempts);
      expect(receipt).toMatchObject({ state: 'recorded' });
      expect((await tasks.events(identity, task.id, 20)).at(-1)).toMatchObject({ state: 'needs_human', reason: 'verification_unavailable' });
      return;
    }
    if (mode === 'revoked' || mode === 'profile changed' || mode === 'cleanup unknown') {
      expect(records).toEqual([]);
      expect(reviewing).not.toHaveBeenCalled();
      expect(verifyArchive).not.toHaveBeenCalled();
      expect(verify).toHaveBeenCalledTimes(mode === 'cleanup unknown' ? 1 : 0);
      const [event] = (await database.admin.query(
        'SELECT state, detail FROM itervane.task_events WHERE task_id=$1 ORDER BY sequence DESC LIMIT 1', [task.id],
      )).rows;
      expect(event).toMatchObject({ state: mode === 'cleanup unknown' ? 'reconciling' : 'needs_human',
        detail: { reason: mode === 'cleanup unknown' ? 'verification_reconciling'
          : mode === 'revoked' ? 'permission_revoked' : 'verification_unavailable' } });
      if (mode === 'cleanup unknown') {
        expect(await new VerificationViewService(database.storage).get(identity, task.id, 'zh-CN')).toMatchObject({
          current: { status: 'reconciling', message: /清理/ }, previous: null,
        });
      }
      return;
    }

    const [record, ...duplicates] = records;
    const [rescan] = await database.storage.db.select().from(formalRescanAttempts);
    const [input] = await database.storage.db.select().from(formalVerificationInputs);
    const failed = mode === 'regression';
    expect(duplicates).toEqual([]);
    expect(record).toMatchObject({ inputSha256: input?.sha256, receiptSha256: rescan?.receiptSha256, requestId: rescan?.requestId,
      document: { status: 'reviewed', releaseEligible: false, evidence: { baseline: { status: failed ? 'failed' : 'passed' } },
        review: { outcome: failed ? 'checks_failed' : 'observed' } },
    });
    expect(record!.finalizedFence).toBe(input!.preparedFence + (mode === 'reclaimed' ? 1 : 0));
    expect(verify).toHaveBeenCalledTimes(1);
    expect(reviewing).toHaveBeenCalledTimes(failed ? 4 : 5);
    if (failed) expect(verifyArchive).not.toHaveBeenCalled();
    else expect(verifyArchive).toHaveBeenCalledTimes(1);
    if (failed || mode === 'archive unavailable') expect(record!.document.archiveVerification).toBeUndefined();
    else expect(record!.document.archiveVerification).toMatchObject({ kind: 'archive_verified', runnerImageSha256: imageSha256 });
    const recent = (await tasks.events(identity, task.id, 20, 'zh-CN')).at(-1);
    expect(recent).toMatchObject({ type: 'task.verification_recorded', state: failed ? 'needs_human' : 'waiting_input',
      reason: failed ? 'verification_checks_failed' : 'verification_observed', reasonMessage: /复验/ });
    expect((await database.admin.query('SELECT task_id FROM itervane.execution_slot')).rows[0]).toEqual({ task_id: null });
    await expect(database.storage.db.update(formalVerificationResults).set({ sha256: sha256('different result') }))
      .rejects.toMatchObject({ cause: { code: '23514', message: 'formal_verification_result_is_immutable' } });
    if (mode === 'healthy' || mode === 'reclaimed' || mode === 'archive unavailable' || mode === 'regression') {
      await assertFormalCandidate(mode === 'healthy' || mode === 'reclaimed', mode === 'reclaimed' ? 'cancel' : 'revoke');
    }
  },
);

async function assertFormalCandidate(eligible: boolean, stop: 'revoke' | 'cancel') {
  const resources = new ResourceService(database.storage);
  async function environmentFor(projectId: string) {
    const application = await resources.createApplication(identity, projectId, { name: 'Release sample' });
    return resources.createEnvironment(identity, projectId, { applicationId: application.id, name: 'Protected demo' });
  }
  const environment = await environmentFor(task.projectId);
  const target = { environmentId: environment.id, deploymentId: 'a'.repeat(24), serverId: 'b'.repeat(24),
    imageRepository: 'testing/standard', runtimeConfigSha256: sha256('runtime configuration'),
    verificationProfileSha256: verificationProfileFingerprint(standardVerificationProfile),
    rolloutCheckSha256: sha256('health verification'), recoveryPlanSha256: sha256('known release'),
  };
  const registered = await registerReleaseTarget(database.storage, target);
  expect(await registerReleaseTarget(database.storage, target)).toEqual(registered);
  const current = await new TaskService(database.storage).get(identity, task.id);
  const portalClientId = 'itervane-test-portal';
  const publicUrl = 'https://itervane.example';
  const api = createApi(database.storage, { ...issuer.config, portalClientId, publicUrl }, { logger: false });
  const clients: Client[] = [];
  const url = `/v1/tasks/${task.id}/release-candidate`;
  const headers = { authorization: `Bearer ${await issuer.token()}`, 'Accept-Language': 'zh-CN' };
  const portalHeaders = { ...headers, authorization: `Bearer ${await issuer.token('owner', { azp: portalClientId })}` };
  const viewUrl = `/v1/tasks/${task.id}/release`;
  async function view(as = portalHeaders) {
    const response = await api.inject({ url: viewUrl, headers: as });
    expect(response.statusCode).toBe(200);
    return formalReleaseViewSchema.parse(response.json());
  }
  const payload = { environmentId: environment.id, expectedVersion: current.version };
  const freeze = (body = payload) => api.inject({ method: 'POST', url, payload: body, headers });
  try {
    if (!eligible) {
      expect((await freeze()).statusCode).toBe(409);
      expect(await view()).toMatchObject({ candidate: null, candidateTarget: null, result: null, availableTargets: [], actions: [] });
      expect(await database.storage.db.select().from(releaseCandidates)).toEqual([]);
      return;
    }
    const otherProject = await resources.createProject(identity, { name: 'Other', slug: 'other-release' });
    const otherEnvironment = await environmentFor(otherProject.id);
    await expect(registerReleaseTarget(database.storage, { ...target, environmentId: otherEnvironment.id }))
      .rejects.toMatchObject({ cause: { code: '23505' } });
    await registerReleaseTarget(database.storage, { ...target, environmentId: otherEnvironment.id, deploymentId: 'c'.repeat(24) });
    const display = { environmentId: environment.id, applicationId: environment.applicationId,
      environmentName: environment.name, applicationName: 'Release sample' };
    expect(await view()).toEqual({ taskId: task.id, runId: current.runId, taskVersion: current.version,
      candidate: null, candidateTarget: null, result: null, availableTargets: [{ ...display, revision: 1 }], actions: [] });
    expect((await freeze({ ...payload, environmentId: otherEnvironment.id })).statusCode).toBe(404);
    expect((await freeze({ ...payload, expectedVersion: current.version + 1 })).statusCode).toBe(409);

    await database.admin.query("ALTER TABLE itervane.task_events ADD CONSTRAINT injected_release_event_failure CHECK(type <> 'task.release_candidate_frozen') NOT VALID");
    try {
      expect((await freeze()).statusCode).toBe(500);
      expect(await database.storage.db.select().from(releaseCandidates)).toEqual([]);
      expect(await new TaskService(database.storage).get(identity, task.id)).toMatchObject({ state: 'waiting_input', version: current.version });
    } finally { await database.admin.query('ALTER TABLE itervane.task_events DROP CONSTRAINT injected_release_event_failure'); }

    const responses = await Promise.all([freeze(), freeze()]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 201]);
    const candidate = formalReleaseCandidateDtoSchema.parse(responses[0]!.json());
    expect(responses[1]!.json()).toEqual(candidate);
    expect(candidate).toMatchObject({ locale: 'zh-CN', status: 'pending', message: '发布候选已冻结，等待人工决定。', manifest: {
      source: task.source, target: { applicationId: environment.applicationId, environmentId: environment.id, revision: 1, mappingSha256: registered.fingerprint },
      diffSha256: null, runId: current.runId, image: { runnerImageSha256: imageSha256, findings: { medium: 1 } },
    } });
    const [proof] = await database.storage.db.select().from(formalVerificationResults);
    expect(candidate.manifest.verification).toMatchObject({ inputSha256: proof?.inputSha256, resultSha256: proof?.sha256, receiptSha256: proof?.receiptSha256 });
    expect(candidate.manifest.image.archive).toEqual(proof?.document.archiveVerification?.archive);
    expect(await view()).toEqual({ taskId: task.id, runId: current.runId, taskVersion: current.version + 1,
      candidate, candidateTarget: display, result: null, availableTargets: [], actions: ['confirm', 'reject'] });
    expect((await view(headers)).actions).toEqual([]);
    const [stored] = await database.storage.db.select().from(releaseCandidates);
    const substitute = { ...candidate.manifest, evidenceVersion: 2, image: { ...candidate.manifest.image,
      archive: { ...candidate.manifest.image.archive, bytes: candidate.manifest.image.archive.bytes + 1 },
    } };
    await expect(database.storage.db.insert(releaseCandidates).values({ ...stored!, id: randomUUID(), evidenceVersion: 2,
      document: substitute, fingerprint: sha256(JSON.stringify(substitute)),
    })).rejects.toMatchObject({ cause: { code: '23514', message: 'formal_release_candidate_binding' } });

    const viewer = randomUUID();
    await database.admin.query('INSERT INTO itervane.principals(id,issuer,subject) VALUES($1,$2,$3)', [viewer, issuer.config.issuer, 'release-viewer']);
    await database.admin.query("INSERT INTO itervane.project_members(project_id,principal_id,role) VALUES($1,$2,'viewer')", [task.projectId, viewer]);
    const viewerHeaders = { authorization: `Bearer ${await issuer.token('release-viewer')}`, 'Accept-Language': 'en' };
    const viewerCandidate = (await api.inject({ url, headers: viewerHeaders })).json();
    expect(viewerCandidate).toMatchObject({ id: candidate.id, locale: 'en', status: 'pending',
      message: 'The release candidate is awaiting a human decision.',
    });
    const address = await api.listen({ host: '127.0.0.1', port: 0 });
    async function connect(subject: string, scope: string, locale: string) {
      const token = await issuer.token(subject, { aud: `${publicUrl}/mcp`, scope });
      const client = new Client({ name: 'release-candidate-test', version: '0.0.0' });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        requestInit: { headers: { Authorization: `Bearer ${token}`, 'Accept-Language': locale } },
      }));
      return client;
    }
    const viewerMcp = await connect('release-viewer', 'itervane:read itervane:write', 'en');
    const args = { name: 'get_release_candidate', arguments: { taskId: task.id } };
    const readCandidate = await viewerMcp.callTool(args);
    expect(readCandidate.isError).not.toBe(true);
    expect(formalReleaseCandidateDtoSchema.parse(readCandidate.structuredContent)).toEqual(viewerCandidate);
    expect((await api.inject({ method: 'POST', url, headers: viewerHeaders, payload })).statusCode).toBe(403);
    expect(await view(viewerHeaders)).toMatchObject({ candidate: { id: candidate.id, locale: 'en' },
      candidateTarget: display, actions: [], availableTargets: [] });
    const options = { name: 'get_release_options', arguments: { taskId: task.id } };
    const request = (expectedVersion: number, environmentId = environment.id) => ({
      name: 'request_release', arguments: { taskId: task.id, environmentId, expectedVersion },
    });
    expect(formalReleaseOptionsSchema.parse((await viewerMcp.callTool(options)).structuredContent).availableTargets).toEqual([]);
    expect(apiErrorSchema.parse((await viewerMcp.callTool(request(current.version + 1))).structuredContent).error.code).toBe('forbidden');
    await database.admin.query('DELETE FROM itervane.project_members WHERE principal_id=$1', [viewer]);
    expect((await api.inject({ url, headers: viewerHeaders })).statusCode).toBe(404);
    expect((await api.inject({ url: viewUrl, headers: viewerHeaders })).statusCode).toBe(404);
    const denied = await viewerMcp.callTool(args);
    expect(denied.isError).toBe(true);
    expect(apiErrorSchema.parse(denied.structuredContent).error.code).toBe('not_found');
    expect(apiErrorSchema.parse((await viewerMcp.callTool(options)).structuredContent).error.code).toBe('not_found');

    const bound = { ...target, registryOrigin: 'https://registry.example.invalid' };
    const originRevision = await registerReleaseTarget(database.storage, bound);
    expect(originRevision.revision).toBe(2);
    expect(originRevision.fingerprint).not.toBe(registered.fingerprint);
    expect(await registerReleaseTarget(database.storage, { ...bound, registryOrigin: 'https://REGISTRY.example.invalid:443/' }))
      .toEqual(originRevision);
    await expect(registerReleaseTarget(database.storage, { ...bound, registryOrigin: 'http://registry.example.invalid:5000' }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    expect((await api.inject({ url, headers })).json()).toMatchObject({ id: candidate.id, status: 'evidence_changed' });

    expect(await registerReleaseTarget(database.storage, { ...bound, blockImageSeverities: ['critical', 'medium'] })).toMatchObject({ revision: 3 });
    expect((await api.inject({ url, headers })).json()).toMatchObject({ id: candidate.id, status: 'evidence_changed' });
    expect(await view()).toMatchObject({ candidate: { id: candidate.id, status: 'evidence_changed', manifest: { target: { revision: 1 } } },
      candidateTarget: display, availableTargets: [], actions: [] });
    expect((await freeze({ ...payload, expectedVersion: current.version + 1 })).statusCode).toBe(409);
    expect(await registerReleaseTarget(database.storage, bound)).toMatchObject({ revision: 4, fingerprint: originRevision.fingerprint });
    expect((await api.inject({ url, headers })).json()).toMatchObject({ id: candidate.id, status: 'evidence_changed' });
    expect(await view()).toMatchObject({ availableTargets: [{ ...display, revision: 4 }], actions: [] });
    const externalOwner = await connect('owner', 'itervane:read itervane:write', 'zh-CN');
    expect(formalReleaseOptionsSchema.parse((await externalOwner.callTool(options)).structuredContent)).toEqual({
      taskId: task.id, runId: current.runId, taskVersion: current.version + 1, availableTargets: [{ ...display, revision: 4 }],
    });
    const staleRequest = await externalOwner.callTool(request(current.version));
    expect(apiErrorSchema.parse(staleRequest.structuredContent).error.code).toBe('version_conflict');
    const outsideProject = await externalOwner.callTool(request(current.version + 1, otherEnvironment.id));
    expect(apiErrorSchema.parse(outsideProject.structuredContent).error.code).toBe('not_found');
    const nextRequest = request(current.version + 1);
    const invalid = await externalOwner.callTool({ ...nextRequest, arguments: { ...nextRequest.arguments, approve: true } });
    expect(apiErrorSchema.parse(invalid.structuredContent).error.code).toBe('invalid_input');
    const next = await externalOwner.callTool(nextRequest);
    expect(next.isError).not.toBe(true);
    const replacement = formalReleaseCandidateDtoSchema.parse(next.structuredContent);
    expect((await externalOwner.callTool(nextRequest)).structuredContent).toEqual(replacement);
    expect((await api.inject({ url, headers })).json()).toEqual(replacement);
    expect(replacement).toMatchObject({ status: 'pending', operationId: null, decisions: [] });
    expect(replacement.fingerprint).not.toBe(candidate.fingerprint);
    expect(replacement.manifest.evidenceVersion).toBe(2);
    expect(replacement.manifest.target.revision).toBe(4);
    expect((await new TaskService(database.storage).events(identity, task.id, 50, 'zh-CN')).at(-1))
      .toMatchObject({ type: 'task.release_candidate_frozen', state: 'waiting_approval', message: /人工决定/ });
    expect((await database.admin.query('SELECT count(*)::int AS count FROM itervane.release_operations')).rows[0]?.count).toBe(0);
    await assertReleaseApproval(api, replacement, candidate, portalClientId, stop);
  } finally { await Promise.allSettled(clients.map(client => client.close())); await api.close(); }
}

async function assertReleaseApproval(api: ReturnType<typeof createApi>, current: ReturnType<typeof formalReleaseCandidateDtoSchema.parse>,
  superseded: ReturnType<typeof formalReleaseCandidateDtoSchema.parse>, portalClientId: string, stop: 'revoke' | 'cancel') {
  const url = `/v1/release-candidates/${current.id}/decisions`;
  const headers = { authorization: `Bearer ${await issuer.token('owner', { azp: portalClientId })}`, 'Accept-Language': 'zh-CN' };
  const payload = { action: 'confirm', fingerprint: current.fingerprint, expectedVersion: 0, idempotencyKey: randomUUID() };
  const confirm = () => api.inject({ method: 'POST', url, payload, headers });
  expect((await api.inject({ method: 'POST', url, payload, headers: { authorization: `Bearer ${await issuer.token()}` } })).statusCode).toBe(403);
  expect((await api.inject({ method: 'POST', url: `/v1/release-candidates/${superseded.id}/decisions`, headers,
    payload: { ...payload, fingerprint: superseded.fingerprint },
  })).statusCode).toBe(409);
  await expect(database.storage.db.insert(releaseOperations).values({ id: randomUUID(), candidateId: current.id,
    environmentId: current.manifest.target.environmentId, approvalVersion: 1,
  })).rejects.toMatchObject({ cause: { code: '23514', message: 'formal_release_operation_approval_binding' } });

  const sending = vi.spyOn(database.storage.boss, 'send').mockResolvedValueOnce(null);
  try { expect((await confirm()).statusCode).toBe(503); }
  finally { sending.mockRestore(); }
  expect(await database.storage.db.select().from(releaseOperations)).toHaveLength(0);
  expect(await database.storage.db.select().from(releaseDecisions)).toHaveLength(0);
  expect(await new TaskService(database.storage).get(identity, task.id)).toMatchObject({ state: 'waiting_approval' });

  const responses = await Promise.all([confirm(), confirm()]);
  expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
  expect(responses.map(response => response.json().replayed).sort()).toEqual([false, true]);
  const approved = formalReleaseCandidateDtoSchema.parse(responses[0]!.json().candidate);
  expect(responses[1]!.json().candidate).toEqual(approved);
  expect(approved).toMatchObject({ id: current.id, status: 'confirmed', decisionVersion: 1, message: /已入队/,
    decisions: [{ action: 'confirm', selfConfirmed: true }],
  });
  const operations = await database.storage.db.select().from(releaseOperations);
  expect(operations).toHaveLength(1);
  expect(operations[0]).toMatchObject({ id: approved.operationId, state: 'queued' });
  const jobs = await database.storage.boss.findJobs(formalReleaseQueue);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ id: approved.operationId, data: { operationId: approved.operationId } });
  const tasks = new TaskService(database.storage);
  const queued = await tasks.get(identity, task.id);
  expect(queued.state).toBe('queued');
  const viewUrl = `/v1/tasks/${task.id}/release`;
  expect(formalReleaseViewSchema.parse((await api.inject({ url: viewUrl, headers })).json()))
    .toMatchObject({ taskVersion: queued.version, candidate: approved, availableTargets: [], actions: ['revoke'] });
  await coordinator.reconcile(randomUUID());
  expect((await database.storage.db.select().from(taskRuns).where(eq(taskRuns.id, queued.runId)))[0]?.wakeupJobId).toBeNull();

  if (stop === 'revoke') {
    const [owner] = await database.storage.db.delete(workspaceMembers).returning();
    await database.storage.db.insert(workspaceMembers).values({ principalId: owner!.principalId, workspaceId: owner!.workspaceId });
    expect((await confirm()).json()).toMatchObject({ replayed: true, candidate: { status: 'approver_revoked' } });
    const revoke = await api.inject({ method: 'POST', url, headers, payload: {
      action: 'revoke', fingerprint: current.fingerprint, expectedVersion: 1, idempotencyKey: randomUUID(),
    } });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toMatchObject({ candidate: { status: 'revoked', decisionVersion: 2 } });
    expect(formalReleaseViewSchema.parse((await api.inject({ url: viewUrl, headers })).json()))
      .toMatchObject({ candidate: { status: 'revoked' }, actions: [] });
  } else {
    expect(await tasks.cancel(identity, task.id, { expectedVersion: queued.version })).toMatchObject({ state: 'cancelled' });
    expect((await confirm()).json()).toMatchObject({ replayed: true, candidate: { status: 'task_changed' } });
  }
  expect((await database.storage.db.select().from(releaseOperations))[0]).toMatchObject({ state: 'blocked' });
  expect(await database.storage.boss.fetch(formalReleaseQueue)).toEqual([]);
}

const releaseOrigin = 'https://registry.example.invalid';

async function adjustFixtureVerification(statement: string, values: unknown[] = []) {
  const connection = await database.admin.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('ALTER TABLE itervane.formal_verification_results DISABLE TRIGGER formal_verification_result_authority');
    await connection.query(statement, values);
    await connection.query('ALTER TABLE itervane.formal_verification_results ENABLE TRIGGER formal_verification_result_authority');
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally { connection.release(); }
}

const komodoBinding = { origin: 'https://komodo.example.invalid', actorId: 'd'.repeat(24) };

const rolloutCheckFixture = {
  version: 1, origin: 'https://app.example.invalid', healthPath: '/health', network: 'private-demo', backendPort: 3000,
  traefik: { apiOrigin: 'http://127.0.0.1:8120', entryPoint: 'websecure', routeName: 'demo',
    forwardAuthAddress: 'http://demo-oauth:4180/oauth2/auth' },
  probeIdentity: { issuer: 'https://idp.example.invalid/realms/demo', audience: 'demo',
    clientId: 'demo-probe', subject: 'expected-probe-service-account' },
} as const;

async function preparedFormalRelease(options: {
  separateRequester?: boolean; expiring?: boolean; komodo?: boolean; rolloutCheck?: boolean; existingTarget?: FormalReleaseTarget;
  imageVariant?: string;
} = {}) {
  const taskService = new TaskService(database.storage);
  const resources = new ResourceService(database.storage);
  const verifyIdentity = createIdentityVerifier(issuer.config);
  let requester = identity;
  if (options.separateRequester) {
    const [principal] = await database.storage.db.insert(principals).values({ issuer: issuer.config.issuer, subject: 'release-requester' }).returning();
    await database.storage.db.insert(projectMembers).values({ principalId: principal!.id, projectId: task.projectId, role: 'maintainer' });
    requester = await verifyIdentity(await issuer.token('release-requester'));
    await taskService.cancel(identity, task.id, { expectedVersion: task.version });
    task = (await taskService.admit(requester, { projectId: task.projectId, source: task.source,
      purpose: 'Request scoped release', dataClass: 'synthetic', locale: 'zh-CN', idempotencyKey: randomUUID() })).task;
  }
  const reviewing = scriptedVerification('zh-CN');
  const worker = new DurableWorker(database.storage, database.runtimeUrl, {
    runner: inspectionRunner(async (request, authorize) => { await authorize(); return testReceipt(request); }),
    auditModel: auditModel(request => {
      const context = request.conversation[0];
      return context?.kind === 'user' && JSON.parse(context.text).role === 'verify' ? reviewing.complete(request) : concludeAudit(request);
    }),
    verification: { profile: standardVerificationProfile, runner: {
      observe: async () => idleRepairRunner(),
      verify: async (coordinates, input, repair, authorize) => {
        await authorize();
        const [stored] = await database.storage.db.select().from(inspectionAttempts).where(eq(inspectionAttempts.runId, task.runId));
        const original = qualifiedInspectionResponseSchema.parse(stored?.receipt);
        if (original.kind !== 'receipt') throw new Error('Missing verified original');
        const request = prepareQualifiedVerificationRequest(coordinates, canonicalVerificationCommand({ input, repair }));
        return standardVerificationReceipt(original, request, input, false, undefined, options.imageVariant);
      },
      verifyArchive: async archive => ({ kind: 'archive_verified', version: 1, runnerImageSha256: imageSha256, archive }),
    } },
  });
  try { await processAdmittedTestTask(worker); } finally { await worker.close(); }
  let target = options.existingTarget;
  if (!target) {
    const application = await resources.createApplication(identity, task.projectId, { name: 'Claim sample' });
    const environment = await resources.createEnvironment(identity, task.projectId, { applicationId: application.id, name: 'Protected sample' });
    target = formalReleaseTargetSchema.parse({ environmentId: environment.id, deploymentId: 'a'.repeat(24), serverId: 'b'.repeat(24),
      imageRepository: 'testing/standard', registryOrigin: releaseOrigin, runtimeConfigSha256: sha256('runtime configuration'),
      verificationProfileSha256: verificationProfileFingerprint(standardVerificationProfile), verificationMaxAgeSeconds: 60,
      rolloutCheckSha256: options.rolloutCheck ? fingerprintRolloutCheck(rolloutCheckFixture) : sha256('health verification'),
      recoveryPlanSha256: sha256('known release'), ...(options.rolloutCheck ? { rolloutCheck: rolloutCheckFixture } : {}),
      ...(options.komodo ? { komodo: komodoBinding } : {}),
    });
  }
  await registerReleaseTarget(database.storage, target);
  const portal = 'itervane-claim-portal';
  const owner = await verifyIdentity(await issuer.token('owner', { azp: portal }));
  const service = new FormalReleaseService(database.storage, portal);
  const verified = await taskService.get(identity, task.id);
  expect(verified.state).toBe('waiting_input');
  if (options.expiring) {
    // Exercise expiry below the runtime's five-second statement timeout even on a fast database.
    await adjustFixtureVerification("UPDATE itervane.formal_verification_results SET created_at=clock_timestamp()-interval '57 seconds'");
  }
  const frozen = (await service.freeze(requester, task.id, { environmentId: target.environmentId, expectedVersion: verified.version }, 'zh-CN')).candidate;
  const releaseTarget = target;
  async function confirm() {
    const approval = (await service.decide(owner, frozen.id, {
      action: 'confirm', fingerprint: frozen.fingerprint, expectedVersion: 0, idempotencyKey: randomUUID(),
    }, 'zh-CN')).candidate;
    if (!approval.operationId) throw new Error('Expected formal release operation');
    return { approval, operationId: approval.operationId, target: releaseTarget, owner, service, taskService };
  }
  return { confirm, candidateId: frozen.id };
}

async function queuedFormalRelease(options?: Parameters<typeof preparedFormalRelease>[0]) {
  return (await preparedFormalRelease(options)).confirm();
}

async function fetchFormalWakeup() {
  return vi.waitFor(async () => {
    const [job] = await database.storage.boss.fetch(formalReleaseQueue, { includeMetadata: true });
    if (!job) throw new Error('Waiting for formal release wakeup');
    return job;
  }, { timeout: 5_000, interval: 40 });
}

async function readOperation(operationId: string) {
  const [row] = await database.storage.db.select().from(releaseOperations).where(eq(releaseOperations.id, operationId));
  if (!row) throw new Error('Expected a durable release operation');
  return row;
}

function standardRegistryProof({ archive, manifestDigest, configDigest }: FormalReleaseManifest['image']) {
  return { registryOrigin: releaseOrigin, repository: 'testing/standard', archive, manifestDigest, configDigest,
    reference: `registry.example.invalid/testing/standard@${manifestDigest}` };
}

it('claims one formal release atomically, proves its scope and yields the same operation with a fresh wakeup', async () => {
  const { approval, operationId, target, owner, service, taskService } = await queuedFormalRelease();
  const releases = new FormalReleaseCoordinator(coordinator, releaseOrigin);
  const first = await fetchFormalWakeup();
  const replay = await database.storage.boss.send(formalReleaseQueue, { operationId });
  const stray = await fetchFormalWakeup();
  expect(stray.id).toBe(replay);
  expect(await releases.claim(stray, randomUUID())).toBeNull();
  expect(await releases.claim({ ...first, data: { operationId: randomUUID() } }, randomUUID())).toBeNull();
  expect(await releases.claim({ ...first, retryCount: first.retryCount + 1 }, randomUUID())).toBeNull();
  expect(await releases.claim({ ...first, name: queueName }, randomUUID())).toBeNull();

  await database.admin.query("ALTER TABLE itervane.task_events ADD CONSTRAINT injected_claim_failure CHECK(type <> 'task.release_claimed') NOT VALID");
  try { await expect(releases.claim(first, randomUUID())).rejects.toMatchObject({ cause: { code: '23514' } }); }
  finally { await database.admin.query('ALTER TABLE itervane.task_events DROP CONSTRAINT injected_claim_failure'); }
  expect(await readOperation(operationId)).toMatchObject({ state: 'queued', wakeupJobId: first.id });
  expect((await database.storage.boss.findJobs(formalReleaseQueue, { id: first.id }))[0]?.state).toBe('active');
  expect(await taskService.get(identity, task.id)).toMatchObject({ state: 'queued' });

  const results = await Promise.all([releases.claim(first, randomUUID()), releases.claim(first, randomUUID())]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const scope = results.find(item => item !== null)!;
  expect(scope).toMatchObject({ operationId, taskId: task.id, runId: task.runId, decisionVersion: 1,
    candidateId: approval.id, fingerprint: approval.fingerprint });
  expect(await readOperation(operationId)).toMatchObject({ state: 'dispatching', wakeupJobId: null });
  expect(await releases.authorize(scope)).toMatchObject({
    mapping: target, manifest: approval.manifest, archiveVerification: { archive: approval.manifest.image.archive },
  });
  expect(await releases.heartbeat(scope)).toBe(true);
  await expect(releases.authorize({ ...scope, operationId: randomUUID() })).rejects.toBeInstanceOf(ExecutionLost);
  await expect(coordinator.withLease(scope, async () => true)).rejects.toBeInstanceOf(ExecutionLost);
  await expect(registerReleaseTarget(database.storage, { ...target, registryOrigin: 'https://changed.invalid' }))
    .rejects.toMatchObject({ code: 'conflict' });
  expect(await service.getView(owner, task.id, 'zh-CN')).toMatchObject({ actions: [],
    candidate: { status: 'confirmed', operationId, message: /预留执行权/ } });
  expect(await service.getView(owner, task.id, 'en')).toMatchObject({ actions: [],
    candidate: { status: 'confirmed', message: /reserved execution/ } });

  await releases.yieldClaim(scope);
  const yielded = await readOperation(operationId);
  expect(yielded).toMatchObject({ id: operationId, state: 'queued' });
  expect(yielded.wakeupJobId).not.toBe(first.id);
  expect(await releases.claim(first, randomUUID())).toBeNull();
  await expect(releases.authorize(scope)).rejects.toBeInstanceOf(ExecutionLost);
  expect((await taskService.events(identity, task.id, 50, 'zh-CN')).at(-1))
    .toMatchObject({ type: 'task.release_requeued', state: 'queued' });
});

it('uses the same global slot as source work and recovers a release without a source wakeup', async () => {
  const { operationId, taskService } = await queuedFormalRelease();
  const release = new FormalReleaseCoordinator(coordinator, releaseOrigin);
  const companion = (await taskService.admit(identity, { projectId: task.projectId, source: task.source,
    purpose: 'Competing source work', dataClass: 'synthetic', locale: 'en', idempotencyKey: randomUUID() })).task;
  const source = await claim();
  expect(source.taskId).toBe(companion.id);
  const first = await fetchFormalWakeup();
  expect(await release.claim(first, randomUUID())).toBeNull();
  expect(await readOperation(operationId)).toMatchObject({ state: 'queued' });
  expect((await readOperation(operationId)).wakeupJobId).not.toBe(first.id);
  await coordinator.stop(source, 'execution_error');

  const next = await fetchFormalWakeup();
  const scope = await release.claim(next, randomUUID());
  if (!scope) throw new Error('Expected a release lease');
  await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
  await expect(release.heartbeat(scope)).rejects.toBeInstanceOf(ExecutionLost);
  await coordinator.reconcile(randomUUID());
  const recovered = await fetchFormalWakeup();
  expect(recovered.id).not.toBe(next.id);
  expect(recovered.data).toEqual({ operationId });
  expect((await database.storage.db.select().from(taskRuns).where(eq(taskRuns.id, scope.runId)))[0]?.wakeupJobId).toBeNull();
  expect((await taskService.events(identity, task.id, 50, 'en')).at(-1))
    .toMatchObject({ type: 'task.recovered', reason: 'lease_expired' });
  const adopted = await release.claim(recovered, randomUUID());
  if (!adopted) throw new Error('Expected the replacement release lease');
  expect(adopted.fence).toBeGreaterThan(scope.fence);
  const current = await taskService.get(identity, task.id);
  expect(await taskService.cancel(identity, task.id, { expectedVersion: current.version })).toMatchObject({ state: 'cancel_requested' });
  expect(await release.heartbeat(adopted)).toBe(false);
  await expect(release.authorize(adopted)).rejects.toBeInstanceOf(ExecutionLost);
  await release.yieldClaim(adopted);
  expect(await readOperation(operationId)).toMatchObject({ state: 'blocked', wakeupJobId: null });
  expect(await taskService.get(identity, task.id)).toMatchObject({ state: 'cancelled' });
  expect(await database.storage.boss.fetch(formalReleaseQueue)).toEqual([]);
});

it('repairs an abandoned formal wakeup before claim and keeps the old delivery stale', async () => {
  const { operationId } = await queuedFormalRelease();
  const release = new FormalReleaseCoordinator(coordinator, releaseOrigin);
  const first = await fetchFormalWakeup();
  await release.reconcile(randomUUID());
  expect(await readOperation(operationId)).toMatchObject({ state: 'queued', wakeupJobId: first.id });
  await database.admin.query("UPDATE itervane_queue.job SET started_on=clock_timestamp()-interval '11 seconds' WHERE id=$1 AND name=$2",
    [first.id, formalReleaseQueue]);
  await release.reconcile(randomUUID());
  const next = await fetchFormalWakeup();
  expect(next.id).not.toBe(first.id);
  expect(next.data).toEqual({ operationId });
  expect(await release.claim(first, randomUUID())).toBeNull();
  expect(await release.claim(next, randomUUID())).toMatchObject({ operationId });
});

it('waits for an environment already held by another release operation', async () => {
  const { approval, operationId, owner } = await queuedFormalRelease();
  const fixtureTask = randomUUID();
  const fixtureRun = randomUUID();
  const { manifest } = approval;
  await database.storage.db.insert(taskRecords).values({
    id: fixtureTask, projectId: task.projectId, repositoryId: task.source.repositoryId, requestedBy: task.requestedBy,
    commit: task.source.commit, purpose: 'Earlier fixture release', dataClass: 'synthetic',
    requestKey: randomUUID(), requestHash: sha256(fixtureTask), state: 'waiting_approval',
  });
  await database.storage.db.insert(taskRuns).values({ id: fixtureRun, taskId: fixtureTask, generation: 1, role: 'verify', state: 'waiting_approval' });
  const oldManifest = fixtureReleaseManifestSchema.parse({
    version: 1, origin: 'trusted_fixture', releaseEligible: false, taskId: fixtureTask, runId: fixtureRun, projectId: task.projectId,
    evidenceVersion: 1, generation: 1, source: manifest.source, originalSnapshotSha256: manifest.originalSnapshotSha256,
    repairedSnapshotSha256: manifest.repairedSnapshotSha256, diffSha256: manifest.diffSha256,
    templateSetSha256: sha256('earlier templates'), ruleSetSha256: manifest.verification.catalogSha256,
    verificationProfileSha256: manifest.verification.profileSha256, imageDigest: manifest.image.manifestDigest,
    checks: { rescanSha256: manifest.verification.receiptSha256, baselineSha256: manifest.verification.baselineSha256,
      targetedSha256: manifest.verification.buildSha256, imageScanSha256: manifest.image.scanReportSha256 },
    target: { applicationId: manifest.target.applicationId, environmentId: manifest.target.environmentId, mappingSha256: manifest.target.mappingSha256 },
    runtimeConfigSha256: manifest.runtimeConfigSha256, rolloutCheckSha256: manifest.rolloutCheckSha256,
    recoveryPlanSha256: manifest.recoveryPlanSha256, validUntil: manifest.validUntil,
  });
  const fixtures = new ReleaseCandidateService(database.storage,
    { readCurrent: async (_tx, binding) => binding.taskId === fixtureTask ? oldManifest : null }, 'itervane-claim-portal');
  const frozen = await fixtures.freeze(fixtureTask);
  const previous = await fixtures.decide(owner, frozen.id, {
    action: 'confirm', fingerprint: frozen.fingerprint, expectedVersion: 0, idempotencyKey: randomUUID(),
  });
  const rehearsal = new ReleaseRehearsal(database.storage, fixtures, {
    readCurrent: async (_tx, binding) => ({ ...binding, version: 1, origin: 'trusted_fixture',
      downstreamId: 'existing-fixture-release', healthy: true, accessProtected: true }),
  });
  expect(await rehearsal.reserve({ id: previous.operationId, data: { operationId: previous.operationId } })).toMatchObject({ outcome: 'reserved' });
  const release = new FormalReleaseCoordinator(coordinator, releaseOrigin);
  const first = await fetchFormalWakeup();
  expect(await release.claim(first, randomUUID())).toBeNull();
  expect(await readOperation(operationId)).toMatchObject({ id: operationId, state: 'queued' });
  expect((await database.admin.query('SELECT task_id FROM itervane.execution_slot')).rows[0]).toEqual({ task_id: null });
  expect(await rehearsal.reconcile(previous.operationId)).toMatchObject({ state: 'verified_fixture' });
  expect(await release.claim(await fetchFormalWakeup(), randomUUID())).toMatchObject({ operationId });
});

it.each([
  ['target revision', 'release_target_changed'],
  ['Komodo binding', 'release_target_changed'],
  ['worker origin', 'release_target_changed'],
  ['approver regrant', 'release_approval_invalid'],
  ['requester access', 'permission_revoked'],
  ['verification proof', 'release_evidence_changed'],
] as const)('blocks formal release when %s no longer matches the approval', async (change, reason) => {
  const { approval, operationId, target, taskService } = await queuedFormalRelease({
    separateRequester: change === 'requester access', rolloutCheck: change === 'target revision',
  });
  if (change === 'target revision') {
    const original = await registerReleaseTarget(database.storage, target);
    expect(original.revision).toBe(1);
    expect(approval.manifest.rolloutCheckSha256).toBe(fingerprintRolloutCheck(rolloutCheckFixture));
    const changed = { ...rolloutCheckFixture, origin: 'https://updated.example.invalid',
      probeIdentity: { ...rolloutCheckFixture.probeIdentity, clientId: 'new-probe' } };
    await expect(registerReleaseTarget(database.storage, { ...target, rolloutCheck: changed })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await registerReleaseTarget(database.storage, target)).toEqual(original);
    const updated = await registerReleaseTarget(database.storage, { ...target, rolloutCheck: changed, rolloutCheckSha256: fingerprintRolloutCheck(changed) });
    expect(updated).toMatchObject({ revision: 2 });
    expect(updated.fingerprint).not.toBe(original.fingerprint);
  }
  if (change === 'Komodo binding') {
    const original = await registerReleaseTarget(database.storage, target);
    expect(original.revision).toBe(1);
    const komodo = { origin: 'https://komodo.example.invalid', actorId: 'd'.repeat(24) };
    const revision = await registerReleaseTarget(database.storage, { ...target, komodo });
    expect(revision.revision).toBe(2);
    expect(revision.fingerprint).not.toBe(original.fingerprint);
    expect(await registerReleaseTarget(database.storage, { ...target, komodo: { ...komodo, origin: 'https://KOMODO.example.invalid:443/' } }))
      .toEqual(revision);
    expect(await registerReleaseTarget(database.storage, { ...target, komodo: { ...komodo, actorId: 'e'.repeat(24) } }))
      .toMatchObject({ revision: 3 });
  }
  if (change === 'approver regrant') {
    const [removed] = await database.storage.db.delete(workspaceMembers).returning();
    await database.storage.db.insert(workspaceMembers).values({ principalId: removed!.principalId, workspaceId: removed!.workspaceId });
  }
  if (change === 'requester access') await database.storage.db.delete(projectMembers);
  if (change === 'verification proof') {
    const [original] = await database.storage.db.select().from(formalVerificationResults);
    const changed = formalVerificationResultSchema.parse({ ...original!.document,
      provider: original!.document.provider === 'anthropic' ? 'openai' : 'anthropic' });
    const document = JSON.stringify(changed);
    await adjustFixtureVerification('UPDATE itervane.formal_verification_results SET sha256=$1, document=$2 WHERE run_id=$3',
      [sha256(document), document, original!.runId]);
  }
  const coordinatorOrigin = change === 'worker origin' ? 'https://other-registry.invalid' : releaseOrigin;
  const release = new FormalReleaseCoordinator(coordinator, coordinatorOrigin);
  expect(await release.claim(await fetchFormalWakeup(), randomUUID())).toBeNull();
  expect(await readOperation(operationId)).toMatchObject({ state: 'blocked', wakeupJobId: null });
  expect((await taskService.events(identity, task.id, 50, 'zh-CN')).at(-1))
    .toMatchObject({ type: 'task.release_blocked', reason, state: 'needs_human' });
  expect((await database.admin.query('SELECT task_id FROM itervane.execution_slot')).rows[0]).toEqual({ task_id: null });
});

it('checks approval expiry on the database clock after waiting for the environment lock', async () => {
  const { approval, operationId, target, taskService } = await queuedFormalRelease({ expiring: true });
  const release = new FormalReleaseCoordinator(coordinator, releaseOrigin);
  const job = await fetchFormalWakeup();
  const held = await database.admin.connect();
  const worker = randomUUID();
  try {
    await held.query('BEGIN');
    await held.query('SELECT id FROM itervane.environments WHERE id=$1 FOR UPDATE', [target.environmentId]);
    const claiming = release.claim(job, worker);
    try {
      await vi.waitFor(async () => {
        const { rows: [status] } = await held.query(`SELECT EXISTS (
          SELECT FROM pg_locks WHERE NOT granted AND pg_backend_pid() = ANY(pg_blocking_pids(pid))
        ) AS blocked, clock_timestamp() < $1::timestamptz AS live`, [approval.manifest.validUntil]);
        expect(status).toEqual({ blocked: true, live: true });
      }, { interval: 30, timeout: 2_500 });
      await held.query('SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp())) + 0.05))',
        [approval.manifest.validUntil]);
    } finally {
      await held.query('ROLLBACK');
      await expect(claiming).resolves.toBeNull();
    }
  } finally { held.release(); }
  expect(await readOperation(operationId)).toMatchObject({ state: 'blocked', wakeupJobId: null });
  expect((await taskService.events(identity, task.id, 50, 'en')).at(-1)).toMatchObject({
    type: 'task.release_blocked', reason: 'release_approval_invalid', state: 'needs_human', workerId: worker,
  });
});

it('records a fence-bound archive proof and only one registry intent, then confirms the same bounded observation', async () => {
  const { approval, operationId, taskService } = await queuedFormalRelease();
  const release = new FormalReleaseCoordinator(coordinator, releaseOrigin);
  const steps = new FormalReleaseSteps(release);
  const initial = await release.claim(await fetchFormalWakeup(), randomUUID());
  if (!initial) throw new Error('Expected an approved lease');
  const insertRegistry = (preparedFence: number, preparedBy: string) => database.storage.db.insert(formalReleaseSteps).values({
    operationId, kind: 'registry', preparedFence, preparedBy,
  });
  await expect(insertRegistry(initial.fence, initial.workerId))
    .rejects.toMatchObject({ cause: { code: '23514', message: 'formal_release_archive_required' } });
  const archive = await steps.prepareArchive(initial);
  await steps.confirmArchive(initial, archive);
  await release.yieldClaim(initial);
  const scope = await release.claim(await fetchFormalWakeup(), randomUUID());
  if (!scope) throw new Error('Expected a replacement lease');
  expect(scope.fence).toBeGreaterThan(initial.fence);
  await expect(steps.confirmArchive(initial, archive)).rejects.toBeInstanceOf(ExecutionLost);
  await expect(steps.prepareRegistry(scope)).rejects.toMatchObject({ code: 'unsupported_state' });
  await expect(insertRegistry(scope.fence, scope.workerId))
    .rejects.toMatchObject({ cause: { code: '23514', message: 'formal_release_archive_required' } });
  expect(await steps.prepareArchive(scope)).toEqual(archive);
  expect(await steps.prepareArchive(scope)).toEqual(archive);
  await expect(steps.confirmArchive(scope, { ...archive, archive: { ...archive.archive, sha256: sha256('different archive') } }))
    .rejects.toMatchObject({ code: 'conflict' });
  await steps.confirmArchive(scope, archive);
  await steps.confirmArchive(scope, archive);
  await expect(insertRegistry(initial.fence, initial.workerId))
    .rejects.toMatchObject({ cause: { code: '23514', message: 'formal_release_step_authority' } });
  const competing = await Promise.allSettled([steps.prepareRegistry(scope), steps.prepareRegistry(scope)]);
  expect(competing.map(item => item.status).sort()).toEqual(['fulfilled', 'rejected']);
  await expect(release.yieldClaim(scope)).rejects.toMatchObject({ code: 'unsupported_state' });
  expect(await readOperation(operationId)).toMatchObject({ state: 'dispatching', wakeupJobId: null });
  const proof = standardRegistryProof(approval.manifest.image);
  await expect(release.authorizeRegistryWrite(scope)).resolves.toBeUndefined();
  await expect(steps.confirmRegistry({ ...scope, operationId: randomUUID() }, proof)).rejects.toBeInstanceOf(ExecutionLost);
  await expect(steps.confirmRegistry(scope, { ...proof, configDigest: `sha256:${sha256('different registry config')}` }))
    .rejects.toMatchObject({ code: 'conflict' });
  expect(await steps.readRegistryProof(scope)).toBeNull();
  const persistedRegistry = and(eq(formalReleaseSteps.operationId, operationId), eq(formalReleaseSteps.kind, 'registry'));
  await expect(database.storage.db.update(formalReleaseSteps).set({
    state: 'confirmed', proof: { ...proof, repository: 'testing/other' },
    settledFence: scope.fence, settledBy: scope.workerId, settledAt: sql`clock_timestamp()`,
  }).where(persistedRegistry)).rejects.toMatchObject({ cause: { code: '23514', message: 'formal_release_step_proof_mismatch' } });

  const latest = await taskService.get(identity, task.id);
  await taskService.cancel(identity, task.id, { expectedVersion: latest.version });
  await expect(release.authorize(scope)).rejects.toBeInstanceOf(ExecutionLost);
  expect(await steps.confirmRegistry(scope, proof)).toEqual(proof);
  expect(await steps.confirmRegistry(scope, proof)).toEqual(proof);
  expect(await steps.readRegistryProof(scope)).toEqual(proof);
  expect((await database.storage.db.select().from(formalReleaseSteps).where(persistedRegistry))[0])
    .toMatchObject({ state: 'confirmed', preparedFence: scope.fence, settledFence: scope.fence, proof });
  await expect(database.storage.db.delete(formalReleaseSteps).where(persistedRegistry))
    .rejects.toMatchObject({ cause: { code: '23514', message: 'formal_release_step_is_immutable' } });
  expect(await taskService.get(identity, task.id)).toMatchObject({ state: 'cancel_requested' });
  const events = await taskService.events(identity, task.id, 50, 'zh-CN');
  expect(events.filter(event => event.type === 'task.release_registry_prepared')).toHaveLength(1);
  expect(events.filter(event => event.type === 'task.release_registry_confirmed')).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ state: 'cancel_requested', message: /独立核对获批镜像/ });
});

it('requeues an expired registry intent for readback while retaining the environment and cancellation', async () => {
  const { operationId, target, taskService, approval } = await queuedFormalRelease();
  const release = new FormalReleaseCoordinator(coordinator, releaseOrigin);
  const steps = new FormalReleaseSteps(release);
  const initial = await fetchFormalWakeup();
  const scope = await release.claim(initial, randomUUID());
  if (!scope) throw new Error('Expected an approved lease');
  const archive = await steps.prepareArchive(scope);
  await steps.confirmArchive(scope, archive);
  await steps.prepareRegistry(scope);
  const current = await taskService.get(identity, task.id);
  await taskService.cancel(identity, task.id, { expectedVersion: current.version });
  await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
  await coordinator.reconcile(randomUUID());
  const recovered = await readOperation(operationId);
  expect(recovered).toMatchObject({ state: 'reconciling', id: operationId });
  expect(recovered.wakeupJobId).toBeTruthy();
  expect(recovered.wakeupJobId).not.toBe(initial.id);
  expect((await database.storage.boss.findJobs(formalReleaseQueue, { id: recovered.wakeupJobId! }))[0])
    .toMatchObject({ state: 'created', data: { operationId } });
  expect(await database.storage.boss.fetch(queueName)).toEqual([]);
  expect((await database.storage.db.select().from(formalReleaseSteps).where(eq(formalReleaseSteps.kind, 'registry')))[0])
    .toMatchObject({ operationId, state: 'prepared', preparedFence: scope.fence, proof: null });
  await expect(steps.readRegistryProof(scope)).rejects.toBeInstanceOf(ExecutionLost);
  await expect(registerReleaseTarget(database.storage, { ...target, runtimeConfigSha256: sha256('new configuration') }))
    .rejects.toMatchObject({ code: 'conflict' });
  expect((await database.admin.query('SELECT task_id FROM itervane.execution_slot')).rows[0]).toEqual({ task_id: null });
  expect((await taskService.events(identity, task.id, 50, 'en')).at(-1))
    .toMatchObject({ type: 'task.release_registry_recovered', state: 'cancel_requested', reason: 'lease_expired' });
  const [oldGrant] = (await database.admin.query('DELETE FROM itervane.workspace_members RETURNING workspace_id, principal_id')).rows;
  const recovery = await release.claim(await fetchFormalWakeup(), randomUUID());
  if (!recovery) throw new Error('Expected a read-only recovery lease');
  expect(recovery).toMatchObject({ operationId, mode: 'registry_recovery', candidateId: approval.id });
  expect(recovery.fence).toBeGreaterThan(scope.fence);
  await expect(release.authorizeRegistryWrite(recovery)).rejects.toBeInstanceOf(ExecutionLost);
  await expect(release.authorizeRegistryWrite(scope)).rejects.toBeInstanceOf(ExecutionLost);
  await expect(release.heartbeatRegistryObservation(recovery)).resolves.toBe(true);
  const proof = standardRegistryProof(approval.manifest.image);
  expect(await steps.confirmRegistry(recovery, proof)).toEqual(proof);
  expect(await release.settleRegistryCancellation(recovery)).toBe(true);
  expect(await readOperation(operationId)).toMatchObject({ state: 'blocked', wakeupJobId: null });
  await expect(steps.readRegistryProof(recovery)).rejects.toBeInstanceOf(ExecutionLost);
  expect((await database.storage.db.select().from(formalReleaseSteps).where(eq(formalReleaseSteps.kind, 'registry')))[0])
    .toMatchObject({ state: 'confirmed', preparedFence: scope.fence, settledFence: recovery.fence, proof });
  await database.admin.query('INSERT INTO itervane.workspace_members(workspace_id, principal_id) VALUES ($1, $2)',
    [oldGrant.workspace_id, oldGrant.principal_id]);
  expect(await taskService.get(identity, task.id)).toMatchObject({ state: 'cancelled' });
  expect(await database.storage.boss.fetch(formalReleaseQueue)).toEqual([]);
});

it('bounds registry recovery to three claims and preserves a held unknown result across mismatches and cancellation', async () => {
  const { operationId, target, taskService, approval, owner, service } = await queuedFormalRelease();
  const publish = vi.fn<ReleaseRegistryPublisher['publish']>(async (_target, _image, _path, authorize) => {
    await authorize();
    throw new Error('simulated_lost_write_response');
  });
  const observe = vi.fn<ReleaseRegistryPublisher['observe']>()
    .mockImplementationOnce(async (_target, _image, authorize) => { await authorize(); return null; })
    .mockImplementationOnce(async (_target, _image, authorize) => {
      await authorize();
      return { ...standardRegistryProof(approval.manifest.image), configDigest: `sha256:${sha256('foreign configuration')}` };
    });
  const worker = new FormalReleaseWorker(database.storage, { origin: releaseOrigin, registry: { publish, observe }, runner: {
    async withRetainedArchive(_archive, authorize, use) {
      await authorize();
      return use('/trusted-fixture/approved.oci.tar');
    },
  } });
  const first = await worker.tick();
  expect(first).toMatchObject({ status: 'requeued', scope: { operationId, mode: 'import' } });
  const recoveryWorker = new FormalReleaseWorker(database.storage, { origin: releaseOrigin, registry: { publish, observe } });
  const changedWorker = new FormalReleaseWorker(database.storage, { origin: 'https://other.example.invalid', registry: { publish, observe } });
  const runWhenDue = (worker: FormalReleaseWorker) => vi.waitFor(async () => {
    const result = await worker.tick();
    if (result.status === 'idle') throw new Error('Expected a delayed read-only wakeup');
    return result;
  }, { timeout: 5000, interval: 60 });
  expect(await runWhenDue(changedWorker)).toMatchObject({ status: 'requeued', scope: { mode: 'registry_recovery' } });
  expect(observe).toHaveBeenCalledTimes(0);
  expect(await runWhenDue(recoveryWorker)).toMatchObject({ status: 'requeued', scope: { mode: 'registry_recovery' } });
  expect((await service.getView(owner, task.id, 'zh-CN')).candidate?.message).toMatch(/独立核对/);
  const current = await taskService.get(identity, task.id);
  expect(current.state).toBe('reconciling');
  await taskService.cancel(identity, task.id, { expectedVersion: current.version });
  expect(await runWhenDue(recoveryWorker)).toMatchObject({ status: 'manual_review', scope: { mode: 'registry_recovery' } });
  expect(await recoveryWorker.tick()).toEqual({ status: 'idle' });
  expect(publish).toHaveBeenCalledTimes(1);
  expect(observe).toHaveBeenCalledTimes(2);
  expect(await readOperation(operationId)).toMatchObject({ state: 'reconciling', wakeupJobId: null });
  expect((await database.storage.db.select().from(formalReleaseSteps).where(eq(formalReleaseSteps.kind, 'registry')))[0])
    .toMatchObject({ state: 'uncertain', proof: null });
  await expect(registerReleaseTarget(database.storage, { ...target, runtimeConfigSha256: sha256('still held') }))
    .rejects.toMatchObject({ code: 'conflict' });
  const events = await taskService.events(identity, task.id, 50, 'en');
  expect(events.filter(event => event.type === 'task.release_registry_recheck_started')).toHaveLength(3);
  expect(events.some(event => event.reason === 'release_target_changed')).toBe(true);
  expect(events.some(event => event.reason === 'release_registry_missing')).toBe(true);
  expect(events.at(-1)).toMatchObject({ type: 'task.release_registry_manual_review', state: 'cancel_requested', reason: 'release_registry_unavailable' });
});

it('requires this lease to recheck Registry before making a previously confirmed proof available', async () => {
  const { operationId, approval, target } = await queuedFormalRelease({ komodo: true });
  const release = new FormalReleaseCoordinator(coordinator, releaseOrigin);
  const steps = new FormalReleaseSteps(release);
  const first = await release.claim(await fetchFormalWakeup(), randomUUID());
  if (!first) throw new Error('Expected the original release claim');
  await steps.confirmArchive(first, await steps.prepareArchive(first));
  await steps.prepareRegistry(first);
  const proof = standardRegistryProof(approval.manifest.image);
  await steps.confirmRegistry(first, proof);
  expect(await steps.readRegistryProof(first)).toEqual(proof);

  await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
  await release.reconcile(randomUUID());
  const recovery = await release.claim(await fetchFormalWakeup(), randomUUID());
  if (!recovery) throw new Error('Expected the Registry observation claim');
  expect(recovery).toMatchObject({ operationId, mode: 'registry_recovery' });
  expect(recovery.fence).toBeGreaterThan(first.fence);
  await expect(steps.readRegistryProof(first)).rejects.toBeInstanceOf(ExecutionLost);
  expect(await steps.readRegistryProof(recovery)).toBeNull();
  await steps.confirmRegistry(recovery, proof);
  expect(await steps.readRegistryProof(recovery)).toEqual(proof);
  await expect(release.authorizeRegistryWrite(recovery)).rejects.toBeInstanceOf(ExecutionLost);
  await expect(new FormalKomodoSteps(release).prepareConfiguration(recovery, {
    deploymentId: target.deploymentId, serverId: target.serverId, runtimeConfigSha256: target.runtimeConfigSha256, imageReference: '',
  })).rejects.toBeInstanceOf(ExecutionLost);
  expect((await database.storage.db.select().from(formalReleaseSteps).where(eq(formalReleaseSteps.kind, 'registry')))[0])
    .toMatchObject({ state: 'confirmed', preparedFence: first.fence, settledFence: first.fence, proof });
});

it('records one Komodo configuration and dispatch with separately bound observations', async () => {
  const { approval, operationId, target, owner, service, taskService } = await queuedFormalRelease({ komodo: true, separateRequester: true });
  const release = new FormalReleaseCoordinator(coordinator, releaseOrigin);
  const registry = new FormalReleaseSteps(release);
  const komodo = new FormalKomodoSteps(release);
  const scope = await release.claim(await fetchFormalWakeup(), randomUUID());
  if (!scope) throw new Error('Expected a formal release claim');
  const image = standardRegistryProof(approval.manifest.image);
  const configuration = {
    deploymentId: target.deploymentId, serverId: target.serverId, runtimeConfigSha256: target.runtimeConfigSha256,
    imageReference: 'registry.example.invalid/testing/standard:previous',
  };
  const approvedConfiguration = { ...configuration, imageReference: image.reference };
  const { revision, mappingSha256 } = approval.manifest.target;
  const storedIntent = { ...komodoBinding, revision, mappingSha256, ...approvedConfiguration,
    previousImageSha256: sha256(configuration.imageReference) };
  const insert = (kind: 'komodo_config' | 'komodo_dispatch', raw = storedIntent) =>
    database.storage.db.insert(formalReleaseSteps).values({
      operationId, kind, preparedFence: scope.fence, preparedBy: scope.workerId, intent: raw,
    });
  await expect(komodo.prepareConfiguration(scope, configuration)).rejects.toMatchObject({ code: 'unsupported_state' });
  await expect(insert('komodo_config')).rejects.toMatchObject({ cause: { code: '23514', message: 'formal_release_step_authority' } });
  const archive = await registry.prepareArchive(scope);
  await registry.confirmArchive(scope, archive);
  await registry.prepareRegistry(scope);
  await registry.confirmRegistry(scope, image);

  await expect(insert('komodo_config', { ...storedIntent, actorId: 'f'.repeat(24) }))
    .rejects.toMatchObject({ cause: { code: '23514', message: 'formal_release_step_intent_mismatch' } });
  await expect(komodo.prepareConfiguration(scope, { ...configuration, serverId: 'f'.repeat(24) }))
    .rejects.toMatchObject({ code: 'conflict' });
  const preparations = await Promise.allSettled([
    komodo.prepareConfiguration(scope, configuration), komodo.prepareConfiguration(scope, configuration),
  ]);
  expect(preparations.filter(result => result.status === 'fulfilled')).toEqual([{
    status: 'fulfilled', value: { target: expect.objectContaining({ komodo: komodoBinding }),
      previousImage: configuration.imageReference, manifestDigest: image.manifestDigest },
  }]);
  await expect(komodo.prepareDispatch(scope)).rejects.toMatchObject({ code: 'unsupported_state' });
  await expect(insert('komodo_dispatch')).rejects.toMatchObject({ cause: { code: '23514', message: 'formal_release_step_authority' } });
  await expect(komodo.authorizeWrite({ ...scope, fence: scope.fence - 1 }, 'komodo_config')).rejects.toBeInstanceOf(ExecutionLost);
  await expect(komodo.authorizeWrite(scope, 'komodo_config')).resolves.toBeUndefined();
  await expect(komodo.confirmConfiguration(scope, configuration)).rejects.toMatchObject({ code: 'conflict' });
  await expect(database.storage.db.update(formalReleaseSteps).set({
    state: 'confirmed', proof: configuration, settledFence: scope.fence, settledBy: scope.workerId, settledAt: sql`clock_timestamp()`,
  }).where(eq(formalReleaseSteps.kind, 'komodo_config')))
    .rejects.toMatchObject({ cause: { code: '23514', message: 'formal_release_step_proof_mismatch' } });
  expect(await komodo.confirmConfiguration(scope, approvedConfiguration)).toEqual(approvedConfiguration);
  await expect(komodo.authorizeWrite(scope, 'komodo_config')).rejects.toBeInstanceOf(ExecutionLost);
  expect(await komodo.prepareDispatch(scope)).toMatchObject({ target: { komodo: komodoBinding }, manifestDigest: image.manifestDigest });
  await expect(komodo.prepareDispatch(scope)).rejects.toMatchObject({ code: 'unsupported_state' });
  const update = { updateId: 'e'.repeat(24), actorId: komodoBinding.actorId,
    deploymentId: target.deploymentId, status: 'Queued', success: false };
  await expect(komodo.recordUpdate(scope, { ...update, deploymentId: 'f'.repeat(24) })).rejects.toMatchObject({ code: 'conflict' });
  await expect(komodo.authorizeWrite(scope, 'komodo_dispatch')).resolves.toBeUndefined();
  expect(await service.getView(owner, task.id, 'zh-CN')).toMatchObject({ actions: [],
    candidate: { status: 'confirmed', operationId, message: /发送前记录/ } });

  const [removed] = await database.storage.db.delete(workspaceMembers).returning();
  await expect(komodo.authorizeWrite(scope, 'komodo_dispatch')).rejects.toMatchObject({ reason: 'release_approval_invalid' });
  expect(await komodo.recordUpdate(scope, update)).toBe(update.updateId);
  await expect(komodo.confirmDispatch(scope, update)).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(komodo.confirmDispatch(scope, { ...update, status: 'Complete', updateId: 'f'.repeat(24) }))
    .rejects.toMatchObject({ code: 'conflict' });
  await expect(database.storage.db.update(formalReleaseSteps).set({ externalUpdateId: 'f'.repeat(24) })
    .where(eq(formalReleaseSteps.kind, 'komodo_dispatch')))
    .rejects.toMatchObject({ cause: { code: '23514', message: 'formal_release_step_is_immutable' } });
  const terminal = { ...update, status: 'Complete', success: true };
  expect(await komodo.confirmDispatch(scope, terminal)).toEqual(terminal);
  expect(await readOperation(operationId)).toMatchObject({ state: 'dispatching', wakeupJobId: null, observation: null });
  const recorded = await database.storage.db.select().from(formalReleaseSteps);
  expect(recorded.filter(step => step.kind === 'komodo_config')).toMatchObject([
    { state: 'confirmed', intent: storedIntent, proof: approvedConfiguration, externalUpdateId: null },
  ]);
  expect(recorded.filter(step => step.kind === 'komodo_dispatch')).toMatchObject([
    { state: 'confirmed', intent: storedIntent, proof: terminal, externalUpdateId: update.updateId },
  ]);
  expect(JSON.stringify(recorded)).not.toContain(configuration.imageReference);
  await database.storage.db.insert(workspaceMembers).values({ principalId: removed!.principalId, workspaceId: removed!.workspaceId });
  const en = await taskService.events(identity, task.id, 50, 'en');
  const zh = await taskService.events(identity, task.id, 50, 'zh-CN');
  expect(en.slice(-5).map(event => event.type)).toEqual([
    'task.release_komodo_config_prepared', 'task.release_komodo_configured',
    'task.release_komodo_dispatch_prepared', 'task.release_komodo_update_recorded', 'task.release_komodo_dispatch_observed',
  ]);
  expect(en.at(-1)?.message).toMatch(/independent Komodo read/);
  expect(zh.at(-1)?.message).toMatch(/独立核对/);
});

async function parkForRollout({ approval, target }: Awaited<ReturnType<typeof queuedFormalRelease>>, success = true, updateId = 'e'.repeat(24)) {
  const release = new FormalReleaseCoordinator(coordinator, releaseOrigin);
  const registry = new FormalReleaseSteps(release);
  const importScope = await release.claim(await fetchFormalWakeup(), randomUUID());
  if (!importScope) throw new Error('Expected OCI import claim');
  await registry.confirmArchive(importScope, await registry.prepareArchive(importScope));
  const image = standardRegistryProof(approval.manifest.image);
  await registry.prepareRegistry(importScope);
  await registry.confirmRegistry(importScope, image);
  expect(await release.handoffKomodo(importScope)).toBe('komodo_ready');
  const writer = await release.claim(await fetchFormalWakeup(), randomUUID());
  if (writer?.mode !== 'komodo_write') throw new Error('Expected Komodo writer');
  const komodo = new FormalKomodoSteps(release);
  const configuration = { deploymentId: target.deploymentId, serverId: target.serverId,
    runtimeConfigSha256: target.runtimeConfigSha256, imageReference: image.reference };
  await komodo.prepareConfiguration(writer, { ...configuration, imageReference: '' });
  await komodo.authorizeWrite(writer, 'komodo_config');
  await komodo.confirmConfiguration(writer, configuration);
  await komodo.prepareDispatch(writer);
  await komodo.authorizeWrite(writer, 'komodo_dispatch');
  const update = { updateId, actorId: komodoBinding.actorId, deploymentId: target.deploymentId,
    status: 'Complete', success } as const;
  await komodo.recordUpdate(writer, { ...update, status: 'Queued', success: false });
  await komodo.confirmDispatch(writer, update);
  expect(await release.finishKomodo(writer)).toBe('awaiting_rollout');
  return { image, update, writer, komodo };
}

it('keeps formal release scheduled for the installed environment and blocks drift before any downstream call', async () => {
  const { approval, operationId, target } = await queuedFormalRelease({ komodo: true, rolloutCheck: true });
  const installed = { environmentId: target.environmentId, mappingSha256: approval.manifest.target.mappingSha256 };
  await expect(readInstalledReleaseTarget(database.storage, installed)).resolves.toMatchObject({
    environmentId: target.environmentId, komodo: komodoBinding, rolloutCheck: rolloutCheckFixture,
  });
  const registry = { publish: vi.fn(), observe: vi.fn() };
  const runner = { withRetainedArchive: vi.fn() };
  const other = new FormalReleaseWorker(database.storage, {
    origin: releaseOrigin, registry, runner, installed: { ...installed, environmentId: randomUUID() },
  });
  const original = await readOperation(operationId);
  expect(await other.tick()).toMatchObject({ status: 'idle' });
  const waiting = await readOperation(operationId);
  expect(waiting).toMatchObject({ state: 'queued' });
  expect(waiting?.wakeupJobId).toBeTruthy();
  expect(waiting?.wakeupJobId).not.toBe(original?.wakeupJobId);

  await registerReleaseTarget(database.storage, { ...target, runtimeConfigSha256: sha256('new installer target') });
  await expect(readInstalledReleaseTarget(database.storage, installed)).rejects.toThrow('release_installation_target');
  const matchingProcess = new FormalReleaseCoordinator(coordinator, releaseOrigin, installed);
  const [wake] = await database.storage.boss.findJobs(formalReleaseQueue, { id: waiting!.wakeupJobId! });
  if (!wake) throw new Error('Expected installation-scoped wakeup');
  await database.admin.query("SELECT pg_sleep_until($1::timestamptz + interval '20 milliseconds')", [wake.startAfter]);
  expect(await matchingProcess.claim(await fetchFormalWakeup(), randomUUID())).toBeNull();
  expect(await readOperation(operationId)).toMatchObject({ state: 'blocked', wakeupJobId: null });
  expect(runner.withRetainedArchive).not.toHaveBeenCalled();
  expect(registry.publish).not.toHaveBeenCalled();
  expect(registry.observe).not.toHaveBeenCalled();
});

it('scopes formal rollout observation to the installed environment and target fingerprint', async () => {
  const submitted = await queuedFormalRelease({ komodo: true, rolloutCheck: true });
  const installed = { environmentId: submitted.target.environmentId, mappingSha256: submitted.approval.manifest.target.mappingSha256 };
  await parkForRollout(submitted);
  const other = new FormalRolloutCoordinator(database.storage, releaseOrigin, undefined, { ...installed, mappingSha256: sha256('other target') });
  expect(await other.claimNext(randomUUID())).toBeNull();
  const observe = new FormalRolloutCoordinator(database.storage, releaseOrigin, undefined, installed);
  const scope = await observe.claimNext(randomUUID());
  if (!scope) throw new Error('Expected rollout lease from enrolled target');
  expect(scope.operationId).toBe(submitted.operationId);
  await expect(other.authorize(scope)).rejects.toMatchObject({ reason: 'release_target_changed' });
  await expect(observe.authorize(scope)).resolves.toMatchObject({ rolloutCheckSha256: submitted.target.rolloutCheckSha256 });
});

it('claims one formal rollout alongside a model workflow and keeps read authority after cancellation and grant removal', async () => {
  const submitted = await queuedFormalRelease({ komodo: true, rolloutCheck: true });
  const { operationId, target, taskService } = submitted;
  const { image, update, writer, komodo } = await parkForRollout(submitted);
  const other = (await taskService.admit(identity, { projectId: task.projectId, source: task.source,
    purpose: 'Independent workflow', dataClass: 'synthetic', idempotencyKey: randomUUID() })).task;
  const workflowJob = await vi.waitFor(async () => {
    const [job] = await database.storage.boss.fetch(queueName, { includeMetadata: true });
    if (!job) throw new Error('Expected independent workflow wakeup');
    return job;
  });
  const workflow = await coordinator.claim(workflowJob, randomUUID());
  expect(workflow).toMatchObject({ taskId: other.id });

  const observe = new FormalRolloutCoordinator(database.storage, releaseOrigin);
  await expect(new FormalRolloutCoordinator(database.storage, 'https://different.registry.invalid').claimNext(randomUUID()))
    .rejects.toMatchObject({ reason: 'release_target_changed' });
  const parallel = await Promise.all([observe.claimNext(randomUUID()), observe.claimNext(randomUUID())]);
  const leases = parallel.filter(lease => lease !== null);
  expect(leases).toHaveLength(1);
  const scope = leases[0]!;
  expect(scope).toMatchObject({ operationId, fence: 1 });
  await expect(observe.authorize({ ...scope, workerId: randomUUID() })).rejects.toBeInstanceOf(ExecutionLost);
  await expect(observe.authorize({ ...scope, operationId: randomUUID() })).rejects.toBeInstanceOf(ExecutionLost);
  await expect(observe.authorize(scope)).resolves.toMatchObject({
    manifest: submitted.approval.manifest, image, update, check: rolloutCheckFixture,
    target: { deploymentId: target.deploymentId, serverId: target.serverId, komodo: komodoBinding },
  });
  const current = await taskService.get(identity, task.id);
  expect(await taskService.cancel(identity, task.id, { expectedVersion: current.version })).toMatchObject({ state: 'cancel_requested' });
  const [removed] = await database.storage.db.delete(workspaceMembers).returning();
  await expect(observe.authorize(scope)).resolves.toMatchObject({ update });
  await expect(komodo.authorizeWrite(writer, 'komodo_dispatch')).rejects.toBeInstanceOf(ExecutionLost);
  await database.storage.db.insert(workspaceMembers).values({ principalId: removed!.principalId, workspaceId: removed!.workspaceId });
  const events = await taskService.events(identity, task.id, 50, 'zh-CN');
  expect(events.find(event => event.type === 'task.release_rollout_claimed')?.message).toMatch(/只读租约/);
  expect((await database.admin.query('SELECT task_id FROM itervane.execution_slot')).rows[0]).toEqual({ task_id: other.id });
  expect(await readOperation(operationId)).toMatchObject({ state: 'reconciling', wakeupJobId: null, observation: null });
});

it('durably fences formal rollout recovery and escalates after three expired observations', async () => {
  const submitted = await queuedFormalRelease({ komodo: true, rolloutCheck: true });
  const { operationId, taskService, target } = submitted;
  await parkForRollout(submitted);
  for (const fence of [1, 2, 3]) {
    const replacement = new FormalRolloutCoordinator(database.storage, releaseOrigin, 1);
    const scope = await replacement.claimNext(randomUUID());
    expect(scope).toMatchObject({ operationId, fence });
    if (!scope) throw new Error('Expected an observation attempt');
    await database.admin.query(`SELECT pg_sleep_until(lease_until + interval '20 milliseconds')
      FROM itervane.formal_release_rollout_attempts WHERE operation_id=$1 AND fence=$2`, [operationId, fence]);
    await expect(replacement.authorize(scope)).rejects.toBeInstanceOf(ExecutionLost);
  }
  const final = new FormalRolloutCoordinator(database.storage, releaseOrigin);
  expect(await final.claimNext(randomUUID())).toBeNull();
  expect(await final.claimNext(randomUUID())).toBeNull();
  const attempts = await database.storage.db.select().from(formalReleaseRolloutAttempts).orderBy(formalReleaseRolloutAttempts.fence);
  expect(attempts).toMatchObject([{ fence: 1, state: 'expired' }, { fence: 2, state: 'expired' }, { fence: 3, state: 'manual_review' }]);
  expect(new Set(attempts.map(attempt => attempt.workerId)).size).toBe(3);
  expect(await taskService.get(identity, task.id)).toMatchObject({ state: 'needs_human' });
  const [manual] = (await taskService.events(identity, task.id, 50, 'en')).filter(event => event.type === 'task.release_rollout_manual_review');
  expect(manual).toMatchObject({ reason: 'release_rollout_limit', message: /remains reserved/ });
  await expect(registerReleaseTarget(database.storage, { ...target, runtimeConfigSha256: sha256('changed') })).rejects.toMatchObject({ code: 'conflict' });
  expect(await readOperation(operationId)).toMatchObject({ state: 'reconciling', wakeupJobId: null, observation: null });
});

it('rejects direct formal rollout lease changes outside the recorded handoff and bounds', async () => {
  const submitted = await queuedFormalRelease({ komodo: true, rolloutCheck: true });
  const { operationId } = submitted;
  const observer = new FormalRolloutCoordinator(database.storage, releaseOrigin);
  const insert = (fence: number, seconds: number) => database.storage.pool.query(`INSERT
    INTO itervane.formal_release_rollout_attempts (operation_id, fence, worker_id, lease_until)
    VALUES ($1, $2, $3, clock_timestamp() + $4 * interval '1 second')`, [operationId, fence, randomUUID(), seconds]);
  expect(await observer.claimNext(randomUUID())).toBeNull();
  await expect(insert(1, 45)).rejects.toMatchObject({ code: '23514', message: 'formal_rollout_binding_required' });
  await parkForRollout(submitted);
  await expect(insert(2, 45)).rejects.toMatchObject({ code: '23514', message: 'formal_rollout_lease_required' });
  await expect(insert(1, 46)).rejects.toMatchObject({ code: '23514', message: 'formal_rollout_lease_required' });
  const rollback = new Error('rollback legacy lease probe');
  await expect(database.storage.db.transaction(async tx => {
    const legacy = await tx.execute<{ bounded: boolean }>(sql`INSERT
      INTO itervane.formal_release_rollout_attempts (operation_id, fence, worker_id, lease_until)
      VALUES (${operationId}, 1, ${randomUUID()}, clock_timestamp() + interval '45 seconds')
      RETURNING lease_until > created_at AND lease_until <= created_at + interval '45 seconds' AS bounded`);
    expect(legacy.rows[0]?.bounded).toBe(true);
    throw rollback;
  })).rejects.toBe(rollback);
  expect(await observer.claimNext(randomUUID())).toMatchObject({ operationId, fence: 1 });
  const lease = await database.storage.pool.query<{ exact: boolean }>(`SELECT lease_until - created_at = interval '45 seconds' AS exact
    FROM itervane.formal_release_rollout_attempts WHERE operation_id=$1`, [operationId]);
  expect(lease.rows[0]?.exact).toBe(true);
  await expect(insert(2, 45)).rejects.toMatchObject({ code: '23514', message: 'formal_rollout_lease_required' });
  await expect(database.storage.pool.query("UPDATE itervane.formal_release_rollout_attempts SET state='expired' WHERE operation_id=$1", [operationId]))
    .rejects.toMatchObject({ code: '23514', message: 'formal_rollout_attempt_is_immutable' });
  await expect(database.storage.pool.query('DELETE FROM itervane.formal_release_rollout_attempts WHERE operation_id=$1', [operationId]))
    .rejects.toMatchObject({ code: '23514', message: 'formal_rollout_attempt_is_immutable' });
});

function observedRuntime(binding: Awaited<ReturnType<FormalRolloutCoordinator['authorize']>>) {
  return { rolloutCheckSha256: binding.rolloutCheckSha256, containerId: sha256('running container'),
    configDigest: binding.image.configDigest, imageReference: binding.image.reference,
    runtimeConfigSha256: binding.target.runtimeConfigSha256, network: binding.check.network,
    anonymousStatus: 401 as const, healthStatus: 200 as const, version: 'standard-v2' };
}

async function finishTestRollout({ image, update }: Awaited<ReturnType<typeof parkForRollout>>, version?: string) {
  const observe = new FormalRolloutCoordinator(database.storage, releaseOrigin);
  const scope = await observe.claimNext(randomUUID());
  if (!scope) throw new Error('Expected formal rollout attempt');
  const binding = await observe.authorize(scope);
  const runtime = observedRuntime(binding);
  if (version) runtime.version = version;
  await observe.settle(scope, { version: 1, ...binding.decision, rolloutFence: scope.fence, generation: binding.manifest.generation,
    targetRevision: binding.manifest.target.revision, mappingSha256: binding.manifest.target.mappingSha256,
    manifestDigest: image.manifestDigest, update, runtime });
  return { binding, runtime, image, update };
}

async function installedOperationsFixture() {
  const submitted = await queuedFormalRelease({ komodo: true, rolloutCheck: true });
  const { binding, runtime, image } = await finishTestRollout(await parkForRollout(submitted));
  const scope = { projectId: task.projectId, environmentId: submitted.target.environmentId };
  const registration = { environmentId: scope.environmentId, releaseTargetRevision: binding.manifest.target.revision,
    releaseTargetSha256: binding.manifest.target.mappingSha256, whiskers: { origin: 'https://ops.example.invalid', serverId: 'local' } };
  const enrollment = await registerOperationsTarget(database.storage, registration);
  return { ...submitted, scope, registration, enrollment, runtime, image };
}

function healthInstallation({ scope, enrollment, registration }: Awaited<ReturnType<typeof installedOperationsFixture>>) {
  return { environmentId: scope.environmentId, enrollmentSha256: enrollment.fingerprint, mappingSha256: registration.releaseTargetSha256 };
}

const stoppedHealth = { status: 'unhealthy', reason: 'runtime_stopped', evidenceSha256: sha256('stopped health fixture') } as const;
const recoveredHealth = { status: 'healthy', evidenceSha256: sha256('protected health fixture') } as const;
const unavailableHealth = { status: 'unavailable', reason: 'probe_identity', evidenceSha256: sha256('probe identity fixture') } as const;

async function incidentMonitorFixture(fixture?: Awaited<ReturnType<typeof installedOperationsFixture>>) {
  const application = fixture ?? await installedOperationsFixture();
  const installation = healthInstallation(application);
  const worker = diagnosisInstallation(application);
  const registration = { action: 'register', ...installation, expectedActiveId: null, locale: 'zh-CN',
    providerSha256: worker.diagnosisProviderSha256, validUntil: new Date(Date.now() + 60 * 60_000).toISOString() };
  const { monitorId } = await changeOperationsIncidentMonitor(database.storage, registration);
  const journal = new OperationsHealthJournal(database.storage, installation);
  const makeScheduler = (id = monitorId) => new OperationsIncidentScheduler(database.storage, { ...installation, monitorId: id });
  const sample = async (signal: OperationsHealthSignal = stoppedHealth) =>
    journal.recordProbe((await journal.prepareProbe()).probe, signal);
  return { application, installation, worker, registration, monitorId, journal, makeScheduler, sample };
}

it('admits one incident diagnosis in concurrent polls and recovers its original wakeup after lease loss', async () => {
  const fixture = await incidentMonitorFixture();
  const first = fixture.makeScheduler();
  expect(await first.tick()).toEqual({ status: 'idle', reason: 'no_incident' });
  const sample = await fixture.sample();
  const results = await Promise.all([first.tick(), fixture.makeScheduler().tick()]);
  const admitted = results.find(result => result.status === 'queued');
  if (!admitted) throw new Error('Expected an incident diagnosis task');
  expect(admitted).toMatchObject({ incidentId: sample.incidentId, sampleSequence: sample.sequence, attempt: 1 });
  expect(results).toContainEqual({ status: 'active', taskId: admitted.taskId });
  expect(await fixture.makeScheduler().tick()).toEqual({ status: 'active', taskId: admitted.taskId });
  const [monitor] = await database.storage.db.select().from(operationsIncidentMonitors);
  const [link] = await database.storage.db.select().from(operationsIncidentDiagnoses);
  expect(link).toMatchObject({ incidentId: sample.incidentId, environmentId: fixture.installation.environmentId,
    monitorId: fixture.monitorId, taskId: admitted.taskId, runId: admitted.runId, sampleSequence: sample.sequence });
  expect(await fixture.application.taskService.get(identity, admitted.taskId)).toMatchObject({ workflow: 'operations',
    requestedBy: monitor?.principalId, locale: 'zh-CN', purpose: translate('zh-CN', 'operations.incident.purpose'),
    source: task.source, state: 'queued' });
  const scope = await claimOperations(fixture.worker);
  if (!scope) throw new Error('Expected the monitored diagnosis to hold the global slot');
  expect(scope).toMatchObject({ taskId: admitted.taskId, runId: admitted.runId });
  const recovered = await reclaimDiagnosis(scope, fixture.worker);
  await expect(coordinator.withLease(scope, async () => {})).rejects.toBeInstanceOf(ExecutionLost);
  const request = await coordinator.withLease(recovered, async (_tx, current) => current.operationsDiagnosis);
  expect(request).toMatchObject({ providerSha256: fixture.registration.providerSha256,
    document: { request: { grantId: monitor?.grantId, releaseOperationId: fixture.application.operationId } } });
  await coordinator.stop(recovered, 'operations_review_required');
  expect(await fixture.makeScheduler().tick()).toEqual({ status: 'stopped', reason: 'task_stopped' });
  expect(await database.storage.db.select().from(operationsIncidentDiagnoses)).toHaveLength(1);
}, 60_000);

it('rolls back the incident task, queue wakeup and trigger link when admission cannot commit', async () => {
  const fixture = await incidentMonitorFixture();
  const { probe } = await fixture.journal.prepareProbe();
  const startedAt = new Date(Date.parse(probe.startedAt) - 1_000).toISOString();
  const sample = await fixture.journal.recordProbe({ ...probe, startedAt }, stoppedHealth);
  const current = await database.admin.query('SELECT count(*)::int AS count FROM itervane_queue.job WHERE name=$1', [queueName]);
  const [monitor] = await database.storage.db.select().from(operationsIncidentMonitors);
  if (!monitor) throw new Error('Expected a monitored diagnosis actor');
  await database.admin.query(`ALTER TABLE itervane.operations_incident_diagnoses
    ADD CONSTRAINT incident_fixture_reject_attempt CHECK (attempt <> 1)`);
  try {
    await expect(fixture.makeScheduler().tick()).rejects.toMatchObject({
      cause: { code: '23514', constraint: 'incident_fixture_reject_attempt' },
    });
    expect(await database.storage.db.select().from(taskRecords).where(eq(taskRecords.requestedBy, monitor.principalId))).toEqual([]);
    expect(await database.storage.db.select().from(operationsDiagnosisInputs)).toEqual([]);
    expect(await database.storage.db.select().from(operationsIncidentDiagnoses)).toEqual([]);
    const after = await database.admin.query('SELECT count(*)::int AS count FROM itervane_queue.job WHERE name=$1', [queueName]);
    expect(after.rows).toEqual(current.rows);
  } finally {
    await database.admin.query('ALTER TABLE itervane.operations_incident_diagnoses DROP CONSTRAINT incident_fixture_reject_attempt');
  }
  const retried = await fixture.makeScheduler().tick();
  expect(retried, JSON.stringify(retried)).toMatchObject({
    status: 'queued', attempt: 1, incidentId: sample.incidentId, sampleSequence: sample.sequence,
  });
}, 45_000);

it('requires fresh incident samples and an environment cooldown before exhausting the diagnosis budget', async () => {
  const fixture = await incidentMonitorFixture();
  const scheduler = fixture.makeScheduler();
  const agedProbe = (await fixture.journal.prepareProbe()).probe;
  const stale = await fixture.journal.recordProbe({ ...agedProbe, startedAt: new Date(Date.now() - 7 * 60_000).toISOString() }, stoppedHealth);
  expect(await scheduler.tick()).toEqual({ status: 'idle', reason: 'awaiting_sample' });
  const finish = async (attempt: number) => {
    const accepted = await scheduler.tick();
    if (accepted.status !== 'queued') throw new Error('Expected the next bounded diagnostic task');
    expect(accepted).toMatchObject({ attempt, incidentId: stale.incidentId });
    const scope = await claimOperations(fixture.worker);
    if (!scope) throw new Error('Expected the diagnostic task lease');
    expect(scope.taskId).toBe(accepted.taskId);
    // Represent an observed diagnosis completion. Native evidence is exercised by the worker acceptance.
    await coordinator.withLease(scope, async (tx, { task }) => {
      await appendEvent(tx, task, 'task.operations_observed', 'succeeded', { workerId: scope.workerId });
      await clearSlot(tx);
    });
    return accepted.taskId;
  };
  const ageAdmission = (id: string) => database.admin.query(`UPDATE itervane.operations_incident_diagnoses
    SET admitted_at=admitted_at - interval '121 seconds' WHERE task_id=$1`, [id]);
  await fixture.sample();
  const first = await finish(1);
  expect(await scheduler.tick()).toEqual({ status: 'idle', reason: 'awaiting_sample' });
  await fixture.sample(unavailableHealth);
  expect(await scheduler.tick()).toEqual({ status: 'idle', reason: 'awaiting_sample' });
  await fixture.sample();
  expect(await scheduler.tick()).toEqual({ status: 'idle', reason: 'cooldown' });
  await ageAdmission(first);
  const second = await finish(2);
  await ageAdmission(second);
  await fixture.sample();
  await finish(3);
  await fixture.sample();
  expect(await scheduler.tick()).toEqual({ status: 'stopped', reason: 'attempt_limit' });
  expect(await fixture.makeScheduler().tick()).toEqual({ status: 'stopped', reason: 'attempt_limit' });
  expect(await database.storage.db.select().from(operationsIncidents)).toMatchObject([
    { id: stale.incidentId, diagnosisStopReason: 'attempt_limit', diagnosisStoppedAt: expect.any(Date) },
  ]);
  expect(await database.storage.db.select().from(operationsIncidentDiagnoses)).toHaveLength(3);
  await fixture.sample(recoveredHealth);
  const reopened = await fixture.sample();
  expect(reopened.incidentId).not.toBe(stale.incidentId);
  expect(await scheduler.tick()).toEqual({ status: 'idle', reason: 'cooldown' });
}, 60_000);

it('rechecks the project grant and monitor generation before claiming an incident diagnosis', async () => {
  const fixture = await incidentMonitorFixture();
  const [monitor] = await database.storage.db.select().from(operationsIncidentMonitors);
  if (!monitor) throw new Error('Expected a diagnostic monitor');
  await fixture.sample();
  const [member] = await database.storage.db.select().from(projectMembers).where(eq(projectMembers.principalId, monitor.principalId));
  expect(member).toMatchObject({ grantId: monitor.grantId, projectId: fixture.application.scope.projectId, role: 'maintainer' });
  await database.storage.db.transaction(async tx => {
    const where = eq(projectMembers.principalId, monitor.principalId);
    await tx.update(projectMembers).set({ role: 'viewer' }).where(where);
    const [renewed] = await tx.update(projectMembers).set({ role: 'maintainer' }).where(where).returning();
    expect(renewed?.grantId).not.toBe(monitor.grantId);
  });
  expect(await fixture.makeScheduler().tick()).toEqual({ status: 'skipped', reason: 'forbidden' });
  await expect(changeOperationsIncidentMonitor(database.storage, fixture.registration)).rejects.toMatchObject({ code: 'version_conflict' });
  const reissued = await changeOperationsIncidentMonitor(database.storage, { ...fixture.registration, expectedActiveId: fixture.monitorId });
  expect(await fixture.makeScheduler().tick()).toEqual({ status: 'skipped', reason: 'forbidden' });
  const second = fixture.makeScheduler(reissued.monitorId);
  const accepted = await second.tick();
  if (accepted.status !== 'queued') throw new Error('Expected a task for the new monitored grant');
  await changeOperationsIncidentMonitor(database.storage, { action: 'revoke', environmentId: fixture.installation.environmentId,
    expectedActiveId: reissued.monitorId });
  expect(await claimOperations(fixture.worker)).toBeNull();
  expect(await fixture.application.taskService.get(identity, accepted.taskId)).toMatchObject({ state: 'needs_human' });
  expect(await fixture.application.taskService.events(identity, accepted.taskId, 10)).toMatchObject([
    { type: 'task.accepted' }, { type: 'task.needs_human', reason: 'permission_revoked' },
  ]);
  expect(await second.tick()).toEqual({ status: 'skipped', reason: 'forbidden' });
  expect(await database.storage.db.select().from(operationsIncidentDiagnoses)).toHaveLength(1);
}, 60_000);

it('blocks further incident diagnosis work when the active registration expires', async () => {
  const fixture = await incidentMonitorFixture();
  await fixture.sample();
  const accepted = await fixture.makeScheduler().tick();
  if (accepted.status !== 'queued') throw new Error('Expected the monitored run before expiry');
  const scope = await claimOperations(fixture.worker);
  if (!scope) throw new Error('Expected the original diagnostic lease');
  await database.admin.query(`UPDATE itervane.operations_incident_monitors
    SET created_at=clock_timestamp() - interval '2 minutes', valid_until=clock_timestamp() - interval '1 minute' WHERE id=$1`, [fixture.monitorId]);
  const read = vi.fn();
  await expect(coordinator.withLease(scope, read)).rejects.toMatchObject({ code: 'forbidden' });
  expect(read).not.toHaveBeenCalled();
  expect(await fixture.makeScheduler().tick()).toEqual({ status: 'skipped', reason: 'forbidden' });
  await coordinator.stop(scope, 'permission_revoked');
  expect(await fixture.application.taskService.get(identity, accepted.taskId)).toMatchObject({ state: 'needs_human' });
}, 60_000);

it('defers incident diagnosis during a pending release and fences its old queued instance after publication', async () => {
  const fixture = await incidentMonitorFixture();
  const initial = await fixture.sample();
  task = (await fixture.application.taskService.admit(identity, { projectId: fixture.application.scope.projectId,
    source: task.source, purpose: 'Publish the replacement instance', dataClass: 'synthetic', idempotencyKey: randomUUID() })).task;
  const prepared = await preparedFormalRelease({ existingTarget: fixture.application.target, imageVariant: 'incident target replacement' });
  const accepted = await fixture.makeScheduler().tick();
  if (accepted.status !== 'queued') throw new Error('Expected a monitored diagnosis before the next release');
  const next = await prepared.confirm();
  expect(await fixture.makeScheduler().tick()).toEqual({ status: 'skipped', reason: 'conflict' });
  expect(await claimOperations(fixture.worker)).toBeNull();
  expect(await fixture.application.taskService.get(identity, accepted.taskId)).toMatchObject({ state: 'queued' });
  await finishTestRollout(await parkForRollout(next, true, 'd'.repeat(24)), 'standard-v3');
  expect(await claimOperations(fixture.worker)).toBeNull();
  expect(await fixture.application.taskService.get(identity, accepted.taskId)).toMatchObject({ state: 'needs_human' });
  const newIncident = await fixture.sample();
  expect(newIncident.incidentId).not.toBe(initial.incidentId);
  expect(await fixture.makeScheduler().tick()).toEqual({ status: 'idle', reason: 'cooldown' });
  expect(await database.storage.db.select().from(operationsIncidentDiagnoses)).toHaveLength(1);
}, 60_000);

it('deduplicates concurrent health samples, preserves uncertainty and recovers the same incident', async () => {
  const fixture = await installedOperationsFixture();
  const installation = healthInstallation(fixture);
  const journal = new OperationsHealthJournal(database.storage, installation);
  const peer = new OperationsHealthJournal(database.storage, installation);
  const { probe } = await journal.prepareProbe();
  const concurrent = await Promise.all([journal.recordProbe(probe, stoppedHealth), peer.recordProbe(probe, stoppedHealth)]);
  const { incidentId } = concurrent[0]!;
  expect(incidentId).toBeTypeOf('string');
  expect(concurrent).toEqual(expect.arrayContaining([
    { sequence: probe.sequence, incidentId, replayed: false }, { sequence: probe.sequence, incidentId, replayed: true },
  ]));
  await expect(journal.recordProbe(probe, recoveredHealth)).rejects.toMatchObject({ code: 'idempotency_conflict' });
  const [initial] = await database.storage.db.select().from(operationsHealthSamples);
  expect(initial).toMatchObject({ sequence: probe.sequence, incidentId, signal: stoppedHealth,
    binding: { ...probe.binding, releaseOperationId: fixture.operationId, restoreExecutionId: null } });
  expect(initial?.recordedAt.getTime()).toBeGreaterThanOrEqual(Date.parse(probe.startedAt));
  await expect(database.storage.db.update(operationsHealthSamples).set({ signal: recoveredHealth })
    .where(eq(operationsHealthSamples.sequence, probe.sequence))).rejects.toMatchObject({
    cause: { code: '23514', message: 'operations_health_sample_is_immutable' },
  });

  const older = (await journal.prepareProbe()).probe;
  const newer = (await peer.prepareProbe()).probe;
  expect(newer.sequence).toBeGreaterThan(older.sequence);
  await expect(peer.recordProbe(newer, stoppedHealth)).resolves.toMatchObject({ incidentId, replayed: false });
  await expect(journal.recordProbe(older, recoveredHealth)).rejects.toMatchObject({ code: 'version_conflict' });
  const unknown = (await journal.prepareProbe()).probe;
  await expect(journal.recordProbe(unknown, unavailableHealth)).resolves.toMatchObject({ incidentId });
  expect(await database.storage.db.select().from(operationsIncidents)).toMatchObject([
    { id: incidentId, unhealthySamples: 2, closedAt: null, closedReason: null },
  ]);

  const failedWrite = (await journal.prepareProbe()).probe;
  await database.admin.query(`ALTER TABLE itervane.operations_health_samples ADD CONSTRAINT health_fixture_reject_observation
    CHECK (signal->>'evidenceSha256' <> '${recoveredHealth.evidenceSha256}')`);
  try {
    await expect(journal.recordProbe(failedWrite, recoveredHealth)).rejects.toMatchObject({
      cause: { code: '23514', constraint: 'health_fixture_reject_observation' },
    });
    expect(await database.storage.db.select().from(operationsIncidents)).toMatchObject([{ id: incidentId, closedAt: null }]);
    expect(await database.storage.db.select().from(operationsHealthSamples)).toHaveLength(3);
  } finally { await database.admin.query('ALTER TABLE itervane.operations_health_samples DROP CONSTRAINT health_fixture_reject_observation'); }
  await expect(journal.recordProbe(failedWrite, recoveredHealth)).resolves.toMatchObject({ incidentId, replayed: false });
  expect(await database.storage.db.select().from(operationsIncidents)).toMatchObject([
    { id: incidentId, unhealthySamples: 2, closedAt: expect.any(Date), closedReason: 'recovered' },
  ]);
  const fresh = await journal.recordProbe((await journal.prepareProbe()).probe, stoppedHealth);
  expect(fresh.incidentId).not.toBe(incidentId);
  expect(await database.storage.db.select().from(operationsIncidents)).toHaveLength(2);
}, 45_000);

it('rejects health samples after scope, rollout or enrollment changes', async () => {
  const fixture = await installedOperationsFixture();
  const installation = healthInstallation(fixture);
  const journal = new OperationsHealthJournal(database.storage, installation);
  const { probe } = await journal.prepareProbe();
  await expect(journal.recordProbe({ ...probe, binding: { ...probe.binding, projectId: randomUUID() } }, stoppedHealth))
    .rejects.toMatchObject({ code: 'version_conflict' });
  await expect(new OperationsHealthJournal(database.storage, { ...installation, mappingSha256: sha256('wrong rollout mapping') }).prepareProbe())
    .rejects.toMatchObject({ code: 'version_conflict' });
  const { incidentId } = await journal.recordProbe(probe, stoppedHealth);
  const delayed = (await journal.prepareProbe()).probe;
  task = (await fixture.taskService.admit(identity, { projectId: fixture.scope.projectId, source: task.source,
    purpose: 'Replace the unhealthy instance', dataClass: 'synthetic', locale: 'en', idempotencyKey: randomUUID() })).task;
  const next = await queuedFormalRelease({ existingTarget: fixture.target, imageVariant: 'new instance for health observation' });
  await expect(journal.prepareProbe()).rejects.toMatchObject({ code: 'conflict' });
  await expect(journal.recordProbe(delayed, recoveredHealth)).rejects.toMatchObject({ code: 'conflict' });
  await finishTestRollout(await parkForRollout(next, true, 'd'.repeat(24)), 'standard-v3');
  await expect(journal.recordProbe(delayed, recoveredHealth)).rejects.toMatchObject({ code: 'version_conflict' });
  const fresh = (await journal.prepareProbe()).probe;
  expect(fresh.binding.releaseOperationId).toBe(next.operationId);
  await expect(journal.recordProbe(fresh, unavailableHealth)).resolves.toMatchObject({ incidentId: null });
  expect(await database.storage.db.select().from(operationsIncidents)).toMatchObject([{ id: incidentId, closedAt: null }]);
  await expect(journal.recordProbe((await journal.prepareProbe()).probe, recoveredHealth)).resolves.toMatchObject({ incidentId: null });
  expect(await database.storage.db.select().from(operationsIncidents)).toMatchObject([
    { id: incidentId, closedReason: 'target_changed', binding: { releaseOperationId: fixture.operationId } },
  ]);

  const beforeRotation = (await journal.prepareProbe()).probe;
  const enrollment = await registerOperationsTarget(database.storage, { ...fixture.registration,
    whiskers: { ...fixture.registration.whiskers, serverId: 'health-rotation' } });
  await expect(journal.prepareProbe()).rejects.toMatchObject({ code: 'unavailable' });
  const rotated = new OperationsHealthJournal(database.storage, { ...installation, enrollmentSha256: enrollment.fingerprint });
  await expect(rotated.recordProbe(beforeRotation, stoppedHealth)).rejects.toMatchObject({ code: 'version_conflict' });
  expect((await rotated.prepareProbe()).probe.binding).toMatchObject({ releaseOperationId: next.operationId, enrollmentRevision: enrollment.revision });
}, 60_000);

it('fences health samples during a held restore and binds a new incident to the verified replacement instance', async () => {
  const original = await installedOperationsFixture();
  const journal = new OperationsHealthJournal(database.storage, healthInstallation(original));
  const archived = (await journal.prepareProbe()).probe;
  const previous = await journal.recordProbe(archived, stoppedHealth);
  const stale = (await journal.prepareProbe()).probe;
  const { executor, successor, execution, ack } = await dispatchedRestore('acknowledged', original);
  await expect(journal.prepareProbe()).rejects.toMatchObject({ code: 'conflict' });
  await expect(journal.recordProbe(stale, recoveredHealth)).rejects.toMatchObject({ code: 'conflict' });
  expect(await database.storage.db.select().from(operationsHealthSamples)).toHaveLength(1);

  const runtime = { ...original.runtime, containerId: sha256('restored health fixture instance') };
  await expect(executor.settleRestoreRecovery(successor, { update: { ...ack, status: 'Complete', success: true }, runtime }))
    .resolves.toBe('verified');
  const current = (await journal.prepareProbe()).probe;
  expect(current.binding).toMatchObject({ releaseOperationId: original.operationId, restoreExecutionId: execution.id,
    manifestDigest: original.image.manifestDigest, containerId: runtime.containerId });
  expect(current.binding.publicationProofSha256).not.toBe(stale.binding.publicationProofSha256);
  await expect(journal.recordProbe(stale, recoveredHealth)).rejects.toMatchObject({ code: 'version_conflict' });
  const replacement = await journal.recordProbe(current, stoppedHealth);
  expect(replacement.incidentId).not.toBe(previous.incidentId);
  expect(await database.storage.db.select().from(operationsIncidents)).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: previous.incidentId, closedReason: 'target_changed', binding: archived.binding }),
    expect.objectContaining({ id: replacement.incidentId, closedAt: null, binding: current.binding }),
  ]));

  const [latest] = await database.storage.db.select().from(operationsHealthSamples).where(eq(operationsHealthSamples.sequence, current.sequence));
  const another = (await journal.prepareProbe()).probe;
  await expect(database.storage.db.insert(operationsHealthSamples).values({ ...latest!, sequence: another.sequence, incidentId: previous.incidentId }))
    .rejects.toMatchObject({ cause: { code: '23503', constraint: 'operations_health_sample_incident_fk' } });
  expect(await database.storage.db.select().from(operationsHealthSamples)).toHaveLength(2);
}, 60_000);

it('reads the current and preceding verified releases only for the frozen operations scope', async () => {
  const fixture = await installedOperationsFixture();
  const capture = () => database.storage.db.transaction(async tx =>
    freezeOperationsRequest(await readOperationsObservationTarget(tx, await requireActor(tx, identity), fixture.scope)));
  const read = (request: Awaited<ReturnType<typeof capture>>, actor = identity) => database.storage.db.transaction(async tx =>
    readOperationsReleaseEvidence(tx, await requireActor(tx, actor), request));
  const queueNext = async (target: FormalReleaseTarget, purpose: string, imageVariant: string) => {
    task = (await fixture.taskService.admit(identity, { projectId: fixture.scope.projectId, source: task.source, purpose,
      dataClass: 'synthetic', locale: 'zh-CN', idempotencyKey: randomUUID() })).task;
    return queuedFormalRelease({ existingTarget: target, imageVariant });
  };
  const original = await capture();
  const first = await read(original);
  expect(first.result).toEqual({ current: { operationId: fixture.operationId,
    manifestDigest: fixture.image.manifestDigest, verifiedAt: expect.any(String) }, previous: null });

  const next = await queueNext(fixture.target, 'Second verified release', 'diagnostic history v2');
  await expect(read(original)).rejects.toMatchObject({ code: 'conflict' });
  const second = await finishTestRollout(await parkForRollout(next, true, 'd'.repeat(24)));
  await expect(read(original)).rejects.toMatchObject({ code: 'version_conflict' });
  const current = await capture();
  const history = await read(current);
  expect(history).toEqual({ proofSha256: expect.stringMatching(/^[a-f0-9]{64}$/), result: {
    current: { operationId: next.operationId, manifestDigest: second.image.manifestDigest, verifiedAt: expect.any(String) },
    previous: first.result.current,
  } });
  expect(history.proofSha256).not.toBe(first.proofSha256);
  await expect(read(current)).resolves.toEqual(history);
  expect(JSON.stringify(history)).not.toContain(fixture.registration.whiskers.origin);
  await expect(read({ ...current, sha256: sha256('altered request') })).rejects.toMatchObject({ code: 'unsupported_state' });

  const foreign = await new ResourceService(database.storage).createProject(identity, { name: 'Other release history', slug: 'other-release-history' });
  const document = { ...current.document, projectId: foreign.id };
  await expect(read({ document, sha256: sha256(JSON.stringify(document)) })).rejects.toMatchObject({ code: 'not_found' });
  const principalId = randomUUID();
  const subject = 'diagnosis-history-viewer';
  await database.storage.db.insert(principals).values({ id: principalId, issuer: issuer.config.issuer, subject });
  await database.storage.db.insert(projectMembers).values({ projectId: fixture.scope.projectId, principalId, role: 'viewer' });
  const viewer = await createIdentityVerifier(issuer.config)(await issuer.token(subject));
  await expect(read(current, viewer)).rejects.toMatchObject({ code: 'forbidden' });
  await database.storage.db.update(projectMembers).set({ role: 'maintainer' }).where(eq(projectMembers.principalId, principalId));
  await expect(read(current, viewer)).rejects.toMatchObject({ code: 'version_conflict' });

  await registerOperationsTarget(database.storage, { ...fixture.registration, whiskers: { ...fixture.registration.whiskers, serverId: 'rebound' } });
  await expect(read(current)).rejects.toMatchObject({ code: 'version_conflict' });

  const remapped = await queueNext({ ...fixture.target, runtimeConfigSha256: sha256('new runtime baseline') }, 'Remapped release', 'remapped diagnostic history');
  const settled = await finishTestRollout(await parkForRollout(remapped, true, 'f'.repeat(24)));
  await registerOperationsTarget(database.storage, { ...fixture.registration,
    releaseTargetRevision: settled.binding.manifest.target.revision, releaseTargetSha256: settled.binding.manifest.target.mappingSha256 });
  expect((await read(await capture())).result).toMatchObject({ current: { operationId: remapped.operationId }, previous: null });
});

it.each(['verified', 'manual_review'] as const)('shares the %s formal release result between HTTP and MCP under current grants', async status => {
  const submitted = await queuedFormalRelease({ komodo: true, rolloutCheck: true });
  const { operationId, approval } = submitted;
  const principalId = randomUUID();
  const subject = 'formal-result-viewer';
  const publicUrl = 'https://itervane.example';
  await database.storage.db.insert(principals).values({ id: principalId, issuer: issuer.config.issuer, subject });
  await database.storage.db.insert(projectMembers).values({ projectId: task.projectId, principalId, role: 'viewer' });
  const authorization = `Bearer ${await issuer.token(subject)}`;
  const mcpToken = await issuer.token(subject, { aud: `${publicUrl}/mcp`, scope: 'itervane:read' });
  const api = createApi(database.storage, { ...issuer.config, publicUrl }, { logger: false });
  const clients: Client[] = [];
  const route = `/v1/tasks/${task.id}/release`;
  const request = { name: 'get_release_result', arguments: { taskId: task.id } };
  async function readHttp(locale: 'en' | 'zh-CN') {
    const response = await api.inject({ url: route, headers: { authorization, 'accept-language': locale } });
    expect(response.statusCode).toBe(200);
    return formalReleaseViewSchema.parse(response.json());
  }
  try {
    const address = await api.listen({ host: '127.0.0.1', port: 0 });
    const queued = await readHttp('en');
    expect(queued.result).toMatchObject({ operationId, candidateId: approval.id, status: 'queued', updateId: null });
    expect(queued.result).not.toHaveProperty('evidence');
    const { update, image } = await parkForRollout(submitted);
    expect((await readHttp('en')).result).toMatchObject({ operationId, updateId: update.updateId, status: 'reconciling' });

    const observer = new FormalRolloutCoordinator(database.storage, releaseOrigin);
    const scope = await observer.claimNext(randomUUID());
    if (!scope) throw new Error('Expected formal rollout attempt');
    expect((await readHttp('en')).result).toMatchObject({ status: 'checking' });
    const binding = await observer.authorize(scope);
    if (status === 'verified') {
      await observer.settle(scope, { version: 1, ...binding.decision, rolloutFence: scope.fence, generation: binding.manifest.generation,
        targetRevision: binding.manifest.target.revision, mappingSha256: binding.manifest.target.mappingSha256,
        manifestDigest: image.manifestDigest, update, runtime: observedRuntime(binding) });
    } else {
      await observer.requireManualReview(scope, 'release_rollout_health_failed');
    }

    for (const locale of ['en', 'zh-CN'] as const) {
      const client = new Client({ name: 'release-result-test', version: '0.0.0' });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        requestInit: { headers: { authorization: `Bearer ${mcpToken}`, 'accept-language': locale } },
      }));
      const result = await client.callTool(request);
      expect(result.isError).not.toBe(true);
      const outcome = formalReleaseResultSchema.parse(result.structuredContent);
      const http = await readHttp(locale);
      expect(outcome).toEqual({ taskId: http.taskId, runId: http.runId, taskVersion: http.taskVersion, result: http.result });
      expect(http.actions).toEqual([]);
      expect(outcome.result).toMatchObject({ operationId, candidateId: approval.id, updateId: update.updateId, status, locale });
      if (status === 'verified') {
        expect(outcome.result).toMatchObject({ message: translate(locale, 'release.operation.verified_formal'), evidence: {
          manifestDigest: image.manifestDigest, configDigest: image.configDigest, version: observedRuntime(binding).version,
          checkedAt: expect.any(String), healthy: true, accessProtected: true,
        } });
      } else {
        expect(outcome.result).not.toHaveProperty('evidence');
        expect(outcome.result).toMatchObject({ message: translate(locale, 'release.result.manual_review'),
          reason: 'release_rollout_health_failed', reasonMessage: translate(locale, 'reason.release_rollout_health_failed') });
      }
      expect(JSON.stringify(outcome)).not.toContain(image.reference);
    }
    await database.storage.db.delete(projectMembers).where(eq(projectMembers.principalId, principalId));
    expect((await api.inject({ url: route, headers: { authorization } })).statusCode).toBe(404);
    const denied = await clients[0]!.callTool(request);
    expect(denied.isError).toBe(true);
    expect(apiErrorSchema.parse(denied.structuredContent).error.code).toBe('not_found');
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await api.close();
  }
});

it('binds operations to the latest verified deployment under current project authority', async () => {
  const submitted = await queuedFormalRelease({ komodo: true, rolloutCheck: true });
  const { operationId, target } = submitted;
  const read = (caller = identity, projectId = task.projectId) => database.storage.db.transaction(async tx =>
    readOperationsDeployment(tx, await requireActor(tx, caller), { projectId, environmentId: target.environmentId }));
  await expect(read()).rejects.toMatchObject({ code: 'conflict' });
  const parked = await parkForRollout(submitted);
  await expect(read()).rejects.toMatchObject({ code: 'conflict' });
  const { binding, runtime, image, update } = await finishTestRollout(parked);

  const selected = await read();
  expect(selected).toMatchObject({ projectId: task.projectId, environmentId: target.environmentId, releaseOperationId: operationId,
    releaseTaskId: task.id, source: task.source, updateId: update.updateId, deploymentId: target.deploymentId,
    containerId: runtime.containerId, manifestDigest: image.manifestDigest, configDigest: image.configDigest,
    targetRevision: binding.manifest.target.revision, mappingSha256: binding.manifest.target.mappingSha256,
    version: runtime.version, verifiedAt: expect.any(String) });
  const other = await new ResourceService(database.storage).createProject(identity, { name: 'Other operations', slug: 'other-operations' });
  await expect(read(identity, other.id)).rejects.toMatchObject({ code: 'not_found' });

  const readEnrolled = (projectId = task.projectId) => database.storage.db.transaction(async tx =>
    readOperationsObservationTarget(tx, await requireActor(tx, identity), { projectId, environmentId: target.environmentId }));
  await expect(readEnrolled()).rejects.toMatchObject({ code: 'unsupported_state' });
  const registration = { environmentId: target.environmentId, releaseTargetRevision: selected.targetRevision,
    releaseTargetSha256: selected.mappingSha256, whiskers: { origin: 'https://ops.example.invalid', serverId: 'local' } };
  await expect(registerOperationsTarget(database.storage, { ...registration, readKey: 'fixture-secret' }))
    .rejects.toMatchObject({ code: 'invalid_input' });
  const register = () => registerOperationsTarget(database.storage, registration);
  const [first, repeated] = await Promise.all([register(), register()]);
  expect(first).toEqual({ environmentId: target.environmentId, revision: 1, fingerprint: expect.any(String) });
  expect(repeated).toEqual(first);
  await expect(readEnrolled()).resolves.toMatchObject({ ...selected, whiskers: registration.whiskers, enrollmentRevision: 1,
    enrollmentSha256: first.fingerprint });
  await expect(readEnrolled(other.id)).rejects.toMatchObject({ code: 'not_found' });

  const nextWhiskers = { ...registration.whiskers, serverId: 'replacement-server' };
  const enrolled = await registerOperationsTarget(database.storage, { ...registration, whiskers: nextWhiskers });
  expect(enrolled.revision).toBe(2);
  expect(enrolled.fingerprint).not.toBe(first.fingerprint);
  await expect(readEnrolled()).resolves.toMatchObject({ ...selected, whiskers: nextWhiskers, enrollmentRevision: 2 });

  const principalId = randomUUID();
  const subject = 'ops-reader';
  await database.storage.db.insert(principals).values({ id: principalId, issuer: issuer.config.issuer, subject });
  const viewer = await createIdentityVerifier(issuer.config)(await issuer.token(subject));
  await database.storage.db.insert(projectMembers).values({ projectId: task.projectId, principalId, role: 'viewer' });
  await expect(read(viewer)).rejects.toMatchObject({ code: 'forbidden' });
  await database.storage.db.update(projectMembers).set({ role: 'maintainer' }).where(eq(projectMembers.principalId, principalId));
  expect((await read(viewer)).grantId).not.toBe(selected.grantId);
  await database.storage.db.delete(projectMembers).where(eq(projectMembers.principalId, principalId));
  await expect(read(viewer)).rejects.toMatchObject({ code: 'not_found' });

  await registerReleaseTarget(database.storage, { ...target, runtimeConfigSha256: sha256('new runtime config') });
  await expect(read()).rejects.toMatchObject({ code: 'unsupported_state' });
  await expect(register()).rejects.toMatchObject({ code: 'version_conflict' });
  await expect(readEnrolled()).rejects.toMatchObject({ code: 'unsupported_state' });
});

it('atomically admits one localized operations task with an immutable published target and job', async () => {
  const fixture = await installedOperationsFixture();
  const service = fixture.taskService;
  const input = { ...fixture.scope, idempotencyKey: randomUUID(), locale: 'zh-CN' };
  const outcomes = await Promise.all([service.admitOperations(identity, input), service.admitOperations(identity, input)]);
  expect(outcomes.map(item => item.replayed).sort()).toEqual([false, true]);
  const recorded = outcomes[0]!.task;
  expect(outcomes[1]!.task.id).toBe(recorded.id);
  expect(recorded).toMatchObject({ state: 'queued', source: task.source, dataClass: task.dataClass, locale: 'zh-CN', purpose: '诊断已发布应用' });
  const [request] = await database.storage.db.select().from(operationsRequests);
  expect(request).toMatchObject({ runId: recorded.runId, taskId: recorded.id, projectId: recorded.projectId,
    releaseOperationId: fixture.operationId, document: { source: task.source, releaseTaskId: task.id,
      enrollmentSha256: fixture.enrollment.fingerprint, containerId: fixture.runtime.containerId, manifestDigest: fixture.image.manifestDigest,
      mappingSha256: fixture.registration.releaseTargetSha256, dataClass: recorded.dataClass }, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(request?.document).not.toHaveProperty('whiskers');
  const [run] = await database.storage.db.select().from(taskRuns).where(eq(taskRuns.id, recorded.runId));
  expect(run).toMatchObject({ role: 'operations', wakeupJobId: expect.any(String) });
  expect(await database.storage.boss.findJobs(queueName, { id: run!.wakeupJobId! })).toMatchObject([
    { data: { taskId: recorded.id, runId: recorded.runId, generation: 1 } },
  ]);
  expect(await service.events(identity, recorded.id, 10, 'zh-CN')).toMatchObject([{ type: 'task.accepted', locale: 'zh-CN' }]);
  const [budget] = await database.storage.db.select().from(runRuntime).where(eq(runRuntime.runId, recorded.runId));
  expect(budget).toMatchObject({ maxTools: 2, toolsUsed: 0 });
  await expect(database.storage.pool.query('DELETE FROM itervane.operations_requests WHERE run_id=$1', [recorded.runId]))
    .rejects.toMatchObject({ code: '23514', message: 'operations_request_is_immutable' });
  await expect(service.admitOperations(identity, { ...input, locale: 'en' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  await expect(service.admit(identity, { projectId: task.projectId, source: task.source, dataClass: 'synthetic', purpose: 'Development',
    idempotencyKey: input.idempotencyKey })).rejects.toMatchObject({ code: 'idempotency_conflict' });

  await registerOperationsTarget(database.storage, { ...fixture.registration, whiskers: { ...fixture.registration.whiskers, serverId: 'new-server' } });
  await expect(service.admitOperations(identity, input)).resolves.toMatchObject({ replayed: true, task: { id: recorded.id } });
  const runner = { inspect: vi.fn<InspectionRunner['inspect']>(), observe: vi.fn<InspectionRunner['observe']>() };
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { runner });
  try {
    await worker.tick();
    expect(await service.get(identity, recorded.id)).toMatchObject({ state: 'queued' });
    const [deferredRun] = await database.storage.db.select().from(taskRuns).where(eq(taskRuns.id, recorded.runId));
    expect(deferredRun?.wakeupJobId).not.toBe(run?.wakeupJobId);
    expect(runner.inspect).not.toHaveBeenCalled();
  } finally { await worker.close(); }
});

it('rolls back an operations task and a real queue insert together, and rejects a replaced project grant', async () => {
  const fixture = await installedOperationsFixture();
  const { taskService, scope } = fixture;
  const installed = diagnosisInstallation(fixture);
  const subject = 'operations-admission-actor';
  const principalId = randomUUID();
  const grant = { principalId, projectId: task.projectId, role: 'maintainer' as const };
  await database.storage.db.insert(principals).values({ id: principalId, issuer: issuer.config.issuer, subject });
  await database.storage.db.insert(projectMembers).values({ ...grant, role: 'viewer' });
  const maintainer = await createIdentityVerifier(issuer.config)(await issuer.token(subject));
  const input = { ...scope, idempotencyKey: randomUUID() };
  await expect(taskService.admitOperations(maintainer, input)).rejects.toMatchObject({ code: 'forbidden' });
  await database.storage.db.update(projectMembers).set({ role: 'maintainer' }).where(eq(projectMembers.principalId, principalId));

  const send = database.storage.boss.send.bind(database.storage.boss);
  let rolledBackJob: string | null = null;
  const injected = vi.spyOn(database.storage.boss, 'send').mockImplementationOnce(async (...args) => {
    rolledBackJob = await send(...args);
    throw new Error('operations queue rollback');
  });
  try { await expect(taskService.admitOperations(maintainer, input, installed)).rejects.toThrow('operations queue rollback'); }
  finally { injected.mockRestore(); }
  expect(rolledBackJob).toBeTruthy();
  expect(await database.storage.boss.findJobs(queueName, { id: rolledBackJob! })).toEqual([]);
  expect(await database.storage.db.select().from(operationsRequests)).toEqual([]);
  expect(await database.storage.db.select().from(operationsDiagnosisInputs)).toEqual([]);
  expect(await database.storage.db.select().from(taskRecords).where(eq(taskRecords.requestKey, input.idempotencyKey))).toEqual([]);

  const { task: requested } = await taskService.admitOperations(maintainer, input, installed);
  await database.storage.db.delete(projectMembers).where(eq(projectMembers.principalId, principalId));
  await database.storage.db.insert(projectMembers).values(grant);
  const [job] = await database.storage.boss.fetch(queueName);
  expect(job?.data).toMatchObject({ taskId: requested.id, runId: requested.runId });
  expect(await coordinator.claim(job!, randomUUID(), installed)).toBeNull();
  expect((await taskService.events(maintainer, requested.id, 10, 'zh-CN')).at(-1)).toMatchObject({ reason: 'permission_revoked', state: 'needs_human' });
});

const operationsFixtureKey = 'b'.repeat(64);

function scopedWhiskers(fixture: Awaited<ReturnType<typeof installedOperationsFixture>>, beforeReply = async () => {},
  diagnosisState?: 'running' | 'exited') {
  const observe = vi.fn(beforeReply);
  const tools: string[] = [];
  const originalFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== `${fixture.registration.whiskers.origin}/mcp`) return originalFetch(input, options);
    expect(new Headers(options?.headers).get('authorization')).toBe(`Bearer ${operationsFixtureKey}`);
    if (options?.method === 'GET') return new Response(null, { status: 405 });
    const command = JSON.parse(String(options?.body)) as { id?: number; method: string; params?: Record<string, unknown> };
    if (command.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const reply = (result: object) => Response.json({ jsonrpc: '2.0', id: command.id, result });
    if (command.method === 'initialize') return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} },
      serverInfo: { name: 'whiskers', version: '0.15.0' } });
    const name = command.params?.name;
    expect(command.method).toEqual('tools/call');
    const target = { containerId: fixture.runtime.containerId, serverId: fixture.registration.whiskers.serverId };
    const state = diagnosisState ?? 'exited';
    const text = (content: string) => reply({ content: [{ type: 'text', text: content }] });
    if (diagnosisState && name === 'get_container_logs') {
      expect(command.params?.arguments).toEqual({ ...target, lines: 40 });
      tools.push(name);
      await observe();
      return text('Logs for trusted-test-container (last 40 lines):\nwarning diagnostic label\nerror local-log-canary-value');
    }
    if (diagnosisState && name === 'get_container_metrics') {
      expect(command.params?.arguments).toEqual({ ...target, period: '1h' });
      tools.push(name);
      await observe();
      return text(`Metrics for container ${target.containerId.slice(0, 12)} (last 1h):\nCPU: avg 3.0%, max 9.0%, min 1.0%\nMemory: avg 92.0%, max 98.0%, min 45.0%\nData points: 3`);
    }
    expect(name).toEqual('get_container_details');
    expect(command.params?.arguments).toEqual(target);
    tools.push('get_container_details');
    await observe();
    return text([
      'Name: trusted-test-container', `ID: ${target.containerId}`, 'Image: sample:v2', `State: ${state}`, 'Health: none',
      `Status: ${state}`, 'Created: 2026-01-01', `Server: local (${target.serverId})`, 'Labels: demo-only-metadata',
    ].join('\n'));
  });
  return { observe, tools, restore: () => spy.mockRestore() };
}

function installedOperations(fixture: Awaited<ReturnType<typeof installedOperationsFixture>>) {
  return { environmentId: fixture.scope.environmentId, enrollmentSha256: fixture.enrollment.fingerprint, readKey: operationsFixtureKey };
}

function diagnosisInstallation(fixture: Awaited<ReturnType<typeof installedOperationsFixture>>) {
  return { ...installedOperations(fixture), diagnosisProviderSha256: sha256('configured operations model') };
}

async function claimOperations(installed: OperationsWorkflowScope) {
  const job = await vi.waitFor(async () => {
    const [available] = await database.storage.boss.fetch(queueName);
    if (!available) throw new Error('Waiting for operations wakeup');
    return available;
  }, { timeout: 5_000, interval: 60 });
  return coordinator.claim(job, randomUUID(), installed);
}

async function startDiagnosis(prepared?: Awaited<ReturnType<typeof installedOperationsFixture>>) {
  const fixture = prepared ?? await installedOperationsFixture();
  const installed = diagnosisInstallation(fixture);
  const { task } = await fixture.taskService.admitOperations(identity, { ...fixture.scope, locale: 'zh-CN', idempotencyKey: randomUUID() }, installed);
  const scope = await claimOperations(installed);
  if (!scope) throw new Error('Expected diagnosis lease');
  const input = await coordinator.withLease(scope, async (_tx, current) => current.operationsDiagnosis);
  if (!input) throw new Error('Expected frozen diagnosis input');
  const operations = { environmentId: installed.environmentId, enrollmentSha256: installed.enrollmentSha256,
    inputSha256: input.sha256, providerSha256: input.providerSha256 };
  return { fixture, installed, task, scope, input, operations };
}

async function reclaimDiagnosis(scope: ExecutionScope, installed: OperationsWorkflowScope) {
  await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp() - interval '1 second' WHERE run_id=$1 AND fence=$2",
    [scope.runId, scope.fence]);
  await database.storage.db.transaction(tx => coordinator.recoverExpired(tx, randomUUID()));
  const current = await claimOperations(installed);
  if (!current) throw new Error('Expected recovered diagnosis lease');
  expect(current).toMatchObject({ runId: scope.runId, fence: scope.fence + 1 });
  return current;
}

it('recovers only published diagnosis checkpoints and acknowledged writes after lease loss', async () => {
  const { scope, installed, operations } = await startDiagnosis();
  const saver = PostgresSaver.fromConnString(database.runtimeUrl, { schema: 'itervane_checkpoint' });
  const replacementSaver = PostgresSaver.fromConnString(database.runtimeUrl, { schema: 'itervane_checkpoint' });
  try {
    const guard = new GuardedCheckpointer(coordinator, scope, saver, { operations });
    const config = { configurable: { thread_id: `operations:${scope.runId}` } };
    const preflight = new GuardedCheckpointer(coordinator, scope, saver);
    const first = emptyCheckpoint();
    await expect(guard.getTuple({ configurable: { ...config.configurable, checkpoint_id: first.id } })).rejects.toBeInstanceOf(ExecutionLost);
    await expect(guard.getTuple({ configurable: { thread_id: preflight.threadId } })).rejects.toBeInstanceOf(ExecutionLost);
    await expect(preflight.getTuple({ configurable: { thread_id: preflight.threadId } })).rejects.toBeInstanceOf(ExecutionLost);
    expect(await guard.getTuple(config)).toBeUndefined();
    for (const mismatch of [{ inputSha256: sha256('incorrect diagnosis input') }, { providerSha256: sha256('different model') }]) {
      const wrong = new GuardedCheckpointer(coordinator, scope, saver, { operations: { ...operations, ...mismatch } });
      await expect(wrong.getTuple(config)).rejects.toBeInstanceOf(ExecutionLost);
    }
    const bound = await guard.put(config, first, { source: 'input', step: -1, parents: {} }, {});
    const metadata = { source: 'loop', step: 0, parents: {} } as const;
    await expect(guard.put(bound, first, metadata, {})).rejects.toBeInstanceOf(ExecutionLost);
    await guard.putWrites(bound, [['reserved', 'container']], 'recorded-node');
    await saver.putWrites(bound, [['reserved', 'logs']], 'unpublished-node');

    const orphan = emptyCheckpoint();
    const retiring = new AbortController();
    const interrupted = new GuardedCheckpointer(coordinator, scope, saver, { operations, signal: retiring.signal });
    const put = saver.put.bind(saver);
    const hook = vi.spyOn(saver, 'put').mockImplementationOnce(async (...args) => {
      const saved = await put(...args);
      retiring.abort(new Error('Worker retired before pointer publication'));
      return saved;
    });
    try { await expect(interrupted.put(bound, orphan, metadata, {})).rejects.toThrow('Worker retired before pointer publication'); }
    finally { hook.mockRestore(); }
    expect((await saver.getTuple({ configurable: { ...config.configurable, checkpoint_id: orphan.id } }))?.checkpoint.id).toBe(orphan.id);
    expect((await guard.getTuple(config))?.checkpoint.id).toBe(first.id);
    await expect(guard.getTuple({ configurable: { ...config.configurable, checkpoint_id: orphan.id } })).rejects.toBeInstanceOf(ExecutionLost);

    const recovered = await reclaimDiagnosis(scope, installed);
    await expect(guard.getTuple(config)).rejects.toBeInstanceOf(ExecutionLost);
    await expect(guard.put(bound, emptyCheckpoint(), metadata, {})).rejects.toBeInstanceOf(ExecutionLost);
    await expect(guard.putWrites(bound, [['reserved', 'release']], 'expired-node')).rejects.toBeInstanceOf(ExecutionLost);
    const pointer = operationsDiagnosisRuntime;
    await expect(database.storage.db.update(pointer).set({ checkpointId: orphan.id, checkpointStep: 0 }).where(eq(pointer.runId, scope.runId)))
      .rejects.toMatchObject({ cause: { code: '23514', message: 'operations_diagnosis_pointer_lease_required' } });
    const replacement = new GuardedCheckpointer(coordinator, recovered, replacementSaver, { operations });
    const tuple = await replacement.getTuple(config);
    expect(tuple?.checkpoint.id).toBe(first.id);
    expect(tuple?.pendingWrites).toEqual([['recorded-node', 'reserved', 'container']]);
    const next = emptyCheckpoint();
    await replacement.put(bound, next, metadata, {});
    expect((await database.storage.db.select().from(pointer)).at(0)).toMatchObject({
      runId: scope.runId, inputSha256: operations.inputSha256, checkpointId: next.id, checkpointStep: 0,
      workerId: recovered.workerId, publishedFence: recovered.fence,
    });
    await expect(database.storage.db.update(pointer).set({ checkpointId: first.id }).where(eq(pointer.runId, scope.runId)))
      .rejects.toMatchObject({ cause: { code: '23514', message: 'operations_diagnosis_pointer_regression' } });
  } finally { await Promise.all([saver.end(), replacementSaver.end()]); }
});

it.each(['cancel', 'revoke', 'remap'] as const)('denies diagnosis checkpoint reads and writes after %s', async mode => {
  const { fixture, task, scope, operations } = await startDiagnosis();
  const saver = PostgresSaver.fromConnString(database.runtimeUrl, { schema: 'itervane_checkpoint' });
  try {
    const guard = new GuardedCheckpointer(coordinator, scope, saver, { operations });
    const config = { configurable: { thread_id: guard.threadId } };
    const first = emptyCheckpoint();
    const bound = await guard.put(config, first, { source: 'input', step: -1, parents: {} }, {});
    if (mode === 'cancel') {
      const current = await fixture.taskService.get(identity, task.id);
      await fixture.taskService.cancel(identity, task.id, { expectedVersion: current.version });
    } else if (mode === 'revoke') {
      await database.storage.db.delete(workspaceMembers);
    } else {
      await registerOperationsTarget(database.storage, { ...fixture.registration,
        whiskers: { ...fixture.registration.whiskers, serverId: 'updated-diagnosis-enrollment' } });
    }
    const expected = mode === 'revoke' ? { code: 'not_found' }
      : mode === 'remap' ? { reason: 'operations_target_changed' } : { message: 'execution_lost' };
    await expect(guard.getTuple(config)).rejects.toMatchObject(expected);
    await expect(guard.put(bound, emptyCheckpoint(), { source: 'loop', step: 0, parents: {} }, {})).rejects.toMatchObject(expected);
    await expect(guard.putWrites(bound, [['late', true]], 'expired')).rejects.toMatchObject(expected);
    expect((await saver.getTuple(config))?.checkpoint.id).toBe(first.id);
  } finally { await saver.end(); }
});

it('resumes a diagnosis Agent from its stored evidence and final checkpoint without duplicating observations', async () => {
  const { fixture, installed, scope, input, operations } = await startDiagnosis();
  const store = new OperationsEvidenceStore(coordinator, installed);
  const container = { containerId: fixture.runtime.containerId, serverId: fixture.registration.whiskers.serverId,
    observedAt: new Date().toISOString(), state: 'running' } as const;
  const metrics = { containerId: container.containerId, serverId: container.serverId, observedAt: container.observedAt,
    status: 'observed', period: '1h', dataPoints: 3, cpu: { minimum: 1, average: 3, maximum: 9 },
    memory: { minimum: 45, average: 92, maximum: 98 } } satisfies Extract<OperationsDiagnosisObservation, { section: 'metrics' }>['result'];
  const readDownstream = vi.fn(async (execution: ExecutionScope, section: OperationsDiagnosisSection) => {
    if (section === 'container') return { proofSha256: sha256('frozen container fact'), result: container };
    if (section === 'metrics') return { proofSha256: sha256('frozen metrics fact'), result: metrics };
    if (section === 'release') return coordinator.withLease(execution, async (tx, current) =>
      readOperationsReleaseEvidence(tx, await requireActor(tx, identity), current.operationsRequest!));
    throw new Error('Unexpected observation');
  });
  const model = scriptedOperations();
  const complete = vi.fn(model.complete);
  const run = async (execution: ExecutionScope, pauseAfter?: 'decision' | 'reservation') => {
    const saver = PostgresSaver.fromConnString(database.runtimeUrl, { schema: 'itervane_checkpoint' });
    try {
      return await createFormalOperations({
        input, serverId: container.serverId, checkpointer: new GuardedCheckpointer(coordinator, execution, saver, { operations }),
        model: { ...model, complete }, providerSha256: operations.providerSha256,
        authorize: (_agent, signal) => coordinator.withLease(execution, async () => !signal.aborted),
        async read({ section, operationId }) {
          const reserved = await store.reserve(execution, section, operationId);
          if (reserved.state === 'recorded') return reserved.evidence;
          const fact = await readDownstream(execution, section);
          return store.record(execution, operationId, { ...fact, kind: 'operations_section', section });
        },
      }).run(pauseAfter ? { pauseAfter } : undefined);
    } finally { await saver.end(); }
  };
  expect(await run(scope, 'decision')).toMatchObject({ status: 'paused', usage: { turns: 1, toolCalls: 0 } });
  const paused = await run(scope, 'reservation');
  expect(paused).toMatchObject({ status: 'paused', usage: { turns: 1, toolCalls: 1 } });
  const operationId = sha256(paused.bindingSha256 + ':1');
  await store.reserve(scope, 'container', operationId);
  await store.record(scope, operationId, { ...await readDownstream(scope, 'container'), kind: 'operations_section', section: 'container' });
  const successor = await reclaimDiagnosis(scope, installed);
  const completed = await run(successor);
  expect(completed).toMatchObject({
    status: 'completed', reason: 'operations_review_complete', checkpointId: expect.any(String), usage: { turns: 4, toolCalls: 3 },
    formalOperations: { recommendation: { code: 'continue_observation' }, hypotheses: [{ code: 'memory_pressure' }] },
  });
  const budget = (await database.storage.db.select().from(runRuntime).where(eq(runRuntime.runId, scope.runId))).at(0);
  expect(budget).toMatchObject({ checkpointId: null, toolsUsed: 3, maxTools: 4 });
  expect(readDownstream.mock.calls.map(([, section]) => section)).toEqual(['container', 'metrics', 'release']);
  expect(complete).toHaveBeenCalledTimes(4);
  expect(await run(successor)).toEqual(completed);
  expect(readDownstream).toHaveBeenCalledTimes(3);
  expect(complete).toHaveBeenCalledTimes(4);
  expect((await database.storage.db.select().from(operationsDiagnosisRuntime)).at(0)).toMatchObject({
    checkpointId: completed.checkpointId, workerId: successor.workerId, publishedFence: successor.fence,
  });
});

it('freezes diagnostic mode once and admits only a matching operations Worker', async () => {
  const fixture = await installedOperationsFixture();
  const installed = diagnosisInstallation(fixture);
  const input = { ...fixture.scope, locale: 'zh-CN', idempotencyKey: randomUUID() };
  await expect(fixture.taskService.admitOperations(identity, { ...input, diagnosisProviderSha256: installed.diagnosisProviderSha256 }))
    .rejects.toMatchObject({ code: 'invalid_input' });
  const [first, other] = await Promise.all([
    fixture.taskService.admitOperations(identity, input, installed), fixture.taskService.admitOperations(identity, input, installed),
  ]);
  expect([first.replayed, other.replayed].sort()).toEqual([false, true]);
  expect(first.task.id).toBe(other.task.id);
  expect(await fixture.taskService.admitOperations(identity, input, installedOperations(fixture)))
    .toEqual({ task: first.task, replayed: true });
  const [budget] = await database.storage.db.select().from(runRuntime).where(eq(runRuntime.runId, first.task.runId));
  expect(budget).toMatchObject({ maxTools: 4, toolsUsed: 0 });
  const [inputRow] = await database.storage.db.select().from(operationsDiagnosisInputs);
  const [taskRow] = await database.storage.db.select().from(taskRecords).where(eq(taskRecords.id, first.task.id));
  const snapshot = await database.storage.db.transaction(async tx => readOperationsDiagnosis(tx, taskRow!, first.task.runId,
    await readOperationsRequest(tx, taskRow!, first.task.runId)));
  expect(inputRow).toMatchObject({ runId: first.task.runId, inputSha256: snapshot?.sha256, providerSha256: installed.diagnosisProviderSha256 });
  expect(snapshot?.document).toMatchObject({ taskId: first.task.id, runId: first.task.runId, locale: 'zh-CN',
    request: { releaseOperationId: fixture.operationId, containerId: fixture.runtime.containerId,
      enrollmentSha256: fixture.enrollment.fingerprint } });
  expect(JSON.stringify(snapshot)).not.toContain(operationsFixtureKey);
  await expect(database.storage.pool.query('UPDATE itervane.operations_diagnosis_inputs SET provider_sha256=$1 WHERE run_id=$2',
    [sha256('other profile'), first.task.runId])).rejects.toMatchObject({ code: '23514', message: 'operations_diagnosis_input_is_immutable' });

  for (const incompatible of [installedOperations(fixture), { ...installed, diagnosisProviderSha256: sha256('wrong provider') },
    { ...installed, enrollmentSha256: sha256('wrong enrollment') }]) {
    await expect(claimOperations(incompatible)).resolves.toBeNull();
    expect(await fixture.taskService.get(identity, first.task.id)).toMatchObject({ state: 'queued' });
  }
  await expect(claimOperations(installed)).resolves.toMatchObject({ runId: first.task.runId, taskId: first.task.id });
});

it('settles only the scoped operations diagnosis through the Worker and its three verified reads', async () => {
  const fixture = await installedOperationsFixture();
  const operations = diagnosisInstallation(fixture);
  const { task } = await fixture.taskService.admitOperations(identity, { ...fixture.scope, idempotencyKey: randomUUID() }, operations);
  const auditModel = { adapter: scriptedOperations(), providerSha256: operations.diagnosisProviderSha256 };
  expect(() => new DurableWorker(database.storage, database.runtimeUrl, { operations })).toThrow('diagnosis model');
  const whiskers = scopedWhiskers(fixture, undefined, 'running');
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { operations, auditModel, leaseSeconds: 30 });
  try { expect(await worker.tick()).toBe(true); }
  finally { await worker.close(); whiskers.restore(); }
  expect(whiskers.tools).toEqual(['get_container_details', 'get_container_metrics']);

  expect(await fixture.taskService.get(identity, task.id)).toMatchObject({ state: 'succeeded' });
  const [result] = await database.storage.db.select().from(operationsDiagnosisResults);
  const [container] = await database.storage.db.select().from(operationsObservations);
  const [event] = await database.storage.db.select().from(taskEvents)
    .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.type, 'task.operations_observed')));
  const receipt = operationsDiagnosisReceiptSchema.parse(result?.document);
  expect(result?.sha256).toBe(sha256(JSON.stringify(receipt)));
  expect(receipt).toMatchObject({
    runId: task.runId, taskId: task.id, providerSha256: operations.diagnosisProviderSha256, observationSha256: container?.sha256,
    usage: { turns: 4, toolCalls: 3 }, result: { hypotheses: [{ code: 'memory_pressure' }], recommendation: { code: 'continue_observation' } },
  });
  expect(receipt.reads.map(read => read.section)).toEqual(['container', 'metrics', 'release']);
  expect(event).toMatchObject({ workerId: worker.id, detail: {
    runId: task.runId, releaseOperationId: fixture.operationId, observationSha256: container?.sha256, diagnosisSha256: result?.sha256,
  } });
  expect(JSON.stringify(result)).not.toContain(operationsFixtureKey);
  await expect(new OperationsObservationViewService(database.storage).get(identity, task.id, 'zh-CN')).resolves
    .toMatchObject({ state: 'succeeded', observation: { state: 'running' }, reason: 'operations_diagnosed', reasonMessage: '已记录诊断结论及其证据。' });
  await expect(database.storage.db.delete(operationsDiagnosisResults)).rejects
    .toMatchObject({ cause: { code: '23514', message: 'operations_diagnosis_result_is_immutable' } });
});

function scriptedRestartDiagnosis(): ModelAdapter {
  const scripted = scriptedOperations();
  return { ...scripted, async complete(input) {
    const response = await scripted.complete(input);
    const call = response.calls[0];
    if (call?.name !== 'finish_role') return response;
    const draft = finishOperationsInputSchema.parse(call.input);
    return operationsDecision('finish_role', { ...draft, recommendation: { ...draft.recommendation, code: 'review_restart' } });
  } };
}

it('rolls back diagnosis settlement on event failure and replays the published conclusion after takeover', async () => {
  const { fixture, installed, scope } = await startDiagnosis();
  const scripted = scriptedRestartDiagnosis();
  const complete = vi.fn(scripted.complete);
  const model = { adapter: { ...scripted, complete }, providerSha256: installed.diagnosisProviderSha256 };
  const whiskers = scopedWhiskers(fixture, undefined, 'exited');
  const run = async (lease: ExecutionScope) => {
    const saver = PostgresSaver.fromConnString(database.runtimeUrl, { schema: 'itervane_checkpoint' });
    try { await runFormalOperations(coordinator, lease, saver, installed, model, new AbortController().signal); }
    finally { await saver.end(); }
  };
  try {
    await database.admin.query(`ALTER TABLE itervane.task_events ADD CONSTRAINT injected_operations_event_failure
      CHECK (detail->>'diagnosisSha256' IS NULL) NOT VALID`);
    try { await expect(run(scope)).rejects.toMatchObject({ cause: { code: '23514', constraint: 'injected_operations_event_failure' } }); }
    finally { await database.admin.query('ALTER TABLE itervane.task_events DROP CONSTRAINT injected_operations_event_failure'); }
    expect(await database.storage.db.select().from(operationsDiagnosisResults)).toEqual([]);
    expect(await database.storage.db.select().from(operationsObservations)).toEqual([]);
    expect(await fixture.taskService.get(identity, scope.taskId)).toMatchObject({ state: 'running' });
    const [published] = await database.storage.db.select().from(operationsDiagnosisRuntime);
    expect(published).toMatchObject({ runId: scope.runId, publishedFence: scope.fence });
    const reads = await database.storage.db.select().from(operationsDiagnosisReads);
    expect(reads).toHaveLength(3);
    expect(reads.every(read => read.state === 'recorded')).toBe(true);
    expect(JSON.stringify(reads)).not.toContain('local-log-canary-value');
    expect(complete).toHaveBeenCalledTimes(4);
    expect(whiskers.tools).toEqual(['get_container_details', 'get_container_logs']);

    const successor = await reclaimDiagnosis(scope, installed);
    await expect(run(scope)).rejects.toBeInstanceOf(ExecutionLost);
    await run(successor);
    const [result] = await database.storage.db.select().from(operationsDiagnosisResults);
    expect(result).toMatchObject({ workerId: successor.workerId, fence: successor.fence, checkpointId: published?.checkpointId,
      document: { result: { recommendation: { code: 'review_restart' } } } });
    expect(await fixture.taskService.get(identity, scope.taskId)).toMatchObject({ state: 'succeeded' });
    expect(whiskers.tools).toEqual(['get_container_details', 'get_container_logs']);
    expect(complete).toHaveBeenCalledTimes(4);
  } finally { whiskers.restore(); }
});

const repairDiagnosisSections = ['container', 'release', 'logs'] as const;
const scriptedRepairDiagnosis: ModelAdapter = { protocol: 'anthropic', async complete({ conversation }) {
  const message = conversation[0];
  if (message?.kind !== 'user') throw new Error('Missing diagnosis context');
  const { observations } = JSON.parse(message.text) as { observations: { id: string; data: { section: OperationsDiagnosisSection } }[] };
  const missing = repairDiagnosisSections.find(section => !observations.some(item => item.data.section === section));
  if (missing) return chooseOperationsSection(missing);
  const logs = observations.find(item => item.data.section === 'logs')!;
  const release = observations.find(item => item.data.section === 'release')!;
  return operationsDecision('finish_role', { hypotheses: [{ code: 'application_error', evidenceIds: [logs.id] }],
    recommendation: { code: 'investigate_code', evidenceIds: [logs.id, release.id] } });
} };

type ProposalDiagnosisKind = 'restart' | 'rollback' | 'observe' | 'investigate';

async function settleProposalRun(kind: ProposalDiagnosisKind, fixture: Awaited<ReturnType<typeof installedOperationsFixture>>,
  installed: ReturnType<typeof diagnosisInstallation>, scope: ExecutionScope) {
  const adapter = kind === 'investigate' ? scriptedRepairDiagnosis : kind === 'restart' ? scriptedRestartDiagnosis() : scriptedOperations();
  const whiskers = scopedWhiskers(fixture, undefined, kind === 'observe' || kind === 'investigate' ? 'running' : 'exited');
  const saver = PostgresSaver.fromConnString(database.runtimeUrl, { schema: 'itervane_checkpoint' });
  try {
    await runFormalOperations(coordinator, scope, saver, installed, { adapter, providerSha256: installed.diagnosisProviderSha256 },
      new AbortController().signal);
  } finally { whiskers.restore(); await saver.end(); }
  const [diagnosis] = await database.storage.db.select().from(operationsDiagnosisResults)
    .where(eq(operationsDiagnosisResults.runId, scope.runId));
  if (!diagnosis) throw new Error('Expected a settled diagnosis');
  return diagnosis;
}

async function settleProposalDiagnosis(kind: ProposalDiagnosisKind, prepared?: Awaited<ReturnType<typeof installedOperationsFixture>>) {
  const context = await startDiagnosis(prepared);
  const { fixture, installed, scope } = context;
  const diagnosis = await settleProposalRun(kind, fixture, installed, scope);
  return { ...context, diagnosis, service: new OperationsProposalService(database.storage, installed) };
}

it('freezes one linked repair proposal with verified source and the original health trigger', async () => {
  const fixture = await incidentMonitorFixture();
  const sample = await fixture.sample({ status: 'unhealthy', reason: 'application_unhealthy', evidenceSha256: sha256('application fixture failure') });
  const queued = await fixture.makeScheduler().tick();
  if (queued.status !== 'queued') throw new Error('Expected scheduled diagnosis');
  const lease = await claimOperations(fixture.worker);
  if (!lease) throw new Error('Expected scheduled lease');
  const diagnosis = await settleProposalRun('investigate', fixture.application, fixture.worker, lease);
  const service = new OperationsRepairProposalService(database.storage, fixture.installation);
  const input = { diagnosisSha256: diagnosis.sha256 };
  const before = await database.storage.db.select({ id: taskRecords.id }).from(taskRecords);
  const attempts = await Promise.all([service.freeze(identity, queued.taskId, input), service.freeze(identity, queued.taskId, input)]);
  expect(attempts.map(item => item.replayed).sort()).toEqual([false, true]);
  expect(attempts[0]!.proposal.id).toBe(attempts[1]!.proposal.id);
  const proposal = attempts[0]!.proposal;
  const { manifest, fingerprint, id } = fixture.application.approval;
  const document = readOperationsRepairProposal(proposal);
  expect(document).toMatchObject({ diagnosis: { taskId: queued.taskId, runId: queued.runId, sha256: diagnosis.sha256 },
    target: { releaseOperationId: fixture.application.operationId, containerId: fixture.application.runtime.containerId,
      mappingSha256: fixture.installation.mappingSha256, enrollmentSha256: fixture.installation.enrollmentSha256 },
    incident: { id: sample.incidentId, sampleSequence: sample.sequence },
    source: { candidateId: id, candidateSha256: fingerprint, git: manifest.source, releaseTaskId: manifest.taskId,
      originalSnapshotSha256: manifest.originalSnapshotSha256, deployedSnapshotSha256: manifest.repairedSnapshotSha256,
      patchSha256: manifest.diffSha256, originSha256: sha256(origin) } });
  expect(Date.parse(document.validUntil)).toBe(diagnosis.createdAt.getTime() + fixture.application.target.approvalTtlSeconds * 1_000);
  expect(JSON.stringify(document)).not.toContain('local-log-canary-value');
  expect(await database.storage.db.select().from(operationsRepairProposals)).toHaveLength(1);
  expect((await database.storage.db.select({ id: taskRecords.id }).from(taskRecords)).map(row => row.id).sort()).toEqual(before.map(row => row.id).sort());
  await expect(database.storage.db.delete(operationsRepairProposals).where(eq(operationsRepairProposals.id, proposal.id)))
    .rejects.toMatchObject({ cause: { code: '23514', message: 'operations_repair_proposal_is_immutable' } });
}, 45_000);

it('checks linked repair permissions and proposal input without inventing an event for manual diagnosis', async () => {
  const { task: diagnosisTask, diagnosis, fixture } = await settleProposalDiagnosis('investigate');
  const service = new OperationsRepairProposalService(database.storage, healthInstallation(fixture));
  const input = { diagnosisSha256: diagnosis.sha256 };
  const [principal] = await database.storage.db.insert(principals).values({ issuer: issuer.config.issuer, subject: 'repair-proposal-reader' }).returning();
  const reader = await createIdentityVerifier(issuer.config)(await issuer.token('repair-proposal-reader'));
  await expect(service.freeze(reader, diagnosisTask.id, input)).rejects.toMatchObject({ code: 'not_found' });
  await database.storage.db.insert(projectMembers).values({ projectId: fixture.scope.projectId, principalId: principal!.id, role: 'viewer' });
  await expect(service.freeze(reader, diagnosisTask.id, input)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(service.freeze(identity, diagnosisTask.id, { ...input, repositoryId: randomUUID() })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(service.freeze(identity, diagnosisTask.id, { diagnosisSha256: sha256('other run') })).rejects.toMatchObject({ code: 'version_conflict' });
  await database.storage.db.update(projectMembers).set({ role: 'maintainer' }).where(eq(projectMembers.principalId, principal!.id));
  const proposal = await service.freeze(reader, diagnosisTask.id, input);
  expect(readOperationsRepairProposal(proposal.proposal).incident).toBeNull();
  await database.storage.db.update(projectMembers).set({ role: 'viewer' }).where(eq(projectMembers.principalId, principal!.id));
  await expect(service.freeze(identity, diagnosisTask.id, input)).rejects.toMatchObject({ code: 'forbidden' });
  const observation = await settleProposalDiagnosis('observe', fixture);
  await expect(service.freeze(identity, observation.task.id, { diagnosisSha256: observation.diagnosis.sha256 }))
    .rejects.toMatchObject({ code: 'unsupported_state' });
  expect(await database.storage.db.select().from(operationsRepairProposals)).toHaveLength(1);
}, 45_000);

it('rejects a linked repair proposal when the repository or current publication has changed', async () => {
  const { task: diagnosisTask, diagnosis, fixture } = await settleProposalDiagnosis('investigate');
  const service = new OperationsRepairProposalService(database.storage, healthInstallation(fixture));
  const input = { diagnosisSha256: diagnosis.sha256 };
  const repositoryFilter = eq(repositories.id, diagnosisTask.source.repositoryId);
  await database.storage.db.update(repositories).set({ url: 'https://source.example.invalid/replaced.git' }).where(repositoryFilter);
  await expect(service.freeze(identity, diagnosisTask.id, input)).rejects.toMatchObject({ code: 'version_conflict' });
  await database.storage.db.update(repositories).set({ url: origin }).where(repositoryFilter);
  const replacement = await (await competingPublication(fixture)).confirm();
  await finishTestRollout(await parkForRollout(replacement, true, 'd'.repeat(24)), 'standard-v3');
  await expect(service.freeze(identity, diagnosisTask.id, input)).rejects.toMatchObject({ code: 'version_conflict' });
  expect(await database.storage.db.select().from(operationsRepairProposals)).toHaveLength(0);
}, 45_000);

it('rejects a linked repair proposal after the diagnosis confirmation window', async () => {
  const fixture = await installedOperationsFixture();
  await database.admin.query(`ALTER TABLE itervane.operations_diagnosis_results
    ALTER COLUMN created_at SET DEFAULT clock_timestamp() - interval '1 day'`);
  const saved = await settleProposalDiagnosis('investigate', fixture).finally(() =>
    database.admin.query('ALTER TABLE itervane.operations_diagnosis_results ALTER COLUMN created_at SET DEFAULT now()'));
  const service = new OperationsRepairProposalService(database.storage, healthInstallation(fixture));
  await expect(service.freeze(identity, saved.task.id, { diagnosisSha256: saved.diagnosis.sha256 })).rejects.toMatchObject({ code: 'unsupported_state' });
  expect(await database.storage.db.select().from(operationsRepairProposals)).toHaveLength(0);
}, 45_000);

async function proposedLinkedRepair() {
  const context = await settleProposalDiagnosis('investigate');
  const installation = healthInstallation(context.fixture);
  const { proposal } = await new OperationsRepairProposalService(database.storage, installation)
    .freeze(identity, context.task.id, { diagnosisSha256: context.diagnosis.sha256 });
  const clientId = 'itervane-linked-repair-portal';
  const approver = await createIdentityVerifier(issuer.config)(await issuer.token('owner', { azp: clientId }));
  const service = new OperationsRepairAdmission(database.storage, installation, clientId);
  const input = { fingerprint: proposal.fingerprint, locale: 'zh-CN' };
  return { ...context, proposal, input, approver, admission: service, confirm: () => service.confirm(approver, proposal.id, input) };
}

it('enqueues one linked repair task after scoped portal confirmation', async () => {
  const fixture = await proposedLinkedRepair();
  const { admission, approver, input, proposal } = fixture;
  await expect(admission.confirm(identity, proposal.id, input)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(admission.confirm(approver, proposal.id, { ...input, fingerprint: sha256('other proposal') }))
    .rejects.toMatchObject({ code: 'version_conflict' });
  await expect(admission.confirm(approver, proposal.id, { ...input, commit: 'e'.repeat(40) }))
    .rejects.toMatchObject({ code: 'invalid_input' });
  const admitted = await Promise.all([fixture.confirm(), fixture.confirm()]);
  expect(admitted.map(item => item.replayed).sort()).toEqual([false, true]);
  const linked = admitted[0]!.task;
  expect(admitted[1]?.task).toEqual(linked);
  expect(linked).toMatchObject({ source: fixture.task.source, projectId: fixture.task.projectId, state: 'queued',
    locale: 'zh-CN', purpose: translate('zh-CN', 'operations.incident.repairPurpose') });
  const links = await database.storage.db.select().from(operationsRepairAdmissions);
  expect(links).toMatchObject([{ proposalId: proposal.id, taskId: linked.id, runId: linked.runId,
    actorId: linked.requestedBy, sourceCommit: linked.source.commit, selfConfirmed: true }]);
  await expect(admission.confirm(approver, proposal.id, { ...input, locale: 'en' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  await expect(database.storage.db.delete(operationsRepairAdmissions))
    .rejects.toMatchObject({ cause: { code: '23514', message: 'operations_repair_admission_is_immutable' } });
  const scope = await claimOperations(fixture.installed);
  if (!scope) throw new Error('Expected the linked repair to use the normal execution lease');
  expect(scope).toMatchObject({ taskId: linked.id, runId: linked.runId });
  const recovered = await reclaimDiagnosis(scope, fixture.installed);
  expect(recovered).toMatchObject({ taskId: linked.id, runId: linked.runId });
  expect(recovered.fence).toBeGreaterThan(scope.fence);
  await expect(coordinator.withLease(scope, async () => {})).rejects.toBeInstanceOf(ExecutionLost);
  await coordinator.stop(recovered, 'operations_review_required');
}, 45_000);

it('shares linked repair requests and progress over HTTP and MCP with portal-only confirmation', async () => {
  const { task, diagnosis, fixture, installed } = await settleProposalDiagnosis('investigate');
  const publicUrl = 'https://itervane.example';
  const portalClientId = 'itervane-linked-repair-portal';
  const api = createApi(database.storage, { ...issuer.config, operationsApi: installed, publicUrl, portalClientId }, { logger: false });
  const path = `/v1/tasks/${task.id}/operations-repair`;
  const subject = 'linked-repair-viewer';
  const [member] = await database.storage.db.insert(principals).values({ issuer: issuer.config.issuer, subject }).returning();
  const viewer = await issuer.token(subject);
  const owner = await issuer.token('owner');
  const portal = await issuer.token('owner', { azp: portalClientId });
  const read = new Client({ name: 'repair-reader', version: '0.1.0' });
  const write = new Client({ name: 'repair-requester', version: '0.1.0' });
  const get = (authorization: string, locale = 'zh-CN') => api.inject({ url: path,
    headers: { authorization: `Bearer ${authorization}`, 'Accept-Language': locale } });
  const post = (url: string, authorization: string, payload: Record<string, string>) => api.inject({ method: 'POST', url, payload,
    headers: { authorization: `Bearer ${authorization}`, 'Accept-Language': 'zh-CN' } });
  const input = { diagnosisSha256: diagnosis.sha256 };
  try {
    expect((await get(viewer)).statusCode).toBe(404);
    await database.storage.db.insert(projectMembers).values({ projectId: fixture.scope.projectId, principalId: member!.id, role: 'viewer' });
    expect(operationsRepairViewSchema.parse((await get(viewer)).json())).toMatchObject({ draft: null, proposal: null });
    expect(operationsRepairViewSchema.parse((await get(owner)).json())).toMatchObject({ draft: input, proposal: null });
    expect((await post(path, viewer, input)).statusCode).toBe(403);
    expect((await post(path, owner, { diagnosisSha256: sha256('another diagnosis') })).statusCode).toBe(409);

    const endpoint = new URL('/mcp', await api.listen({ host: '127.0.0.1', port: 0 }));
    const connect = async (client: Client, username: string, scope: string) => {
      const token = await issuer.token(username, { aud: `${publicUrl}/mcp`, scope });
      await client.connect(new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { authorization: `Bearer ${token}`, 'Accept-Language': 'en' } },
      }));
    };
    await connect(read, subject, 'itervane:read');
    await connect(write, 'owner', 'itervane:read itervane:write');
    expect((await read.listTools()).tools.filter(tool => tool.name.includes('operations_repair')).map(tool => tool.name)).toEqual(['get_operations_repair']);
    expect((await write.listTools()).tools.filter(tool => tool.name.includes('operations_repair'))
      .map(tool => [tool.name, tool.annotations?.readOnlyHint])).toEqual([['get_operations_repair', true], ['request_operations_repair', false]]);
    const request = { name: 'request_operations_repair', arguments: { taskId: task.id, ...input } };
    await expect(read.callTool(request)).rejects.toThrow(/itervane:write/);
    const prepared = operationsRepairViewSchema.parse((await write.callTool(request)).structuredContent);
    expect(prepared).toMatchObject({ taskId: task.id, runId: task.runId, draft: null, locale: 'en', proposal: {
      status: 'pending', message: translate('en', 'operations.linked_repair.pending'), mayConfirm: false,
      source: { ...task.source, requiresMaterializedCommit: false },
      target: { environmentId: fixture.scope.environmentId, releaseOperationId: fixture.operationId, restoreExecutionId: null },
    } });
    const proposal = prepared.proposal!;
    const replay = await post(path, owner, input);
    expect(replay.statusCode).toBe(200);
    expect(operationsRepairViewSchema.parse(replay.json()).proposal).toMatchObject({ id: proposal.id, fingerprint: proposal.fingerprint,
      message: translate('zh-CN', 'operations.linked_repair.pending'), mayConfirm: false });
    expect(operationsRepairViewSchema.parse((await get(portal)).json()).proposal?.mayConfirm).toBe(true);
    const lookup = { name: 'get_operations_repair', arguments: { taskId: task.id } };
    expect(operationsRepairViewSchema.parse((await read.callTool(lookup)).structuredContent)).toEqual(prepared);

    const confirmation = `/v1/operations/repair-proposals/${proposal.id}/confirm`;
    const approval = { fingerprint: proposal.fingerprint, locale: 'zh-CN' };
    expect((await post(confirmation, owner, approval)).statusCode).toBe(403);
    expect((await post(confirmation, portal, { ...approval, fingerprint: sha256('wrong fingerprint') })).statusCode).toBe(409);
    const results = await Promise.all([post(confirmation, portal, approval), post(confirmation, portal, approval)]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 202]);
    const admissions = results.map(result => admissionDtoSchema.parse(result.json()));
    expect(admissions[0]!.task).toEqual(admissions[1]!.task);
    const linked = admissions[0]!.task;
    const projection = operationsRepairViewSchema.parse((await get(owner, 'en')).json());
    expect(projection.proposal).toMatchObject({ id: proposal.id, status: 'confirmed', mayConfirm: false,
      linkedTask: { taskId: linked.id, runId: linked.runId, state: 'queued' } });
    expect(operationsRepairViewSchema.parse((await read.callTool(lookup)).structuredContent)).toEqual(projection);
    await database.storage.db.delete(projectMembers).where(eq(projectMembers.principalId, member!.id));
    expect((await get(viewer)).statusCode).toBe(404);
    expect(apiErrorSchema.parse((await read.callTool(lookup)).structuredContent).error.code).toBe('not_found');
  } finally {
    await Promise.all([read.close(), write.close()]);
    await api.close();
  }
}, 55_000);

it('projects a stale linked repair proposal after publication changes and refuses confirmation', async () => {
  const { fixture, installed, task, proposal, input } = await proposedLinkedRepair();
  const portalClientId = 'itervane-linked-repair-portal';
  const api = createApi(database.storage, { ...issuer.config, operationsApi: installed, portalClientId }, { logger: false });
  const headers = { authorization: `Bearer ${await issuer.token('owner', { azp: portalClientId })}` };
  const lookup = () => api.inject({ url: `/v1/tasks/${task.id}/operations-repair`, headers });
  try {
    expect(operationsRepairViewSchema.parse((await lookup()).json()).proposal?.mayConfirm).toBe(true);
    const replacement = await (await competingPublication(fixture)).confirm();
    await finishTestRollout(await parkForRollout(replacement, true, 'd'.repeat(24)), 'standard-v3');
    expect(operationsRepairViewSchema.parse((await lookup()).json()).proposal).toMatchObject({
      id: proposal.id, status: 'stale', mayConfirm: false, linkedTask: null,
    });
    const response = await api.inject({ method: 'POST', url: `/v1/operations/repair-proposals/${proposal.id}/confirm`, headers, payload: input });
    expect(response.statusCode).toBe(409);
    expect(await database.storage.db.select().from(operationsRepairAdmissions)).toEqual([]);
  } finally { await api.close(); }
}, 45_000);

it('rolls back a linked repair task and its initial wakeup when the confirmation cannot commit', async () => {
  const fixture = await proposedLinkedRepair();
  const countJobs = () => database.admin.query('SELECT count(*)::int AS count FROM itervane_queue.job WHERE name=$1', [queueName]);
  const before = await countJobs();
  await database.admin.query(`ALTER TABLE itervane.operations_repair_admissions
    ADD CONSTRAINT repair_admission_fixture CHECK (self_confirmed = false)`);
  try {
    await expect(fixture.confirm()).rejects.toMatchObject({ cause: { code: '23514', constraint: 'repair_admission_fixture' } });
    expect(await database.storage.db.select().from(taskRecords).where(eq(taskRecords.requestKey, `linked-repair:${fixture.proposal.id}`))).toEqual([]);
    expect(await database.storage.db.select().from(operationsRepairAdmissions)).toEqual([]);
    expect((await countJobs()).rows).toEqual(before.rows);
  } finally { await database.admin.query('ALTER TABLE itervane.operations_repair_admissions DROP CONSTRAINT repair_admission_fixture'); }
  expect(await fixture.confirm()).toMatchObject({ task: { state: 'queued' }, replayed: false });
}, 45_000);

it('blocks a queued linked repair after the portal owner grant is replaced', async () => {
  const fixture = await proposedLinkedRepair();
  const { task: linked } = await fixture.confirm();
  const [removed] = await database.storage.db.delete(workspaceMembers).returning();
  await database.storage.db.insert(workspaceMembers).values({ workspaceId: removed!.workspaceId, principalId: removed!.principalId });
  await expect(fixture.confirm()).rejects.toMatchObject({ code: 'forbidden' });
  expect(await claimOperations(fixture.installed)).toBeNull();
  expect(await fixture.fixture.taskService.get(identity, linked.id)).toMatchObject({ state: 'needs_human' });
  const events = await fixture.fixture.taskService.events(identity, linked.id, 10);
  expect(events.at(-1)).toMatchObject({ type: 'task.needs_human', reason: 'permission_revoked' });
}, 45_000);

it('requires the diagnosed publication to remain current when confirming a linked repair', async () => {
  const fixture = await proposedLinkedRepair();
  const replacement = await (await competingPublication(fixture.fixture)).confirm();
  await finishTestRollout(await parkForRollout(replacement, true, 'd'.repeat(24)), 'standard-v3');
  await expect(fixture.confirm()).rejects.toMatchObject({ code: 'version_conflict' });
  expect(await database.storage.db.select().from(operationsRepairAdmissions)).toHaveLength(0);
}, 45_000);

it('rejects confirmation of a linked repair after the frozen proposal expires', async () => {
  await database.admin.query(`ALTER TABLE itervane.operations_diagnosis_results
    ALTER COLUMN created_at SET DEFAULT clock_timestamp() - interval '1796 seconds'`);
  const fixture = await proposedLinkedRepair().finally(() =>
    database.admin.query('ALTER TABLE itervane.operations_diagnosis_results ALTER COLUMN created_at SET DEFAULT now()'));
  await database.admin.query("SELECT pg_sleep_until($1::timestamptz + interval '20 milliseconds')", [fixture.proposal.validUntil]);
  await expect(fixture.confirm()).rejects.toMatchObject({ code: 'unsupported_state' });
  expect(await database.storage.db.select().from(operationsRepairAdmissions)).toHaveLength(0);
}, 45_000);

it.each(['matched', 'different content', 'changed origin'] as const)('gates linked repair audit on the deployed source (%s)', async variant => {
  const fixture = await proposedLinkedRepair();
  const { task: linked } = await fixture.confirm();
  if (variant === 'changed origin') await database.storage.db.update(repositories).set({ url: 'https://source.example.invalid/replaced.git' })
    .where(eq(repositories.id, linked.source.repositoryId));
  const inspect = vi.fn<InspectionRunner['inspect']>(async (request, authorize) => {
    await authorize();
    const receipt = testReceipt(request);
    if (variant === 'different content') {
      receipt.snapshot.manifestSha256 = sha256('different inspected files');
      for (const report of receipt.snapshot.reports) report.snapshotSha256 = receipt.snapshot.manifestSha256;
    }
    return receipt;
  });
  const audit = vi.fn(concludeAudit);
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { runner: inspectionRunner(inspect), auditModel: auditModel(audit) });
  try { await processAdmittedTestTask(worker); } finally { await worker.close(); }
  const event = (await fixture.fixture.taskService.events(identity, linked.id, 20)).at(-1);
  expect(inspect).toHaveBeenCalledTimes(variant === 'changed origin' ? 0 : 1);
  const stored = await database.storage.db.select().from(formalAuditResults).where(eq(formalAuditResults.runId, linked.runId));
  if (variant === 'matched') {
    expect(audit).toHaveBeenCalled();
    expect(stored).toHaveLength(1);
    expect(event).toMatchObject({ type: 'task.audit_recorded', reason: 'audit_ready' });
  } else {
    expect(audit).not.toHaveBeenCalled();
    expect(stored).toHaveLength(0);
    expect(event).toMatchObject({ type: 'task.inspection_paused', reason: 'inspection_source_mismatch', state: 'waiting_input' });
    const inspection = await new InspectionService(database.storage).get(identity, linked.id);
    expect(inspection).toMatchObject({ status: 'blocked', reason: 'inspection_source_mismatch', scanCompleted: false });
  }
}, 45_000);

it('rechecks the linked repair environment and original publication before release approval', async () => {
  const fixture = await proposedLinkedRepair();
  const { task: linked } = await fixture.confirm();
  const reviewing = scriptedVerification('zh-CN');
  const worker = new DurableWorker(database.storage, database.runtimeUrl, {
    runner: inspectionRunner(async (request, authorize) => { await authorize(); return testReceipt(request); }),
    auditModel: auditModel(request => {
      const context = request.conversation[0];
      return context?.kind === 'user' && JSON.parse(context.text).role === 'verify' ? reviewing.complete(request) : concludeAudit(request);
    }),
    verification: { profile: standardVerificationProfile, runner: {
      observe: async () => idleRepairRunner(),
      verify: async (coordinates, input, repair, authorize) => {
        await authorize();
        const [stored] = await database.storage.db.select().from(inspectionAttempts).where(eq(inspectionAttempts.runId, linked.runId));
        const original = qualifiedInspectionResponseSchema.parse(stored?.receipt);
        if (original.kind !== 'receipt') throw new Error('Missing verified linked source');
        const request = prepareQualifiedVerificationRequest(coordinates, canonicalVerificationCommand({ input, repair }));
        return standardVerificationReceipt(original, request, input);
      },
      verifyArchive: async archive => ({ kind: 'archive_verified', version: 1, runnerImageSha256: imageSha256, archive }),
    } },
  });
  try { await processAdmittedTestTask(worker); } finally { await worker.close(); }
  const current = await fixture.fixture.taskService.get(identity, linked.id);
  const release = new FormalReleaseService(database.storage, fixture.approver.clientId);
  const input = { environmentId: fixture.fixture.scope.environmentId, expectedVersion: current.version };
  await expect(release.freeze(identity, linked.id, { ...input, environmentId: randomUUID() }, 'zh-CN'))
    .rejects.toMatchObject({ code: 'version_conflict' });
  const { candidate } = await release.freeze(identity, linked.id, input, 'zh-CN');
  const replacement = await (await competingPublication(fixture.fixture)).confirm();
  await finishTestRollout(await parkForRollout(replacement, true, 'd'.repeat(24)), 'standard-v3');
  await expect(release.decide(fixture.approver, candidate.id, { action: 'confirm', fingerprint: candidate.fingerprint,
    expectedVersion: 0, idempotencyKey: randomUUID() }, 'zh-CN')).rejects.toMatchObject({ code: 'version_conflict' });
  expect(await database.storage.db.select().from(releaseDecisions).where(eq(releaseDecisions.candidateId, candidate.id))).toEqual([]);
}, 45_000);

async function confirmIncidentReproduction() {
  const monitor = await incidentMonitorFixture();
  const { application, installation } = monitor;
  const evidenceSha256 = sha256('protected health sample for reproduction');
  const sample = await monitor.sample({ status: 'unhealthy', reason: 'application_unhealthy', evidenceSha256 });
  const queued = await monitor.makeScheduler().tick();
  if (queued.status !== 'queued') throw new Error('Expected scheduled diagnosis');
  const lease = await claimOperations(monitor.worker);
  if (!lease) throw new Error('Expected scheduled lease');
  const diagnosis = await settleProposalRun('investigate', application, monitor.worker, lease);
  const { proposal } = await new OperationsRepairProposalService(database.storage, installation)
    .freeze(identity, queued.taskId, { diagnosisSha256: diagnosis.sha256 });
  const portal = 'itervane-reproduction-portal';
  const approver = await createIdentityVerifier(issuer.config)(await issuer.token('owner', { azp: portal }));
  const { task: linked } = await new OperationsRepairAdmission(database.storage, installation, portal).confirm(approver, proposal.id,
    { fingerprint: proposal.fingerprint, locale: 'zh-CN' });
  return { application, diagnosis, proposal, sample, evidenceSha256, linked, portal };
}

it('projects the authorized incident history and task associations in both locales', async () => {
  const { application, sample, linked, diagnosis, proposal } = await confirmIncidentReproduction();
  const operationsApi = diagnosisInstallation(application);
  const api = createApi(database.storage, { ...issuer.config, operationsApi }, { logger: false });
  const viewerId = randomUUID();
  const viewerSubject = 'incident-project-viewer';
  await database.storage.db.insert(principals).values({ id: viewerId, issuer: issuer.config.issuer, subject: viewerSubject });
  await database.storage.db.insert(projectMembers).values({ projectId: application.scope.projectId, principalId: viewerId, role: 'viewer' });
  const token = await issuer.token(viewerSubject);
  const scope = application.scope;
  const url = `/v1/projects/${scope.projectId}/environments/${scope.environmentId}/operations-incidents`;
  const context = (taskId: string) => `/v1/tasks/${taskId}/operations-incident`;
  const get = (url: string, locale = 'en', bearer = token) => api.inject({
    url, headers: { authorization: `Bearer ${bearer}`, 'Accept-Language': locale },
  });
  try {
    const [english, chinese] = await Promise.all([get(url), get(url + '?limit=1', 'zh-CN')]);
    expect(english.statusCode).toBe(200);
    expect(chinese.statusCode).toBe(200);
    expect(chinese.headers['content-language']).toBe('zh-CN');
    expect(chinese.headers['cache-control']).toBe('no-store');
    const en = operationsIncidentsViewSchema.parse(english.json());
    const zh = operationsIncidentsViewSchema.parse(chinese.json());
    expect(en).toMatchObject({ ...scope, locale: 'en', items: [{ id: sample.incidentId, closedAt: null, diagnosisStop: null,
      latestSample: { sequence: sample.sequence, signal: { status: 'unhealthy', reason: 'application_unhealthy' } },
      diagnoses: [{ taskId: diagnosis.document.taskId, runId: diagnosis.runId, sampleSequence: sample.sequence, state: 'succeeded' }],
      repairs: [{ proposalId: proposal.id, diagnosisRunId: diagnosis.runId, taskId: linked.id, state: 'queued' }],
    }] });
    expect(zh.items[0]?.message).not.toBe(en.items[0]?.message);
    expect(zh.latestHealth?.message).not.toBe(en.latestHealth?.message);
    expect(JSON.stringify(zh)).not.toMatch(/containerId|grantId|enrollmentSha256|configDigest|publicationProofSha256/);
    const taskViews = await Promise.all([get(context(diagnosis.document.taskId), 'zh-CN'), get(context(linked.id)), get(context(task.id))]);
    expect(taskViews.map(result => result.statusCode)).toEqual([200, 200, 200]);
    expect(taskIncidentViewSchema.parse(taskViews[0]!.json())).toMatchObject({ relatedAs: 'diagnosis', incident: zh.items[0] });
    expect(taskIncidentViewSchema.parse(taskViews[1]!.json())).toMatchObject({ relatedAs: 'linked_repair', incident: en.items[0] });
    expect(taskIncidentViewSchema.parse(taskViews[2]!.json())).toMatchObject({ relatedAs: null, incident: null });

    const journal = new OperationsHealthJournal(database.storage, healthInstallation(application));
    const recovered = await journal.recordProbe((await journal.prepareProbe()).probe, recoveredHealth);
    const unavailable = await journal.recordProbe((await journal.prepareProbe()).probe, unavailableHealth);
    const history = operationsIncidentsViewSchema.parse((await get(url, 'zh-CN')).json());
    expect(history).toMatchObject({ latestHealth: { sequence: unavailable.sequence, signal: { status: 'unavailable' } }, items: [{
      id: sample.incidentId, closedReason: 'recovered', latestSample: { sequence: recovered.sequence, signal: { status: 'healthy' } },
    }] });

    const stranger = await new ResourceService(database.storage).createProject(identity, { name: 'Other incident scope', slug: 'other-incident-scope' });
    expect((await get(url.replace(scope.projectId, stranger.id), 'en', await issuer.token())).statusCode).toBe(404);
    expect((await get(url.replace(scope.environmentId, randomUUID()))).statusCode).toBe(404);
    expect((await get(url + '?limit=101')).statusCode).toBe(400);
    await database.storage.db.delete(projectMembers).where(eq(projectMembers.principalId, viewerId));
    expect((await get(url)).statusCode).toBe(404);
    expect((await get(context(linked.id))).statusCode).toBe(404);
  } finally { await api.close(); }
}, 45_000);

it.each(['queued', 'running'] as const)('stops automatic diagnosis while retaining the %s task and its MCP history', async state => {
  const fixture = await incidentMonitorFixture();
  const { application, worker: operationsApi } = fixture;
  const sample = await fixture.sample();
  if (!sample.incidentId) throw new Error('Expected open incident');
  const admission = await fixture.makeScheduler().tick();
  if (admission.status !== 'queued') throw new Error('Expected one queued diagnosis');
  const active = state === 'running' ? await claimOperations(operationsApi) : null;
  if (state === 'running' && !active) throw new Error('Expected diagnosis lease');

  const publicUrl = 'https://itervane.example';
  const portalClientId = 'itervane-operations-portal';
  const api = createApi(database.storage, { ...issuer.config, operationsApi, publicUrl, portalClientId }, { logger: false });
  const portal = await issuer.token('owner', { azp: portalClientId });
  const owner = await issuer.token();
  const token = await issuer.token('owner', { aud: `${publicUrl}/mcp`, scope: 'itervane:read' });
  const mcp = new Client({ name: 'incident-readonly', version: '0.1.0' });
  const { scope } = application;
  const list = `/v1/projects/${scope.projectId}/environments/${scope.environmentId}/operations-incidents`;
  const stop = list + `/${sample.incidentId}/stop-diagnosis`;
  const lookup = `/v1/tasks/${admission.taskId}/operations-incident`;
  const get = (url: string, authorization = owner) => api.inject({ url,
    headers: { authorization: `Bearer ${authorization}`, 'Accept-Language': 'zh-CN' } });
  const body = { expectedReleaseOperationId: application.operationId, expectedRestoreExecutionId: null };
  const post = (authorization: string, payload = body) => api.inject({ method: 'POST', url: stop, payload,
    headers: { authorization: `Bearer ${authorization}`, 'Accept-Language': 'zh-CN' } });
  try {
    expect(taskIncidentViewSchema.parse((await get(lookup)).json()).stopDiagnosis).toBeNull();
    expect(taskIncidentViewSchema.parse((await get(lookup, portal)).json()).stopDiagnosis).toEqual(scope);
    expect((await post(owner)).statusCode).toBe(403);
    expect((await post(portal, { ...body, expectedReleaseOperationId: randomUUID() })).statusCode).toBe(409);
    const concurrent = await Promise.all([post(portal), post(portal)]);
    expect(concurrent.map(response => response.statusCode)).toEqual([200, 200]);
    const stops = concurrent.map(response => operationsIncidentStopResultSchema.parse(response.json()));
    expect(stops.map(value => value.replayed).sort()).toEqual([false, true]);
    expect(stops[0]).toMatchObject({ incidentId: sample.incidentId, reason: 'operator_stopped', locale: 'zh-CN' });
    expect(stops[1]?.stoppedAt).toBe(stops[0]?.stoppedAt);
    const [operator] = await database.storage.db.select().from(workspaceMembers);
    const [incident] = await database.storage.db.select().from(operationsIncidents).where(eq(operationsIncidents.id, sample.incidentId));
    expect(incident).toMatchObject({ diagnosisStoppedBy: operator?.principalId, diagnosisStopGrantId: operator?.grantId,
      diagnosisStoppedAt: new Date(stops[0]!.stoppedAt), diagnosisStopReason: 'operator_stopped' });
    await expect(database.storage.db.update(operationsIncidents).set({ diagnosisStopGrantId: randomUUID() })
      .where(eq(operationsIncidents.id, sample.incidentId))).rejects
      .toMatchObject({ cause: { code: '23514', message: 'operations_incident_stop_is_immutable' } });
    if (active) {
      await expect(coordinator.withLease(active, async () => true)).rejects.toMatchObject({ code: 'unsupported_state' });
      await coordinator.stop(active, 'operations_review_required');
    } else expect(await claimOperations(operationsApi)).toBeNull();
    expect((await fixture.sample()).incidentId).toBe(sample.incidentId);
    expect(await fixture.makeScheduler().tick()).toEqual({ status: 'stopped', reason: 'operator_stopped' });
    expect(await database.storage.db.select().from(operationsIncidentDiagnoses)).toHaveLength(1);

    const address = await api.listen({ host: '127.0.0.1', port: 0 });
    await mcp.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { authorization: `Bearer ${token}`, 'Accept-Language': 'zh-CN' } },
    }));
    const incidentTools = (await mcp.listTools()).tools.filter(tool => tool.name === 'list_operations_incidents' || tool.name === 'get_task_incident');
    expect(incidentTools).toHaveLength(2);
    expect(incidentTools.every(tool => tool.annotations?.readOnlyHint)).toBe(true);
    const history = operationsIncidentsViewSchema.parse((await get(list)).json());
    const visible = (await mcp.callTool({ name: 'list_operations_incidents', arguments: scope })).structuredContent;
    expect(operationsIncidentsViewSchema.parse(visible)).toEqual(history);
    expect(history.items[0]?.diagnosisStop).toMatchObject({ at: stops[0]?.stoppedAt, reason: 'operator_stopped' });
    const detail = (await mcp.callTool({ name: 'get_task_incident', arguments: { taskId: admission.taskId } })).structuredContent;
    const projected = taskIncidentViewSchema.parse((await get(lookup, portal)).json());
    expect(projected.stopDiagnosis).toBeNull();
    expect(taskIncidentViewSchema.parse(detail)).toEqual(projected);
    const outside = await mcp.callTool({ name: 'list_operations_incidents', arguments: { ...scope, environmentId: randomUUID() } });
    expect(apiErrorSchema.parse(outside.structuredContent).error.code).toBe('not_found');
  } finally { await mcp.close(); await api.close(); }
}, 55_000);

it.each(['unhealthy', 'passed', 'unavailable', 'missing', 'revoked'] as const)
  ('settles a verified linked health reproduction (%s) with bounded evidence', async outcome => {
    const { application, diagnosis, proposal, sample, evidenceSha256, linked, portal } = await confirmIncidentReproduction();
    const reviewing = scriptedVerification('zh-CN');
    const verify = vi.fn<RescanRunner['verify']>(async (coordinates, input, repair, authorize) => {
      await authorize();
      expect(input.healthRegression).toEqual({ proposalId: proposal.id, diagnosisSha256: diagnosis.sha256,
        publicationProofSha256: readOperationsRepairProposal(proposal).target.publicationProofSha256,
        incidentId: sample.incidentId, sampleSequence: sample.sequence, sampleEvidenceSha256: evidenceSha256 });
      expect(input.subject.kind).toBe('original');
      expect(input.profile.ociInputsSha256).toBeUndefined();
      expect(input.profile.retainStandardImage).toBeUndefined();
      const [stored] = await database.storage.db.select().from(inspectionAttempts).where(eq(inspectionAttempts.runId, linked.runId));
      const original = qualifiedInspectionResponseSchema.parse(stored?.receipt);
      if (original.kind !== 'receipt') throw new Error('Missing verified linked source');
      const request = prepareQualifiedVerificationRequest(coordinates, canonicalVerificationCommand({ input, repair }));
      expect(request.healthFollowup).toBe(true);
      const receipt = standardVerificationReceipt(original, request, input);
      const baseline = receipt.snapshot.build?.status === 'built' ? receipt.snapshot.build.baseline : undefined;
      if (baseline?.status !== 'passed') throw new Error('Missing standard baseline');
      if (outcome === 'revoked') {
        await database.storage.db.delete(workspaceMembers).where(eq(workspaceMembers.principalId, linked.requestedBy));
        await authorize();
      }
      if (outcome !== 'missing') baseline.healthFollowup = outcome === 'unhealthy'
        ? { status: 'unhealthy', code: 'application_unhealthy', statusCode: 503 }
        : outcome === 'passed' ? { status: 'passed', code: null, statusCode: 200 }
        : { status: 'unavailable', code: 'unexpected_content', statusCode: 503 };
      return receipt;
    });
    const worker = new DurableWorker(database.storage, database.runtimeUrl, {
      runner: inspectionRunner(async (request, authorize) => { await authorize(); return testReceipt(request); }),
      auditModel: auditModel(request => {
        const context = request.conversation[0];
        return context?.kind === 'user' && JSON.parse(context.text).role === 'verify' ? reviewing.complete(request) : concludeAudit(request);
      }),
      verification: { profile: standardVerificationProfile, runner: { observe: async () => idleRepairRunner(), verify } },
    });
    try { await processAdmittedTestTask(worker); } finally { await worker.close(); }
    expect(verify).toHaveBeenCalledTimes(1);
    const [current] = await database.storage.db.select().from(taskRecords).where(eq(taskRecords.id, linked.id));
    const [attempt] = await database.storage.db.select().from(formalRescanAttempts).where(eq(formalRescanAttempts.runId, linked.runId));
    const [result] = await database.storage.db.select().from(formalVerificationResults).where(eq(formalVerificationResults.runId, linked.runId));
    if (outcome === 'missing' || outcome === 'revoked') {
      expect(attempt?.state).toBe('uncertain');
      expect(result).toBeUndefined();
      expect(current?.state).toBe(outcome === 'missing' ? 'reconciling' : 'needs_human');
      return;
    }
    const events = await application.taskService.events(identity, linked.id, 30, 'zh-CN');
    expect(events.at(-1)).toMatchObject({ type: 'task.verification_recorded', state: 'needs_human',
      reason: outcome === 'unhealthy' ? 'operations_reproduction_observed'
        : outcome === 'passed' ? 'operations_reproduction_not_observed' : 'operations_reproduction_unavailable' });
    expect(attempt).toMatchObject({ state: 'recorded', receiptSha256: result?.receiptSha256 });
    expect(result?.document).toMatchObject({ evidence: { baseline: { status: 'passed', failures: [], healthFollowup: { status: outcome } },
      image: { status: 'not_requested' } }, review: { outcome: outcome === 'unhealthy' ? 'checks_failed' : 'incomplete' } });
    await expect(new FormalReleaseService(database.storage, portal).freeze(identity, linked.id,
      { environmentId: application.scope.environmentId, expectedVersion: current!.version }, 'zh-CN'))
      .rejects.toMatchObject({ code: 'unsupported_state' });
  }, 45_000);

it.each(['recovered', 'still unhealthy', 'revoked grant', 'enqueue rollback'] as const)
  ('continues a reproduced health incident with at most one bounded repair (%s)', async outcome => {
    const { application, linked, portal } = await confirmIncidentReproduction();
    const original = 'export const secondHealth = 503;\n';
    const repaired = 'export const secondHealth = 200;\n';
    const range = { startByte: 0, endByte: Buffer.byteLength(original), sha256: sha256(original) };
    let scan: QualifiedInspectionReceipt | undefined;
    let candidate: QualifiedRepairReceipt['snapshot']['candidate'] | undefined;
    const observeRepair = vi.fn<RepairObservationRunner['observeRepair']>(async (request, workspace, targets, authorize) => {
      await authorize();
      expect(targets).toEqual([{ kind: 'health_reproduction', findingId: workspace.healthReproductionSha256,
        path: standardHealthRepairPath, line: null }]);
      expect(request.generation).toBe(2);
      return repairObservationReceipt(scan!, request, workspace, targets, original, range);
    });
    const repair = vi.fn<RepairRunner['repair']>(async (request, workspace, patch, authorize) => {
      await authorize();
      expect(workspace.editablePaths).toEqual([standardHealthRepairPath]);
      expect(workspace.healthReproductionSha256).toBeTruthy();
      expect(patch.files).toEqual([{ path: standardHealthRepairPath, beforeSha256: sha256(original),
        edits: [{ startByte: 0, endByte: range.endByte, replacement: repaired }] }]);
      const receipt = repairReceipt(scan!, request, workspace, patch, original);
      candidate = receipt.snapshot.candidate;
      return receipt;
    });
    const verify = vi.fn<RescanRunner['verify']>(async (coordinates, input, patch, authorize) => {
      await authorize();
      const request = prepareQualifiedVerificationRequest(coordinates, canonicalVerificationCommand({ input, repair: patch }));
      expect(request.healthFollowup).toBe(true);
      const fixed = input.subject.kind === 'repair';
      if (fixed) {
        expect(input.profile).toEqual(standardVerificationProfile);
        expect(input.healthReproduction?.previousRunId).toBe(linked.runId);
        expect(input.subject.manifestSha256).toBe(candidate?.candidateManifestSha256);
        expect(patch?.workspace.healthReproductionSha256).toBe(input.healthReproduction?.receiptSha256);
      } else expect(input.profile.ociInputsSha256).toBeUndefined();
      const receipt = standardVerificationReceipt(scan!, request, input, false, fixed ? candidate : undefined, 'linked healthy');
      const baseline = receipt.snapshot.build?.status === 'built' ? receipt.snapshot.build.baseline : undefined;
      if (baseline?.status !== 'passed') throw new Error('Expected trusted baseline');
      if (fixed && outcome === 'recovered') baseline.healthFollowup = { status: 'passed', code: null, statusCode: 200 };
      else { delete baseline.image; baseline.healthFollowup = { status: 'unhealthy', code: 'application_unhealthy', statusCode: 503 }; }
      return receipt;
    });
    const model = auditModel(async request => {
      const context = request.conversation[0];
      if (context?.kind !== 'user') throw new Error('Missing model context');
      const { role, observations, handoff, completionNeeds } = JSON.parse(context.text) as {
        role: string; observations: AgentEvidence[]; handoff: { healthReproduction?: { receiptSha256: string } }; completionNeeds: string[];
      };
      if (role === 'verify') return scriptedVerification('zh-CN').complete(request);
      if (role === 'audit') {
        if (completionNeeds.includes('health_reproduction')) return auditTurn('read_health_reproduction', {});
        if (completionNeeds.length) return concludeAudit(request);
        return auditTurn('finish_role', { summary: '已核对扫描与健康证据。', evidenceIds: observations.map(item => item.id), explanations: [] });
      }
      if (observations.some(item => item.data.kind === 'repair_failure')) return auditTurn('request_human', {});
      const finished = observations.find(item => item.data.kind === 'repair_candidate');
      if (finished) return auditTurn('finish_role', { evidenceId: finished.id, summary: '已更新第二次健康请求的处理。' });
      const observation = observations.find(item => item.data.kind === 'repair_targets');
      if (observation?.data.kind !== 'repair_targets') return auditTurn('read_repair_targets', { findingIds: [handoff.healthReproduction?.receiptSha256] });
      const target = observation.data.observation.targets[0];
      if (!target || !('kind' in target) || target.sourceText !== original || !target.range) throw new Error('Missing scoped source');
      return auditTurn('apply_repair_patch', { observationId: observation.id, targets: [{ targetIndex: 0,
        edits: [{ startByte: target.range.startByte, endByte: target.range.endByte, replacement: repaired }] }] });
    });
    const worker = () => new DurableWorker(database.storage, database.runtimeUrl, {
      runner: inspectionRunner(async (request, authorize) => { await authorize(); scan = testReceipt(request); return scan; }),
      auditModel: model, repair: { protectedPaths: [], runner: { observe: async () => idleRepairRunner(), observeRepair, repair } },
      verification: { profile: standardVerificationProfile, runner: { observe: async () => idleRepairRunner(), verify,
        verifyArchive: async archive => ({ kind: 'archive_verified', version: 1, runnerImageSha256: imageSha256, archive }),
      } },
    });
    const failEnqueue = outcome === 'enqueue rollback' ? vi.spyOn(database.storage.boss, 'send').mockResolvedValueOnce(null) : undefined;
    const initial = worker();
    try { await processAdmittedTestTask(initial); } finally { await initial.close(); failEnqueue?.mockRestore(); }
    const service = application.taskService;
    const queued = await service.get(identity, linked.id);
    const retries = () => database.storage.db.select().from(formalRepairRetries).where(eq(formalRepairRetries.taskId, linked.id));
    const [continuation] = await retries();
    if (outcome === 'enqueue rollback') {
      expect(queued).toMatchObject({ runId: linked.runId, state: 'needs_human' });
      expect(continuation).toBeUndefined();
      expect(await database.storage.db.select().from(formalVerificationResults).where(eq(formalVerificationResults.runId, linked.runId))).toEqual([]);
      return;
    }
    expect(queued).toMatchObject({ state: 'queued' });
    expect(continuation).toMatchObject({ runId: queued.runId, previousRunId: linked.runId, document: { kind: 'linked_health', generation: 2 } });
    expect((await service.events(identity, linked.id, 30, 'zh-CN')).at(-1)).toMatchObject({ type: 'task.repair_retry_queued' });
    const before = await new VerificationViewService(database.storage).get(identity, linked.id, 'en');
    expect(before.previous).toMatchObject({ outcome: 'checks_failed', baseline: { healthFollowup: { status: 'unhealthy' } } });
    if (outcome === 'revoked grant') {
      const [previous] = await database.storage.db.delete(workspaceMembers).where(eq(workspaceMembers.principalId, linked.requestedBy)).returning();
      await database.storage.db.insert(workspaceMembers).values({ workspaceId: previous!.workspaceId, principalId: previous!.principalId });
    }
    const resumed = worker();
    try { await processAdmittedTestTask(resumed); } finally { await resumed.close(); }
    const changed = await service.get(identity, linked.id);
    expect(await retries()).toHaveLength(1);
    expect(await database.storage.db.select().from(taskRuns).where(eq(taskRuns.taskId, linked.id))).toHaveLength(2);
    if (outcome === 'revoked grant') {
      expect(changed.state).toBe('needs_human');
      expect(observeRepair).not.toHaveBeenCalled();
      expect(repair).not.toHaveBeenCalled();
      expect(verify).toHaveBeenCalledTimes(1);
      return;
    }
    expect(observeRepair).toHaveBeenCalledTimes(1);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(2);
    const after = await new VerificationViewService(database.storage).get(identity, linked.id, 'zh-CN');
    const passed = outcome === 'recovered';
    expect(after.current).toMatchObject({ runId: queued.runId, outcome: passed ? 'observed' : 'checks_failed',
      baseline: { healthFollowup: { status: passed ? 'passed' : 'unhealthy' } } });
    if (after.current.status !== 'recorded') throw new Error('Missing repair verification');
    const cases = new LearningCaseService(database.storage);
    const evidence = { runId: changed.runId, evidenceSha256: after.current.resultSha256 };
    const releases = new FormalReleaseService(database.storage, portal);
    const freeze = () => releases.freeze(identity, linked.id, { environmentId: application.scope.environmentId, expectedVersion: changed.version }, 'zh-CN');
    if (!passed) {
      expect(changed.state).toBe('needs_human');
      await expect(freeze()).rejects.toMatchObject({ code: 'unsupported_state' });
      await expect(cases.capture(identity, linked.id, evidence, 'en')).rejects.toMatchObject({ code: 'unsupported_state' });
      return;
    }
    await expect(cases.capture(identity, linked.id, { ...evidence, runId: linked.runId }, 'en')).rejects.toMatchObject({ code: 'version_conflict' });
    await expect(cases.capture(identity, linked.id, { ...evidence, evidenceSha256: sha256('old result') }, 'en'))
      .rejects.toMatchObject({ code: 'version_conflict' });
    const [english, chinese] = await Promise.all([cases.capture(identity, linked.id, evidence, 'en'), cases.capture(identity, linked.id, evidence, 'zh-CN')]);
    expect([english.replayed, chinese.replayed].sort()).toEqual([false, true]);
    expect(english.item.document).toEqual(chinese.item.document);
    expect(english.item.title).not.toBe(chinese.item.title);
    expect(english.item.document).toMatchObject({ taskId: linked.id, runId: changed.runId, generation: 2,
      facts: { category: 'reproduced_health_failure', originalHealthStatus: 503, repairedHealthStatus: 200 } });
    expect(JSON.stringify(english.item)).not.toContain('export const secondHealth');
    await expect(database.storage.pool.query('UPDATE itervane.learning_cases SET document=document'))
      .rejects.toMatchObject({ code: '23514', message: 'learning_case_is_immutable' });
    const extraction = new RuleExtractionService(database.storage, extractionModel().providerSha256);
    const request = { caseSha256: english.item.sha256, idempotencyKey: randomUUID() };
    const first = await extraction.admit(identity, linked.projectId, english.item.id, request);
    const repeated = await extraction.admit(identity, linked.projectId, english.item.id, request);
    expect(repeated).toEqual({ task: first.task, replayed: true });
    expect(first.task).toMatchObject({ workflow: 'rule-extraction', state: 'queued' });
    const generated = await processExtraction(first.task);
    expect(generated).toMatchObject({ state: 'succeeded', result: { document: {
      extraction: { caseId: english.item.id, result: { outcome: 'candidate', candidate: { kind: 'code_rule' } } },
      usage: { turns: 3, toolCalls: 2 },
    } } });
    const candidateRecord = generated.result!;
    const validations = new CandidateValidationService(database.storage, { profile: validationProfile });
    const attempt = { extractionResultSha256: candidateRecord.sha256, locale: 'zh-CN', idempotencyKey: randomUUID() };
    await expect(validations.admit(identity, linked.projectId, candidateRecord.id, { ...attempt, extractionResultSha256: sha256('replaced extraction') }))
      .rejects.toMatchObject({ code: 'version_conflict' });
    const admissions = await Promise.all([validations.admit(identity, linked.projectId, candidateRecord.id, attempt),
      validations.admit(identity, linked.projectId, candidateRecord.id, attempt)]);
    expect(admissions.map(item => item.replayed).sort()).toEqual([false, true]);
    const validated = await processCandidateValidation(admissions[0]!.task, codeValidationOptions('passed'));
    expect(validated).toMatchObject({ state: 'succeeded', result: { document: { status: 'passed', candidateId: candidateRecord.id,
      evidence: { kind: 'code_rule', receipt: { sessionVerified: true, cleanupConfirmed: true } },
    } } });
    await expect(database.storage.pool.query('UPDATE itervane.candidate_validation_results SET document=document'))
      .rejects.toMatchObject({ code: '23514', message: 'candidate_validation_result_is_immutable' });
    let failedValidationId: string | undefined;
    for (const mode of ['false_positive', 'wrong_fence', 'blocked'] as const) {
      const entry = await validations.admit(identity, linked.projectId, candidateRecord.id, { ...attempt, idempotencyKey: randomUUID() });
      const checked = await processCandidateValidation(entry.task, codeValidationOptions(mode));
      expect(checked.state).toBe('needs_human');
      if (mode === 'false_positive') {
        expect(checked.result?.document.status).toBe('failed');
        failedValidationId = checked.result!.id;
      } else expect(checked.result).toBeNull();
      if (mode === 'blocked') expect(checked.message).toBe(translate('zh-CN', 'reason.candidate_validation_cleanup_unknown'));
    }
    const publishedRule = await assertCandidatePublication(validated.result!, portal, failedValidationId);
    const released = await validations.admit(identity, linked.projectId, candidateRecord.id, { ...attempt, idempotencyKey: randomUUID() });
    const obsolete = await processCandidateValidation(released.task, codeValidationOptions('expired'));
    expect(obsolete).toMatchObject({ state: 'running', result: null });
    const recovered = await processCandidateValidation(released.task, codeValidationOptions('passed'));
    expect(recovered).toMatchObject({ state: 'succeeded', result: { document: { status: 'passed' } } });
    const observations = await database.admin.query<{ fence: number }>(
      'SELECT fence FROM itervane.candidate_validation_attempts WHERE run_id=$1 ORDER BY fence', [released.task.runId]);
    expect(observations.rows).toHaveLength(2);
    expect(observations.rows[1]!.fence).toBeGreaterThan(observations.rows[0]!.fence);
    const replayedCase = await extraction.admit(identity, linked.projectId, english.item.id, { ...request, idempotencyKey: randomUUID() });
    const duplicate = await processExtraction(replayedCase.task);
    expect(duplicate).toMatchObject({ state: 'succeeded', result: { document: {
      extraction: { result: { outcome: 'duplicate', existingCandidateId: generated.result?.id } }, candidateSemanticSha256: null,
    } } });
    const later = await new TaskService(database.storage).admit(identity, { projectId: linked.projectId, source: linked.source,
      dataClass: 'synthetic', purpose: 'Check published rule snapshot', idempotencyKey: randomUUID() });
    expect(await database.storage.pool.query('SELECT document FROM itervane.task_rule_snapshots WHERE task_id=$1', [later.task.id]))
      .toMatchObject({ rows: [{ document: { purpose: 'delivery', entries: [{ kind: 'code_rule', versionId: publishedRule.versionId, sequence: 3 }] } }] });
    const laterScope = await claim();
    expect(laterScope.taskId).toBe(later.task.id);
    const inspect = vi.fn<InspectionRunner['inspect']>(async (request, authorize, _signal, published) => {
      await authorize();
      expect(published?.rules.input.snapshot.document.entries[0]).toMatchObject({ versionId: publishedRule.versionId, sequence: 3 });
      const { publishedCode, ...legacy } = request;
      expect(publishedCode).toEqual(published?.binding);
      const receipt = testReceipt(legacy);
      const { tree, totalBytes } = receipt.snapshot;
      const dimensions = { version: 1 as const, source: later.task.source, objectFormat: 'sha1' as const, tree,
        files: [{ path: 'api/readiness.mjs', mode: '100644' as const, bytes: totalBytes, sha256: sha256('synthetic bytes') }], totalBytes,
      };
      const manifest = { ...dimensions, sha256: sha256(JSON.stringify(dimensions)) };
      const { basis } = preparePublishedCodeScan(published!.rules, manifest);
      expect(basis.batches[0]?.fileCount).toBe(1);
      const finding = { ruleKey: publishedRule.packageKey, path: 'api/readiness.mjs',
        start: { line: 1, col: 1, offset: 0 }, end: { line: 1, col: 5, offset: 4 } };
      const document = { basis, reports: [{ language: 'javascript', status: 'checked', reportSha256: sha256('synthetic scanner output'),
        findings: [finding] }] };
      return qualifiedInspectionResponseSchema.parse({ ...receipt, scope: { ...receipt.scope, publishedCode },
        snapshot: { ...receipt.snapshot, manifestSha256: manifest.sha256,
          reports: receipt.snapshot.reports.map(report => ({ ...report, snapshotSha256: manifest.sha256 })),
          publishedCode: { commandSha256: published!.binding.commandSha256, manifest, scan: { sha256: sha256(JSON.stringify(document)), document } },
        },
      });
    });
    const inspected = inspectionRunner(inspect);
    const disconnected = new ToolGateway(coordinator, inspected);
    expect(await disconnected.call(laterScope, 'source.inspect', {}, 'profile-missing'))
      .toMatchObject({ status: 'business_error', code: 'runner_unavailable' });
    expect(inspect).not.toHaveBeenCalled();
    const delegated = new ToolGateway(coordinator, inspected, { ...validationProfile, runnerImageSha256: imageSha256 });
    expect(await delegated.call(laterScope, 'source.inspect', {}, 'published-rule-coverage'))
      .toMatchObject({ status: 'success', data: { coverage: 'complete' } });
    expect(inspect).toHaveBeenCalledTimes(1);
    const reading = new InspectionService(database.storage);
    expect(await reading.get(identity, later.task.id)).toMatchObject({
      status: 'completed', result: { publishedCode: { status: 'complete', findings: 1, checkedFiles: 1 } },
    });
    const approver = await createIdentityVerifier(issuer.config)(await issuer.token('owner', { azp: portal }));
    const activation = await new RulePackageActivationService(database.storage, portal).change(approver, publishedRule.packageId, {
      action: 'withdraw', expectedSequence: 3, versionId: publishedRule.versionId, versionSha256: publishedRule.sha256, idempotencyKey: randomUUID(),
    }, 'zh-CN');
    expect(activation.state.current).toBeNull();
    expect(await new ToolGateway(coordinator, inspected).call(laterScope, 'source.inspect', {}, 'historical-coverage'))
      .toMatchObject({ status: 'success', data: { coverage: 'complete' } });
    expect(inspect).toHaveBeenCalledTimes(1);
    let requestedEarlyFinish = false;
    let readPublishedScan = false;
    const scopedModel = auditModel(request => {
      const context = request.conversation[0];
      if (context?.kind !== 'user') throw new Error('Missing audit context');
      const { completionNeeds } = JSON.parse(context.text) as { completionNeeds: string[] };
      expect(context.text).not.toContain('api/readiness.mjs');
      if (completionNeeds.length === 1 && completionNeeds[0] === 'semgrep_ce') {
        expect(request.tools.some(tool => tool.name === 'finish_role')).toBe(false);
        if (!requestedEarlyFinish) {
          requestedEarlyFinish = true;
          return concludeAudit(request);
        }
        readPublishedScan = true;
        return Promise.resolve(auditTurn('read_scan', { scanner: 'semgrep_ce' }));
      }
      return concludeAudit(request);
    });
    const auditStorage = PostgresSaver.fromConnString(database.runtimeUrl, { schema: 'itervane_checkpoint' });
    try {
      await expect(runFormalAudit(coordinator, laterScope, auditStorage, scopedModel, new AbortController().signal, true, standardVerificationProfile))
        .resolves.toBe('settled');
    } finally { await auditStorage.end(); }
    expect(requestedEarlyFinish && readPublishedScan).toBe(true);
    const audited = await new FormalAuditService(database.storage).get(identity, later.task.id, 'zh-CN');
    expect(audited).toMatchObject({ status: 'recorded', result: { status: 'completed', evidence: expect.arrayContaining([
      expect.objectContaining({ kind: 'scan', scanner: 'semgrep_ce', totalFindings: 1 }),
    ]), checklist: { coverage: 'complete', findings: [{
      scanner: 'semgrep_ce', ruleId: publishedRule.packageKey, path: 'api/readiness.mjs', line: 1, certainty: 'confirmed', severity: 'unknown',
    }] } } });
    expect((await new TaskService(database.storage).events(identity, later.task.id, 25, 'zh-CN')).at(-1))
      .toMatchObject({ state: 'needs_human', reason: 'audit_published_rule_review' });
    expect(await database.storage.db.select().from(formalRepairInputs).where(eq(formalRepairInputs.runId, later.task.runId))).toHaveLength(0);
    const next = await new TaskService(database.storage).admit(identity, { projectId: linked.projectId, source: linked.source,
      dataClass: 'synthetic', purpose: 'Check withdrawn rule snapshot', idempotencyKey: randomUUID() });
    expect(await database.storage.pool.query('SELECT document FROM itervane.task_rule_snapshots WHERE task_id=$1', [next.task.id]))
      .toMatchObject({ rows: [{ document: { purpose: 'delivery', entries: [] } }] });
    const { candidate: release } = await freeze();
    expect(release.manifest.repairedSnapshotSha256).toBe(candidate?.candidateManifestSha256);
    const approved = await releases.decide(approver, release.id, { action: 'confirm', fingerprint: release.fingerprint,
      expectedVersion: 0, idempotencyKey: randomUUID() }, 'zh-CN');
    const [job] = await database.storage.boss.fetch(formalReleaseQueue, { includeMetadata: true });
    expect(job).toBeTruthy();
    const releaseClaim = await new FormalReleaseCoordinator(coordinator, releaseOrigin).claim(job!, randomUUID());
    expect(releaseClaim).toMatchObject({ operationId: approved.candidate.operationId, candidateId: release.id, mode: 'import' });
  }, 75_000);

it('freezes one immutable restart proposal from the settled diagnosis under concurrent requests', async () => {
  const current = await settleProposalDiagnosis('restart');
  const { fixture, diagnosis, task, service } = current;
  const input = { diagnosisSha256: diagnosis.sha256 };
  const principalId = randomUUID();
  const subject = 'operations-proposal-viewer';
  await database.storage.db.insert(principals).values({ id: principalId, issuer: issuer.config.issuer, subject });
  await database.storage.db.insert(projectMembers).values({ projectId: fixture.scope.projectId, principalId, role: 'viewer' });
  const viewer = await createIdentityVerifier(issuer.config)(await issuer.token(subject));
  await expect(service.freeze(viewer, task.id, input)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(service.freeze(identity, task.id, { ...input, action: 'rollback' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(service.freeze(identity, task.id, { diagnosisSha256: sha256('another diagnosis') })).rejects.toMatchObject({ code: 'version_conflict' });

  const attempts = await Promise.all([service.freeze(identity, task.id, input), service.freeze(identity, task.id, input)]);
  const [first, other] = attempts;
  expect(attempts.map(item => item.replayed).sort()).toEqual([false, true]);
  expect(other?.proposal.id).toBe(first?.proposal.id);
  const proposal = first!.proposal;
  const document = readOperationsProposal(proposal);
  expect(document).toMatchObject({ action: { kind: 'restart' },
    diagnosis: { taskId: task.id, runId: task.runId, sha256: diagnosis.sha256 },
    target: { environmentId: fixture.scope.environmentId, releaseOperationId: fixture.operationId, containerId: fixture.runtime.containerId,
      enrollmentSha256: fixture.enrollment.fingerprint, manifestDigest: fixture.image.manifestDigest } });
  expect(Date.parse(document.validUntil)).toBe(diagnosis.createdAt.getTime() + fixture.target.approvalTtlSeconds * 1_000);
  expect(JSON.stringify(document)).not.toContain(operationsFixtureKey);
  expect(await database.storage.db.select().from(operationsProposals)).toHaveLength(1);
  expect(await database.storage.db.select().from(releaseOperations)).toHaveLength(1);
  expect(await fixture.taskService.get(identity, task.id)).toMatchObject({ state: 'succeeded', version: task.version + 2 });
  await expect(database.storage.db.delete(operationsProposals)).rejects
    .toMatchObject({ cause: { code: '23514', message: 'operations_proposal_is_immutable' } });
});

it('binds a rollback intent and read-only takeover to the approved image after a repeated publication', async () => {
  const first = await installedOperationsFixture();
  task = (await first.taskService.admit(identity, { projectId: first.scope.projectId, source: task.source, purpose: 'Different verified release',
    dataClass: 'synthetic', locale: 'zh-CN', idempotencyKey: randomUUID() })).task;
  const release = { existingTarget: first.target, imageVariant: 'second verified release' };
  const second = await finishTestRollout(await parkForRollout(await queuedFormalRelease(release), true, 'd'.repeat(24)), 'standard-v3');
  task = (await first.taskService.admit(identity, { projectId: first.scope.projectId, source: task.source, purpose: 'Same image published again',
    dataClass: 'synthetic', locale: 'zh-CN', idempotencyKey: randomUUID() })).task;
  const next = await queuedFormalRelease(release);
  const { runtime, image } = await finishTestRollout(await parkForRollout(next, true, 'c'.repeat(24)), 'standard-v3');
  expect(image.manifestDigest).toBe(second.image.manifestDigest);
  const { diagnosis, installed, task: diagnosed, service } = await settleProposalDiagnosis('rollback', { ...first, ...next, runtime, image });
  const input = { diagnosisSha256: diagnosis.sha256 };
  const { proposal } = await service.freeze(identity, diagnosed.id, input);
  const frozen = readOperationsProposal(proposal);
  expect(frozen).toMatchObject({
    target: { releaseOperationId: next.operationId, manifestDigest: image.manifestDigest },
    action: { kind: 'rollback', restore: { operationId: first.operationId, manifestDigest: first.image.manifestDigest,
      configDigest: first.image.configDigest, proofSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } },
  });
  if (frozen.action.kind !== 'rollback') throw new Error('Expected an approved rollback image');
  expect(first.image.manifestDigest).not.toBe(image.manifestDigest);
  const owner = await decisionIdentity();
  const approvals = new OperationsDecisionService(database.storage, installed, operationsPortal);
  const coordinates = { proposalId: proposal.id, fingerprint: proposal.fingerprint, decisionVersion: 1 };
  await approvals.decide(owner, proposal.id, { fingerprint: coordinates.fingerprint, action: 'confirm', expectedVersion: 0, idempotencyKey: randomUUID() });
  const { execution, schedule } = await new OperationsExecutionAdmission(database.storage, installed).enqueue(coordinates);
  expect(execution).toMatchObject({ proposalId: proposal.id, proposalFingerprint: proposal.fingerprint, state: 'reserved' });
  await expect(first.taskService.get(identity, schedule.taskId)).resolves.toMatchObject({
    state: 'queued', runId: schedule.runId, purpose: translate('zh-CN', 'operations.execution.rollback'),
  });
  expect(await database.storage.db.select().from(releaseOperations)).toHaveLength(3);

  const executor = new OperationsExecutionCoordinator(coordinator, installed);
  const scope = await executor.claim(await fetchOperationsWakeup(operationsRestoreQueue), randomUUID());
  if (!scope) throw new Error('Expected the rollback dispatch lease');
  const { deploymentId, serverId, imageRepository, registryOrigin, runtimeConfigSha256, komodo, rolloutCheckSha256 } = next.target;
  const plan = operationsRestorePlanSchema.parse({ version: 1, environmentId: first.scope.environmentId,
    targetRevision: frozen.target.targetRevision, mappingSha256: frozen.target.mappingSha256, rolloutCheckSha256,
    target: { deploymentId, serverId, imageRepository, registryOrigin, runtimeConfigSha256, komodo },
    current: { operationId: next.operationId, containerId: runtime.containerId, manifestDigest: image.manifestDigest,
      configDigest: image.configDigest, proofSha256: frozen.targetProofSha256 },
    restore: { ...frozen.action.restore, publishedVersion: first.runtime.version },
  });
  const intentBinding = { executionId: execution.id, proposalFingerprint: proposal.fingerprint, decisionVersion: 1,
    generation: scope.generation, workerId: scope.workerId, fence: scope.fence };
  const releaseInstallation = { environmentId: first.scope.environmentId, mappingSha256: frozen.target.mappingSha256 };
  await expect(executor.prepareDispatch(scope)).rejects.toMatchObject({ code: 'unsupported_state' });
  await expect(executor.prepareRestoreDispatch(scope, { ...releaseInstallation, mappingSha256: sha256('wrong installation') }))
    .rejects.toMatchObject({ code: 'version_conflict' });
  await expect(database.storage.db.insert(operationsExecutionIntents).values(intentBinding))
    .rejects.toMatchObject({ cause: { code: '23514', message: 'operations_restore_plan_authority_required' } });
  const alteredPlans = [
    { ...plan, restore: { ...plan.restore, publishedVersion: runtime.version } },
    { ...plan, restore: { ...plan.restore, manifestDigest: 'sha256:' + sha256('unverified restore image') } },
    { ...plan, target: { ...plan.target, deploymentId: 'c'.repeat(24) } },
  ];
  for (const changed of alteredPlans) {
    await expect(database.storage.db.insert(operationsExecutionIntents).values({
      ...intentBinding, restorePlan: changed, restorePlanSha256: sha256(JSON.stringify(changed)),
    })).rejects.toMatchObject({ cause: { code: '23514', message: 'operations_restore_plan_authority_required' } });
  }
  await database.admin.query(`ALTER TABLE itervane.task_events ADD CONSTRAINT injected_restore_intent_event_failure
    CHECK (type <> 'task.operations_execution_dispatch_intended') NOT VALID`);
  try {
    await expect(executor.prepareRestoreDispatch(scope, releaseInstallation))
      .rejects.toMatchObject({ cause: { code: '23514', constraint: 'injected_restore_intent_event_failure' } });
    expect(await database.storage.db.select().from(operationsExecutionIntents)).toEqual([]);
  } finally { await database.admin.query('ALTER TABLE itervane.task_events DROP CONSTRAINT injected_restore_intent_event_failure'); }
  const { intent } = await executor.prepareRestoreDispatch(scope, releaseInstallation);
  expect(intent).toMatchObject({ ...intentBinding, restorePlan: plan, restorePlanSha256: sha256(JSON.stringify(plan)) });
  const fingerprint = sha256(JSON.stringify(plan));
  await expect(executor.beginRestoreStep(scope, 'deploy', fingerprint))
    .rejects.toMatchObject({ cause: { code: '23514', message: 'operations_restore_step_send_authority_required' } });
  const configAttempts = await Promise.allSettled([
    executor.beginRestoreStep(scope, 'configure', fingerprint), executor.beginRestoreStep(scope, 'configure', fingerprint),
  ]);
  expect(configAttempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1);
  expect(configAttempts.find(attempt => attempt.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
  await approvals.decide(owner, proposal.id, { fingerprint: coordinates.fingerprint, action: 'revoke', expectedVersion: 1, idempotencyKey: randomUUID() });
  await expect(database.storage.db.insert(operationsRestoreSteps).values({
    executionId: execution.id, kind: 'deploy', planSha256: fingerprint, workerId: scope.workerId, fence: scope.fence,
  })).rejects.toMatchObject({ cause: { code: '23514', message: 'operations_restore_step_send_authority_required' } });
  await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
  await coordinator.reconcile(randomUUID());
  const reader = await executor.claim(await fetchOperationsWakeup(operationsRestoreQueue), randomUUID());
  if (!reader) throw new Error('Expected read-only takeover');
  expect(reader).toMatchObject({ mode: 'reconcile', fence: scope.fence + 1 });
  await expect(executor.prepareDispatch(reader)).rejects.toBeInstanceOf(ExecutionLost);
  await expect(executor.readRestoreIntent(scope)).rejects.toBeInstanceOf(ExecutionLost);
  await expect(executor.readRestoreIntent(reader)).resolves.toEqual({ plan, sha256: intent.restorePlanSha256 });
  expect(await database.storage.db.select().from(operationsExecutionIntents)).toEqual([intent]);
  expect(await database.storage.db.select({ state: operationsExecutions.state }).from(operationsExecutions)).toEqual([{ state: 'reserved' }]);
});

async function restoreExecutionCandidate(prepared?: Awaited<ReturnType<typeof installedOperationsFixture>>, expiresSoon = false) {
  const earlier = prepared ?? await installedOperationsFixture();
  task = (await earlier.taskService.admit(identity, { projectId: earlier.scope.projectId, source: task.source, purpose: 'Publish a newer image',
    dataClass: 'synthetic', locale: 'en', idempotencyKey: randomUUID() })).task;
  const next = await queuedFormalRelease({ existingTarget: earlier.target, imageVariant: 'newer rollback fixture' });
  const current = await finishTestRollout(await parkForRollout(next, true, 'd'.repeat(24)), 'standard-v3');
  if (expiresSoon) await database.admin.query(`ALTER TABLE itervane.operations_diagnosis_results
    ALTER COLUMN created_at SET DEFAULT (now() - interval '1788 seconds')`);
  const { diagnosis, installed, task: diagnosed, service } = await settleProposalDiagnosis('rollback', { ...earlier, ...next, ...current })
    .finally(async () => {
      if (expiresSoon) await database.admin.query('ALTER TABLE itervane.operations_diagnosis_results ALTER COLUMN created_at SET DEFAULT now()');
    });
  const { proposal } = await service.freeze(identity, diagnosed.id, { diagnosisSha256: diagnosis.sha256 });
  const owner = await decisionIdentity();
  const decisions = new OperationsDecisionService(database.storage, installed, operationsPortal);
  const decision = { fingerprint: proposal.fingerprint };
  return { earlier, next, current, diagnosed, installed, proposal, owner, decisions, decision };
}

async function queuedRestore(prepared?: Awaited<ReturnType<typeof installedOperationsFixture>>, expiresSoon = false) {
  const candidate = await restoreExecutionCandidate(prepared, expiresSoon);
  const { installed, proposal, owner, decisions, decision } = candidate;
  await decisions.decide(owner, proposal.id, { ...decision, action: 'confirm', expectedVersion: 0, idempotencyKey: randomUUID() });
  const { execution, schedule } = await new OperationsExecutionAdmission(database.storage, installed)
    .enqueue({ ...decision, proposalId: proposal.id, decisionVersion: 1 });
  const executor = new OperationsExecutionCoordinator(coordinator, installed);
  return { ...candidate, execution, schedule, executor };
}

async function dispatchedRestore(outcome: 'acknowledged' | 'reply_lost' | 'prior_receipt' | 'approval_revoked',
  prepared?: Awaited<ReturnType<typeof installedOperationsFixture>>) {
  const { earlier, next, current, diagnosed, installed, proposal, owner, decisions, decision, execution, schedule, executor } = await queuedRestore(prepared);
  const scope = await executor.claim(await fetchOperationsWakeup(operationsRestoreQueue), randomUUID(), 'rollback');
  if (!scope) throw new Error('Expected a restore lease');
  const { deploymentId, serverId, runtimeConfigSha256 } = next.target;
  const config = { deploymentId, serverId, runtimeConfigSha256, imageReference: earlier.runtime.imageReference };
  const ack = { deploymentId, actorId: current.update.actorId, updateId: '8'.repeat(24), status: 'InProgress' as const, success: false };
  const sends: string[] = [];
  const worker = new OperationsRestoreWorker(executor, {
    ...earlier.scope, mappingSha256: current.binding.manifest.target.mappingSha256, network: current.runtime.network,
  }, {
    async configureImage(target, change, authorize, _signal, observe) {
      await observe?.();
      expect(target.deploymentId).toBe(deploymentId);
      expect(change).toEqual({ previousImage: current.runtime.imageReference, manifestDigest: earlier.image.manifestDigest });
      await authorize();
      expect(await database.storage.db.select().from(operationsRestoreSteps)).toMatchObject([{ kind: 'configure', receipt: null }]);
      sends.push('configure');
      return config;
    },
    async dispatch(target, digest, authorize, _signal, observe) {
      await observe?.();
      expect(target.deploymentId).toBe(deploymentId);
      expect(digest).toBe(earlier.image.manifestDigest);
      await authorize();
      expect(await database.storage.db.select().from(operationsRestoreSteps).orderBy(operationsRestoreSteps.kind))
        .toMatchObject([{ kind: 'configure', receipt: config }, { kind: 'deploy', receipt: null }]);
      sends.push('deploy');
      if (outcome === 'reply_lost') throw new Error('Native deploy response lost');
      if (outcome === 'prior_receipt') return { ...ack, updateId: current.update.updateId };
      return ack;
    },
  }, {
    async inspectStoppedRuntime(_target, image, network, authorize) {
      await authorize();
      expect(image.manifestDigest).toBe(current.image.manifestDigest);
      expect(network).toBe(current.runtime.network);
      return stoppedBaseline({ ...earlier, ...current });
    },
    async inspectTarget(_target, authorize) {
      await authorize();
      if (outcome === 'approval_revoked') {
        await decisions.decide(owner, proposal.id, { ...decision, action: 'revoke', expectedVersion: 1, idempotencyKey: randomUUID() });
      }
      return config;
    },
  });
  await expect(worker.dispatch(scope)).resolves.toBe('reconciling');
  expect(sends).toEqual(outcome === 'approval_revoked' ? ['configure'] : ['configure', 'deploy']);
  expect((await database.storage.pool.query('SELECT task_id FROM itervane.execution_slot')).rows[0]).toEqual({ task_id: null });
  await expect(earlier.taskService.get(identity, schedule.taskId)).resolves.toMatchObject({ state: 'reconciling' });
  expect((await database.storage.db.select().from(operationsExecutions).where(eq(operationsExecutions.id, execution.id)))[0]?.state)
    .toBe('reserved');
  const successor = await executor.claim(await fetchOperationsWakeup(operationsRestoreQueue), randomUUID(), 'rollback');
  if (!successor) throw new Error('Expected a read-only restore lease');
  return { earlier, current, diagnosed, installed, proposal, executor, scope, successor, execution, schedule, config, ack, sends };
}

it('shares authorized bilingual restore receipts through HTTP and MCP', async () => {
  const { earlier, current, diagnosed, installed, proposal, executor, successor, execution, schedule, ack } = await dispatchedRestore('acknowledged');
  const publicUrl = 'http://127.0.0.1:4330';
  const config = { ...issuer.config, publicUrl, portalClientId: operationsPortal, operationsApi: installed };
  const app = createApi(database.storage, config, { logger: false });
  const client = new Client({ name: 'restore-receipt-test', version: '0.0.0' });
  try {
    const subject = 'restore-receipt-viewer';
    const principalId = randomUUID();
    await database.storage.db.insert(principals).values({ id: principalId, issuer: config.issuer, subject });
    const authorization = `Bearer ${await issuer.token(subject)}`;
    const url = `/v1/tasks/${diagnosed.id}/operations-restore`;
    const fetchView = (locale: 'en' | 'zh-CN') => app.inject({ url, headers: { authorization, 'accept-language': locale } });
    expect((await fetchView('en')).statusCode).toBe(404);
    await database.storage.db.insert(projectMembers).values({ principalId, projectId: diagnosed.projectId, role: 'viewer' });
    const before = await fetchView('en');
    expect(before.statusCode).toBe(200);
    expect(operationsRestoreExecutionViewSchema.parse(before.json())).toMatchObject({ action: null,
      execution: { state: 'running', environmentHeld: true, nativeUpdateId: ack.updateId, recovery: { state: 'observing', proof: null } } });

    const runtime = { ...earlier.runtime, containerId: sha256('recovered for public receipt test') };
    await expect(executor.settleRestoreRecovery(successor, { update: { ...ack, status: 'Complete', success: true }, runtime })).resolves.toBe('verified');
    const [proof] = await database.storage.db.select().from(operationsRestoreRecoveries);
    const views = await Promise.all((['en', 'zh-CN'] as const).map(async locale => {
      const result = await fetchView(locale);
      expect(result.statusCode).toBe(200);
      const view = operationsRestoreExecutionViewSchema.parse(result.json());
      expect(view).toMatchObject({ taskId: diagnosed.id, runId: diagnosed.runId, locale, action: null,
        execution: { id: execution.id, taskId: schedule.taskId, runId: schedule.runId, proposalId: proposal.id,
          releaseOperationId: current.binding.decision.operationId, nativeUpdateId: ack.updateId, state: 'succeeded', environmentHeld: false,
          message: translate(locale, 'reason.operations_restore_recovery_verified'),
          restore: { operationId: earlier.operationId, manifestDigest: earlier.image.manifestDigest },
          recovery: { state: 'verified', failure: null, proof: { proofSha256: proof?.proofSha256, version: runtime.version,
            verifiedAt: proof?.completedAt?.toISOString() } } },
      });
      for (const value of [runtime.containerId, runtime.imageReference, runtime.network, ack.actorId, earlier.registration.whiskers.origin]) {
        expect(JSON.stringify(view)).not.toContain(value);
      }
      return view;
    }));
    const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
    const token = await issuer.token(subject, { aud: `${publicUrl}/mcp`, scope: 'itervane:read' });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', endpoint), {
      requestInit: { headers: { authorization: `Bearer ${token}`, 'accept-language': 'zh-CN' } },
    }));
    expect((await client.listTools()).tools.filter(tool => tool.name.includes('restore'))).toEqual([
      expect.objectContaining({ name: 'get_operations_restore', annotations: expect.objectContaining({ readOnlyHint: true }) }),
    ]);
    const call = { name: 'get_operations_restore', arguments: { taskId: diagnosed.id } };
    expect((await client.callTool(call)).structuredContent).toEqual(views[1]);
    await database.storage.db.delete(projectMembers).where(eq(projectMembers.principalId, principalId));
    expect((await fetchView('zh-CN')).statusCode).toBe(404);
    expect(await client.callTool(call)).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_found' } } });
  } finally {
    await client.close();
    await app.close();
  }
}, 45_000);

function restoreApiEnvironment(installed: OperationsWorkflowScope, mappingSha256: string) {
  return { DATABASE_URL: database.runtimeUrl, ITERVANE_OIDC_ISSUER: issuer.config.issuer, ITERVANE_OIDC_AUDIENCE: issuer.config.audience,
    ITERVANE_PORTAL_CLIENT_ID: operationsPortal, ITERVANE_OPERATIONS_API_ENABLED: '1', ITERVANE_RESTORE_API_ENABLED: '1',
    ITERVANE_OPERATIONS_ENVIRONMENT_ID: installed.environmentId, ITERVANE_OPERATIONS_ENROLLMENT_SHA256: installed.enrollmentSha256,
    ITERVANE_OPERATIONS_DIAGNOSIS_PROVIDER_SHA256: installed.diagnosisProviderSha256, ITERVANE_OPERATIONS_RELEASE_TARGET_SHA256: mappingSha256 };
}

it('queues one version restore through the approved human portal and cancels it before dispatch', async () => {
  const { installed, proposal, owner, decisions, decision, current, diagnosed } = await restoreExecutionCandidate();
  const settings = restoreApiEnvironment(installed, current.binding.manifest.target.mappingSha256);
  const start = (env: NodeJS.ProcessEnv) => createInstalledApi(database.storage, runtimeConfig(env), { logger: false });
  await expect(start({ ...settings, ITERVANE_OPERATIONS_RELEASE_TARGET_SHA256: sha256('old registered mapping') }))
    .rejects.toThrow('operations_restore_api_release_mapping_changed');
  await expect(start({ ...settings, ITERVANE_OPERATIONS_ENROLLMENT_SHA256: sha256('old operations enrollment') }))
    .rejects.toThrow('operations_restore_api_enrollment_required');
  const { app } = await start(settings);
  const { app: disabled } = await start({ ...settings, ITERVANE_RESTORE_API_ENABLED: undefined });
  try {
    const portal = { authorization: `Bearer ${await issuer.token('owner', { azp: operationsPortal })}`, 'accept-language': 'zh-CN' };
    const assistant = { authorization: `Bearer ${await issuer.token('owner')}` };
    const url = `/v1/tasks/${diagnosed.id}/operations-restore`;
    const view = async (server = app) => operationsRestoreExecutionViewSchema.parse((await server.inject({ url, headers: portal })).json());
    const endpoint = `/v1/operations/proposals/${proposal.id}/restore`;
    const payload = { fingerprint: proposal.fingerprint, decisionVersion: 1 };
    const post = (server = app, headers = portal, body: object = payload) => server.inject({ method: 'POST', url: endpoint, headers, payload: body });
    expect(await view()).toMatchObject({ execution: null, action: null });
    expect((await post()).statusCode).toBe(409);
    await decisions.decide(owner, proposal.id, { ...decision, action: 'confirm', expectedVersion: 0, idempotencyKey: randomUUID() });
    expect((await view()).action).toEqual({ kind: 'enqueue', proposalId: proposal.id, ...payload });
    expect((await view(disabled)).action).toBeNull();
    expect((await post(disabled)).statusCode).toBe(404);
    expect((await post(app, { ...portal, ...assistant })).statusCode).toBe(403);
    expect((await post(app, portal, { ...payload, restoreOperationId: randomUUID() })).statusCode).toBe(400);
    expect((await post(app, portal, { ...payload, fingerprint: sha256('unapproved proposal') })).statusCode).toBe(409);
    expect(await database.storage.db.select().from(operationsExecutions)).toEqual([]);

    const responses = await Promise.all([post(), post()]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 202]);
    const receipts = responses.map(response => operationsSubmissionSchema.parse(response.json()));
    const executionId = receipts[0]!.executionId;
    expect(receipts).toEqual(expect.arrayContaining([{ executionId, replayed: true }, { executionId, replayed: false }]));
    expect(await database.storage.db.select().from(operationsExecutionSchedules)).toMatchObject([{ executionId, wakeupJobId: executionId }]);
    expect((await database.storage.boss.findJobs(operationsRestoreQueue, { id: executionId }))[0]?.state).toBe('created');
    expect(await database.storage.boss.findJobs(operationsExecutionQueue, { id: executionId })).toEqual([]);
    expect(await view()).toMatchObject({ execution: { id: executionId, state: 'queued', environmentHeld: true }, action: null });
    await decisions.decide(owner, proposal.id, { ...decision, action: 'revoke', expectedVersion: 1, idempotencyKey: randomUUID() });
    expect(await view()).toMatchObject({ execution: { id: executionId, state: 'cancelled', environmentHeld: false }, action: null });
    expect((await post()).statusCode).toBe(409);
  } finally { await Promise.all([app.close(), disabled.close()]); }
}, 45_000);

it.each(['grant', 'publication', 'registration'] as const)('rejects restore submission after its approved %s changes', async changed => {
  const { earlier, installed, proposal, owner, decisions, decision, current, diagnosed } = await restoreExecutionCandidate();
  await decisions.decide(owner, proposal.id, { ...decision, action: 'confirm', expectedVersion: 0, idempotencyKey: randomUUID() });
  const config = runtimeConfig(restoreApiEnvironment(installed, current.binding.manifest.target.mappingSha256));
  const { app } = await createInstalledApi(database.storage, config, { logger: false });
  try {
    const headers = { authorization: `Bearer ${await issuer.token('owner', { azp: operationsPortal })}` };
    if (changed === 'grant') {
      const [grant] = await database.storage.db.delete(workspaceMembers).returning();
      if (!grant) throw new Error('Expected original workspace grant');
      await database.storage.db.insert(workspaceMembers).values({ principalId: grant.principalId, workspaceId: grant.workspaceId });
    } else if (changed === 'publication') {
      task = (await earlier.taskService.admit(identity, { projectId: earlier.scope.projectId, source: task.source,
        purpose: 'Replace the approved runtime', dataClass: 'synthetic', locale: 'en', idempotencyKey: randomUUID() })).task;
      const next = await queuedFormalRelease({ existingTarget: earlier.target, imageVariant: 'replacement after restore approval' });
      await finishTestRollout(await parkForRollout(next, true, 'c'.repeat(24)), 'standard-v4');
    } else {
      await registerReleaseTarget(database.storage, { ...earlier.target, recoveryPlanSha256: sha256('revised recovery plan') });
      await expect(createInstalledApi(database.storage, config)).rejects.toThrow('operations_restore_api_release_mapping_changed');
    }
    const url = `/v1/tasks/${diagnosed.id}/operations-restore`;
    expect((await app.inject({ url, headers })).json()).toMatchObject({ execution: null, action: null });
    const rejected = await app.inject({ method: 'POST', url: `/v1/operations/proposals/${proposal.id}/restore`, headers,
      payload: { ...decision, decisionVersion: 1 } });
    expect(rejected.statusCode).toBe(changed === 'grant' ? 403 : 409);
    expect(await database.storage.db.select().from(operationsExecutions)).toEqual([]);
  } finally { await app.close(); }
}, 45_000);

it.each(['legacy', 'missing'] as const)('routes a %s restore wakeup and takes over through the reader', async kind => {
  const { earlier, current, executor, schedule, execution } = await queuedRestore();
  const jobId = schedule.wakeupJobId!;
  expect((await database.storage.boss.findJobs(operationsRestoreQueue, { id: jobId }))[0]?.state).toBe('created');
  const restartWriter = vi.fn<OperationsRestartWorker['dispatch']>();
  const restartObserver = vi.fn<OperationsRestartRecoveryWorker['verify']>();
  await expect(new RestartQueueWorker(executor, { dispatch: restartWriter }, { verify: restartObserver }).tick()).resolves.toBe('idle');
  expect(restartWriter).not.toHaveBeenCalled();
  expect(restartObserver).not.toHaveBeenCalled();

  await database.storage.boss.deleteJob(operationsRestoreQueue, jobId);
  if (kind === 'legacy') await database.storage.boss.send(operationsExecutionQueue, {
    executionId: execution.id, taskId: schedule.taskId, runId: schedule.runId, generation: 1,
  }, { id: jobId });
  const dispatch = vi.fn<OperationsRestoreWorker['dispatch']>(async scope => {
    await executor.prepareRestoreDispatch(scope, { environmentId: earlier.scope.environmentId,
      mappingSha256: current.binding.manifest.target.mappingSha256 });
    return executor.deferRestore(scope);
  });
  const verify = vi.fn<OperationsRestoreRecoveryWorker['verify']>(scope => executor.deferRestoreRecovery(scope, 'missing_update'));
  const worker = new RestoreQueueWorker(executor, { dispatch }, { verify });
  await expect(worker.tick()).resolves.toBe('reconciling');
  if (kind === 'legacy') expect((await database.storage.boss.findJobs(operationsExecutionQueue, { id: jobId }))[0]?.state).toBe('cancelled');
  const takeover = new RestoreQueueWorker(executor, { dispatch }, { verify });
  await expect(takeover.tick()).resolves.toBe('manual_review');
  await expect(takeover.tick()).resolves.toBe('idle');
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mode: 'dispatch', workerId: worker.workerId, executionId: execution.id }), undefined);
  expect(verify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mode: 'reconcile', workerId: takeover.workerId, executionId: execution.id,
    fence: dispatch.mock.calls[0]![0].fence + 1 }), undefined);
  expect((await database.storage.db.select().from(operationsExecutions))[0]?.state).toBe('reserved');
}, 45_000);

it.each(['revoked', 'expired'] as const)('closes the %s restore wakeup before dispatch', async mode => {
  const { earlier, executor, decisions, decision, owner, proposal, schedule } = await queuedRestore(undefined, mode === 'expired');
  const dispatch = vi.fn<OperationsRestoreWorker['dispatch']>();
  const verify = vi.fn<OperationsRestoreRecoveryWorker['verify']>();
  if (mode === 'revoked') await decisions.decide(owner, proposal.id, {
    ...decision, action: 'revoke', expectedVersion: 1, idempotencyKey: randomUUID(),
  });
  else await vi.waitFor(async () => {
    const expired = await database.storage.pool.query<{ value: boolean }>('SELECT clock_timestamp() >= $1 AS value', [proposal.validUntil]);
    expect(expired.rows[0]?.value).toBe(true);
  }, { timeout: 15_000, interval: 300 });
  await expect(new RestoreQueueWorker(executor, { dispatch }, { verify }).tick()).resolves.toBe('idle');
  expect(dispatch).not.toHaveBeenCalled();
  expect(verify).not.toHaveBeenCalled();
  expect(await database.storage.db.select().from(operationsExecutionIntents)).toEqual([]);
  expect((await database.storage.db.select().from(operationsExecutions))[0]).toMatchObject({
    state: 'blocked', blockedReason: mode === 'revoked' ? 'approval_revoked' : 'proposal_expired',
  });
  expect((await database.storage.boss.findJobs(operationsRestoreQueue, { id: schedule.wakeupJobId! }))[0]?.state).toBe('cancelled');
  await expect(earlier.taskService.get(identity, schedule.taskId)).resolves.toMatchObject({ state: mode === 'revoked' ? 'cancelled' : 'needs_human' });
}, 45_000);

it.each(['acknowledged', 'reply_lost', 'prior_receipt', 'approval_revoked'] as const)('keeps a fenced restore dispatch accountable when %s', async outcome => {
  const { executor, scope, successor, config, ack } = await dispatchedRestore(outcome);
  expect(successor).toMatchObject({ mode: 'reconcile', fence: scope.fence + 1 });
  const progress = await executor.readRestoreProgress(successor);
  expect(progress.steps).toMatchObject(outcome === 'approval_revoked' ? [{ kind: 'configure', receipt: config }] : [
    { kind: 'configure', receipt: config }, { kind: 'deploy', receipt: outcome === 'acknowledged' ? ack : null },
  ]);
  await expect(executor.beginRestoreStep(successor, 'deploy', progress.sha256)).rejects.toBeInstanceOf(ExecutionLost);
  await expect(executor.recordRestoreStep(successor, 'deploy', progress.sha256, ack)).rejects.toBeInstanceOf(ExecutionLost);
});

it.each(['verified', 'missing_update', 'wrong_runtime', 'expired_reader', 'update_pending'] as const)('records bounded independent restore verification for %s', async result => {
  const fixture = await dispatchedRestore(result === 'missing_update' ? 'reply_lost' : 'acknowledged');
  const { earlier, current, executor, scope, successor, execution, schedule, ack, sends } = fixture;
  const completed = { ...ack, status: 'Complete' as const, success: true };
  const runtime = { ...earlier.runtime, containerId: sha256('restored instance') };
  const applyRead = vi.fn(async (target: Parameters<KomodoReleaseClient['observeUpdate']>[0], id: string, authorize: () => Promise<void>) => {
    await authorize();
    expect(target.deploymentId).toEqual(ack.deploymentId);
    expect(id).toEqual(ack.updateId);
    return result === 'update_pending' ? { ...completed, status: 'InProgress' as const, success: false } : completed;
  });
  const worker = new OperationsRestoreRecoveryWorker(executor, { observeUpdate: applyRead }, {
    async observe(subject, authorize) {
      await authorize();
      expect(subject.image).toMatchObject({ manifestDigest: earlier.image.manifestDigest, configDigest: earlier.image.configDigest });
      return result === 'wrong_runtime' ? { ...runtime, containerId: current.runtime.containerId } : runtime;
    },
  });
  let reader = successor;
  if (result === 'verified') {
    const progress = await executor.readRestoreProgress(reader);
    const proof = operationsRestoreRecoveryProofSchema.parse({ version: 1, executionId: execution.id, restoreOperationId: earlier.operationId,
      planSha256: progress.sha256, fence: reader.fence, attempt: 1, update: completed, runtime });
    const saveOnly = (document: typeof proof) => database.storage.db.update(operationsRestoreRecoveries).set({
      state: 'verified', proof: document, proofSha256: sha256(JSON.stringify(document)),
    }).where(eq(operationsRestoreRecoveries.executionId, execution.id));
    await expect(saveOnly({ ...proof, runtime: { ...runtime, version: 'different-version' } }))
      .rejects.toMatchObject({ cause: { code: '23514', message: 'operations_restore_recovery_proof_required' } });
    await expect(saveOnly(proof))
      .rejects.toMatchObject({ cause: { code: '23514', message: 'operations_restore_recovery_must_record_outcome' } });
    await expect(database.storage.db.update(operationsExecutions).set({ state: 'recovered' }).where(eq(operationsExecutions.id, execution.id)))
      .rejects.toMatchObject({ cause: { code: '23514', message: 'operations_restore_recovery_verified_receipt_required' } });
    expect((await database.storage.db.select().from(operationsRestoreRecoveries))[0]).toMatchObject({ state: 'observing', proof: null });
  }
  if (result === 'expired_reader') {
    await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
    await coordinator.reconcile(randomUUID());
    await expect(worker.verify(successor)).resolves.toBe('lease_lost');
    const retry = await executor.claim(await fetchOperationsWakeup(operationsRestoreQueue), randomUUID(), 'rollback');
    if (!retry) throw new Error('Expected a replacement restore reader');
    expect(retry.fence).toBe(successor.fence + 1);
    reader = retry;
  }
  if (result === 'update_pending') {
    for (let attempt = 1; attempt <= 2; attempt++) {
      await expect(worker.verify(reader)).resolves.toBe('retry');
      const retry = await executor.claim(await fetchOperationsWakeup(operationsRestoreQueue), randomUUID(), 'rollback');
      if (!retry) throw new Error('Expected the next restore reader');
      reader = retry;
    }
  }
  const verified = result === 'verified' || result === 'expired_reader';
  await expect(worker.verify(reader)).resolves.toBe(verified ? 'verified' : 'manual_review');
  expect(sends).toEqual(['configure', 'deploy']);
  expect(applyRead).toHaveBeenCalledTimes(result === 'missing_update' ? 0 : result === 'update_pending' ? 3 : 1);
  const attempts = await database.storage.db.select().from(operationsRestoreRecoveries).orderBy(operationsRestoreRecoveries.attempt);
  const final = attempts.at(-1);
  if (result === 'expired_reader') {
    expect(attempts[0]).toMatchObject({ attempt: 1, fence: successor.fence, failure: 'lease_expired', state: 'retry' });
  }
  if (verified) {
    expect(final).toMatchObject({ state: 'verified', failure: null, fence: reader.fence,
      proof: { restoreOperationId: earlier.operationId, update: completed, runtime } });
    expect(final?.proofSha256).toBe(sha256(JSON.stringify(operationsRestoreRecoveryProofSchema.parse(final?.proof))));
  } else {
    const failure = result === 'wrong_runtime' ? 'target_changed' : result;
    expect(final).toMatchObject({ state: 'manual_review', failure, proof: null });
  }
  for (const locale of ['zh-CN', 'en'] as const) {
    const events = await earlier.taskService.events(identity, schedule.taskId, 10, locale);
    expect(events.at(-1)).toMatchObject({ type: 'task.operations_restore_recovery_recorded',
      state: verified ? 'succeeded' : 'needs_human',
      reasonMessage: translate(locale, verified ? 'reason.operations_restore_recovery_verified' : 'reason.operations_restore_recovery_manual') });
  }
  expect((await database.storage.db.select().from(operationsExecutions).where(eq(operationsExecutions.id, execution.id)))[0])
    .toMatchObject({ state: verified ? 'recovered' : 'reserved', closedAt: verified ? final?.completedAt : null });
  const published = await database.storage.db.transaction(async tx => readOperationsDeployment(tx, await requireActor(tx, identity), earlier.scope));
  expect(published).toMatchObject(verified
    ? { releaseOperationId: earlier.operationId, restoreExecutionId: execution.id, containerId: runtime.containerId }
    : { releaseOperationId: current.binding.decision.operationId, containerId: current.runtime.containerId });
  if (!verified) expect(published).not.toHaveProperty('restoreExecutionId');
  expect((await database.storage.pool.query('SELECT task_id FROM itervane.execution_slot')).rows[0]).toEqual({ task_id: null });
  await expect(executor.settleRestoreRecovery(scope, { update: completed, runtime })).rejects.toBeInstanceOf(ExecutionLost);
  await expect(database.storage.db.delete(operationsRestoreRecoveries))
    .rejects.toMatchObject({ cause: { code: '23514', message: 'operations_restore_recovery_is_immutable' } });
}, 45_000);

it('binds diagnosis and restart to the restored instance and lets a later formal release supersede it', async () => {
  const original = await installedOperationsFixture();
  const stale = await restartExecutionCandidate(original);
  await stale.decide('confirm');
  const { earlier, current, executor, successor, execution, ack } = await dispatchedRestore('acknowledged', original);
  const archived = () => database.storage.db.select().from(releaseOperations).orderBy(releaseOperations.id);
  const originalRecords = await archived();
  const publication = () => database.storage.db.transaction(async tx =>
    readOperationsDeployment(tx, await requireActor(tx, identity), earlier.scope, { includePrevious: true }));
  const before = await publication();
  expect(before).toMatchObject({ releaseOperationId: current.binding.decision.operationId, previous: { releaseOperationId: earlier.operationId } });
  const restored = { ...earlier.runtime, containerId: sha256('replacement runtime for the first image') };
  const update = { ...ack, status: 'Complete' as const, success: true };
  await expect(executor.settleRestoreRecovery(successor, { update, runtime: restored })).resolves.toBe('verified');
  expect(await archived()).toEqual(originalRecords);
  expect(await publication()).toMatchObject({ releaseOperationId: earlier.operationId, restoreExecutionId: execution.id,
    manifestDigest: earlier.image.manifestDigest, containerId: restored.containerId, updateId: update.updateId,
    previous: { releaseOperationId: current.binding.decision.operationId } });
  await expect(stale.reserve()).rejects.toMatchObject({ code: 'version_conflict' });
  await expect(database.storage.db.insert(operationsExecutions).values({
    id: randomUUID(), environmentId: earlier.scope.environmentId, proposalId: stale.proposal.id,
    proposalFingerprint: stale.proposal.fingerprint, state: 'reserved', decisionVersion: 1,
    createdAt: sql`GREATEST(clock_timestamp(), (SELECT decided_at FROM itervane.operations_decisions
      WHERE proposal_id = ${stale.proposal.id} AND version = 1))`,
  })).rejects.toMatchObject({ cause: { code: '23514', message: 'operations_execution_authority_required' } });

  const restart = await restartAwaitingRecovery('acknowledged', { ...earlier, runtime: restored });
  const request = readOperationsProposal(restart.action.proposal).target;
  expect(request).toMatchObject({ releaseOperationId: earlier.operationId, restoreExecutionId: execution.id, containerId: restored.containerId });
  const { scope } = await restart.claimRecovery();
  await expect(restart.runtime.settleRestartRecovery(scope, restart.outcomeEvidence)).resolves.toBe('verified');
  expect(await publication()).toMatchObject({ releaseOperationId: earlier.operationId, restoreExecutionId: execution.id,
    containerId: restored.containerId, updateId: update.updateId });

  task = (await earlier.taskService.admit(identity, { projectId: earlier.scope.projectId, source: task.source,
    purpose: 'Publish after recovery', dataClass: 'synthetic', locale: 'en', idempotencyKey: randomUUID() })).task;
  const newest = await queuedFormalRelease({ existingTarget: earlier.target, imageVariant: 'image after recovery' });
  const launched = await finishTestRollout(await parkForRollout(newest, true, '7'.repeat(24)), 'standard-v4');
  const published = await publication();
  expect(published).toMatchObject({ releaseOperationId: newest.operationId, manifestDigest: launched.image.manifestDigest, version: 'standard-v4' });
  expect(published).not.toHaveProperty('restoreExecutionId');
}, 60_000);

it.each(['wait', 'expired', 'replaced', 'publishing', 'revoked'] as const)('limits proposal admission after %s', async mode => {
  if (mode === 'expired') await database.admin.query(`ALTER TABLE itervane.operations_diagnosis_results
    ALTER COLUMN created_at SET DEFAULT (now() - interval '2 hours')`);
  const { fixture, diagnosis, task: diagnosed, service } = await settleProposalDiagnosis(mode === 'wait' ? 'observe' : 'restart')
    .finally(async () => {
      if (mode === 'expired') await database.admin.query('ALTER TABLE itervane.operations_diagnosis_results ALTER COLUMN created_at SET DEFAULT now()');
    });
  if (mode === 'replaced') await registerOperationsTarget(database.storage, { ...fixture.registration,
    whiskers: { ...fixture.registration.whiskers, serverId: 'rebound-server' } });
  if (mode === 'publishing') {
    task = (await fixture.taskService.admit(identity, { projectId: fixture.scope.projectId, source: task.source, purpose: 'Publication already queued',
      dataClass: 'synthetic', locale: 'en', idempotencyKey: randomUUID() })).task;
    await queuedFormalRelease({ existingTarget: fixture.target });
  }
  if (mode === 'revoked') {
    const [owner] = await database.storage.db.delete(workspaceMembers).returning();
    if (!owner) throw new Error('Expected owner grant');
    await database.storage.db.insert(workspaceMembers).values({ principalId: owner.principalId, workspaceId: owner.workspaceId });
  }
  const code = mode === 'publishing' ? 'conflict' : mode === 'replaced' || mode === 'revoked' ? 'version_conflict' : 'unsupported_state';
  await expect(service.freeze(identity, diagnosed.id, { diagnosisSha256: diagnosis.sha256 })).rejects.toMatchObject({ code });
  expect(await database.storage.db.select().from(operationsProposals)).toEqual([]);
});

const operationsPortal = 'itervane-operations-decision-portal';
const decisionIdentity = (subject = 'owner') => issuer.token(subject, { azp: operationsPortal }).then(createIdentityVerifier(issuer.config));

it('keeps operations authorization timestamps ordered when the database clock falls behind the diagnosis', async () => {
  await database.admin.query(`ALTER TABLE itervane.operations_diagnosis_results
    ALTER COLUMN created_at SET DEFAULT (clock_timestamp() + interval '20 seconds')`);
  const { installed, diagnosis, task: diagnosed, service } = await settleProposalDiagnosis('restart')
    .finally(() => database.admin.query('ALTER TABLE itervane.operations_diagnosis_results ALTER COLUMN created_at SET DEFAULT now()'));
  const clock = await database.storage.pool.query('SELECT clock_timestamp() < $1::timestamptz AS behind', [diagnosis.createdAt]);
  expect(clock.rows[0]?.behind).toBe(true);

  const { proposal } = await service.freeze(identity, diagnosed.id, { diagnosisSha256: diagnosis.sha256 });
  const owner = await decisionIdentity();
  const decisionService = new OperationsDecisionService(database.storage, installed, operationsPortal);
  const decisionInput = { fingerprint: proposal.fingerprint };
  const confirmed = (await decisionService.decide(owner, proposal.id, {
    ...decisionInput, action: 'confirm', expectedVersion: 0, idempotencyKey: randomUUID(),
  })).decision;
  const { execution } = await new OperationsExecutionAdmission(database.storage, installed)
    .enqueue({ ...decisionInput, proposalId: proposal.id, decisionVersion: 1 });
  const revoked = (await decisionService.decide(owner, proposal.id, {
    ...decisionInput, action: 'revoke', expectedVersion: 1, idempotencyKey: randomUUID(),
  })).decision;
  expect([proposal.createdAt, confirmed.decidedAt, execution.createdAt, revoked.decidedAt])
    .toEqual([diagnosis.createdAt, diagnosis.createdAt, diagnosis.createdAt, diagnosis.createdAt]);
  expect((await database.storage.db.select().from(operationsExecutions).where(eq(operationsExecutions.id, execution.id)))[0])
    .toMatchObject({ state: 'blocked', blockedReason: 'approval_revoked', closedAt: revoked.decidedAt });
});

async function restartExecutionCandidate(prepared?: Awaited<ReturnType<typeof installedOperationsFixture>>) {
  const { fixture, installed, diagnosis, task: diagnosed, service } = await settleProposalDiagnosis('restart', prepared);
  const { proposal } = await service.freeze(identity, diagnosed.id, { diagnosisSha256: diagnosis.sha256 });
  const owner = await decisionIdentity();
  const decisionService = new OperationsDecisionService(database.storage, installed, operationsPortal);
  const admission = new OperationsExecutionAdmission(database.storage, installed);
  const input = { proposalId: proposal.id, fingerprint: proposal.fingerprint, decisionVersion: 1 };
  const decide = (action: 'confirm' | 'revoke', idempotencyKey = randomUUID()) => decisionService.decide(owner, proposal.id, {
    action, expectedVersion: action === 'confirm' ? 0 : 1, fingerprint: proposal.fingerprint, idempotencyKey,
  });
  return { fixture, installed, diagnosed, diagnosis, proposal, admission, input, decide,
    reserve: () => admission.reserve(input), enqueue: () => admission.enqueue(input) };
}

async function competingPublication(fixture: Awaited<ReturnType<typeof installedOperationsFixture>>) {
  task = (await fixture.taskService.admit(identity, { projectId: fixture.scope.projectId, source: task.source,
    purpose: 'Competing approved release', dataClass: 'synthetic', locale: 'en', idempotencyKey: randomUUID() })).task;
  return preparedFormalRelease({ existingTarget: fixture.target });
}

async function queuedOperationsLease(prepared?: Awaited<ReturnType<typeof installedOperationsFixture>>) {
  const action = await restartExecutionCandidate(prepared);
  await action.decide('confirm');
  const { execution, schedule } = await action.enqueue();
  const runtime = new OperationsExecutionCoordinator(coordinator, action.installed);
  return { ...action, execution, schedule, runtime };
}

async function fetchOperationsWakeup(queue: typeof operationsExecutionQueue | typeof operationsRestoreQueue = operationsExecutionQueue) {
  return vi.waitFor(async () => {
    const [job] = await database.storage.boss.fetch(queue);
    if (!job) throw new Error('Waiting for an operations execution wakeup');
    return job;
  }, { timeout: 8_000, interval: 50 });
}

function restartInstallation(fixture: Awaited<ReturnType<typeof installedOperationsFixture>>): OperationsRestartInstallation {
  return { version: 1, installationId: randomUUID(), environmentId: fixture.scope.environmentId,
    enrollmentSha256: fixture.enrollment.fingerprint, whiskers: fixture.registration.whiskers, imageDigest: whiskersRestartImageDigest,
    policySha256: sha256('sealed Confirm policy'), rolesSha256: sha256('read-only Operator role map'), credentialSha256: sha256(randomUUID()) };
}

function stoppedBaseline({ runtime }: Awaited<ReturnType<typeof installedOperationsFixture>>) {
  const { containerId, configDigest, imageReference, runtimeConfigSha256, network } = runtime;
  return operationsRestartBaselineSchema.parse({ containerId, configDigest, imageReference, runtimeConfigSha256, network,
    state: 'exited', startedAt: '2026-01-01T00:00:00.000000001Z' });
}

async function registerRestartInstallation(installation: OperationsRestartInstallation, expectedActiveId: string | null = null) {
  const receipt = await changeOperationsRestartInstallation(database.storage, { action: 'register', expectedActiveId, installation });
  return { installationId: receipt.installationId, installationSha256: receipt.installationSha256, credentialSha256: installation.credentialSha256 };
}

async function withRestartWorker(action: Awaited<ReturnType<typeof queuedOperationsLease>>, run: (fixture: {
  worker: OperationsRestartWorker; approvalId: string;
  calls: Array<{ params: unknown; intentFence: number | undefined; resumeState: string | undefined; baseline: string | null | undefined }>;
  onPermissions: (callback: () => Promise<void>) => void;
  onRestart: (callback: () => { text: string; isError?: boolean }) => void;
  invalidatePolicy: () => Promise<void>; rotateWriter: () => Promise<void>;
  changeContainerStart: () => void;
}) => Promise<void>) {
  const document = restartInstallation(action.fixture);
  const key = randomBytes(32).toString('hex');
  const policy = await readFile(new URL('../../../../fixtures/whiskers/guardrails.json', import.meta.url));
  const roles = JSON.stringify({ Roles: [{ Email: 'offline-admin@example.invalid', Role: 2 },
    { Email: 'operator@example.invalid', Role: 1 }], DefaultRole: 0 });
  const installation = { ...document, policySha256: sha256(policy), rolesSha256: sha256(roles), credentialSha256: sha256(key) };
  const dir = await mkdtemp(join(tmpdir(), 'itervane-whiskers-writer-'));
  const paths = { installation: join(dir, 'installation.json'), guardrails: join(dir, 'guardrails.json'), roles: join(dir, 'roles.json') };
  const approvalId = randomUUID().replaceAll('-', '');
  const calls: Parameters<typeof run>[0]['calls'] = [];
  let baseline = stoppedBaseline(action.fixture);
  const permissionUri = 'whiskers://me/permissions';
  const permission = '# My Whiskers permissions\n- Caller: API key "restart worker"\n- Scope: explicit tool list\n'
    + '- Native guardrails also apply.\n\n## Tools I may call (1)\n- `restart_container`\n';
  let beforeSend: (() => Promise<void>) | undefined;
  let reply = (): { text: string; isError?: boolean } => ({ isError: true,
    text: `Human approval required: 'restart_container' (write) requires confirmation. Approval ${approvalId} was raised (Whiskers → Approvals). After it is approved, repeat this exact call within 10 minutes; it then runs once.` });
  const originalFetch = globalThis.fetch;
  try {
    await Promise.all([writeFile(paths.installation, JSON.stringify(installation)), writeFile(paths.guardrails, policy), writeFile(paths.roles, roles)]);
    await registerRestartInstallation(installation);
    vi.stubGlobal('fetch', (async (input, init) => {
      if (String(input) !== installation.whiskers.origin + '/mcp') return originalFetch(input, init);
      if (init?.method === 'GET') return new Response(null, { status: 405 });
      if (init?.method !== 'POST' || new Headers(init.headers).get('authorization') !== 'Bearer ' + key) return new Response(null, { status: 403 });
      const message = JSON.parse(String(init.body));
      const respond = (result: unknown) => Response.json({ jsonrpc: '2.0', id: message.id, result });
      if (message.method === 'initialize') return respond({ protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'whiskers', version: '0.15.0' } });
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (message.method === 'resources/read' && message.params.uri === permissionUri) {
        await beforeSend?.();
        return respond({ contents: [{ uri: permissionUri, text: permission }] });
      }
      if (message.method !== 'tools/call') return new Response(null, { status: 400 });
      const [intent] = await database.storage.db.select().from(operationsExecutionIntents);
      const [bound] = await database.storage.db.select().from(operationsRestartRequests);
      const [resume] = await database.storage.db.select().from(operationsRestartResumes).orderBy(sql`attempt desc`);
      calls.push({ params: message.params, intentFence: intent?.fence, resumeState: resume?.state, baseline: bound?.runtimeBaselineSha256 });
      const { text, isError } = reply();
      return respond({ isError, content: [{ type: 'text', text }] });
    }) satisfies typeof fetch);
    await run({ worker: new OperationsRestartWorker(action.runtime, {
      async captureRestartBaseline(subject, authorize) {
        await authorize();
        expect(subject).toMatchObject({ containerId: baseline.containerId, image: { configDigest: baseline.configDigest } });
        return baseline;
      },
    }, paths, key), calls, approvalId,
      onPermissions: callback => { beforeSend = callback; }, onRestart: callback => { reply = callback; },
      changeContainerStart: () => { baseline = { ...baseline, startedAt: '2026-01-01T00:00:00.000000002Z' }; },
      invalidatePolicy: () => writeFile(paths.guardrails, '{}'),
      rotateWriter: async () => { await registerRestartInstallation(restartInstallation(action.fixture), installation.installationId); } });
  } finally {
    vi.unstubAllGlobals();
    for (const file of Object.values(paths)) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(dir);
  }
}

it('dispatches the bound Whiskers request and continuation only after durable intent', async () => {
  const action = await queuedOperationsLease();
  await withRestartWorker(action, async ({ worker, calls, approvalId, onRestart }) => {
    const initial = await action.runtime.claim(await fetchOperationsWakeup(), randomUUID());
    if (!initial) throw new Error('Expected an initial restart lease');
    await expect(worker.dispatch(initial)).resolves.toBe('awaiting_approval');
    const [request] = await database.storage.db.select().from(operationsRestartRequests);
    const baseline = stoppedBaseline(action.fixture);
    const runtimeBaselineSha256 = sha256(JSON.stringify(baseline));
    expect(request).toMatchObject({ approvalId, executionId: action.execution.id, runtimeBaseline: baseline, runtimeBaselineSha256 });
    expect((await action.fixture.taskService.get(identity, initial.taskId)).state).toBe('waiting_approval');
    await expect(worker.dispatch(initial)).resolves.toBe('lease_lost');

    const humanRuntime = new OperationsExecutionCoordinator(coordinator, action.installed, operationsPortal);
    const waiting = await action.fixture.taskService.get(identity, initial.taskId);
    await humanRuntime.requestRestartResume(await decisionIdentity(), action.execution.id, {
      expectedVersion: waiting.version, idempotencyKey: randomUUID(), approvalId, callSha256: request!.callSha256,
    });
    onRestart(() => ({ text: 'Container fixture restarted.' }));
    const continuation = await action.runtime.claim(await fetchOperationsWakeup(), randomUUID());
    if (!continuation) throw new Error('Expected a restart continuation lease');
    expect(continuation.mode).toBe('restart_resume');
    await expect(worker.dispatch(continuation)).resolves.toBe('reconciling');
    const params = { name: 'restart_container', arguments: { containerId: action.fixture.runtime.containerId, serverId: 'local' } };
    expect(calls).toEqual([{ params, intentFence: initial.fence, resumeState: undefined, baseline: runtimeBaselineSha256 },
      { params, intentFence: initial.fence, resumeState: 'prepared', baseline: runtimeBaselineSha256 }]);
    expect(await database.storage.db.select().from(operationsRestartResumes)).toMatchObject([{ state: 'acknowledged', approvalId }]);
    expect((await database.storage.db.select().from(operationsExecutions))[0]?.state).toBe('reserved');
    expect((await action.fixture.taskService.get(identity, initial.taskId)).state).toBe('reconciling');
    const observer = await action.runtime.claim(await fetchOperationsWakeup(), randomUUID());
    expect(observer?.mode).toBe('reconcile');
    if (!observer) throw new Error('Expected a read-only continuation');
    await expect(worker.dispatch(observer)).resolves.toBe('reconciling');
    expect(calls).toHaveLength(2);
  });
});

it('retains Whiskers approval for read-only reconciliation when the stopped runtime changes before continuation', async () => {
  const action = await queuedOperationsLease();
  await withRestartWorker(action, async ({ worker, calls, approvalId, changeContainerStart }) => {
    const initial = await action.runtime.claim(await fetchOperationsWakeup(), randomUUID());
    if (!initial) throw new Error('Expected an initial restart lease');
    await expect(worker.dispatch(initial)).resolves.toBe('awaiting_approval');
    const [request] = await database.storage.db.select().from(operationsRestartRequests);
    const humanRuntime = new OperationsExecutionCoordinator(coordinator, action.installed, operationsPortal);
    const waiting = await action.fixture.taskService.get(identity, initial.taskId);
    await humanRuntime.requestRestartResume(await decisionIdentity(), action.execution.id, {
      expectedVersion: waiting.version, idempotencyKey: randomUUID(), approvalId, callSha256: request!.callSha256,
    });
    changeContainerStart();
    const continuation = await action.runtime.claim(await fetchOperationsWakeup(), randomUUID());
    if (!continuation) throw new Error('Expected a restart continuation lease');
    await expect(worker.dispatch(continuation)).resolves.toBe('reconciling');
    expect(calls).toHaveLength(1);
    expect(await database.storage.db.select().from(operationsRestartResumes)).toMatchObject([{ state: 'blocked', fence: null }]);
    expect((await database.storage.db.select().from(operationsExecutions))[0]?.state).toBe('reserved');
    expect((await database.storage.db.select().from(operationsRestartRequests))[0]).toMatchObject({ runtimeBaseline: stoppedBaseline(action.fixture) });
  });
});

it('routes an installed restart queue across native pause, continuation and independent readback', async () => {
  const action = await queuedOperationsLease();
  await withRestartWorker(action, async ({ worker, calls, approvalId, onRestart }) => {
    const observeRestart = vi.fn(async (_subject, _baseline, authorize: () => Promise<void>) => {
      await authorize();
      return { startedAt: '2026-01-01T00:00:00.000000002Z', runtime: action.fixture.runtime };
    });
    const queue = new RestartQueueWorker(action.runtime, worker,
      new OperationsRestartRecoveryWorker(action.runtime, { observeRestart }));
    await expect(queue.tick()).resolves.toBe('awaiting_approval');
    await expect(queue.tick()).resolves.toBe('idle');
    expect(calls).toHaveLength(1);
    expect(observeRestart).not.toHaveBeenCalled();
    const [native] = await database.storage.db.select().from(operationsRestartRequests);
    const human = new OperationsExecutionCoordinator(coordinator, action.installed, operationsPortal);
    const waiting = await action.fixture.taskService.get(identity, action.schedule.taskId);
    await human.requestRestartResume(await decisionIdentity(), action.execution.id, {
      expectedVersion: waiting.version, idempotencyKey: randomUUID(), approvalId, callSha256: native!.callSha256,
    });
    onRestart(() => ({ text: 'Container fixture restarted.' }));
    await expect(queue.tick()).resolves.toBe('reconciling');
    await expect(queue.tick()).resolves.toBe('verified');
    await expect(queue.tick()).resolves.toBe('idle');
    expect(calls).toHaveLength(2);
    expect(observeRestart).toHaveBeenCalledOnce();
    expect((await database.storage.db.select().from(operationsExecutions))[0]?.state).toBe('recovered');
  });
});

it.each(['replaced installation', 'changed policy'] as const)('closes a Whiskers restart before send after %s', async reason => {
  const action = await queuedOperationsLease();
  await withRestartWorker(action, async ({ worker, calls, onPermissions, rotateWriter, invalidatePolicy }) => {
    onPermissions(reason === 'replaced installation' ? rotateWriter : invalidatePolicy);
    const scope = await action.runtime.claim(await fetchOperationsWakeup(), randomUUID());
    if (!scope) throw new Error('Expected an initial restart lease');
    await expect(database.storage.db.update(operationsExecutions).set({ state: 'blocked', blockedReason: 'restart_not_sent',
      closedAt: sql`GREATEST(${operationsExecutions.createdAt}, clock_timestamp())` }).where(eq(operationsExecutions.id, action.execution.id)))
      .rejects.toMatchObject({ cause: { code: '23514', message: 'operations_execution_schedule_must_close' } });
    await expect(worker.dispatch(scope)).resolves.toBe('not_sent');
    expect(calls).toEqual([]);
    expect(await database.storage.db.select().from(operationsExecutionIntents)).toEqual([]);
    expect(await database.storage.db.select().from(operationsRestartRequests)).toEqual([]);
    expect((await database.storage.db.select().from(operationsExecutions))[0]).toMatchObject({ state: 'blocked', blockedReason: 'restart_not_sent' });
    expect((await database.storage.pool.query('SELECT task_id FROM itervane.execution_slot')).rows[0]).toEqual({ task_id: null });
    expect((await action.fixture.taskService.get(identity, scope.taskId)).state).toBe('needs_human');
    for (const locale of ['en', 'zh-CN'] as const) {
      expect((await action.fixture.taskService.events(identity, scope.taskId, 10, locale)).at(-1))
        .toMatchObject({ reasonMessage: translate(locale, 'reason.operations_restart_not_sent') });
    }
  });
});

it('keeps the environment reserved and reconciles a lost Whiskers write response', async () => {
  const action = await queuedOperationsLease();
  await withRestartWorker(action, async ({ worker, calls, onRestart }) => {
    onRestart(() => { throw new Error('Fixture connection interrupted'); });
    const scope = await action.runtime.claim(await fetchOperationsWakeup(), randomUUID());
    if (!scope) throw new Error('Expected an initial restart lease');
    await expect(worker.dispatch(scope)).resolves.toBe('reconciling');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.intentFence).toBe(scope.fence);
    expect((await database.storage.db.select().from(operationsExecutions))[0]).toMatchObject({ state: 'reserved', closedAt: null });
    expect((await action.fixture.taskService.events(identity, scope.taskId, 10, 'zh-CN')).at(-1))
      .toMatchObject({ state: 'reconciling', reasonMessage: translate('zh-CN', 'reason.operations_restart_result_unknown') });
    await expect(action.runtime.claim(await fetchOperationsWakeup(), randomUUID())).resolves.toMatchObject({ mode: 'reconcile' });
    await expect(worker.dispatch(scope)).resolves.toBe('lease_lost');
    expect(calls).toHaveLength(1);
  });
});

it('registers one immutable Whiskers write installation without altering the read enrollment', async () => {
  const fixture = await installedOperationsFixture();
  const initial = restartInstallation(fixture);
  const before = await database.storage.db.select().from(operationsTargets);
  await expect(registerRestartInstallation({ ...initial, whiskers: { ...initial.whiskers, serverId: 'unregistered' } }))
    .rejects.toMatchObject({ code: 'version_conflict' });
  await expect(registerRestartInstallation({ ...initial, enrollmentSha256: sha256('not the enrollment') }))
    .rejects.toMatchObject({ code: 'version_conflict' });
  await expect(changeOperationsRestartInstallation(database.storage, { action: 'register', expectedActiveId: null,
    installation: { ...initial, writeKey: 'fixture secret never stored' } })).rejects.toMatchObject({ code: 'invalid_input' });
  const [first, duplicate] = await Promise.all([registerRestartInstallation(initial), registerRestartInstallation(initial)]);
  expect(duplicate).toEqual(first);
  const rotated = await Promise.allSettled([registerRestartInstallation(restartInstallation(fixture), first.installationId),
    registerRestartInstallation(restartInstallation(fixture), first.installationId)]);
  const winner = rotated.find(result => result.status === 'fulfilled');
  const stale = rotated.find(result => result.status === 'rejected');
  expect(stale).toMatchObject({ status: 'rejected', reason: { code: 'version_conflict' } });
  if (!winner) throw new Error('Expected one rotation');
  const rows = await database.storage.db.select().from(operationsRestartInstallations).orderBy(operationsRestartInstallations.id);
  expect(rows).toHaveLength(2);
  expect(rows.find(row => row.id === initial.installationId)?.retiredAt).toBeInstanceOf(Date);
  expect(rows.filter(row => row.retiredAt === null).map(row => row.id)).toEqual([winner.value.installationId]);
  await expect(registerRestartInstallation({ ...initial, installationId: randomUUID() }, winner.value.installationId))
    .rejects.toMatchObject({ code: 'version_conflict' });
  expect(await database.storage.db.select().from(operationsRestartInstallations).orderBy(operationsRestartInstallations.id)).toEqual(rows);
  await expect(database.storage.db.update(operationsRestartInstallations).set({ retiredAt: null })
    .where(eq(operationsRestartInstallations.id, initial.installationId)))
    .rejects.toMatchObject({ cause: { code: '23514', message: 'operations_restart_writer_is_immutable' } });

  const retire = () => changeOperationsRestartInstallation(database.storage, {
    action: 'retire', environmentId: fixture.scope.environmentId, installationId: winner.value.installationId,
  });
  const retired = await retire();
  expect(retired.retiredAt).toBeInstanceOf(Date);
  expect(await retire()).toEqual(retired);
  expect(await database.storage.db.select().from(operationsTargets)).toEqual(before);
});

async function prepareNativeRestart(action: Awaited<ReturnType<typeof queuedOperationsLease>>) {
  const scope = await action.runtime.claim(await fetchOperationsWakeup(), randomUUID());
  if (!scope) throw new Error('Expected an initial restart lease');
  const writer = await registerRestartInstallation(restartInstallation(action.fixture));
  const { restartRequest, intent } = await action.runtime.prepareDispatch(scope, writer, stoppedBaseline(action.fixture));
  if (!restartRequest) throw new Error('Expected a frozen native restart request');
  return { scope, restartRequest, intent, writer, credentialSha256: writer.credentialSha256,
    approval: { callSha256: restartRequest.callSha256, approvalId: randomUUID().replaceAll('-', '') } };
}

it('atomically pauses a bound Whiskers approval and frees the shared execution slot', async () => {
  const action = await queuedOperationsLease();
  const release = await competingPublication(action.fixture);
  const { scope, restartRequest, intent, writer, credentialSha256, approval } = await prepareNativeRestart(action);
  expect(restartRequest).toMatchObject({
    executionId: action.execution.id, approvalId: null, writerInstallationId: writer.installationId,
    document: { version: 1, tool: 'restart_container', credentialSha256,
      target: { ...action.fixture.registration.whiskers, containerId: action.fixture.runtime.containerId } },
  });
  expect(restartRequest.callSha256).toBe(sha256(JSON.stringify(operationsRestartRequestSchema.parse(restartRequest.document))));
  expect(restartRequest.createdAt.getTime()).toBeGreaterThanOrEqual(intent.createdAt.getTime());
  await expect(database.storage.db.update(operationsRestartRequests).set({ approvalId: approval.approvalId, runtimeBaseline: null, runtimeBaselineSha256: null })
    .where(eq(operationsRestartRequests.executionId, action.execution.id)))
    .rejects.toMatchObject({ cause: { code: '23514', message: 'operations_restart_baseline_is_immutable' } });
  const recorded = await action.runtime.pauseForRestartApproval(scope, approval);
  expect(recorded).toMatchObject({ executionId: action.execution.id, ...approval, receivedAt: expect.any(Date) });
  expect(recorded.receivedAt!.getTime()).toBeGreaterThanOrEqual(restartRequest.createdAt.getTime());
  await expect(action.runtime.pauseForRestartApproval(scope, approval)).rejects.toBeInstanceOf(ExecutionLost);
  await expect(action.fixture.taskService.get(identity, action.schedule.taskId)).resolves.toMatchObject({ state: 'waiting_approval' });
  for (const locale of ['en', 'zh-CN'] as const) {
    expect((await action.fixture.taskService.events(identity, action.schedule.taskId, 10, locale)).at(-1))
      .toMatchObject({ type: 'task.operations_execution_native_approval', reason: 'operations_execution_native_approval',
        state: 'waiting_approval', workerId: scope.workerId, reasonMessage: translate(locale, 'reason.operations_execution_native_approval') });
  }
  expect((await database.storage.pool.query('SELECT task_id FROM itervane.execution_slot')).rows[0]).toEqual({ task_id: null });
  await expect(release.confirm()).rejects.toMatchObject({ code: 'conflict' });
  await action.runtime.reconcile(randomUUID());
  expect(await database.storage.boss.fetch(operationsExecutionQueue)).toEqual([]);
  const unrelated = (await action.fixture.taskService.admit(identity, { projectId: task.projectId, source: task.source,
    purpose: 'Development while waiting for native approval', dataClass: 'synthetic', locale: 'en', idempotencyKey: randomUUID() })).task;
  await expect(claim()).resolves.toMatchObject({ taskId: unrelated.id });
  await action.decide('revoke');
  await expect(action.fixture.taskService.get(identity, scope.taskId)).resolves.toMatchObject({ state: 'reconciling' });
  expect((await fetchOperationsWakeup()).data).toMatchObject({ executionId: action.execution.id, runId: scope.runId });
  expect((await database.storage.db.select().from(operationsRestartRequests))[0]).toMatchObject(approval);
});

it('rolls back a Whiskers approval unless the matching pause and lease release commit', async () => {
  const action = await queuedOperationsLease();
  const { scope, approval } = await prepareNativeRestart(action);
  await expect(action.runtime.pauseForRestartApproval(scope, { ...approval, callSha256: sha256('another request') }))
    .rejects.toMatchObject({ code: 'version_conflict' });
  await expect(database.storage.db.update(operationsRestartRequests).set({ approvalId: approval.approvalId })
    .where(eq(operationsRestartRequests.executionId, action.execution.id)))
    .rejects.toMatchObject({ cause: { code: '23514', message: 'operations_restart_approval_must_pause' } });
  await database.admin.query(`ALTER TABLE itervane.task_events ADD CONSTRAINT injected_restart_pause_failure
    CHECK (type <> 'task.operations_execution_native_approval') NOT VALID`);
  try {
    await expect(action.runtime.pauseForRestartApproval(scope, approval))
      .rejects.toMatchObject({ cause: { code: '23514', constraint: 'injected_restart_pause_failure' } });
    expect((await database.storage.db.select().from(operationsRestartRequests))[0]).toMatchObject({ approvalId: null, receivedAt: null });
    expect((await database.storage.pool.query('SELECT task_id FROM itervane.execution_slot')).rows[0]).toEqual({ task_id: scope.taskId });
    await expect(action.fixture.taskService.get(identity, scope.taskId)).resolves.toMatchObject({ state: 'running' });
  } finally { await database.admin.query('ALTER TABLE itervane.task_events DROP CONSTRAINT injected_restart_pause_failure'); }
  await expect(action.runtime.pauseForRestartApproval(scope, approval)).resolves.toMatchObject(approval);
  await expect(database.storage.db.update(operationsRestartRequests).set({ approvalId: randomUUID().replaceAll('-', '') }))
    .rejects.toMatchObject({ cause: { code: '23514', message: 'operations_restart_request_is_immutable' } });
});

it('retains a late Whiskers approval receipt after platform withdrawal', async () => {
  const action = await queuedOperationsLease();
  const { scope, approval } = await prepareNativeRestart(action);
  await action.decide('revoke');
  await expect(action.runtime.pauseForRestartApproval(scope, approval)).resolves.toMatchObject(approval);
  expect(await database.storage.db.select().from(operationsDecisions)).toHaveLength(2);
  expect((await database.storage.db.select().from(operationsExecutions))[0]).toMatchObject({ state: 'reserved' });
  await expect(action.fixture.taskService.get(identity, scope.taskId)).resolves.toMatchObject({ state: 'reconciling' });
  await expect(action.fixture.taskService.resume(identity, scope.taskId, { expectedVersion: 4 }))
    .rejects.toMatchObject({ code: 'unsupported_state' });
  const pending = await action.runtime.claim(await fetchOperationsWakeup(), randomUUID());
  expect(pending).toMatchObject({ mode: 'reconcile', fence: scope.fence + 1 });
});

it('rejects a forged Whiskers restart target despite a valid platform intent', async () => {
  const action = await queuedOperationsLease();
  const scope = await action.runtime.claim(await fetchOperationsWakeup(), randomUUID());
  if (!scope) throw new Error('Expected an initial restart lease');
  await action.runtime.prepareDispatch(scope);
  const document = { version: 1, tool: 'restart_container', credentialSha256: sha256('dedicated restart caller'),
    target: { ...action.fixture.registration.whiskers, containerId: sha256('different container') } } as const;
  await expect(database.storage.db.insert(operationsRestartRequests).values({
    executionId: action.execution.id, callSha256: sha256(JSON.stringify(document)), document,
  })).rejects.toMatchObject({ cause: { code: '23514', message: 'operations_restart_request_binding_required' } });
  const correctTarget = { ...document, target: { ...document.target, containerId: action.fixture.runtime.containerId } };
  await expect(database.storage.db.insert(operationsRestartRequests).values({
    executionId: action.execution.id, callSha256: sha256(JSON.stringify(correctTarget)), document: correctTarget,
  })).rejects.toMatchObject({ cause: { code: '23514', message: 'operations_restart_request_writer_required' } });
  expect(await database.storage.db.select().from(operationsRestartRequests)).toEqual([]);
});

it('fences a Whiskers restart approval receipt after the sender loses its lease', async () => {
  const action = await queuedOperationsLease();
  const { scope, approval } = await prepareNativeRestart(action);
  await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
  await expect(database.storage.db.update(operationsRestartRequests).set({ approvalId: approval.approvalId })
    .where(eq(operationsRestartRequests.executionId, action.execution.id)))
    .rejects.toMatchObject({ cause: { code: '23514', message: 'operations_restart_request_lease_required' } });
  await action.runtime.reconcile(randomUUID());
  const resumed = await action.runtime.claim(await fetchOperationsWakeup(), randomUUID());
  if (!resumed) throw new Error('Expected a reconciliation lease');
  expect(resumed.mode).toBe('reconcile');
  await expect(action.runtime.pauseForRestartApproval(scope, approval)).rejects.toBeInstanceOf(ExecutionLost);
  await expect(action.runtime.pauseForRestartApproval(resumed, approval)).rejects.toBeInstanceOf(ExecutionLost);
  expect((await database.storage.db.select().from(operationsRestartRequests))[0]).toMatchObject({ approvalId: null });
});

async function pausedWhiskersRestart(prepared?: Awaited<ReturnType<typeof installedOperationsFixture>>) {
  const action = await queuedOperationsLease(prepared);
  const { scope, approval, writer } = await prepareNativeRestart(action);
  await action.runtime.pauseForRestartApproval(scope, approval);
  const runtime = new OperationsExecutionCoordinator(coordinator, action.installed, operationsPortal);
  const human = await decisionIdentity();
  const next = async () => {
    const current = await action.fixture.taskService.get(identity, scope.taskId);
    return { ...approval, expectedVersion: current.version, idempotencyKey: randomUUID() };
  };
  const request = async () => runtime.requestRestartResume(human, action.execution.id, await next());
  const lease = async () => {
    const claimed = await runtime.claim(await fetchOperationsWakeup(), randomUUID());
    if (claimed?.mode !== 'restart_resume') throw new Error('Expected a restart continuation lease');
    return claimed;
  };
  return { action, runtime, human, next, request, lease, approval, writer,
    binding: { ...approval, ...writer, runtimeBaselineSha256: sha256(JSON.stringify(stoppedBaseline(action.fixture))) } };
}

async function restartAwaitingRecovery(outcome: 'acknowledged' | 'unknown' = 'acknowledged',
  prepared?: Awaited<ReturnType<typeof installedOperationsFixture>>) {
  const { action, runtime, request, lease, approval, binding } = await pausedWhiskersRestart(prepared);
  await request();
  const sent = await lease();
  await runtime.prepareRestartResume(sent, binding);
  await runtime.recordRestartResume(sent, { ...approval, outcome });
  const claimRecovery = async () => {
    const job = await fetchOperationsWakeup();
    const scope = await runtime.claim(job, randomUUID());
    if (scope?.mode !== 'reconcile') throw new Error('Expected a read-only recovery lease');
    return { scope, job };
  };
  const outcomeEvidence = { startedAt: '2026-01-01T00:00:00.000000002Z', runtime: action.fixture.runtime };
  return { action, runtime, sent, approval, binding, claimRecovery, outcomeEvidence };
}

it('holds the durable restart acknowledgement at the native interruption point', async () => {
  const { action, runtime, request, lease, binding, approval } = await pausedWhiskersRestart();
  await request();
  const scope = await lease();
  await runtime.prepareRestartResume(scope, binding);
  const barrier = await holdOperationsAcknowledgement(database, 'restart', action.execution.id);
  const recording = runtime.recordRestartResume(scope, { ...approval, outcome: 'acknowledged' });
  void recording.catch(() => {});
  try {
    expect(await barrier.waitForWorker()).toBeGreaterThan(0);
    const [pending] = await database.storage.db.select().from(operationsRestartResumes)
      .where(eq(operationsRestartResumes.executionId, action.execution.id));
    expect(pending).toMatchObject({ state: 'prepared', fence: scope.fence, recordedAt: null });
    await barrier.release();
    await expect(recording).resolves.toMatchObject({ state: 'acknowledged', waiting: false });
  } finally {
    await barrier.close();
    await recording.catch(() => {});
  }
});

it('settles restart recovery after revocation under the original proof and frees the environment once', async () => {
  const { action, runtime, sent, approval, claimRecovery, outcomeEvidence } = await restartAwaitingRecovery();
  const release = await competingPublication(action.fixture);
  await expect(release.confirm()).rejects.toMatchObject({ code: 'conflict' });
  const { scope, job } = await claimRecovery();
  expect(scope.fence).toBeGreaterThan(sent.fence);
  await expect(runtime.claim(job, randomUUID())).resolves.toBeNull();
  await expect(database.storage.db.update(operationsExecutions).set({ state: 'recovered' }).where(eq(operationsExecutions.id, action.execution.id)))
    .rejects.toMatchObject({ cause: { code: '23514', message: 'operations_restart_recovery_verified_receipt_required' } });
  let checks = 0;
  const observer = new OperationsRestartRecoveryWorker(runtime, {
    async observeRestart(subject, baseline, authorize) {
      await authorize();
      expect(subject).toMatchObject({ containerId: action.fixture.runtime.containerId, version: action.fixture.runtime.version });
      expect(baseline).toEqual(stoppedBaseline(action.fixture));
      await action.decide('revoke');
      await authorize();
      checks++;
      return outcomeEvidence;
    },
  });
  await expect(observer.verify(scope)).resolves.toBe('verified');
  const [record] = await database.storage.db.select().from(operationsRestartRecoveries);
  const proof = operationsRestartRecoveryProofSchema.parse(record?.proof);
  expect(record).toMatchObject({ attempt: 1, state: 'verified', fence: scope.fence, proofSha256: sha256(JSON.stringify(proof)) });
  expect(proof).toMatchObject({ observation: outcomeEvidence, native: { approvalId: approval.approvalId, attempt: 1 } });
  expect((await database.storage.db.select().from(operationsExecutions))[0]).toMatchObject({ state: 'recovered', closedAt: record!.completedAt });
  expect((await database.storage.pool.query('SELECT task_id FROM itervane.execution_slot')).rows[0]).toEqual({ task_id: null });
  await expect(action.fixture.taskService.get(identity, scope.taskId)).resolves.toMatchObject({ state: 'succeeded' });
  for (const locale of ['en', 'zh-CN'] as const) {
    expect((await action.fixture.taskService.events(identity, scope.taskId, 50, locale)).at(-1))
      .toMatchObject({ type: 'task.operations_restart_recovery_recorded', reasonMessage: translate(locale, 'reason.operations_restart_recovery_verified') });
  }
  await expect(observer.verify(scope)).resolves.toBe('lease_lost');
  expect(checks).toBe(1);
  await release.confirm();
});

it('retains the environment when restart recovery has health evidence and an unknown native permit', async () => {
  const { action, runtime, approval, claimRecovery, binding, outcomeEvidence } = await restartAwaitingRecovery('unknown');
  const release = await competingPublication(action.fixture);
  const { scope } = await claimRecovery();
  const forged = operationsRestartRecoveryProofSchema.parse({ version: 1, executionId: action.execution.id,
    releaseOperationId: action.fixture.operationId, fence: scope.fence, proposalFingerprint: action.execution.proposalFingerprint,
    callSha256: approval.callSha256, runtimeBaselineSha256: binding.runtimeBaselineSha256,
    native: { approvalId: approval.approvalId, attempt: 1 }, observation: outcomeEvidence });
  await expect(database.storage.db.update(operationsRestartRecoveries).set({ state: 'verified', proof: forged, proofSha256: sha256(JSON.stringify(forged)) }))
    .rejects.toMatchObject({ cause: { code: '23514', message: 'operations_restart_recovery_evidence_required' } });
  await expect(runtime.settleRestartRecovery(scope, outcomeEvidence)).resolves.toBe('manual_review');
  expect((await database.storage.db.select().from(operationsRestartRecoveries))[0]).toMatchObject({
    state: 'manual_review', failure: 'native_unconfirmed', proof: { native: null, observation: outcomeEvidence },
  });
  expect((await database.storage.db.select().from(operationsExecutions))[0]).toMatchObject({ state: 'reserved', closedAt: null });
  await expect(action.fixture.taskService.get(identity, scope.taskId)).resolves.toMatchObject({ state: 'needs_human' });
  await expect(release.confirm()).rejects.toMatchObject({ code: 'conflict' });
  expect(await database.storage.boss.fetch(operationsExecutionQueue)).toEqual([]);
});

it('moves an expired native approval wait into exactly one read-only restart recovery', async () => {
  const fixture = await installedOperationsFixture();
  const publication = await competingPublication(fixture);
  await database.admin.query(`ALTER TABLE itervane.operations_diagnosis_results
    ALTER COLUMN created_at SET DEFAULT (now() - interval '1788 seconds')`);
  const action = await restartExecutionCandidate(fixture).finally(() =>
    database.admin.query('ALTER TABLE itervane.operations_diagnosis_results ALTER COLUMN created_at SET DEFAULT now()'));
  await action.decide('confirm');
  const { execution, schedule } = await action.enqueue();
  const runtime = new OperationsExecutionCoordinator(coordinator, action.installed);
  const { scope, approval, writer } = await prepareNativeRestart({ ...action, execution, schedule, runtime });
  await runtime.pauseForRestartApproval(scope, approval);
  const app = createApi(database.storage, { ...issuer.config, portalClientId: operationsPortal, operationsApi: action.installed },
    { logger: false, operationsRestartWriter: writer });
  try {
    const token = await issuer.token('owner', { azp: operationsPortal });
    const url = `/v1/tasks/${action.diagnosed.id}/operations-execution`;
    const view = async (locale: 'en' | 'zh-CN' = 'en') => operationsRestartExecutionViewSchema.parse((await app.inject({
      url, headers: { authorization: `Bearer ${token}`, 'accept-language': locale },
    })).json());
    await runtime.reconcile(randomUUID());
    expect(await view()).toMatchObject({ execution: { state: 'waiting_approval', environmentHeld: true }, action: { kind: 'continue' } });
    await database.admin.query("SELECT pg_sleep_until($1::timestamptz + interval '20 milliseconds')", [action.proposal.validUntil]);

    const other = new OperationsExecutionCoordinator(coordinator, { ...action.installed, enrollmentSha256: sha256('another enrollment') });
    await other.reconcile(randomUUID());
    expect(await view()).toMatchObject({ execution: { state: 'waiting_approval' }, action: null });
    await Promise.all([runtime.reconcile(randomUUID()), runtime.reconcile(randomUUID())]);
    for (const locale of ['en', 'zh-CN'] as const) {
      expect(await view(locale)).toMatchObject({ execution: { state: 'reconciling', environmentHeld: true,
        nativeApprovalId: approval.approvalId, reason: 'operations_restart_approval_expired',
        message: translate(locale, 'reason.operations_restart_approval_expired') }, action: null });
    }
    const events = await action.fixture.taskService.events(identity, schedule.taskId, 50, 'en');
    expect(events.filter(event => event.reason === 'operations_restart_approval_expired')).toHaveLength(1);
    expect(await database.storage.db.select().from(operationsRestartResumes)).toEqual([]);
    const recovered = await runtime.claim(await fetchOperationsWakeup(), randomUUID());
    if (recovered?.mode !== 'reconcile') throw new Error('Expected a read-only restart recovery lease');
    expect(recovered.fence).toBeGreaterThan(scope.fence);
    await expect(runtime.settleRestartRecovery(recovered, { startedAt: '2026-01-01T00:00:00.000000002Z',
      runtime: fixture.runtime })).resolves.toBe('manual_review');
    expect(await view()).toMatchObject({ execution: { state: 'needs_human', environmentHeld: true,
      recovery: { state: 'manual_review', failure: 'native_unconfirmed' } }, action: null });
    await expect(publication.confirm()).rejects.toMatchObject({ code: 'conflict' });
  } finally {
    await app.close();
  }
});

it('stops restart recovery without probing after the enrolled target changes', async () => {
  const { action, runtime, claimRecovery } = await restartAwaitingRecovery();
  const { scope } = await claimRecovery();
  await registerOperationsTarget(database.storage, { ...action.fixture.registration,
    whiskers: { ...action.fixture.registration.whiskers, serverId: 'rebound-after-restart' } });
  const observeRestart = vi.fn(async () => { throw new Error('Unexpected probe'); });
  const worker = new OperationsRestartRecoveryWorker(runtime, { observeRestart });
  await expect(worker.verify(scope)).resolves.toBe('manual_review');
  expect(observeRestart).not.toHaveBeenCalled();
  expect((await database.storage.db.select().from(operationsRestartRecoveries))[0]).toMatchObject({ state: 'manual_review', failure: 'target_changed', proof: null });
  expect((await database.storage.db.select().from(operationsExecutions))[0]?.state).toBe('reserved');
});

it('records restart recovery for an older intent with missing evidence without contacting the target', async () => {
  const action = await queuedOperationsLease();
  const original = await action.runtime.claim(await fetchOperationsWakeup(), randomUUID());
  if (!original) throw new Error('Expected the original lease');
  await action.runtime.prepareDispatch(original);
  await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
  await action.runtime.reconcile(randomUUID());
  const scope = await action.runtime.claim(await fetchOperationsWakeup(), randomUUID());
  if (scope?.mode !== 'reconcile') throw new Error('Expected a read-only recovery lease');
  const observeRestart = vi.fn(async () => { throw new Error('Unexpected probe'); });
  await expect(new OperationsRestartRecoveryWorker(action.runtime, { observeRestart }).verify(scope)).resolves.toBe('manual_review');
  expect(observeRestart).not.toHaveBeenCalled();
  expect((await database.storage.db.select().from(operationsRestartRecoveries))[0]).toMatchObject({
    state: 'manual_review', failure: 'missing_evidence', proof: null,
  });
  expect((await database.storage.db.select().from(operationsExecutions))[0]?.state).toBe('reserved');
});

it('bounds restart recovery retries and fences a superseded read lease', async () => {
  const { action, runtime, claimRecovery, outcomeEvidence } = await restartAwaitingRecovery();
  const first = (await claimRecovery()).scope;
  await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
  await runtime.reconcile(randomUUID());
  const second = (await claimRecovery()).scope;
  await expect(runtime.settleRestartRecovery(first, outcomeEvidence)).rejects.toBeInstanceOf(ExecutionLost);
  expect(second.fence).toBe(first.fence + 1);
  const worker = new OperationsRestartRecoveryWorker(runtime, {
    async observeRestart(_subject, _baseline, authorize) { await authorize(); throw new ReleaseIngressError('health_failed'); },
  });
  await expect(worker.verify(second)).resolves.toBe('retry');
  const third = (await claimRecovery()).scope;
  await expect(worker.verify(third)).resolves.toBe('manual_review');
  expect(await database.storage.db.select().from(operationsRestartRecoveries).orderBy(operationsRestartRecoveries.attempt)).toMatchObject([
    { attempt: 1, state: 'retry', failure: 'lease_expired', fence: first.fence },
    { attempt: 2, state: 'retry', failure: 'unhealthy', fence: second.fence },
    { attempt: 3, state: 'manual_review', failure: 'unhealthy', fence: third.fence },
  ]);
  await expect(action.fixture.taskService.get(identity, third.taskId)).resolves.toMatchObject({ state: 'needs_human' });
  expect((await database.storage.db.select().from(operationsExecutions))[0]?.state).toBe('reserved');
  expect(await database.storage.boss.fetch(operationsExecutionQueue)).toEqual([]);
});

it('rolls back restart recovery proof and hold release when its event cannot commit', async () => {
  const { runtime, claimRecovery, outcomeEvidence } = await restartAwaitingRecovery();
  const { scope } = await claimRecovery();
  await expect(runtime.settleRestartRecovery(scope, { ...outcomeEvidence, runtime: { ...outcomeEvidence.runtime, version: 'other-version' } }))
    .rejects.toMatchObject({ reason: 'target_changed' });
  await database.admin.query("ALTER TABLE itervane.task_events ADD CONSTRAINT test_restart_recovery_event CHECK (type <> 'task.operations_restart_recovery_recorded') NOT VALID");
  try {
    await expect(runtime.settleRestartRecovery(scope, outcomeEvidence)).rejects.toMatchObject({ cause: { code: '23514', constraint: 'test_restart_recovery_event' } });
    expect((await database.storage.db.select().from(operationsRestartRecoveries))[0]).toMatchObject({ state: 'observing', proof: null, completedAt: null });
    expect((await database.storage.db.select().from(operationsExecutions))[0]).toMatchObject({ state: 'reserved', closedAt: null });
    expect((await database.storage.pool.query('SELECT task_id FROM itervane.execution_slot')).rows[0]).toEqual({ task_id: scope.taskId });
  } finally { await database.admin.query('ALTER TABLE itervane.task_events DROP CONSTRAINT test_restart_recovery_event'); }
  await expect(runtime.settleRestartRecovery(scope, outcomeEvidence)).resolves.toBe('verified');
});

it('requires the matching active Whiskers write installation before a native intent is recorded', async () => {
  const action = await queuedOperationsLease();
  const scope = await action.runtime.claim(await fetchOperationsWakeup(), randomUUID());
  if (!scope) throw new Error('Expected an initial restart lease');
  const document = restartInstallation(action.fixture);
  const guessed = { installationId: document.installationId, installationSha256: sha256('other policy'), credentialSha256: document.credentialSha256 };
  await expect(action.runtime.prepareDispatch(scope, guessed)).rejects.toMatchObject({ code: 'version_conflict' });
  const writer = await registerRestartInstallation(document);
  await expect(action.runtime.prepareDispatch(scope, guessed)).rejects.toMatchObject({ code: 'version_conflict' });
  expect(await database.storage.db.select().from(operationsExecutionIntents)).toEqual([]);
  const target = { ...action.fixture.registration.whiskers, containerId: action.fixture.runtime.containerId };
  await expect(action.runtime.prepareDispatch(scope, writer, stoppedBaseline(action.fixture))).resolves.toMatchObject({
    restartRequest: { writerInstallationId: writer.installationId, document: { target, credentialSha256: writer.credentialSha256 } },
  });
});

it('rolls back Whiskers intent when the stopped baseline cannot be persisted', async () => {
  const action = await queuedOperationsLease();
  const scope = await action.runtime.claim(await fetchOperationsWakeup(), randomUUID());
  if (!scope) throw new Error('Expected an initial restart lease');
  const writer = await registerRestartInstallation(restartInstallation(action.fixture));
  const baseline = stoppedBaseline(action.fixture);
  await expect(action.runtime.prepareDispatch(scope, writer, { ...baseline, configDigest: 'sha256:' + '0'.repeat(64) }))
    .rejects.toMatchObject({ reason: 'runtime_changed' });
  await database.admin.query('ALTER TABLE itervane.operations_restart_requests ADD CONSTRAINT test_restart_baseline_failure CHECK (runtime_baseline IS NULL) NOT VALID');
  try {
    await expect(action.runtime.prepareDispatch(scope, writer, baseline))
      .rejects.toMatchObject({ cause: { code: '23514', constraint: 'test_restart_baseline_failure' } });
    expect(await database.storage.db.select().from(operationsExecutionIntents)).toEqual([]);
    expect(await database.storage.db.select().from(operationsRestartRequests)).toEqual([]);
  } finally { await database.admin.query('ALTER TABLE itervane.operations_restart_requests DROP CONSTRAINT test_restart_baseline_failure'); }
  await expect(action.runtime.prepareDispatch(scope, writer, baseline)).resolves.toMatchObject({ restartRequest: { runtimeBaseline: baseline } });
});

it.each([false, true])('reconciles Whiskers writer rotation without changing read scope (queued=%s)', async queued => {
  const { action, runtime, request, writer, binding } = await pausedWhiskersRestart();
  let obsoleteJob: Awaited<ReturnType<typeof fetchOperationsWakeup>> | undefined;
  if (queued) {
    await request();
    obsoleteJob = await fetchOperationsWakeup();
  }
  await expect(registerRestartInstallation({ ...restartInstallation(action.fixture), credentialSha256: writer.credentialSha256 }, writer.installationId))
    .rejects.toMatchObject({ code: 'version_conflict' });
  expect((await action.fixture.taskService.get(identity, action.schedule.taskId)).state).toBe(queued ? 'queued' : 'waiting_approval');
  await registerRestartInstallation(restartInstallation(action.fixture), writer.installationId);
  if (obsoleteJob) await expect(runtime.claim(obsoleteJob, randomUUID())).resolves.toBeNull();
  expect((await action.fixture.taskService.get(identity, action.schedule.taskId)).state).toBe('reconciling');
  expect((await database.storage.db.select().from(operationsRestartRequests))[0]).toMatchObject({ writerInstallationId: writer.installationId });
  if (queued) expect((await database.storage.db.select().from(operationsRestartResumes))[0]).toMatchObject({ state: 'blocked' });
  const readOnly = await runtime.claim(await fetchOperationsWakeup(), randomUUID());
  expect(readOnly?.mode).toBe('reconcile');
  expect((await database.storage.db.select().from(operationsExecutions))[0]?.state).toBe('reserved');
  if (!readOnly) throw new Error('Expected a reconciliation lease');
  await expect(runtime.prepareRestartResume(readOnly, binding)).rejects.toBeInstanceOf(ExecutionLost);
});

it('retains a late Whiskers approval after retirement of the recorded writer', async () => {
  const action = await queuedOperationsLease();
  const { scope, approval, writer } = await prepareNativeRestart(action);
  await changeOperationsRestartInstallation(database.storage, {
    action: 'retire', environmentId: action.fixture.scope.environmentId, installationId: writer.installationId,
  });
  await expect(action.runtime.pauseForRestartApproval(scope, approval)).resolves.toMatchObject(approval);
  await expect(action.fixture.taskService.get(identity, scope.taskId)).resolves.toMatchObject({ state: 'reconciling' });
  await expect(action.runtime.claim(await fetchOperationsWakeup(), randomUUID())).resolves.toMatchObject({ mode: 'reconcile' });
});

it('deduplicates human restart continuation and binds its send intent to the original credential', async () => {
  const { action, runtime, human, next, lease, binding } = await pausedWhiskersRestart();
  const input = await next();
  const submit = () => runtime.requestRestartResume(human, action.execution.id, input);
  await expect(runtime.requestRestartResume(identity, action.execution.id, input)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(runtime.requestRestartResume(human, action.execution.id, { ...input, approvalId: randomUUID().replaceAll('-', '') }))
    .rejects.toMatchObject({ code: 'version_conflict' });
  const requests = await Promise.all([submit(), submit()]);
  expect(requests.map(item => item.replayed).sort()).toEqual([false, true]);
  expect(requests[0]?.resume).toEqual(requests[1]?.resume);
  expect(requests[0]?.resume).toMatchObject({ attempt: 1, state: 'queued', approvalId: input.approvalId });
  await expect(runtime.requestRestartResume(human, action.execution.id, { ...input, idempotencyKey: randomUUID() }))
    .rejects.toMatchObject({ code: 'version_conflict' });

  const scope = await lease();
  await expect(runtime.prepareRestartResume(scope, { ...binding, credentialSha256: sha256('replacement key') }))
    .rejects.toMatchObject({ code: 'version_conflict' });
  await expect(database.storage.db.update(operationsRestartResumes).set({ state: 'prepared', workerId: scope.workerId, fence: scope.fence }))
    .rejects.toMatchObject({ cause: { code: '23514', message: 'operations_restart_resume_task_must_transition' } });
  const { resume } = await runtime.prepareRestartResume(scope, binding);
  expect(resume).toMatchObject({ state: 'prepared', attempt: 1, workerId: scope.workerId, fence: scope.fence });
  await expect(runtime.prepareRestartResume(scope, binding)).rejects.toBeInstanceOf(ExecutionLost);
  for (const locale of ['en', 'zh-CN'] as const) {
    expect((await action.fixture.taskService.events(identity, scope.taskId, 10, locale)).at(-1))
      .toMatchObject({ type: 'task.operations_restart_resume_prepared', reason: 'operations_restart_resume_prepared',
        reasonMessage: translate(locale, 'reason.operations_restart_resume_prepared') });
  }
});

it('allows at most three human continuations after explicit unchanged Whiskers pending results', async () => {
  const { action, runtime, request, lease, binding, approval } = await pausedWhiskersRestart();
  for (const attempt of [1, 2, 3]) {
    expect((await request()).resume.attempt).toBe(attempt);
    const scope = await lease();
    await runtime.prepareRestartResume(scope, binding);
    await expect(runtime.recordRestartResume(scope, { ...approval, outcome: 'pending' })).resolves.toMatchObject({ attempt, state: 'pending' });
    expect((await database.storage.pool.query('SELECT task_id FROM itervane.execution_slot')).rows[0]).toEqual({ task_id: null });
    expect((await action.fixture.taskService.get(identity, scope.taskId)).state).toBe(attempt < 3 ? 'waiting_approval' : 'reconciling');
  }
  await expect(request()).rejects.toMatchObject({ code: 'unsupported_state' });
  await expect(runtime.claim(await fetchOperationsWakeup(), randomUUID())).resolves.toMatchObject({ mode: 'reconcile' });
});

it.each(['acknowledged', 'unknown'] as const)('moves a %s Whiskers continuation into read-only verification', async outcome => {
  const { action, runtime, request, lease, binding, approval } = await pausedWhiskersRestart();
  await request();
  const scope = await lease();
  await runtime.prepareRestartResume(scope, binding);
  await expect(runtime.recordRestartResume(scope, { ...approval, approvalId: randomUUID().replaceAll('-', ''), outcome }))
    .rejects.toBeInstanceOf(ExecutionLost);
  await expect(runtime.recordRestartResume(scope, { ...approval, outcome })).resolves.toMatchObject({ state: outcome, recordedAt: expect.any(Date) });
  expect((await database.storage.db.select().from(operationsExecutions))[0]?.state).toBe('reserved');
  expect((await action.fixture.taskService.get(identity, scope.taskId)).state).toBe('reconciling');
  await expect(request()).rejects.toMatchObject({ code: 'unsupported_state' });
  const observer = await runtime.claim(await fetchOperationsWakeup(), randomUUID());
  if (!observer) throw new Error('Expected a read-only lease');
  expect(observer.mode).toBe('reconcile');
  await expect(runtime.prepareRestartResume(observer, binding)).rejects.toBeInstanceOf(ExecutionLost);
});

it('reclaims an unsent Whiskers continuation and fences recovery after its send intent', async () => {
  const { runtime, request, lease, binding, approval } = await pausedWhiskersRestart();
  await request();
  const first = await lease();
  const expire = () => database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
  await expire();
  await runtime.reconcile(randomUUID());
  const second = await lease();
  expect(second.fence).toBe(first.fence + 1);
  await expect(runtime.prepareRestartResume(first, binding)).rejects.toBeInstanceOf(ExecutionLost);
  expect((await runtime.prepareRestartResume(second, binding)).resume).toMatchObject({ attempt: 1, fence: second.fence });
  await expire();
  await runtime.reconcile(randomUUID());
  const observer = await runtime.claim(await fetchOperationsWakeup(), randomUUID());
  expect(observer).toMatchObject({ mode: 'reconcile', fence: second.fence + 1 });
  await expect(runtime.recordRestartResume(second, { ...approval, outcome: 'acknowledged' })).rejects.toBeInstanceOf(ExecutionLost);
  expect(await database.storage.db.select().from(operationsRestartResumes)).toMatchObject([{ attempt: 1, state: 'prepared', recordedAt: null }]);
});

it('replaces a queued Whiskers continuation with read-only work on platform withdrawal', async () => {
  const { action, runtime, request } = await pausedWhiskersRestart();
  await request();
  const queued = await fetchOperationsWakeup();
  await action.decide('revoke');
  await expect(runtime.claim(queued, randomUUID())).resolves.toBeNull();
  expect(await database.storage.db.select().from(operationsRestartResumes)).toMatchObject([{ attempt: 1, state: 'blocked', fence: null }]);
  expect((await action.fixture.taskService.get(identity, action.schedule.taskId)).state).toBe('reconciling');
  expect((await database.storage.db.select().from(operationsExecutions))[0]?.state).toBe('reserved');
  await expect(runtime.claim(await fetchOperationsWakeup(), randomUUID())).resolves.toMatchObject({ mode: 'reconcile' });
});

it('fences a claimed Whiskers continuation after platform withdrawal', async () => {
  const { action, runtime, request, lease, binding } = await pausedWhiskersRestart();
  await request();
  const scope = await lease();
  await action.decide('revoke');
  await expect(runtime.heartbeat(scope)).rejects.toMatchObject({ code: 'unsupported_state' });
  await expect(runtime.prepareRestartResume(scope, binding)).rejects.toMatchObject({ code: 'unsupported_state' });
  await runtime.blockRestartResume(scope);
  expect(await database.storage.db.select().from(operationsRestartResumes)).toMatchObject([{ attempt: 1, state: 'blocked', fence: null }]);
  expect((await database.storage.db.select().from(operationsExecutions))[0]?.state).toBe('reserved');
  await expect(runtime.claim(await fetchOperationsWakeup(), randomUUID())).resolves.toMatchObject({ mode: 'reconcile' });
});

it('blocks an unprepared continuation when its native caller changes', async () => {
  const { runtime, request, lease, binding } = await pausedWhiskersRestart();
  await request();
  const scope = await lease();
  await expect(runtime.prepareRestartResume(scope, { ...binding, credentialSha256: sha256('changed native caller') }))
    .rejects.toMatchObject({ code: 'version_conflict' });
  await runtime.blockRestartResume(scope);
  expect(await database.storage.db.select().from(operationsRestartResumes)).toMatchObject([{ attempt: 1, state: 'blocked', fence: null }]);
  await expect(runtime.claim(await fetchOperationsWakeup(), randomUUID())).resolves.toMatchObject({ mode: 'reconcile' });
});

it('uses the shared slot for operations and fences replaced wakeups', async () => {
  const action = await queuedOperationsLease();
  const devTask = (await action.fixture.taskService.admit(identity, { projectId: task.projectId, source: task.source,
    purpose: 'Competing development run', dataClass: 'synthetic', locale: 'en', idempotencyKey: randomUUID() })).task;
  const devLease = await claim();
  expect(devLease.taskId).toBe(devTask.id);
  const job = await fetchOperationsWakeup();
  await expect(action.runtime.claim(job, randomUUID())).resolves.toBeNull();
  const [delayed] = await database.storage.db.select().from(operationsExecutionSchedules);
  expect(delayed?.wakeupJobId).not.toBe(job.id);
  await expect(action.runtime.claim(job, randomUUID())).resolves.toBeNull();
  await action.fixture.taskService.cancel(identity, devTask.id, { expectedVersion: devTask.version + 1 });
  await coordinator.stop(devLease, 'cancelled', true);

  const replacement = await fetchOperationsWakeup();
  expect(replacement.id).toBe(delayed?.wakeupJobId);
  const [scope, replay] = await Promise.all([action.runtime.claim(replacement, randomUUID()), action.runtime.claim(job, randomUUID())]);
  expect(replay).toBeNull();
  expect(scope).toMatchObject({ mode: 'dispatch', executionId: action.execution.id, taskId: action.schedule.taskId,
    runId: action.schedule.runId, generation: 1, fence: devLease.fence + 1 });
  if (!scope) throw new Error('Expected an operations execution lease');
  await expect(coordinator.heartbeat(scope)).rejects.toBeInstanceOf(ExecutionLost);
  await action.runtime.heartbeat(scope);
  expect((await database.storage.db.select().from(operationsExecutionSchedules))[0]?.wakeupJobId).toBeNull();
});

it('repairs an abandoned operations wakeup and defers a mismatched installed target', async () => {
  const action = await queuedOperationsLease();
  const lostJob = await fetchOperationsWakeup();
  await action.runtime.reconcile(randomUUID());
  expect((await database.storage.db.select().from(operationsExecutionSchedules))[0]?.wakeupJobId).toBe(lostJob.id);
  await database.admin.query(`UPDATE itervane_queue.job SET started_on=clock_timestamp()-interval '90 seconds'
    WHERE id=$1 AND name=$2`, [lostJob.id, operationsExecutionQueue]);
  await action.runtime.reconcile(randomUUID());
  const replacement = await fetchOperationsWakeup();
  expect(replacement.id).not.toBe(lostJob.id);
  expect((await database.storage.boss.findJobs(operationsExecutionQueue, { id: lostJob.id }))[0]?.state).toBe('cancelled');
  const wrong = new OperationsExecutionCoordinator(coordinator, { ...action.installed, enrollmentSha256: sha256('old enrollment') });
  await expect(wrong.claim(replacement, randomUUID())).resolves.toBeNull();
  await expect(action.fixture.taskService.get(identity, action.schedule.taskId)).resolves.toMatchObject({ state: 'queued' });
  await expect(action.runtime.claim(await fetchOperationsWakeup(), randomUUID())).resolves.toMatchObject({ mode: 'dispatch' });
});

it('reclaims a lease before dispatch and records exactly one fenced operations intent', async () => {
  const action = await queuedOperationsLease();
  const first = await action.runtime.claim(await fetchOperationsWakeup(), randomUUID());
  if (!first) throw new Error('Expected the initial operations lease');
  await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
  const untrustedIntent = { executionId: action.execution.id, proposalFingerprint: action.proposal.fingerprint,
    decisionVersion: 1, generation: 1, workerId: first.workerId, fence: first.fence };
  await expect(database.storage.db.insert(operationsExecutionIntents).values(untrustedIntent))
    .rejects.toMatchObject({ cause: { code: '23514', message: 'operations_execution_intent_authority_required' } });
  await coordinator.reconcile(randomUUID());
  const successor = await action.runtime.claim(await fetchOperationsWakeup(), randomUUID());
  if (!successor) throw new Error('Expected the recovered operations lease');
  expect(successor).toMatchObject({ mode: 'dispatch', fence: first.fence + 1 });
  await expect(action.runtime.prepareDispatch(first)).rejects.toBeInstanceOf(ExecutionLost);
  await database.admin.query(`ALTER TABLE itervane.task_events ADD CONSTRAINT injected_operations_intent_event_failure
    CHECK (type <> 'task.operations_execution_dispatch_intended') NOT VALID`);
  try {
    await expect(action.runtime.prepareDispatch(successor))
      .rejects.toMatchObject({ cause: { code: '23514', constraint: 'injected_operations_intent_event_failure' } });
    expect(await database.storage.db.select().from(operationsExecutionIntents)).toEqual([]);
  } finally { await database.admin.query('ALTER TABLE itervane.task_events DROP CONSTRAINT injected_operations_intent_event_failure'); }
  const prepared = await Promise.allSettled([action.runtime.prepareDispatch(successor), action.runtime.prepareDispatch(successor)]);
  expect(prepared.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(prepared.find(result => result.status === 'rejected')).toMatchObject({ reason: expect.any(ExecutionLost) });
  const intents = await database.storage.db.select().from(operationsExecutionIntents);
  expect(intents).toHaveLength(1);
  expect(intents[0]).toMatchObject({ ...untrustedIntent, workerId: successor.workerId, fence: successor.fence });
  await expect(database.storage.db.delete(operationsExecutionIntents))
    .rejects.toMatchObject({ cause: { code: '23514', message: 'operations_execution_intent_is_immutable' } });
  for (const locale of ['en', 'zh-CN'] as const) {
    const events = await action.fixture.taskService.events(identity, action.schedule.taskId, 10, locale);
    expect(events.at(-1)).toMatchObject({ workerId: successor.workerId, type: 'task.operations_execution_dispatch_intended',
      reason: 'operations_execution_dispatch_intended',
      reasonMessage: translate(locale, 'reason.operations_execution_dispatch_intended') });
  }
});

it('cancels a claimed operations lease on withdrawal before intent', async () => {
  const action = await queuedOperationsLease();
  const scope = await action.runtime.claim(await fetchOperationsWakeup(), randomUUID());
  if (!scope) throw new Error('Expected a claimed operations execution');
  await action.decide('revoke');
  await expect(action.runtime.prepareDispatch(scope)).rejects.toBeInstanceOf(ExecutionLost);
  await expect(action.runtime.heartbeat(scope)).rejects.toBeInstanceOf(ExecutionLost);
  await coordinator.reconcile(randomUUID());
  expect((await database.storage.pool.query('SELECT task_id FROM itervane.execution_slot')).rows[0]).toEqual({ task_id: null });
  await expect(action.fixture.taskService.get(identity, action.schedule.taskId)).resolves.toMatchObject({ state: 'cancelled' });
  expect(await database.storage.db.select().from(operationsExecutionIntents)).toEqual([]);
});

it('serializes operations intent and approval withdrawal under the same environment lock', async () => {
  const action = await queuedOperationsLease();
  const scope = await action.runtime.claim(await fetchOperationsWakeup(), randomUUID());
  if (!scope) throw new Error('Expected a claimed operations execution');
  const [intent, withdrawn] = await Promise.allSettled([action.runtime.prepareDispatch(scope), action.decide('revoke')]);
  expect(withdrawn.status).toBe('fulfilled');
  expect(await database.storage.db.select().from(operationsDecisions)).toHaveLength(2);
  const [recorded] = await database.storage.db.select().from(operationsExecutions);
  if (intent.status === 'fulfilled') {
    expect(recorded?.state).toBe('reserved');
    expect(await database.storage.db.select().from(operationsExecutionIntents)).toEqual([intent.value.intent]);
  } else {
    expect(intent.reason).toBeInstanceOf(ExecutionLost);
    expect(recorded).toMatchObject({ state: 'blocked', blockedReason: 'approval_revoked' });
    expect(await database.storage.db.select().from(operationsExecutionIntents)).toEqual([]);
  }
});

it('recovers an operations intent for reconciliation only and retains the release hold after withdrawal', async () => {
  const action = await queuedOperationsLease();
  const competing = await competingPublication(action.fixture);
  const scope = await action.runtime.claim(await fetchOperationsWakeup(), randomUUID());
  if (!scope) throw new Error('Expected the initial operations execution');
  const { intent } = await action.runtime.prepareDispatch(scope);
  await action.decide('revoke');
  await expect(database.storage.db.update(operationsExecutions).set({ state: 'blocked', blockedReason: 'approval_revoked',
    closedAt: sql`(SELECT decided_at FROM itervane.operations_decisions WHERE proposal_id = ${action.proposal.id} AND version = 2)` })
    .where(eq(operationsExecutions.id, action.execution.id)))
    .rejects.toMatchObject({ cause: { code: '23514', message: 'operations_execution_intent_requires_reconciliation' } });
  await expect(competing.confirm()).rejects.toMatchObject({ code: 'conflict' });

  await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
  await coordinator.reconcile(randomUUID());
  expect((await database.storage.db.select().from(operationsExecutions))[0]?.state).toBe('reserved');
  await expect(action.fixture.taskService.get(identity, action.schedule.taskId)).resolves.toMatchObject({ state: 'reconciling' });
  const successor = await action.runtime.claim(await fetchOperationsWakeup(), randomUUID());
  if (!successor) throw new Error('Expected the reconciliation lease');
  expect(successor).toMatchObject({ mode: 'reconcile', fence: scope.fence + 1 });
  await expect(action.runtime.prepareDispatch(scope)).rejects.toBeInstanceOf(ExecutionLost);
  await expect(action.runtime.prepareDispatch(successor)).rejects.toBeInstanceOf(ExecutionLost);
  await action.runtime.heartbeat(successor);
  expect(await database.storage.db.select().from(operationsExecutionIntents)).toEqual([intent]);
});

it.each(['grant', 'target'] as const)('fences operations dispatch if the %s changes after claim', async changed => {
  const action = await queuedOperationsLease();
  const scope = await action.runtime.claim(await fetchOperationsWakeup(), randomUUID());
  if (!scope) throw new Error('Expected an operations execution lease');
  if (changed === 'grant') {
    const [old] = await database.storage.db.delete(workspaceMembers).returning();
    if (!old) throw new Error('Missing owner grant');
    await database.storage.db.insert(workspaceMembers).values({ principalId: old.principalId, workspaceId: old.workspaceId });
  } else {
    const { registration } = action.fixture;
    await registerOperationsTarget(database.storage, { ...registration, whiskers: { ...registration.whiskers, serverId: 'replacement-after-claim' } });
  }
  await expect(action.runtime.prepareDispatch(scope)).rejects.toMatchObject({ code: changed === 'grant' ? 'forbidden' : 'version_conflict' });
  expect(await database.storage.db.select().from(operationsExecutionIntents)).toEqual([]);
});

it('atomically queues one approved operations execution without reusing the diagnosis run', async () => {
  const action = await restartExecutionCandidate();
  await expect(action.enqueue()).rejects.toMatchObject({ code: 'unsupported_state' });
  const { decision } = await action.decide('confirm');
  const taskCount = (await database.storage.db.select({ id: taskRecords.id }).from(taskRecords)).length;
  await database.admin.query(`ALTER TABLE itervane.operations_execution_schedules ADD CONSTRAINT injected_schedule_failure
    CHECK (false) NOT VALID`);
  try {
    const failure: unknown = await action.enqueue().then(() => undefined, (error: unknown) => error);
    expect(failure instanceof Error && failure.cause instanceof Error ? failure.cause.message : null).toContain('injected_schedule_failure');
    expect(await database.storage.db.select().from(operationsExecutions)).toEqual([]);
    expect(await database.storage.db.select().from(operationsExecutionSchedules)).toEqual([]);
    expect(await database.storage.db.select({ id: taskRecords.id }).from(taskRecords)).toHaveLength(taskCount);
    expect(await database.storage.boss.fetch(operationsExecutionQueue)).toEqual([]);
  } finally {
    await database.admin.query('ALTER TABLE itervane.operations_execution_schedules DROP CONSTRAINT injected_schedule_failure');
  }
  const held = await action.reserve();
  const queued = await Promise.all([action.enqueue(), action.enqueue()]);
  expect(queued.map(item => item.replayed).sort()).toEqual([false, true]);
  const { execution, schedule } = queued[0]!;
  expect(execution.id).toBe(held.execution.id);
  expect(queued[1]?.schedule).toEqual(schedule);
  expect(schedule.taskId).not.toBe(action.diagnosed.id);
  expect(schedule.runId).not.toBe(action.diagnosed.runId);
  const taskService = action.fixture.taskService;
  await expect(taskService.get(identity, schedule.taskId)).resolves.toMatchObject({
    runId: schedule.runId, projectId: action.diagnosed.projectId, requestedBy: decision.actorId,
    workflow: 'operations', source: action.diagnosed.source, locale: 'zh-CN', state: 'queued',
    purpose: translate('zh-CN', 'operations.execution.restart'),
  });
  for (const locale of ['en', 'zh-CN'] as const) {
    const events = await taskService.events(identity, schedule.taskId, 10, locale);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'task.accepted', reason: 'operations_execution_queued',
      reasonMessage: translate(locale, 'reason.operations_execution_queued') });
  }
  await expect(taskService.get(identity, action.diagnosed.id)).resolves.toMatchObject({ state: 'succeeded', version: action.diagnosed.version + 2 });
  await expect(taskService.cancel(identity, schedule.taskId, { expectedVersion: 1 })).rejects.toMatchObject({ code: 'unsupported_state' });
  await expect(taskService.resume(identity, schedule.taskId, { expectedVersion: 1 })).rejects.toMatchObject({ code: 'unsupported_state' });
  await coordinator.reconcile(randomUUID());
  const [ordinaryRun] = await database.storage.db.select().from(taskRuns).where(eq(taskRuns.id, schedule.runId));
  expect(ordinaryRun).toMatchObject({ wakeupJobId: null, generation: 1, state: 'queued' });

  const wakeups = await database.storage.boss.fetch(operationsExecutionQueue, { batchSize: 2 });
  expect(wakeups).toHaveLength(1);
  expect(wakeups[0]).toMatchObject({ id: schedule.wakeupJobId, data: { executionId: execution.id,
    taskId: schedule.taskId, runId: schedule.runId, generation: 1 } });
});

it('closes a fetched operations execution only with the durable revocation and task event', async () => {
  const action = await restartExecutionCandidate();
  const { decision } = await action.decide('confirm');
  const { execution, schedule } = await action.enqueue();
  const [active] = await database.storage.boss.fetch(operationsExecutionQueue, { includeMetadata: true });
  expect(active).toMatchObject({ id: schedule.wakeupJobId, state: 'active' });
  await expect(database.storage.db.insert(operationsDecisions).values({
    proposalId: action.proposal.id, version: 2, actorId: decision.actorId, grantId: decision.grantId,
    action: 'revoke', idempotencyKey: randomUUID(), selfConfirmed: false, decidedAt: sql`clock_timestamp()`,
  })).rejects.toMatchObject({ cause: { code: '23514', message: 'operations_execution_schedule_must_close' } });
  const revoke = randomUUID();
  await database.admin.query(`ALTER TABLE itervane.operations_execution_schedules ADD CONSTRAINT injected_schedule_closure_failure
    CHECK (wakeup_job_id IS NOT NULL) NOT VALID`);
  try {
    await expect(action.decide('revoke', revoke)).rejects.toMatchObject({ cause: { code: '23514', constraint: 'injected_schedule_closure_failure' } });
    expect(await database.storage.db.select().from(operationsDecisions)).toHaveLength(1);
    expect((await database.storage.db.select().from(operationsExecutions))[0]).toMatchObject({ state: 'reserved' });
    expect((await database.storage.boss.findJobs(operationsExecutionQueue, { id: execution.id }))[0]?.state).toBe('active');
    await expect(action.fixture.taskService.get(identity, schedule.taskId)).resolves.toMatchObject({ state: 'queued', version: 1 });
  } finally {
    await database.admin.query('ALTER TABLE itervane.operations_execution_schedules DROP CONSTRAINT injected_schedule_closure_failure');
  }
  await action.decide('revoke', revoke);
  expect(await action.decide('revoke', revoke)).toMatchObject({ replayed: true });
  await expect(action.enqueue()).rejects.toMatchObject({ code: 'unsupported_state' });
  expect((await database.storage.db.select().from(operationsExecutionSchedules))[0]).toMatchObject({ wakeupJobId: null });
  expect((await database.storage.boss.findJobs(operationsExecutionQueue, { id: execution.id }))[0]?.state).toBe('cancelled');
  await expect(action.fixture.taskService.get(identity, schedule.taskId)).resolves.toMatchObject({ state: 'cancelled', version: 2 });
  expect((await action.fixture.taskService.events(identity, schedule.taskId, 10, 'zh-CN')).at(-1))
    .toMatchObject({ actorId: decision.actorId, type: 'task.cancelled', reason: 'operations_execution_revoked' });
});

it('serializes scheduling and withdrawal of the same approved operations proposal', async () => {
  const action = await restartExecutionCandidate();
  await action.decide('confirm');
  const [admission, revocation] = await Promise.allSettled([action.enqueue(), action.decide('revoke')]);
  expect(revocation.status).toBe('fulfilled');
  expect(await database.storage.boss.fetch(operationsExecutionQueue)).toEqual([]);
  if (admission.status === 'fulfilled') {
    await expect(action.fixture.taskService.get(identity, admission.value.schedule.taskId)).resolves.toMatchObject({ state: 'cancelled' });
    expect((await database.storage.db.select().from(operationsExecutions))[0]).toMatchObject({ state: 'blocked', blockedReason: 'approval_revoked' });
  } else {
    expect(admission.reason).toMatchObject({ code: 'unsupported_state' });
    expect(await database.storage.db.select().from(operationsExecutionSchedules)).toEqual([]);
  }
});

it('reserves an approved operations execution only once and closes it atomically on revocation', async () => {
  const action = await restartExecutionCandidate();
  const { proposal, input, reserve, decide } = action;
  const injected = () => database.storage.db.insert(operationsExecutions).values({
    id: randomUUID(), proposalId: proposal.id, environmentId: proposal.environmentId,
    proposalFingerprint: proposal.fingerprint, decisionVersion: 1, state: 'reserved', createdAt: sql`clock_timestamp()`,
  });
  await expect(reserve()).rejects.toMatchObject({ code: 'unsupported_state' });
  await expect(injected()).rejects.toMatchObject({ cause: { code: '23514', message: 'operations_execution_authority_required' } });
  await decide('confirm');
  await expect(action.admission.reserve({ ...input, fingerprint: sha256('different proposal') })).rejects.toMatchObject({ code: 'version_conflict' });
  await expect(action.admission.reserve({ ...input, containerId: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'invalid_input' });
  const results = await Promise.all([reserve(), reserve()]);
  expect(results.map(result => result.replayed).sort()).toEqual([false, true]);
  const execution = results[0]!.execution;
  expect(results[1]?.execution).toEqual(execution);
  expect(execution).toMatchObject({ proposalId: proposal.id, proposalFingerprint: proposal.fingerprint,
    environmentId: proposal.environmentId, decisionVersion: 1, state: 'reserved' });
  await expect(database.storage.db.update(operationsExecutions).set({ state: 'blocked', blockedReason: 'proposal_expired',
    closedAt: sql`clock_timestamp()` })).rejects.toMatchObject({ cause: { code: '23514', message: 'operations_execution_invalid_closure' } });
  await expect(database.storage.db.delete(operationsExecutions)).rejects
    .toMatchObject({ cause: { code: '23514', message: 'operations_execution_is_retained' } });

  const revocationKey = randomUUID();
  await database.admin.query(`ALTER TABLE itervane.operations_executions ADD CONSTRAINT injected_operations_close_failure
    CHECK (state = 'reserved') NOT VALID`);
  try {
    await expect(decide('revoke', revocationKey)).rejects.toMatchObject({ cause: { code: '23514', constraint: 'injected_operations_close_failure' } });
    expect(await database.storage.db.select().from(operationsDecisions)).toHaveLength(1);
    expect((await database.storage.db.select().from(operationsExecutions))[0]).toMatchObject({ state: 'reserved' });
  } finally {
    await database.admin.query('ALTER TABLE itervane.operations_executions DROP CONSTRAINT injected_operations_close_failure');
  }
  const revoked = await decide('revoke', revocationKey);
  expect((await database.storage.db.select().from(operationsExecutions))[0]).toMatchObject({
    id: execution.id, state: 'blocked', blockedReason: 'approval_revoked', closedAt: revoked.decision.decidedAt,
  });
  expect(await decide('revoke', revocationKey)).toMatchObject({ replayed: true });
  await expect(reserve()).rejects.toMatchObject({ code: 'unsupported_state' });
  expect((await action.fixture.taskService.get(identity, action.diagnosed.id)).state).toBe('succeeded');
  expect(await database.storage.db.select().from(operationsDiagnosisResults)).toHaveLength(1);
});

it.each(['operations', 'release', 'concurrent'] as const)('serializes a real queue and an operations execution with %s admission', async first => {
  const action = await restartExecutionCandidate();
  const publication = await competingPublication(action.fixture);
  await action.decide('confirm');
  if (first === 'operations') {
    await action.reserve();
    await expect(publication.confirm()).rejects.toMatchObject({ code: 'conflict' });
    // Include a valid decision so the database reaches the environment guard after its approval checks.
    await expect(database.storage.db.transaction(async tx => {
      const [owner] = await tx.select().from(workspaceMembers);
      if (!owner) throw new Error('Missing fixture owner');
      await tx.insert(releaseDecisions).values({ candidateId: publication.candidateId, version: 1, action: 'confirm',
        actorId: owner.principalId, grantId: owner.grantId, idempotencyKey: randomUUID(), selfConfirmed: true, decidedAt: new Date() });
      await tx.insert(releaseOperations).values({ id: randomUUID(), candidateId: publication.candidateId,
        environmentId: action.proposal.environmentId, approvalVersion: 1 });
    })).rejects.toMatchObject({ cause: { code: '23514', message: 'release_environment_reserved_by_operations' } });
    expect(await database.storage.db.select().from(releaseDecisions).where(eq(releaseDecisions.candidateId, publication.candidateId))).toEqual([]);
    await action.decide('revoke');
    expect(await publication.confirm()).toMatchObject({ operationId: expect.any(String) });
  } else if (first === 'release') {
    await publication.confirm();
    await expect(action.reserve()).rejects.toMatchObject({ code: 'conflict' });
    expect(await database.storage.db.select().from(operationsExecutions)).toEqual([]);
  } else {
    const outcomes = await Promise.allSettled([action.reserve(), publication.confirm()]);
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(item => item.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    const held = await database.storage.db.select().from(operationsExecutions);
    const queued = await database.storage.db.select().from(releaseOperations).where(eq(releaseOperations.candidateId, publication.candidateId));
    expect(held.length + queued.length).toBe(1);
  }
});

it.each(['grant', 'target'] as const)('rejects an approved execution when its %s changes before admission', async scope => {
  const action = await restartExecutionCandidate();
  await action.decide('confirm');
  if (scope === 'grant') {
    const [old] = await database.storage.db.delete(workspaceMembers).returning();
    if (!old) throw new Error('Missing owner grant');
    await database.storage.db.insert(workspaceMembers).values({ principalId: old.principalId, workspaceId: old.workspaceId });
  } else {
    const { registration } = action.fixture;
    await registerOperationsTarget(database.storage, { ...registration, whiskers: { ...registration.whiskers, serverId: 'changed-after-approval' } });
  }
  await expect(action.reserve()).rejects.toMatchObject({ code: scope === 'grant' ? 'forbidden' : 'version_conflict' });
  expect(await database.storage.db.select().from(operationsExecutions)).toEqual([]);
});

it.each(['reserved', 'queued', 'claimed', 'intended'] as const)('reconciles a %s operations reservation at expiry', async mode => {
  const fixture = await installedOperationsFixture();
  const publication = await competingPublication(fixture);
  await database.admin.query(`ALTER TABLE itervane.operations_diagnosis_results
    ALTER COLUMN created_at SET DEFAULT (now() - interval '1788 seconds')`);
  const action = await restartExecutionCandidate(fixture).finally(() =>
    database.admin.query('ALTER TABLE itervane.operations_diagnosis_results ALTER COLUMN created_at SET DEFAULT now()'));
  await action.decide('confirm');
  const scheduled = mode === 'reserved' ? undefined : await action.enqueue();
  if (!scheduled) await action.reserve();
  const runtime = new OperationsExecutionCoordinator(coordinator, action.installed);
  if (mode === 'claimed' || mode === 'intended') {
    const scope = await runtime.claim(await fetchOperationsWakeup(), randomUUID());
    if (!scope) throw new Error('Expected an operations execution lease');
    if (mode === 'intended') await runtime.prepareDispatch(scope);
  }
  await vi.waitFor(async () => {
    const expired = await database.storage.pool.query<{ value: boolean }>('SELECT clock_timestamp() >= $1 AS value', [action.proposal.validUntil]);
    expect(expired.rows[0]?.value).toBe(true);
  }, { timeout: 15_000, interval: 300 });
  await expect(action.reserve()).rejects.toMatchObject({ code: 'unsupported_state' });
  if (mode === 'intended') {
    await expect(publication.confirm()).rejects.toMatchObject({ code: 'conflict' });
    await runtime.reconcile(randomUUID());
    expect((await database.storage.db.select().from(operationsExecutions))[0]?.state).toBe('reserved');
    expect(await database.storage.db.select().from(operationsExecutionIntents)).toHaveLength(1);
    return;
  }
  await publication.confirm();
  expect((await database.storage.db.select().from(operationsExecutions))[0]).toMatchObject({
    state: 'blocked', blockedReason: 'proposal_expired', closedAt: expect.any(Date),
  });
  if (scheduled) {
    const { schedule } = scheduled;
    expect((await database.storage.db.select().from(operationsExecutionSchedules))[0]).toMatchObject({ wakeupJobId: null });
    expect(await database.storage.boss.fetch(operationsExecutionQueue)).toEqual([]);
    await expect(action.fixture.taskService.get(identity, schedule.taskId)).resolves.toMatchObject({ state: 'needs_human' });
    expect((await action.fixture.taskService.events(identity, schedule.taskId, 10, 'en')).at(-1))
      .toMatchObject({ reason: 'operations_execution_expired', reasonMessage: translate('en', 'reason.operations_execution_expired') });
  }
}, 45_000);

it('records an owner portal confirmation once and retains its revocation alongside the diagnosis', async () => {
  const { fixture, installed, diagnosis, task, service } = await settleProposalDiagnosis('restart');
  const { proposal } = await service.freeze(identity, task.id, { diagnosisSha256: diagnosis.sha256 });
  const decisions = new OperationsDecisionService(database.storage, installed, operationsPortal);
  const owner = await decisionIdentity();
  const subject = 'operations-non-owner';
  const principalId = randomUUID();
  await database.storage.db.insert(principals).values({ id: principalId, issuer: issuer.config.issuer, subject });
  await database.storage.db.insert(projectMembers).values({ projectId: fixture.scope.projectId, principalId, role: 'maintainer' });
  const input = { action: 'confirm', expectedVersion: 0, fingerprint: proposal.fingerprint, idempotencyKey: randomUUID() };
  await expect(decisions.decide(identity, proposal.id, input)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(decisions.decide(await decisionIdentity(subject), proposal.id, input)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(new OperationsDecisionService(database.storage, installed).decide(owner, proposal.id, input)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(decisions.decide(owner, proposal.id, { ...input, fingerprint: sha256('different frozen proposal') })).rejects
    .toMatchObject({ code: 'version_conflict' });
  await expect(decisions.decide(owner, proposal.id, { ...input, action: 'revoke' })).rejects.toMatchObject({ code: 'unsupported_state' });

  const results = await Promise.all([decisions.decide(owner, proposal.id, input), decisions.decide(owner, proposal.id, input)]);
  expect(results.map(item => item.replayed).sort()).toEqual([false, true]);
  const [membership] = await database.storage.db.select().from(workspaceMembers);
  expect(results[0]?.decision).toMatchObject({ proposalId: proposal.id, action: 'confirm', version: 1,
    actorId: proposal.proposedBy, grantId: membership?.grantId, selfConfirmed: true });
  await expect(decisions.decide(owner, proposal.id, { ...input, action: 'reject' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  await expect(decisions.decide(owner, proposal.id, { ...input, action: 'reject', idempotencyKey: randomUUID() })).rejects
    .toMatchObject({ code: 'version_conflict' });

  const revoke = { ...input, action: 'revoke', expectedVersion: 1, idempotencyKey: randomUUID() };
  expect(await decisions.decide(owner, proposal.id, revoke)).toMatchObject({ replayed: false, decision: { action: 'revoke', version: 2, selfConfirmed: false } });
  expect(await decisions.decide(owner, proposal.id, revoke)).toMatchObject({ replayed: true });
  expect(await database.storage.db.select().from(operationsDecisions)).toHaveLength(2);
  expect(await database.storage.db.select().from(releaseOperations)).toHaveLength(1);
  await expect(database.storage.db.delete(operationsDecisions)).rejects
    .toMatchObject({ cause: { code: '23514', message: 'operations_decision_is_immutable' } });
  await expect(new OperationsObservationViewService(database.storage).get(identity, task.id, 'zh-CN')).resolves
    .toMatchObject({ state: 'succeeded', diagnosis: { receiptSha256: diagnosis.sha256 } });
});

it('serializes competing owner decisions for a proposal submitted by a project maintainer', async () => {
  const { fixture, installed, diagnosis, task, service } = await settleProposalDiagnosis('restart');
  const subject = 'operations-proposer';
  const principalId = randomUUID();
  await database.storage.db.insert(principals).values({ id: principalId, issuer: issuer.config.issuer, subject });
  await database.storage.db.insert(projectMembers).values({ projectId: fixture.scope.projectId, principalId, role: 'maintainer' });
  const { proposal } = await service.freeze(await decisionIdentity(subject), task.id, { diagnosisSha256: diagnosis.sha256 });
  const decisions = new OperationsDecisionService(database.storage, installed, operationsPortal);
  const owner = await decisionIdentity();
  const input = { expectedVersion: 0, fingerprint: proposal.fingerprint };
  const attempts = await Promise.allSettled([
    decisions.decide(owner, proposal.id, { ...input, action: 'confirm', idempotencyKey: randomUUID() }),
    decisions.decide(owner, proposal.id, { ...input, action: 'reject', idempotencyKey: randomUUID() }),
  ]);
  expect(attempts).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: 'fulfilled', value: { taskId: task.id, replayed: false,
      decision: expect.objectContaining({ version: 1, selfConfirmed: false }) } }),
    expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'version_conflict' }) }),
  ]));
  const before = (await database.storage.db.select().from(operationsDecisions)).at(0);
  expect(before?.actorId).not.toBe(principalId);
  await expect(decisions.decide(owner, proposal.id, { ...input, expectedVersion: 1, action: 'confirm', idempotencyKey: randomUUID() }))
    .rejects.toMatchObject({ code: 'unsupported_state' });
});

it('shares authorized operations proposals across HTTP and MCP and records decisions through the portal identity', async () => {
  const { fixture, installed, diagnosis, task } = await settleProposalDiagnosis('restart');
  const { environmentId, enrollmentSha256, diagnosisProviderSha256 } = installed;
  const publicUrl = 'http://127.0.0.1:4330';
  const app = createApi(database.storage, { ...issuer.config, portalClientId: operationsPortal, publicUrl, operationsApi: {
    environmentId, enrollmentSha256, diagnosisProviderSha256,
  } }, { logger: false });
  const client = new Client({ name: 'operations-proposal-test', version: '0.0.0' });
  try {
    const path = `/v1/tasks/${task.id}/operations-proposal`;
    const normalHeaders = { authorization: `Bearer ${await issuer.token('owner')}`, 'accept-language': 'en' };
    const portalHeaders = { authorization: `Bearer ${await issuer.token('owner', { azp: operationsPortal })}`, 'accept-language': 'zh-CN' };
    const get = async (headers = normalHeaders) => operationsProposalViewSchema.parse((await app.inject({ url: path, headers })).json());
    const draft = await get();
    expect(draft.draft).toEqual({ diagnosisSha256: diagnosis.sha256, kind: 'restart' });
    const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
    const mcpToken = await issuer.token('owner', { aud: `${publicUrl}/mcp`, scope: 'itervane:read itervane:write' });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', endpoint), {
      requestInit: { headers: { authorization: `Bearer ${mcpToken}`, 'accept-language': 'en' } },
    }));
    const request = { name: 'request_operations_proposal', arguments: { taskId: task.id, diagnosisSha256: diagnosis.sha256 } };
    const read = { name: 'get_operations_proposal', arguments: { taskId: task.id } };
    const announced = (await client.listTools()).tools;
    expect(announced.some(tool => /operations.*decision/.test(tool.name))).toBe(false);
    expect(operationsProposalViewSchema.parse((await client.callTool(read)).structuredContent)).toEqual(draft);
    const formed = operationsProposalViewSchema.parse((await client.callTool(request)).structuredContent);
    expect(formed).toEqual(await get());
    const proposal = formed.proposal;
    if (!proposal) throw new Error('Expected a projected proposal');
    expect(proposal).toMatchObject({ status: 'pending', actions: [], current: { operationId: fixture.operationId } });
    for (const privateValue of [fixture.runtime.containerId, fixture.registration.whiskers.origin, operationsFixtureKey]) {
      expect(JSON.stringify(formed)).not.toContain(privateValue);
    }
    expect((await app.inject({ method: 'POST', url: path, headers: portalHeaders, payload: { diagnosisSha256: diagnosis.sha256 } })).statusCode).toBe(200);
    expect((await get(portalHeaders)).proposal).toMatchObject({ actions: ['confirm', 'reject'], message: '此处置正在等待人工审批。' });

    const url = `/v1/operations/proposals/${proposal.id}/decisions`;
    const payload = { action: 'confirm', fingerprint: proposal.fingerprint, expectedVersion: 0, idempotencyKey: randomUUID() };
    expect((await app.inject({ method: 'POST', url, headers: normalHeaders, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers: portalHeaders, payload })).json()).toMatchObject({
      proposal: { status: 'confirmed', actions: ['revoke'], decisions: [{ action: 'confirm', selfConfirmed: true }] },
    });
    expect(operationsProposalViewSchema.parse((await client.callTool(read)).structuredContent)).toEqual(await get());
    await registerOperationsTarget(database.storage, { ...fixture.registration,
      whiskers: { ...fixture.registration.whiskers, serverId: 'proposal-target-moved' } });
    expect((await get(portalHeaders)).proposal).toMatchObject({ status: 'stale', actions: ['revoke'] });
    expect((await app.inject({ method: 'POST', url, headers: portalHeaders, payload: {
      ...payload, action: 'revoke', expectedVersion: 1, idempotencyKey: randomUUID(),
    } })).json()).toMatchObject({ proposal: { status: 'revoked', actions: [] } });
  } finally {
    await client.close();
    await app.close();
  }
});

it('queues and resumes a restart through the bound human portal, once per request', async () => {
  const action = await restartExecutionCandidate();
  const writer = await registerRestartInstallation(restartInstallation(action.fixture));
  const config = { ...issuer.config, portalClientId: operationsPortal, operationsApi: action.installed };
  const app = createApi(database.storage, config, { logger: false, operationsRestartWriter: writer });
  const disabled = createApi(database.storage, config, { logger: false });
  const wrongWriter = createApi(database.storage, config, { logger: false, operationsRestartWriter: { ...writer, installationSha256: sha256('another installation') } });
  try {
    const url = `/v1/tasks/${action.diagnosed.id}/operations-execution`;
    const submitUrl = `/v1/operations/proposals/${action.proposal.id}/execution`;
    const portal = { authorization: `Bearer ${await issuer.token('owner', { azp: operationsPortal })}`, 'accept-language': 'zh-CN' };
    const assistant = { authorization: `Bearer ${await issuer.token('owner')}` };
    const view = async () => operationsRestartExecutionViewSchema.parse((await app.inject({ url, headers: portal })).json());
    const payload = { fingerprint: action.proposal.fingerprint, decisionVersion: 1 };
    const submit = (headers = portal, body = payload) => app.inject({ method: 'POST', url: submitUrl, headers, payload: body });
    expect(await view()).toMatchObject({ execution: null, action: null });
    expect((await submit()).statusCode).toBe(409);
    await action.decide('confirm');
    expect((await view()).action).toEqual({ kind: 'enqueue', proposalId: action.proposal.id, ...payload });
    expect((await disabled.inject({ url, headers: portal })).json()).toMatchObject({ action: null, execution: null });
    expect((await disabled.inject({ method: 'POST', url: submitUrl, headers: portal, payload })).statusCode).toBe(404);
    expect((await wrongWriter.inject({ url, headers: portal })).json()).toMatchObject({ action: null, execution: null });
    expect((await wrongWriter.inject({ method: 'POST', url: submitUrl, headers: portal, payload })).statusCode).toBe(409);
    expect((await submit({ ...portal, ...assistant })).statusCode).toBe(403);
    expect((await submit(portal, { ...payload, fingerprint: sha256('different proposal') })).statusCode).toBe(409);
    const results = await Promise.all([submit(), submit()]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 202]);
    const receipts = results.map(result => operationsRestartSubmissionSchema.parse(result.json()));
    const executionId = receipts[0]!.executionId;
    expect(receipts.every(receipt => receipt.executionId === executionId)).toBe(true);
    expect(await database.storage.db.select().from(operationsExecutionSchedules)).toHaveLength(1);
    expect(await view()).toMatchObject({ execution: { id: executionId, state: 'queued', environmentHeld: true, recovery: null }, action: null });

    const runtime = new OperationsExecutionCoordinator(coordinator, action.installed);
    const scope = await runtime.claim(await fetchOperationsWakeup(), randomUUID());
    if (!scope) throw new Error('Expected an initial restart lease');
    const { restartRequest } = await runtime.prepareDispatch(scope, writer, stoppedBaseline(action.fixture));
    if (!restartRequest) throw new Error('Expected the original restart request');
    const approval = { callSha256: restartRequest.callSha256, approvalId: randomUUID().replaceAll('-', '') };
    await runtime.pauseForRestartApproval(scope, approval);
    const waiting = await view();
    const continuation = waiting.action;
    if (continuation?.kind !== 'continue') throw new Error('Expected the bound human continuation');
    expect(waiting.execution).toMatchObject({ nativeApprovalId: approval.approvalId, state: 'waiting_approval',
      message: translate('zh-CN', 'reason.operations_execution_native_approval'), environmentHeld: true });
    const { kind, executionId: boundId, ...binding } = continuation;
    expect({ kind, boundId, callSha256: binding.callSha256, approvalId: binding.approvalId }).toEqual({ kind: 'continue', boundId: executionId, ...approval });
    const urlContinue = `/v1/operations/executions/${executionId}/continue`;
    const request = { ...binding, idempotencyKey: randomUUID() };
    const resume = (body = request, headers = portal) => app.inject({ method: 'POST', url: urlContinue, headers, payload: body });
    expect((await resume(request, { ...portal, ...assistant })).statusCode).toBe(403);
    expect((await resume({ ...request, approvalId: randomUUID().replaceAll('-', '') })).statusCode).toBe(409);
    expect((await resume({ ...request, expectedVersion: request.expectedVersion + 1 })).statusCode).toBe(409);
    expect((await wrongWriter.inject({ method: 'POST', url: urlContinue, headers: portal, payload: request })).statusCode).toBe(409);
    expect((await app.inject({ url, headers: assistant })).json()).toMatchObject({ action: null, execution: {
      nativeApprovalId: approval.approvalId, message: translate('en', 'reason.operations_execution_native_approval'),
    } });
    expect((await Promise.all([resume(), resume()])).map(result => result.statusCode).sort()).toEqual([200, 202]);
    expect(await database.storage.db.select().from(operationsRestartResumes)).toHaveLength(1);
    expect((await view()).action).toBeNull();
    await action.decide('revoke');
    expect((await resume()).statusCode).toBe(409);
    expect(await view()).toMatchObject({ execution: { state: 'reconciling', environmentHeld: true }, action: null });
  } finally {
    await Promise.all([app.close(), disabled.close(), wrongWriter.close()]);
  }
});

it('projects a redacted verified restart receipt under current HTTP and read-only MCP project access', async () => {
  const { action, runtime, approval, binding, claimRecovery, outcomeEvidence } = await restartAwaitingRecovery();
  const { scope } = await claimRecovery();
  const cases = new LearningCaseService(database.storage);
  await expect(cases.capture(identity, action.diagnosed.id, { runId: action.diagnosed.runId, evidenceSha256: sha256('unsettled') }, 'en'))
    .rejects.toMatchObject({ code: 'unsupported_state' });
  await expect(runtime.settleRestartRecovery(scope, outcomeEvidence)).resolves.toBe('verified');
  const publicUrl = 'http://127.0.0.1:4330';
  const config = { ...issuer.config, publicUrl, portalClientId: operationsPortal, operationsApi: action.installed,
    ruleExtractionProviderSha256: extractionModel().providerSha256, candidateValidation: {} };
  const { installationId, installationSha256, credentialSha256 } = binding;
  const app = createApi(database.storage, config, { logger: false, operationsRestartWriter: { installationId, installationSha256, credentialSha256 } });
  const reader = new Client({ name: 'restart-receipt-test', version: '0.0.0' });
  const writer = new Client({ name: 'restart-mcp-write-scope-test', version: '0.0.0' });
  try {
    const projectId = action.diagnosed.projectId;
    const subject = 'restart-receipt-viewer';
    const principalId = randomUUID();
    await database.storage.db.insert(principals).values({ id: principalId, issuer: config.issuer, subject });
    const http = { authorization: `Bearer ${await issuer.token(subject)}`, 'accept-language': 'zh-CN' };
    const url = `/v1/tasks/${action.diagnosed.id}/operations-execution`;
    expect((await app.inject({ url, headers: http })).statusCode).toBe(404);
    await database.storage.db.insert(projectMembers).values({ principalId, projectId, role: 'viewer' });
    const response = await app.inject({ url, headers: http });
    expect(response.statusCode).toBe(200);
    const view = operationsRestartExecutionViewSchema.parse(response.json());
    const [proof] = await database.storage.db.select().from(operationsRestartRecoveries);
    const captureUrl = `/v1/tasks/${action.diagnosed.id}/learning-case`;
    const payload = { runId: action.diagnosed.runId, evidenceSha256: proof!.proofSha256! };
    expect((await app.inject({ url: captureUrl, method: 'POST', headers: http, payload })).statusCode).toBe(403);
    const ownerHttp = { authorization: `Bearer ${await issuer.token()}` };
    const captured = await app.inject({ url: captureUrl, method: 'POST', headers: ownerHttp, payload });
    expect(captured.statusCode).toBe(201);
    const { item } = learningCaseCaptureResultSchema.parse(captured.json());
    expect(item.document).toMatchObject({ projectId, evidenceSha256: proof?.proofSha256, facts: { category: 'recovered_stopped_instance',
      actionTaskId: scope.taskId, executionId: action.execution.id, releaseOperationId: action.fixture.operationId,
      sameInstance: true, healthStatus: 200 } });
    const listing = `/v1/projects/${projectId}/learning-cases?category=recovered_stopped_instance`;
    const scopedCases = await app.inject({ url: listing, headers: http });
    expect(scopedCases.statusCode).toBe(200);
    expect(learningCasesViewSchema.parse(scopedCases.json()).items).toMatchObject([{ id: item.id, sha256: item.sha256, locale: 'zh-CN' }]);
    const extractionPath = `/v1/projects/${projectId}/learning-cases/${item.id}/extractions`;
    const input = { caseSha256: item.sha256, locale: 'zh-CN', idempotencyKey: randomUUID() };
    expect((await app.inject({ url: extractionPath, method: 'POST', headers: http, payload: input })).statusCode).toBe(403);
    const admit = (body: typeof input) => app.inject({ url: extractionPath, method: 'POST', headers: ownerHttp, payload: body });
    const admitted = await Promise.all([admit(input), admit(input)]);
    expect(admitted.map(value => value.statusCode).sort()).toEqual([200, 202]);
    const task = admissionDtoSchema.parse(admitted[0]!.json()).task;
    expect(admissionDtoSchema.parse(admitted[1]!.json()).task).toEqual(task);
    const observed = await processExtraction(task);
    expect(observed).toMatchObject({ state: 'succeeded', result: { document: { extraction: {
      caseId: item.id, result: { outcome: 'candidate', candidate: { kind: 'runbook', action: 'restart_current_publication' } },
    } } } });
    const report = ruleExtractionViewSchema.parse((await app.inject({ url: `/v1/tasks/${task.id}/rule-extraction`, headers: http })).json());
    expect(report.result).toEqual(observed.result);
    const validationUrl = `/v1/projects/${projectId}/rule-candidates/${report.result!.id}/validations`;
    const validationPayload = { extractionResultSha256: report.result!.sha256, locale: 'zh-CN', idempotencyKey: randomUUID() };
    expect((await app.inject({ url: validationUrl, method: 'POST', headers: http, payload: validationPayload })).statusCode).toBe(403);
    const validation = await app.inject({ url: validationUrl, method: 'POST', headers: ownerHttp, payload: validationPayload });
    expect(validation.statusCode).toBe(202);
    const validationTask = admissionDtoSchema.parse(validation.json()).task;
    expect(validationTask.workflow).toBe('rule-validation');
    const checked = await processCandidateValidation(validationTask, {});
    const presented = await app.inject({ url: `/v1/tasks/${validationTask.id}/candidate-validation`, headers: http });
    expect(candidateValidationViewSchema.parse(presented.json())).toEqual(checked);
    expect(checked).toMatchObject({ state: 'succeeded', result: { document: { status: 'passed', evidence: { kind: 'runbook',
      evaluatorVersion: 1, result: { scenarios: { stale: 'stop_target_drift', unapproved: 'await_approval' },
        recovery: { unknown: 'stop_unknown', verified: 'verified_recovered' } },
    } } } });
    const publishedRunbook = await assertCandidatePublication(checked.result!, operationsPortal);
    expect((await database.admin.query("SELECT count(*)::int n FROM itervane.checkpoint_write_receipts WHERE run_id=$1 AND graph='rule-extraction'",
      [task.runId])).rows[0]?.n).toBeGreaterThan(0);
    await expect(database.storage.pool.query('UPDATE itervane.rule_extraction_results SET document=document WHERE run_id=$1', [task.runId]))
      .rejects.toMatchObject({ code: '23514', message: 'rule_extraction_result_is_immutable' });

    const mismatched = admissionDtoSchema.parse((await admit({ ...input, idempotencyKey: randomUUID() })).json()).task;
    const stopped = await processExtraction(mismatched, { ...extractionModel(), providerSha256: sha256('rotated provider') });
    expect(stopped).toMatchObject({ state: 'needs_human', result: null, message: translate('zh-CN', 'reason.rule_extraction_model_changed') });
    const recoverTask = admissionDtoSchema.parse((await admit({ ...input, idempotencyKey: randomUUID() })).json()).task;
    const lease = await claim();
    expect(lease).toMatchObject({ taskId: recoverTask.id, runId: recoverTask.runId });
    await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second' WHERE run_id=$1", [recoverTask.runId]);
    await expect(coordinator.withLease(lease, async () => true)).rejects.toBeInstanceOf(ExecutionLost);
    expect(await processExtraction(recoverTask)).toMatchObject({ state: 'succeeded', result: { document: {
      extraction: { result: { outcome: 'duplicate', existingCandidateId: report.result?.id } },
    } } });

    await database.storage.db.update(projectMembers).set({ role: 'maintainer' }).where(eq(projectMembers.principalId, principalId));
    const maintainer = await app.inject({ url: extractionPath, method: 'POST', headers: http, payload: { ...input, idempotencyKey: randomUUID() } });
    const revoked = admissionDtoSchema.parse(maintainer.json()).task;
    await database.storage.db.update(projectMembers).set({ role: 'viewer' }).where(eq(projectMembers.principalId, principalId));
    expect(await processExtraction(revoked)).toMatchObject({ state: 'needs_human', result: null });
    await expect(database.storage.pool.query('DELETE FROM itervane.learning_cases WHERE id=$1', [item.id]))
      .rejects.toMatchObject({ code: '23514', message: 'learning_case_is_immutable' });
    expect(view).toMatchObject({ taskId: action.diagnosed.id, locale: 'zh-CN', action: null, execution: {
      id: action.execution.id, taskId: scope.taskId, runId: scope.runId, proposalId: action.proposal.id,
      releaseOperationId: action.fixture.operationId, nativeApprovalId: approval.approvalId, state: 'succeeded', environmentHeld: false,
      message: translate('zh-CN', 'reason.operations_restart_recovery_verified'),
      recovery: { state: 'verified', failure: null, proofSha256: proof?.proofSha256 },
    } });
    for (const value of [action.fixture.registration.whiskers.origin, action.fixture.runtime.containerId, approval.callSha256, operationsFixtureKey]) {
      expect(JSON.stringify(view)).not.toContain(value);
      expect(JSON.stringify(item)).not.toContain(value);
    }
    const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
    const token = await issuer.token(subject, { aud: `${publicUrl}/mcp`, scope: 'itervane:read' });
    await reader.connect(new StreamableHTTPClientTransport(new URL('/mcp', endpoint), {
      requestInit: { headers: { authorization: `Bearer ${token}`, 'accept-language': 'zh-CN' } },
    }));
    const ownerToken = await issuer.token('owner', { aud: `${publicUrl}/mcp`, azp: operationsPortal, scope: 'itervane:read itervane:write' });
    await writer.connect(new StreamableHTTPClientTransport(new URL('/mcp', endpoint), {
      requestInit: { headers: { authorization: `Bearer ${ownerToken}`, 'accept-language': 'zh-CN' } },
    }));
    const tools = (await writer.listTools()).tools;
    expect(tools.filter(tool => /operations.*(execution|continue|restart)/.test(tool.name)).map(tool => tool.name)).toEqual(['get_operations_execution']);
    const call = { name: 'get_operations_execution', arguments: { taskId: action.diagnosed.id } };
    expect((await reader.callTool(call)).structuredContent).toEqual(view);
    const extractionCall = { name: 'get_rule_extraction', arguments: { taskId: task.id } };
    const validationCall = { name: 'get_candidate_validation', arguments: { taskId: validationTask.id } };
    expect((await reader.callTool(extractionCall)).structuredContent).toEqual(report);
    expect((await reader.callTool(validationCall)).structuredContent).toEqual(checked);
    const later = await new TaskService(database.storage).admitOperations(identity, { projectId, environmentId: action.fixture.scope.environmentId,
      idempotencyKey: randomUUID(), locale: 'zh-CN', expectedReleaseOperationId: action.fixture.operationId }, action.installed);
    const snapshotPath = `/v1/tasks/${later.task.id}/rule-snapshot`;
    const snapshotCall = { name: 'get_task_rule_snapshot', arguments: { taskId: later.task.id } };
    const snapshot = taskRuleSnapshotViewSchema.parse((await app.inject({ url: snapshotPath, headers: http })).json());
    expect(snapshot.snapshot?.document).toMatchObject({ purpose: 'operations', entries: [{ kind: 'runbook', versionId: publishedRunbook.versionId, sequence: 3 }] });
    expect((await reader.callTool(snapshotCall)).structuredContent).toEqual(snapshot);
    const validationSnapshot = await app.inject({ url: `/v1/tasks/${validationTask.id}/rule-snapshot`, headers: http });
    expect(taskRuleSnapshotViewSchema.parse(validationSnapshot.json()).snapshot).toBeNull();
    await database.storage.db.delete(projectMembers).where(eq(projectMembers.principalId, principalId));
    expect((await app.inject({ url, headers: http })).statusCode).toBe(404);
    expect((await app.inject({ url: listing, headers: http })).statusCode).toBe(404);
    expect(await reader.callTool(call)).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_found' } } });
    for (const request of [extractionCall, validationCall, snapshotCall]) {
      expect(await reader.callTool(request)).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_found' } } });
    }
  } finally {
    await Promise.all([reader.close(), writer.close()]);
    await app.close();
  }
}, 60_000);

it('rejects portal restart submission after the original approval grant is replaced', async () => {
  const action = await restartExecutionCandidate();
  const writer = await registerRestartInstallation(restartInstallation(action.fixture));
  await action.decide('confirm');
  const app = createApi(database.storage, { ...issuer.config, portalClientId: operationsPortal, operationsApi: action.installed },
    { logger: false, operationsRestartWriter: writer });
  try {
    const [grant] = await database.storage.db.delete(workspaceMembers).returning();
    if (!grant) throw new Error('Expected the original workspace grant');
    await database.storage.db.insert(workspaceMembers).values({ principalId: grant.principalId, workspaceId: grant.workspaceId });
    const headers = { authorization: `Bearer ${await issuer.token('owner', { azp: operationsPortal })}` };
    const view = await app.inject({ url: `/v1/tasks/${action.diagnosed.id}/operations-execution`, headers });
    expect(view.json()).toMatchObject({ action: null, execution: null });
    const response = await app.inject({ method: 'POST', url: `/v1/operations/proposals/${action.proposal.id}/execution`,
      headers, payload: { fingerprint: action.proposal.fingerprint, decisionVersion: 1 } });
    expect(response.statusCode).toBe(403);
    expect(await database.storage.db.select().from(operationsExecutionSchedules)).toEqual([]);
    expect(await database.storage.db.select().from(operationsExecutions)).toEqual([]);
  } finally {
    await app.close();
  }
});

it('keeps the installed API tied to the current restart registration through rotation', async () => {
  const action = await restartExecutionCandidate();
  await action.decide('confirm');
  const first = restartInstallation(action.fixture);
  const next = restartInstallation(action.fixture);
  const directory = await mkdtemp(join(tmpdir(), 'itervane-restart-api-'));
  const file = join(directory, 'registration.json');
  const settings = { DATABASE_URL: database.runtimeUrl, ITERVANE_OIDC_ISSUER: issuer.config.issuer, ITERVANE_OIDC_AUDIENCE: issuer.config.audience,
    ITERVANE_PORTAL_CLIENT_ID: operationsPortal, ITERVANE_OPERATIONS_API_ENABLED: '1',
    ITERVANE_OPERATIONS_ENVIRONMENT_ID: action.installed.environmentId, ITERVANE_OPERATIONS_ENROLLMENT_SHA256: action.installed.enrollmentSha256,
    ITERVANE_OPERATIONS_DIAGNOSIS_PROVIDER_SHA256: action.installed.diagnosisProviderSha256 };
  const optional = { ...settings, ITERVANE_RESTART_API_INSTALLATION_FILE: file };
  const started: ReturnType<typeof createApi>[] = [];
  let closed = 0;
  const start = async (env: NodeJS.ProcessEnv = optional) => {
    const { app } = await createInstalledApi(database.storage, runtimeConfig(env), { logger: false });
    app.addHook('onClose', async () => { closed++; });
    started.push(app);
    return app;
  };
  try {
    const defaultApi = await start(settings);
    const headers = { authorization: `Bearer ${await issuer.token('owner', { azp: operationsPortal })}` };
    const url = `/v1/tasks/${action.diagnosed.id}/operations-execution`;
    const submit = `/v1/operations/proposals/${action.proposal.id}/execution`;
    const payload = { fingerprint: action.proposal.fingerprint, decisionVersion: 1 };
    expect((await defaultApi.inject({ method: 'POST', url: submit, headers, payload })).statusCode).toBe(404);
    expect((await defaultApi.inject({ url, headers })).json()).toMatchObject({ action: null });

    expect(() => runtimeConfig({ ...optional, ITERVANE_PORTAL_CLIENT_ID: undefined })).toThrow('operations_restart_api_requires_formal_diagnosis_and_portal');
    expect(() => runtimeConfig({ ...optional, ITERVANE_OPERATIONS_DIAGNOSIS_PROVIDER_SHA256: undefined }))
      .toThrow('operations_restart_api_requires_formal_diagnosis_and_portal');
    expect(() => runtimeConfig({ ...optional, ITERVANE_RESTART_API_INSTALLATION_FILE: 'registration.json' })).toThrow();
    await writeFile(file, JSON.stringify(first), { mode: 0o600 });
    await expect(start()).rejects.toMatchObject({ code: 'version_conflict' });
    await registerRestartInstallation(first);
    await writeFile(file, JSON.stringify({ ...first, enrollmentSha256: sha256('wrong enrollment') }));
    await expect(start()).rejects.toThrow('operations_restart_api_enrollment_mismatch');
    await writeFile(file, JSON.stringify({ ...first, policySha256: sha256('unregistered policy') }));
    await expect(start()).rejects.toMatchObject({ code: 'version_conflict' });
    await writeFile(file, JSON.stringify(first));
    const original = await start();
    expect((await original.inject({ url, headers })).json()).toMatchObject({ action: { kind: 'enqueue', proposalId: action.proposal.id } });

    await registerRestartInstallation(next, first.installationId);
    await expect(start()).rejects.toMatchObject({ code: 'version_conflict' });
    expect((await original.inject({ url, headers })).json()).toMatchObject({ action: null });
    expect((await original.inject({ method: 'POST', url: submit, headers, payload })).statusCode).toBe(409);
    expect(await database.storage.db.select().from(operationsExecutions)).toEqual([]);
    await writeFile(file, JSON.stringify(next));
    const replacement = await start();
    expect((await replacement.inject({ method: 'POST', url: submit, headers, payload })).statusCode).toBe(202);
    expect((await replacement.inject({ url, headers })).json()).toMatchObject({ execution: { state: 'queued', environmentHeld: true }, action: null });
  } finally {
    await Promise.all(started.map(app => app.close()));
    expect(closed).toBe(started.length);
    await unlink(file).catch(() => {});
    await rmdir(directory);
  }
});

it.each(['replaced', 'proposer_revoked', 'publishing', 'expired'] as const)('blocks human confirmation when the proposal is %s', async mode => {
  if (mode === 'expired') await database.admin.query(`ALTER TABLE itervane.operations_diagnosis_results
    ALTER COLUMN created_at SET DEFAULT (now() - interval '1788 seconds')`);
  const { fixture, installed, diagnosis, task: diagnosed, service } = await settleProposalDiagnosis('restart')
    .finally(async () => {
      if (mode === 'expired') await database.admin.query('ALTER TABLE itervane.operations_diagnosis_results ALTER COLUMN created_at SET DEFAULT now()');
    });
  const subject = 'operations-decision-requester';
  const principalId = randomUUID();
  const membership = { projectId: fixture.scope.projectId, principalId, role: 'maintainer' };
  await database.storage.db.insert(principals).values({ id: principalId, issuer: issuer.config.issuer, subject });
  await database.storage.db.insert(projectMembers).values(membership);
  const { proposal } = await service.freeze(await decisionIdentity(subject), diagnosed.id, { diagnosisSha256: diagnosis.sha256 });
  if (mode === 'replaced') await registerOperationsTarget(database.storage, { ...fixture.registration,
    whiskers: { ...fixture.registration.whiskers, serverId: 'changed-after-proposal' } });
  if (mode === 'proposer_revoked') {
    await database.storage.db.delete(projectMembers).where(eq(projectMembers.principalId, principalId));
    await database.storage.db.insert(projectMembers).values(membership);
  }
  if (mode === 'publishing') {
    task = (await fixture.taskService.admit(identity, { projectId: fixture.scope.projectId, source: task.source, purpose: 'Another approved release',
      dataClass: 'synthetic', locale: 'en', idempotencyKey: randomUUID() })).task;
    await queuedFormalRelease({ existingTarget: fixture.target });
  }
  if (mode === 'expired') await vi.waitFor(async () => {
    const time = await database.storage.pool.query<{ expired: boolean }>('SELECT clock_timestamp() >= $1 AS expired', [proposal.validUntil]);
    expect(time.rows[0]?.expired).toBe(true);
  }, { timeout: 15_000, interval: 300 });
  const code = { replaced: 'version_conflict', proposer_revoked: 'forbidden', publishing: 'conflict', expired: 'unsupported_state' }[mode];
  await expect(new OperationsDecisionService(database.storage, installed, operationsPortal).decide(await decisionIdentity(), proposal.id, {
    action: 'confirm', expectedVersion: 0, fingerprint: proposal.fingerprint, idempotencyKey: randomUUID(),
  })).rejects.toMatchObject({ code });
  expect(await database.storage.db.select().from(operationsDecisions)).toEqual([]);
});

it('drops a pending operations diagnosis fetch after the installed server is changed', async () => {
  const fixture = await installedOperationsFixture();
  const operations = diagnosisInstallation(fixture);
  const { task } = await fixture.taskService.admitOperations(identity, { ...fixture.scope, idempotencyKey: randomUUID() }, operations);
  const auditModel = { adapter: scriptedOperations(), providerSha256: operations.diagnosisProviderSha256 };
  const whiskers = scopedWhiskers(fixture, async () => {
    await registerOperationsTarget(database.storage, { ...fixture.registration,
      whiskers: { ...fixture.registration.whiskers, serverId: 'replaced-during-diagnosis' } });
  }, 'running');
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { operations, auditModel, leaseSeconds: 30 });
  try { expect(await worker.tick()).toBe(true); }
  finally { await worker.close(); whiskers.restore(); }
  expect(whiskers.tools).toEqual(['get_container_details']);
  expect(await database.storage.db.select().from(operationsObservations)).toEqual([]);
  expect(await database.storage.db.select().from(operationsDiagnosisResults)).toEqual([]);
  expect((await database.storage.db.select().from(operationsDiagnosisReads)).at(0)).toMatchObject({ section: 'container', state: 'reserved' });
  expect((await fixture.taskService.events(identity, task.id, 10, 'en')).at(-1)).toMatchObject({
    state: 'needs_human', reason: 'operations_target_changed',
  });
});

it('reserves one budget per evidence section, replays its record and limits successor attempts', async () => {
  const fixture = await installedOperationsFixture();
  const installed = diagnosisInstallation(fixture);
  const admitted = await fixture.taskService.admitOperations(identity, { ...fixture.scope, idempotencyKey: randomUUID() }, installed);
  const original = await claimOperations(installed);
  if (!original) throw new Error('Expected diagnosis lease');
  const store = new OperationsEvidenceStore(coordinator, installed);
  const logsId = sha256('planned logs observation');
  const logs = { kind: 'operations_section', section: 'logs', proofSha256: sha256('fixed log signals'), result: {
    containerId: fixture.runtime.containerId, serverId: fixture.registration.whiskers.serverId,
    observedAt: new Date().toISOString(), tailLines: 40, lines: 4, warningLines: 1, errorLines: 1,
  } } as const;
  const concurrent = await Promise.allSettled([store.reserve(original, 'logs', logsId), store.reserve(original, 'logs', logsId)]);
  expect(concurrent).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: 'fulfilled', value: { state: 'reserved', target: {
      ...fixture.registration.whiskers, containerId: fixture.runtime.containerId,
    } } }),
    expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'conflict' }) }),
  ]));
  await expect(store.reserve(original, 'metrics', logsId)).rejects.toMatchObject({ code: 'version_conflict' });
  await expect(store.record(original, logsId, { ...logs, result: { ...logs.result, containerId: sha256('another container') } }))
    .rejects.toMatchObject({ reason: 'operations_invalid_observation' });

  const [request] = await database.storage.db.select().from(operationsRequests).where(eq(operationsRequests.runId, admitted.task.runId));
  const legacy = { version: 1, taskId: original.taskId, runId: original.runId, fence: original.fence,
    releaseOperationId: fixture.operationId, bindingSha256: request!.sha256, observation: {
      containerId: logs.result.containerId, serverId: logs.result.serverId, observedAt: logs.result.observedAt, state: 'exited',
    } };
  await expect(database.storage.pool.query(`INSERT INTO itervane.operations_observations
    (run_id,worker_id,fence,binding_sha256,sha256,document) VALUES ($1,$2,$3,$4,$5,$6)`,
  [original.runId, original.workerId, original.fence, request!.sha256, sha256(JSON.stringify(legacy)), JSON.stringify(legacy)]))
    .rejects.toMatchObject({ code: '23514', message: 'operations_diagnosis_settlement_required' });

  const successor = await reclaimDiagnosis(original, installed);
  await expect(store.record(successor, logsId, logs)).rejects.toBeInstanceOf(ExecutionLost);
  await expect(store.reserve(successor, 'logs', logsId)).resolves.toMatchObject({ state: 'reserved' });
  await expect(store.record(original, logsId, logs)).rejects.toBeInstanceOf(ExecutionLost);
  await expect(store.record(successor, logsId, logs)).resolves.toEqual(logs);
  await expect(store.record(successor, logsId, logs)).resolves.toEqual(logs);
  await expect(store.record(successor, logsId, { ...logs, proofSha256: sha256('wrong digest') })).rejects.toMatchObject({ code: 'version_conflict' });
  await expect(database.storage.pool.query("DELETE FROM itervane.operations_diagnosis_reads WHERE run_id=$1 AND section='logs'", [successor.runId]))
    .rejects.toMatchObject({ code: '23514', message: 'operations_diagnosis_read_is_immutable' });

  const metricsId = sha256('planned metrics observation');
  await store.reserve(successor, 'metrics', metricsId);
  const third = await reclaimDiagnosis(successor, installed);
  await expect(store.reserve(third, 'logs', logsId)).resolves.toEqual({ state: 'recorded', evidence: logs });
  await expect(store.reserve(third, 'logs', sha256('different operation'))).rejects.toMatchObject({ code: 'version_conflict' });
  await store.reserve(third, 'metrics', metricsId);
  const fourth = await reclaimDiagnosis(third, installed);
  await expect(store.reserve(fourth, 'metrics', metricsId)).rejects.toBeInstanceOf(BudgetExhausted);
  expect(await database.storage.db.select().from(operationsDiagnosisReads)).toEqual(expect.arrayContaining([
    expect.objectContaining({ section: 'logs', state: 'recorded', attempts: 2, fence: successor.fence }),
    expect.objectContaining({ section: 'metrics', state: 'reserved', attempts: 2, fence: third.fence }),
  ]));
  const [budget] = await database.storage.db.select().from(runRuntime).where(eq(runRuntime.runId, fourth.runId));
  expect(budget).toMatchObject({ maxTools: 4, toolsUsed: 2 });
});

it('records diagnosis evidence when the database clock is behind the reservation timestamp', async () => {
  const { fixture, installed, scope } = await startDiagnosis();
  const store = new OperationsEvidenceStore(coordinator, installed);
  const operationId = sha256('logs with a previous higher clock reading');
  const evidence = { kind: 'operations_section', section: 'logs', proofSha256: sha256('fixed log signals'), result: {
    containerId: fixture.runtime.containerId, serverId: fixture.registration.whiskers.serverId,
    observedAt: new Date().toISOString(), tailLines: 40, lines: 4, warningLines: 1, errorLines: 1,
  } } as const;
  await database.admin.query(`ALTER TABLE itervane.operations_diagnosis_reads
    ALTER COLUMN created_at SET DEFAULT (clock_timestamp() + interval '5 minutes')`);
  try { await store.reserve(scope, 'logs', operationId); }
  finally {
    await database.admin.query('ALTER TABLE itervane.operations_diagnosis_reads ALTER COLUMN created_at SET DEFAULT now()');
  }
  await expect(store.record(scope, operationId, evidence)).resolves.toEqual(evidence);
  const [recorded] = await database.storage.db.select().from(operationsDiagnosisReads)
    .where(and(eq(operationsDiagnosisReads.runId, scope.runId), eq(operationsDiagnosisReads.section, 'logs')));
  expect(recorded?.state).toBe('recorded');
  expect(recorded?.recordedAt).toEqual(recorded?.createdAt);
});

it.each(['cancel', 'remap'] as const)('rejects a diagnosis result after %s during its reservation', async mode => {
  const fixture = await installedOperationsFixture();
  const installed = diagnosisInstallation(fixture);
  const { task } = await fixture.taskService.admitOperations(identity, { ...fixture.scope, idempotencyKey: randomUUID() }, installed);
  const scope = await claimOperations(installed);
  if (!scope) throw new Error('Expected diagnosis lease');
  const store = new OperationsEvidenceStore(coordinator, installed);
  const id = sha256('planned container observation');
  await store.reserve(scope, 'container', id);
  const observed = { kind: 'operations_section', section: 'container', proofSha256: sha256('container proof'), result: {
    containerId: fixture.runtime.containerId, serverId: fixture.registration.whiskers.serverId,
    observedAt: new Date().toISOString(), state: 'exited',
  } };
  if (mode === 'cancel') {
    const current = await fixture.taskService.get(identity, task.id);
    await fixture.taskService.cancel(identity, task.id, { expectedVersion: current.version });
    await expect(store.record(scope, id, observed)).rejects.toBeInstanceOf(ExecutionLost);
  } else {
    await registerOperationsTarget(database.storage, { ...fixture.registration,
      whiskers: { ...fixture.registration.whiskers, serverId: 'changed-server' } });
    await expect(store.record(scope, id, observed)).rejects.toMatchObject({ reason: 'operations_target_changed' });
  }
  expect(await database.storage.db.select().from(operationsDiagnosisReads)).toMatchObject([{ state: 'reserved', document: null }]);
});

it('observes a bound deployment using a compatible Worker and atomically records its receipt', async () => {
  const fixture = await installedOperationsFixture();
  const request = (await fixture.taskService.admitOperations(identity, { ...fixture.scope, idempotencyKey: randomUUID() })).task;
  const enabled = installedOperations(fixture);
  const wrong = new DurableWorker(database.storage, database.runtimeUrl, { operations: { ...enabled, environmentId: randomUUID() } });
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { operations: enabled });
  const downstream = scopedWhiskers(fixture);
  try {
    await wrong.tick();
    expect(await fixture.taskService.get(identity, request.id)).toMatchObject({ state: 'queued' });
    expect(downstream.observe).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      await worker.tick();
      expect(await fixture.taskService.get(identity, request.id)).toMatchObject({ state: 'succeeded' });
    }, { timeout: 5_000, interval: 100 });
    expect(downstream.observe).toHaveBeenCalledOnce();
    const [binding] = await database.storage.db.select().from(operationsRequests).where(eq(operationsRequests.runId, request.runId));
    const [receipt] = await database.storage.db.select().from(operationsObservations).where(eq(operationsObservations.runId, request.runId));
    expect(receipt).toMatchObject({ runId: request.runId, workerId: worker.id, bindingSha256: binding?.sha256, document: {
      taskId: request.id, releaseOperationId: fixture.operationId,
      observation: { containerId: fixture.runtime.containerId, serverId: 'local', state: 'exited', observedAt: expect.any(String) },
    } });
    expect(receipt?.document.observation).not.toHaveProperty('labels');
    expect((await fixture.taskService.events(identity, request.id, 10, 'zh-CN')).at(-1)).toMatchObject({
      type: 'task.operations_observed', locale: 'zh-CN', message: '已记录绑定容器的状态。',
    });
    expect((await fixture.taskService.events(identity, request.id, 10, 'en')).at(-1)).toMatchObject({
      type: 'task.operations_observed', locale: 'en', message: 'The bound container state was recorded.',
    });
    await expect(database.storage.pool.query('DELETE FROM itervane.operations_observations WHERE run_id=$1', [request.runId]))
      .rejects.toMatchObject({ code: '23514', message: 'operations_observation_is_immutable' });
  } finally { downstream.restore(); await Promise.all([wrong.close(), worker.close()]); }
});

it.each(['cancel', 'change enrollment'] as const)('discards an in-flight Whiskers result after %s', async mode => {
  const fixture = await installedOperationsFixture();
  const request = (await fixture.taskService.admitOperations(identity, { ...fixture.scope, idempotencyKey: randomUUID() })).task;
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { operations: installedOperations(fixture) });
  const reply = Promise.withResolvers<void>();
  const downstream = scopedWhiskers(fixture, () => reply.promise);
  const pending = worker.tick();
  try {
    await vi.waitFor(() => expect(downstream.observe).toHaveBeenCalledOnce(), { timeout: 5_000 });
    if (mode === 'cancel') {
      const running = await fixture.taskService.get(identity, request.id);
      await fixture.taskService.cancel(identity, request.id, { expectedVersion: running.version });
    } else {
      await registerOperationsTarget(database.storage, { ...fixture.registration,
        whiskers: { ...fixture.registration.whiskers, serverId: 'changed-server' } });
    }
    reply.resolve();
    await pending;
    expect(await database.storage.db.select().from(operationsObservations)).toEqual([]);
    expect(await fixture.taskService.get(identity, request.id)).toMatchObject({ state: mode === 'cancel' ? 'cancelled' : 'needs_human' });
    expect((await fixture.taskService.events(identity, request.id, 10)).at(-1)).toMatchObject({
      reason: mode === 'cancel' ? 'cancelled' : 'operations_target_changed',
    });
  } finally { reply.resolve(); try { await pending; } finally { downstream.restore(); await worker.close(); } }
});

it('lets a successor re-observe within the persisted budget and rejects the old fence', async () => {
  const fixture = await installedOperationsFixture();
  const request = (await fixture.taskService.admitOperations(identity, { ...fixture.scope, idempotencyKey: randomUUID() })).task;
  const installed = installedOperations(fixture);
  const [job] = await database.storage.boss.fetch(queueName);
  const initial = await coordinator.claim(job!, randomUUID(), installed);
  if (!initial) throw new Error('Expected operations lease');
  const abandoned = Promise.withResolvers<void>();
  let callCount = 0;
  const downstream = scopedWhiskers(fixture, async () => { if (++callCount === 1) await abandoned.promise; });
  const first = runOperationsObservation(coordinator, initial, installed, new AbortController().signal)
    .then(() => undefined, (error: unknown) => error);
  const nextWorker = new DurableWorker(database.storage, database.runtimeUrl, { operations: installed });
  try {
    await vi.waitFor(() => expect(downstream.observe).toHaveBeenCalledOnce(), { timeout: 5_000 });
    await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp() - interval '1 second' WHERE worker_id=$1", [initial.workerId]);
    await nextWorker.tick();
    expect(await fixture.taskService.get(identity, request.id)).toMatchObject({ state: 'succeeded' });
    abandoned.resolve();
    expect(await first).toBeInstanceOf(ExecutionLost);
    expect(downstream.observe).toHaveBeenCalledTimes(2);
    const [budget] = await database.storage.db.select().from(runRuntime).where(eq(runRuntime.runId, request.runId));
    expect(budget).toMatchObject({ toolsUsed: 2, maxTools: 2 });
    const rows = await database.storage.db.select().from(operationsObservations);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workerId: nextWorker.id, fence: initial.fence + 1 });
  } finally { abandoned.resolve(); await first; downstream.restore(); await nextWorker.close(); }
});

it('stops an operations run before contacting Whiskers when the persisted read budget is spent', async () => {
  const fixture = await installedOperationsFixture();
  const request = (await fixture.taskService.admitOperations(identity, { ...fixture.scope, idempotencyKey: randomUUID() })).task;
  await database.storage.db.update(runRuntime).set({ toolsUsed: 2 }).where(eq(runRuntime.runId, request.runId));
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { operations: installedOperations(fixture) });
  const downstream = scopedWhiskers(fixture);
  try {
    await worker.tick();
    expect(downstream.observe).not.toHaveBeenCalled();
    expect(await database.storage.db.select().from(operationsObservations)).toEqual([]);
    expect((await fixture.taskService.events(identity, request.id, 10)).at(-1)).toMatchObject({ reason: 'budget_exhausted', state: 'needs_human' });
    await expect(new OperationsObservationViewService(database.storage).get(identity, request.id, 'zh-CN')).resolves.toMatchObject({
      state: 'needs_human', observation: null, reason: 'budget_exhausted', reasonMessage: '持久化工具预算已耗尽。', locale: 'zh-CN',
    });
  } finally { downstream.restore(); await worker.close(); }
});

it('projects a historical operations receipt in both languages under current project read access', async () => {
  const fixture = await installedOperationsFixture();
  const diagnostic = (await fixture.taskService.admitOperations(identity, { ...fixture.scope, idempotencyKey: randomUUID() })).task;
  const view = new OperationsObservationViewService(database.storage);
  await expect(view.get(identity, task.id, 'en')).rejects.toMatchObject({ code: 'not_found' });
  await expect(view.get(identity, diagnostic.id, 'en')).resolves.toMatchObject({ state: 'queued', observation: null, message: 'Queued' });

  const principalId = randomUUID();
  const subject = 'operations-viewer';
  await database.storage.db.insert(principals).values({ id: principalId, issuer: issuer.config.issuer, subject });
  const viewer = await createIdentityVerifier(issuer.config)(await issuer.token(subject));
  await expect(view.get(viewer, diagnostic.id, 'en')).rejects.toMatchObject({ code: 'not_found' });
  await database.storage.db.insert(projectMembers).values({ projectId: fixture.scope.projectId, principalId, role: 'viewer' });

  const worker = new DurableWorker(database.storage, database.runtimeUrl, { operations: installedOperations(fixture) });
  const downstream = scopedWhiskers(fixture);
  try { await worker.tick(); } finally { downstream.restore(); await worker.close(); }
  const [zh, en] = await Promise.all([view.get(viewer, diagnostic.id, 'zh-CN'), view.get(viewer, diagnostic.id, 'en')]);
  expect(zh).toMatchObject({ state: 'succeeded', releaseOperationId: fixture.operationId, environmentId: fixture.scope.environmentId,
    observation: { state: 'exited', stateLabel: '已退出', observedAt: expect.any(String), receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  expect(en.observation).toEqual({ ...zh.observation, stateLabel: 'Exited' });
  expect(zh.message).not.toBe(en.message);
  expect(Object.keys(en.observation!).sort()).toEqual(['observedAt', 'receiptSha256', 'state', 'stateLabel']);
  expect(JSON.stringify(en)).not.toContain(fixture.registration.whiskers.origin);

  await registerOperationsTarget(database.storage, { ...fixture.registration, whiskers: { ...fixture.registration.whiskers, serverId: 'new-origin-scope' } });
  await expect(view.get(viewer, diagnostic.id, 'en')).resolves.toEqual(en);
  await database.storage.db.delete(projectMembers).where(eq(projectMembers.principalId, principalId));
  await expect(view.get(viewer, diagnostic.id, 'en')).rejects.toMatchObject({ code: 'not_found' });
});

it('shares one authorized diagnosis across opt-in HTTP and MCP and fences a replaced enrollment', async () => {
  const fixture = await installedOperationsFixture();
  const { environmentId } = fixture.scope;
  const publicUrl = 'http://127.0.0.1:4329';
  const config = { ...issuer.config, publicUrl };
  const app = createApi(database.storage, { ...config,
    operationsApi: { environmentId, enrollmentSha256: fixture.enrollment.fingerprint } }, { logger: false });
  const disabled = createApi(database.storage, config, { logger: false });
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { operations: installedOperations(fixture) });
  const clients: Client[] = [];
  try {
    const url = '/v1/operations/diagnoses';
    const payload = { ...fixture.scope, idempotencyKey: randomUUID(), locale: 'zh-CN', expectedReleaseOperationId: fixture.operationId };
    const headers = { authorization: `Bearer ${await issuer.token('owner')}`, 'accept-language': 'zh-CN' };
    const launchPath = `/v1/tasks/${task.id}/operations-option`;
    const readLaunch = async (path = launchPath) => {
      const response = await app.inject({ url: path, headers });
      expect(response.statusCode).toBe(200);
      return operationsLaunchViewSchema.parse(response.json());
    };
    expect((await disabled.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(404);
    expect((await disabled.inject({ url: launchPath, headers })).statusCode).toBe(404);
    expect((await disabled.inject({ url: '/v1/capabilities', headers })).json()).toMatchObject({ stage: 'p1-e', operations: false });
    expect((await app.inject({ url: '/v1/capabilities', headers })).json()).toMatchObject({ stage: 'p3-a', operations: true });
    const post = (input: Record<string, unknown> = payload, requestHeaders = headers) => app.inject({ method: 'POST', url, headers: requestHeaders, payload: input });
    expect((await post({ ...payload, environmentId: randomUUID() })).statusCode).toBe(404);
    expect((await post({ ...payload, containerId: fixture.runtime.containerId })).statusCode).toBe(400);
    expect(await readLaunch()).toEqual({ option: { ...fixture.scope, releaseOperationId: fixture.operationId } });
    const changed = await post({ ...payload, expectedReleaseOperationId: randomUUID() });
    expect(changed.statusCode).toBe(409);
    expect(apiErrorSchema.parse(changed.json()).error.code).toBe('version_conflict');
    expect(await database.storage.db.select().from(operationsRequests)).toHaveLength(0);

    const subject = 'diagnosis-api-viewer';
    const principalId = randomUUID();
    await database.storage.db.insert(principals).values({ id: principalId, issuer: issuer.config.issuer, subject });
    await database.storage.db.insert(projectMembers).values({ projectId: fixture.scope.projectId, principalId, role: 'viewer' });
    const viewerHeaders = { authorization: `Bearer ${await issuer.token(subject)}`, 'accept-language': 'en' };
    expect((await post(payload, viewerHeaders)).statusCode).toBe(403);
    expect((await app.inject({ url: launchPath, headers: viewerHeaders })).statusCode).toBe(403);
    const accepted = await post();
    expect(accepted.statusCode).toBe(202);
    const admission = admissionDtoSchema.parse(accepted.json());
    expect(admission).toMatchObject({ replayed: false, task: { state: 'queued', purpose: '诊断已发布应用', workflow: 'operations' } });
    expect(await readLaunch(`/v1/tasks/${admission.task.id}/operations-option`)).toEqual({ option: null });
    const listed = (await app.inject({ url: `/v1/projects/${fixture.scope.projectId}/tasks`, headers })).json().items;
    const records = taskDtoSchema.array().parse(listed);
    expect(records.find(record => record.id === admission.task.id)?.workflow).toBe('operations');
    expect(records.find(record => record.id === task.id)).not.toHaveProperty('workflow');
    const resultPath = `/v1/tasks/${admission.task.id}/operations`;
    expect((await disabled.inject({ url: resultPath, headers })).statusCode).toBe(404);

    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    async function connect(caller: string, scope: string, locale: string) {
      const token = await issuer.token(caller, { aud: `${publicUrl}/mcp`, scope });
      const client = new Client({ name: 'operations-test', version: '0.0.0' });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        requestInit: { headers: { Authorization: `Bearer ${token}`, 'Accept-Language': locale } },
      }));
      return client;
    }
    const owner = await connect('owner', 'itervane:read itervane:write', 'zh-CN');
    const viewer = await connect(subject, 'itervane:read', 'en');
    const start = { name: 'start_operations_diagnosis', arguments: payload };
    expect((await owner.listTools()).tools.find(tool => tool.name === start.name)).toMatchObject({
      description: translate('zh-CN', 'mcp.operations_start'), annotations: { readOnlyHint: false } });
    const query = { name: 'get_operations_result', arguments: { taskId: admission.task.id } };
    const readerTools = (await viewer.listTools()).tools;
    expect(readerTools.some(tool => tool.name === start.name)).toBe(false);
    expect(readerTools.find(tool => tool.name === query.name)).toMatchObject({
      description: translate('en', 'mcp.operations_result'), annotations: { readOnlyHint: true } });
    const viewerStart = await fetch(new URL('/mcp', address), {
      method: 'POST', headers: { authorization: `Bearer ${await issuer.token(subject, { aud: `${publicUrl}/mcp`, scope: 'itervane:read' })}`,
        'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: start }),
    });
    expect(viewerStart.status).toBe(403);
    expect(viewerStart.headers.get('www-authenticate')).toContain('scope="itervane:write"');
    expect(apiErrorSchema.parse(await viewerStart.json()).error.code).toBe('forbidden');
    expect(admissionDtoSchema.parse((await owner.callTool(start)).structuredContent))
      .toEqual({ ...admission, replayed: true });
    const downstream = scopedWhiskers(fixture);
    try { await worker.tick(); } finally { downstream.restore(); }
    expect(downstream.observe).toHaveBeenCalledOnce();

    const response = await app.inject({ url: resultPath, headers: viewerHeaders });
    expect(response.statusCode).toBe(200);
    const observed = operationsObservationViewSchema.parse(response.json());
    expect(observed).toMatchObject({ state: 'succeeded', releaseOperationId: fixture.operationId,
      observation: { state: 'exited', stateLabel: 'Exited' } });
    expect(operationsObservationViewSchema.parse((await viewer.callTool(query)).structuredContent)).toEqual(observed);
    expect(operationsObservationViewSchema.parse((await owner.callTool(query)).structuredContent).observation?.stateLabel).toBe('已退出');
    expect(response.body).not.toContain(fixture.registration.whiskers.origin);
    expect(response.body).not.toContain(operationsFixtureKey);

    await registerOperationsTarget(database.storage, { ...fixture.registration, whiskers: { ...fixture.registration.whiskers, serverId: 'next-server' } });
    expect(await readLaunch()).toEqual({ option: null });
    expect((await post(payload)).statusCode).toBe(200);
    const stale = await post({ ...payload, idempotencyKey: randomUUID() });
    expect(stale.statusCode).toBe(503);
    expect(apiErrorSchema.parse(stale.json()).error).toMatchObject({ code: 'unavailable', locale: 'zh-CN' });
    expect(await database.storage.db.select().from(operationsRequests)).toHaveLength(1);

    await database.storage.db.delete(projectMembers).where(eq(projectMembers.principalId, principalId));
    expect((await app.inject({ url: launchPath, headers: viewerHeaders })).statusCode).toBe(404);
    expect((await app.inject({ url: resultPath, headers: viewerHeaders })).statusCode).toBe(404);
    expect(apiErrorSchema.parse((await viewer.callTool(query)).structuredContent).error.code).toBe('not_found');
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await Promise.all([app.close(), disabled.close(), worker.close()]);
  }
});

it('serves the same authorized bilingual diagnosis and facts over HTTP and MCP', async () => {
  const fixture = await installedOperationsFixture();
  const publishedTaskId = task.id;
  const provider = await auditProtocolFixture();
  const model = workerConfig({ DATABASE_URL: database.runtimeUrl, ITERVANE_AUDIT_MODEL_PROVIDER: 'anthropic',
    ANTHROPIC_BASE_URL: provider.baseURL, ANTHROPIC_API_KEY: auditFixtureKey, ANTHROPIC_MODEL: auditFixtureModel }).auditModel;
  if (!model) throw new Error('Expected the protocol fixture model');
  const auditModel = configuredAuditModel(model);
  const operations = { ...installedOperations(fixture), diagnosisProviderSha256: auditModel.providerSha256 };
  const { environmentId, enrollmentSha256, diagnosisProviderSha256 } = operations;
  const publicUrl = 'http://127.0.0.1:4329';
  const app = createApi(database.storage, runtimeConfig({
    DATABASE_URL: database.runtimeUrl, ITERVANE_OIDC_ISSUER: issuer.config.issuer, ITERVANE_OIDC_AUDIENCE: issuer.config.audience,
    ITERVANE_PUBLIC_URL: publicUrl, ITERVANE_OPERATIONS_API_ENABLED: '1', ITERVANE_OPERATIONS_ENVIRONMENT_ID: environmentId,
    ITERVANE_OPERATIONS_ENROLLMENT_SHA256: enrollmentSha256, ITERVANE_OPERATIONS_DIAGNOSIS_PROVIDER_SHA256: diagnosisProviderSha256,
  }), { logger: false });
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { operations, auditModel, leaseSeconds: 30 });
  const viewer = new Client({ name: 'diagnosis-view-test', version: '0.0.0' });
  try {
    const headers = { authorization: `Bearer ${await issuer.token('owner')}` };
    expect((await app.inject({ url: '/v1/capabilities', headers })).json()).toMatchObject({ stage: 'p3-b', operations: true });
    expect((await app.inject({ url: `/v1/tasks/${publishedTaskId}/operations-option`, headers })).json()).toEqual({
      option: { ...fixture.scope, releaseOperationId: fixture.operationId, diagnosis: true },
    });
    const start = await app.inject({ method: 'POST', url: '/v1/operations/diagnoses',
      headers,
      payload: { ...fixture.scope, locale: 'zh-CN', idempotencyKey: randomUUID(), expectedReleaseOperationId: fixture.operationId } });
    expect(start.statusCode).toBe(202);
    const { task } = admissionDtoSchema.parse(start.json());
    const payload = { name: 'get_operations_result', arguments: { taskId: task.id } };
    const path = `/v1/tasks/${task.id}/operations`;
    const subject = 'formal-diagnosis-viewer';
    const principalId = randomUUID();
    await database.storage.db.insert(principals).values({ id: principalId, issuer: issuer.config.issuer, subject });
    await database.storage.db.insert(projectMembers).values({ projectId: fixture.scope.projectId, principalId, role: 'viewer' });
    const actor = `Bearer ${await issuer.token(subject)}`;
    const http = (language: string) => app.inject({ url: path, headers: { authorization: actor, 'accept-language': language } });
    expect((await http('en')).json()).not.toHaveProperty('diagnosis');

    const downstream = scopedWhiskers(fixture, undefined, 'running');
    try { expect(await worker.tick()).toBe(true); } finally { downstream.restore(); }
    expect(downstream.tools).toEqual(['get_container_details', 'get_container_logs', 'get_container_metrics']);
    expect(provider.calls).toEqual(['read_operations', 'read_operations', 'read_operations', 'read_operations', 'finish_role']);

    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const token = await issuer.token(subject, { aud: `${publicUrl}/mcp`, scope: 'itervane:read' });
    await viewer.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, 'Accept-Language': 'zh-CN' } },
    }));
    const [english, chinese] = await Promise.all([http('en'), http('zh-CN')]);
    expect([english.statusCode, chinese.statusCode]).toEqual([200, 200]);
    const en = operationsObservationViewSchema.parse(english.json());
    const zh = operationsObservationViewSchema.parse(chinese.json());
    expect(operationsObservationViewSchema.parse((await viewer.callTool(payload)).structuredContent)).toEqual(zh);
    expect(en.diagnosis).toMatchObject({
      hypotheses: [],
      recommendation: { code: 'continue_observation', evidenceIds: [expect.any(String), expect.any(String)] },
    });
    expect(zh.diagnosis?.receiptSha256).toBe(en.diagnosis?.receiptSha256);
    expect(zh.diagnosis?.recommendation.message).toMatch(/[\u3400-\u9fff]/u);
    expect(en.diagnosis?.recommendation.message).not.toBe(zh.diagnosis?.recommendation.message);
    expect(zh.diagnosis?.facts).toEqual(en.diagnosis?.facts);
    expect(en.diagnosis?.facts).toMatchObject([
      { section: 'container', result: { state: 'running' } },
      { section: 'release', result: { current: { operationId: fixture.operationId }, previous: null } },
      { section: 'logs', result: { lines: 2, errorLines: 1 } },
      { section: 'metrics', result: { status: 'observed', dataPoints: 3, memory: { average: 92 } } },
    ]);
    for (const value of [operationsFixtureKey, fixture.runtime.containerId, fixture.registration.whiskers.origin, 'local-log-canary-value']) {
      expect(english.body).not.toContain(value);
      expect(chinese.body).not.toContain(value);
    }
    expect(en.diagnosis?.facts.every(fact => !('serverId' in fact.result))).toBe(true);
    await registerOperationsTarget(database.storage, { ...fixture.registration,
      whiskers: { ...fixture.registration.whiskers, serverId: 'next-diagnosis-target' } });
    expect(operationsObservationViewSchema.parse((await http('en')).json())).toEqual(en);

    await database.admin.query(`UPDATE itervane.task_events SET detail = detail || jsonb_build_object('diagnosisSha256', $2::text)
      WHERE task_id=$1 AND type='task.operations_observed'`, [task.id, sha256('unbound diagnostic event')]);
    expect((await http('en')).statusCode).toBe(500);
    expect((await viewer.callTool(payload)).isError).toBe(true);
    await database.storage.db.delete(projectMembers).where(eq(projectMembers.principalId, principalId));
    expect((await http('en')).statusCode).toBe(404);
    expect(apiErrorSchema.parse((await viewer.callTool(payload)).structuredContent).error.code).toBe('not_found');
  } finally {
    await viewer.close();
    await Promise.all([app.close(), worker.close(), provider.close()]);
  }
});

it('settles one formal rollout and releases the environment only with a complete current proof', async () => {
  const submitted = await queuedFormalRelease({ komodo: true, rolloutCheck: true });
  const { operationId, target, taskService, approval } = submitted;
  const { image, update } = await parkForRollout(submitted);
  const observe = new FormalRolloutCoordinator(database.storage, releaseOrigin);
  const observeUpdate = vi.fn<ConstructorParameters<typeof FormalRolloutWorker>[1]['observeUpdate']>(
    async (_target, updateId, authorize) => {
      expect(updateId).toBe(update.updateId);
      await authorize();
      return update;
    });
  const verify = vi.fn<ConstructorParameters<typeof FormalRolloutWorker>[2]['observe']>(async (binding, authorize) => {
    await authorize();
    expect(binding.image.configDigest).toBe(image.configDigest);
    return { rolloutCheckSha256: binding.rolloutCheckSha256, containerId: sha256('running container'),
      configDigest: binding.image.configDigest, imageReference: image.reference, runtimeConfigSha256: target.runtimeConfigSha256,
      network: rolloutCheckFixture.network, anonymousStatus: 401, healthStatus: 200, version: 'standard-v2' };
  });
  const worker = new FormalRolloutWorker(observe, { observeUpdate }, { observe: verify });

  expect(await Promise.all([worker.tick(randomUUID()), worker.tick(randomUUID())])).toEqual(expect.arrayContaining(['idle', 'verified_formal']));
  expect(observeUpdate).toHaveBeenCalledTimes(2);
  expect(verify).toHaveBeenCalledOnce();
  expect(await worker.tick(randomUUID())).toBe('idle');
  expect(await readOperation(operationId)).toMatchObject({ state: 'verified_formal', observation: null, wakeupJobId: null });
  expect(await taskService.get(identity, task.id)).toMatchObject({ state: 'succeeded' });
  const [result] = await database.storage.db.select().from(formalReleaseRolloutAttempts);
  expect(result).toMatchObject({ state: 'verified', fence: 1, failure: null, proof: { operationId, rolloutFence: 1,
    generation: approval.manifest.generation, targetRevision: approval.manifest.target.revision, manifestDigest: image.manifestDigest, update,
    runtime: { containerId: sha256('running container'), configDigest: image.configDigest, anonymousStatus: 401, healthStatus: 200 } } });
  expect(result!.completedAt!.getTime()).toBeLessThan(result!.leaseUntil.getTime());
  for (const locale of ['zh-CN', 'en'] as const) {
    const events = (await taskService.events(identity, task.id, 50, locale)).filter(event => event.type === 'task.release_rollout_verified');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ state: 'succeeded', locale, message: locale === 'zh-CN' ? /已核验/ : /were verified/ });
  }
  await expect(registerReleaseTarget(database.storage, { ...target, runtimeConfigSha256: sha256('next revision') }))
    .resolves.toMatchObject({ revision: approval.manifest.target.revision + 1 });
});

it('keeps formal rollout completion ordered when the database clock is behind the claim timestamp', async () => {
  const submitted = await queuedFormalRelease({ komodo: true, rolloutCheck: true });
  const parked = await parkForRollout(submitted);
  await database.admin.query(`CREATE FUNCTION itervane.test_future_rollout_claim() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.created_at := NEW.lease_until - interval '15 seconds'; RETURN NEW; END;
    $$`);
  try {
    await database.admin.query(`CREATE TRIGGER test_future_rollout_claim BEFORE INSERT ON itervane.formal_release_rollout_attempts
      FOR EACH ROW EXECUTE FUNCTION itervane.test_future_rollout_claim()`);
    try { await finishTestRollout(parked); }
    finally {
      await database.admin.query('DROP TRIGGER test_future_rollout_claim ON itervane.formal_release_rollout_attempts');
    }
  } finally { await database.admin.query('DROP FUNCTION itervane.test_future_rollout_claim()'); }
  const [attempt] = await database.storage.db.select().from(formalReleaseRolloutAttempts)
    .where(eq(formalReleaseRolloutAttempts.operationId, submitted.operationId));
  expect(attempt?.state).toBe('verified');
  expect(attempt?.completedAt).toEqual(attempt?.createdAt);
  expect(await readOperation(submitted.operationId)).toMatchObject({ state: 'verified_formal' });
});

it('rejects wrong, stale and partial formal rollout evidence while preserving a later cancellation', async () => {
  const submitted = await queuedFormalRelease({ komodo: true, rolloutCheck: true });
  const { operationId, taskService, target } = submitted;
  const short = new FormalRolloutCoordinator(database.storage, releaseOrigin, 1);
  await parkForRollout(submitted);
  const stale = await short.claimNext(randomUUID());
  if (!stale) throw new Error('Expected a first observation attempt');
  await database.admin.query(`SELECT pg_sleep_until(lease_until + interval '20 milliseconds')
    FROM itervane.formal_release_rollout_attempts WHERE operation_id=$1 AND fence=1`, [operationId]);
  const observe = new FormalRolloutCoordinator(database.storage, releaseOrigin);
  const scope = await observe.claimNext(randomUUID());
  if (!scope) throw new Error('Expected an observation after expiry');
  expect(scope.fence).toBe(2);
  const binding = await observe.authorize(scope);
  const proof = { version: 1, ...binding.decision, rolloutFence: scope.fence, generation: binding.manifest.generation,
    targetRevision: binding.manifest.target.revision, mappingSha256: binding.manifest.target.mappingSha256,
    manifestDigest: binding.image.manifestDigest, update: binding.update, runtime: observedRuntime(binding) };
  await expect(observe.settle(stale, { ...proof, rolloutFence: stale.fence })).rejects.toBeInstanceOf(ExecutionLost);
  await expect(observe.settle(scope, {})).rejects.toThrow();
  for (const result of [
    { ...proof, operationId: randomUUID() },
    { ...proof, fingerprint: sha256('other candidate') },
    { ...proof, update: { ...proof.update, updateId: 'c'.repeat(24) } },
    { ...proof, runtime: { ...proof.runtime, configDigest: 'sha256:' + sha256('wrong image') } },
    { ...proof, runtime: { ...proof.runtime, rolloutCheckSha256: sha256('other profile') } },
  ]) {
    await expect(observe.settle(scope, result)).rejects.toMatchObject({
      cause: { code: '23514', message: 'formal_rollout_proof_mismatch' },
    });
  }

  await expect(database.storage.pool.query("UPDATE itervane.release_operations SET state='verified_formal' WHERE id=$1", [operationId]))
    .rejects.toMatchObject({ code: '23514', message: 'formal_rollout_evidence_required' });
  await expect(database.storage.pool.query(`UPDATE itervane.formal_release_rollout_attempts SET state='verified', proof=$2::jsonb
    WHERE operation_id=$1 AND fence=2`, [operationId, JSON.stringify(proof)]))
    .rejects.toMatchObject({ code: '23514', message: 'formal_rollout_settlement_incomplete' });
  expect(await readOperation(operationId)).toMatchObject({ state: 'reconciling' });
  await expect(registerReleaseTarget(database.storage, { ...target, runtimeConfigSha256: sha256('still reserved') }))
    .rejects.toMatchObject({ code: 'conflict' });

  const current = await taskService.get(identity, task.id);
  expect(await taskService.cancel(identity, task.id, { expectedVersion: current.version })).toMatchObject({ state: 'cancel_requested' });
  expect(await observe.settle(scope, proof)).toBe('verified_formal');
  await expect(observe.settle(scope, proof)).rejects.toBeInstanceOf(ExecutionLost);
  expect(await readOperation(operationId)).toMatchObject({ state: 'verified_formal' });
  expect(await taskService.get(identity, task.id)).toMatchObject({ state: 'cancelled' });
  const attempts = await database.storage.db.select().from(formalReleaseRolloutAttempts).orderBy(formalReleaseRolloutAttempts.fence);
  expect(attempts).toMatchObject([{ state: 'expired', fence: 1, proof: null }, { state: 'verified', fence: 2, proof }]);
});

it.each([
  { scenario: 'recorded update failed', reason: 'release_rollout_update_failed', reads: 1, health: 0 },
  { scenario: 'update changed after health', reason: 'release_rollout_update_changed', reads: 2, health: 1 },
  { scenario: 'protected health failed', reason: 'release_rollout_health_failed', reads: 1, health: 1 },
] as const)('holds the environment when formal rollout needs manual review ($scenario)', async ({ scenario, reason, reads, health }) => {
  const submitted = await queuedFormalRelease({ komodo: true, rolloutCheck: true });
  const { operationId, taskService, target } = submitted;
  const { image, update } = await parkForRollout(submitted, scenario !== 'recorded update failed');
  const coordinator = new FormalRolloutCoordinator(database.storage, releaseOrigin);
  const observeUpdate = vi.fn().mockResolvedValueOnce(update).mockResolvedValueOnce({ ...update, success: false });
  const verify = vi.fn<ConstructorParameters<typeof FormalRolloutWorker>[2]['observe']>(async (binding, authorize) => {
    await authorize();
    if (scenario === 'protected health failed') throw new ReleaseIngressError('health_failed');
    return { rolloutCheckSha256: binding.rolloutCheckSha256, containerId: sha256('running container'),
      configDigest: image.configDigest, imageReference: image.reference, runtimeConfigSha256: target.runtimeConfigSha256,
      network: rolloutCheckFixture.network, anonymousStatus: 401, healthStatus: 200, version: 'standard-v2' };
  });
  const worker = new FormalRolloutWorker(coordinator, { observeUpdate }, { observe: verify });

  expect(await worker.tick(randomUUID())).toBe('manual_review');
  expect(observeUpdate).toHaveBeenCalledTimes(reads);
  expect(verify).toHaveBeenCalledTimes(health);
  expect(await worker.tick(randomUUID())).toBe('idle');
  expect(await readOperation(operationId)).toMatchObject({ state: 'reconciling', observation: null, wakeupJobId: null });
  expect(await taskService.get(identity, task.id)).toMatchObject({ state: 'needs_human' });
  expect(await database.storage.db.select().from(formalReleaseRolloutAttempts)).toMatchObject([{ state: 'rejected', proof: null, failure: reason }]);
  await expect(registerReleaseTarget(database.storage, { ...target, runtimeConfigSha256: sha256('different revision') }))
    .rejects.toMatchObject({ code: 'conflict' });
  const events = await taskService.events(identity, task.id, 50, 'zh-CN');
  expect(events.filter(event => event.type === 'task.release_rollout_manual_review')).toMatchObject([{ reason, reasonMessage: expect.any(String) }]);
});

it.each(['normal', 'config response lost', 'config unconfirmed', 'dispatch ID lost',
  'dispatch observation expired', 'registry response lost', 'approval revoked before Komodo'] as const)(
  'runs formal Komodo through the durable Worker (%s)', async scenario => {
    const { approval, operationId, target, taskService, owner, service } = await queuedFormalRelease({ komodo: true, separateRequester: true });
    const image = standardRegistryProof(approval.manifest.image);
    const previous = { deploymentId: target.deploymentId, serverId: target.serverId,
      runtimeConfigSha256: target.runtimeConfigSha256, imageReference: 'registry.example.invalid/testing/standard:old' };
    const approved = { ...previous, imageReference: image.reference };
    const update = { updateId: '6'.repeat(24), deploymentId: target.deploymentId,
      actorId: komodoBinding.actorId, status: 'Queued', success: false } as const;
    let configuration = previous;
    let expireObservation = scenario === 'dispatch observation expired';
    type Backend = ConstructorParameters<typeof FormalReleaseWorker>[1];
    type Komodo = NonNullable<Backend['komodo']>;
    const publish = vi.fn<Backend['registry']['publish']>(async (_target, _image, _path, authorize) => {
      await authorize();
      if (scenario === 'registry response lost') throw new Error('test_registry_response_lost');
      return image;
    });
    const observe = vi.fn<Backend['registry']['observe']>(async (_target, _image, authorize) => {
      await authorize();
      return image;
    });
    const inspectTarget = vi.fn<Komodo['inspectTarget']>(async (bound, authorize) => {
      expect(bound).toMatchObject({ komodo: komodoBinding, deploymentId: target.deploymentId, serverId: target.serverId });
      await authorize();
      return configuration;
    });
    const configureImage = vi.fn<Komodo['configureImage']>(async (_target, requested, authorizeWrite, _signal, authorizeRead) => {
      expect(requested).toMatchObject({ manifestDigest: image.manifestDigest, previousImage: previous.imageReference });
      await authorizeWrite();
      if (scenario !== 'config unconfirmed') configuration = approved;
      if (scenario === 'config response lost' || scenario === 'config unconfirmed') throw new Error('test_config_response_lost');
      await authorizeRead?.();
      return configuration;
    });
    const dispatch = vi.fn<Komodo['dispatch']>(async (_target, digest, authorizeWrite, _signal, authorizeRead) => {
      expect(digest).toBe(image.manifestDigest);
      expect(configuration).toEqual(approved);
      await authorizeWrite();
      if (scenario === 'dispatch ID lost') throw new Error('test_dispatch_id_lost');
      await authorizeRead?.();
      return update;
    });
    const observeUpdate = vi.fn<Komodo['observeUpdate']>(async (_target, id, authorize) => {
      expect(id).toBe(update.updateId);
      await authorize();
      if (expireObservation) {
        expireObservation = false;
        await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
        throw new Error('test_process_interrupted_after_receipt');
      }
      return { ...update, status: 'Complete', success: true };
    });
    const backend: Backend = { origin: releaseOrigin, registry: { publish, observe }, komodo: { inspectTarget, configureImage, dispatch, observeUpdate } };
    const importWorker = new FormalReleaseWorker(database.storage, { ...backend, runner: {
      async withRetainedArchive(_archive, authorize, use) {
        await authorize();
        return use('/trusted-fixture/approved.oci.tar');
      },
    } });
    const run = async (worker: FormalReleaseWorker, phase: string) => {
      // Delayed wakeups use PostgreSQL time. The local test process and database can disagree on elapsed time.
      await database.admin.query(`SELECT pg_sleep_until(LEAST(
          job.start_after + interval '10 milliseconds', clock_timestamp() + interval '3 seconds'))
        FROM itervane.release_operations operation
        JOIN itervane_queue.job job ON job.id=operation.wakeup_job_id
        WHERE operation.id=$1 AND job.name=$2 AND job.state='created'`, [operationId, formalReleaseQueue]);
      const deadline = performance.now() + 5_000;
      do {
        const result = await worker.tick();
        if (result.status !== 'idle') return result;
        await delay(45);
      } while (performance.now() < deadline);
      const operation = await readOperation(operationId);
      const job = operation.wakeupJobId && (await database.storage.boss.findJobs(formalReleaseQueue, { id: operation.wakeupJobId }))[0];
      const { rows: [runtime] } = await database.admin.query<{ reason: string }>('SELECT reason FROM itervane.run_runtime WHERE run_id=$1', [task.runId]);
      const { rows: [clock] } = await database.admin.query<{ now: Date }>('SELECT itervane_queue.job_now() AS now');
      throw new Error(`No Komodo wakeup for ${phase} (${operation.state}, ${runtime?.reason}, ${job ? job.state : 'missing'}, `
        + `starts ${job ? job.startAfter.toISOString() : '-'}, DB clock ${clock?.now.toISOString()})`);
    };
    const newWorker = () => new FormalReleaseWorker(database.storage, backend);
    const imported = await run(importWorker, 'registry import');
    expect(imported).toMatchObject({ status: scenario === 'registry response lost' ? 'requeued' : 'komodo_ready', scope: { operationId, mode: 'import' } });
    if (scenario === 'registry response lost') {
      expect(await run(newWorker(), 'registry observation')).toMatchObject({
        status: 'komodo_ready', scope: { operationId, mode: 'registry_recovery' },
      });
    }
    expect(configureImage).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await readOperation(operationId)).toMatchObject({ state: 'reconciling', wakeupJobId: expect.any(String) });
    expect((await service.getView(owner, task.id, 'zh-CN')).candidate?.message).toMatch(/新的 Komodo 写入租约/);
    if (scenario === 'approval revoked before Komodo') {
      const [ownerGrant] = await database.storage.db.delete(workspaceMembers).returning();
      const observer = newWorker();
      await vi.waitFor(async () => {
        expect(await observer.tick()).toEqual({ status: 'idle' });
        expect(await readOperation(operationId)).toMatchObject({ state: 'blocked', wakeupJobId: null });
      }, { timeout: 5_000, interval: 45 });
      expect(inspectTarget).not.toHaveBeenCalled();
      expect(configureImage).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      await database.storage.db.insert(workspaceMembers).values({ principalId: ownerGrant!.principalId, workspaceId: ownerGrant!.workspaceId });
      expect((await taskService.events(identity, task.id, 50, 'en')).at(-1))
        .toMatchObject({ type: 'task.release_blocked', state: 'needs_human', reason: 'release_approval_invalid' });
      return;
    }

    const competing = await Promise.all([newWorker().tick(), newWorker().tick()]);
    expect(competing.filter(item => item.status === 'idle')).toHaveLength(1);
    const first = competing.find(item => item.status !== 'idle');
    if (!first) throw new Error('Missing Komodo writer');
    expect(first.scope).toMatchObject({ operationId, mode: 'komodo_write' });
    expect(first.scope.fence).toBeGreaterThan(imported.scope.fence);
    let last: typeof first = first;
    if (scenario === 'config response lost' || scenario === 'config unconfirmed') {
      expect(first.status).toBe('requeued');
      expect(dispatch).not.toHaveBeenCalled();
      const recovery = await run(newWorker(), 'Komodo configuration observation');
      expect(recovery).toMatchObject({ status: scenario === 'config response lost' ? 'komodo_ready' : 'requeued',
        scope: { operationId, mode: 'komodo_recovery', komodoStep: 'komodo_config' } });
      if (scenario === 'config unconfirmed') {
        expect((await run(newWorker(), 'second configuration observation')).status).toBe('requeued');
        last = await run(newWorker(), 'last configuration observation');
      } else {
        const writer = await run(newWorker(), 'Komodo writer after confirmed configuration');
        expect(writer.scope).toMatchObject({ operationId, mode: 'komodo_write' });
        last = writer;
      }
    }
    if (scenario === 'dispatch observation expired') {
      expect(first.status).toBe('lease_lost');
      const current = await taskService.get(identity, task.id);
      await taskService.cancel(identity, task.id, { expectedVersion: current.version });
      const [ownerGrant] = await database.storage.db.delete(workspaceMembers).returning();
      const recovered = await run(newWorker(), 'recorded deployment observation');
      expect(recovered.scope).toMatchObject({ operationId, mode: 'komodo_recovery', komodoStep: 'komodo_dispatch' });
      expect(recovered.scope.fence).toBeGreaterThan(first.scope.fence);
      last = recovered;
      await database.storage.db.insert(workspaceMembers).values({ principalId: ownerGrant!.principalId, workspaceId: ownerGrant!.workspaceId });
    }
    const manual = scenario === 'config unconfirmed' || scenario === 'dispatch ID lost';
    expect(last.status).toBe(manual ? 'manual_review' : 'awaiting_rollout');
    expect(await readOperation(operationId)).toMatchObject({ state: 'reconciling', wakeupJobId: null, observation: null });
    expect(await newWorker().tick()).toEqual({ status: 'idle' });
    await expect(registerReleaseTarget(database.storage, { ...target, rolloutCheckSha256: sha256('conflicting configuration') }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect((await database.admin.query('SELECT task_id FROM itervane.execution_slot')).rows[0]).toEqual({ task_id: null });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(scenario === 'registry response lost' ? 1 : 0);
    expect(configureImage).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(scenario === 'config unconfirmed' ? 0 : 1);
    expect(observeUpdate).toHaveBeenCalledTimes(manual ? 0 : scenario === 'dispatch observation expired' ? 2 : 1);
    const steps = await database.storage.db.select().from(formalReleaseSteps).where(eq(formalReleaseSteps.operationId, operationId));
    expect(steps.find(step => step.kind === 'komodo_config')).toMatchObject({ preparedFence: first.scope.fence,
      state: scenario === 'config unconfirmed' ? 'prepared' : 'confirmed' });
    if (!manual) {
      expect(steps.find(step => step.kind === 'komodo_dispatch')).toMatchObject({ state: 'confirmed', externalUpdateId: update.updateId,
        settledFence: last.scope.fence, proof: { ...update, status: 'Complete', success: true } });
    }
    const en = await taskService.events(identity, task.id, 50, 'en');
    const zh = await taskService.events(identity, task.id, 50, 'zh-CN');
    expect(en.filter(event => event.type === 'task.release_komodo_config_recheck_started'))
      .toHaveLength(scenario === 'config unconfirmed' ? 3 : scenario === 'config response lost' ? 1 : 0);
    expect(en.filter(event => event.type === 'task.release_komodo_dispatch_recheck_started'))
      .toHaveLength(scenario === 'dispatch observation expired' ? 1 : 0);
    expect(en.at(-1)?.message).toMatch(manual ? /manual review/ : /independent runtime checks/);
    expect(zh.at(-1)?.message).toMatch(manual ? /人工核对/ : /独立核验/);
    expect(zh.at(-1)?.state).toBe(scenario === 'dispatch observation expired' ? 'cancel_requested' : 'reconciling');
  },
);

it('keeps verification unavailable while an audit finding has no published repair candidate', async () => {
  const { scope } = await repairReady();
  await expect(coordinator.withLease(scope, (tx, current) => prepareFormalVerificationInput(tx, current.task, scope, verificationProfile)))
    .rejects.toMatchObject({ code: 'unavailable' });
  expect(await database.storage.db.select().from(formalVerificationInputs)).toEqual([]);
});

it.each(['reclaimed change', 'remaining finding', 'repeat patch', 'budget exhausted', 'restored grant', 'changed policy', 'queue failure'] as const)(
  'binds failed-candidate retry behavior to the PostgreSQL ledger (%s)', async mode => {
    const prefix = 'header=fixture\nkeep=on\n';
    const removed = 'REMOVE=public\n';
    const replacement = 'REMOVE=disabled\n';
    const original = prefix + removed;
    const range = { startByte: Buffer.byteLength(prefix), endByte: Buffer.byteLength(original), sha256: sha256(removed) };
    let scan: QualifiedInspectionReceipt | undefined;
    let candidate: QualifiedRepairReceipt['snapshot']['candidate'] | undefined;
    const inspect = vi.fn<InspectionRunner['inspect']>(async (request, authorize) => {
      await authorize(); scan = testReceipt(request, false, fixtureFindingPath); return scan;
    });
    const observeRepair: RepairObservationRunner['observeRepair'] = async (request, workspace, targets, authorize) => {
      await authorize(); return repairObservationReceipt(scan!, request, workspace, targets, original, range);
    };
    const repair = vi.fn<RepairRunner['repair']>(async (request, workspace, patch, authorize) => {
      await authorize();
      const receipt = repairReceipt(scan!, request, workspace, patch, original);
      candidate = receipt.snapshot.candidate;
      return receipt;
    });
    const verify = vi.fn<RescanRunner['verify']>(async (coordinates, input, patch, authorize) => {
      await authorize();
      if (input.subject.kind !== 'repair' || !patch || !candidate) throw new Error('Missing frozen candidate');
      const request = prepareQualifiedVerificationRequest(coordinates, canonicalVerificationCommand({ input, repair: patch }));
      const healthy = candidate.changes[0]?.afterSha256 === sha256(prefix + replacement) && mode !== 'budget exhausted';
      if (mode === 'remaining finding' && input.generation === 1) {
        const receipt = standardVerificationReceipt(scan!, request, input, false, candidate);
        const target = receipt.snapshot.target!;
        const finding = receipt.snapshot.reports[0].findings[0]!;
        target.reports[0].findings = [{ ...finding,
          id: sha256(JSON.stringify(['gitleaks', target.manifestSha256, finding.ruleId, finding.path, finding.line])),
        }];
        return receipt;
      }
      return standardVerificationReceipt(scan!, request, input, !healthy, candidate);
    });
    const observedRetries: Array<ReturnType<typeof formalRepairRetryContextSchema.parse>> = [];
    const model = auditModel(async request => {
      const context = request.conversation[0];
      if (context?.kind !== 'user') throw new Error('Missing agent context');
      const { role, observations, handoff } = JSON.parse(context.text) as {
        role: string; observations: AgentEvidence[]; handoff: { findings: Array<{ id: string }>; previousVerification?: unknown };
      };
      if (role === 'audit') return concludeAudit(request);
      if (role === 'verify') return scriptedVerification('zh-CN').complete(request);
      if (handoff.previousVerification) observedRetries.push(formalRepairRetryContextSchema.parse(handoff.previousVerification));
      const chosen = observations.find(item => item.data.kind === 'repair_candidate');
      if (chosen) return auditTurn('finish_role', { evidenceId: chosen.id, summary: '候选已按当前证据修改。' });
      const target = observations.find(item => item.data.kind === 'repair_targets');
      if (!target) return auditTurn('read_repair_targets', { findingIds: handoff.findings.map(item => item.id) });
      const rejected = observations.some(item => item.data.kind === 'repair_failure' && item.data.code === 'previous_failed_patch');
      if (rejected && mode === 'repeat patch') return auditTurn('request_human', {});
      return auditTurn('apply_repair_patch', { observationId: target.id, targets: [{ targetIndex: 0, edits: [{
        startByte: range.startByte, endByte: range.endByte, replacement: rejected ? replacement : '',
      }] }] });
    });
    const tasks = new TaskService(database.storage);
    const runner = inspectionRunner(inspect);
    const common = { runner, auditModel: model, verification: { runner: { observe: async () => idleRepairRunner(), verify }, profile: standardVerificationProfile } };
    const open = (protectedPaths: string[] = []) => new DurableWorker(database.storage, database.runtimeUrl, {
      ...common, repair: { runner: { observe: async () => idleRepairRunner(), observeRepair, repair }, protectedPaths },
    });
    const failEnqueue = mode === 'queue failure' ? vi.spyOn(database.storage.boss, 'send').mockResolvedValueOnce(null) : undefined;
    const first = open();
    try { expect(await first.tick()).toBe(true); } finally { await first.close(); failEnqueue?.mockRestore(); }
    const ready = await tasks.get(identity, task.id);
    const [retry, ...duplicates] = await database.storage.db.select().from(formalRepairRetries);
    const [previousResult] = await database.storage.db.select().from(formalVerificationResults);
    if (mode === 'queue failure') {
      expect(ready).toMatchObject({ runId: task.runId, state: 'needs_human' });
      expect(retry).toBeUndefined();
      expect(previousResult).toBeUndefined();
      expect(await database.storage.db.select().from(taskRuns)).toHaveLength(1);
      expect((await tasks.events(identity, task.id, 50)).at(-1)).toMatchObject({ reason: 'verification_unavailable' });
      return;
    }
    expect(duplicates).toHaveLength(0);
    const failure = mode === 'remaining finding' ? { outcome: 'source_findings', introduced: 0, remaining: 1 }
      : { outcome: 'checks_failed', checks: [{ id: 'health', code: 'unexpected_status', statusCode: 503 }] };
    expect(previousResult?.document.review?.outcome).toBe(failure.outcome);
    expect(retry).toMatchObject({ taskId: task.id, previousRunId: task.runId, runId: ready.runId, document: {
      generation: 2, previous: { verificationResultSha256: previousResult?.sha256, receiptSha256: previousResult?.receiptSha256,
        patchShape: { files: 1, replacementBytes: 0 }, failure },
    } });
    expect(ready).toMatchObject({ state: 'queued' });
    expect((await tasks.events(identity, task.id, 50, 'zh-CN')).at(-1)).toMatchObject({ type: 'task.repair_retry_queued', message: /返修/ });
    expect((await database.storage.db.select().from(taskRuns).where(eq(taskRuns.id, task.runId)))[0]).toMatchObject({ state: 'failed' });
    await expect(database.storage.db.update(formalRepairRetries).set({ sha256: sha256('different proof') }))
      .rejects.toMatchObject({ cause: { code: '23514', message: 'formal_repair_retry_is_immutable' } });
    await expect(coordinator.withLease({ taskId: task.id, runId: task.runId, generation: 1, fence: previousResult!.finalizedFence,
      workerId: previousResult!.workerId }, async () => true)).rejects.toBeInstanceOf(ExecutionLost);

    if (mode === 'reclaimed change') {
      const waiting = await new VerificationViewService(database.storage).get(identity, task.id, 'en');
      expect(waiting).toMatchObject({ current: { runId: ready.runId, generation: 2, status: 'pending' },
        previous: { runId: task.runId, generation: 1, status: 'recorded', outcome: 'checks_failed', resultSha256: previousResult!.sha256 },
      });
      const interrupted = await claim();
      expect(interrupted).toMatchObject({ runId: ready.runId, generation: 2 });
      await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
    } else if (mode === 'restored grant') {
      const [owner] = await database.storage.db.delete(workspaceMembers).returning();
      await database.storage.db.insert(workspaceMembers).values({ principalId: owner!.principalId, workspaceId: owner!.workspaceId });
    }
    const second = open(mode === 'changed policy' ? ['protected-elsewhere'] : []);
    try { expect(await second.tick()).toBe(true); expect(await second.tick()).toBe(false); } finally { await second.close(); }
    const after = await tasks.get(identity, task.id);
    if (mode === 'restored grant' || mode === 'changed policy') {
      expect(after.state).toBe('needs_human');
      expect((await tasks.events(identity, task.id, 50)).at(-1)).toMatchObject({
        reason: mode === 'restored grant' ? 'permission_revoked' : 'repair_retry_configuration_changed',
      });
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(repair).toHaveBeenCalledTimes(1);
      expect(verify).toHaveBeenCalledTimes(1);
      return;
    }
    expect(observedRetries).not.toHaveLength(0);
    expect(observedRetries.every(value => JSON.stringify(value) === JSON.stringify(formalRepairRetryContextSchema.parse(retry!.document.previous)))).toBe(true);
    expect(inspect).toHaveBeenCalledTimes(2);
    const [newRepair] = await database.storage.db.select().from(formalRepairResults).where(eq(formalRepairResults.runId, ready.runId));
    if (mode === 'repeat patch') {
      expect(after.state).toBe('needs_human');
      expect(repair).toHaveBeenCalledTimes(1);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(newRepair?.document).toMatchObject({ status: 'requires_human', reason: 'manual_review' });
    } else {
      expect(repair).toHaveBeenCalledTimes(2);
      expect(verify).toHaveBeenCalledTimes(2);
      expect(newRepair?.document).toMatchObject({ status: 'candidate_ready', candidate: { changes: [{ afterSha256: sha256(prefix + replacement) }] } });
      const [review] = await database.storage.db.select().from(formalVerificationResults).where(eq(formalVerificationResults.runId, ready.runId));
      const exhausted = mode === 'budget exhausted';
      expect(review?.document.review).toMatchObject({ outcome: exhausted ? 'checks_failed' : 'observed' });
      expect(after).toMatchObject({ runId: ready.runId, state: exhausted ? 'needs_human' : 'waiting_input' });
      expect((await tasks.events(identity, task.id, 50)).at(-1)).toMatchObject({
        reason: exhausted ? 'repair_retry_limit' : 'verification_observed', type: 'task.verification_recorded',
      });
      if (mode === 'reclaimed change') await verifyRetryView(ready.runId, review!.sha256, previousResult!.sha256);
    }
    expect(await database.storage.db.select().from(taskRuns)).toHaveLength(2);
    expect(await database.storage.db.select().from(formalRepairRetries)).toHaveLength(1);
  },
);

async function verifyRetryView(currentRunId: string, currentSha256: string, previousSha256: string) {
  const publicUrl = 'https://itervane.example';
  const api = createApi(database.storage, { ...issuer.config, publicUrl }, { logger: false });
  const client = new Client({ name: 'verification-reader', version: '0.0.0' });
  const url = `/v1/tasks/${task.id}/verification`;
  const authorization = `Bearer ${await issuer.token()}`;
  try {
    const address = await api.listen({ host: '127.0.0.1', port: 0 });
    const token = await issuer.token('owner', { aud: `${publicUrl}/mcp`, scope: 'itervane:read' });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, 'Accept-Language': 'zh-CN' } },
    }));
    const read = async (locale: string) => api.inject({ url, headers: { authorization, 'Accept-Language': locale } });
    const zh = await read('zh-CN');
    const en = await read('en');
    const mcp = await client.callTool({ name: 'get_verification', arguments: { taskId: task.id } });
    expect(zh.statusCode).toBe(200);
    expect(zh.headers['cache-control']).toBe('no-store');
    expect(mcp.isError).not.toBe(true);
    const view = verificationViewSchema.parse(mcp.structuredContent);
    expect(zh.json()).toEqual(view);
    expect(view).toMatchObject({ locale: 'zh-CN',
      current: { runId: currentRunId, generation: 2, outcome: 'observed', resultSha256: currentSha256,
        message: /复验/, image: { status: 'scanned', manifestDigest: /sha256:/ } },
      previous: { runId: task.runId, generation: 1, outcome: 'checks_failed', resultSha256: previousSha256,
        baseline: { status: 'failed', failures: [{ id: 'health', statusCode: 503 }] } },
    });
    expect(verificationViewSchema.parse(en.json())).toMatchObject({ locale: 'en',
      current: { resultSha256: view.current.status === 'recorded' ? view.current.resultSha256 : null, message: /verification/ },
      previous: { resultSha256: previousSha256, message: /verification/ },
    });
    expect(JSON.stringify(mcp)).not.toMatch(/workspaceSha256|archive|checkpointId|followUps|grantId|releaseEligible|REMOVE=/);
    expect(JSON.stringify(mcp)).not.toContain(fixtureFindingPath);

    await database.admin.query('ALTER TABLE itervane.formal_verification_results DISABLE TRIGGER formal_verification_result_authority');
    try {
      await database.admin.query('UPDATE itervane.formal_verification_results SET sha256=$1 WHERE run_id=$2', [sha256('different prior result'), task.runId]);
      const rejected = await read('zh-CN');
      expect(rejected.statusCode).toBe(500);
      expect(apiErrorSchema.parse(rejected.json()).error).toMatchObject({ code: 'internal_error', locale: 'zh-CN' });
      const rejectedMcp = await client.callTool({ name: 'get_verification', arguments: { taskId: task.id } });
      expect(rejectedMcp.isError).toBe(true);
      expect(apiErrorSchema.parse(rejectedMcp.structuredContent).error.code).toBe('internal_error');
    } finally {
      await database.admin.query('UPDATE itervane.formal_verification_results SET sha256=$1 WHERE run_id=$2', [previousSha256, task.runId]);
      await database.admin.query('ALTER TABLE itervane.formal_verification_results ENABLE TRIGGER formal_verification_result_authority');
    }
  } finally { await client.close(); await api.close(); }
}

it('records one immutable repair command and a checked receipt across concurrent duplicate dispatches', async () => {
  const { scope, proposal, scan, original } = await repairReady();
  const admitted = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const repair = vi.fn<RepairRunner['repair']>(async (request, workspace, patch, authorize) => {
    await authorize(); admitted.resolve();
    await finish.promise;
    return repairReceipt(scan, request, workspace, patch, original);
  });
  const execution = new FormalRepairExecution(coordinator, { runner: { observe: async () => idleRepairRunner(), repair }, protectedPaths: [] });
  const processing = execution.apply(scope, proposal);
  try {
    await Promise.race([admitted.promise, processing.then(() => { throw new Error('Repair was not dispatched'); })]);
    expect(await execution.apply(scope, proposal)).toMatchObject({ kind: 'rejected', code: 'cleanup_unproven', cleanup: 'unknown' });
    const [record] = await database.storage.db.select().from(formalRepairAttempts);
    expect(record).toMatchObject({ state: 'reserved', fence: scope.fence, receipt: null });
  } finally { finish.resolve(); }
  const result = await processing;
  expect(result).toMatchObject({ kind: 'repair_receipt', cleanupConfirmed: true });
  expect(await execution.apply(scope, proposal)).toEqual(result);
  expect(repair).toHaveBeenCalledTimes(1);
  const [operation] = await database.storage.db.select().from(formalRepairOperations);
  const [attempt] = await database.storage.db.select().from(formalRepairAttempts);
  expect(operation).toMatchObject({ preparedFence: scope.fence, findingIds: proposal.findingIds, commandSha256: sha256(operation!.command) });
  expect(attempt).toMatchObject({ operationId: operation!.operationId, state: 'recorded', settledFence: scope.fence,
    settledWorkerId: scope.workerId, receipt: result, receiptSha256: sha256(JSON.stringify(result)) });

  const changed: RepairPatch = { ...proposal.patch, files: proposal.patch.files.map(file => ({ ...file,
    edits: file.edits.map(edit => ({ ...edit, replacement: 'Different verified change.\n' })) })) };
  await expect(execution.apply(scope, { ...proposal, patch: changed })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  await expect(database.storage.db.update(formalRepairAttempts).set({ state: 'closed' })).rejects
    .toMatchObject({ cause: { code: '23514', message: 'formal_repair_attempt_transition' } });
  const otherOperationId = randomUUID();
  const persisted = JSON.parse(operation!.command);
  const other = canonicalRepairCommand({ ...persisted.workspace, operationId: otherOperationId }, persisted.patch);
  await expect(database.storage.db.insert(formalRepairOperations).values({ ...operation!, operationId: otherOperationId,
    callKeySha256: sha256('modified command'), command: other.bytes.toString('utf8') })).rejects
    .toMatchObject({ cause: { code: '23514', constraint: 'formal_repair_operation_command' } });
});

it('restricts scoped repair paths and retains no candidate for an invalid runner receipt', async () => {
  const { scope, proposal, scan, original } = await repairReady();
  const arrived = Promise.withResolvers<QualifiedRepairReceipt>();
  const finish = Promise.withResolvers<void>();
  const repair = vi.fn<RepairRunner['repair']>(async (request, workspace, patch, authorize) => {
    await authorize();
    const receipt = { ...repairReceipt(scan, request, workspace, patch, original), commitSha256: sha256('different object') };
    arrived.resolve(receipt);
    await finish.promise;
    return receipt;
  });
  const runner = { observe: async () => idleRepairRunner(), repair };
  const protectedExecution = new FormalRepairExecution(coordinator, { runner, protectedPaths: [fixtureFindingPath.toUpperCase()] });
  const execution = new FormalRepairExecution(coordinator, { runner, protectedPaths: [] });
  await expect(protectedExecution.apply(scope, proposal)).rejects.toMatchObject({ code: 'forbidden' });
  const other = { ...proposal.patch, files: proposal.patch.files.map(file => ({ ...file, path: 'unobserved.ts' })) };
  await expect(execution.apply(scope, { ...proposal, patch: other })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(execution.apply(scope, { ...proposal, findingIds: [sha256('foreign')] })).rejects.toMatchObject({ code: 'forbidden' });
  expect(repair).not.toHaveBeenCalled();
  expect(await database.storage.db.select().from(formalRepairOperations)).toEqual([]);
  const processing = execution.apply(scope, proposal);
  try {
    const receipt = await Promise.race([arrived.promise, processing.then(() => { throw new Error('Repair was not dispatched'); })]);
    await expect(database.storage.db.update(formalRepairAttempts).set({ state: 'recorded', settledFence: scope.fence,
      settledWorkerId: scope.workerId, settledAt: new Date(), receipt, receiptSha256: sha256(JSON.stringify(receipt)) }))
      .rejects.toMatchObject({ cause: { code: '23514', message: 'formal_repair_attempt_authority_or_receipt_mismatch' } });
  } finally { finish.resolve(); }
  expect(await processing).toMatchObject({ kind: 'rejected', code: 'cleanup_unproven' });
  expect(repair).toHaveBeenCalledTimes(1);
  expect((await database.storage.db.select().from(formalRepairAttempts))[0]).toMatchObject({ state: 'uncertain', receipt: null });
});

it('replays only after the original runner workspace is proven idle under a recovered lease', async () => {
  const { scope, proposal, scan, original } = await repairReady();
  let status = idleRepairRunner();
  const repair = vi.fn<RepairRunner['repair']>(async (request, workspace, patch, authorize) => {
    await authorize();
    if (request.fence === scope.fence) await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
    return repairReceipt(scan, request, workspace, patch, original);
  });
  const execution = new FormalRepairExecution(coordinator, { runner: { observe: async () => status, repair }, protectedPaths: [] });
  await expect(execution.apply(scope, proposal)).rejects.toBeInstanceOf(ExecutionLost);
  const [originalAttempt] = await database.storage.db.select().from(formalRepairAttempts);
  expect(originalAttempt).toMatchObject({ state: 'reserved', receipt: null });
  await coordinator.reconcile(randomUUID());
  const recovered = await claim();
  expect(recovered).toMatchObject({ runId: scope.runId });
  expect(recovered.fence).toBeGreaterThan(scope.fence);
  status = { ...status, workspaceSha256: sha256('different runner workspace') };
  await expect(execution.apply(recovered, proposal)).resolves.toMatchObject({ code: 'cleanup_unproven', requestId: originalAttempt!.requestId });
  expect(repair).toHaveBeenCalledTimes(1);
  expect((await database.storage.db.select().from(formalRepairAttempts))[0]).toMatchObject({ state: 'uncertain', settledFence: recovered.fence });
  status = idleRepairRunner();
  await expect(execution.apply(recovered, proposal)).resolves.toMatchObject({ kind: 'repair_receipt', scope: { fence: recovered.fence } });
  const attempts = await database.storage.db.select().from(formalRepairAttempts);
  expect(attempts).toHaveLength(2);
  expect(attempts.find(row => row.requestId === originalAttempt!.requestId)).toMatchObject({ state: 'closed', receipt: null });
  const replacement = attempts.find(row => row.state === 'recorded')!;
  expect(replacement.operationId).toBe(originalAttempt!.operationId);
  expect(replacement.requestId).not.toBe(originalAttempt!.requestId);
  expect(await database.storage.db.select().from(formalRepairOperations)).toHaveLength(1);
});

it.each(['cancelled', 'revoked'] as const)('keeps cleanup evidence only when a repair task is %s', async change => {
  const { scope, proposal, scan, original } = await repairReady();
  const repair = vi.fn<RepairRunner['repair']>(async (request, workspace, patch, authorize) => {
    await authorize();
    if (change === 'cancelled') {
      const tasks = new TaskService(database.storage);
      const current = await tasks.get(identity, task.id);
      await tasks.cancel(identity, task.id, { expectedVersion: current.version });
    } else {
      await database.admin.query('DELETE FROM itervane.workspace_members');
    }
    await expect(authorize()).rejects.toBeDefined();
    return repairReceipt(scan, request, workspace, patch, original);
  });
  const execution = new FormalRepairExecution(coordinator, { runner: { observe: async () => idleRepairRunner(), repair }, protectedPaths: [] });
  await expect(execution.apply(scope, proposal)).rejects.toBeDefined();
  expect((await database.storage.db.select().from(formalRepairAttempts))[0]).toMatchObject({ state: 'closed', receipt: null, receiptSha256: null });
});

async function attempt(scope: ExecutionScope) {
  const plan = await coordinator.withLease(scope, (tx, current) => prepareInspection(tx, current.task, scope.runId, scope.fence));
  const binding = {
    requestId: randomUUID(), taskId: task.id, projectId: task.projectId, runId: scope.runId,
    repositoryId: task.source.repositoryId, commit: task.source.commit, generation: scope.generation,
    fence: scope.fence, planSha256: plan.sha256, workspaceSha256,
  };
  const receipt = testReceipt({ version: 1, origin, ...binding });
  const storage = database.storage.db;
  const row = { ...binding, workerId: scope.workerId, imageSha256, originSha256: sha256(origin) };
  return {
    row, receipt,
    reserve: () => storage.insert(inspectionAttempts).values(row),
    record: (value = receipt) => storage.update(inspectionAttempts).set({
      state: 'recorded', settledFence: scope.fence, settledAt: new Date(), receiptSha256: sha256(JSON.stringify(value)), receipt: value,
    }).where(eq(inspectionAttempts.requestId, binding.requestId)),
  };
}

it('fences a late inspection receipt and requires closure of an earlier attempt before reserving a recovered one', async () => {
  const old = await claim(); const first = await attempt(old);
  await expect(database.storage.db.insert(inspectionAttempts).values({ ...first.row, workspaceSha256: null })).rejects
    .toMatchObject({ cause: { code: '23514', message: 'inspection_workspace_required' } });
  await first.reserve();
  await expect(database.storage.db.update(inspectionAttempts).set({ workspaceSha256: '0'.repeat(64), state: 'closed', settledFence: old.fence, settledAt: new Date() })).rejects
    .toMatchObject({ cause: { code: '23514', message: 'inspection_workspace_is_immutable' } });
  await expect(database.storage.db.update(inspectionAttempts).set({ workerId: randomUUID() })).rejects
    .toMatchObject({ cause: { code: '23514', message: 'inspection_attempt_binding_is_immutable' } });
  await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
  await expect(first.record()).rejects.toMatchObject({ cause: { code: '23514', message: 'inspection_attempt_authority_lost' } });
  await coordinator.reconcile(randomUUID());
  const current = await claim(); const second = await attempt(current);
  await expect(second.reserve()).rejects.toMatchObject({ cause: { code: '23505' } });
  await database.storage.db.update(inspectionAttempts).set({
    state: 'closed', settledFence: current.fence, settledAt: new Date(),
  }).where(eq(inspectionAttempts.requestId, first.row.requestId));
  await second.reserve();
  await expect(second.record(first.receipt)).rejects.toMatchObject({ cause: { code: '23514', constraint: 'inspection_attempt_receipt_binding' } });
  await expect(second.record({ ...second.receipt, scope: { ...second.receipt.scope, workspaceSha256: '0'.repeat(64) } })).rejects
    .toMatchObject({ cause: { code: '23514', constraint: 'inspection_attempt_workspace_binding' } });
  await second.record();
  const observed = await database.admin.query('SELECT state, settled_fence FROM itervane.inspection_attempts ORDER BY fence');
  expect(observed.rows).toEqual([{ state: 'closed', settled_fence: current.fence }, { state: 'recorded', settled_fence: current.fence }]);
  await expect(database.storage.db.delete(inspectionAttempts)).rejects
    .toMatchObject({ cause: { code: '23514', message: 'inspection_attempt_is_retained' } });
});

it('blocks publication after task cancellation while allowing the active worker to record closure', async () => {
  const scope = await claim(); const pending = await attempt(scope);
  await pending.reserve();
  await new TaskService(database.storage).cancel(identity, task.id, { expectedVersion: 2 });
  await expect(pending.record()).rejects.toMatchObject({ cause: { code: '23514', message: 'inspection_attempt_authority_lost' } });
  await database.storage.db.update(inspectionAttempts).set({ state: 'closed', settledFence: scope.fence, settledAt: new Date() })
    .where(eq(inspectionAttempts.requestId, pending.row.requestId));
  expect((await database.admin.query('SELECT state, receipt FROM itervane.inspection_attempts')).rows).toEqual([{ state: 'closed', receipt: null }]);
});

const idle: Awaited<ReturnType<InspectionRunner['observe']>> = { kind: 'status', version: 1, state: 'idle', imageSha256, workspaceSha256 };
const inspectionRunner = (inspect: InspectionRunner['inspect']): InspectionRunner => ({ observe: async () => idle, inspect });

it('publishes a receipt and its tool event atomically, and reuses the receipt after the Worker is replaced', async () => {
  let dispatched = 0;
  const runner = inspectionRunner(async (request, authorize) => {
    await authorize();
    expect(request).toMatchObject({ origin, workspaceSha256, taskId: task.id, projectId: task.projectId, commit: task.source.commit });
    expect((await database.admin.query('SELECT state, receipt FROM itervane.inspection_attempts')).rows).toEqual([{ state: 'reserved', receipt: null }]);
    dispatched++;
    return testReceipt(request, false, fixtureFindingPath);
  });
  const scope = await claim();
  const gateway = new ToolGateway(coordinator, runner);
  const first = await gateway.call(scope, 'source.inspect', {}, 'source:0');
  const attempt = (await database.admin.query('SELECT request_id, state, receipt_sha256 FROM itervane.inspection_attempts')).rows[0];
  expect(attempt.state).toBe('recorded');
  expect(first).toMatchObject({ status: 'success', data: { requestId: attempt.request_id, coverage: 'complete' },
    evidence: [{ id: attempt.request_id, kind: 'scan', sha256: attempt.receipt_sha256 }] });
  const observed = (await database.admin.query("SELECT detail FROM itervane.task_events WHERE type='task.tool_observed'")).rows;
  expect(observed).toEqual([{ detail: { reason: 'source.inspect', runId: scope.runId,
    inspectionRequestId: attempt.request_id, toolCallKeySha256: sha256('source:0') } }]);
  expect(await gateway.call(scope, 'source.inspect', {}, 'source:0')).toEqual(first);
  expect(await gateway.call(scope, 'source.inspect', {}, 'other-key')).toEqual(first);

  await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
  const replacement = new DurableWorker(database.storage, database.runtimeUrl);
  try { await replacement.tick(); } finally { await replacement.close(); }
  const tasks = new TaskService(database.storage);
  const current = await tasks.get(identity, task.id);
  expect(current).toMatchObject({ state: 'waiting_input', runId: scope.runId });
  const summary = await new InspectionService(database.storage).get(identity, task.id);
  expect(summary).toMatchObject({ status: 'completed', sourceFetched: true, snapshotVerified: true, scanCompleted: true,
    result: { requestId: attempt.request_id, receiptSha256: attempt.receipt_sha256,
      scans: [{ scanner: 'gitleaks', status: 'completed' }, { scanner: 'trivy', status: 'completed' }] } });
  expect(JSON.stringify(summary)).not.toContain('workspaceSha256');
  const [auditInput] = await database.storage.db.select().from(formalAuditInputs);
  const handoff = formalAuditInputSchema.parse(auditInput?.document);
  expect(handoff).toMatchObject({ taskId: task.id, runId: scope.runId, projectId: task.projectId, source: task.source,
    locale: 'zh-CN', purposeSha256: sha256(task.purpose), inspection: { requestId: attempt.request_id, receiptSha256: attempt.receipt_sha256 } });
  expect(sha256(JSON.stringify(handoff))).toBe(auditInput?.sha256);
  expect(handoff.catalog.rules.every(rule => rule.material.enforcement === 'advisory')).toBe(true);
  expect(JSON.stringify(handoff)).not.toContain(origin);
  expect((await tasks.events(identity, task.id, 50, 'zh-CN')).at(-1)).toMatchObject({
    reason: 'inspection_ready', reasonMessage: '源码检查证据已入库，等待进入审计阶段。',
  });
  const beforeAudit = await database.admin.query("SELECT key_hash, fence FROM itervane.tool_calls WHERE tool='source.inspect' ORDER BY key_hash");
  const queued = await tasks.resume(identity, task.id, { expectedVersion: current.version });
  expect(queued).toMatchObject({ runId: scope.runId, state: 'queued' });
  const complete = vi.fn(concludeAudit);
  const auditor = new DurableWorker(database.storage, database.runtimeUrl, { auditModel: auditModel(complete) });
  try { await auditor.tick(); } finally { await auditor.close(); }

  const [row] = await database.storage.db.select().from(formalAuditResults);
  const audit = formalAuditResultSchema.parse(row?.document);
  expect(sha256(JSON.stringify(audit))).toBe(row?.sha256);
  expect(audit).toMatchObject({ runId: scope.runId, status: 'completed', reason: 'audit_complete', locale: 'zh-CN',
    inspectionSha256: attempt.receipt_sha256, usage: { turns: 3, toolCalls: 2, tokens: 90 },
    checklist: { coverage: 'complete', findings: [{ scanner: 'gitleaks', path: fixtureFindingPath, line: 3, certainty: 'suspected' }] },
  });
  const [sealed] = await database.storage.db.select().from(formalRepairInputs);
  const repair = formalRepairInputSchema.parse(sealed?.document);
  expect(repair).toMatchObject({ source: task.source, inspection: handoff.inspection, catalogSha256: handoff.catalog.sha256,
    audit: { resultSha256: row?.sha256, inputSha256: auditInput?.sha256, checkpointId: audit.checkpointId },
    findingIds: audit.checklist?.findings.map(finding => finding.id),
  });
  expect(sealed?.sha256).toBe(sha256(JSON.stringify(repair)));
  expect(audit.trace.map(item => item.tool)).toEqual(['read_scan', 'read_scan']);
  expect(complete).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(complete.mock.calls.map(([request]) => request.conversation))).not.toContain(fixtureFindingPath);
  const audited = await tasks.get(identity, task.id);
  expect(audited).toMatchObject({ runId: scope.runId, state: 'waiting_input' });
  expect((await tasks.events(identity, task.id, 50, 'zh-CN')).at(-1)).toMatchObject({ type: 'task.audit_recorded', reason: 'audit_ready' });
  const events = await database.admin.query("SELECT detail FROM itervane.task_events WHERE type='task.audit_recorded'");
  expect(events.rows).toEqual([{ detail: { runId: scope.runId, reason: 'audit_ready', auditResultSha256: row?.sha256 } }]);
  await expect(tasks.resume(identity, task.id, { expectedVersion: audited.version - 1 })).rejects.toMatchObject({ code: 'version_conflict' });
  await expect(database.storage.pool.query('UPDATE itervane.formal_audit_results SET sha256=sha256')).rejects
    .toMatchObject({ code: '23514', message: 'formal_audit_result_is_retained' });
  await expect(database.storage.pool.query('UPDATE itervane.formal_audit_runtime SET checkpoint_step=checkpoint_step+1')).rejects
    .toMatchObject({ code: '23514', message: 'formal_audit_checkpoint_already_finalized' });
  const sourceCalls = await database.admin.query("SELECT key_hash, fence FROM itervane.tool_calls WHERE tool='source.inspect' ORDER BY key_hash");
  expect(sourceCalls.rows).toEqual(beforeAudit.rows);
  expect(dispatched).toBe(1);
});

it('publishes provider failure with already recorded scan evidence and measured usage', async () => {
  const provider = await auditProtocolFixture(); provider.fail();
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { runner: completedRunner(),
    auditModel: configuredAuditModel({ protocol: 'anthropic', baseURL: provider.baseURL, apiKey: auditFixtureKey, model: auditFixtureModel }),
  });
  try { await worker.tick(); } finally { try { await worker.close(); } finally { await provider.close(); } }
  const [record] = await database.storage.db.select().from(formalAuditResults);
  expect(formalAuditResultSchema.parse(record?.document)).toMatchObject({ status: 'requires_human', reason: 'provider_error', checklist: null,
    usage: { turns: 2, toolCalls: 1, tokens: 47 }, evidence: [{ kind: 'scan', scanner: 'gitleaks' }] });
  expect(provider.calls).toEqual(['read_scan', 'unavailable']);
  expect(await new TaskService(database.storage).get(identity, task.id)).toMatchObject({ state: 'needs_human' });
  expect((await database.admin.query('SELECT task_id FROM itervane.execution_slot')).rows).toEqual([{ task_id: null }]);
});

it('shares one recorded audit across authorized HTTP and external MCP with independent display languages', async () => {
  const provider = await auditProtocolFixture();
  const worker = new DurableWorker(database.storage, database.runtimeUrl, {
    runner: completedRunner(fixtureFindingPath), auditModel: configuredAuditModel({ protocol: 'anthropic', baseURL: provider.baseURL,
      apiKey: auditFixtureKey, model: auditFixtureModel }),
  });
  expect(await database.storage.db.select().from(formalRepairInputs)).toEqual([]);
  try { await worker.tick(); } finally { try { await worker.close(); } finally { await provider.close(); } }
  expect(provider.calls).toEqual(['read_scan', 'read_rule', 'read_scan', 'finish_role']);
  const publicUrl = 'https://itervane.example';
  const api = createApi(database.storage, { ...issuer.config, publicUrl }, { logger: false });
  const client = new Client({ name: 'audit-reader', version: '0.0.0' });
  try {
    const address = await api.listen({ host: '127.0.0.1', port: 0 });
    const token = await issuer.token('owner', { aud: `${publicUrl}/mcp`, scope: 'itervane:read' });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, 'Accept-Language': 'zh-CN' } },
    }));
    const response = await client.callTool({ name: 'get_audit', arguments: { taskId: task.id } });
    const view = formalAuditDtoSchema.parse(response.structuredContent);
    const url = `/v1/tasks/${task.id}/audit`;
    const authorization = `Bearer ${await issuer.token()}`;
    const zh = await api.inject({ url, headers: { authorization, 'Accept-Language': 'zh-CN' } });
    const en = await api.inject({ url, headers: { authorization, 'Accept-Language': 'en' } });
    expect(zh.statusCode).toBe(200);
    expect(zh.headers['cache-control']).toBe('no-store');
    expect(zh.json()).toEqual(view);
    expect(en.json()).toMatchObject({ locale: 'en', message: 'The audit checklist is grounded in both protected scans.', result: view.result });
    expect(view).toMatchObject({ status: 'recorded', locale: 'zh-CN', result: { locale: 'zh-CN', status: 'completed',
      checklist: { findings: [{ path: fixtureFindingPath, certainty: 'suspected' }] } } });
    expect(response.isError).not.toBe(true);
    expect(JSON.stringify(view)).not.toContain('workspaceSha256');
  } finally { await client.close(); await api.close(); }
});

it.each(['runner_missing', 'incomplete_scan'])('keeps the model off when source evidence is %s', async condition => {
  const complete = vi.fn(concludeAudit);
  const worker = new DurableWorker(database.storage, database.runtimeUrl, {
    auditModel: auditModel(complete), ...(condition === 'incomplete_scan' ? { runner: completedRunner(undefined, true) } : {}),
  });
  const tasks = new TaskService(database.storage);
  try {
    await vi.waitFor(async () => {
      await worker.tick();
      expect(await tasks.get(identity, task.id)).toMatchObject({ state: 'waiting_input' });
    }, { timeout: 5_000, interval: 50 });
  } finally { await worker.close(); }
  expect(complete).not.toHaveBeenCalled();
  expect(await database.storage.db.select().from(formalAuditResults)).toEqual([]);
});

it('recovers the reserved turn after Worker shutdown without calling the model again', async () => {
  const started = Promise.withResolvers<void>();
  const complete = vi.fn<ModelAdapter['complete']>().mockImplementation(async ({ signal }) => {
    const aborted = once(signal, 'abort');
    started.resolve();
    await aborted;
    return auditTurn('read_scan', { scanner: 'gitleaks' });
  });
  const options = { auditModel: auditModel(complete) };
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { ...options, runner: completedRunner() });
  const processing = worker.tick();
  try { await Promise.race([started.promise, processing.then(() => { throw new Error('Worker did not start the model'); })]); }
  finally { await worker.close(); }
  const checkpoint = (await database.admin.query('SELECT checkpoint_id, published_fence FROM itervane.formal_audit_runtime')).rows[0];
  await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
  const replacement = new DurableWorker(database.storage, database.runtimeUrl, options);
  try { await replacement.tick(); } finally { await replacement.close(); }
  const [record] = await database.storage.db.select().from(formalAuditResults);
  expect(record?.checkpointId).toBe(checkpoint.checkpoint_id);
  expect(record!.finalizedFence).toBeGreaterThan(checkpoint.published_fence);
  expect(formalAuditResultSchema.parse(record?.document)).toMatchObject({ status: 'requires_human', reason: 'interrupted_action',
    usage: { turns: 1, toolCalls: 0 }, evidence: [] });
  expect(complete).toHaveBeenCalledTimes(1);
});

it.each(['cancelled', 'revoked'] as const)('blocks audit publication when the in-flight task is %s', async change => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const complete = vi.fn<ModelAdapter['complete']>().mockImplementation(async () => {
    started.resolve();
    await finish.promise;
    return auditTurn('read_scan', { scanner: 'gitleaks' });
  });
  const tasks = new TaskService(database.storage);
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { runner: completedRunner(), auditModel: auditModel(complete) });
  const processing = worker.tick();
  let grant: { workspace_id: string; principal_id: string; grant_id: string } | undefined;
  try {
    await Promise.race([started.promise, processing.then(() => { throw new Error('Worker did not start the model'); })]);
    if (change === 'cancelled') {
      const current = await tasks.get(identity, task.id);
      await tasks.cancel(identity, task.id, { expectedVersion: current.version });
    } else {
      grant = (await database.admin.query('DELETE FROM itervane.workspace_members RETURNING workspace_id, principal_id, grant_id')).rows[0];
      expect(grant).toBeDefined();
    }
    finish.resolve();
    await processing;
  } finally {
    finish.resolve();
    await worker.close();
    if (grant) await database.admin.query('INSERT INTO itervane.workspace_members(workspace_id,principal_id,grant_id) VALUES($1,$2,$3)',
      [grant.workspace_id, grant.principal_id, grant.grant_id]);
  }
  expect(await database.storage.db.select().from(formalAuditResults)).toEqual([]);
  expect(await tasks.get(identity, task.id)).toMatchObject({ state: change === 'cancelled' ? 'cancelled' : 'needs_human' });
  expect((await tasks.events(identity, task.id, 50)).at(-1)).toMatchObject({ reason: change === 'cancelled' ? 'cancelled' : 'permission_revoked' });
  expect(complete).toHaveBeenCalledTimes(1);
});

it('rolls back the outcome and handoff when the audit event cannot be written', async () => {
  await database.admin.query("ALTER TABLE itervane.task_events ADD CONSTRAINT injected_audit_event_failure CHECK(type <> 'task.audit_recorded') NOT VALID");
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { runner: completedRunner(), auditModel: auditModel() });
  try { await worker.tick(); } finally {
    await worker.close();
    await database.admin.query('ALTER TABLE itervane.task_events DROP CONSTRAINT injected_audit_event_failure');
  }
  expect(await database.storage.db.select().from(formalAuditResults)).toEqual([]);
  expect(await database.storage.db.select().from(formalRepairInputs)).toEqual([]);
  expect(await new TaskService(database.storage).get(identity, task.id)).toMatchObject({ state: 'needs_human' });
  expect((await new TaskService(database.storage).events(identity, task.id, 50)).at(-1)).toMatchObject({ reason: 'audit_failed' });
});

it('revalidates the same repair input after a new lease and seals existing completed audits on demand', async () => {
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { runner: completedRunner(fixtureFindingPath), auditModel: auditModel() });
  const tasks = new TaskService(database.storage);
  try {
    await vi.waitFor(async () => {
      await worker.tick();
      const current = await tasks.get(identity, task.id);
      const reason = current.state === 'needs_human' ? (await tasks.events(identity, task.id, 20)).at(-1)?.reason : undefined;
      expect(current.state, reason ?? undefined).toBe('waiting_input');
    }, { timeout: 5_000, interval: 50 });
  } finally { await worker.close(); }
  const [sealed] = await database.storage.db.select().from(formalRepairInputs);
  expect(sealed).toBeDefined();
  const scope = await claimAfterAudit();
  const prepare = (execution = scope) => coordinator.withLease(execution, (tx, current) => prepareFormalRepairInput(tx, current.task, execution));
  const prepared = await prepare();
  expect(prepared).toMatchObject({ sha256: sealed!.sha256, document: formalRepairInputSchema.parse(sealed!.document),
    audit: { checkpointId: sealed!.document.audit.checkpointId, status: 'completed' },
  });
  expect(await prepare()).toEqual(prepared);
  expect((await database.storage.db.select().from(formalRepairInputs))[0]?.preparedFence).toBe(sealed!.preparedFence);
  await expect(prepare({ ...scope, fence: sealed!.preparedFence })).rejects.toBeInstanceOf(ExecutionLost);
  await expect(prepare({ ...scope, runId: randomUUID() })).rejects.toBeInstanceOf(ExecutionLost);
  await expect(database.storage.db.insert(formalRepairInputs).values({ ...sealed!, preparedFence: scope.fence, workerId: scope.workerId,
    document: { ...prepared.document, inspection: { ...prepared.document.inspection, snapshotSha256: '0'.repeat(64) } },
  })).rejects.toMatchObject({ cause: { code: '23514', message: 'formal_repair_input_authority_or_audit_mismatch' } });
  await expect(database.storage.pool.query('UPDATE itervane.formal_repair_inputs SET sha256=sha256')).rejects
    .toMatchObject({ code: '23514', message: 'formal_repair_input_is_retained' });
  // The isolated test database now resembles a completed audit from before this migration.
  await clearRepairHandoff();
  expect(await prepare()).toEqual(prepared);
  expect((await database.storage.db.select().from(formalRepairInputs))[0]?.preparedFence).toBe(scope.fence);
});

it('freezes the audit input under the current lease and rejects a substituted snapshot or planned-only source', async () => {
  const scope = await claim();
  const prepare = () => coordinator.withLease(scope, (tx, current) => prepareFormalAuditInput(tx, current.task, scope));
  await expect(prepare()).rejects.toMatchObject({ code: 'unavailable' });
  await new ToolGateway(coordinator).call(scope, 'source.inspect', {}, 'plan-only');
  await expect(prepare()).rejects.toMatchObject({ code: 'unavailable' });
  const runner = inspectionRunner(async (request, authorize) => { await authorize(); return testReceipt(request); });
  await new ToolGateway(coordinator, runner).call(scope, 'source.inspect', {}, 'qualified');
  const frozen = await prepare();
  expect(await prepare()).toEqual(frozen);
  const [row] = await database.storage.db.select().from(formalAuditInputs);
  const changed = { ...frozen.document, inspection: { ...frozen.document.inspection, snapshotSha256: '0'.repeat(64) } };
  await expect(database.storage.db.insert(formalAuditInputs).values({ ...row!, document: changed })).rejects
    .toMatchObject({ cause: { code: '23514', message: 'formal_audit_input_authority_or_inspection_mismatch' } });
  await expect(database.storage.db.insert(formalAuditInputs).values({ ...row!, preparedFence: scope.fence + 1 })).rejects
    .toMatchObject({ cause: { code: '23514', message: 'formal_audit_input_authority_or_inspection_mismatch' } });
  await expect(database.storage.db.update(formalAuditInputs).set({ document: changed })).rejects
    .toMatchObject({ cause: { code: '23514', message: 'formal_audit_input_is_retained' } });
  await expect(database.storage.db.delete(formalAuditInputs)).rejects
    .toMatchObject({ cause: { code: '23514', message: 'formal_audit_input_is_retained' } });
});

it('isolates the audit checkpoint, its acknowledged writes and its input from preflight and stale workers', async () => {
  const scope = await claim();
  const runner = inspectionRunner(async (request, authorize) => { await authorize(); return testReceipt(request); });
  await new ToolGateway(coordinator, runner).call(scope, 'source.inspect', {}, 'verified-for-audit');
  const { sha256: auditInputSha256 } = await coordinator.withLease(scope, (tx, current) => prepareFormalAuditInput(tx, current.task, scope));
  const storage = PostgresSaver.fromConnString(database.runtimeUrl, { schema: 'itervane_checkpoint' });
  try {
    const preflight = new GuardedCheckpointer(coordinator, scope, storage);
    const audit = new GuardedCheckpointer(coordinator, scope, storage, { auditInputSha256 });
    const preflightConfig = { configurable: { thread_id: preflight.threadId } };
    const auditConfig = { configurable: { thread_id: audit.threadId } };
    const sharedId = emptyCheckpoint();
    const preflightBound = await preflight.put(preflightConfig, sharedId, { source: 'input', step: -1, parents: {} }, {});
    await expect(audit.getTuple(preflightConfig)).rejects.toBeInstanceOf(ExecutionLost);
    expect(await audit.getTuple(auditConfig)).toBeUndefined();
    const auditBound = await audit.put(auditConfig, sharedId, { source: 'input', step: -1, parents: {} }, {});

    await preflight.putWrites(preflightBound, [['registered', true]], 'shared-node');
    await storage.putWrites(auditBound, [['registered', true]], 'shared-node');
    expect((await audit.getTuple(auditConfig))?.pendingWrites).toEqual([]);
    await audit.putWrites(auditBound, [['audit_summary', 'verified']], 'audit-node');
    expect((await audit.getTuple(auditConfig))?.pendingWrites).toEqual([['audit-node', 'audit_summary', 'verified']]);
    expect((await preflight.getTuple(preflightConfig))?.pendingWrites).toEqual([['shared-node', 'registered', true]]);

    const orphan = emptyCheckpoint();
    await database.admin.query(`ALTER TABLE itervane.formal_audit_runtime ADD CONSTRAINT injected_audit_pointer_failure CHECK(checkpoint_id <> '${orphan.id}') NOT VALID`);
    try { await expect(audit.put(auditBound, orphan, { source: 'loop', step: 0, parents: {} }, {})).rejects.toThrow(); }
    finally { await database.admin.query('ALTER TABLE itervane.formal_audit_runtime DROP CONSTRAINT injected_audit_pointer_failure'); }
    expect((await storage.getTuple(auditConfig))?.checkpoint.id).toBe(orphan.id);
    expect((await audit.getTuple(auditConfig))?.checkpoint.id).toBe(sharedId.id);
    const wrongInput = new GuardedCheckpointer(coordinator, scope, storage, { auditInputSha256: '0'.repeat(64) });
    await expect(wrongInput.getTuple(auditConfig)).rejects.toBeInstanceOf(ExecutionLost);

    await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
    await expect(audit.put(auditBound, emptyCheckpoint(), { source: 'loop', step: 1, parents: {} }, {})).rejects.toBeInstanceOf(ExecutionLost);
    await coordinator.reconcile(randomUUID());
    const replacement = new GuardedCheckpointer(coordinator, await claim(), storage, { auditInputSha256 });
    expect((await replacement.getTuple(auditConfig))?.checkpoint.id).toBe(sharedId.id);
  } finally { await storage.end(); }
});

it('recovers the repair checkpoint from the published input and filters unacknowledged intermediate writes', async () => {
  const { scope } = await repairReady();
  const [auditInput] = await database.storage.db.select().from(formalAuditInputs);
  const [repairInput] = await database.storage.db.select().from(formalRepairInputs);
  const storage = PostgresSaver.fromConnString(database.runtimeUrl, { schema: 'itervane_checkpoint' });
  try {
    const audit = new GuardedCheckpointer(coordinator, scope, storage, { auditInputSha256: auditInput!.sha256 });
    const repair = new GuardedCheckpointer(coordinator, scope, storage, { repairInputSha256: repairInput!.sha256 });
    const auditConfig = { configurable: { thread_id: audit.threadId } };
    const repairConfig = { configurable: { thread_id: repair.threadId } };
    const auditCheckpoint = await audit.getTuple(auditConfig);
    expect(auditCheckpoint).toBeDefined();
    expect(await repair.getTuple(repairConfig)).toBeUndefined();
    await expect(repair.getTuple(auditConfig)).rejects.toBeInstanceOf(ExecutionLost);
    const invalid = new GuardedCheckpointer(coordinator, scope, storage, { repairInputSha256: auditInput!.sha256 });
    await expect(invalid.getTuple(repairConfig)).rejects.toBeInstanceOf(ExecutionLost);

    const first = { ...emptyCheckpoint(), id: auditCheckpoint!.checkpoint.id };
    const bound = await repair.put(repairConfig, first, { source: 'input', step: -1, parents: {} }, {});
    await repair.putWrites(bound, [['observed', true]], 'repair-node');
    await storage.putWrites(bound, [['unpublished', true]], 'orphan-node');
    const orphan = emptyCheckpoint();
    await storage.put(bound, orphan, { source: 'loop', step: 0, parents: {} }, {});
    expect((await repair.getTuple(repairConfig))?.checkpoint.id).toBe(first.id);
    expect((await repair.getTuple(repairConfig))?.pendingWrites).toEqual([['repair-node', 'observed', true]]);
    expect((await audit.getTuple(auditConfig))?.pendingWrites).not.toContainEqual(['repair-node', 'observed', true]);
    const pointer = (await database.storage.db.select().from(formalRepairRuntime))[0]!;
    expect(pointer).toMatchObject({ runId: scope.runId, checkpointId: first.id, publishedFence: scope.fence });
    await expect(database.storage.db.update(formalRepairRuntime).set({ checkpointStep: pointer.checkpointStep })).rejects
      .toMatchObject({ cause: { code: '23514', message: 'formal_repair_pointer_regression' } });

    const expired = await database.admin.query(
      "UPDATE itervane.execution_slot SET lease_until=TIMESTAMPTZ '2000-01-01T00:00:00Z' WHERE run_id=$1 AND worker_id=$2 AND fence=$3 RETURNING lease_until < clock_timestamp() AS expired",
      [scope.runId, scope.workerId, scope.fence],
    );
    expect(expired.rows).toEqual([{ expired: true }]);
    await expect(repair.putWrites(bound, [['expired', true]], 'old-node')).rejects.toBeInstanceOf(ExecutionLost);
    await coordinator.reconcile(randomUUID());
    const replacement = new GuardedCheckpointer(coordinator, await claim(), storage, { repairInputSha256: repairInput!.sha256 });
    const recovered = await replacement.getTuple(repairConfig);
    expect(recovered?.checkpoint.id).toBe(first.id);
    expect(recovered?.pendingWrites).toEqual([['repair-node', 'observed', true]]);
  } finally { await storage.end(); }
});

it('drops a late receipt when a real cancellation races the scan', async () => {
  const started = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>();
  const runner = inspectionRunner(async (request, authorize) => {
    await authorize(); started.resolve();
    await finish.promise;
    await expect(authorize()).rejects.toBeInstanceOf(ExecutionLost);
    return testReceipt(request);
  });
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { runner });
  const processing = worker.tick();
  const tasks = new TaskService(database.storage);
  try {
    await started.promise;
    expect(await new InspectionService(database.storage).get(identity, task.id)).toMatchObject({ status: 'checking', scanCompleted: false });
    const current = await tasks.get(identity, task.id);
    await tasks.cancel(identity, task.id, { expectedVersion: current.version });
    finish.resolve();
    await processing;
    expect((await tasks.get(identity, task.id)).state).toBe('cancelled');
    expect((await database.admin.query('SELECT state, receipt FROM itervane.inspection_attempts')).rows).toEqual([{ state: 'closed', receipt: null }]);
    expect((await database.admin.query("SELECT result FROM itervane.tool_calls WHERE tool='source.inspect'")).rows).toEqual([{ result: null }]);
  } finally { finish.resolve(); await worker.close(); }
});

it('rolls back the cleaned receipt and tool update together when the observation event cannot commit', async () => {
  const scope = await claim();
  const runner = inspectionRunner(async (request, authorize) => { await authorize(); return testReceipt(request); });
  const gateway = new ToolGateway(coordinator, runner);
  await database.admin.query("ALTER TABLE itervane.task_events ADD CONSTRAINT injected_observation_failure CHECK(type <> 'task.tool_observed') NOT VALID");
  try {
    await expect(gateway.call(scope, 'source.inspect', {}, 'source:0')).rejects.toMatchObject({ cause: { constraint: 'injected_observation_failure' } });
  } finally { await database.admin.query('ALTER TABLE itervane.task_events DROP CONSTRAINT injected_observation_failure'); }
  expect((await database.admin.query('SELECT state, receipt FROM itervane.inspection_attempts')).rows).toEqual([{ state: 'closed', receipt: null }]);
  expect((await database.admin.query('SELECT status, result FROM itervane.tool_calls')).rows).toEqual([{ status: 'reserved', result: null }]);
  expect((await database.admin.query("SELECT count(*)::int AS count FROM itervane.task_events WHERE type='task.tool_observed'")).rows[0]?.count).toBe(0);
});

it('does not revive an inspection after a heartbeat observed permission loss and the grant was restored', async () => {
  const runner = inspectionRunner(async (request, authorize) => {
    await authorize();
    const { workspace_id, principal_id } = (await database.admin.query('DELETE FROM itervane.workspace_members RETURNING workspace_id, principal_id')).rows[0];
    await expect(authorize()).rejects.toMatchObject({ code: 'not_found' });
    await database.admin.query('INSERT INTO itervane.workspace_members(workspace_id,principal_id) VALUES($1,$2)', [workspace_id, principal_id]);
    return testReceipt(request);
  });
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { runner });
  try { await worker.tick(); } finally { await worker.close(); }
  const tasks = new TaskService(database.storage);
  expect((await tasks.get(identity, task.id)).state).toBe('needs_human');
  expect((await tasks.events(identity, task.id, 50)).at(-1)).toMatchObject({ reason: 'permission_revoked' });
  expect((await database.admin.query('SELECT state, receipt FROM itervane.inspection_attempts')).rows).toEqual([{ state: 'closed', receipt: null }]);
});

it('waits for the running inspection to settle cleanup before releasing the slot after heartbeat revocation', async () => {
  const started = Promise.withResolvers<void>(); const stopping = Promise.withResolvers<void>(); const drained = Promise.withResolvers<void>();
  const runner = inspectionRunner(async (request, authorize, signal) => {
    await authorize();
    const aborted = once(signal!, 'abort');
    started.resolve();
    await aborted;
    stopping.resolve();
    await drained.promise;
    return { kind: 'rejected', requestId: request.requestId, code: 'lease_lost', cleanup: 'confirmed', domainId: randomUUID() };
  });
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { runner, leaseSeconds: 6 });
  const processing = worker.tick();
  try {
    await started.promise;
    await database.admin.query('DELETE FROM itervane.workspace_members');
    await stopping.promise;
    await delay(150);
    expect((await database.admin.query('SELECT task_id FROM itervane.execution_slot')).rows).toEqual([{ task_id: task.id }]);
    drained.resolve();
    await processing;
    expect((await database.admin.query('SELECT state, receipt FROM itervane.inspection_attempts')).rows).toEqual([{ state: 'closed', receipt: null }]);
    expect((await database.admin.query('SELECT reason FROM itervane.run_runtime')).rows).toEqual([{ reason: 'permission_revoked' }]);
  } finally { drained.resolve(); await worker.close(); }
});

it('requires a matching idle workspace before a new fence, and retains incomplete scan coverage', async () => {
  let observed = idle;
  let dispatched = 0;
  const runner: InspectionRunner = {
    observe: async () => observed,
    async inspect(request, authorize) {
      await authorize();
      return ++dispatched === 1 ? { kind: 'rejected', requestId: request.requestId, cleanup: 'unknown', code: 'cleanup_unproven', domainId: null }
        : testReceipt(request, true);
    },
  };
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { runner });
  const tasks = new TaskService(database.storage);
  const inspections = new InspectionService(database.storage);
  const reason = async () => (await tasks.events(identity, task.id, 50)).at(-1)?.reason;
  const resume = async () => { await tasks.resume(identity, task.id, { expectedVersion: (await tasks.get(identity, task.id)).version }); await worker.tick(); };
  try {
    await worker.tick();
    expect(await reason()).toBe('inspection_reconciling');
    expect(await inspections.get(identity, task.id)).toMatchObject({ status: 'reconciling', snapshotVerified: false, scanCompleted: false });
    observed = { ...idle, workspaceSha256: '9'.repeat(64) };
    await resume();
    expect(await reason()).toBe('inspection_reconciling');
    observed = { ...idle, state: 'blocked' };
    await resume();
    expect(await reason()).toBe('inspection_reconciling');
    expect(dispatched).toBe(1);
    observed = idle;
    await resume();
    expect(await reason()).toBe('inspection_incomplete');
    expect(dispatched).toBe(2);
    expect(await inspections.get(identity, task.id)).toMatchObject({ status: 'incomplete', snapshotVerified: true, scanCompleted: false,
      result: { scans: [{ status: 'completed' }, { status: 'unsupported', reason: 'missing_inventory', findingsCount: 0 }] } });
    expect(await database.storage.db.select().from(formalAuditInputs)).toHaveLength(0);
    const { rows } = await database.admin.query('SELECT state, settled_fence, fence, receipt FROM itervane.inspection_attempts ORDER BY fence');
    expect(rows).toMatchObject([{ state: 'closed', settled_fence: rows[1].fence, receipt: null },
      { state: 'recorded', receipt: { snapshot: { reports: [{ status: 'completed' }, { status: 'unsupported', reason: 'missing_inventory' }] } } }]);
  } finally { await worker.close(); }
});
