import { deepStrictEqual, equal, notEqual, ok, rejects } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Client } from '@modelcontextprotocol/client';
import { operationsProposalViewSchema, operationsRestartExecutionViewSchema, operationsRestartRecoveryProofSchema,
  operationsRestartSubmissionSchema, type Locale, type OperationsRestartBaseline, type ReleaseRolloutProof, type TaskDto } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { lockEnvironmentForEffect, requireNoOperationsHold } from '../../src/service/environment-effects.js';
import type { databaseFixture } from '../helpers/database.js';
import { awaitOperationsWorkerDisconnect, holdOperationsAcknowledgement } from './operations-acknowledgement-barrier.js';

export type DiagnosisHttp = (path: string, options?: { locale?: Locale; portal?: boolean; payload?: object; status?: number }) => Promise<unknown>;
export type DiagnosisReaders = {
  request: DiagnosisHttp; mcp: Client; withEnglishReader: <T>(read: (lookup: Client) => Promise<T>) => Promise<T>;
};
type RestartInterruption = { environmentId: string; stopWorker: () => Promise<void>; startWorker: () => Promise<void> };

type RestartProofInput = {
  db: Awaited<ReturnType<typeof databaseFixture>>; diagnosis: TaskDto; diagnosisSha256: string;
  released: ReleaseRolloutProof; request: DiagnosisHttp; mcp: Client;
  readStopped: () => Promise<OperationsRestartBaseline>; approve: () => Promise<void>; verifyAudit: () => Promise<void>;
};

