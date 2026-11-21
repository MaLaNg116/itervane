import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { AgentEvidence } from '@itervane/agent';
import { formalAuditDtoSchema, formalAuditInputSchema, formalAuditResultSchema, formalRepairDtoSchema, formalRepairInputSchema, formalRepairPatchDtoSchema,
  qualifiedInspectionResponseSchema, qualifiedRepairObservationRequestSchema, qualifiedRepairRequestSchema, type QualifiedInspectionReceipt,
  type QualifiedInspectionRequest, type QualifiedRepairObservationReceipt, type QualifiedRepairReceipt, type RepairPatch } from '@itervane/contracts';
import type { ModelAdapter } from '@itervane/model';
import { canonicalRepairCommand, canonicalRepairObservation, scannerProfiles, sha256 } from '@itervane/runner';
import { createApi } from '../../src/api.js';
import { createIdentityVerifier, type VerifiedIdentity } from '../../src/auth/identity.js';
import { queueName } from '../../src/persistence/database.js';
import { formalAuditInputs, formalAuditResults, formalRepairAttempts, formalRepairInputs, formalRepairOperations, formalRepairResults, formalRepairRuntime,
  inspectionAttempts } from '../../src/persistence/schema.js';
import { ExecutionCoordinator } from '../../src/runtime/coordinator.js';
import { configuredAuditModel, runFormalAudit } from '../../src/runtime/formal-audit.js';
import { runFormalRepair } from '../../src/runtime/formal-repair.js';
import { ExecutionLost, type ExecutionScope } from '../../src/runtime/authority.js';
import { GuardedCheckpointer } from '../../src/runtime/checkpointer.js';
import { FormalRepairExecution, type RepairRunner } from '../../src/runtime/repair-execution.js';
import { observeFormalRepairTargets, type RepairObservationRunner } from '../../src/runtime/repair-observation.js';
import { ToolGateway } from '../../src/runtime/tools.js';
import { DurableWorker } from '../../src/runtime/worker.js';
import type { InspectionRunner } from '../../src/runtime/source-inspection.js';
import { bootstrapOwner, ResourceService } from '../../src/service/resources.js';
import { InspectionService, prepareInspection } from '../../src/service/inspections.js';
import { prepareFormalAuditInput } from '../../src/service/formal-audit.js';
import { prepareFormalRepairInput } from '../../src/service/formal-repair.js';
import { publishFormalRepair } from '../../src/service/repair-result.js';
import { TaskService } from '../../src/service/tasks.js';
import { databaseFixture } from '../helpers/database.js';
import { identityFixture } from '../helpers/identity.js';
import { auditFixtureKey, auditFixtureModel, auditProtocolFixture } from '../native/audit-provider.js';

let database: Awaited<ReturnType<typeof databaseFixture>>; let issuer: Awaited<ReturnType<typeof identityFixture>>;
let identity: VerifiedIdentity; let coordinator: ExecutionCoordinator; let task: Awaited<ReturnType<TaskService['admit']>>['task'];
const origin = 'https://example.invalid/inspection.git';
const imageSha256 = 'a'.repeat(64);
const workspaceSha256 = 'd'.repeat(64);
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

function testReceipt(request: QualifiedInspectionRequest, partial = false, findingPath?: string) {
  const { origin, ...scope } = request;
  const domainId = randomUUID();
  const manifestSha256 = 'b'.repeat(64);
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
        }] : [],
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
  // Establish the repair phase lease in this fixture while the application handoff is in development.
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
  workspace: Parameters<RepairRunner['repair']>[1], patch: RepairPatch, original: string): QualifiedRepairReceipt {
  const command = canonicalRepairCommand(workspace, patch);
  const { origin: registered, ...scope } = qualifiedRepairRequestSchema.parse({ ...request, operation: 'apply_repair',
    commandSha256: sha256(command.bytes), commandBytes: command.bytes.length });
  const domainId = randomUUID();
  const file = patch.files[0]!;
  const edit = file.edits[0]!;
  const bytes = Buffer.from(original);
  const modified = Buffer.concat([bytes.subarray(0, edit.startByte), Buffer.from(edit.replacement), bytes.subarray(edit.endByte)]);
  return {
    kind: 'repair_receipt', scope, domainId, imageSha256, originSha256: sha256(registered), commitSha256: scan.commitSha256,
    cleanupConfirmed: true, sessionVerified: true,
    snapshot: {
      runId: domainId, repositoryId: scope.repositoryId, commit: scope.commit, tree: scan.snapshot.tree, files: scan.snapshot.files,
      manifestSha256: scope.baseSnapshotSha256, commandSha256: scope.commandSha256, readOnly: true, offline: true,
      candidate: { version: 1, operationId: scope.operationId, repairInputSha256: scope.repairInputSha256,
        baseSnapshotSha256: scope.baseSnapshotSha256, workspaceSha256: command.workspaceSha256, patchSha256: command.patchSha256,
        candidateManifestSha256: sha256(Buffer.concat([modified, Buffer.from(' candidate')])),
        changes: [{ path: file.path, beforeSha256: file.beforeSha256, afterSha256: sha256(modified), beforeBytes: Buffer.byteLength(original),
          afterBytes: Buffer.byteLength(modified), edits: file.edits.length }] },
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

it.each(['continuous', 'reclaimed', 'existing audit'] as const)('continues a sealed audit into a repair candidate through the ordinary queue (%s)', async mode => {
  const prefix = 'header=fixture\nkeep=on\n';
  const line = 'REMOVE=public\n';
  const original = prefix + line;
  const range = { startByte: Buffer.byteLength(prefix), endByte: Buffer.byteLength(original), sha256: sha256(line) };
  let scan: QualifiedInspectionReceipt | undefined;
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
    return repairReceipt(scan!, request, workspace, patch, original);
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
    const repairing = context?.kind === 'user' && JSON.parse(context.text).role === 'repair';
    return (repairing ? completeRepair : completeAudit)(request);
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
      await database.admin.query('TRUNCATE itervane.formal_repair_results, itervane.formal_repair_attempts, itervane.formal_repair_operations, itervane.formal_repair_runtime, itervane.formal_repair_inputs');
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
  expect(result!.finalizedFence).toBe(audit!.finalizedFence + (mode === 'continuous' ? 0 : mode === 'reclaimed' ? 1 : 2));
  expect(events.at(-1)).toMatchObject({ type: 'task.repair_recorded', reason: 'repair_ready',
    reasonMessage: '修复候选已就绪，等待独立复验。',
  });
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
});

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
      expect(await tasks.get(identity, task.id)).toMatchObject({ state: 'waiting_input' });
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
  await database.admin.query('TRUNCATE itervane.formal_repair_results, itervane.formal_repair_attempts, itervane.formal_repair_operations, itervane.formal_repair_runtime, itervane.formal_repair_inputs');
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
