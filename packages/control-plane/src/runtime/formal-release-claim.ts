import { formalReleaseManifestSchema, idSchema, komodoReleasePhases, releaseRegistryOriginSchema, releaseWakeupSchema, type FormalReleaseManifest,
  type FormalReleaseTarget, type TaskEventReason } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { fromDrizzle, type Job } from 'pg-boss';
import { formalReleaseQueue } from '../persistence/database.js';
import { environments, formalReleaseSteps, formalReleaseTargets, releaseCandidates, releaseDecisions, releaseOperations, runRuntime,
  taskRuns, tasks } from '../persistence/schema.js';
import { requireStoredActor, type Transaction } from '../service/access.js';
import { DomainError } from '../service/errors.js';
import { describeVerifiedRelease, latestReleaseCandidate, readReleaseManifest } from '../service/formal-release.js';
import { requireLinkedRepairReleaseTarget } from '../service/operations-repair-proposals.js';
import { readReleaseTarget, type InstalledReleaseTarget } from '../service/release-targets.js';
import { databaseNow } from '../service/releases.js';
import { readPublishedVerification } from '../service/verification-result.js';
import { appendEvent, assertLeaseLive, assignSlot, clearSlot, ExecutionLost, lockExecution, lockSlot, renewSlot,
  type ExecutionScope, type TaskRow } from './authority.js';
import { authorizeRun, type ExecutionCoordinator } from './coordinator.js';
import { requireMatchingRegistryImage } from './formal-release-steps.js';
import { countKomodoRechecks, komodoRecheckEvent, lockKomodoSteps, pendingKomodoStep, recoverClaimedRelease, recoverKomodoLease,
  recoverRegistryLease, registryRecheckEvent, renewFormalWakeup, type KomodoStepKind } from './release-queue.js';

const formalCandidate = sql`${releaseCandidates.document}->>'origin' = 'formal_verification'`;
type ReleaseBlockReason = 'permission_revoked' | 'release_approval_invalid' | 'release_target_changed' | 'release_evidence_changed';

export class ReleaseAuthorityRejected extends Error {
  constructor(readonly reason: ReleaseBlockReason) { super(reason); this.name = 'ReleaseAuthorityRejected'; }
}

export type FormalReleaseScope = ExecutionScope & Readonly<{
  operationId: string; candidateId: string; fingerprint: string; decisionVersion: number;
} & ({ mode: 'import' | 'registry_recovery' | 'komodo_write' } | { mode: 'komodo_recovery'; komodoStep: KomodoStepKind })>;

async function readLink(tx: Transaction, operationId: string) {
  const [link] = await tx.select({ candidate: releaseCandidates, operation: releaseOperations }).from(releaseOperations)
    .innerJoin(releaseCandidates, eq(releaseCandidates.id, releaseOperations.candidateId))
    .where(and(eq(releaseOperations.id, operationId), formalCandidate));
  return link;
}

type ReleaseLink = NonNullable<Awaited<ReturnType<typeof readLink>>>;

async function lockRelease(tx: Transaction, { candidate, operation: link }: ReleaseLink) {
  const [environment] = await tx.select().from(environments).where(eq(environments.id, link.environmentId)).for('update');
  const [operation] = await tx.select().from(releaseOperations).where(eq(releaseOperations.id, link.id)).for('update');
  if (!environment || !operation || operation.candidateId !== candidate.id || operation.environmentId !== candidate.environmentId) {
    throw new DomainError('unavailable');
  }
  return { candidate, operation, environment };
}

