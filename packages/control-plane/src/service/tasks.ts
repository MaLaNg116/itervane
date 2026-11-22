import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { fromDrizzle } from 'pg-boss';
import { cancelTaskSchema, resumeTaskSchema, idSchema, listQuerySchema, startOperationsTaskSchema, startTaskSchema, taskDtoSchema, taskEventDtoSchema, translate,
  eventReasonMessages, retrySourceInspectionReasonSchema, taskEventReasonSchema, type Locale, type MessageKey } from '@itervane/contracts';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { OperationsEnrollmentScope } from '../config.js';
import { queueName, type Database } from '../persistence/database.js';
import { formalAuditInputs, formalAuditResults, operationsRequests, releaseCandidates, releaseOperations, repositories,
  runRuntime, taskEvents, taskRuns, tasks } from '../persistence/schema.js';
import { requireActor, requireProject, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { isRepairableAudit } from './formal-repair.js';
import { freezeOperationsRequest } from './operations-requests.js';
import { readOperationsObservationTarget } from './operations-targets.js';
import { appendEvent, enqueue, lockSlot } from '../runtime/authority.js';
import { blockQueuedRelease } from '../runtime/release-queue.js';
import { databaseNow } from './releases.js';

function presentTask(task: typeof tasks.$inferSelect, run: Pick<typeof taskRuns.$inferSelect, 'id' | 'role'>) {
  return taskDtoSchema.parse({ id: task.id, projectId: task.projectId, requestedBy: task.requestedBy, runId: run.id,
    ...(run.role === 'operations' ? { workflow: run.role } : {}),
    source: { repositoryId: task.repositoryId, commit: task.commit }, purpose: task.purpose, dataClass: task.dataClass,
    state: task.state, version: task.version, locale: task.locale, createdAt: task.createdAt.toISOString() });
}

async function taskView(tx: Transaction, taskId: string) {
  const [row] = await tx.select({ task: tasks, run: { id: taskRuns.id, role: taskRuns.role } }).from(tasks)
    .innerJoin(taskRuns, and(eq(taskRuns.taskId, tasks.id), eq(taskRuns.generation, tasks.generation))).where(eq(tasks.id, taskId));
  if (!row) throw new DomainError('not_found');
  return presentTask(row.task, row.run);
}

type TaskAdmission = Pick<typeof tasks.$inferInsert,
  'projectId' | 'requestedBy' | 'repositoryId' | 'commit' | 'purpose' | 'dataClass' | 'locale' | 'requestKey' | 'requestHash'>;

async function replayAdmission(tx: Transaction, scope: Pick<TaskAdmission, 'projectId' | 'requestedBy' | 'requestKey' | 'requestHash'>) {
  const [existing] = await tx.select({ id: tasks.id, requestHash: tasks.requestHash }).from(tasks)
    .where(and(eq(tasks.projectId, scope.projectId), eq(tasks.requestedBy, scope.requestedBy), eq(tasks.requestKey, scope.requestKey)));
  if (!existing) return undefined;
  if (existing.requestHash !== scope.requestHash) throw new DomainError('idempotency_conflict');
  return { task: await taskView(tx, existing.id), replayed: true };
}

export class TaskService {
  constructor(private readonly database: Database) {}

  private async insertTask(tx: Transaction, values: TaskAdmission, operations?: ReturnType<typeof freezeOperationsRequest>) {
    const taskId = randomUUID(); const runId = randomUUID();
    const [task] = await tx.insert(tasks).values({ ...values, id: taskId })
      .onConflictDoNothing({ target: [tasks.projectId, tasks.requestedBy, tasks.requestKey] }).returning();
    if (!task) {
      const replay = await replayAdmission(tx, values);
      if (!replay) throw new DomainError('idempotency_conflict');
      return replay;
    }
    const run = { id: runId, role: operations ? 'operations' : 'audit' } as const;
    await tx.insert(taskRuns).values({ ...run, taskId, generation: 1 });
    await tx.insert(runRuntime).values({ runId, taskId, ...(operations ? { maxTools: 2 } : {}) });
    if (operations) {
      const { projectId, applicationId, environmentId, releaseOperationId } = operations.document;
      await tx.insert(operationsRequests).values({ runId, taskId, projectId, applicationId, environmentId, releaseOperationId, ...operations });
    }
    await enqueue(tx, this.database, task, runId);
    await tx.insert(taskEvents).values({ taskId, sequence: 1, type: 'task.accepted', state: 'queued', actorId: task.requestedBy });
    return { task: presentTask(task, run), replayed: false };
  }

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
      return this.insertTask(tx, { projectId: input.projectId,
        repositoryId: repository.id, requestedBy: actor.principalId, commit: input.source.commit, purpose: input.purpose,
        dataClass: input.dataClass, locale: input.locale, requestKey: input.idempotencyKey, requestHash: hash });
    });
  }

  async admitOperations(identity: VerifiedIdentity, raw: unknown, installation?: OperationsEnrollmentScope) {
    const input = parseInput(startOperationsTaskSchema, raw);
    const { projectId, environmentId, idempotencyKey, locale, expectedReleaseOperationId } = input;
    // An omitted expectation keeps the request fingerprint of earlier MCP and HTTP submissions.
    const requestHash = createHash('sha256').update(JSON.stringify({
      workflow: 'operations', projectId, environmentId, locale, expectedReleaseOperationId,
    })).digest('hex');
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      await requireProject(tx, actor, projectId, true);
      if (installation && installation.environmentId !== environmentId) throw new DomainError('not_found');
      const scope = { projectId, requestedBy: actor.principalId, requestKey: idempotencyKey, requestHash };
      const replay = await replayAdmission(tx, scope);
      if (replay) return replay;
      const target = await readOperationsObservationTarget(tx, actor, { projectId, environmentId });
      if (installation && installation.enrollmentSha256 !== target.enrollmentSha256) throw new DomainError('unavailable');
      if (expectedReleaseOperationId && expectedReleaseOperationId !== target.releaseOperationId) throw new DomainError('version_conflict');
      return this.insertTask(tx, { ...scope, repositoryId: target.source.repositoryId, commit: target.source.commit,
        purpose: translate(locale, 'operations.task.purpose'), dataClass: target.dataClass, locale }, freezeOperationsRequest(target));
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
      const rows = await tx.select({ task: tasks, run: { id: taskRuns.id, role: taskRuns.role } }).from(tasks)
        .innerJoin(taskRuns, and(eq(taskRuns.taskId, tasks.id), eq(taskRuns.generation, tasks.generation))).where(eq(tasks.projectId, projectId))
        .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(limit);
      return rows.map(row => presentTask(row.task, row.run));
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
      if (!['queued', 'running', 'waiting_input', 'waiting_approval', 'reconciling'].includes(task.state)) throw new DomainError('unsupported_state');
      if (task.version !== input.expectedVersion) throw new DomainError('version_conflict');
      const [run] = await tx.select().from(taskRuns).where(and(eq(taskRuns.taskId, taskId), eq(taskRuns.generation, task.generation)));
      if (!run) throw new DomainError('unavailable');
      if (task.state === 'reconciling') {
        const [runtime] = await tx.select({ reason: runRuntime.reason }).from(runRuntime).where(eq(runRuntime.runId, run.id));
        if (!['release_registry_reconciling', 'release_komodo_ready', 'release_komodo_reconciling', 'release_komodo_awaiting_rollout']
          .includes(runtime?.reason ?? '')) throw new DomainError('unsupported_state');
      }
      if (run.wakeupJobId) await this.database.boss.cancel(queueName, run.wakeupJobId, { db: fromDrizzle(tx, sql) });
      if (task.state === 'queued' && !run.wakeupJobId) {
        const [operation] = await tx.select({ id: releaseOperations.id }).from(releaseOperations)
          .innerJoin(releaseCandidates, eq(releaseCandidates.id, releaseOperations.candidateId))
          .where(and(eq(releaseCandidates.runId, run.id), eq(releaseOperations.state, 'queued'),
            sql`${releaseCandidates.document}->>'origin' = 'formal_verification'`));
        if (operation && !await blockQueuedRelease(tx, this.database, operation.id, await databaseNow(tx))) throw new DomainError('conflict');
      }
      const running = task.state === 'running' || task.state === 'reconciling';
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
      const readyForAudit = runtime?.reason === 'inspection_ready';
      const readyForRepair = runtime?.reason === 'audit_ready' || runtime?.reason === 'repair_deferred';
      if (!run || !runtime?.checkpointId || runtime.waitingForTaskId
        || (!readyForAudit && !readyForRepair && !retrySourceInspectionReasonSchema.safeParse(runtime.reason).success)) throw new DomainError('unsupported_state');
      if (readyForAudit) {
        const [record] = await tx.select({ runId: formalAuditInputs.runId }).from(formalAuditInputs).where(eq(formalAuditInputs.runId, run.id));
        if (!record) throw new DomainError('unsupported_state');
      }
      if (readyForRepair) {
        const [record] = await tx.select({ document: formalAuditResults.document }).from(formalAuditResults)
          .where(eq(formalAuditResults.runId, run.id));
        if (!isRepairableAudit(record?.document)) throw new DomainError('unsupported_state');
      }
      if (runtime.resumeCount >= 3) throw new DomainError('resume_limit');
      await tx.update(runRuntime).set({ resumePending: true, resumeCount: runtime.resumeCount + 1,
        ...(readyForRepair ? { reason: 'repair_pending' } : {}),
      }).where(eq(runRuntime.runId, run.id));
      const event = readyForRepair ? 'task.repair_resumed' : readyForAudit ? 'task.audit_resumed' : 'task.resumed';
      const next = await appendEvent(tx, task, event, 'queued', { actorId: actor.principalId, ...(readyForRepair ? { reason: 'repair_pending' } : {}) });
      await enqueue(tx, this.database, next, run.id);
      return taskView(tx, taskId);
    });
  }
}
