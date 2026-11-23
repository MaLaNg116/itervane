import { confirmOperationsRepairSchema, idSchema, operationsRepairProposalSchema, translate } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { Database } from '../persistence/database.js';
import { operationsRepairAdmissions, operationsRepairProposals, operationsRequests, tasks } from '../persistence/schema.js';
import { isHumanWorkspaceOwner, requireActor, requireProjectAccess, requireStoredActor } from './access.js';
import { DomainError, parseInput } from './errors.js';
import type { OperationsHealthInstallation } from './operations-health.js';
import { readOperationsRepairBasis, readOperationsRepairProposal } from './operations-repair-proposals.js';
import { databaseNow } from './releases.js';
import { TaskService, taskView } from './tasks.js';

export class OperationsRepairAdmission {
  private readonly tasks: TaskService;

  constructor(private readonly database: Database, private readonly installation: OperationsHealthInstallation, private readonly humanClientId?: string) {
    this.tasks = new TaskService(database);
  }

  async confirm(identity: VerifiedIdentity, rawProposalId: unknown, raw: unknown) {
    const proposalId = parseInput(idSchema, rawProposalId);
    const { fingerprint, commit, locale } = parseInput(confirmOperationsRepairSchema, raw);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      const diagnosisTask = alias(tasks, 'diagnosis_task');
      const [entry] = await tx.select({ proposal: operationsRepairProposals, parent: diagnosisTask }).from(operationsRepairProposals)
        .innerJoin(operationsRequests, eq(operationsRequests.runId, operationsRepairProposals.diagnosisRunId))
        .innerJoin(diagnosisTask, eq(diagnosisTask.id, operationsRequests.taskId))
        .where(eq(operationsRepairProposals.id, proposalId)).for('update', { of: diagnosisTask });
      if (!entry) throw new DomainError('not_found');
      const { proposal, parent } = entry;
      const { project } = await requireProjectAccess(tx, actor, parent.projectId, true);
      if (!isHumanWorkspaceOwner(identity, actor, project.workspaceId, this.humanClientId)) throw new DomainError('forbidden');
      if (proposal.fingerprint !== fingerprint) throw new DomainError('version_conflict');
      const frozen = readOperationsRepairProposal(proposal);
      const sourceCommit = commit ?? frozen.source.git.commit;
      const requestSha256 = sha256(JSON.stringify({ proposalId, fingerprint, sourceCommit, locale }));
      const [existing] = await tx.select().from(operationsRepairAdmissions).where(eq(operationsRepairAdmissions.proposalId, proposalId));
      if (identity.expiresAt * 1_000 <= (await databaseNow(tx)).getTime()) throw new DomainError('unauthenticated');
      if (existing) {
        if (existing.actorId !== actor.principalId || existing.grantId !== actor.workspaceGrantId) throw new DomainError('forbidden');
        if (existing.requestSha256 !== requestSha256) throw new DomainError('idempotency_conflict');
        return { task: await taskView(tx, existing.taskId), replayed: true };
      }
      if (frozen.source.patchSha256 === null ? sourceCommit !== frozen.source.git.commit : sourceCommit === frozen.source.git.commit) {
        throw new DomainError('invalid_input');
      }

      const proposer = await requireStoredActor(tx, proposal.proposedBy);
      if ((await requireProjectAccess(tx, proposer, parent.projectId, true)).grantId !== proposal.grantId) throw new DomainError('forbidden');
      const basis = await readOperationsRepairBasis(tx, parent, frozen.diagnosis.sha256, this.installation);
      const current = operationsRepairProposalSchema.parse({ ...basis.document, proposedBy: proposal.proposedBy, grantId: proposal.grantId });
      if (sha256(JSON.stringify(current)) !== fingerprint) throw new DomainError('version_conflict');
      const now = await databaseNow(tx, proposal.createdAt);
      if (identity.expiresAt * 1_000 <= now.getTime()) throw new DomainError('unauthenticated');
      if (proposal.validUntil <= now) throw new DomainError('unsupported_state');
      const { task, replayed } = await this.tasks.insertAuthorizedTask(tx, { projectId: parent.projectId, requestedBy: actor.principalId,
        repositoryId: frozen.source.git.repositoryId, commit: sourceCommit, locale, dataClass: frozen.source.dataClass,
        purpose: translate(locale, 'operations.incident.repairPurpose'), requestKey: `linked-repair:${proposalId}`, requestHash: requestSha256 });
      if (replayed) throw new DomainError('idempotency_conflict');
      await tx.insert(operationsRepairAdmissions).values({ proposalId, taskId: task.id, runId: task.runId, actorId: actor.principalId,
        grantId: actor.workspaceGrantId, requestSha256, sourceCommit, selfConfirmed: proposal.proposedBy === actor.principalId, confirmedAt: now });
      return { task, replayed: false };
    });
  }
}
