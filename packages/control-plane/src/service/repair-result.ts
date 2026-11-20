import type { FormalRepairReport } from '@itervane/agent';
import { formalRepairResultSchema, qualifiedRepairResponseSchema, type FormalRepairResult } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, eq } from 'drizzle-orm';
import { formalRepairAttempts, formalRepairOperations, formalRepairResults, formalRepairRuntime, runRuntime } from '../persistence/schema.js';
import { appendEvent, clearSlot, type ExecutionScope, type TaskRow } from '../runtime/authority.js';
import type { Transaction } from './access.js';
import { DomainError } from './errors.js';
import { prepareFormalRepairInput } from './formal-repair.js';

async function recordedCandidate(tx: Transaction, runId: string, inputSha256: string, report: FormalRepairReport) {
  const selection = report.formalRepair;
  if (!selection) throw new Error('formal_repair_candidate_missing');
  const entry = report.evidence.find(evidence => evidence.id === selection.evidenceId);
  const data = entry?.data;
  if (data?.kind !== 'repair_candidate' || data.receiptSha256 !== selection.receiptSha256
      || data.candidate.operationId !== selection.operationId || data.candidate.candidateManifestSha256 !== selection.candidateManifestSha256) {
    throw new Error('formal_repair_candidate_evidence');
  }
  const [stored] = await tx.select({ operation: formalRepairOperations, attempt: formalRepairAttempts })
    .from(formalRepairOperations).innerJoin(formalRepairAttempts, eq(formalRepairAttempts.operationId, formalRepairOperations.operationId))
    .where(and(eq(formalRepairOperations.runId, runId), eq(formalRepairOperations.operationId, selection.operationId),
      eq(formalRepairAttempts.state, 'recorded')));
  const receipt = qualifiedRepairResponseSchema.safeParse(stored?.attempt.receipt).data;
  if (!stored || receipt?.kind !== 'repair_receipt' || stored.operation.inputSha256 !== inputSha256
      || stored.attempt.receiptSha256 !== selection.receiptSha256 || sha256(JSON.stringify(receipt)) !== selection.receiptSha256
      || JSON.stringify(receipt.snapshot.candidate) !== JSON.stringify(data.candidate)
      || !report.trace.some(item => item.evidenceId === selection.evidenceId && item.tool === data.action
        && item.operationId === stored.operation.callKeySha256)) throw new Error('formal_repair_recorded_receipt_binding');
  const { operationId, patchSha256, candidateManifestSha256, changes } = receipt.snapshot.candidate;
  return { requestId: stored.attempt.requestId, candidate: { summary: selection.summary, evidenceId: selection.evidenceId, operationId,
    receiptSha256: selection.receiptSha256, patchSha256, manifestSha256: candidateManifestSha256, changes,
  } };
}

export async function publishFormalRepair(tx: Transaction, task: TaskRow, scope: ExecutionScope, report: FormalRepairReport,
  provider: FormalRepairResult['provider'], signal: AbortSignal) {
  signal.throwIfAborted();
  const input = await prepareFormalRepairInput(tx, task, scope);
  const [pointer] = await tx.select().from(formalRepairRuntime).where(eq(formalRepairRuntime.runId, scope.runId));
  if (!pointer || pointer.checkpointId !== report.checkpointId || pointer.inputSha256 !== input.sha256
      || report.runId !== scope.runId || report.origin !== 'formal_repair' || report.role !== 'repair'
      || (report.status !== 'completed' && report.status !== 'requires_human')) throw new DomainError('unavailable');
  const result = report.status === 'completed' ? await recordedCandidate(tx, scope.runId, input.sha256, report) : null;
  const document = formalRepairResultSchema.parse({
    version: 1, taskId: task.id, runId: scope.runId, projectId: task.projectId, generation: scope.generation, locale: task.locale,
    inputSha256: input.sha256, checkpointId: pointer.checkpointId, auditResultSha256: input.document.audit.resultSha256,
    baseSnapshotSha256: input.document.inspection.snapshotSha256, provider, releaseEligible: report.releaseEligible, usage: report.usage,
    status: result ? 'candidate_ready' : 'requires_human', reason: report.reason, candidate: result?.candidate ?? null,
  });
  const hash = sha256(JSON.stringify(document));
  await tx.insert(formalRepairResults).values({ runId: scope.runId, inputSha256: input.sha256, checkpointId: pointer.checkpointId,
    requestId: result?.requestId ?? null, finalizedFence: scope.fence, workerId: scope.workerId, sha256: hash, document });
  const reason = result ? 'repair_ready' : document.reason === 'repair_reconciling' ? 'repair_reconciling' : 'repair_needs_human';
  await tx.update(runRuntime).set({ reason, resumePending: false, waitingForTaskId: null }).where(eq(runRuntime.runId, scope.runId));
  await appendEvent(tx, task, 'task.repair_recorded', result ? 'waiting_input' : 'needs_human', {
    workerId: scope.workerId, reason, repair: { runId: scope.runId, repairResultSha256: hash },
  });
  await clearSlot(tx);
  signal.throwIfAborted();
  return { document, sha256: hash };
}
