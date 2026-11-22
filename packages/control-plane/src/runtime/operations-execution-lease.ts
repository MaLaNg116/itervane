import {
  idSchema, maxOperationsRestartResumes, operationsRestartApprovalInputSchema, operationsRestartContinueInputSchema,
  operationsRestartResumeBindingSchema, operationsRestartResumeOutcomeSchema, operationsRestartWriterProofSchema,
  type OperationsRestartInstallation, type OperationsRestartWriterProof,
} from '@itervane/contracts';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { fromDrizzle, type Job } from 'pg-boss';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { OperationsEnrollmentScope } from '../config.js';
import { operationsExecutionQueue, type Database } from '../persistence/database.js';
import { operationsExecutionIntents, operationsExecutionSchedules, operationsExecutions, operationsProposals, operationsRestartResumes,
  runRuntime, taskRuns, tasks } from '../persistence/schema.js';
import { isHumanWorkspaceOwner, requireActor, requireProjectAccess, type Transaction } from '../service/access.js';
import { expireUndispatchedOperations, lockEnvironmentForEffect } from '../service/environment-effects.js';
import { DomainError, parseInput } from '../service/errors.js';
import { lockOperationsDiagnosisTask, requireOperationsExecutionApproval } from '../service/operations-execution-admission.js';
import { readOperationsProposal } from '../service/operations-proposals.js';
import { requireOperationsRestartWriter } from '../service/operations-restart-installations.js';
import { databaseNow } from '../service/releases.js';
import { appendEvent, assertLeaseLive, assignSlot, clearSlot, ExecutionLost, lockExecution, lockSlot, renewSlot,
  type ExecutionScope } from './authority.js';
import type { ExecutionCoordinator } from './coordinator.js';
import { closeUndispatchedOperationsExecution, operationsExecutionWakeupSchema, replaceOperationsExecutionWakeup } from './operations-execution-queue.js';
import { attachOperationsRestartApproval, prepareOperationsRestartRequest, readOperationsRestartRequest, readOperationsRestartSubject } from './operations-restart-request.js';
import { findActiveRestartRecovery, finishRestartRecovery, proveRestartRecovery, readRestartRecoveryBinding, startRestartRecovery,
  type RecoveryFailure } from './operations-restart-recovery.js';
import { blockQueuedRestartResume, latestRestartResume } from './operations-restart-resume.js';
import { matchRestartBaseline } from './release-rollout.js';

export type OperationsExecutionLease = ExecutionScope & Readonly<{ executionId: string; mode: 'dispatch' | 'restart_resume' | 'reconcile' }>;

// Callers lock the execution slot first. The diagnosis and environment locks also serialize approval and release.
async function lockOperationsExecution(tx: Transaction, executionId: string) {
  const [proposal] = await tx.select({ row: operationsProposals }).from(operationsExecutions)
    .innerJoin(operationsProposals, eq(operationsProposals.id, operationsExecutions.proposalId))
    .where(eq(operationsExecutions.id, executionId));
  if (!proposal) return;
  const diagnosis = await lockOperationsDiagnosisTask(tx, proposal.row);
  await lockEnvironmentForEffect(tx, proposal.row.environmentId);
  const execution = alias(operationsExecutions, 'execution');
  const schedule = alias(operationsExecutionSchedules, 'schedule');
  const task = alias(tasks, 'execution_task');
  const [current] = await tx.select({ execution, schedule, task, reason: runRuntime.reason, intent: operationsExecutionIntents })
    .from(execution).innerJoin(schedule, eq(schedule.executionId, execution.id)).innerJoin(task, eq(task.id, schedule.taskId))
    .innerJoin(taskRuns, and(eq(taskRuns.id, schedule.runId), eq(taskRuns.taskId, task.id), eq(taskRuns.generation, task.generation),
      eq(taskRuns.state, task.state), eq(taskRuns.role, 'operations')))
    .innerJoin(runRuntime, and(eq(runRuntime.runId, taskRuns.id), eq(runRuntime.taskId, task.id)))
    .leftJoin(operationsExecutionIntents, eq(operationsExecutionIntents.executionId, execution.id))
    .where(eq(execution.id, executionId)).for('update', { of: [execution, schedule, task] });
  if (current) return { ...current, diagnosis, proposal: proposal.row };
}

