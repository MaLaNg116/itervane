import { and, desc, eq } from 'drizzle-orm';
import { operationsRestartResumes } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { DomainError } from '../service/errors.js';

export async function latestRestartResume(tx: Transaction, executionId: string) {
  const [resume] = await tx.select().from(operationsRestartResumes)
    .where(eq(operationsRestartResumes.executionId, executionId)).orderBy(desc(operationsRestartResumes.attempt)).limit(1);
  return resume;
}

export async function blockQueuedRestartResume(tx: Transaction, executionId: string) {
  const [blocked] = await tx.update(operationsRestartResumes).set({ state: 'blocked' })
    .where(and(eq(operationsRestartResumes.executionId, executionId), eq(operationsRestartResumes.state, 'queued'))).returning();
  if (!blocked) throw new DomainError('unsupported_state');
  return blocked;
}
