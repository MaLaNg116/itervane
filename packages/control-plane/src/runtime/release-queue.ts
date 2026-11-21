import { randomUUID } from 'node:crypto';
import { releaseWakeupSchema } from '@itervane/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { fromDrizzle } from 'pg-boss';
import { formalReleaseQueue, releaseFixtureQueue, type Database } from '../persistence/database.js';
import { environments, releaseCandidates, releaseOperations, runRuntime } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { DomainError } from '../service/errors.js';
import { appendEvent, type TaskRow } from './authority.js';

export async function enqueueReleaseOperation(tx: Transaction, database: Database, queue: typeof releaseFixtureQueue | typeof formalReleaseQueue, scope: {
  candidateId: string; environmentId: string; approvalVersion: number;
}) {
  const id = randomUUID();
  await tx.insert(releaseOperations).values({
    id, ...scope, wakeupJobId: queue === formalReleaseQueue ? id : null,
  });
  const jobId = await database.boss.send(queue, releaseWakeupSchema.parse({ operationId: id }), {
    id, db: fromDrizzle(tx, sql),
  });
  if (jobId !== id) throw new DomainError('unavailable');
  return id;
}

export async function blockQueuedRelease(tx: Transaction, database: Database, operationId: string, now: Date) {
  const [queued] = await tx.select({ wakeupJobId: releaseOperations.wakeupJobId }).from(releaseOperations)
    .where(and(eq(releaseOperations.id, operationId), eq(releaseOperations.state, 'queued'))).for('update');
  if (!queued?.wakeupJobId) return false;
  await tx.update(releaseOperations).set({ state: 'blocked', wakeupJobId: null, updatedAt: now })
    .where(eq(releaseOperations.id, operationId));
  await database.boss.cancel(formalReleaseQueue, queued.wakeupJobId, { db: fromDrizzle(tx, sql) });
  return true;
}

export async function renewFormalWakeup(tx: Transaction, database: Database, operationId: string, delay = false) {
  const id = randomUUID();
  const jobId = await database.boss.send(formalReleaseQueue, releaseWakeupSchema.parse({ operationId }), {
    id, db: fromDrizzle(tx, sql), ...(delay ? { startAfter: 1 } : {}),
  });
  if (jobId !== id) throw new DomainError('unavailable');
  await tx.update(releaseOperations).set({ state: 'queued', wakeupJobId: id, updatedAt: sql`clock_timestamp()` })
    .where(eq(releaseOperations.id, operationId));
  return id;
}

export async function recoverClaimedRelease(tx: Transaction, database: Database, task: TaskRow, runId: string,
  workerId: string, expired: boolean) {
  const operations = await tx.select({ operation: releaseOperations, candidate: releaseCandidates }).from(releaseOperations)
    .innerJoin(releaseCandidates, eq(releaseCandidates.id, releaseOperations.candidateId))
    .where(and(eq(releaseCandidates.runId, runId), eq(releaseCandidates.taskId, task.id),
      eq(releaseOperations.state, 'dispatching'), sql`${releaseCandidates.document}->>'origin' = 'formal_verification'`)).limit(2);
  const reserved = operations[0];
  if (!reserved || operations.length !== 1 || (task.state !== 'running' && task.state !== 'cancel_requested')) {
    throw new DomainError('unavailable');
  }
  const { candidate, operation } = reserved;
  await tx.select({ id: environments.id }).from(environments).where(eq(environments.id, operation.environmentId)).for('update');
  const [current] = await tx.select({ state: releaseOperations.state }).from(releaseOperations)
    .where(eq(releaseOperations.id, operation.id)).for('update');
  if (current?.state !== 'dispatching') throw new DomainError('unavailable');
  const releaseDecision = { candidateId: candidate.id, fingerprint: candidate.fingerprint,
    decisionVersion: operation.approvalVersion, operationId: operation.id };
  if (task.state === 'cancel_requested') {
    await tx.update(releaseOperations).set({ state: 'blocked', updatedAt: sql`clock_timestamp()` }).where(eq(releaseOperations.id, operation.id));
    await appendEvent(tx, task, 'task.cancelled', 'cancelled', { workerId, reason: expired ? 'expired_cancel' : 'cancelled', releaseDecision });
    await tx.update(runRuntime).set({ reason: 'release_cancelled' }).where(eq(runRuntime.runId, runId));
  } else {
    await renewFormalWakeup(tx, database, operation.id);
    await appendEvent(tx, task, expired ? 'task.recovered' : 'task.release_requeued', 'queued', {
      workerId, reason: expired ? 'lease_expired' : 'release_queued', releaseDecision,
    });
    await tx.update(runRuntime).set({ reason: 'release_queued' }).where(eq(runRuntime.runId, runId));
  }
}
