import { deepStrictEqual, equal, ok } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Client } from '@modelcontextprotocol/client';
import { operationsProposalViewSchema, operationsRestartExecutionViewSchema, operationsRestartRecoveryProofSchema,
  operationsRestartSubmissionSchema, type Locale, type OperationsRestartBaseline, type ReleaseRolloutProof, type TaskDto } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import type { databaseFixture } from '../helpers/database.js';

export type DiagnosisHttp = (path: string, options?: { locale?: Locale; portal?: boolean; payload?: object; status?: number }) => Promise<unknown>;

export async function proveNativeRestart(input: {
  db: Awaited<ReturnType<typeof databaseFixture>>; diagnosis: TaskDto; diagnosisSha256: string;
  released: ReleaseRolloutProof; request: DiagnosisHttp; mcp: Client;
  readStopped: () => Promise<OperationsRestartBaseline>; approve: () => Promise<void>; verifyAudit: () => Promise<void>;
}) {
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
  await request(executionPath, { payload, status: 403 });
  const queued = operationsRestartSubmissionSchema.parse(await request(executionPath, { portal: true, payload, status: 202 }));
  equal(queued.replayed, false);
  deepStrictEqual(await request(executionPath, { portal: true, payload, status: 200 }), { executionId: queued.executionId, replayed: true });

  const receiptPath = diagnosisPath + '/operations-execution';
  const waitFor = async (state: 'waiting_approval' | 'succeeded') => {
    const deadline = performance.now() + 40_000;
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
  deepStrictEqual(await request(continuePath, { portal: true, payload: continuation, status: 202 }), queued);
  deepStrictEqual(await request(continuePath, { portal: true, payload: continuation, status: 200 }), { ...queued, replayed: true });
  const recovered = await waitFor('succeeded');
  equal(recovered.receipt.nativeApprovalId, approvalId);
  equal(recovered.receipt.environmentHeld, false);
  equal(recovered.view.action, null);
  equal(recovered.receipt.recovery?.state, 'verified');

  const { rows } = await db.admin.query<{ proof: unknown; digest: string; resumes: number; acknowledged: number; slot: string | null }>(`
    SELECT result.proof, result.proof_sha256 AS digest,
      (SELECT count(*)::int FROM itervane.operations_restart_resumes resume WHERE resume.execution_id=result.execution_id) AS resumes,
      (SELECT count(*)::int FROM itervane.operations_restart_resumes resume WHERE resume.execution_id=result.execution_id
        AND resume.approval_id=$2 AND resume.call_sha256=$3 AND resume.state='acknowledged') AS acknowledged,
      (SELECT task_id FROM itervane.execution_slot WHERE id=1) AS slot
    FROM itervane.operations_restart_recoveries result WHERE result.execution_id=$1 AND result.state='verified'`,
  [queued.executionId, approvalId, callSha256]);
  equal(rows.length, 1);
  const record = rows[0]!;
  equal(record.resumes, 1);
  equal(record.acknowledged, 1);
  equal(record.slot, null);
  const proof = operationsRestartRecoveryProofSchema.parse(record.proof);
  equal(proof.executionId, queued.executionId);
  equal(proof.proposalFingerprint, proposal.fingerprint);
  equal(proof.releaseOperationId, released.operationId);
  equal(proof.runtimeBaselineSha256, sha256(JSON.stringify(baseline)));
  deepStrictEqual(proof.native, { approvalId, attempt: 1 });
  equal(record.digest, sha256(JSON.stringify(proof)));
  equal(recovered.receipt.recovery?.proofSha256, record.digest);
  deepStrictEqual(proof.observation.runtime, released.runtime);
  ok(proof.observation.startedAt > baseline.startedAt);
  const inspected = (await mcp.callTool({ name: 'get_operations_execution', arguments: { taskId: diagnosis.id } })).structuredContent;
  deepStrictEqual(operationsRestartExecutionViewSchema.parse(inspected), recovered.view);
  await verifyAudit();
  return { executionId: proof.executionId, releaseOperationId: proof.releaseOperationId, approvalId,
    proofSha256: record.digest, activeContainer: proof.observation.runtime.containerId, stoppedStart: baseline.startedAt,
    recoveredStart: proof.observation.startedAt, anonymousStatus: proof.observation.runtime.anonymousStatus,
    healthStatus: proof.observation.runtime.healthStatus, resumeCount: record.resumes, acknowledgedCount: record.acknowledged,
    environmentReleased: true, slotReleased: true, nativeAuditCount: 1, blockedBeforeApproval: true, httpMcpAgreement: true };
}
