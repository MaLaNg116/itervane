import {
  idSchema, listQuerySchema, operationsHealthBindingSchema, operationsHealthSignalSchema, operationsIncidentScopeSchema,
  operationsIncidentSummarySchema, operationsIncidentsViewSchema, taskIncidentViewSchema, translate, type Locale,
} from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { OperationsWorkflowScope } from '../config.js';
import type { Database } from '../persistence/database.js';
import {
  environments, operationsHealthSamples, operationsIncidentDiagnoses, operationsIncidents,
  operationsRepairAdmissions, operationsRepairProposals, operationsTargets, tasks,
} from '../persistence/schema.js';
import { isHumanWorkspaceOwner, requireActor, requireProject, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { readOperationsEnrollment } from './operations-targets.js';

type Incident = typeof operationsIncidents.$inferSelect;
type HealthSample = typeof operationsHealthSamples.$inferSelect;
type Scope = ReturnType<typeof operationsIncidentScopeSchema.parse>;

export function verifiedIncidentBinding(row: Incident | HealthSample, scope: Scope) {
  const binding = operationsHealthBindingSchema.parse(row.binding);
  if (binding.projectId !== scope.projectId || binding.environmentId !== scope.environmentId
      || sha256(JSON.stringify(binding)) !== row.bindingSha256) throw new Error('operations_incident_view_scope');
  return binding;
}

function presentSample(sample: HealthSample, scope: Scope, locale: Locale) {
  const { releaseOperationId, restoreExecutionId } = verifiedIncidentBinding(sample, scope);
  const signal = operationsHealthSignalSchema.parse(sample.signal);
  const label = signal.status === 'healthy' ? 'healthy' : signal.reason;
  return { sequence: sample.sequence, recordedAt: sample.recordedAt.toISOString(), releaseOperationId, restoreExecutionId,
    signal, message: translate(locale, `operations.health.${label}`) };
}

async function presentIncidents(tx: Transaction, rows: Incident[], scope: Scope, locale: Locale) {
  if (!rows.length) return [];
  const ids = rows.map(row => row.id);
  const latest = await tx.selectDistinctOn([operationsHealthSamples.incidentId]).from(operationsHealthSamples)
    .where(and(eq(operationsHealthSamples.environmentId, scope.environmentId), inArray(operationsHealthSamples.incidentId, ids)))
    .orderBy(asc(operationsHealthSamples.incidentId), desc(operationsHealthSamples.sequence));
  const diagnoses = await tx.select({
    incidentId: operationsIncidentDiagnoses.incidentId, taskId: tasks.id, runId: operationsIncidentDiagnoses.runId,
    attempt: operationsIncidentDiagnoses.attempt, sampleSequence: operationsIncidentDiagnoses.sampleSequence, state: tasks.state,
  }).from(operationsIncidentDiagnoses)
    .innerJoin(tasks, and(eq(tasks.id, operationsIncidentDiagnoses.taskId), eq(tasks.projectId, scope.projectId)))
    .where(and(eq(operationsIncidentDiagnoses.environmentId, scope.environmentId), inArray(operationsIncidentDiagnoses.incidentId, ids)))
    .orderBy(asc(operationsIncidentDiagnoses.attempt));
  const repairs = await tx.select({
    incidentId: operationsRepairProposals.incidentId, proposalId: operationsRepairProposals.id,
    diagnosisRunId: operationsRepairProposals.diagnosisRunId, taskId: tasks.id, state: tasks.state,
  }).from(operationsRepairProposals)
    .leftJoin(operationsRepairAdmissions, eq(operationsRepairAdmissions.proposalId, operationsRepairProposals.id))
    .leftJoin(tasks, and(eq(tasks.id, operationsRepairAdmissions.taskId), eq(tasks.projectId, scope.projectId)))
    .where(and(eq(operationsRepairProposals.environmentId, scope.environmentId), inArray(operationsRepairProposals.incidentId, ids)))
    .orderBy(asc(operationsRepairProposals.createdAt), asc(operationsRepairProposals.id));

  const sampleByIncident = new Map(latest.map(sample => [sample.incidentId, sample]));
  return rows.map(row => {
    const binding = verifiedIncidentBinding(row, scope);
    const latestSample = sampleByIncident.get(row.id);
    if (!latestSample || latestSample.bindingSha256 !== row.bindingSha256) throw new Error('operations_incident_view_sample');
    const { id, openedAt, lastUnhealthyAt, unhealthySamples, closedAt, closedReason, diagnosisStoppedAt, diagnosisStopReason } = row;
    return operationsIncidentSummarySchema.parse({
      id, releaseOperationId: binding.releaseOperationId, restoreExecutionId: binding.restoreExecutionId,
      openedAt: openedAt.toISOString(), lastUnhealthyAt: lastUnhealthyAt.toISOString(), unhealthySamples,
      closedAt: closedAt?.toISOString() ?? null, closedReason, message: translate(locale, `operations.incident.${closedReason ?? 'open'}`),
      diagnosisStop: diagnosisStoppedAt && diagnosisStopReason ? {
        at: diagnosisStoppedAt.toISOString(), reason: diagnosisStopReason, message: translate(locale, `operations.incident.${diagnosisStopReason}`),
      } : null,
      latestSample: presentSample(latestSample, scope, locale),
      diagnoses: diagnoses.filter(link => link.incidentId === id).map(({ incidentId: _incident, ...link }) =>
        ({ ...link, stateLabel: translate(locale, `state.${link.state}`) })),
      repairs: repairs.filter(link => link.incidentId === id).map(({ incidentId: _incident, ...link }) => link),
    });
  });
}

export async function readInstalledIncidentEnvironment(tx: Transaction, installation: OperationsWorkflowScope, scope: Scope) {
  if (scope.environmentId !== installation.environmentId) throw new DomainError('not_found');
  const [enrollment] = await tx.select({ row: operationsTargets }).from(operationsTargets)
    .innerJoin(environments, and(eq(environments.id, operationsTargets.environmentId), eq(environments.access, 'protected'),
      eq(environments.projectId, operationsTargets.projectId), eq(environments.applicationId, operationsTargets.applicationId)))
    .where(and(eq(operationsTargets.environmentId, scope.environmentId), eq(operationsTargets.projectId, scope.projectId),
      eq(operationsTargets.sha256, installation.enrollmentSha256)));
  if (!enrollment) throw new DomainError('not_found');
  return readOperationsEnrollment(enrollment.row);
}

export class OperationsIncidentsViewService {
  constructor(private readonly database: Database, private readonly installation: OperationsWorkflowScope,
    private readonly portalClientId?: string) {}

  async list(identity: VerifiedIdentity, rawScope: unknown, rawQuery: unknown, locale: Locale) {
    const scope = parseInput(operationsIncidentScopeSchema, rawScope);
    const { limit } = parseInput(listQuerySchema, rawQuery);
    return this.database.db.transaction(async tx => {
      await requireProject(tx, await requireActor(tx, identity), scope.projectId);
      await readInstalledIncidentEnvironment(tx, this.installation, scope);
      const [latest] = await tx.select().from(operationsHealthSamples).where(eq(operationsHealthSamples.environmentId, scope.environmentId))
        .orderBy(desc(operationsHealthSamples.sequence)).limit(1);
      const rows = await tx.select().from(operationsIncidents).where(eq(operationsIncidents.environmentId, scope.environmentId))
        .orderBy(desc(operationsIncidents.openedAt), desc(operationsIncidents.id)).limit(limit);
      return operationsIncidentsViewSchema.parse({ version: 1, ...scope, locale,
        latestHealth: latest ? presentSample(latest, scope, locale) : null, items: await presentIncidents(tx, rows, scope, locale) });
    }, { isolationLevel: 'repeatable read' });
  }

  async forTask(identity: VerifiedIdentity, rawTaskId: unknown, locale: Locale) {
    const taskId = parseInput(idSchema, rawTaskId);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      const [task] = await tx.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId));
      if (!task) throw new DomainError('not_found');
      const project = await requireProject(tx, actor, task.projectId);
      const [diagnosis] = await tx.select({
        incidentId: operationsIncidentDiagnoses.incidentId, environmentId: operationsIncidentDiagnoses.environmentId,
      }).from(operationsIncidentDiagnoses).where(eq(operationsIncidentDiagnoses.taskId, taskId));
      const [repair] = diagnosis ? [] : await tx.select({
        incidentId: operationsRepairProposals.incidentId, environmentId: operationsRepairProposals.environmentId,
      }).from(operationsRepairAdmissions)
        .innerJoin(operationsRepairProposals, eq(operationsRepairProposals.id, operationsRepairAdmissions.proposalId))
        .where(eq(operationsRepairAdmissions.taskId, taskId));
      const link = diagnosis ?? repair;
      const base = { version: 1, taskId, locale };
      if (!link?.incidentId || link.environmentId !== this.installation.environmentId) {
        return taskIncidentViewSchema.parse({ ...base, relatedAs: null, incident: null });
      }
      const scope = { projectId: task.projectId, environmentId: link.environmentId };
      await readInstalledIncidentEnvironment(tx, this.installation, scope);
      const rows = await tx.select().from(operationsIncidents).where(and(
        eq(operationsIncidents.id, link.incidentId), eq(operationsIncidents.environmentId, scope.environmentId)));
      const [incident] = await presentIncidents(tx, rows, scope, locale);
      if (!incident) throw new Error('operations_incident_view_link');
      const stopDiagnosis = !incident.closedAt && !incident.diagnosisStop
        && isHumanWorkspaceOwner(identity, actor, project.workspaceId, this.portalClientId) ? scope : null;
      return taskIncidentViewSchema.parse({ ...base, relatedAs: diagnosis ? 'diagnosis' : 'linked_repair', incident, stopDiagnosis });
    }, { isolationLevel: 'repeatable read' });
  }
}
