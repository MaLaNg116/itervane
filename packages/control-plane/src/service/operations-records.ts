import { operationsObservationReceiptSchema } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, eq } from 'drizzle-orm';
import { operationsObservations, taskEvents, taskRuns, type tasks } from '../persistence/schema.js';
import type { Transaction } from './access.js';
import { DomainError } from './errors.js';
import { readPublishedOperationsDiagnosis } from './operations-diagnosis-view.js';
import { readOperationsRequest } from './operations-requests.js';

export async function readOperationsTaskRecord(tx: Transaction, task: typeof tasks.$inferSelect) {
  const [run] = await tx.select().from(taskRuns).where(and(eq(taskRuns.taskId, task.id), eq(taskRuns.generation, task.generation)));
  if (run?.role !== 'operations') throw new DomainError('not_found');
  if (run.state !== task.state) throw new Error('operations_view_run_integrity');
  const request = await readOperationsRequest(tx, task, run.id);
  const [event] = await tx.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.sequence, task.version)));
  if (event?.state !== task.state) throw new Error('operations_view_event_integrity');
  const [recorded] = await tx.select().from(operationsObservations).where(eq(operationsObservations.runId, run.id));
  if ((task.state === 'succeeded') !== Boolean(recorded)) throw new Error('operations_view_receipt_integrity');
  if (!recorded) return { run, request, event, observation: undefined, diagnosis: undefined };

  const receipt = operationsObservationReceiptSchema.parse(recorded.document);
  if (receipt.taskId !== task.id || receipt.runId !== run.id || receipt.releaseOperationId !== request.document.releaseOperationId
      || receipt.bindingSha256 !== request.sha256 || receipt.bindingSha256 !== recorded.bindingSha256
      || receipt.fence !== recorded.fence || receipt.observation.containerId !== request.document.containerId
      || sha256(JSON.stringify(receipt)) !== recorded.sha256 || event.type !== 'task.operations_observed'
      || event.workerId !== recorded.workerId || event.detail.observationSha256 !== recorded.sha256 || event.detail.fence !== recorded.fence) {
    throw new Error('operations_view_receipt_integrity');
  }
  return { run, request, event, observation: { receipt, sha256: recorded.sha256 },
    diagnosis: await readPublishedOperationsDiagnosis(tx, task, request, receipt, event) };
}
