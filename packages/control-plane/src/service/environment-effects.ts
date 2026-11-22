import { and, eq, exists, sql } from 'drizzle-orm';
import { environments, operationsExecutions, operationsProposals } from '../persistence/schema.js';
import type { Transaction } from './access.js';
import { DomainError } from './errors.js';

export async function lockEnvironmentForEffect(tx: Transaction, environmentId: string) {
  const [environment] = await tx.select({ id: environments.id }).from(environments)
    .where(eq(environments.id, environmentId)).for('update');
  if (!environment) throw new DomainError('not_found');
}

// Call with the environment locked. Only reservations that have not been dispatched can expire here.
export async function requireNoOperationsHold(tx: Transaction, environmentId: string) {
  await tx.update(operationsExecutions).set({ state: 'blocked', blockedReason: 'proposal_expired', closedAt: sql`clock_timestamp()` })
    .where(and(eq(operationsExecutions.environmentId, environmentId), eq(operationsExecutions.state, 'reserved'),
      exists(tx.select({ id: operationsProposals.id }).from(operationsProposals).where(and(
        eq(operationsProposals.id, operationsExecutions.proposalId), sql`${operationsProposals.validUntil} <= clock_timestamp()`,
      )))));
  const [hold] = await tx.select({ id: operationsExecutions.id }).from(operationsExecutions)
    .where(and(eq(operationsExecutions.environmentId, environmentId), eq(operationsExecutions.state, 'reserved'))).limit(1);
  if (hold) throw new DomainError('conflict');
}
