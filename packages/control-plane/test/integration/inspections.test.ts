import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { AgentEvidence } from '@itervane/agent';
import { createFormalVerification } from '@itervane/agent';
import { apiErrorSchema, fixtureReleaseManifestSchema, formalAuditDtoSchema, formalAuditInputSchema, formalAuditResultSchema, formalRepairDtoSchema, formalRepairInputSchema, formalRepairPatchDtoSchema,
  formalReleaseCandidateDtoSchema, formalReleaseOptionsSchema, formalReleaseViewSchema, formalRepairRetryContextSchema, formalVerificationResultSchema, verificationViewSchema,
  qualifiedInspectionResponseSchema, qualifiedRepairObservationRequestSchema, qualifiedRepairRequestSchema, qualifiedScanReportsSchema, type QualifiedInspectionReceipt,
  type NpmUpgradeApproval, type QualifiedInspectionRequest, type QualifiedRepairObservationReceipt, type QualifiedRepairReceipt,
  type QualifiedStandardImageProof, type QualifiedVerificationReceipt, type RepairPatch, type StandardVerificationProfile } from '@itervane/contracts';
import type { ModelAdapter } from '@itervane/model';
import { canonicalRepairCommand, canonicalRepairObservation, canonicalVerificationCommand, prepareQualifiedVerificationRequest,
  scannerProfiles, sha256, verifyQualifiedVerificationReceipt } from '@itervane/runner';
import { npmFixtureApproval, npmFixtureFiles, npmFixturePaths } from '../../../verification/src/agent/npm-repair-fixture.js';
import { scriptedVerification } from '../../../verification/src/agent/verification-fixture.js';
import { createApi } from '../../src/api.js';
import { createIdentityVerifier, type VerifiedIdentity } from '../../src/auth/identity.js';
import { formalReleaseQueue, queueName } from '../../src/persistence/database.js';
import { formalAuditInputs, formalAuditResults, formalRepairAttempts, formalRepairInputs, formalRepairOperations, formalRepairResults, formalRepairRetries,
  formalRepairRuntime, formalRescanAttempts, formalVerificationInputs, formalVerificationResults, formalVerificationRuntime, inspectionAttempts,
  principals, projectMembers, releaseCandidates, releaseDecisions, releaseOperations, taskRuns, tasks as taskRecords, workspaceMembers } from '../../src/persistence/schema.js';
