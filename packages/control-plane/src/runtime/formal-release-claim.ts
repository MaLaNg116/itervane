import { formalReleaseManifestSchema, idSchema, releaseRegistryOriginSchema, releaseWakeupSchema, type FormalReleaseManifest,
  type FormalReleaseTarget } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { fromDrizzle, type Job } from 'pg-boss';
import { formalReleaseQueue } from '../persistence/database.js';
import { environments, formalReleaseSteps, formalReleaseTargets, releaseCandidates, releaseDecisions, releaseOperations, runRuntime,
  taskRuns, tasks } from '../persistence/schema.js';
import { requireStoredActor, type Transaction } from '../service/access.js';
import { DomainError } from '../service/errors.js';
import { describeVerifiedRelease, latestReleaseCandidate, readReleaseManifest } from '../service/formal-release.js';
import { readReleaseTarget } from '../service/release-targets.js';
import { databaseNow } from '../service/releases.js';
import { readPublishedVerification } from '../service/verification-result.js';
import { appendEvent, assertLeaseLive, assignSlot, clearSlot, ExecutionLost, lockExecution, lockSlot, renewSlot,
  type ExecutionScope, type TaskRow } from './authority.js';
import { authorizeRun, type ExecutionCoordinator } from './coordinator.js';
import { recoverClaimedRelease, renewFormalWakeup } from './release-queue.js';

const formalCandidate = sql`${releaseCandidates.document}->>'origin' = 'formal_verification'`;
type ReleaseBlockReason = 'permission_revoked' | 'release_approval_invalid' | 'release_target_changed' | 'release_evidence_changed';

export class ReleaseAuthorityRejected extends Error {
  constructor(readonly reason: ReleaseBlockReason) { super(reason); this.name = 'ReleaseAuthorityRejected'; }
}

export type FormalReleaseScope = ExecutionScope & Readonly<{
  operationId: string; candidateId: string; fingerprint: string; decisionVersion: number;
}>;

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
  if (task?.state !== 'queued') return null;
  const [bound] = await tx.select({ run: taskRuns, runtime: runRuntime }).from(taskRuns)
    .innerJoin(runRuntime, eq(runRuntime.runId, taskRuns.id)).where(eq(taskRuns.id, link.candidate.runId));
  if (!bound || bound.run.taskId !== task.id || bound.runtime.taskId !== task.id || bound.run.generation !== task.generation
      || bound.run.state !== 'queued' || bound.run.wakeupJobId !== null || bound.runtime.reason !== 'release_queued') return null;
  const release = await lockRelease(tx, link);
  if (release.operation.state !== 'queued' || !release.operation.wakeupJobId) return null;
  return { ...release, task, wakeupJobId: release.operation.wakeupJobId };
}

type LockedRelease = Awaited<ReturnType<typeof lockRelease>>;
type ReleasePhase = 'release_claimed' | 'release_registry_prepared' | 'release_registry_verified';
type ReleaseAuthority = Awaited<ReturnType<typeof verifyAuthority>>;
type RegistryObservation = {
  phase: Exclude<ReleasePhase, 'release_claimed'>;
  manifest: FormalReleaseManifest;
  mapping: FormalReleaseTarget;
  intent: typeof formalReleaseSteps.$inferSelect;
};

function decisionBinding({ operation, candidate }: LockedRelease) {
  return { operationId: operation.id, candidateId: candidate.id, fingerprint: candidate.fingerprint, decisionVersion: operation.approvalVersion };
}

async function verifyTarget(tx: Transaction, task: TaskRow, { candidate, environment }: LockedRelease,
  manifest: FormalReleaseManifest, workerOrigin: string) {
  const [target] = await tx.select().from(formalReleaseTargets).where(eq(formalReleaseTargets.environmentId, environment.id)).for('share');
  if (!target || environment.access !== 'protected' || target.projectId !== task.projectId || environment.projectId !== task.projectId
      || target.applicationId !== environment.applicationId || target.applicationId !== candidate.applicationId
      || target.revision !== manifest.target.revision || target.sha256 !== manifest.target.mappingSha256) {
    throw new ReleaseAuthorityRejected('release_target_changed');
  }
  const mapping = readReleaseTarget(target);
  if (mapping.registryOrigin !== workerOrigin) throw new ReleaseAuthorityRejected('release_target_changed');
  return { target, mapping };
}

