import { idSchema, releaseKomodoCompletionSchema, releaseKomodoIntentSchema, releaseRegistryOriginSchema, releaseRolloutFailureSchema,
  releaseRolloutProofSchema, type ReleaseRolloutFailure, type ReleaseRolloutProof } from '@itervane/contracts';
import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { Database } from '../persistence/database.js';
import { executionSlot, formalReleaseRolloutAttempts, formalReleaseTargets, releaseCandidates, releaseDecisions,
  releaseOperations, runRuntime, taskRuns, tasks } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { readReleaseManifest } from '../service/formal-release.js';
import type { InstalledReleaseTarget } from '../service/release-targets.js';
import { databaseNow } from '../service/releases.js';
import { appendEvent, ExecutionLost } from './authority.js';
import { targetForKomodo } from './formal-komodo-steps.js';
import { lockLinkedRelease, lockRegistryIntent, readFormalReleaseLink, releaseDecisionBinding, verifyFormalReleaseTarget } from './formal-release-claim.js';
import { requireMatchingRegistryImage } from './formal-release-steps.js';
import { lockKomodoSteps } from './release-queue.js';

const awaitingRollout = 'release_komodo_awaiting_rollout';
const observationStates = ['reconciling', 'cancel_requested'] as const;
const maxRolloutAttempts = 3;
const maxRolloutLeaseSeconds = 45;

export type FormalRolloutScope = Readonly<{ operationId: string; workerId: string; fence: number }>;
type RolloutAttempt = typeof formalReleaseRolloutAttempts.$inferSelect;
type RolloutResult = { state: 'verified'; proof: ReleaseRolloutProof } | { state: 'rejected'; failure: ReleaseRolloutFailure };

function attemptIdentity(scope: FormalRolloutScope) {
  return and(eq(formalReleaseRolloutAttempts.operationId, scope.operationId), eq(formalReleaseRolloutAttempts.workerId, scope.workerId),
    eq(formalReleaseRolloutAttempts.fence, scope.fence), eq(formalReleaseRolloutAttempts.state, 'observing'));
}

async function lockPendingRollout(tx: Transaction, operationId: string) {
  const link = await readFormalReleaseLink(tx, operationId);
  if (!link) return null;
  const [task] = await tx.select().from(tasks).where(and(eq(tasks.id, link.candidate.taskId), inArray(tasks.state, observationStates))).for('update');
  if (!task) return null;
  const [run] = await tx.select({ id: taskRuns.id }).from(taskRuns)
    .innerJoin(runRuntime, eq(runRuntime.runId, taskRuns.id))
    .where(and(eq(taskRuns.id, link.candidate.runId), eq(taskRuns.taskId, task.id), eq(runRuntime.taskId, task.id),
      eq(taskRuns.generation, task.generation), eq(taskRuns.state, task.state), isNull(taskRuns.wakeupJobId), eq(runRuntime.reason, awaitingRollout)));
  if (!run) return null;
  const release = await lockLinkedRelease(tx, link);
  if (release.operation.state !== 'reconciling' || release.operation.wakeupJobId !== null) return null;
  const [writer] = await tx.select({ id: executionSlot.id }).from(executionSlot).where(eq(executionSlot.taskId, task.id));
  if (writer) return null;
  return { ...release, task };
}

type PendingRollout = NonNullable<Awaited<ReturnType<typeof lockPendingRollout>>>;

