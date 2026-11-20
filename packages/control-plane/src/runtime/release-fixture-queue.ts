import { randomUUID } from 'node:crypto';
import { fixtureReleaseWakeupSchema } from '@itervane/contracts';
import { sql } from 'drizzle-orm';
import { fromDrizzle } from 'pg-boss';
import { releaseFixtureQueue, type Database } from '../persistence/database.js';
import { releaseOperations } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { DomainError } from '../service/errors.js';

export async function enqueueReleaseFixture(tx: Transaction, database: Database, scope: {
  candidateId: string; environmentId: string; approvalVersion: number;
}) {
  const id = randomUUID();
  await tx.insert(releaseOperations).values({ id, ...scope });
  const jobId = await database.boss.send(releaseFixtureQueue, fixtureReleaseWakeupSchema.parse({ operationId: id }), {
    id, db: fromDrizzle(tx, sql),
  });
  if (jobId !== id) throw new DomainError('unavailable');
  return id;
}
