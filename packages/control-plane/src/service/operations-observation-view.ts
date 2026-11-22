import { eventReasonMessages, idSchema, operationsObservationViewSchema,
  taskEventReasonSchema, translate, type Locale, type OperationsObservationView } from '@itervane/contracts';
import { eq } from 'drizzle-orm';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { OperationsWorkflowScope } from '../config.js';
import type { Database } from '../persistence/database.js';
import { tasks } from '../persistence/schema.js';
import { requireActor, requireProject } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { presentOperationsDiagnosis } from './operations-diagnosis-view.js';
import { readOperationsTaskRecord } from './operations-records.js';
import { readOperationsObservationTarget } from './operations-targets.js';

export class OperationsObservationViewService {
  constructor(private readonly database: Database) {}

  async getLaunchOption(identity: VerifiedIdentity, taskId: string, installation: OperationsWorkflowScope) {
    parseInput(idSchema, taskId);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      const [task] = await tx.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId));
      if (!task) throw new DomainError('not_found');
      await requireProject(tx, actor, task.projectId, true);
      const scope = { projectId: task.projectId, environmentId: installation.environmentId };
      const target = await readOperationsObservationTarget(tx, actor, scope).catch(error => {
        if (error instanceof DomainError && ['not_found', 'unsupported_state', 'version_conflict', 'conflict'].includes(error.code)) return undefined;
        throw error;
      });
      if (!target || target.releaseTaskId !== taskId || target.enrollmentSha256 !== installation.enrollmentSha256) return { option: null };
      return { option: { ...scope, releaseOperationId: target.releaseOperationId,
        ...(installation.diagnosisProviderSha256 ? { diagnosis: true as const } : {}) } };
    });
  }

  async get(identity: VerifiedIdentity, taskId: string, locale: Locale) {
    parseInput(idSchema, taskId);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('share');
      if (!task) throw new DomainError('not_found');
      await requireProject(tx, actor, task.projectId);
      const { run, request, event, observation: recorded, diagnosis } = await readOperationsTaskRecord(tx, task);
      let observation: OperationsObservationView['observation'] = null;
      if (recorded) {
        const { state, observedAt } = recorded.receipt.observation;
        observation = { state, observedAt, stateLabel: translate(locale, `operations.container.${state}`), receiptSha256: recorded.sha256 };
      }

      const { applicationId, environmentId, releaseOperationId } = request.document;
      const reason = taskEventReasonSchema.safeParse(event.detail.reason).data ?? null;
      return operationsObservationViewSchema.parse({ version: 1, taskId, runId: run.id, taskVersion: task.version,
        state: task.state, applicationId, environmentId, releaseOperationId, observation, locale, reason,
        ...(diagnosis ? { diagnosis: presentOperationsDiagnosis(diagnosis, locale) } : {}),
        message: translate(locale, observation ? 'task.operations_observed' : `state.${task.state}`),
        reasonMessage: reason ? translate(locale, eventReasonMessages[reason]) : null });
    });
  }
}