async function verifyAuthority(tx: Transaction, task: TaskRow, release: LockedRelease, workerOrigin: string) {
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

  const { target, mapping } = await verifyTarget(tx, task, release, manifest, workerOrigin);
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
  constructor(private readonly coordinator: ExecutionCoordinator, registryOrigin: string) {
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
      const [hold] = await tx.select({ id: releaseOperations.id }).from(releaseOperations)
        .where(and(eq(releaseOperations.environmentId, operation.environmentId), inArray(releaseOperations.state, ['dispatching', 'reconciling'])))
        .limit(1);
      if (slot.taskId || hold) {
        await renewFormalWakeup(tx, database, operation.id, true);
        return null;
      }
      const releaseDecision = decisionBinding(binding);
      try { await verifyAuthority(tx, task, binding, this.workerOrigin); }
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
      return Object.freeze({ ...scope, ...releaseDecision });
    });
  }

  private async withClaim<T>(scope: FormalReleaseScope, action: (tx: Transaction, task: TaskRow, release: LockedRelease, phase: ReleasePhase) => Promise<T>,
    allowCancel = false) {
    return this.coordinator.database.db.transaction(async tx => {
      const { slot, task, runtime } = await lockExecution(tx, scope, allowCancel);
      const phase = runtime.reason;
      if (phase !== 'release_claimed' && phase !== 'release_registry_prepared' && phase !== 'release_registry_verified') throw new ExecutionLost();
      const link = await readLink(tx, scope.operationId);
      if (!link || link.candidate.taskId !== task.id || link.candidate.runId !== scope.runId || link.candidate.id !== scope.candidateId
          || link.candidate.fingerprint !== scope.fingerprint || link.operation.approvalVersion !== scope.decisionVersion) throw new ExecutionLost();
      const release = await lockRelease(tx, link);
      if (release.operation.state !== 'dispatching') throw new ExecutionLost();
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
      const authority = await verifyAuthority(tx, task, release, this.workerOrigin);
      return action(tx, task, phase, authority);
    });
  }

  async withRegistryObservation<T>(scope: FormalReleaseScope,
    action: (tx: Transaction, task: TaskRow, observation: RegistryObservation) => Promise<T>) {
    return this.withClaim(scope, async (tx, task, release, phase) => {
      if (phase === 'release_claimed') throw new DomainError('unsupported_state');
      const [intent] = await tx.select().from(formalReleaseSteps)
        .where(and(eq(formalReleaseSteps.operationId, scope.operationId), eq(formalReleaseSteps.kind, 'registry'))).for('update');
      if (!intent || intent.preparedFence !== scope.fence) throw new ExecutionLost();
      const manifest = readReleaseManifest(release.candidate);
      const { mapping } = await verifyTarget(tx, task, release, manifest, this.workerOrigin);
      // The recorded intent permits outcome checks even if the original permission to write has since ended.
      return action(tx, task, { phase, manifest, mapping, intent });
    }, true);
  }

  async heartbeat(scope: FormalReleaseScope) {
    return this.withClaim(scope, async (tx, task, release) => {
      if (task.state === 'cancel_requested') return false;
      await verifyAuthority(tx, task, release, this.workerOrigin);
      await renewSlot(tx, this.coordinator.leaseSeconds);
      return true;
    }, true);
  }

  async yieldClaim(scope: FormalReleaseScope) {
    await this.withClaim(scope, async (tx, task, _release, phase) => {
      if (phase !== 'release_claimed') throw new DomainError('unsupported_state');
      await recoverClaimedRelease(tx, this.coordinator.database, task, scope.runId, scope.workerId, false);
      await clearSlot(tx);
    }, true);
  }

  async reconcile(workerId: string) {
    idSchema.parse(workerId);
    const { database, leaseSeconds } = this.coordinator;
    await database.db.transaction(tx => this.coordinator.recoverExpired(tx, workerId));
    const pending = await database.db.select({ id: releaseOperations.id }).from(releaseOperations)
      .innerJoin(releaseCandidates, eq(releaseCandidates.id, releaseOperations.candidateId))
      .where(and(eq(releaseOperations.state, 'queued'), formalCandidate)).orderBy(releaseOperations.createdAt).limit(20);
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
        await renewFormalWakeup(tx, database, id);
      });
    }
  }
}
