import { deepStrictEqual, equal, notEqual, ok, rejects } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  operationsProposalViewSchema, operationsRestoreExecutionViewSchema, operationsRestoreRecoveryProofSchema,
  operationsRestorePlanSchema, operationsSubmissionSchema, releaseKomodoConfigurationSchema, releaseKomodoUpdateSchema,
  type OperationsRestoreExecutionView, type ReleaseRolloutProof, type TaskDto,
} from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { lockEnvironmentForEffect, requireNoOperationsHold } from '../../src/service/environment-effects.js';
import type { databaseFixture } from '../helpers/database.js';
import { awaitOperationsWorkerDisconnect, holdOperationsAcknowledgement } from './operations-acknowledgement-barrier.js';
import type { DiagnosisReaders } from './restart-proof.js';

type PublishedInstance = Pick<ReleaseRolloutProof, 'operationId' | 'manifestDigest' | 'runtime' | 'update'>;
type NativeRestoreInput = DiagnosisReaders & {
  db: Awaited<ReturnType<typeof databaseFixture>>;
  diagnosis: TaskDto;
  diagnosisSha256: string;
  current: PublishedInstance;
  previous: PublishedInstance;
  startWorker: () => Promise<void>;
};
type Receipt = NonNullable<OperationsRestoreExecutionView['execution']>;
const receiptPath = (diagnosis: TaskDto) => `/v1/tasks/${diagnosis.id}/operations-restore`;
const summary = (release: PublishedInstance) => ({ operationId: release.operationId, manifestDigest: release.manifestDigest });

async function submitRestore({ db, diagnosis, diagnosisSha256, current, previous, request }: NativeRestoreInput) {
  const taskPath = `/v1/tasks/${diagnosis.id}`;
  const resultPath = receiptPath(diagnosis);
  const { proposal } = operationsProposalViewSchema.parse(await request(taskPath + '/operations-proposal', {
    payload: { diagnosisSha256 }, status: 201,
  }));
  ok(proposal?.kind === 'rollback' && proposal.status === 'pending');
  deepStrictEqual(proposal.current, summary(current));
  deepStrictEqual(proposal.restore, summary(previous));
  const proposalPath = `/v1/operations/proposals/${proposal.id}`;
  const payload = { fingerprint: proposal.fingerprint, decisionVersion: 1 };
  await request(proposalPath + '/restore', { portal: true, payload, status: 409 });
  const before = operationsRestoreExecutionViewSchema.parse(await request(resultPath, { portal: true }));
  equal(before.action, null);
  equal(before.execution, null);
  const { rowCount: beforeApproval } = await db.admin.query('SELECT id FROM itervane.operations_executions WHERE proposal_id=$1', [proposal.id]);
  equal(beforeApproval, 0);

  const decided = operationsProposalViewSchema.parse(await request(proposalPath + '/decisions', { portal: true, payload: {
    action: 'confirm', expectedVersion: 0, fingerprint: proposal.fingerprint, idempotencyKey: randomUUID(),
  } }));
  ok(decided.proposal?.status === 'confirmed');
  const approvedBy = decided.proposal.decisions[0]?.actorId;
  ok(approvedBy);
  deepStrictEqual(operationsRestoreExecutionViewSchema.parse(await request(resultPath, { portal: true })).action, {
    kind: 'enqueue', proposalId: proposal.id, ...payload,
  });
  await request(proposalPath + '/restore', { payload, status: 403 });
  equal(operationsRestoreExecutionViewSchema.parse(await request(resultPath)).action, null);
  const submitted = operationsSubmissionSchema.parse(await request(proposalPath + '/restore', { portal: true, payload, status: 202 }));
  equal(submitted.replayed, false);
  const { executionId } = submitted;
  deepStrictEqual(await request(proposalPath + '/restore', { portal: true, payload, status: 200 }), { executionId, replayed: true });
  const queued = operationsRestoreExecutionViewSchema.parse(await request(resultPath, { portal: true }));
  equal(queued.execution?.id, executionId);
  equal(queued.execution?.state, 'queued');
  equal(queued.execution?.environmentHeld, true);
  equal(queued.execution?.nativeUpdateId, null);
  return { executionId, approvedBy };
}

async function waitForRestore({ diagnosis, request }: NativeRestoreInput, executionId: string, expected: 'succeeded' | 'needs_human') {
  const deadline = performance.now() + 90_000;
  while (performance.now() < deadline) {
    const view = operationsRestoreExecutionViewSchema.parse(await request(receiptPath(diagnosis), { portal: true }));
    const receipt = view.execution;
    ok(receipt?.id === executionId);
    if (receipt.state === expected) return { ...view, execution: receipt };
    if (['succeeded', 'needs_human', 'failed', 'cancelled'].includes(receipt.state)) {
      throw new Error(`restore_fixture_${receipt.reason}_${receipt.recovery?.failure ?? 'no_receipt'}`);
    }
    await delay(350);
  }
  throw new Error(`native_restore_wait_${expected}`);
}