async function lockQueuedRelease(tx: Transaction, operationId: string) {
  const link = await readLink(tx, operationId);
  if (!link) return null;
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, link.candidate.taskId)).for('update');
  if (!task || !['queued', 'reconciling', 'cancel_requested'].includes(task.state)) return null;
  const [bound] = await tx.select({ run: taskRuns, runtime: runRuntime }).from(taskRuns)
    .innerJoin(runRuntime, eq(runRuntime.runId, taskRuns.id)).where(eq(taskRuns.id, link.candidate.runId));
  if (!bound || bound.run.taskId !== task.id || bound.runtime.taskId !== task.id || bound.run.generation !== task.generation
      || bound.run.state !== task.state || bound.run.wakeupJobId !== null) return null;
  let mode: FormalReleaseScope['mode'];
  if (task.state === 'queued' && bound.runtime.reason === 'release_queued') mode = 'import';
  else if (task.state === 'queued') return null;
  else if (bound.runtime.reason === 'release_registry_reconciling') mode = 'registry_recovery';
  else if (bound.runtime.reason === 'release_komodo_ready') mode = 'komodo_write';
  else if (bound.runtime.reason === 'release_komodo_reconciling') mode = 'komodo_recovery';
  else return null;
  const release = await lockRelease(tx, link);
  if (release.operation.state !== (mode === 'import' ? 'queued' : 'reconciling') || !release.operation.wakeupJobId) return null;
  return { ...release, task, mode, wakeupJobId: release.operation.wakeupJobId };
}

type LockedRelease = Awaited<ReturnType<typeof lockRelease>>;
const registryObservationPhases = ['release_registry_prepared', 'release_registry_reconciling', 'release_registry_verified'] as const;
const releasePhases = ['release_claimed', ...registryObservationPhases, ...komodoReleasePhases] as const;
type ReleasePhase = typeof releasePhases[number];
type KomodoPhase = typeof komodoReleasePhases[number];
type ReleaseAuthority = Awaited<ReturnType<typeof verifyAuthority>>;
type RegistryIntent = typeof formalReleaseSteps.$inferSelect;
type RegistryObservation = {
  phase: typeof registryObservationPhases[number];
  manifest: FormalReleaseManifest;
  mapping: FormalReleaseTarget & { registryOrigin: string };
  intent: RegistryIntent;
};

export type RegistryPendingReason = 'release_registry_missing' | 'release_registry_unavailable' | 'release_target_changed';

function isReleasePhase(reason: string | null): reason is ReleasePhase {
  return releasePhases.some(phase => phase === reason);
}

function isRegistryObservationPhase(phase: ReleasePhase): phase is RegistryObservation['phase'] {
  return registryObservationPhases.some(candidate => candidate === phase);
}

function isKomodoPhase(phase: ReleasePhase): phase is KomodoPhase {
  return komodoReleasePhases.some(candidate => candidate === phase);
}

async function lockRegistryIntent(tx: Transaction, operationId: string) {
  const [intent] = await tx.select().from(formalReleaseSteps)
    .where(and(eq(formalReleaseSteps.operationId, operationId), eq(formalReleaseSteps.kind, 'registry'))).for('update');
  return intent;
}

function decisionBinding({ operation, candidate }: LockedRelease) {
  return { operationId: operation.id, candidateId: candidate.id, fingerprint: candidate.fingerprint, decisionVersion: operation.approvalVersion };
}

async function verifyTarget(tx: Transaction, task: TaskRow, { candidate, environment }: LockedRelease,
  manifest: FormalReleaseManifest, workerOrigin: string, installed?: InstalledReleaseTarget) {
  const [target] = await tx.select().from(formalReleaseTargets).where(eq(formalReleaseTargets.environmentId, environment.id)).for('share');
  if (!target || environment.access !== 'protected' || target.projectId !== task.projectId || environment.projectId !== task.projectId
      || target.applicationId !== environment.applicationId || target.applicationId !== candidate.applicationId
      || target.revision !== manifest.target.revision || target.sha256 !== manifest.target.mappingSha256
      || (installed && (environment.id !== installed.environmentId || target.sha256 !== installed.mappingSha256))) {
    throw new ReleaseAuthorityRejected('release_target_changed');
  }
  const mapping = readReleaseTarget(target);
  if (mapping.registryOrigin !== workerOrigin) throw new ReleaseAuthorityRejected('release_target_changed');
  return { target, mapping: { ...mapping, registryOrigin: workerOrigin } };
}