type BoundExecution = NonNullable<Awaited<ReturnType<typeof lockOperationsExecution>>>;
type ApprovedExecution = Awaited<ReturnType<typeof requireOperationsExecutionApproval>>;

async function requireRestartRecoveryAttempt(tx: Transaction, scope: OperationsExecutionLease) {
  if (scope.mode !== 'reconcile') throw new ExecutionLost();
  const attempt = await findActiveRestartRecovery(tx, scope);
  if (!attempt) throw new ExecutionLost();
  return attempt;
}

async function requireSavedRestartWriter(tx: Transaction, target: OperationsEnrollmentScope, whiskers: OperationsRestartInstallation['whiskers'],
  request: Awaited<ReturnType<typeof readOperationsRestartRequest>>, expected?: OperationsRestartWriterProof) {
  if (!request.writerInstallationId) throw new DomainError('unsupported_state');
  if (expected && (expected.installationId !== request.writerInstallationId || expected.credentialSha256 !== request.document.credentialSha256)) {
    throw new DomainError('version_conflict');
  }
  await requireOperationsRestartWriter(tx, target, whiskers, expected ?? {
    installationId: request.writerInstallationId, credentialSha256: request.document.credentialSha256,
  });
}

async function readRestartContinuation(tx: Transaction, executionId: string, authority: ApprovedExecution, proof: OperationsRestartWriterProof) {
  const { frozen, whiskers, decision } = authority;
  const request = await readOperationsRestartRequest(tx, executionId);
  if (!request.approvalId || request.writerInstallationId !== proof.installationId
      || request.document.credentialSha256 !== proof.credentialSha256 || request.document.target.containerId !== frozen.target.containerId
      || request.document.target.origin !== whiskers.origin || request.document.target.serverId !== whiskers.serverId) {
    throw new DomainError('version_conflict');
  }
  await requireOperationsRestartWriter(tx, frozen.target, whiskers, proof);
  const resume = await latestRestartResume(tx, executionId);
  if (resume?.state !== 'queued' || resume.approvalId !== request.approvalId || resume.callSha256 !== request.callSha256
      || resume.actorId !== decision.actorId || resume.grantId !== decision.grantId) throw new ExecutionLost();
  return { request, resume, approval: { approvalId: request.approvalId, callSha256: request.callSha256 } };
}

function wakeupMode({ execution, task, reason, intent }: BoundExecution): OperationsExecutionLease['mode'] | undefined {
  if (execution.state !== 'reserved') return;
  if (!intent && task.state === 'queued' && reason === 'operations_execution_queued') return 'dispatch';
  if (intent && task.state === 'queued' && reason === 'operations_restart_resume_queued') return 'restart_resume';
  if (intent && task.state === 'reconciling' && reason === 'operations_execution_reconciling') return 'reconcile';
}

async function reconcileBlockedRestartResume(tx: Transaction, database: Database, { execution, schedule, task }: BoundExecution, workerId: string) {
  const blocked = await blockQueuedRestartResume(tx, execution.id);
  const reason = 'operations_execution_reconciling';
  await tx.update(runRuntime).set({ reason }).where(eq(runRuntime.runId, schedule.runId));
  await appendEvent(tx, task, 'task.operations_execution_recovered', 'reconciling', {
    workerId, reason, operationsExecution: { executionId: execution.id, proposalId: execution.proposalId, resumeAttempt: blocked.attempt },
  });
  await replaceOperationsExecutionWakeup(tx, database, schedule, task.generation);
}