async function readRolloutBinding(tx: Transaction, pending: PendingRollout, workerOrigin: string, installed?: InstalledReleaseTarget) {
  const { candidate, task, operation } = pending;
  const manifest = readReleaseManifest(candidate);
  if (task.generation !== manifest.generation || task.requestedBy !== candidate.requestedBy) throw new ExecutionLost();
  const { mapping } = await verifyFormalReleaseTarget(tx, task, pending, manifest, workerOrigin, installed);
  if (!mapping.rolloutCheck || mapping.rolloutCheckSha256 !== manifest.rolloutCheckSha256 ||
      mapping.runtimeConfigSha256 !== manifest.runtimeConfigSha256) throw new ExecutionLost();
  const target = targetForKomodo(mapping);
  // The approved request already happened. Rechecking its effects uses the historical confirm, even after cancellation or revocation.
  const [approved] = await tx.select().from(releaseDecisions).where(and(eq(releaseDecisions.candidateId, candidate.id),
    eq(releaseDecisions.version, operation.approvalVersion), eq(releaseDecisions.action, 'confirm')));
  if (!approved || approved.selfConfirmed !== (approved.actorId === task.requestedBy)) throw new ExecutionLost();
  const registry = await lockRegistryIntent(tx, operation.id);
  const { config, dispatch } = await lockKomodoSteps(tx, operation.id);
  if (registry?.state !== 'confirmed' || config?.state !== 'confirmed' || dispatch?.state !== 'confirmed') throw new ExecutionLost();
  const image = requireMatchingRegistryImage(registry.proof, mapping, manifest.image);
  const intent = releaseKomodoIntentSchema.parse(dispatch.intent);
  const update = releaseKomodoCompletionSchema.parse(dispatch.proof);
  if (update.updateId !== dispatch.externalUpdateId || update.deploymentId !== target.deploymentId || update.actorId !== target.komodo.actorId ||
      intent.deploymentId !== target.deploymentId || intent.serverId !== target.serverId || intent.origin !== target.komodo.origin ||
      intent.actorId !== target.komodo.actorId || intent.runtimeConfigSha256 !== target.runtimeConfigSha256 ||
      intent.revision !== manifest.target.revision || intent.mappingSha256 !== manifest.target.mappingSha256 ||
      intent.imageReference !== image.reference) throw new ExecutionLost();
  return { target, check: mapping.rolloutCheck, rolloutCheckSha256: manifest.rolloutCheckSha256, manifest, image, update,
    decision: releaseDecisionBinding(pending) };
}

async function expireAttempt(tx: Transaction, attempt: RolloutAttempt, workerId: string) {
  const pending = await lockPendingRollout(tx, attempt.operationId);
  const exhausted = attempt.fence === maxRolloutAttempts;
  const [expired] = await tx.update(formalReleaseRolloutAttempts).set({ state: exhausted ? 'manual_review' : 'expired' })
    .where(and(attemptIdentity(attempt), sql`${formalReleaseRolloutAttempts.leaseUntil} <= clock_timestamp()`)).returning();
  if (expired && exhausted && pending) {
    await tx.update(runRuntime).set({ reason: 'release_rollout_manual_review' }).where(eq(runRuntime.runId, pending.candidate.runId));
    await appendEvent(tx, pending.task, 'task.release_rollout_manual_review', 'needs_human', {
      workerId, reason: 'release_rollout_limit', releaseDecision: { ...releaseDecisionBinding(pending), rolloutFence: attempt.fence },
    });
  }
}

export class FormalRolloutCoordinator {
  private readonly workerOrigin: string;