export { readLink as readFormalReleaseLink, lockRelease as lockLinkedRelease, verifyTarget as verifyFormalReleaseTarget,
  lockRegistryIntent, decisionBinding as releaseDecisionBinding };

async function verifyAuthority(tx: Transaction, task: TaskRow, release: LockedRelease, workerOrigin: string, installed?: InstalledReleaseTarget) {
  const { operation, candidate } = release;
  const manifest = readReleaseManifest(candidate);
  if (manifest.generation !== task.generation || candidate.requestedBy !== task.requestedBy || candidate.projectId !== task.projectId
      || (await latestReleaseCandidate(tx, task.id))?.id !== candidate.id) throw new ReleaseAuthorityRejected('release_evidence_changed');

  const [last] = await tx.select().from(releaseDecisions).where(eq(releaseDecisions.candidateId, candidate.id))
    .orderBy(desc(releaseDecisions.version)).limit(1);
  if (last?.action !== 'confirm' || last.version !== operation.approvalVersion
      || last.selfConfirmed !== (last.actorId === task.requestedBy)) throw new ReleaseAuthorityRejected('release_approval_invalid');
  const access = await authorizeRun(tx, task, candidate.runId).catch(error => {
    if (error instanceof DomainError && (error.code === 'forbidden' || error.code === 'not_found')) {
      throw new ReleaseAuthorityRejected('permission_revoked');
    }
    throw error;
  });
  const approver = await requireStoredActor(tx, last.actorId);
  if (approver.workspaceId !== access.project.workspaceId || approver.workspaceGrantId !== last.grantId) {
    throw new ReleaseAuthorityRejected('release_approval_invalid');
  }

  const { target, mapping } = await verifyTarget(tx, task, release, manifest, workerOrigin, installed);
  try { await requireLinkedRepairReleaseTarget(tx, task, target.environmentId, access.grantId, operation.id); }
  catch (error) {
    if (error instanceof DomainError) throw new ReleaseAuthorityRejected('release_target_changed');
    throw error;
  }
  const proof = await readPublishedVerification(tx, task, { runId: candidate.runId, generation: task.generation });
  const evidence = proof ? describeVerifiedRelease(proof, target, mapping) : null;
  if (!evidence) throw new ReleaseAuthorityRejected('release_evidence_changed');
  const current = formalReleaseManifestSchema.parse({ ...evidence.manifest, validUntil: manifest.validUntil, evidenceVersion: candidate.evidenceVersion });
  if (sha256(JSON.stringify(current)) !== candidate.fingerprint) throw new ReleaseAuthorityRejected('release_evidence_changed');
  if (Date.parse(manifest.validUntil) <= (await databaseNow(tx)).getTime()) throw new ReleaseAuthorityRejected('release_approval_invalid');
  return { mapping, manifest, archiveVerification: evidence.archiveVerification };
}

export class FormalReleaseCoordinator {
  private readonly workerOrigin: string;
  constructor(private readonly coordinator: ExecutionCoordinator, registryOrigin: string, private readonly installed?: InstalledReleaseTarget) {
    this.workerOrigin = releaseRegistryOriginSchema.parse(registryOrigin);
  }