export async function recoverOperationsExecutionSlot(tx: Transaction, database: Database,
  slot: Awaited<ReturnType<typeof lockSlot>>, workerId: string) {
  if (!slot.taskId) return false;
  const [linked] = await tx.select({ id: operationsExecutions.id, state: operationsExecutions.state }).from(operationsExecutionSchedules)
    .innerJoin(operationsExecutions, eq(operationsExecutions.id, operationsExecutionSchedules.executionId))
    .where(eq(operationsExecutionSchedules.taskId, slot.taskId));
  if (!linked) return false;
  if (slot.live && linked.state === 'reserved') return true;

  const bound = await lockOperationsExecution(tx, linked.id);
  if (!bound || bound.schedule.runId !== slot.runId || bound.schedule.wakeupJobId) throw new ExecutionLost();
  const { execution, schedule, task, intent } = bound;
  if (!slot.live && slot.workerId && bound.reason === 'operations_execution_reconciling') {
    const attempt = await findActiveRestartRecovery(tx, { executionId: execution.id, fence: slot.fence, workerId: slot.workerId });
    if (attempt) {
      await finishRestartRecovery(tx, database, bound, attempt, workerId, { failure: 'lease_expired' });
      return true;
    }
  }
  if (execution.state === 'blocked') {
    if (intent || (task.state !== 'cancelled' && task.state !== 'needs_human')) throw new ExecutionLost();
  } else {
    if (task.state !== 'running') throw new ExecutionLost();
    const expired = !intent && await expireUndispatchedOperations(tx, database, execution.environmentId, task.requestedBy, workerId);
    if (!expired) {
      const restartUnsent = bound.reason === 'operations_restart_resume_claimed' && (await latestRestartResume(tx, execution.id))?.state === 'queued';
      const reason = restartUnsent ? 'operations_restart_resume_queued' : intent ? 'operations_execution_reconciling' : 'operations_execution_queued';
      await tx.update(runRuntime).set({ reason }).where(eq(runRuntime.runId, schedule.runId));
      await appendEvent(tx, task, 'task.operations_execution_recovered', reason === 'operations_execution_reconciling' ? 'reconciling' : 'queued', {
        workerId, reason, operationsExecution: { executionId: execution.id, proposalId: execution.proposalId, fence: slot.fence },
      });
      await replaceOperationsExecutionWakeup(tx, database, schedule, task.generation);
    }
  }
  await clearSlot(tx);
  return true;
}

export class OperationsExecutionCoordinator {
  constructor(private readonly coordinator: ExecutionCoordinator, private readonly installation: OperationsEnrollmentScope,
    private readonly humanClientId?: string) {}

  get leaseSeconds() { return this.coordinator.leaseSeconds; }

  async claim(job: Job<unknown>, workerId: string, supportedAction?: 'restart'): Promise<OperationsExecutionLease | null> {
    idSchema.parse(workerId);
    const database = this.coordinator.database;
    const request = operationsExecutionWakeupSchema.safeParse(job.data);
    return database.db.transaction(async tx => {
      await this.coordinator.recoverExpired(tx, workerId);
      const slot = await lockSlot(tx);
      const complete = () => database.boss.complete(operationsExecutionQueue, job, undefined, { db: fromDrizzle(tx, sql) });
      const wakeup = request.success ? request.data : undefined;
      const bound = wakeup ? await lockOperationsExecution(tx, wakeup.executionId) : undefined;
      const mode = bound && wakeupMode(bound);
      if (!bound || !mode || bound.task.id !== wakeup?.taskId || bound.schedule.runId !== wakeup.runId
          || bound.task.generation !== wakeup.generation || bound.schedule.wakeupJobId !== job.id) {
        await complete();
        return null;
      }

      const { execution, schedule, task, proposal, diagnosis } = bound;
      if (mode === 'dispatch' && await expireUndispatchedOperations(tx, database, execution.environmentId, task.requestedBy, workerId)) return null;
      const { target, action } = readOperationsProposal(proposal);
      const eligible = !slot.taskId && target.environmentId === this.installation.environmentId
        && target.enrollmentSha256 === this.installation.enrollmentSha256 && (!supportedAction || action.kind === supportedAction);
      let authorized = true;
      if (eligible && mode !== 'reconcile') {
        try {
          const { frozen, whiskers } = await requireOperationsExecutionApproval(tx, diagnosis, proposal, this.installation, execution.decisionVersion);
          if (mode === 'restart_resume') {
            await requireSavedRestartWriter(tx, frozen.target, whiskers, await readOperationsRestartRequest(tx, execution.id));
          }
        }
        catch (error) {
          if (!(error instanceof DomainError)) throw error;
          authorized = false;
        }
      }
      if ((await complete()).affected !== 1) return null;
      if (!authorized && mode === 'restart_resume') {
        await reconcileBlockedRestartResume(tx, database, bound, workerId);
        return null;
      }
      if (!eligible || !authorized) {
        await replaceOperationsExecutionWakeup(tx, database, schedule, task.generation, slot.taskId ? 1 : 5);
        return null;
      }

      const lease = await assignSlot(tx, task, schedule.runId, workerId, this.coordinator.leaseSeconds);
      const reason = mode === 'dispatch' ? 'operations_execution_claimed'
        : mode === 'restart_resume' ? 'operations_restart_resume_claimed' : 'operations_execution_reconciling';
      await tx.update(runRuntime).set({ reason }).where(eq(runRuntime.runId, schedule.runId));
      await appendEvent(tx, task, 'task.operations_execution_started', 'running', {
        workerId, reason, operationsExecution: { executionId: execution.id, proposalId: execution.proposalId, fence: lease.fence },
      });
      await tx.update(operationsExecutionSchedules).set({ wakeupJobId: null }).where(eq(operationsExecutionSchedules.executionId, execution.id));
      const scope = Object.freeze({ ...lease, executionId: execution.id, mode });
      if (mode === 'reconcile' && action.kind === 'restart') await startRestartRecovery(tx, scope);
      return scope;
    });
  }

