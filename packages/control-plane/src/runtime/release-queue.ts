import { randomUUID } from 'node:crypto';
import { releaseWakeupSchema, type TaskEventReason } from '@itervane/contracts';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { fromDrizzle } from 'pg-boss';
import { formalReleaseQueue, releaseFixtureQueue, type Database } from '../persistence/database.js';
import { environments, formalReleaseSteps, releaseCandidates, releaseOperations, runRuntime, taskEvents } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { lockEnvironmentForEffect, requireNoOperationsHold } from '../service/environment-effects.js';
import { DomainError } from '../service/errors.js';
import { appendEvent, type TaskRow } from './authority.js';

export async function enqueueReleaseOperation(tx: Transaction, database: Database, queue: typeof releaseFixtureQueue | typeof formalReleaseQueue, scope: {
  candidateId: string; environmentId: string; approvalVersion: number;
}) {
  await lockEnvironmentForEffect(tx, scope.environmentId);
  await requireNoOperationsHold(tx, scope.environmentId);
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

export async function renewFormalWakeup(tx: Transaction, database: Database, operationId: string,
  options: { state?: 'queued' | 'reconciling'; delaySeconds?: number } = {}) {
  const id = randomUUID();
  const jobId = await database.boss.send(formalReleaseQueue, releaseWakeupSchema.parse({ operationId }), {
    id, db: fromDrizzle(tx, sql), ...(options.delaySeconds ? { startAfter: options.delaySeconds } : {}),
  });
  if (jobId !== id) throw new DomainError('unavailable');
  await tx.update(releaseOperations).set({ state: options.state ?? 'queued', wakeupJobId: id, updatedAt: sql`clock_timestamp()` })
    .where(eq(releaseOperations.id, operationId));
  return id;
}

async function lockReleaseForRecovery(tx: Transaction, task: TaskRow, runId: string) {
  const operations = await tx.select({ operation: releaseOperations, candidate: releaseCandidates }).from(releaseOperations)
    .innerJoin(releaseCandidates, eq(releaseCandidates.id, releaseOperations.candidateId))
    .where(and(eq(releaseCandidates.runId, runId), eq(releaseCandidates.taskId, task.id),
      inArray(releaseOperations.state, ['dispatching', 'reconciling']), sql`${releaseCandidates.document}->>'origin' = 'formal_verification'`)).limit(2);
  const reserved = operations[0];
  if (!reserved || operations.length !== 1 || (task.state !== 'running' && task.state !== 'cancel_requested')) {
    throw new DomainError('unavailable');
  }
  const { candidate, operation } = reserved;
  await tx.select({ id: environments.id }).from(environments).where(eq(environments.id, operation.environmentId)).for('update');
  const [current] = await tx.select().from(releaseOperations)
    .where(eq(releaseOperations.id, operation.id)).for('update');
  if (!current || (current.state !== 'dispatching' && current.state !== 'reconciling') || current.wakeupJobId) {
    throw new DomainError('unavailable');
  }
  const releaseDecision = { candidateId: candidate.id, fingerprint: candidate.fingerprint,
    decisionVersion: operation.approvalVersion, operationId: operation.id };
  return { operation: current, releaseDecision };
}

export async function recoverClaimedRelease(tx: Transaction, database: Database, task: TaskRow, runId: string,
  workerId: string, expired: boolean) {
  const { operation, releaseDecision } = await lockReleaseForRecovery(tx, task, runId);
  if (operation.state !== 'dispatching') throw new DomainError('unavailable');
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

export const registryRecheckEvent = 'task.release_registry_recheck_started';
const maxRegistryRechecks = 3;

export async function recoverRegistryLease(tx: Transaction, database: Database, task: TaskRow, runId: string, workerId: string,
  reason: TaskEventReason = 'lease_expired') {
  const { operation, releaseDecision } = await lockReleaseForRecovery(tx, task, runId);
  const [intent] = await tx.select({ state: formalReleaseSteps.state }).from(formalReleaseSteps)
    .where(and(eq(formalReleaseSteps.operationId, operation.id), eq(formalReleaseSteps.kind, 'registry'))).for('update');
  if (!intent) throw new DomainError('unavailable');
  const attempts = await tx.select({ sequence: taskEvents.sequence }).from(taskEvents)
    .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.type, registryRecheckEvent),
      sql`${taskEvents.detail}->>'operationId' = ${operation.id}`)).limit(maxRegistryRechecks);
  const queued = attempts.length < maxRegistryRechecks;
  if (queued) {
    const delaySeconds = reason === 'lease_expired' && attempts.length === 0 ? undefined : 1;
    await renewFormalWakeup(tx, database, operation.id, { state: 'reconciling', ...(delaySeconds ? { delaySeconds } : {}) });
  } else if (operation.state !== 'reconciling') {
    await tx.update(releaseOperations).set({ state: 'reconciling', updatedAt: sql`clock_timestamp()` }).where(eq(releaseOperations.id, operation.id));
  }
  await tx.update(runRuntime).set({ reason: 'release_registry_reconciling' }).where(eq(runRuntime.runId, runId));
  await appendEvent(tx, task, queued ? 'task.release_registry_recovered' : 'task.release_registry_manual_review',
    task.state === 'cancel_requested' ? task.state : 'reconciling', {
    workerId, reason, releaseDecision,
  });
  return queued;
}