  async claim(job: Job<unknown>, workerId: string): Promise<FormalReleaseScope | null> {
    idSchema.parse(workerId);
    if (job.name !== formalReleaseQueue || !idSchema.safeParse(job.id).success
        || !Number.isSafeInteger(job.retryCount) || job.retryCount < 0) return null;
    const { database, leaseSeconds } = this.coordinator;
    return database.db.transaction(async tx => {
      await this.coordinator.recoverExpired(tx, workerId);
      const slot = await lockSlot(tx);
      const db = fromDrizzle(tx, sql);
      const [stored] = await database.boss.findJobs<unknown>(formalReleaseQueue, { id: job.id, db });
      if (stored?.state !== 'active' || stored.retryCount !== job.retryCount) return null;
      const settle = () => database.boss.complete(formalReleaseQueue, { id: job.id, retryCount: job.retryCount }, undefined, { db });
      const durable = releaseWakeupSchema.safeParse(stored.data);
      if (!durable.success) { await settle(); return null; }
      const delivered = releaseWakeupSchema.safeParse(job.data);
      if (!delivered.success || delivered.data.operationId !== durable.data.operationId) return null;

      const binding = await lockQueuedRelease(tx, durable.data.operationId);
      if (!binding || binding.wakeupJobId !== job.id) { await settle(); return null; }
      const { operation, candidate, task } = binding;
      const completed = await settle();
      if (completed.affected !== 1) return null;
      if (this.installed && operation.environmentId !== this.installed.environmentId) {
        // Preserve wakeups for other enrolled environments without granting this process a lease on them.
        await renewFormalWakeup(tx, database, operation.id, { state: binding.mode === 'import' ? 'queued' : 'reconciling', delaySeconds: 5 });
        return null;
      }
      if (binding.mode !== 'import' && slot.taskId) {
        await renewFormalWakeup(tx, database, operation.id, { state: 'reconciling', delaySeconds: 1 });
        return null;
      }
      if (binding.mode === 'registry_recovery') {
        const intent = await lockRegistryIntent(tx, operation.id);
        if (!intent) throw new DomainError('unavailable');
        const scope = await assignSlot(tx, task, candidate.runId, workerId, leaseSeconds);
        if (intent.preparedFence >= scope.fence) throw new ExecutionLost();
        await tx.update(releaseOperations).set({ wakeupJobId: null, updatedAt: sql`clock_timestamp()` })
          .where(eq(releaseOperations.id, operation.id));
        const releaseDecision = decisionBinding(binding);
        await appendEvent(tx, task, registryRecheckEvent, task.state === 'cancel_requested' ? task.state : 'running', {
          workerId, releaseDecision: { ...releaseDecision, fence: scope.fence },
        });
        return Object.freeze({ ...scope, ...releaseDecision, mode: binding.mode });
      }
      if (binding.mode !== 'import') return this.claimKomodo(tx, binding, workerId);
      const [hold] = await tx.select({ id: releaseOperations.id }).from(releaseOperations)
        .where(and(eq(releaseOperations.environmentId, operation.environmentId), inArray(releaseOperations.state, ['dispatching', 'reconciling'])))
        .limit(1);
      if (slot.taskId || hold) {
        await renewFormalWakeup(tx, database, operation.id, { delaySeconds: 1 });
        return null;
      }
      const releaseDecision = decisionBinding(binding);
      try { await verifyAuthority(tx, task, binding, this.workerOrigin, this.installed); }
      catch (error) {
        if (!(error instanceof ReleaseAuthorityRejected)) throw error;
        await tx.update(releaseOperations).set({ state: 'blocked', wakeupJobId: null, updatedAt: sql`clock_timestamp()` })
          .where(eq(releaseOperations.id, operation.id));
        await tx.update(runRuntime).set({ reason: error.reason }).where(eq(runRuntime.runId, candidate.runId));
        await appendEvent(tx, task, 'task.release_blocked', 'needs_human', { workerId, reason: error.reason, releaseDecision });
        return null;
      }
      await tx.update(releaseOperations).set({ state: 'dispatching', wakeupJobId: null, updatedAt: sql`clock_timestamp()` })
        .where(eq(releaseOperations.id, operation.id));
      await tx.update(runRuntime).set({ reason: 'release_claimed' }).where(eq(runRuntime.runId, candidate.runId));
      await appendEvent(tx, task, 'task.release_claimed', 'running', { workerId, reason: 'release_claimed', releaseDecision });
      const scope = await assignSlot(tx, task, candidate.runId, workerId, leaseSeconds);
      return Object.freeze({ ...scope, ...releaseDecision, mode: binding.mode });
    });
  }