  async heartbeat(scope: OperationsExecutionLease) {
    await this.withLease(scope, async (tx, { diagnosis, proposal, execution, intent, reason }) => {
      if (!intent || reason === 'operations_restart_resume_claimed') {
        const { frozen, whiskers } = await requireOperationsExecutionApproval(tx, diagnosis, proposal, this.installation, execution.decisionVersion);
        if (reason === 'operations_restart_resume_claimed') {
          await requireSavedRestartWriter(tx, frozen.target, whiskers, await readOperationsRestartRequest(tx, execution.id));
        }
      }
      await renewSlot(tx, this.coordinator.leaseSeconds);
    });
  }

  async planRestartConnection(scope: OperationsExecutionLease, proof: OperationsRestartWriterProof) {
    return this.withLease(scope, async (tx, { execution, proposal, diagnosis, reason }) => {
      if (reason !== 'operations_execution_claimed' && reason !== 'operations_restart_resume_claimed') throw new ExecutionLost();
      const authority = await requireOperationsExecutionApproval(tx, diagnosis, proposal, this.installation, execution.decisionVersion);
      const { frozen, whiskers, publishedVersion } = authority;
      if (frozen.action.kind !== 'restart') throw new DomainError('unsupported_state');
      const subject = await readOperationsRestartSubject(tx, frozen.target, publishedVersion);
      if (scope.mode === 'restart_resume') {
        const { request, approval } = await readRestartContinuation(tx, execution.id, authority, proof);
        if (!request.runtimeBaseline) throw new DomainError('unsupported_state');
        return { subject, target: request.document.target, approval };
      }
      await requireOperationsRestartWriter(tx, frozen.target, whiskers, proof);
      return { subject, target: { ...whiskers, containerId: frozen.target.containerId }, approval: null };
    });
  }

  async prepareDispatch(scope: OperationsExecutionLease, rawRestartProof?: unknown, observedBaseline?: unknown) {
    const restart = rawRestartProof === undefined ? undefined : parseInput(operationsRestartWriterProofSchema, rawRestartProof);
    return this.withLease(scope, async (tx, { execution, task, proposal, diagnosis, reason }) => {
      if (scope.mode !== 'dispatch' || reason !== 'operations_execution_claimed') throw new ExecutionLost();
      const { frozen, whiskers, publishedVersion } = await requireOperationsExecutionApproval(tx, diagnosis, proposal, this.installation, execution.decisionVersion);
      if (restart && frozen.action.kind !== 'restart') throw new DomainError('unsupported_state');
      if (restart) await requireOperationsRestartWriter(tx, frozen.target, whiskers, restart);
      const baseline = restart ? matchRestartBaseline(await readOperationsRestartSubject(tx, frozen.target, publishedVersion), observedBaseline) : undefined;
      const [intent] = await tx.insert(operationsExecutionIntents).values({ executionId: execution.id,
        decisionVersion: execution.decisionVersion, proposalFingerprint: execution.proposalFingerprint,
        generation: scope.generation, workerId: scope.workerId, fence: scope.fence }).returning();
      if (!intent) throw new DomainError('unavailable');
      const dispatchReason = 'operations_execution_dispatch_intended';
      await tx.update(runRuntime).set({ reason: dispatchReason }).where(eq(runRuntime.runId, scope.runId));
      const restartRequest = restart && baseline ? await prepareOperationsRestartRequest(tx, execution.id, restart.installationId, {
        version: 1, tool: 'restart_container', target: { ...whiskers, containerId: frozen.target.containerId }, credentialSha256: restart.credentialSha256,
      }, baseline) : undefined;
      await appendEvent(tx, task, 'task.operations_execution_dispatch_intended', 'running', {
        workerId: scope.workerId, reason: dispatchReason,
        operationsExecution: { executionId: execution.id, proposalId: execution.proposalId, fence: scope.fence },
      });
      return { intent, proposal: frozen, ...(restartRequest ? { restartRequest } : {}) };
    });
  }

