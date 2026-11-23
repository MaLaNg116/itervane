import { operationsDiagnosisInputSchema, operationsRequestBindingSchema, type OperationsRequestBinding } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { eq } from 'drizzle-orm';
import { operationsDiagnosisInputs, operationsRequests, tasks } from '../persistence/schema.js';
import type { Transaction } from './access.js';
import { DomainError } from './errors.js';

export function freezeOperationsRequest(target: Omit<OperationsRequestBinding, 'version'>) {
  const document = operationsRequestBindingSchema.strip().parse({ ...target, version: 1 });
  return { document, sha256: sha256(JSON.stringify(document)) };
}

export async function readOperationsRequest(tx: Transaction, task: typeof tasks.$inferSelect, runId: string) {
  const [row] = await tx.select().from(operationsRequests).where(eq(operationsRequests.runId, runId)).for('share');
  if (!row) throw new DomainError('unsupported_state');
  const parsed = operationsRequestBindingSchema.safeParse(row.document);
  if (!parsed.success) throw new DomainError('unsupported_state');
  const document = parsed.data;
  if (row.taskId !== task.id || row.projectId !== task.projectId || document.projectId !== task.projectId
      || document.applicationId !== row.applicationId || document.environmentId !== row.environmentId
      || document.releaseOperationId !== row.releaseOperationId || document.source.repositoryId !== task.repositoryId
      || document.source.commit !== task.commit || document.dataClass !== task.dataClass || sha256(JSON.stringify(document)) !== row.sha256) {
    throw new DomainError('unsupported_state');
  }
  return { document, sha256: row.sha256 };
}

type Task = typeof tasks.$inferSelect;
type Request = Awaited<ReturnType<typeof readOperationsRequest>>;

export function freezeOperationsDiagnosis(task: Task, runId: string, request: Request) {
  const document = operationsDiagnosisInputSchema.safeParse({
    version: 1, taskId: task.id, runId, generation: task.generation, locale: task.locale,
    requestSha256: request.sha256, request: request.document,
  });
  if (!document.success) throw new DomainError('unsupported_state');
  return { document: document.data, sha256: sha256(JSON.stringify(document.data)) };
}

export async function readOperationsDiagnosis(tx: Transaction, task: Task, runId: string, request: Request) {
  const [row] = await tx.select().from(operationsDiagnosisInputs).where(eq(operationsDiagnosisInputs.runId, runId)).for('share');
  if (!row) return undefined;
  const result = freezeOperationsDiagnosis(task, runId, request);
  if (row.inputSha256 !== result.sha256) throw new DomainError('unsupported_state');
  return { ...result, providerSha256: row.providerSha256 };
}
