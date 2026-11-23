import { idSchema, operationsIncidentScopeSchema, operationsIncidentStopResultSchema, stopOperationsIncidentDiagnosisSchema,
  translate, type Locale } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, eq } from 'drizzle-orm';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { OperationsWorkflowScope } from '../config.js';
import type { Database } from '../persistence/database.js';
import { operationsIncidents } from '../persistence/schema.js';
import { isHumanWorkspaceOwner, requireActor, requireProjectAccess } from './access.js';
import { lockEnvironmentForEffect } from './environment-effects.js';
import { DomainError, parseInput } from './errors.js';
import { readHealthProbeTarget } from './operations-health.js';
import { readInstalledIncidentEnvironment, verifiedIncidentBinding } from './operations-incidents-view.js';
import { databaseNow } from './releases.js';

const incidentScopeSchema = operationsIncidentScopeSchema.extend({ incidentId: idSchema });

export class OperationsIncidentStopService {
  constructor(private readonly database: Database, private readonly installation: OperationsWorkflowScope,
    private readonly portalClientId: string) {}

  async stop(identity: VerifiedIdentity, rawScope: unknown, rawInput: unknown, locale: Locale) {
    const { incidentId, ...scope } = parseInput(incidentScopeSchema, rawScope);
    const { expectedReleaseOperationId, expectedRestoreExecutionId } = parseInput(stopOperationsIncidentDiagnosisSchema, rawInput);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      const { project } = await requireProjectAccess(tx, actor, scope.projectId, true);
      if (!isHumanWorkspaceOwner(identity, actor, project.workspaceId, this.portalClientId)) throw new DomainError('forbidden');
      const enrollment = await readInstalledIncidentEnvironment(tx, this.installation, scope);
      await lockEnvironmentForEffect(tx, scope.environmentId);
      const [incident] = await tx.select().from(operationsIncidents).where(and(
        eq(operationsIncidents.id, incidentId), eq(operationsIncidents.environmentId, scope.environmentId))).for('update');
      if (!incident) throw new DomainError('not_found');
      const original = verifiedIncidentBinding(incident, scope);
      if (original.releaseOperationId !== expectedReleaseOperationId || original.restoreExecutionId !== expectedRestoreExecutionId) {
        throw new DomainError('version_conflict');
      }
      const now = await databaseNow(tx, incident.openedAt);
      if (identity.expiresAt * 1_000 <= now.getTime()) throw new DomainError('unauthenticated');
      if (incident.diagnosisStoppedAt && incident.diagnosisStopReason) {
        return operationsIncidentStopResultSchema.parse({ incidentId, replayed: true, locale, stoppedAt: incident.diagnosisStoppedAt.toISOString(),
          reason: incident.diagnosisStopReason, message: translate(locale, `operations.incident.${incident.diagnosisStopReason}`) });
      }
      if (incident.closedAt) throw new DomainError('unsupported_state');
      const { binding } = await readHealthProbeTarget(tx, { ...this.installation, mappingSha256: enrollment.releaseTargetSha256 });
      if (sha256(JSON.stringify(binding)) !== incident.bindingSha256) throw new DomainError('version_conflict');
      await tx.update(operationsIncidents).set({ diagnosisStoppedAt: now, diagnosisStopReason: 'operator_stopped',
        diagnosisStoppedBy: actor.principalId, diagnosisStopGrantId: actor.workspaceGrantId }).where(eq(operationsIncidents.id, incidentId));
      return operationsIncidentStopResultSchema.parse({ incidentId, replayed: false, locale, stoppedAt: now.toISOString(),
        reason: 'operator_stopped', message: translate(locale, 'operations.incident.operator_stopped') });
    });
  }
}