  async pauseForRestartApproval(scope: OperationsExecutionLease, raw: unknown) {
    const approval = parseInput(operationsRestartApprovalInputSchema, raw);
    return this.withLease(scope, async (tx, { execution, schedule, task, reason, diagnosis, proposal }) => {
      if (scope.mode !== 'dispatch' || reason !== 'operations_execution_dispatch_intended') throw new ExecutionLost();
      const recorded = await attachOperationsRestartApproval(tx, execution.id, approval);
      let canAwaitApproval = true;
      try {
        const { frozen, whiskers } = await requireOperationsExecutionApproval(tx, diagnosis, proposal, this.installation, execution.decisionVersion);
        await requireSavedRestartWriter(tx, frozen.target, whiskers, recorded);
      }
      catch (error) {
        if (!(error instanceof DomainError)) throw error;
        canAwaitApproval = false;
      }
      const pauseReason = canAwaitApproval ? 'operations_execution_native_approval' : 'operations_execution_reconciling';
      const pauseState = canAwaitApproval ? 'waiting_approval' : 'reconciling';
      await tx.update(runRuntime).set({ reason: pauseReason }).where(eq(runRuntime.runId, scope.runId));
      await appendEvent(tx, task, 'task.operations_execution_native_approval', pauseState, {
        workerId: scope.workerId, reason: pauseReason,
        operationsExecution: { executionId: execution.id, proposalId: execution.proposalId, fence: scope.fence,
          nativeApprovalId: approval.approvalId, nativeCallSha256: approval.callSha256 },
      });
      if (!canAwaitApproval) await replaceOperationsExecutionWakeup(tx, this.coordinator.database, schedule, task.generation);
      await clearSlot(tx);
      return { ...recorded, waiting: canAwaitApproval };
    });
  }