async function compareLocalizedReceipts({ diagnosis, request, mcp, withEnglishReader }: NativeRestoreInput,
  view: OperationsRestoreExecutionView & { execution: Receipt }) {
  deepStrictEqual(operationsRestoreExecutionViewSchema.parse((await mcp.callTool({
    name: 'get_operations_restore', arguments: { taskId: diagnosis.id },
  })).structuredContent), view);
  const english = operationsRestoreExecutionViewSchema.parse(await request(receiptPath(diagnosis), { locale: 'en' }));
  await withEnglishReader(async client => {
    deepStrictEqual(operationsRestoreExecutionViewSchema.parse((await client.callTool({
      name: 'get_operations_restore', arguments: { taskId: diagnosis.id },
    })).structuredContent), english);
  });
  equal(view.locale, 'zh-CN');
  equal(english.locale, 'en');
  ok(english.execution);
  notEqual(english.execution.message, view.execution.message);
  deepStrictEqual(english.execution.recovery, view.execution.recovery);
}

export async function proveNativeRestore(input: NativeRestoreInput) {
  const { db, current, previous, startWorker } = input;
  const { executionId, approvedBy } = await submitRestore(input);
  await startWorker();
  const verified = await waitForRestore(input, executionId, 'succeeded');
  const { execution } = verified;
  equal(verified.action, null);
  equal(execution.environmentHeld, false);
  equal(execution.releaseOperationId, current.operationId);
  deepStrictEqual(execution.restore, summary(previous));
  equal(execution.recovery?.state, 'verified');
  const { rows: records } = await db.admin.query<{
    proof: unknown; proof_sha256: string; completed_at: Date; state: string; wakeup_job_id: string | null; slot_task: string | null;
    plan: unknown; plan_sha256: string;
  }>(`
    SELECT recovery.proof, recovery.proof_sha256, recovery.completed_at, effect.state, schedule.wakeup_job_id,
      intent.restore_plan AS plan, intent.restore_plan_sha256 AS plan_sha256,
      (SELECT task_id FROM itervane.execution_slot WHERE id=1) AS slot_task
    FROM itervane.operations_restore_recoveries recovery
    JOIN itervane.operations_executions effect ON effect.id=recovery.execution_id
    JOIN itervane.operations_execution_schedules schedule ON schedule.execution_id=effect.id
    JOIN itervane.operations_execution_intents intent ON intent.execution_id=effect.id
    WHERE effect.id=$1 AND recovery.state='verified'`, [executionId]);
  equal(records.length, 1);
  const record = records[0]!;
  equal(record.state, 'recovered');
  equal(record.wakeup_job_id, null);
  equal(record.slot_task, null);
  const proof = operationsRestoreRecoveryProofSchema.parse(record.proof);
  const plan = operationsRestorePlanSchema.parse(record.plan);
  equal(proof.executionId, executionId);
  equal(proof.restoreOperationId, previous.operationId);
  equal(proof.planSha256, record.plan_sha256);
  equal(proof.planSha256, sha256(JSON.stringify(plan)));
  equal(plan.current.operationId, current.operationId);
  equal(plan.current.containerId, current.runtime.containerId);
  equal(plan.current.configDigest, current.runtime.configDigest);
  equal(plan.restore.manifestDigest, previous.manifestDigest);
  equal(plan.restore.publishedVersion, previous.runtime.version);
  equal(proof.runtime.imageReference, previous.runtime.imageReference);
  equal(proof.runtime.configDigest, previous.runtime.configDigest);
  equal(proof.runtime.version, previous.runtime.version);
  equal(proof.runtime.healthStatus, 200);
  ok(proof.runtime.anonymousStatus === 401 || proof.runtime.anonymousStatus === 403);
  notEqual(proof.runtime.containerId, current.runtime.containerId);
  const { updateId, deploymentId, actorId } = proof.update;
  notEqual(updateId, previous.update.updateId);
  notEqual(updateId, current.update.updateId);
  equal(updateId, execution.nativeUpdateId);
  equal(deploymentId, previous.update.deploymentId);
  equal(actorId, previous.update.actorId);
  equal(record.proof_sha256, sha256(JSON.stringify(proof)));
  deepStrictEqual(execution.recovery?.proof, { proofSha256: record.proof_sha256, version: previous.runtime.version,
    verifiedAt: record.completed_at.toISOString() });

  const { rows: sent } = await db.admin.query<{ kind: string; receipt: unknown; fence: number; plan_sha256: string; recorded_at: Date }>(
    'SELECT kind, receipt, fence, plan_sha256, recorded_at FROM itervane.operations_restore_steps WHERE execution_id=$1 ORDER BY kind', [executionId]);
  deepStrictEqual(sent.map(item => item.kind), ['configure', 'deploy']);
  const [configured, deployed] = [sent[0]!, sent[1]!];
  ok(sent.every(item => item.plan_sha256 === proof.planSha256 && item.recorded_at instanceof Date));
  equal(configured.fence, deployed.fence);
  ok(proof.fence > deployed.fence);
  equal(releaseKomodoConfigurationSchema.parse(configured.receipt).imageReference, previous.runtime.imageReference);
  equal(releaseKomodoUpdateSchema.parse(deployed.receipt).updateId, updateId);

  await compareLocalizedReceipts(input, verified);
  return { proof, report: { executionId, approvedBy, updateId, proofSha256: record.proof_sha256,
    currentOperationId: current.operationId, restoredOperationId: previous.operationId, restoredVersion: proof.runtime.version,
    restoredManifestDigest: previous.manifestDigest, restoredConfigDigest: proof.runtime.configDigest,
    stoppedContainerId: current.runtime.containerId, restoredContainerId: proof.runtime.containerId, sendFence: deployed.fence, readFence: proof.fence,
    healthStatus: proof.runtime.healthStatus, anonymousStatus: proof.runtime.anonymousStatus,
    blockedBeforeApproval: true, portalIdentityRequired: true, idempotent: true, environmentReleased: true, slotReleased: true,
    configureReceipts: 1, deployReceipts: 1, httpMcpAgreement: true } };
}

