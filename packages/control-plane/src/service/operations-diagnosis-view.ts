import { agentText } from '@itervane/agent';
import { operationsDiagnosisReceiptSchema, type Locale, type OperationsObservationReceipt } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { eq } from 'drizzle-orm';
import { operationsDiagnosisReads, operationsDiagnosisResults, operationsDiagnosisRuntime, type taskEvents, type tasks } from '../persistence/schema.js';
import { readRecordedOperationsEvidence } from '../runtime/operations-evidence-store.js';
import type { Transaction } from './access.js';
import { readOperationsDiagnosis, type readOperationsRequest } from './operations-requests.js';

export async function readPublishedOperationsDiagnosis(tx: Transaction, task: typeof tasks.$inferSelect,
  request: Awaited<ReturnType<typeof readOperationsRequest>>, observation: OperationsObservationReceipt,
  event: typeof taskEvents.$inferSelect) {
  const { runId } = observation;
  const input = await readOperationsDiagnosis(tx, task, runId, request);
  const [recorded] = await tx.select({ row: operationsDiagnosisResults, pointer: operationsDiagnosisRuntime })
    .from(operationsDiagnosisResults).innerJoin(operationsDiagnosisRuntime, eq(operationsDiagnosisRuntime.runId, operationsDiagnosisResults.runId))
    .where(eq(operationsDiagnosisResults.runId, runId));
  const resultSha256 = event.detail.diagnosisSha256;
  if (!input && !recorded && resultSha256 === undefined) return undefined;
  if (!input || !recorded) throw new Error('operations_diagnosis_view_integrity');
  const { row, pointer } = recorded;
  const receipt = operationsDiagnosisReceiptSchema.parse(row.document);
  if (sha256(JSON.stringify(receipt)) !== row.sha256 || resultSha256 !== row.sha256 || event.workerId !== row.workerId
      || receipt.taskId !== task.id || receipt.runId !== runId || receipt.requestSha256 !== request.sha256
      || receipt.fence !== row.fence || receipt.fence !== observation.fence || receipt.observationSha256 !== event.detail.observationSha256
      || receipt.checkpointId !== row.checkpointId || receipt.checkpointId !== pointer.checkpointId || pointer.publishedFence > row.fence
      || receipt.inputSha256 !== input.sha256 || receipt.inputSha256 !== pointer.inputSha256 || receipt.providerSha256 !== input.providerSha256) {
    throw new Error('operations_diagnosis_view_integrity');
  }
  const rows = await tx.select().from(operationsDiagnosisReads).where(eq(operationsDiagnosisReads.runId, runId));
  if (rows.length !== receipt.reads.length) throw new Error('operations_diagnosis_view_evidence');
  const bySection = new Map(rows.map(evidence => [evidence.section, evidence]));
  const target = { ...request.document, whiskers: { serverId: observation.observation.serverId } };
  const facts = receipt.result.facts.map((fact, index) => {
    const stored = bySection.get(fact.section);
    const bound = receipt.reads[index];
    if (!stored || !bound || stored.operationId !== bound.operationId || stored.sha256 !== bound.readSha256
        || bound.operationId !== sha256(`${receipt.bindingSha256}:${index + 1}`)) throw new Error('operations_diagnosis_view_evidence');
    const data = readRecordedOperationsEvidence(stored, target);
    const evidenceId = sha256(JSON.stringify({ origin: 'formal_operations',
      bindingSha256: receipt.bindingSha256, snapshotSha256: request.sha256, data }));
    if (fact.evidenceId !== evidenceId || fact.proofSha256 !== data.proofSha256) throw new Error('operations_diagnosis_view_evidence');
    return { fact, data };
  });
  return { receipt, sha256: row.sha256, recordedAt: row.createdAt, facts };
}

export function presentOperationsDiagnosis(diagnosis: NonNullable<Awaited<ReturnType<typeof readPublishedOperationsDiagnosis>>>, locale: Locale) {
  const text = agentText(locale);
  const { hypotheses, recommendation, previousReleaseOperationId } = diagnosis.receipt.result;
  const facts = diagnosis.facts.map(({ fact, data }) => {
    if (data.section === 'release') return { ...fact, section: data.section, result: data.result };
    const { containerId: _container, serverId: _server, ...result } = data.result;
    return { ...fact, section: data.section, result };
  });
  return {
    receiptSha256: diagnosis.sha256, facts, previousReleaseOperationId,
    hypotheses: hypotheses.map(item => ({ ...item, message: text.operationsHypothesis[item.code] })),
    recommendation: { ...recommendation, message: text.operationsRecommendation[recommendation.code] },
  };
}
