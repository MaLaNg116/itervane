import { randomUUID } from 'node:crypto';
import { idSchema, operationsProposalSchema, sha256Schema } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { OperationsEnrollmentScope } from '../config.js';
import type { Database } from '../persistence/database.js';
import { operationsDecisions, operationsExecutions, operationsExecutionSchedules, operationsProposals, operationsRequests, tasks } from '../persistence/schema.js';
import { scheduleOperationsExecution } from '../runtime/operations-execution-queue.js';
import { requireProjectAccess, requireStoredActor, type Transaction } from './access.js';
import { lockEnvironmentForEffect, requireNoOperationsHold } from './environment-effects.js';
import { DomainError, parseInput } from './errors.js';
import { readOperationsProposal, readOperationsProposalBasis } from './operations-proposals.js';
import { databaseNow } from './releases.js';

const executionInput = z.strictObject({ proposalId: idSchema, fingerprint: sha256Schema, decisionVersion: z.literal(1) });

export class OperationsExecutionAdmission {
  constructor(private readonly database: Database, private readonly installation: OperationsEnrollmentScope) {}

  async reserve(raw: unknown) {
    const input = parseInput(executionInput, raw);
    return this.database.db.transaction(async tx => {
      const { execution, replayed } = await this.reserveApproved(tx, input);
      return { execution, replayed };
    });
  }

  async enqueue(raw: unknown) {
    const input = parseInput(executionInput, raw);
    return this.database.db.transaction(async tx => {
      const { execution, frozen, decision, task } = await this.reserveApproved(tx, input);
      const [scheduled] = await tx.select().from(operationsExecutionSchedules)
        .where(eq(operationsExecutionSchedules.executionId, execution.id));
      if (scheduled) return { execution, schedule: scheduled, replayed: true };
      const schedule = await scheduleOperationsExecution(tx, this.database, execution, decision.actorId, frozen, task.locale);
      return { execution, schedule, replayed: false };
    });
  }

  private async reserveApproved(tx: Transaction, { proposalId, fingerprint, decisionVersion }: z.infer<typeof executionInput>) {
    const [link] = await tx.select({ proposal: operationsProposals, taskId: operationsRequests.taskId }).from(operationsProposals)
      .innerJoin(operationsRequests, eq(operationsRequests.runId, operationsProposals.diagnosisRunId))
      .where(eq(operationsProposals.id, proposalId));
    if (!link) throw new DomainError('not_found');
    const { proposal, taskId } = link;
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update');
    if (!task) throw new DomainError('not_found');
    await lockEnvironmentForEffect(tx, proposal.environmentId);
    const frozen = readOperationsProposal(proposal);
    if (proposal.fingerprint !== fingerprint) throw new DomainError('version_conflict');

    const [decision] = await tx.select().from(operationsDecisions).where(eq(operationsDecisions.proposalId, proposalId))
      .orderBy(desc(operationsDecisions.version)).limit(1);
    if (decision?.action !== 'confirm' || decision.version !== decisionVersion) throw new DomainError('unsupported_state');
    const proposer = await requireProjectAccess(tx, await requireStoredActor(tx, proposal.proposedBy), task.projectId, true);
    const approver = await requireStoredActor(tx, decision.actorId);
    if (proposer.grantId !== proposal.grantId || approver.workspaceId !== proposer.project.workspaceId
        || approver.workspaceGrantId !== decision.grantId) throw new DomainError('forbidden');

    const basis = await readOperationsProposalBasis(tx, task, frozen.diagnosis.sha256, this.installation);
    const current = operationsProposalSchema.parse({ ...basis.document, proposedBy: proposal.proposedBy, grantId: proposal.grantId });
    if (sha256(JSON.stringify(current)) !== fingerprint) throw new DomainError('version_conflict');
    const now = await databaseNow(tx);
    if (proposal.validUntil <= now) throw new DomainError('unsupported_state');
    const [existing] = await tx.select().from(operationsExecutions).where(eq(operationsExecutions.proposalId, proposalId));
    if (existing) {
      if (existing.state !== 'reserved') throw new DomainError('unsupported_state');
      return { execution: existing, replayed: true, frozen, decision, task };
    }
    await requireNoOperationsHold(tx, this.database, proposal.environmentId, decision.actorId);
    const [execution] = await tx.insert(operationsExecutions).values({
      id: randomUUID(), proposalId, proposalFingerprint: fingerprint, environmentId: proposal.environmentId, decisionVersion,
      state: 'reserved', createdAt: now,
    }).returning();
    if (!execution) throw new DomainError('unavailable');
    return { execution, replayed: false, frozen, decision, task };
  }
}