export const komodoRecheckEvent = {
  komodo_config: 'task.release_komodo_config_recheck_started',
  komodo_dispatch: 'task.release_komodo_dispatch_recheck_started',
} as const;
export type KomodoStepKind = keyof typeof komodoRecheckEvent;
export type KomodoContinuation = 'komodo_ready' | 'requeued' | 'manual_review' | 'awaiting_rollout' | 'cancelled' | 'blocked';
type ReleaseStep = typeof formalReleaseSteps.$inferSelect;
const maxKomodoRechecks = 3;

export async function lockKomodoSteps(tx: Transaction, operationId: string) {
  const steps = await tx.select().from(formalReleaseSteps).where(and(eq(formalReleaseSteps.operationId, operationId),
    inArray(formalReleaseSteps.kind, ['komodo_config', 'komodo_dispatch']))).for('update');
  return {
    config: steps.find(step => step.kind === 'komodo_config'),
    dispatch: steps.find(step => step.kind === 'komodo_dispatch'),
  };
}

export function pendingKomodoStep({ config, dispatch }: { config?: ReleaseStep | undefined; dispatch?: ReleaseStep | undefined }) {
  if (dispatch) return dispatch.state === 'prepared' ? { kind: 'komodo_dispatch' as const, step: dispatch } : null;
  return config?.state === 'prepared' ? { kind: 'komodo_config' as const, step: config } : null;
}

export async function countKomodoRechecks(tx: Transaction, taskId: string, operationId: string, kind: KomodoStepKind) {
  const attempts = await tx.select({ sequence: taskEvents.sequence }).from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.type, komodoRecheckEvent[kind]),
      sql`${taskEvents.detail}->>'operationId' = ${operationId}`)).limit(maxKomodoRechecks);
  return { attempted: attempts.length, exhausted: attempts.length >= maxKomodoRechecks };
}

export async function recoverKomodoLease(tx: Transaction, database: Database, task: TaskRow, runId: string, workerId: string,
  options: { failure?: TaskEventReason; expired?: boolean; fence?: number } = {}): Promise<KomodoContinuation> {
  const { operation, releaseDecision } = await lockReleaseForRecovery(tx, task, runId);
  const steps = await lockKomodoSteps(tx, operation.id);
  const cancelled = task.state === 'cancel_requested';
  const event = { workerId, releaseDecision: { ...releaseDecision, ...(options.fence !== undefined ? { fence: options.fence } : {}) } };
  const changePhase = async (reason: string) => tx.update(runRuntime).set({ reason }).where(eq(runRuntime.runId, runId));
  const keepEnvironment = async () => {
    if (operation.state !== 'reconciling') {
      await tx.update(releaseOperations).set({ state: 'reconciling', updatedAt: sql`clock_timestamp()` })
        .where(eq(releaseOperations.id, operation.id));
    }
  };
  if (steps.dispatch?.state === 'confirmed') {
    await keepEnvironment();
    await changePhase('release_komodo_awaiting_rollout');
    await appendEvent(tx, task, 'task.release_komodo_awaiting_rollout', cancelled ? task.state : 'reconciling', event);
    return 'awaiting_rollout';
  }
  const pending = pendingKomodoStep(steps);
  if (pending) {
    const { attempted, exhausted } = await countKomodoRechecks(tx, task.id, operation.id, pending.kind);
    const needsManual = exhausted || (pending.kind === 'komodo_dispatch' && !pending.step.externalUpdateId);
    if (needsManual) await keepEnvironment();
    else await renewFormalWakeup(tx, database, operation.id, {
      state: 'reconciling', ...((options.expired && attempted === 0) ? {} : { delaySeconds: 2 }),
    });
    await changePhase('release_komodo_reconciling');
    const reason = options.failure ?? (options.expired ? 'lease_expired' : undefined);
    await appendEvent(tx, task, needsManual ? 'task.release_komodo_manual_review' : 'task.release_komodo_reconciling',
      cancelled ? task.state : 'reconciling', { ...event, ...(reason ? { reason } : {}) });
    return needsManual ? 'manual_review' : 'requeued';
  }
  const reason = cancelled ? (options.expired ? 'expired_cancel' : 'cancelled') : options.failure;
  if (reason) {
    await tx.update(releaseOperations).set({ state: 'blocked', updatedAt: sql`clock_timestamp()` })
      .where(eq(releaseOperations.id, operation.id));
    await changePhase(cancelled ? 'release_cancelled' : reason);
    await appendEvent(tx, task, cancelled ? 'task.cancelled' : 'task.release_blocked', cancelled ? 'cancelled' : 'needs_human',
      { ...event, reason });
    return cancelled ? 'cancelled' : 'blocked';
  }
  await renewFormalWakeup(tx, database, operation.id, { state: 'reconciling' });
  await changePhase('release_komodo_ready');
  await appendEvent(tx, task, 'task.release_komodo_ready', 'reconciling', event);
  return 'komodo_ready';
}
