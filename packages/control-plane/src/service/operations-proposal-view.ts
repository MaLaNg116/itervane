import { idSchema, operationsProposalSchema, operationsProposalViewSchema, translate, type Locale, type OperationsProposalView } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { asc, eq } from 'drizzle-orm';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { OperationsEnrollmentScope } from '../config.js';
import type { Database } from '../persistence/database.js';
import { operationsDecisions, operationsProposals, tasks } from '../persistence/schema.js';
import { isHumanWorkspaceOwner, requireActor, requireProjectAccess, requireStoredActor } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { readOperationsProposal, readOperationsProposalBasis } from './operations-proposals.js';
import { readOperationsTaskRecord } from './operations-records.js';
import { databaseNow } from './releases.js';

type Status = NonNullable<OperationsProposalView['proposal']>['status'];

export class OperationsProposalViewService {
  constructor(private readonly database: Database, private readonly installation: OperationsEnrollmentScope, private readonly humanClientId?: string) {}

  async get(identity: VerifiedIdentity, rawTaskId: unknown, locale: Locale) {
    const taskId = parseInput(idSchema, rawTaskId);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('share');
      if (!task) throw new DomainError('not_found');
      const { project, role } = await requireProjectAccess(tx, actor, task.projectId);
      const { run, diagnosis } = await readOperationsTaskRecord(tx, task);
      const view: OperationsProposalView = { taskId, runId: run.id, taskVersion: task.version, locale, proposal: null, draft: null };
      if (!diagnosis) return view;

      const [row] = await tx.select().from(operationsProposals).where(eq(operationsProposals.diagnosisRunId, run.id));
      const now = await databaseNow(tx);
      if (identity.expiresAt * 1_000 <= now.getTime()) throw new DomainError('unauthenticated');
      const currentBasis = () => readOperationsProposalBasis(tx, task, diagnosis.sha256, this.installation).catch(error => {
        if (!(error instanceof DomainError)) throw error;
        return undefined;
      });
      if (!row) {
        const draft = role === 'viewer' ? undefined : await currentBasis();
        if (draft && draft.validUntil > now) view.draft = { diagnosisSha256: diagnosis.sha256, kind: draft.document.action.kind };
        return operationsProposalViewSchema.parse(view);
      }

      const frozen = readOperationsProposal(row);
      if (frozen.diagnosis.taskId !== taskId || frozen.diagnosis.sha256 !== diagnosis.sha256) throw new Error('operations_proposal_view_integrity');
      const history = await tx.select().from(operationsDecisions).where(eq(operationsDecisions.proposalId, row.id))
        .orderBy(asc(operationsDecisions.version));
      const last = history.at(-1);
      let status: Status = last?.action === 'reject' ? 'rejected' : last?.action === 'revoke' ? 'revoked'
        : row.validUntil <= now ? 'expired' : last?.action === 'confirm' ? 'confirmed' : 'pending';
      if (status === 'confirmed' || status === 'pending') {
        const basis = await currentBasis();
        const current = basis && operationsProposalSchema.parse({ ...basis.document, proposedBy: row.proposedBy, grantId: row.grantId });
        const proposer = await requireProjectAccess(tx, await requireStoredActor(tx, row.proposedBy), task.projectId, true).catch(error => {
          if (!(error instanceof DomainError)) throw error;
          return undefined;
        });
        const approver = last && await requireStoredActor(tx, last.actorId);
        if (!current || sha256(JSON.stringify(current)) !== row.fingerprint || proposer?.grantId !== row.grantId
            || (last && (approver?.workspaceId !== project.workspaceId || approver.workspaceGrantId !== last.grantId))) status = 'stale';
      }
      const mayDecide = isHumanWorkspaceOwner(identity, actor, project.workspaceId, this.humanClientId);
      const { target, action } = frozen;
      view.proposal = {
        id: row.id, fingerprint: row.fingerprint, kind: action.kind, validUntil: frozen.validUntil,
        status, message: translate(locale, `operations.proposal_${status}`),
        current: { operationId: target.releaseOperationId, manifestDigest: target.manifestDigest },
        restore: action.kind === 'rollback' ? { operationId: action.restore.operationId, manifestDigest: action.restore.manifestDigest } : null,
        decisions: history.map(({ action, version, actorId, selfConfirmed, decidedAt }) =>
          ({ action, version, actorId, selfConfirmed, decidedAt: decidedAt.toISOString() })),
        actions: !mayDecide ? [] : last?.action === 'confirm' ? ['revoke'] : status === 'pending' ? ['confirm', 'reject'] : [],
      };
      return operationsProposalViewSchema.parse(view);
    });
  }
}
