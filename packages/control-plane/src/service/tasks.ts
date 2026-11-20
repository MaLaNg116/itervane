import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { fromDrizzle } from 'pg-boss';
import { assertTransition, cancelTaskSchema, idSchema, listQuerySchema, startTaskSchema, taskDtoSchema, taskEventDtoSchema, wakeupSchema } from '@itervane/contracts';
import type { VerifiedIdentity } from '../auth/identity.js';
import { queueName, type Database } from '../persistence/database.js';
import { repositories, taskEvents, taskRuns, tasks } from '../persistence/schema.js';
import { requireActor, requireProject, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';

function presentTask(task: typeof tasks.$inferSelect, runId: string) {
  return taskDtoSchema.parse({ id: task.id, projectId: task.projectId, requestedBy: task.requestedBy, runId,
    source: { repositoryId: task.repositoryId, commit: task.commit }, purpose: task.purpose, dataClass: task.dataClass,
    state: task.state, version: task.version, createdAt: task.createdAt.toISOString() });
}

async function taskView(tx: Transaction, taskId: string) {
  const [row] = await tx.select({ task: tasks, runId: taskRuns.id }).from(tasks)
    .innerJoin(taskRuns, and(eq(taskRuns.taskId, tasks.id), eq(taskRuns.generation, tasks.generation))).where(eq(tasks.id, taskId));
  if (!row) throw new DomainError('not_found');
  return presentTask(row.task, row.runId);
}

export class TaskService {
  constructor(private readonly database: Database) {}

  async admit(identity: VerifiedIdentity, raw: unknown) {
    const input = parseInput(startTaskSchema, raw);
    // 显式排序规范化字段，JSON 属性顺序不同不会产生不同的幂等指纹。
    const hash = createHash('sha256').update(JSON.stringify({ projectId: input.projectId,
      source: { repositoryId: input.source.repositoryId, commit: input.source.commit },
      idempotencyKey: input.idempotencyKey, purpose: input.purpose, dataClass: input.dataClass })).digest('hex');
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity); await requireProject(tx, actor, input.projectId, true);
      const [repository] = await tx.select().from(repositories)
        .where(and(eq(repositories.id, input.source.repositoryId), eq(repositories.projectId, input.projectId))).for('share');
      if (!repository) throw new DomainError('not_found');
      const taskId = randomUUID(); const runId = randomUUID();
      const [inserted] = await tx.insert(tasks).values({ id: taskId, projectId: input.projectId,
        repositoryId: repository.id, requestedBy: actor.principalId, commit: input.source.commit, purpose: input.purpose,
        dataClass: input.dataClass, requestKey: input.idempotencyKey, requestHash: hash })
        .onConflictDoNothing({ target: [tasks.projectId, tasks.requestedBy, tasks.requestKey] }).returning();
      if (!inserted) {
        const [existing] = await tx.select().from(tasks).where(and(eq(tasks.projectId, input.projectId), eq(tasks.requestedBy, actor.principalId), eq(tasks.requestKey, input.idempotencyKey)));
        if (!existing || existing.requestHash !== hash) throw new DomainError('idempotency_conflict');
        return { task: await taskView(tx, existing.id), replayed: true };
      }
      await tx.insert(taskRuns).values({ id: runId, taskId, generation: 1, role: 'audit' });
      const jobId = await this.database.boss.send(queueName, wakeupSchema.parse({ taskId, runId, generation: 1 }), { db: fromDrizzle(tx, sql) });
      if (!jobId) throw new DomainError('unavailable');
      await tx.update(taskRuns).set({ wakeupJobId: jobId }).where(eq(taskRuns.id, runId));
      await tx.insert(taskEvents).values({ taskId, sequence: 1, type: 'task.accepted', state: 'queued', actorId: actor.principalId });
      return { task: await taskView(tx, taskId), replayed: false };
    });
  }

  async get(identity: VerifiedIdentity, taskId: string) {
    parseInput(idSchema, taskId);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      const task = await taskView(tx, taskId); await requireProject(tx, actor, task.projectId);
      return task;
    });
  }

  async list(identity: VerifiedIdentity, projectId: string, limit: number) {
    parseInput(idSchema, projectId); limit = parseInput(listQuerySchema, { limit }).limit;
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity); await requireProject(tx, actor, projectId);
      const rows = await tx.select({ task: tasks, runId: taskRuns.id }).from(tasks)
        .innerJoin(taskRuns, and(eq(taskRuns.taskId, tasks.id), eq(taskRuns.generation, tasks.generation))).where(eq(tasks.projectId, projectId))
        .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(limit);
      return rows.map(row => presentTask(row.task, row.runId));
    });
  }

  async events(identity: VerifiedIdentity, taskId: string, limit: number) {
    parseInput(idSchema, taskId); limit = parseInput(listQuerySchema, { limit }).limit;
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity); const task = await taskView(tx, taskId);
      await requireProject(tx, actor, task.projectId);
      return (await tx.select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).orderBy(asc(taskEvents.sequence)).limit(limit))
        .map(row => taskEventDtoSchema.parse({ taskId: row.taskId, sequence: row.sequence, type: row.type,
          state: row.state, actorId: row.actorId, createdAt: row.createdAt.toISOString() }));
    });
  }

  async cancel(identity: VerifiedIdentity, taskId: string, raw: unknown) {
    parseInput(idSchema, taskId); const input = parseInput(cancelTaskSchema, raw);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity); const initial = await taskView(tx, taskId);
      await requireProject(tx, actor, initial.projectId, true);
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update');
      if (!task) throw new DomainError('not_found');
      if (task.state === 'cancelled') return taskView(tx, taskId);
      if (task.state !== 'queued') throw new DomainError('unsupported_state');
      if (task.version !== input.expectedVersion) throw new DomainError('version_conflict');
      assertTransition(task.state, 'cancelled');
      const [updated] = await tx.update(tasks).set({ state: 'cancelled', version: task.version + 1 })
        .where(and(eq(tasks.id, taskId), eq(tasks.version, input.expectedVersion), eq(tasks.state, 'queued'))).returning();
      if (!updated) throw new DomainError('version_conflict');
      const [run] = await tx.select().from(taskRuns).where(and(eq(taskRuns.taskId, taskId), eq(taskRuns.generation, task.generation)));
      if (!run?.wakeupJobId) throw new DomainError('unavailable');
      await this.database.boss.cancel(queueName, run.wakeupJobId, { db: fromDrizzle(tx, sql) });
      await tx.update(taskRuns).set({ state: 'cancelled' }).where(eq(taskRuns.id, run.id));
      await tx.insert(taskEvents).values({ taskId, sequence: updated.version, type: 'task.cancelled', state: 'cancelled', actorId: actor.principalId });
      return taskView(tx, taskId);
    });
  }
}