import { ExecutionCoordinator } from '../../src/runtime/coordinator.js';
import { configuredAuditModel, runFormalAudit } from '../../src/runtime/formal-audit.js';
import { runFormalRepair } from '../../src/runtime/formal-repair.js';
import { FormalReleaseCoordinator } from '../../src/runtime/formal-release-claim.js';
import { runFormalRescan, type RescanRunner } from '../../src/runtime/formal-rescan.js';
import { runFormalVerification, type FormalVerificationOptions } from '../../src/runtime/formal-verification.js';
import { ExecutionLost, type ExecutionScope } from '../../src/runtime/authority.js';
import { GuardedCheckpointer } from '../../src/runtime/checkpointer.js';
import { FormalRepairExecution, type RepairRunner } from '../../src/runtime/repair-execution.js';
import { observeFormalRepairTargets, type RepairObservationRunner } from '../../src/runtime/repair-observation.js';
import { ReleaseRehearsal } from '../../src/runtime/release-rehearsal.js';
import { ToolGateway } from '../../src/runtime/tools.js';
import { prepareFormalVerificationInput } from '../../src/runtime/verification-input.js';
import { projectVerificationEvidence } from '../../src/runtime/verification-evidence.js';
import { DurableWorker } from '../../src/runtime/worker.js';
import type { InspectionRunner } from '../../src/runtime/source-inspection.js';
import { bootstrapOwner, ResourceService } from '../../src/service/resources.js';
import { InspectionService, prepareInspection } from '../../src/service/inspections.js';
import { prepareFormalAuditInput } from '../../src/service/formal-audit.js';
import { prepareFormalRepairInput } from '../../src/service/formal-repair.js';
import { FormalReleaseService } from '../../src/service/formal-release.js';
import { publishFormalRepair } from '../../src/service/repair-result.js';
import { verificationProfileFingerprint } from '../../src/service/repair-retry.js';
import { registerReleaseTarget } from '../../src/service/release-targets.js';
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
beforeAll(async () => { database = await databaseFixture(); issuer = await identityFixture(); identity = await createIdentityVerifier(issuer.config)(await issuer.token()); });
beforeEach(async () => {
  await database.reset(); await bootstrapOwner(database.storage, { issuer: issuer.config.issuer, subject: 'owner' });
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

async function repairReady() {
  const worker = new DurableWorker(database.storage, database.runtimeUrl, { runner: completedRunner(fixtureFindingPath), auditModel: auditModel() });
  try { await worker.tick(); } finally { await worker.close(); }
  const [inspection] = await database.storage.db.select().from(inspectionAttempts);
  const [repair] = await database.storage.db.select().from(formalRepairInputs);
  if (!inspection?.receipt || !repair?.document.findingIds.length) throw new Error('Missing repair fixture basis');
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
    expect(await worker.tick()).toBe(true);
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
      snapshot: { ...original.snapshot, runId: domainId, inputsSha256: bound.scannerInputsSha256, target: null,
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
  input: Parameters<RescanRunner['verify']>[1], regression = false, candidate?: QualifiedRepairReceipt['snapshot']['candidate']): QualifiedVerificationReceipt {
  const { origin: _origin, ...bound } = request;
  const domainId = randomUUID();
  const profile = input.profile;
  if (!profile.buildProfileSha256) throw new Error('Missing build profile');
  const runtimeInputs = sha256('runtime inputs');
  const databaseEvidence = original.snapshot.reports[1].database;
  if (!databaseEvidence) throw new Error('Missing source database evidence');
  const imageDigest = 'sha256:' + sha256('OCI manifest');
  const configDigest = 'sha256:' + sha256('OCI config');
  const image: QualifiedStandardImageProof | undefined = profile.ociInputsSha256 && !regression ? {
    version: 1, status: 'scanned', ociInputsSha256: profile.ociInputsSha256, runtimeInputsSha256: runtimeInputs,
    platform: 'linux/amd64', manifestDigest: imageDigest, configDigest,
    baseManifestDigest: 'sha256:' + sha256('base'), appLayerDigest: 'sha256:' + sha256('app layer'),
    runtimeLayerSha256: sha256('runtime layer'), scan: {
      scanner: 'trivy', version: '0.76.2', imageDigest, configDigest, osPackages: 1, npmPackages: 1,
      findings: [{ class: 'lang-pkgs', advisory: 'FIXTURE-1', package: 'test-module', version: '1.2.3', severity: 'MEDIUM' }],
      policySha256: sha256('protected image scan'), reportSha256: sha256('image report'), database: databaseEvidence,
    },
    ...(profile.retainStandardImage ? { archive: { format: 'oci-layout-tar' as const, sha256: sha256('retained bytes'), bytes: 613 } } : {}),
  } : undefined;
  const target = candidate ? {
    manifestSha256: candidate.candidateManifestSha256, patchSha256: candidate.patchSha256,
    totalBytes: original.snapshot.totalBytes + candidate.changes.reduce((sum, change) => sum + change.afterBytes - change.beforeBytes, 0),
    reports: qualifiedScanReportsSchema.parse(original.snapshot.reports.map(report => ({
      ...report, snapshotSha256: candidate.candidateManifestSha256, findings: [],
    }))),
  } : null;
  const dist = { sha256: sha256('measured build'), files: 3, bytes: 220 };
  return {
    kind: 'verification_receipt', scope: bound, domainId, commitSha256: original.commitSha256, imageSha256,
    originSha256: original.originSha256, cleanupConfirmed: true, sessionVerified: true,
    snapshot: {
      ...original.snapshot, runId: domainId, inputsSha256: bound.scannerInputsSha256, target,
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
      expect(await view()).toMatchObject({ candidate: null, candidateTarget: null, availableTargets: [], actions: [] });
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
      candidate: null, candidateTarget: null, availableTargets: [{ ...display, revision: 1 }], actions: [] });
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
      candidate, candidateTarget: display, availableTargets: [], actions: ['confirm', 'reject'] });
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

async function queuedFormalRelease(options: { separateRequester?: boolean; expiring?: boolean } = {}) {
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
        const [stored] = await database.storage.db.select().from(inspectionAttempts);
        const original = qualifiedInspectionResponseSchema.parse(stored?.receipt);
        if (original.kind !== 'receipt') throw new Error('Missing verified original');
        const request = prepareQualifiedVerificationRequest(coordinates, canonicalVerificationCommand({ input, repair }));
        return standardVerificationReceipt(original, request, input, false);
      },
      verifyArchive: async archive => ({ kind: 'archive_verified', version: 1, runnerImageSha256: imageSha256, archive }),
    } },
  });
  try { expect(await worker.tick()).toBe(true); } finally { await worker.close(); }
  const application = await resources.createApplication(identity, task.projectId, { name: 'Claim sample' });
  const environment = await resources.createEnvironment(identity, task.projectId, { applicationId: application.id, name: 'Protected sample' });
  const target = { environmentId: environment.id, deploymentId: 'a'.repeat(24), serverId: 'b'.repeat(24),
    imageRepository: 'testing/standard', registryOrigin: releaseOrigin, runtimeConfigSha256: sha256('runtime configuration'),
    verificationProfileSha256: verificationProfileFingerprint(standardVerificationProfile), verificationMaxAgeSeconds: 60,
    rolloutCheckSha256: sha256('health verification'), recoveryPlanSha256: sha256('known release'),
  };
  await registerReleaseTarget(database.storage, target);
  const portal = 'itervane-claim-portal';
  const owner = await verifyIdentity(await issuer.token('owner', { azp: portal }));
  const service = new FormalReleaseService(database.storage, portal);
  const verified = await taskService.get(identity, task.id);
  expect(verified.state).toBe('waiting_input');
  if (options.expiring) {
    // An old outcome gives this newly frozen candidate only a few seconds of its real PostgreSQL TTL.
    await adjustFixtureVerification("UPDATE itervane.formal_verification_results SET created_at=clock_timestamp()-interval '55 seconds'");
  }
  const frozen = (await service.freeze(requester, task.id, { environmentId: environment.id, expectedVersion: verified.version }, 'zh-CN')).candidate;
  const approval = (await service.decide(owner, frozen.id, {
    action: 'confirm', fingerprint: frozen.fingerprint, expectedVersion: 0, idempotencyKey: randomUUID(),
  }, 'zh-CN')).candidate;
  if (!approval.operationId) throw new Error('Expected formal release operation');
  return { approval, operationId: approval.operationId, target, owner, service, taskService };
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
  ['worker origin', 'release_target_changed'],
  ['approver regrant', 'release_approval_invalid'],
  ['requester access', 'permission_revoked'],
  ['verification proof', 'release_evidence_changed'],
] as const)('blocks formal release when %s no longer matches the approval', async (change, reason) => {
  const { operationId, target, taskService } = await queuedFormalRelease({ separateRequester: change === 'requester access' });
  if (change === 'target revision') await registerReleaseTarget(database.storage, { ...target, rolloutCheckSha256: sha256('new check') });
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
