import {
  idSchema, operationsRepairProposalSchema, operationsRepairViewSchema, translate, type Locale, type OperationsRepairView,
} from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, eq } from 'drizzle-orm';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { OperationsWorkflowScope } from '../config.js';
import type { Database } from '../persistence/database.js';
import { operationsRepairAdmissions, operationsRepairProposals, operationsRequests, taskRuns, tasks } from '../persistence/schema.js';
import { isHumanWorkspaceOwner, requireActor, requireProjectAccess, requireStoredActor, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { readInstalledIncidentEnvironment } from './operations-incidents-view.js';
import { readOperationsTaskRecord } from './operations-records.js';
import { OperationsRepairAdmission } from './operations-repair-admission.js';
import { OperationsRepairProposalService, readOperationsRepairBasis, readOperationsRepairProposal } from './operations-repair-proposals.js';
import { databaseNow } from './releases.js';

export class OperationsRepairWorkflow {
  constructor(private readonly database: Database, private readonly installation: OperationsWorkflowScope, private readonly portalClientId?: string) {}

  async get(identity: VerifiedIdentity, rawTaskId: unknown, locale: Locale) {
    const taskId = parseInput(idSchema, rawTaskId);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('share');
      if (!task) throw new DomainError('not_found');
      const { project, role } = await requireProjectAccess(tx, actor, task.projectId);
      const { run, request, diagnosis } = await readOperationsTaskRecord(tx, task);
      const view: OperationsRepairView = { taskId, runId: run.id, taskVersion: task.version, locale, draft: null, proposal: null };
      if (!diagnosis || request.document.environmentId !== this.installation.environmentId) return operationsRepairViewSchema.parse(view);

      const [row] = await tx.select().from(operationsRepairProposals).where(eq(operationsRepairProposals.diagnosisRunId, run.id));
      const now = await databaseNow(tx);
      if (identity.expiresAt * 1_000 <= now.getTime()) throw new DomainError('unauthenticated');
      const basis = async () => {
        try {
          const installed = await this.readScope(tx, task.projectId, request.document.environmentId);
          return await readOperationsRepairBasis(tx, task, diagnosis.sha256, installed);
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          return undefined;
        }
      };
      if (!row) {
        const available = role === 'viewer' ? undefined : await basis();
        if (available && available.validUntil > now) view.draft = { diagnosisSha256: diagnosis.sha256 };
        return operationsRepairViewSchema.parse(view);
      }

      const frozen = readOperationsRepairProposal(row);
      if (frozen.diagnosis.taskId !== taskId || frozen.diagnosis.sha256 !== diagnosis.sha256
          || frozen.target.projectId !== task.projectId) throw new Error('operations_repair_view_integrity');
      const [accepted] = await tx.select({ taskId: tasks.id, runId: taskRuns.id, state: tasks.state }).from(operationsRepairAdmissions)
        .innerJoin(tasks, and(eq(tasks.id, operationsRepairAdmissions.taskId), eq(tasks.projectId, task.projectId)))
        .innerJoin(taskRuns, and(eq(taskRuns.taskId, tasks.id), eq(taskRuns.generation, tasks.generation)))
        .where(eq(operationsRepairAdmissions.proposalId, row.id));
      let status: NonNullable<OperationsRepairView['proposal']>['status'] = accepted ? 'confirmed' : row.validUntil <= now ? 'expired' : 'pending';
      if (status === 'pending') {
        const live = await basis();
        const current = live && operationsRepairProposalSchema.parse({ ...live.document, proposedBy: row.proposedBy, grantId: row.grantId });
        const proposer = await requireProjectAccess(tx, await requireStoredActor(tx, row.proposedBy), task.projectId, true).catch(error => {
          if (!(error instanceof DomainError)) throw error;
          return undefined;
        });
        if (!current || sha256(JSON.stringify(current)) !== row.fingerprint || proposer?.grantId !== row.grantId) status = 'stale';
      }
      const { environmentId, releaseOperationId, restoreExecutionId } = frozen.target;
      view.proposal = {
        id: row.id, fingerprint: row.fingerprint, status, message: translate(locale, `operations.linked_repair.${status}`),
        validUntil: frozen.validUntil, incidentId: frozen.incident?.id ?? null,
        mayConfirm: status === 'pending' && isHumanWorkspaceOwner(identity, actor, project.workspaceId, this.portalClientId),
        target: { environmentId, releaseOperationId, restoreExecutionId },
        source: { ...frozen.source.git, requiresMaterializedCommit: frozen.source.patchSha256 !== null },
        linkedTask: accepted ? { ...accepted, stateLabel: translate(locale, `state.${accepted.state}`) } : null,
      };
      return operationsRepairViewSchema.parse(view);
    });
  }

  async request(identity: VerifiedIdentity, rawTaskId: unknown, raw: unknown, locale: Locale) {
    const taskId = parseInput(idSchema, rawTaskId);
    const installation = await this.findScope(identity, { taskId });
    const { replayed } = await new OperationsRepairProposalService(this.database, installation).freeze(identity, taskId, raw);
    return { replayed, view: await this.get(identity, taskId, locale) };
  }

  async confirm(identity: VerifiedIdentity, rawProposalId: unknown, raw: unknown) {
    const proposalId = parseInput(idSchema, rawProposalId);
    const installation = await this.findScope(identity, { proposalId });
    return new OperationsRepairAdmission(this.database, installation, this.portalClientId).confirm(identity, proposalId, raw);
  }

  private async readScope(tx: Transaction, projectId: string, environmentId: string) {
    const enrolled = await readInstalledIncidentEnvironment(tx, this.installation, { projectId, environmentId });
    return { ...this.installation, mappingSha256: enrolled.releaseTargetSha256 };
  }

  private async findScope(identity: VerifiedIdentity, reference: { taskId: string } | { proposalId: string }) {
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      const requests = tx.select({ projectId: operationsRequests.projectId, environmentId: operationsRequests.environmentId }).from(operationsRequests);
      const [scope] = 'taskId' in reference ? await requests
        .innerJoin(tasks, eq(tasks.id, operationsRequests.taskId))
        .innerJoin(taskRuns, and(eq(taskRuns.id, operationsRequests.runId), eq(taskRuns.generation, tasks.generation)))
        .where(eq(tasks.id, reference.taskId)) : await requests
        .innerJoin(operationsRepairProposals, eq(operationsRepairProposals.diagnosisRunId, operationsRequests.runId))
        .where(eq(operationsRepairProposals.id, reference.proposalId));
      if (!scope) throw new DomainError('not_found');
      await requireProjectAccess(tx, actor, scope.projectId, true);
      return this.readScope(tx, scope.projectId, scope.environmentId);
    });
  }
}
