import { randomUUID } from 'node:crypto';
import { releaseWakeupSchema } from '@itervane/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { fromDrizzle } from 'pg-boss';
import { formalReleaseQueue, releaseFixtureQueue, type Database } from '../persistence/database.js';
import { releaseOperations } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { DomainError } from '../service/errors.js';

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
