import { and, eq, exists, notExists, sql } from 'drizzle-orm';
import type { Database } from '../persistence/database.js';
import { environments, operationsExecutionIntents, operationsExecutions, operationsProposals } from '../persistence/schema.js';
import { closeUndispatchedOperationsExecution } from '../runtime/operations-execution-queue.js';
import type { Transaction } from './access.js';
import { DomainError } from './errors.js';

export async function lockEnvironmentForEffect(tx: Transaction, environmentId: string) {
  const [environment] = await tx.select({ id: environments.id }).from(environments)
    .where(eq(environments.id, environmentId)).for('update');
  if (!environment) throw new DomainError('not_found');
}

// Call with the environment locked. A recorded send intent keeps the environment reserved.
export async function expireUndispatchedOperations(tx: Transaction, database: Database, environmentId: string, actorId: string, workerId?: string) {
  const [expired] = await tx.update(operationsExecutions).set({ state: 'blocked', blockedReason: 'proposal_expired', closedAt: sql`clock_timestamp()` })
    .where(and(eq(operationsExecutions.environmentId, environmentId), eq(operationsExecutions.state, 'reserved'),
      notExists(tx.select({ id: operationsExecutionIntents.executionId }).from(operationsExecutionIntents)
        .where(eq(operationsExecutionIntents.executionId, operationsExecutions.id))),
      exists(tx.select({ id: operationsProposals.id }).from(operationsProposals).where(and(
        eq(operationsProposals.id, operationsExecutions.proposalId), sql`${operationsProposals.validUntil} <= clock_timestamp()`,
      ))))).returning({ id: operationsExecutions.id });
  if (expired) await closeUndispatchedOperationsExecution(tx, database, expired.id, 'proposal_expired', actorId, workerId);
  return expired?.id;
}

export async function requireNoOperationsHold(tx: Transaction, database: Database, environmentId: string, actorId: string) {
  await expireUndispatchedOperations(tx, database, environmentId, actorId);
  const [hold] = await tx.select({ id: operationsExecutions.id }).from(operationsExecutions)
    .where(and(eq(operationsExecutions.environmentId, environmentId), eq(operationsExecutions.state, 'reserved'))).limit(1);
  if (hold) throw new DomainError('conflict');
}