type NativeRestoreInterruption = NativeRestoreInput & {
  environmentId: string;
  stopSender: () => Promise<void>;
  observeApplied: () => Promise<{ containerId: string; configDigest: string; reference: string }>;
};

export async function proveInterruptedNativeRestore(input: NativeRestoreInterruption) {
  const { db, current, previous, environmentId, startWorker, stopSender, observeApplied } = input;
  const { executionId, approvedBy } = await submitRestore(input);
  const acknowledgement = await holdOperationsAcknowledgement(db, 'restore', executionId);
  let applied: Awaited<ReturnType<typeof observeApplied>>;
  try {
    await startWorker();
    const backend = await acknowledgement.waitForWorker();
    applied = await observeApplied();
    notEqual(applied.containerId, current.runtime.containerId);
    equal(applied.reference, previous.runtime.imageReference);
    equal(applied.configDigest, previous.runtime.configDigest);
    await stopSender();
    await acknowledgement.release();
    await awaitOperationsWorkerDisconnect(db, backend);
  } finally { await acknowledgement.close(); }

  await startWorker();
  const view = await waitForRestore(input, executionId, 'needs_human');
  equal(view.action, null);
  equal(view.execution.environmentHeld, true);
  equal(view.execution.nativeUpdateId, null);
  equal(view.execution.releaseOperationId, current.operationId);
  deepStrictEqual(view.execution.restore, summary(previous));
  deepStrictEqual(view.execution.recovery, { state: 'manual_review', failure: 'missing_update', proof: null });
  const { rows } = await db.admin.query<{
    sender: string; observer: string; send_fence: number; read_fence: number; missing: boolean;
    state: string; wakeup_job_id: string | null; slot_task: string | null; configuration: unknown; sends: number;
  }>(`
    SELECT sent.worker_id AS sender, recovery.worker_id AS observer, sent.fence AS send_fence, recovery.fence AS read_fence,
      (sent.receipt IS NULL AND sent.recorded_at IS NULL) AS missing, effect.state, schedule.wakeup_job_id,
      configuration.receipt AS configuration,
      (SELECT count(*)::int FROM itervane.operations_restore_steps WHERE execution_id=effect.id) AS sends,
      (SELECT task_id FROM itervane.execution_slot WHERE id=1) AS slot_task
    FROM itervane.operations_restore_recoveries recovery
    JOIN itervane.operations_executions effect ON effect.id=recovery.execution_id
    JOIN itervane.operations_execution_schedules schedule ON schedule.execution_id=effect.id
    JOIN itervane.operations_restore_steps sent ON sent.execution_id=effect.id AND sent.kind='deploy'
    JOIN itervane.operations_restore_steps configuration ON configuration.execution_id=effect.id AND configuration.kind='configure'
    WHERE effect.id=$1 AND recovery.state='manual_review'`, [executionId]);
  equal(rows.length, 1);
  const record = rows[0]!;
  equal(record.state, 'reserved');
  equal(record.wakeup_job_id, null);
  equal(record.slot_task, null);
  equal(record.sends, 2);
  equal(record.missing, true);
  notEqual(record.sender, record.observer);
  ok(record.read_fence > record.send_fence);
  equal(releaseKomodoConfigurationSchema.parse(record.configuration).imageReference, applied.reference);
  deepStrictEqual(await observeApplied(), applied);
  await rejects(db.storage.db.transaction(async tx => {
    await lockEnvironmentForEffect(tx, environmentId);
    await requireNoOperationsHold(tx, db.storage, environmentId, approvedBy);
  }), { code: 'conflict' });
  await compareLocalizedReceipts(input, view);
  return { executionId, currentOperationId: current.operationId, attemptedOperationId: previous.operationId,
    observedContainerId: applied.containerId, observedConfigDigest: applied.configDigest,
    sendFence: record.send_fence, readFence: record.read_fence, sendSteps: record.sends,
    reason: 'missing_update', acknowledgementMissing: true, changedWorker: true, matchingRuntimeBeforeAndAfter: true,
    environmentHeld: view.execution.environmentHeld, publicationBlocked: true, slotReleased: true, httpMcpAgreement: true };
}
