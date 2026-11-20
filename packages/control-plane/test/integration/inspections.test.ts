import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { AgentEvidence } from '@itervane/agent';
import { formalAuditDtoSchema, formalAuditInputSchema, formalAuditResultSchema, formalRepairInputSchema,
  qualifiedInspectionResponseSchema, type QualifiedInspectionRequest } from '@itervane/contracts';
import type { ModelAdapter } from '@itervane/model';
import { scannerProfiles, sha256 } from '@itervane/runner';
import { createApi } from '../../src/api.js';
import { createIdentityVerifier, type VerifiedIdentity } from '../../src/auth/identity.js';
import { queueName } from '../../src/persistence/database.js';
import { formalAuditInputs, formalAuditResults, formalRepairInputs, inspectionAttempts } from '../../src/persistence/schema.js';
import { ExecutionCoordinator } from '../../src/runtime/coordinator.js';
import { configuredAuditModel } from '../../src/runtime/formal-audit.js';
import { ExecutionLost, type ExecutionScope } from '../../src/runtime/authority.js';
import { GuardedCheckpointer } from '../../src/runtime/checkpointer.js';
import { ToolGateway } from '../../src/runtime/tools.js';
import { DurableWorker } from '../../src/runtime/worker.js';
import type { InspectionRunner } from '../../src/runtime/source-inspection.js';
import { bootstrapOwner, ResourceService } from '../../src/service/resources.js';
import { InspectionService, prepareInspection } from '../../src/service/inspections.js';
import { prepareFormalAuditInput } from '../../src/service/formal-audit.js';
import { prepareFormalRepairInput } from '../../src/service/formal-repair.js';
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
  await expect(tasks.resume(identity, task.id, { expectedVersion: audited.version })).rejects.toMatchObject({ code: 'unsupported_state' });
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
  // Requeue the completed audit within this database fixture to exercise a new phase lease.
  await database.admin.query("UPDATE itervane.tasks SET state='queued' WHERE id=$1", [task.id]);
  await database.admin.query("UPDATE itervane.task_runs SET state='queued' WHERE task_id=$1", [task.id]);
  await coordinator.reconcile(randomUUID());
  const scope = await claim();
  const prepare = (execution = scope) => coordinator.withLease(execution, (tx, current) => prepareFormalRepairInput(tx, current.task, execution));
  const prepared = await prepare();
  expect(prepared).toEqual({ sha256: sealed!.sha256, document: formalRepairInputSchema.parse(sealed!.document) });
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
  await database.admin.query('TRUNCATE itervane.formal_repair_inputs');
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
