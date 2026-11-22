import { finishFormalOperations, type FormalOperationsReport } from '@itervane/agent';
import { operationsDiagnosisReceiptSchema } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { eq } from 'drizzle-orm';
import { operationsDiagnosisReads, operationsDiagnosisResults, operationsDiagnosisRuntime } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { ExecutionLost, type ExecutionScope, type TaskRow } from './authority.js';
import { readRecordedOperationsEvidence, type requireCurrentDiagnosis } from './operations-evidence-store.js';
import { OperationsExecutionError, prepareOperationsObservation, settleOperationsObservation } from './operations-execution.js';

type Diagnosis = Awaited<ReturnType<typeof requireCurrentDiagnosis>>;

export async function publishOperationsDiagnosis(tx: Transaction, task: TaskRow, scope: ExecutionScope,
  diagnosis: Diagnosis, report: FormalOperationsReport, signal: AbortSignal) {
  signal.throwIfAborted();
  const { runId, workerId, fence } = scope;
  const { input, request, target } = diagnosis;
  const [pointer] = await tx.select().from(operationsDiagnosisRuntime).where(eq(operationsDiagnosisRuntime.runId, runId));
  if (!pointer || pointer.inputSha256 !== input.sha256 || pointer.checkpointId !== report.checkpointId
      || report.runId !== runId || report.origin !== 'formal_operations' || report.role !== 'operations') throw new ExecutionLost();
  const result = report.formalOperations;
  if (report.status !== 'completed' || report.reason !== 'operations_review_complete' || !result) {
    throw new OperationsExecutionError('operations_review_required');
  }
  const rows = await tx.select().from(operationsDiagnosisReads).where(eq(operationsDiagnosisReads.runId, runId));
  if (rows.length !== report.evidence.length || rows.length !== report.trace.length) {
    throw new OperationsExecutionError('operations_invalid_observation');
  }
  const bySection = new Map(rows.map(row => [row.section, row]));
  const receipts = report.evidence.map(({ id, ...evidence }, index) => {
    const trace = report.trace[index];
    if (evidence.origin !== 'formal_operations' || evidence.bindingSha256 !== report.bindingSha256 || evidence.snapshotSha256 !== request.sha256
        || sha256(JSON.stringify(evidence)) !== id || trace?.evidenceId !== id || trace.role !== 'operations' || trace.tool !== 'read_operations'
        || trace.operationId !== sha256(`${report.bindingSha256}:${index + 1}`)) {
      throw new OperationsExecutionError('operations_invalid_observation');
    }
    const { data } = evidence;
    const row = bySection.get(data.section);
    if (!row?.sha256 || row.operationId !== trace.operationId
        || JSON.stringify(readRecordedOperationsEvidence(row, target)) !== JSON.stringify(data)) {
      throw new OperationsExecutionError('operations_invalid_observation');
    }
    return { data, read: { section: row.section, operationId: row.operationId, readSha256: row.sha256 } };
  });
  const { hypotheses, recommendation } = result;
  const checked = finishFormalOperations(report.evidence, { hypotheses, recommendation });
  const container = receipts.find(item => item.data.section === 'container')?.data;
  if (!container || container.section !== 'container' || JSON.stringify(checked) !== JSON.stringify(result)) {
    throw new OperationsExecutionError('operations_invalid_observation');
  }

  const observation = prepareOperationsObservation(scope, target.releaseOperationId, request.sha256, container.result);
  const { checkpointId } = pointer;
  const document = operationsDiagnosisReceiptSchema.parse({
    version: 1, taskId: task.id, runId, fence, checkpointId, inputSha256: input.sha256, requestSha256: request.sha256,
    bindingSha256: report.bindingSha256, providerSha256: input.providerSha256, observationSha256: observation.sha256,
    reads: receipts.map(item => item.read), usage: report.usage, result,
  });
  const diagnosisSha256 = sha256(JSON.stringify(document));
  await tx.insert(operationsDiagnosisResults).values({ runId, workerId, fence, checkpointId, document, sha256: diagnosisSha256 });
  await settleOperationsObservation(tx, task, observation, diagnosisSha256);
  signal.throwIfAborted();
}