  async requestRestartResume(identity: VerifiedIdentity, rawExecutionId: unknown, raw: unknown, writer?: OperationsRestartWriterProof) {
    const executionId = parseInput(idSchema, rawExecutionId);
    const input = parseInput(operationsRestartContinueInputSchema, raw);
    const database = this.coordinator.database;
    return database.db.transaction(async tx => {
      await lockSlot(tx);
      const bound = await lockOperationsExecution(tx, executionId);
      if (!bound) throw new DomainError('not_found');
      const { task, diagnosis, proposal, schedule, execution, reason } = bound;
      const actor = await requireActor(tx, identity);
      const { project } = await requireProjectAccess(tx, actor, task.projectId, true);
      if (!isHumanWorkspaceOwner(identity, actor, project.workspaceId, this.humanClientId)) throw new DomainError('forbidden');

      const { frozen, whiskers, decision, now } = await requireOperationsExecutionApproval(tx, diagnosis, proposal, this.installation, execution.decisionVersion);
      if (identity.expiresAt * 1_000 <= now.getTime()) throw new DomainError('unauthenticated');
      if (actor.principalId !== decision.actorId || actor.workspaceGrantId !== decision.grantId) throw new DomainError('forbidden');
      const request = await readOperationsRestartRequest(tx, executionId);
      if (request.approvalId !== input.approvalId || request.callSha256 !== input.callSha256) throw new DomainError('version_conflict');
      await requireSavedRestartWriter(tx, frozen.target, whiskers, request, writer);

      const [duplicate] = await tx.select().from(operationsRestartResumes)
        .where(and(eq(operationsRestartResumes.executionId, executionId), eq(operationsRestartResumes.idempotencyKey, input.idempotencyKey)));
      if (duplicate) {
        if (duplicate.expectedVersion !== input.expectedVersion) throw new DomainError('idempotency_conflict');
        return { resume: duplicate, replayed: true };
      }
      if (task.version !== input.expectedVersion) throw new DomainError('version_conflict');
      if (execution.state !== 'reserved' || task.state !== 'waiting_approval' || reason !== 'operations_execution_native_approval'
          || schedule.wakeupJobId) throw new DomainError('unsupported_state');
      const prior = await latestRestartResume(tx, executionId);
      if (prior && (prior.state !== 'pending' || prior.attempt >= maxOperationsRestartResumes)) throw new DomainError('unsupported_state');
      const [resume] = await tx.insert(operationsRestartResumes).values({ ...input, executionId, actorId: actor.principalId,
        grantId: actor.workspaceGrantId, attempt: (prior?.attempt ?? 0) + 1 }).returning();
      if (!resume) throw new DomainError('unavailable');
      const queued = 'operations_restart_resume_queued';
      await tx.update(runRuntime).set({ reason: queued }).where(eq(runRuntime.runId, schedule.runId));
      await appendEvent(tx, task, 'task.operations_restart_resume_requested', 'queued', {
        actorId: actor.principalId, reason: queued,
        operationsExecution: { executionId, proposalId: execution.proposalId, resumeAttempt: resume.attempt },
      });
      await replaceOperationsExecutionWakeup(tx, database, schedule, task.generation);
      return { resume, replayed: false };
    });
  }

  async prepareRestartResume(scope: OperationsExecutionLease, raw: unknown) {
    const binding = parseInput(operationsRestartResumeBindingSchema, raw);
    return this.withLease(scope, async (tx, { execution, diagnosis, proposal, task, reason }) => {
      if (scope.mode !== 'restart_resume' || reason !== 'operations_restart_resume_claimed') throw new ExecutionLost();
      const authority = await requireOperationsExecutionApproval(tx, diagnosis, proposal, this.installation, execution.decisionVersion);
      const { request, resume: checked, approval } = await readRestartContinuation(tx, execution.id, authority, binding);
      if (approval.approvalId !== binding.approvalId || approval.callSha256 !== binding.callSha256 ||
          request.runtimeBaselineSha256 !== binding.runtimeBaselineSha256) throw new DomainError('version_conflict');
      const [resume] = await tx.update(operationsRestartResumes).set({ state: 'prepared', workerId: scope.workerId, fence: scope.fence })
        .where(and(eq(operationsRestartResumes.executionId, execution.id), eq(operationsRestartResumes.attempt, checked.attempt))).returning();
      if (!resume) throw new ExecutionLost();
      const prepared = 'operations_restart_resume_prepared';
      await tx.update(runRuntime).set({ reason: prepared }).where(eq(runRuntime.runId, scope.runId));
      await appendEvent(tx, task, 'task.operations_restart_resume_prepared', 'running', {
        workerId: scope.workerId, reason: prepared,
        operationsExecution: { executionId: execution.id, proposalId: execution.proposalId, fence: scope.fence, resumeAttempt: resume.attempt },
      });
      return { resume, request };
    });
  }

  async blockRestartResume(scope: OperationsExecutionLease) {
    await this.withLease(scope, async (tx, current) => {
      if (scope.mode !== 'restart_resume' || current.reason !== 'operations_restart_resume_claimed') throw new ExecutionLost();
      await reconcileBlockedRestartResume(tx, this.coordinator.database, current, scope.workerId);
      await clearSlot(tx);
    });
  }

