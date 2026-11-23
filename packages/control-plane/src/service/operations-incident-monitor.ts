import { idSchema, localeSchema, sha256Schema, type OperationsRequestBinding } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../persistence/database.js';
import { operationsIncidentDiagnoses, operationsIncidentMonitors, operationsIncidents, principals, projectMembers } from '../persistence/schema.js';
import { requireProjectAccess, requireStoredActor, type Transaction } from './access.js';
import { lockEnvironmentForEffect } from './environment-effects.js';
import { DomainError, parseInput } from './errors.js';
import { readHealthProbeTarget, type OperationsHealthInstallation } from './operations-health.js';
import { databaseNow } from './releases.js';

const issuer = 'urn:itervane:incident-monitor';
const registrationSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('register'), environmentId: idSchema, expectedActiveId: idSchema.nullable(),
    enrollmentSha256: sha256Schema, mappingSha256: sha256Schema, providerSha256: sha256Schema,
    locale: localeSchema.default('en'), validUntil: z.iso.datetime() }),
  z.strictObject({ action: z.literal('revoke'), environmentId: idSchema, expectedActiveId: idSchema }),
]);

export type IncidentMonitor = typeof operationsIncidentMonitors.$inferSelect;
export type IncidentMonitorInstallation = OperationsHealthInstallation & { monitorId: string };

export async function changeOperationsIncidentMonitor(database: Database, raw: unknown) {
  const input = parseInput(registrationSchema, raw);
  const { environmentId } = input;
  return database.db.transaction(async tx => {
    await lockEnvironmentForEffect(tx, environmentId);
    const [active] = await tx.select().from(operationsIncidentMonitors)
      .where(and(eq(operationsIncidentMonitors.environmentId, environmentId), isNull(operationsIncidentMonitors.revokedAt)));
    if ((active?.id ?? null) !== input.expectedActiveId) throw new DomainError('version_conflict');
    const now = await databaseNow(tx, active?.createdAt);
    if (active) await tx.update(operationsIncidentMonitors).set({ revokedAt: now }).where(eq(operationsIncidentMonitors.id, active.id));
    if (input.action === 'revoke') return { environmentId, monitorId: input.expectedActiveId, status: 'revoked' as const };

    const { enrollmentSha256, mappingSha256, providerSha256, locale } = input;
    const validUntil = new Date(input.validUntil);
    if (validUntil <= now) throw new DomainError('invalid_input');
    const { binding } = await readHealthProbeTarget(tx, input);
    const { projectId } = binding;
    // This issuer cannot be used by the HTTP or MCP OIDC verifier.
    await tx.insert(principals).values({ issuer, subject: environmentId })
      .onConflictDoNothing({ target: [principals.issuer, principals.subject] });
    const [principal] = await tx.select({ id: principals.id }).from(principals)
      .where(and(eq(principals.issuer, issuer), eq(principals.subject, environmentId))).for('share');
    if (!principal) throw new DomainError('unavailable');
    await tx.insert(projectMembers).values({ projectId, principalId: principal.id, role: 'maintainer' })
      .onConflictDoNothing({ target: [projectMembers.projectId, projectMembers.principalId] });
    const actor = await requireStoredActor(tx, principal.id);
    const { grantId, role } = await requireProjectAccess(tx, actor, projectId, true);
    if (actor.workspaceId !== null || role !== 'maintainer') throw new DomainError('forbidden');
    const [registered] = await tx.insert(operationsIncidentMonitors).values({ environmentId, principalId: principal.id,
      grantId, enrollmentSha256, mappingSha256, providerSha256, locale, createdAt: now, validUntil,
    }).returning({ id: operationsIncidentMonitors.id });
    if (!registered) throw new DomainError('unavailable');
    return { environmentId, monitorId: registered.id, status: 'registered' as const, validUntil: validUntil.toISOString() };
  });
}

export async function readActiveIncidentMonitor(tx: Transaction, installation: IncidentMonitorInstallation) {
  const [monitor] = await tx.select().from(operationsIncidentMonitors).where(and(
    eq(operationsIncidentMonitors.id, installation.monitorId), eq(operationsIncidentMonitors.environmentId, installation.environmentId),
    eq(operationsIncidentMonitors.enrollmentSha256, installation.enrollmentSha256), eq(operationsIncidentMonitors.mappingSha256, installation.mappingSha256),
    isNull(operationsIncidentMonitors.revokedAt),
  )).for('share');
  if (!monitor || monitor.validUntil <= await databaseNow(tx)) throw new DomainError('forbidden');
  return monitor;
}

export async function requireIncidentMonitorActor(tx: Transaction, monitor: IncidentMonitor, projectId: string) {
  const actor = await requireStoredActor(tx, monitor.principalId);
  const { grantId, role } = await requireProjectAccess(tx, actor, projectId, true);
  if (actor.workspaceId !== null || role !== 'maintainer' || grantId !== monitor.grantId || monitor.validUntil <= await databaseNow(tx)) {
    throw new DomainError('forbidden');
  }
  return actor;
}

export async function requireIncidentDiagnosisAuthority(tx: Transaction, runId: string, principalId: string,
  request: OperationsRequestBinding, providerSha256?: string) {
  const [link] = await tx.select().from(operationsIncidentDiagnoses).where(eq(operationsIncidentDiagnoses.runId, runId));
  if (!link) return;
  const { environmentId, enrollmentSha256, mappingSha256, grantId } = request;
  if (link.environmentId !== environmentId) throw new DomainError('unsupported_state');
  const scope = { monitorId: link.monitorId, environmentId, enrollmentSha256, mappingSha256 };
  const { binding } = await readHealthProbeTarget(tx, scope);
  const monitor = await readActiveIncidentMonitor(tx, scope);
  if (monitor.principalId !== principalId || monitor.grantId !== grantId || monitor.providerSha256 !== providerSha256) {
    throw new DomainError('forbidden');
  }
  const [incident] = await tx.select({ id: operationsIncidents.id }).from(operationsIncidents).where(and(
    eq(operationsIncidents.id, link.incidentId), isNull(operationsIncidents.closedAt), isNull(operationsIncidents.diagnosisStoppedAt),
  ));
  if (!incident || link.bindingSha256 !== sha256(JSON.stringify(binding)) ||
      request.releaseOperationId !== binding.releaseOperationId || request.containerId !== binding.containerId ||
      (request.restoreExecutionId ?? null) !== binding.restoreExecutionId) {
    throw new DomainError('unsupported_state');
  }
}