export async function proveNativeRestart(input: RestartProofInput, interruption?: RestartInterruption) {
  const { db, diagnosis, diagnosisSha256, released, request, mcp, readStopped, approve, verifyAudit } = input;
  const baseline = await readStopped();
  equal(baseline.containerId, released.runtime.containerId);
  const diagnosisPath = `/v1/tasks/${diagnosis.id}`;
  const { proposal } = operationsProposalViewSchema.parse(await request(diagnosisPath + '/operations-proposal', {
    payload: { diagnosisSha256 }, status: 201,
  }));
  ok(proposal?.kind === 'restart' && proposal.status === 'pending');
  equal(proposal.current.operationId, released.operationId);
  equal(proposal.current.manifestDigest, released.manifestDigest);
  const executionPath = `/v1/operations/proposals/${proposal.id}/execution`;
  const payload = { fingerprint: proposal.fingerprint, decisionVersion: 1 };
  await request(executionPath, { portal: true, payload, status: 409 });
  const decisionPath = `/v1/operations/proposals/${proposal.id}/decisions`;
  const decision = operationsProposalViewSchema.parse(await request(decisionPath, { portal: true, payload: {
    action: 'confirm', expectedVersion: 0, fingerprint: proposal.fingerprint, idempotencyKey: randomUUID(),
  } }));
  equal(decision.proposal?.status, 'confirmed');
  const actorId = decision.proposal?.decisions.at(-1)?.actorId;
  ok(actorId);
  await request(executionPath, { payload, status: 403 });
  const queued = operationsRestartSubmissionSchema.parse(await request(executionPath, { portal: true, payload, status: 202 }));
  equal(queued.replayed, false);
  deepStrictEqual(await request(executionPath, { portal: true, payload, status: 200 }), { executionId: queued.executionId, replayed: true });

  const receiptPath = diagnosisPath + '/operations-execution';
  const waitFor = async (state: 'waiting_approval' | 'succeeded' | 'needs_human') => {
    const deadline = performance.now() + (interruption ? 60_000 : 40_000);
    while (performance.now() < deadline) {
      const view = operationsRestartExecutionViewSchema.parse(await request(receiptPath, { portal: true }));
      const receipt = view.execution;
      if (receipt?.state === state) return { view, receipt };
      if (receipt && ['failed', 'cancelled', 'needs_human'].includes(receipt.state)) throw new Error(receipt.reason);
      await delay(350);
    }
    throw new Error('native_restart_wait_' + state);
  };
  const waiting = await waitFor('waiting_approval');
  const bound = waiting.view.action;
  ok(bound?.kind === 'continue' && waiting.receipt.environmentHeld);
  equal(bound.executionId, queued.executionId);
  equal(bound.approvalId, waiting.receipt.nativeApprovalId);
  deepStrictEqual(await readStopped(), baseline);
  await approve();
  deepStrictEqual(await readStopped(), baseline);
  const { approvalId, callSha256, expectedVersion } = bound;
  const continuation = { approvalId, callSha256, expectedVersion, idempotencyKey: randomUUID() };
  const continuePath = `/v1/operations/executions/${queued.executionId}/continue`;
  await request(continuePath, { payload: continuation, status: 403 });
  const submit = async () => {
    deepStrictEqual(await request(continuePath, { portal: true, payload: continuation, status: 202 }), queued);
  };
  if (interruption) {
    const barrier = await holdOperationsAcknowledgement(db, 'restart', queued.executionId);
    try {
      await submit();
      const backend = await barrier.waitForWorker();
      await interruption.stopWorker();
      await barrier.release();
      await awaitOperationsWorkerDisconnect(db, backend);
    } finally { await barrier.close(); }
    const revoked = operationsProposalViewSchema.parse(await request(decisionPath, { portal: true, payload: {
      action: 'revoke', expectedVersion: 1, fingerprint: proposal.fingerprint, idempotencyKey: randomUUID(),
    } }));
    equal(revoked.proposal?.status, 'revoked');
    await request(continuePath, { portal: true, payload: continuation, status: 409 });
    await interruption.startWorker();
  } else {
    await submit();
    deepStrictEqual(await request(continuePath, { portal: true, payload: continuation, status: 200 }), { ...queued, replayed: true });
  }
  const recovered = await waitFor(interruption ? 'needs_human' : 'succeeded');
  equal(recovered.receipt.nativeApprovalId, approvalId);
  equal(recovered.receipt.environmentHeld, Boolean(interruption));
  equal(recovered.view.action, null);
  equal(recovered.receipt.recovery?.state, interruption ? 'manual_review' : 'verified');
  equal(recovered.receipt.recovery?.failure, interruption ? 'native_unconfirmed' : null);

  const { rows } = await db.admin.query<{ proof: unknown; digest: string; resumes: number; acknowledged: number; slot: string | null;
    send_fence: number; read_fence: number; sender: string; observer: string; send_state: string }>(`
    SELECT result.proof, result.proof_sha256 AS digest, sent.fence AS send_fence, result.fence AS read_fence,
      sent.worker_id AS sender, result.worker_id AS observer, sent.state AS send_state,
      (SELECT count(*)::int FROM itervane.operations_restart_resumes resume WHERE resume.execution_id=result.execution_id) AS resumes,
      (SELECT count(*)::int FROM itervane.operations_restart_resumes resume WHERE resume.execution_id=result.execution_id
        AND resume.approval_id=$2 AND resume.call_sha256=$3 AND resume.state='acknowledged') AS acknowledged,
      (SELECT task_id FROM itervane.execution_slot WHERE id=1) AS slot
    FROM itervane.operations_restart_recoveries result
    JOIN itervane.operations_restart_resumes sent ON sent.execution_id=result.execution_id AND sent.attempt=1
    WHERE result.execution_id=$1 AND result.state=$4`,
  [queued.executionId, approvalId, callSha256, interruption ? 'manual_review' : 'verified']);
  equal(rows.length, 1);
  const record = rows[0]!;
  equal(record.resumes, 1);
  equal(record.acknowledged, interruption ? 0 : 1);
  equal(record.send_state, interruption ? 'prepared' : 'acknowledged');
  ok(record.read_fence > record.send_fence);
  equal(record.slot, null);
  const proof = operationsRestartRecoveryProofSchema.parse(record.proof);
  equal(proof.executionId, queued.executionId);
  equal(proof.proposalFingerprint, proposal.fingerprint);
  equal(proof.releaseOperationId, released.operationId);
  equal(proof.runtimeBaselineSha256, sha256(JSON.stringify(baseline)));
  deepStrictEqual(proof.native, interruption ? null : { approvalId, attempt: 1 });
  equal(record.digest, sha256(JSON.stringify(proof)));
  equal(recovered.receipt.recovery?.proofSha256, record.digest);
  deepStrictEqual(proof.observation.runtime, released.runtime);
  ok(proof.observation.startedAt > baseline.startedAt);
  const inspected = (await mcp.callTool({ name: 'get_operations_execution', arguments: { taskId: diagnosis.id } })).structuredContent;
  deepStrictEqual(operationsRestartExecutionViewSchema.parse(inspected), recovered.view);
  await verifyAudit();
  if (interruption) {
    notEqual(record.observer, record.sender);
    await rejects(db.storage.db.transaction(async tx => {
      await lockEnvironmentForEffect(tx, interruption.environmentId);
      await requireNoOperationsHold(tx, db.storage, interruption.environmentId, actorId);
    }), { code: 'conflict' });
  }
  return { executionId: proof.executionId, releaseOperationId: proof.releaseOperationId, approvalId,
    proofSha256: record.digest, activeContainer: proof.observation.runtime.containerId, stoppedStart: baseline.startedAt,
    recoveredStart: proof.observation.startedAt, anonymousStatus: proof.observation.runtime.anonymousStatus,
    healthStatus: proof.observation.runtime.healthStatus, resumeCount: record.resumes, acknowledgedCount: record.acknowledged,
    environmentReleased: !recovered.receipt.environmentHeld, environmentHeld: recovered.receipt.environmentHeld,
    slotReleased: true, nativeAuditCount: interruption ? 2 : 1, blockedBeforeApproval: true, httpMcpAgreement: true,
    approvalRevoked: Boolean(interruption), publicationBlocked: Boolean(interruption), manualReason: recovered.receipt.recovery?.failure,
    sameWorker: record.sender === record.observer, sendFence: record.send_fence, readFence: record.read_fence };
}
