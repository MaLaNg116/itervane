import { idSchema, operationsProposalSchema, releaseDecisionInputSchema } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { asc, eq } from 'drizzle-orm';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { OperationsEnrollmentScope } from '../config.js';
import type { Database } from '../persistence/database.js';
import { operationsDecisions, operationsProposals, operationsRequests, tasks } from '../persistence/schema.js';
import { isHumanWorkspaceOwner, requireActor, requireProjectAccess, requireStoredActor } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { readOperationsProposal, readOperationsProposalBasis } from './operations-proposals.js';
import { databaseNow } from './releases.js';

export class OperationsDecisionService {
  constructor(private readonly database: Database, private readonly installation: OperationsEnrollmentScope, private readonly humanClientId?: string) {}

  async decide(identity: VerifiedIdentity, rawProposalId: unknown, raw: unknown) {
    const proposalId = parseInput(idSchema, rawProposalId);
    const input = parseInput(releaseDecisionInputSchema, raw);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      const [link] = await tx.select({ taskId: operationsRequests.taskId }).from(operationsProposals)
        .innerJoin(operationsRequests, eq(operationsRequests.runId, operationsProposals.diagnosisRunId)).where(eq(operationsProposals.id, proposalId));
      if (!link) throw new DomainError('not_found');
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, link.taskId)).for('update');
      if (!task) throw new DomainError('not_found');
      const { project } = await requireProjectAccess(tx, actor, task.projectId, true);
      if (!isHumanWorkspaceOwner(identity, actor, project.workspaceId, this.humanClientId)) throw new DomainError('forbidden');
      const [proposal] = await tx.select().from(operationsProposals).where(eq(operationsProposals.id, proposalId)).for('update');
      if (!proposal) throw new DomainError('not_found');
      const frozen = readOperationsProposal(proposal);
      if (proposal.fingerprint !== input.fingerprint) throw new DomainError('version_conflict');

      const now = await databaseNow(tx);
      if (identity.expiresAt * 1_000 <= now.getTime()) throw new DomainError('unauthenticated');
      const history = await tx.select().from(operationsDecisions).where(eq(operationsDecisions.proposalId, proposalId)).orderBy(asc(operationsDecisions.version));
      const duplicate = history.find(item => item.actorId === actor.principalId && item.idempotencyKey === input.idempotencyKey);
      if (duplicate) {
        if (duplicate.action !== input.action || duplicate.version !== input.expectedVersion + 1) throw new DomainError('idempotency_conflict');
        if (duplicate.grantId !== actor.workspaceGrantId) throw new DomainError('version_conflict');
        return { taskId: task.id, decision: duplicate, replayed: true };
      }
      const last = history.at(-1);
      const version = last?.version ?? 0;
      if (version !== input.expectedVersion) throw new DomainError('version_conflict');
      if (input.action === 'revoke') {
        if (last?.action !== 'confirm') throw new DomainError('unsupported_state');
      } else {
        if (last || proposal.validUntil <= now) throw new DomainError('unsupported_state');
        const proposer = await requireProjectAccess(tx, await requireStoredActor(tx, proposal.proposedBy), task.projectId, true);
        if (proposer.grantId !== proposal.grantId) throw new DomainError('forbidden');
        const basis = await readOperationsProposalBasis(tx, task, frozen.diagnosis.sha256, this.installation);
        const current = operationsProposalSchema.parse({ ...basis.document, proposedBy: proposal.proposedBy, grantId: proposal.grantId });
        if (sha256(JSON.stringify(current)) !== proposal.fingerprint) throw new DomainError('version_conflict');
      }

      const decidedAt = await databaseNow(tx);
      if (identity.expiresAt * 1_000 <= decidedAt.getTime()) throw new DomainError('unauthenticated');
      if (input.action !== 'revoke' && proposal.validUntil <= decidedAt) throw new DomainError('unsupported_state');
      const [decision] = await tx.insert(operationsDecisions).values({ proposalId, version: version + 1,
        actorId: actor.principalId, grantId: actor.workspaceGrantId, idempotencyKey: input.idempotencyKey, action: input.action,
        selfConfirmed: input.action === 'confirm' && actor.principalId === proposal.proposedBy, decidedAt }).returning();
      if (!decision) throw new DomainError('unavailable');
      return { taskId: task.id, decision, replayed: false };
    });
  }
}
