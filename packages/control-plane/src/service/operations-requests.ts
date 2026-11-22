import { operationsRequestBindingSchema } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { eq } from 'drizzle-orm';
import { operationsRequests, tasks } from '../persistence/schema.js';
import type { Transaction } from './access.js';
import { DomainError } from './errors.js';
import type { readOperationsObservationTarget } from './operations-targets.js';

export function freezeOperationsRequest(target: Awaited<ReturnType<typeof readOperationsObservationTarget>>) {
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