  async recordRestartResume(scope: OperationsExecutionLease, raw: unknown) {
    const result = parseInput(operationsRestartResumeOutcomeSchema, raw);
    return this.withLease(scope, async (tx, { execution, schedule, task, proposal, diagnosis, reason }) => {
      if (scope.mode !== 'restart_resume' || reason !== 'operations_restart_resume_prepared') throw new ExecutionLost();
      const current = await latestRestartResume(tx, execution.id);
      if (current?.state !== 'prepared' || current.fence !== scope.fence || current.workerId !== scope.workerId
          || current.approvalId !== result.approvalId || current.callSha256 !== result.callSha256) throw new ExecutionLost();
      let wait = result.outcome === 'pending' && current.attempt < maxOperationsRestartResumes;
      if (wait) {
        try {
          const { frozen, whiskers } = await requireOperationsExecutionApproval(tx, diagnosis, proposal, this.installation, execution.decisionVersion);
          await requireSavedRestartWriter(tx, frozen.target, whiskers, await readOperationsRestartRequest(tx, execution.id));
        }
        catch (error) {
          if (!(error instanceof DomainError)) throw error;
          wait = false;
        }
      }
      const [resume] = await tx.update(operationsRestartResumes).set({ state: result.outcome })
        .where(and(eq(operationsRestartResumes.executionId, execution.id), eq(operationsRestartResumes.attempt, current.attempt))).returning();
      if (!resume?.recordedAt) throw new ExecutionLost();
      const nextReason = wait ? 'operations_execution_native_approval' : 'operations_execution_reconciling';
      await tx.update(runRuntime).set({ reason: nextReason }).where(eq(runRuntime.runId, scope.runId));
      await appendEvent(tx, task, 'task.operations_restart_resume_recorded', wait ? 'waiting_approval' : 'reconciling', {
        workerId: scope.workerId, reason: nextReason,
        operationsExecution: { executionId: execution.id, proposalId: execution.proposalId, fence: scope.fence, resumeAttempt: current.attempt },
      });
      if (!wait) await replaceOperationsExecutionWakeup(tx, this.coordinator.database, schedule, task.generation);
      await clearSlot(tx);
      return { ...resume, waiting: wait };
    });
  }

  async deferRestart(scope: OperationsExecutionLease) {
    return this.withLease(scope, async (tx, bound) => {
      const { execution, schedule, task, proposal, intent, reason } = bound;
      const database = this.coordinator.database;
      if (scope.mode === 'reconcile' || readOperationsProposal(proposal).action.kind !== 'restart') throw new ExecutionLost();
      if (!intent) {
        const [closed] = await tx.update(operationsExecutions).set({ state: 'blocked', blockedReason: 'restart_not_sent',
          closedAt: sql`GREATEST(${operationsExecutions.createdAt}, clock_timestamp())` })
          .where(eq(operationsExecutions.id, execution.id)).returning({ id: operationsExecutions.id });
        if (!closed) throw new ExecutionLost();
        await closeUndispatchedOperationsExecution(tx, database, execution.id, 'restart_not_sent', task.requestedBy, scope.workerId);
        await clearSlot(tx);
        return 'not_sent' as const;
      }
      if (reason === 'operations_restart_resume_claimed') {
        await reconcileBlockedRestartResume(tx, database, bound, scope.workerId);
      } else {
        const request = await readOperationsRestartRequest(tx, execution.id);
        await tx.update(runRuntime).set({ reason: 'operations_execution_reconciling' }).where(eq(runRuntime.runId, schedule.runId));
        await appendEvent(tx, task, 'task.operations_execution_recovered', 'reconciling', {
          workerId: scope.workerId, reason: 'operations_restart_result_unknown',
          operationsExecution: { executionId: execution.id, proposalId: execution.proposalId, fence: scope.fence,
            nativeCallSha256: request.callSha256, ...(request.approvalId ? { nativeApprovalId: request.approvalId } : {}) },
        });
        await replaceOperationsExecutionWakeup(tx, database, schedule, task.generation);
      }
      await clearSlot(tx);
      return 'reconciling' as const;
    });
  }

  async authorizeRestartRecovery(scope: OperationsExecutionLease) {
    return this.withLease(scope, async (tx, bound) => {
      await requireRestartRecoveryAttempt(tx, scope);
      const { subject, baseline } = await readRestartRecoveryBinding(tx, bound, this.installation);
      return { subject, baseline };
    });
  }

  async settleRestartRecovery(scope: OperationsExecutionLease, raw: unknown) {
    return this.withLease(scope, async (tx, bound) => {
      const attempt = await requireRestartRecoveryAttempt(tx, scope);
      const proof = await proveRestartRecovery(tx, scope, bound, this.installation, raw);
      return finishRestartRecovery(tx, this.coordinator.database, bound, attempt, scope.workerId, { proof });
    });
  }