  private async claimKomodo(tx: Transaction, binding: NonNullable<Awaited<ReturnType<typeof lockQueuedRelease>>>,
    workerId: string): Promise<FormalReleaseScope | null> {
    const { task, candidate, operation, mode } = binding;
    const releaseDecision = decisionBinding(binding);
    const registry = await lockRegistryIntent(tx, operation.id);
    if (registry?.state !== 'confirmed') throw new ExecutionLost();
    const steps = await lockKomodoSteps(tx, operation.id);
    const { leaseSeconds } = this.coordinator;
    if (mode === 'komodo_recovery') {
      const pending = pendingKomodoStep(steps);
      if (!pending || (pending.kind === 'komodo_dispatch' && !pending.step.externalUpdateId)
        || (await countKomodoRechecks(tx, task.id, operation.id, pending.kind)).exhausted) throw new ExecutionLost();
      const scope = await assignSlot(tx, task, candidate.runId, workerId, leaseSeconds);
      if (pending.step.preparedFence >= scope.fence) throw new ExecutionLost();
      await tx.update(releaseOperations).set({ wakeupJobId: null, updatedAt: sql`clock_timestamp()` })
        .where(eq(releaseOperations.id, operation.id));
      await appendEvent(tx, task, komodoRecheckEvent[pending.kind], task.state === 'cancel_requested' ? task.state : 'running',
        { workerId, releaseDecision: { ...releaseDecision, fence: scope.fence } });
      return Object.freeze({ ...scope, ...releaseDecision, mode, komodoStep: pending.kind });
    }
    if (steps.dispatch || pendingKomodoStep(steps)) throw new ExecutionLost();
    let failure: ReleaseBlockReason | 'cancelled' | undefined;
    if (task.state === 'cancel_requested') failure = 'cancelled';
    else {
      try {
        const { manifest, mapping } = await verifyAuthority(tx, task, binding, this.workerOrigin, this.installed);
        if (!mapping.komodo) throw new ReleaseAuthorityRejected('release_target_changed');
        try { requireMatchingRegistryImage(registry.proof, mapping, manifest.image); }
        catch (error) {
          if (error instanceof DomainError) throw new ReleaseAuthorityRejected('release_evidence_changed');
          throw error;
        }
      } catch (error) {
        if (!(error instanceof ReleaseAuthorityRejected)) throw error;
        failure = error.reason;
      }
    }
    if (failure) {
      const cancelled = failure === 'cancelled';
      await tx.update(releaseOperations).set({ state: 'blocked', wakeupJobId: null, updatedAt: sql`clock_timestamp()` })
        .where(eq(releaseOperations.id, operation.id));
      await tx.update(runRuntime).set({ reason: cancelled ? 'release_cancelled' : failure }).where(eq(runRuntime.runId, candidate.runId));
      await appendEvent(tx, task, cancelled ? 'task.cancelled' : 'task.release_blocked', cancelled ? 'cancelled' : 'needs_human',
        { workerId, reason: failure, releaseDecision });
      return null;
    }
    const scope = await assignSlot(tx, task, candidate.runId, workerId, leaseSeconds);
    await tx.update(releaseOperations).set({ state: 'dispatching', wakeupJobId: null, updatedAt: sql`clock_timestamp()` })
      .where(eq(releaseOperations.id, operation.id));
    await appendEvent(tx, task, 'task.release_komodo_claimed', 'running',
      { workerId, releaseDecision: { ...releaseDecision, fence: scope.fence } });
    return Object.freeze({ ...scope, ...releaseDecision, mode });
  }

