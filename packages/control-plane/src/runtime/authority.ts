import { and, eq, sql } from 'drizzle-orm';
import { fromDrizzle } from 'pg-boss';
import { wakeupSchema, type TaskState, type TaskEventReason } from '@itervane/contracts';
import { queueName, type Database } from '../persistence/database.js';
import { executionSlot, taskEvents, taskRuns, tasks } from '../persistence/schema.js';
import { DomainError } from '../service/errors.js';
import type { Transaction } from '../service/access.js';

export type TaskRow = typeof tasks.$inferSelect;
export class ExecutionLost extends Error { constructor() { super('execution_lost'); this.name = 'ExecutionLost'; } }
export class BudgetExhausted extends Error { constructor() { super('budget_exhausted'); this.name = 'BudgetExhausted'; } }
export type ExecutionScope = Readonly<{ taskId: string; runId: string; generation: number; workerId: string; fence: number }>;

export async function lockSlot(tx: Transaction) {
  const [slot] = await tx.select({ id: executionSlot.id, taskId: executionSlot.taskId, runId: executionSlot.runId,
    workerId: executionSlot.workerId, fence: executionSlot.fence, leaseUntil: executionSlot.leaseUntil })
    .from(executionSlot).where(eq(executionSlot.id, 1)).for('update');
  if (!slot) throw new DomainError('unavailable');
  // SELECT 的投影可能在等待行锁前求值；锁定后单独查询数据库时钟。
  const [clock] = await tx.select({ live: sql<boolean>`${executionSlot.leaseUntil} > clock_timestamp()` })
    .from(executionSlot).where(eq(executionSlot.id, 1));
  return { ...slot, live: clock?.live === true };
}

export async function clearSlot(tx: Transaction) {
  await tx.update(executionSlot).set({ taskId: null, runId: null, workerId: null, leaseUntil: sql`'-infinity'::timestamptz` }).where(eq(executionSlot.id, 1));
}

export async function appendEvent(tx: Transaction, task: TaskRow, type: string, state: TaskState,
  options: { actorId?: string; workerId?: string; reason?: TaskEventReason;
    observation?: { runId: string; toolCallKeySha256: string; inspectionRequestId?: string };
    audit?: { runId: string; auditResultSha256: string };
    repair?: { runId: string; repairResultSha256: string };
    verification?: { runId: string; verificationResultSha256: string };
    retry?: { runId: string; previousRunId: string; retrySha256: string } } = {}) {
  const [next] = await tx.update(tasks).set({ state, version: task.version + 1 })
    .where(and(eq(tasks.id, task.id), eq(tasks.version, task.version))).returning();
  if (!next) throw new DomainError('version_conflict');
  await tx.update(taskRuns).set({ state }).where(and(eq(taskRuns.taskId, task.id), eq(taskRuns.generation, task.generation)));
  await tx.insert(taskEvents).values({ taskId: task.id, sequence: next.version, type, state,
    actorId: options.actorId ?? task.requestedBy, actorKind: options.workerId ? 'worker' : 'principal', workerId: options.workerId ?? null,
    detail: { ...(options.reason ? { reason: options.reason } : {}), ...options.observation, ...options.audit, ...options.repair, ...options.verification, ...options.retry } });
  return next;
}

export async function enqueue(tx: Transaction, database: Database, task: TaskRow, runId: string, delay = false) {
  const jobId = await database.boss.send(queueName, wakeupSchema.parse({ taskId: task.id, runId, generation: task.generation }), {
    db: fromDrizzle(tx, sql), ...(delay ? { startAfter: 1 } : {}),
  });
  if (!jobId) throw new DomainError('unavailable');
  await tx.update(taskRuns).set({ wakeupJobId: jobId }).where(eq(taskRuns.id, runId));
  return jobId;
}