  constructor(private readonly database: Database, workerOrigin: string, private readonly leaseSeconds = maxRolloutLeaseSeconds,
    private readonly installed?: InstalledReleaseTarget) {
    this.workerOrigin = releaseRegistryOriginSchema.parse(workerOrigin);
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > maxRolloutLeaseSeconds) throw new Error('invalid_rollout_lease');
  }

  async claimNext(workerId: string): Promise<FormalRolloutScope | null> {
    idSchema.parse(workerId);
    return this.database.db.transaction(async tx => {
      // All contenders use this independent scheduling lock. The database also enforces the single observing lease.
      const guard = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock(hashtextextended('itervane:formal-rollout:v1', 0)) AS locked`);
      if (!guard.rows[0]?.locked) return null;
      const [observing] = await tx.select().from(formalReleaseRolloutAttempts).where(eq(formalReleaseRolloutAttempts.state, 'observing'));
      if (observing) {
        if (observing.leaseUntil > await databaseNow(tx)) return null;
        await expireAttempt(tx, observing, workerId);
      }
      const exhausted = tx.select({ id: formalReleaseRolloutAttempts.operationId }).from(formalReleaseRolloutAttempts)
        .where(eq(formalReleaseRolloutAttempts.fence, maxRolloutAttempts));
      const [next] = await tx.select({ operationId: releaseOperations.id }).from(releaseOperations)
        .innerJoin(releaseCandidates, eq(releaseCandidates.id, releaseOperations.candidateId))
        .innerJoin(runRuntime, eq(runRuntime.runId, releaseCandidates.runId))
        .innerJoin(formalReleaseTargets, eq(formalReleaseTargets.environmentId, releaseOperations.environmentId))
        .where(and(eq(releaseOperations.state, 'reconciling'), isNull(releaseOperations.wakeupJobId), eq(runRuntime.reason, awaitingRollout),
          sql`jsonb_typeof(${formalReleaseTargets.document}->'rolloutCheck') = 'object'`, notInArray(releaseOperations.id, exhausted),
          this.installed && eq(formalReleaseTargets.environmentId, this.installed.environmentId),
          this.installed && eq(formalReleaseTargets.sha256, this.installed.mappingSha256)))
        .orderBy(asc(releaseOperations.createdAt), asc(releaseOperations.id)).limit(1);
      if (!next) return null;
      const pending = await lockPendingRollout(tx, next.operationId);
      if (!pending) return null;
      await readRolloutBinding(tx, pending, this.workerOrigin, this.installed);
      const [previous] = await tx.select({ fence: formalReleaseRolloutAttempts.fence }).from(formalReleaseRolloutAttempts)
        .where(eq(formalReleaseRolloutAttempts.operationId, next.operationId)).orderBy(desc(formalReleaseRolloutAttempts.fence)).limit(1);
      const fence = (previous?.fence ?? 0) + 1;
      const scope = Object.freeze({ operationId: next.operationId, workerId, fence });
      await tx.insert(formalReleaseRolloutAttempts).values({ ...scope,
        leaseUntil: sql`clock_timestamp() + ${this.leaseSeconds} * interval '1 second'` });
      await appendEvent(tx, pending.task, 'task.release_rollout_claimed', pending.task.state, {
        workerId, releaseDecision: { ...releaseDecisionBinding(pending), rolloutFence: fence },
      });
      return scope;
    });
  }

  private async withObservation<T>(scope: FormalRolloutScope, action: (tx: Transaction, pending: PendingRollout,
    binding: Awaited<ReturnType<typeof readRolloutBinding>>) => Promise<T>) {
    return this.database.db.transaction(async tx => {
      const pending = await lockPendingRollout(tx, scope.operationId);
      if (!pending) throw new ExecutionLost();
      const [attempt] = await tx.select().from(formalReleaseRolloutAttempts).where(attemptIdentity(scope)).for('update');
      if (!attempt || attempt.leaseUntil <= await databaseNow(tx)) throw new ExecutionLost();
      const binding = await readRolloutBinding(tx, pending, this.workerOrigin, this.installed);
      const result = await action(tx, pending, binding);
      if (attempt.leaseUntil <= await databaseNow(tx)) throw new ExecutionLost();
      return result;
    });
  }

  async authorize(scope: FormalRolloutScope) {
    return this.withObservation(scope, async (_tx, _pending, binding) => binding);
  }

  async settle(scope: FormalRolloutScope, proof: unknown) {
    return this.finishObservation(scope, { state: 'verified', proof: releaseRolloutProofSchema.parse(proof) });
  }

  async requireManualReview(scope: FormalRolloutScope, failure: ReleaseRolloutFailure) {
    return this.finishObservation(scope, { state: 'rejected', failure: releaseRolloutFailureSchema.parse(failure) });
  }

  private async finishObservation(scope: FormalRolloutScope, result: RolloutResult) {
    return this.withObservation(scope, async (tx, pending) => {
      const [attempt] = await tx.update(formalReleaseRolloutAttempts).set(result)
        .where(and(attemptIdentity(scope), sql`${formalReleaseRolloutAttempts.leaseUntil} > clock_timestamp()`))
        .returning({ completedAt: formalReleaseRolloutAttempts.completedAt });
      if (!attempt?.completedAt) throw new ExecutionLost();

      const event = { workerId: scope.workerId, releaseDecision: { ...releaseDecisionBinding(pending), rolloutFence: scope.fence } };
      if (result.state === 'rejected') {
        await tx.update(runRuntime).set({ reason: 'release_rollout_manual_review' }).where(eq(runRuntime.runId, pending.candidate.runId));
        await appendEvent(tx, pending.task, 'task.release_rollout_manual_review', 'needs_human', { ...event, reason: result.failure });
        return 'manual_review' as const;
      }

      await tx.update(releaseOperations).set({ state: 'verified_formal', updatedAt: attempt.completedAt })
        .where(eq(releaseOperations.id, scope.operationId));
      await tx.update(runRuntime).set({ reason: 'release_rollout_verified' }).where(eq(runRuntime.runId, pending.candidate.runId));
      await appendEvent(tx, pending.task, 'task.release_rollout_verified',
        pending.task.state === 'cancel_requested' ? 'cancelled' : 'succeeded', event);
      return 'verified_formal' as const;
    });
  }
}