  private async withClaim<T>(scope: FormalReleaseScope, action: (tx: Transaction, task: TaskRow, release: LockedRelease, phase: ReleasePhase) => Promise<T>,
    allowCancel = false) {
    return this.coordinator.database.db.transaction(async tx => {
      const { slot, task, runtime } = await lockExecution(tx, scope, allowCancel);
      const phase = runtime.reason;
      if (!isReleasePhase(phase)) throw new ExecutionLost();
      const link = await readLink(tx, scope.operationId);
      if (!link || link.candidate.taskId !== task.id || link.candidate.runId !== scope.runId || link.candidate.id !== scope.candidateId
          || link.candidate.fingerprint !== scope.fingerprint || link.operation.approvalVersion !== scope.decisionVersion) throw new ExecutionLost();
      const release = await lockRelease(tx, link);
      const expectedState = phase === 'release_registry_reconciling' || phase === 'release_komodo_reconciling'
        ? 'reconciling' : 'dispatching';
      if (release.operation.state !== expectedState || release.operation.wakeupJobId) throw new ExecutionLost();
      const result = await action(tx, task, release, phase);
      await assertLeaseLive(tx, slot.leaseUntil);
      return result;
    });
  }

  async authorize(scope: FormalReleaseScope) {
    return this.withAuthorizedRelease(scope, async (_tx, _task, _phase, authority) => authority);
  }

  async withAuthorizedRelease<T>(scope: FormalReleaseScope,
    action: (tx: Transaction, task: TaskRow, phase: ReleasePhase, authority: ReleaseAuthority) => Promise<T>) {
    return this.withClaim(scope, async (tx, task, release, phase) => {
      const importing = scope.mode === 'import' && phase !== 'release_registry_reconciling' && phase !== 'release_komodo_ready';
      const dispatching = scope.mode === 'komodo_write' && isKomodoPhase(phase);
      if ((!importing && !dispatching) || phase === 'release_komodo_reconciling' || phase === 'release_komodo_awaiting_rollout') {
        throw new ExecutionLost();
      }
      const authority = await verifyAuthority(tx, task, release, this.workerOrigin, this.installed);
      return action(tx, task, phase, authority);
    });
  }

  async withKomodoObservation<T>(scope: FormalReleaseScope, expected: KomodoPhase,
    observe: (tx: Transaction, task: TaskRow, mapping: RegistryObservation['mapping']) => Promise<T>, allowRecovery = true) {
    return this.withClaim(scope, async (tx, task, release, phase) => {
      const recovering = allowRecovery && scope.mode === 'komodo_recovery' && phase === 'release_komodo_reconciling';
      const original = (scope.mode === 'import' || scope.mode === 'komodo_write') && phase === expected;
      if (!recovering && !original) throw new ExecutionLost();
      const { mapping } = await verifyTarget(tx, task, release, readReleaseManifest(release.candidate), this.workerOrigin, this.installed);
      // A recorded Komodo request can be observed after the approval to write has ended.
      return observe(tx, task, mapping);
    }, true);
  }

  private async withRegistryIntent<T>(scope: FormalReleaseScope,
    action: (tx: Transaction, task: TaskRow, release: LockedRelease, phase: RegistryObservation['phase'], intent: RegistryIntent) => Promise<T>) {
    return this.withClaim(scope, async (tx, task, release, phase) => {
      if (!isRegistryObservationPhase(phase)) throw new DomainError('unsupported_state');
      if (scope.mode !== 'import' && scope.mode !== 'registry_recovery') throw new ExecutionLost();
      const intent = await lockRegistryIntent(tx, scope.operationId);
      if (!intent) throw new ExecutionLost();
      const original = intent.preparedFence === scope.fence && intent.preparedBy === scope.workerId;
      const previous = intent.preparedFence < scope.fence;
      if (scope.mode === 'import' ? !original || phase === 'release_registry_reconciling'
        : !previous || phase === 'release_registry_prepared') throw new ExecutionLost();
      return action(tx, task, release, phase, intent);
    }, true);
  }

  async withRegistryObservation<T>(scope: FormalReleaseScope,
    action: (tx: Transaction, task: TaskRow, observation: RegistryObservation) => Promise<T>) {
    return this.withRegistryIntent(scope, async (tx, task, release, phase, intent) => {
      const manifest = readReleaseManifest(release.candidate);
      const { mapping } = await verifyTarget(tx, task, release, manifest, this.workerOrigin, this.installed);
      // The recorded intent permits outcome checks even if the original permission to write has since ended.
      return action(tx, task, { phase, manifest, mapping, intent });
    });
  }

