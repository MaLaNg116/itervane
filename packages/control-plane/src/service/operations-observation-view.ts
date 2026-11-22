import { eventReasonMessages, idSchema, operationsObservationReceiptSchema, operationsObservationViewSchema,
  taskEventReasonSchema, translate, type Locale, type OperationsObservationView } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, eq } from 'drizzle-orm';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { OperationsEnrollmentScope } from '../config.js';
import type { Database } from '../persistence/database.js';
import { operationsObservations, taskEvents, taskRuns, tasks } from '../persistence/schema.js';
import { requireActor, requireProject } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { readOperationsDiagnosisView } from './operations-diagnosis-view.js';
import { readOperationsRequest } from './operations-requests.js';
import { readOperationsObservationTarget } from './operations-targets.js';

export class OperationsObservationViewService {
  constructor(private readonly database: Database) {}

  async getLaunchOption(identity: VerifiedIdentity, taskId: string, installation: OperationsEnrollmentScope) {
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
      return { option: { ...scope, releaseOperationId: target.releaseOperationId } };
    });
  }

  async get(identity: VerifiedIdentity, taskId: string, locale: Locale) {
    parseInput(idSchema, taskId);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('share');
      if (!task) throw new DomainError('not_found');
      await requireProject(tx, actor, task.projectId);
      const [run] = await tx.select().from(taskRuns).where(and(eq(taskRuns.taskId, task.id), eq(taskRuns.generation, task.generation)));
      if (run?.role !== 'operations') throw new DomainError('not_found');
      if (run.state !== task.state) throw new Error('operations_view_run_integrity');
      const request = await readOperationsRequest(tx, task, run.id);
      const [event] = await tx.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.sequence, task.version)));
      if (event?.state !== task.state) throw new Error('operations_view_event_integrity');
      const [recorded] = await tx.select().from(operationsObservations).where(eq(operationsObservations.runId, run.id));
      if ((task.state === 'succeeded') !== Boolean(recorded)) throw new Error('operations_view_receipt_integrity');

      let observation: OperationsObservationView['observation'] = null;
      let diagnosis: Awaited<ReturnType<typeof readOperationsDiagnosisView>>;
      if (recorded) {
        const receipt = operationsObservationReceiptSchema.parse(recorded.document);
        if (receipt.taskId !== task.id || receipt.runId !== run.id || receipt.releaseOperationId !== request.document.releaseOperationId
            || receipt.bindingSha256 !== request.sha256 || receipt.bindingSha256 !== recorded.bindingSha256
            || receipt.fence !== recorded.fence || receipt.observation.containerId !== request.document.containerId
            || sha256(JSON.stringify(receipt)) !== recorded.sha256 || event.type !== 'task.operations_observed'
            || event.workerId !== recorded.workerId || event.detail.observationSha256 !== recorded.sha256 || event.detail.fence !== recorded.fence) {
          throw new Error('operations_view_receipt_integrity');
        }
        const { state, observedAt } = receipt.observation;
        observation = { state, observedAt, stateLabel: translate(locale, `operations.container.${state}`), receiptSha256: recorded.sha256 };
        diagnosis = await readOperationsDiagnosisView(tx, task, request, receipt, event, locale);
      }

      const { applicationId, environmentId, releaseOperationId } = request.document;
      const reason = taskEventReasonSchema.safeParse(event.detail.reason).data ?? null;
      return operationsObservationViewSchema.parse({ version: 1, taskId, runId: run.id, taskVersion: task.version,
        state: task.state, applicationId, environmentId, releaseOperationId, observation, locale, reason,
        ...(diagnosis ? { diagnosis } : {}),
        message: translate(locale, observation ? 'task.operations_observed' : `state.${task.state}`),
        reasonMessage: reason ? translate(locale, eventReasonMessages[reason]) : null });
    });
  }
}