  async deferRestartRecovery(scope: OperationsExecutionLease, failure: RecoveryFailure) {
    return this.withLease(scope, async (tx, bound) => {
      const attempt = await requireRestartRecoveryAttempt(tx, scope);
      return finishRestartRecovery(tx, this.coordinator.database, bound, attempt, scope.workerId, { failure });
    });
  }

  async reconcile(workerId: string) {
    idSchema.parse(workerId);
    const database = this.coordinator.database;
    await database.db.transaction(tx => this.coordinator.recoverExpired(tx, workerId));
    const candidates = await database.db.select({ id: operationsExecutionSchedules.executionId, jobId: operationsExecutionSchedules.wakeupJobId })
      .from(operationsExecutionSchedules).innerJoin(tasks, eq(tasks.id, operationsExecutionSchedules.taskId))
      .where(and(inArray(tasks.state, ['queued', 'reconciling']), isNotNull(operationsExecutionSchedules.wakeupJobId))).limit(20);
    for (const { id, jobId } of candidates) {
      if (!jobId) continue;
      const [job] = await database.boss.findJobs(operationsExecutionQueue, { id: jobId });
      if (job?.state === 'created' || job?.state === 'retry') continue;
      await database.db.transaction(async tx => {
        await lockSlot(tx);
        const bound = await lockOperationsExecution(tx, id);
        const mode = bound && wakeupMode(bound);
        if (!bound || !mode || bound.schedule.wakeupJobId !== jobId) return;
        const { execution, schedule, task } = bound;
        if (mode === 'dispatch' && await expireUndispatchedOperations(tx, database, execution.environmentId, task.requestedBy, workerId)) return;
        if (job?.state === 'active') {
          if (!job.startedOn || (await databaseNow(tx)).getTime() - new Date(job.startedOn).getTime() < this.coordinator.leaseSeconds * 1_000) return;
          await database.boss.cancel(operationsExecutionQueue, jobId, { db: fromDrizzle(tx, sql) });
        }
        await replaceOperationsExecutionWakeup(tx, database, schedule, task.generation);
      });
    }
  }

  private async withLease<T>(scope: OperationsExecutionLease, run: (tx: Transaction, bound: BoundExecution) => Promise<T>) {
    return this.coordinator.database.db.transaction(async tx => {
      const currentSlot = await lockSlot(tx);
      if (!currentSlot.live || currentSlot.taskId !== scope.taskId || currentSlot.runId !== scope.runId
          || currentSlot.workerId !== scope.workerId || currentSlot.fence !== scope.fence) throw new ExecutionLost();
      const bound = await lockOperationsExecution(tx, scope.executionId);
      if (!bound || bound.schedule.taskId !== scope.taskId || bound.schedule.runId !== scope.runId
          || bound.schedule.wakeupJobId || bound.execution.state !== 'reserved') throw new ExecutionLost();
      const { slot } = await lockExecution(tx, scope);
      const { intent, reason } = bound;
      const active = scope.mode === 'dispatch'
        ? (!intent && reason === 'operations_execution_claimed') || (intent?.fence === scope.fence && reason === 'operations_execution_dispatch_intended')
        : intent && intent.fence < scope.fence && (scope.mode === 'reconcile' ? reason === 'operations_execution_reconciling'
          : reason === 'operations_restart_resume_claimed' || reason === 'operations_restart_resume_prepared');
      if (!active) throw new ExecutionLost();
      const result = await run(tx, bound);
      await assertLeaseLive(tx, slot.leaseUntil);
      return result;
    });
  }
}

export async function withOperationsLeaseHeartbeat<T>(coordinator: OperationsExecutionCoordinator, scope: OperationsExecutionLease,
  signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const live = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let heartbeat: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (heartbeat || live.aborted) return;
    heartbeat = coordinator.heartbeat(scope).catch(error => controller.abort(error)).finally(() => { heartbeat = undefined; });
  }, coordinator.leaseSeconds * 1000 / 3);
  try { return await run(live); }
  finally {
    clearInterval(timer);
    await heartbeat;
  }
}