  async authorizeRegistryWrite(scope: FormalReleaseScope) {
    await this.withAuthorizedRelease(scope, async (tx, _task, phase) => {
      if (scope.mode !== 'import' || phase !== 'release_registry_prepared') throw new ExecutionLost();
      const intent = await lockRegistryIntent(tx, scope.operationId);
      if (intent?.state !== 'prepared' || intent.preparedFence !== scope.fence || intent.preparedBy !== scope.workerId) {
        throw new ExecutionLost();
      }
    });
  }

  async deferRegistryObservation(scope: FormalReleaseScope, reason: RegistryPendingReason) {
    return this.withRegistryIntent(scope, async (tx, task, release, phase, intent) => {
      if (phase === 'release_registry_verified') throw new ExecutionLost();
      let current = task;
      if (intent.state === 'prepared') {
        await tx.update(formalReleaseSteps).set({
          state: 'uncertain', settledFence: scope.fence, settledBy: scope.workerId, settledAt: sql`clock_timestamp()`,
        }).where(and(eq(formalReleaseSteps.operationId, scope.operationId), eq(formalReleaseSteps.kind, 'registry')));
        current = await appendEvent(tx, task, 'task.release_registry_uncertain', task.state, {
          workerId: scope.workerId, reason, releaseDecision: { ...decisionBinding(release), fence: scope.fence },
        });
      }
      const queued = await recoverRegistryLease(tx, this.coordinator.database, current, scope.runId, scope.workerId, reason);
      await clearSlot(tx);
      return queued;
    });
  }

  async settleRegistryCancellation(scope: FormalReleaseScope) {
    return this.withRegistryIntent(scope, async (tx, task, release, phase, intent) => {
      if (phase !== 'release_registry_verified' || intent.state !== 'confirmed') throw new ExecutionLost();
      if (task.state !== 'cancel_requested') return false;
      await tx.update(releaseOperations).set({ state: 'blocked', updatedAt: sql`clock_timestamp()` })
        .where(eq(releaseOperations.id, scope.operationId));
      await tx.update(runRuntime).set({ reason: 'release_cancelled' }).where(eq(runRuntime.runId, scope.runId));
      await appendEvent(tx, task, 'task.cancelled', 'cancelled', {
        workerId: scope.workerId, reason: 'cancelled', releaseDecision: { ...decisionBinding(release), fence: scope.fence },
      });
      await clearSlot(tx);
      return true;
    });
  }

  async handoffKomodo(scope: FormalReleaseScope) {
    return this.withRegistryObservation(scope, async (tx, task, { phase, mapping, manifest, intent }) => {
      if (phase !== 'release_registry_verified' || intent.state !== 'confirmed') throw new ExecutionLost();
      requireMatchingRegistryImage(intent.proof, mapping, manifest.image);
      const next = await recoverKomodoLease(tx, this.coordinator.database, task, scope.runId, scope.workerId, { fence: scope.fence });
      await clearSlot(tx);
      return next;
    });
  }

  async finishKomodo(scope: FormalReleaseScope, failure?: TaskEventReason) {
    return this.withClaim(scope, async (tx, task, _release, phase) => {
      if (!isKomodoPhase(phase) || (scope.mode !== 'komodo_write' && scope.mode !== 'komodo_recovery')) throw new ExecutionLost();
      const next = await recoverKomodoLease(tx, this.coordinator.database, task, scope.runId, scope.workerId,
        { ...(failure ? { failure } : {}), fence: scope.fence });
      await clearSlot(tx);
      return next;
    }, true);
  }

