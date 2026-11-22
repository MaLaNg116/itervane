import { and, eq, sql } from 'drizzle-orm';
import { fromDrizzle } from 'pg-boss';
import { wakeupSchema, type TaskState, type TaskEventReason } from '@itervane/contracts';
import { queueName, type Database } from '../persistence/database.js';
import { executionSlot, runRuntime, taskEvents, taskRuns, tasks } from '../persistence/schema.js';
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

export async function lockExecution(tx: Transaction, scope: ExecutionScope, allowCancel?: boolean) {
  const slot = await lockSlot(tx);
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, scope.taskId)).for('update');
  const [run] = await tx.select().from(taskRuns).where(eq(taskRuns.id, scope.runId));
  const [runtime] = await tx.select().from(runRuntime).where(eq(runRuntime.runId, scope.runId));
  if (!task || !run || !runtime || !slot.live || slot.taskId !== task.id || slot.runId !== run.id
    || slot.workerId !== scope.workerId || slot.fence !== scope.fence || task.generation !== scope.generation
    || run.taskId !== task.id || runtime.taskId !== task.id || run.generation !== scope.generation
    || (task.state !== 'running' && !(allowCancel && task.state === 'cancel_requested'))) throw new ExecutionLost();
  return { slot, task, run, runtime };
}

export async function assertLeaseLive(tx: Transaction, previousLeaseUntil: Date) {
  // 清空执行槽后仍检查原租约，心跳则检查本次延长后的租约。
  const [valid] = await tx.select({ live: sql<boolean>`CASE WHEN ${executionSlot.taskId} IS NULL
    THEN ${previousLeaseUntil}::timestamptz > clock_timestamp()
    ELSE ${executionSlot.leaseUntil} > clock_timestamp() END` }).from(executionSlot).where(eq(executionSlot.id, 1));
  if (!valid?.live) throw new ExecutionLost();
}

export async function assignSlot(tx: Transaction, task: TaskRow, runId: string, workerId: string, leaseSeconds: number): Promise<ExecutionScope> {
  const [assignment] = await tx.update(executionSlot).set({ taskId: task.id, runId, workerId,
    fence: sql`${executionSlot.fence} + 1`, leaseUntil: sql`clock_timestamp() + ${leaseSeconds} * interval '1 second'` })
    .where(eq(executionSlot.id, 1)).returning({ fence: executionSlot.fence });
  if (!assignment) throw new DomainError('unavailable');
  return Object.freeze({ taskId: task.id, runId, generation: task.generation, workerId, fence: assignment.fence });
}

export async function renewSlot(tx: Transaction, leaseSeconds: number) {
  const [renewed] = await tx.update(executionSlot).set({ leaseUntil: sql`clock_timestamp() + ${leaseSeconds} * interval '1 second'` })
    .where(and(eq(executionSlot.id, 1), sql`${executionSlot.leaseUntil} > clock_timestamp()`)).returning({ id: executionSlot.id });
  if (!renewed) throw new ExecutionLost();
}

export async function appendEvent(tx: Transaction, task: TaskRow, type: string, state: TaskState,
  options: { actorId?: string; workerId?: string; reason?: TaskEventReason;
    observation?: { runId: string; toolCallKeySha256: string; inspectionRequestId?: string };
    audit?: { runId: string; auditResultSha256: string };
    repair?: { runId: string; repairResultSha256: string };
    verification?: { runId: string; verificationResultSha256: string };
    operations?: { runId: string; releaseOperationId: string; observationSha256: string; fence: number; diagnosisSha256?: string };
    operationsExecution?: { executionId: string; proposalId: string; fence?: number; nativeApprovalId?: string; nativeCallSha256?: string };
    releaseCandidate?: { candidateId: string; fingerprint: string };
    releaseDecision?: { candidateId: string; fingerprint: string; decisionVersion: number; operationId?: string; fence?: number; rolloutFence?: number };
    retry?: { runId: string; previousRunId: string; retrySha256: string } } = {}) {
  const [next] = await tx.update(tasks).set({ state, version: task.version + 1 })
    .where(and(eq(tasks.id, task.id), eq(tasks.version, task.version))).returning();
  if (!next) throw new DomainError('version_conflict');
  await tx.update(taskRuns).set({ state }).where(and(eq(taskRuns.taskId, task.id), eq(taskRuns.generation, task.generation)));
  await tx.insert(taskEvents).values({ taskId: task.id, sequence: next.version, type, state,
    actorId: options.actorId ?? task.requestedBy, actorKind: options.workerId ? 'worker' : 'principal', workerId: options.workerId ?? null,
    detail: { ...(options.reason ? { reason: options.reason } : {}), ...options.observation, ...options.audit, ...options.repair,
      ...options.verification, ...options.operations, ...options.operationsExecution, ...options.releaseCandidate, ...options.releaseDecision,
      ...options.retry } });
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
