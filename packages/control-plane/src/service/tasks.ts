import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { fromDrizzle } from 'pg-boss';
import { cancelTaskSchema, resumeTaskSchema, idSchema, listQuerySchema, startTaskSchema, taskDtoSchema, taskEventDtoSchema, wakeupSchema, translate,
  eventReasonMessages, retrySourceInspectionReasonSchema, taskEventReasonSchema, type Locale, type MessageKey } from '@itervane/contracts';
import type { VerifiedIdentity } from '../auth/identity.js';
import { queueName, type Database } from '../persistence/database.js';
import { repositories, runRuntime, taskEvents, taskRuns, tasks } from '../persistence/schema.js';
import { requireActor, requireProject, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { appendEvent, enqueue, lockSlot } from '../runtime/authority.js';

function presentTask(task: typeof tasks.$inferSelect, runId: string) {
  return taskDtoSchema.parse({ id: task.id, projectId: task.projectId, requestedBy: task.requestedBy, runId,
    source: { repositoryId: task.repositoryId, commit: task.commit }, purpose: task.purpose, dataClass: task.dataClass,
    state: task.state, version: task.version, locale: task.locale, createdAt: task.createdAt.toISOString() });
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
    const canonical = { projectId: input.projectId,
      source: { repositoryId: input.source.repositoryId, commit: input.source.commit },
      idempotencyKey: input.idempotencyKey, purpose: input.purpose, dataClass: input.dataClass };
    // 缺省英语保持 P1-A 的幂等指纹；非默认输出语言是任务输入的一部分。
    const hash = createHash('sha256').update(JSON.stringify(input.locale === 'en' ? canonical : { ...canonical, locale: input.locale })).digest('hex');
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity); await requireProject(tx, actor, input.projectId, true);
      const [repository] = await tx.select().from(repositories)
        .where(and(eq(repositories.id, input.source.repositoryId), eq(repositories.projectId, input.projectId))).for('share');
      if (!repository) throw new DomainError('not_found');
      const taskId = randomUUID(); const runId = randomUUID();
      const [inserted] = await tx.insert(tasks).values({ id: taskId, projectId: input.projectId,
        repositoryId: repository.id, requestedBy: actor.principalId, commit: input.source.commit, purpose: input.purpose,
        dataClass: input.dataClass, locale: input.locale, requestKey: input.idempotencyKey, requestHash: hash })
        .onConflictDoNothing({ target: [tasks.projectId, tasks.requestedBy, tasks.requestKey] }).returning();
      if (!inserted) {
        const [existing] = await tx.select().from(tasks).where(and(eq(tasks.projectId, input.projectId), eq(tasks.requestedBy, actor.principalId), eq(tasks.requestKey, input.idempotencyKey)));
        if (!existing || existing.requestHash !== hash) throw new DomainError('idempotency_conflict');
        return { task: await taskView(tx, existing.id), replayed: true };
      }
      await tx.insert(taskRuns).values({ id: runId, taskId, generation: 1, role: 'audit' });
      await tx.insert(runRuntime).values({ runId, taskId });
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

  async events(identity: VerifiedIdentity, taskId: string, limit: number, locale: Locale = 'en') {
    parseInput(idSchema, taskId); limit = parseInput(listQuerySchema, { limit }).limit;
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity); const task = await taskView(tx, taskId);
      await requireProject(tx, actor, task.projectId);
      return (await tx.select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).orderBy(asc(taskEvents.sequence)).limit(limit))
        .map(row => {
          const parsedReason = taskEventReasonSchema.safeParse(row.detail.reason);
          const reason = parsedReason.success ? parsedReason.data : null;
          return taskEventDtoSchema.parse({ taskId: row.taskId, sequence: row.sequence, type: row.type,
          state: row.state, actorId: row.actorId, actorKind: row.actorKind, workerId: row.workerId,
          reason, reasonMessage: reason ? translate(locale, eventReasonMessages[reason]) : null,
          messageKey: row.type, message: translate(locale, row.type as MessageKey), locale, createdAt: row.createdAt.toISOString() });
        });
    });
  }

  async cancel(identity: VerifiedIdentity, taskId: string, raw: unknown) {
    parseInput(idSchema, taskId); const input = parseInput(cancelTaskSchema, raw);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity); const initial = await taskView(tx, taskId);
      await requireProject(tx, actor, initial.projectId, true);
      await lockSlot(tx);
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update');
      if (!task) throw new DomainError('not_found');
      if (task.state === 'cancelled' || task.state === 'cancel_requested') return taskView(tx, taskId);
      if (!['queued', 'running', 'waiting_input', 'waiting_approval'].includes(task.state)) throw new DomainError('unsupported_state');
      if (task.version !== input.expectedVersion) throw new DomainError('version_conflict');
      const [run] = await tx.select().from(taskRuns).where(and(eq(taskRuns.taskId, taskId), eq(taskRuns.generation, task.generation)));
      if (!run) throw new DomainError('unavailable');
      if (run.wakeupJobId) await this.database.boss.cancel(queueName, run.wakeupJobId, { db: fromDrizzle(tx, sql) });
      const running = task.state === 'running';
      await appendEvent(tx, task, running ? 'task.cancel_requested' : 'task.cancelled', running ? 'cancel_requested' : 'cancelled', { actorId: actor.principalId });
      await tx.update(runRuntime).set({ resumePending: false, waitingForTaskId: null }).where(eq(runRuntime.runId, run.id));
      return taskView(tx, taskId);
    });
  }

  async resume(identity: VerifiedIdentity, taskId: string, raw: unknown) {
    parseInput(idSchema, taskId); const input = parseInput(resumeTaskSchema, raw);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity); const initial = await taskView(tx, taskId);
      await requireProject(tx, actor, initial.projectId, true);
      await lockSlot(tx);
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update');
      if (!task) throw new DomainError('not_found');
      if (task.version !== input.expectedVersion) throw new DomainError('version_conflict');
      if (task.state !== 'waiting_input') throw new DomainError('unsupported_state');
      const [run] = await tx.select().from(taskRuns).where(and(eq(taskRuns.taskId, taskId), eq(taskRuns.generation, task.generation)));
      const [runtime] = run ? await tx.select().from(runRuntime).where(eq(runRuntime.runId, run.id)) : [];
      // 人工 resume 只重试 Runner 前置检查，不能代替子任务完成或高风险审批。
      if (!run || !runtime?.checkpointId || !retrySourceInspectionReasonSchema.safeParse(runtime.reason).success
        || runtime.waitingForTaskId) throw new DomainError('unsupported_state');
      if (runtime.resumeCount >= 3) throw new DomainError('resume_limit');
      await tx.update(runRuntime).set({ resumePending: true, resumeCount: runtime.resumeCount + 1 }).where(eq(runRuntime.runId, run.id));
      const next = await appendEvent(tx, task, 'task.resumed', 'queued', { actorId: actor.principalId });
      await enqueue(tx, this.database, next, run.id);
      return taskView(tx, taskId);
    });
  }
}