  async stopBeforeRegistry(scope: FormalReleaseScope, blockedReason: ReleaseBlockReason | 'release_archive_unavailable' = 'release_archive_unavailable') {
    return this.withClaim(scope, async (tx, task, release, phase) => {
      if (phase !== 'release_claimed') throw new ExecutionLost();
      const cancelled = task.state === 'cancel_requested';
      const reason = cancelled ? 'cancelled' : blockedReason;
      await tx.update(releaseOperations).set({ state: 'blocked', updatedAt: sql`clock_timestamp()` })
        .where(eq(releaseOperations.id, scope.operationId));
      await tx.update(runRuntime).set({ reason: cancelled ? 'release_cancelled' : reason }).where(eq(runRuntime.runId, scope.runId));
      await appendEvent(tx, task, cancelled ? 'task.cancelled' : 'task.release_blocked', cancelled ? 'cancelled' : 'needs_human', {
        workerId: scope.workerId, reason, releaseDecision: { ...decisionBinding(release), fence: scope.fence },
      });
      await clearSlot(tx);
      return cancelled;
    }, true);
  }

  async heartbeat(scope: FormalReleaseScope) {
    return this.withClaim(scope, async (tx, task, release, phase) => {
      if (phase === 'release_registry_reconciling') throw new ExecutionLost();
      if (task.state === 'cancel_requested') return false;
      await verifyAuthority(tx, task, release, this.workerOrigin, this.installed);
      await renewSlot(tx, this.coordinator.leaseSeconds);
      return true;
    }, true);
  }

  async heartbeatRegistryObservation(scope: FormalReleaseScope) {
    return this.withRegistryIntent(scope, async tx => {
      await renewSlot(tx, this.coordinator.leaseSeconds);
      return true;
    });
  }

  async heartbeatKomodo(scope: FormalReleaseScope) {
    return this.withClaim(scope, async (tx, _task, _release, phase) => {
      if (!isKomodoPhase(phase) || (scope.mode !== 'komodo_write' && scope.mode !== 'komodo_recovery')) throw new ExecutionLost();
      await renewSlot(tx, this.coordinator.leaseSeconds);
      return true;
    }, true);
  }

  async yieldClaim(scope: FormalReleaseScope) {
    return this.withClaim(scope, async (tx, task, _release, phase) => {
      if (phase !== 'release_claimed') throw new DomainError('unsupported_state');
      await recoverClaimedRelease(tx, this.coordinator.database, task, scope.runId, scope.workerId, false);
      await clearSlot(tx);
      return task.state === 'cancel_requested';
    }, true);
  }

  async reconcile(workerId: string) {
    idSchema.parse(workerId);
    const { database, leaseSeconds } = this.coordinator;
    await database.db.transaction(tx => this.coordinator.recoverExpired(tx, workerId));
    const pending = await database.db.select({ id: releaseOperations.id }).from(releaseOperations)
      .innerJoin(releaseCandidates, eq(releaseCandidates.id, releaseOperations.candidateId))
      .where(and(inArray(releaseOperations.state, ['queued', 'reconciling']),
        sql`${releaseOperations.wakeupJobId} IS NOT NULL`, formalCandidate)).orderBy(releaseOperations.createdAt).limit(20);
    for (const { id } of pending) {
      await database.db.transaction(async tx => {
        await lockSlot(tx);
        const binding = await lockQueuedRelease(tx, id);
        if (!binding) return;
        const db = fromDrizzle(tx, sql);
        const [job] = await database.boss.findJobs<unknown>(formalReleaseQueue, { id: binding.wakeupJobId, db });
        const input = releaseWakeupSchema.safeParse(job?.data);
        if (input.success && input.data.operationId === id) {
          if (job?.state === 'created' || job?.state === 'retry') return;
          if (job?.state === 'active' && job.startedOn
              && new Date(job.startedOn).getTime() + leaseSeconds * 1000 > (await databaseNow(tx)).getTime()) return;
        }
        if (job?.state === 'active') await database.boss.cancel(formalReleaseQueue, job, { db });
        if (job?.state === 'created' || job?.state === 'retry') await database.boss.cancel(formalReleaseQueue, job.id, { db });
        await renewFormalWakeup(tx, database, id, { state: binding.mode === 'import' ? 'queued' : 'reconciling' });
      });
    }
  }
}
