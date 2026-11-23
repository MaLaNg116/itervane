import { operationsHealthBindingSchema, operationsHealthSignalSchema, type OperationsHealthSignal } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { OperationsEnrollmentScope } from '../config.js';
import type { Database } from '../persistence/database.js';
import { operationsExecutions, operationsHealthSamples, operationsIncidents, operationsTargets } from '../persistence/schema.js';
import type { Transaction } from './access.js';
import { lockEnvironmentForEffect } from './environment-effects.js';
import { DomainError, parseInput } from './errors.js';
import { readPublishedOperationsDeployment } from './operations-deployment.js';
import { readOperationsEnrollment } from './operations-targets.js';
import type { InstalledReleaseTarget } from './release-targets.js';
import { databaseNow } from './releases.js';

const healthProbeSchema = z.strictObject({
  sequence: z.int().positive(),
  startedAt: z.iso.datetime({ precision: 3 }),
  binding: operationsHealthBindingSchema,
});
type HealthProbe = z.infer<typeof healthProbeSchema>;
export type OperationsHealthInstallation = OperationsEnrollmentScope & InstalledReleaseTarget;

export class OperationsHealthJournal {
  constructor(private readonly database: Database, private readonly installation: OperationsHealthInstallation) {}

  // Capture the published target before the network read. No locks span a probe request.
  prepareProbe() {
    return this.database.db.transaction(async tx => {
      const current = await readHealthProbeTarget(tx, this.installation);
      const { rows: [ordinal] } = await tx.execute<{ sequence: string }>(sql`
        SELECT nextval('itervane.operations_health_probe_sequence'::regclass)::text AS sequence
      `);
      const sequence = Number(ordinal?.sequence);
      if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new DomainError('unavailable');
      const probe: HealthProbe = { sequence, startedAt: (await databaseNow(tx)).toISOString(), binding: current.binding };
      return { probe, target: current.target, version: current.version };
    });
  }

  authorizeProbe(probe: HealthProbe) {
    const bindingSha256 = sha256(JSON.stringify(probe.binding));
    return this.database.db.transaction(tx => this.requireCurrentBinding(tx, bindingSha256));
  }

  // Only the installed observer submits these normalized results.
  recordProbe(rawProbe: unknown, rawSignal: unknown) {
    const probe = parseInput(healthProbeSchema, rawProbe);
    const signal = parseInput(operationsHealthSignalSchema, rawSignal);
    const { sequence, binding, startedAt } = probe;
    const bindingSha256 = sha256(JSON.stringify(binding));
    return this.database.db.transaction(async tx => {
      await this.requireCurrentBinding(tx, bindingSha256);
      const [prior] = await tx.select().from(operationsHealthSamples).where(eq(operationsHealthSamples.sequence, sequence));
      if (prior) {
        if (prior.environmentId !== binding.environmentId || prior.bindingSha256 !== bindingSha256 ||
            sha256(JSON.stringify(operationsHealthBindingSchema.parse(prior.binding))) !== bindingSha256 ||
            prior.probeStartedAt.toISOString() !== startedAt ||
            JSON.stringify(operationsHealthSignalSchema.parse(prior.signal)) !== JSON.stringify(signal)) {
          throw new DomainError('idempotency_conflict');
        }
        return { sequence, incidentId: prior.incidentId, replayed: true };
      }
      const [latest] = await tx.select({ sequence: operationsHealthSamples.sequence, recordedAt: operationsHealthSamples.recordedAt })
        .from(operationsHealthSamples).where(eq(operationsHealthSamples.environmentId, binding.environmentId))
        .orderBy(desc(operationsHealthSamples.sequence)).limit(1);
      if (latest && sequence <= latest.sequence) throw new DomainError('version_conflict');

      const probeStartedAt = new Date(startedAt);
      const recordedAt = await databaseNow(tx, new Date(Math.max(probeStartedAt.getTime(), latest?.recordedAt.getTime() ?? 0)));
      const incidentId = await recordIncidentSignal(tx, binding, bindingSha256, signal, recordedAt);
      await tx.insert(operationsHealthSamples).values({
        sequence, environmentId: binding.environmentId, bindingSha256, binding, signal, incidentId, probeStartedAt, recordedAt,
      });
      return { sequence, incidentId, replayed: false };
    });
  }

  private async requireCurrentBinding(tx: Transaction, bindingSha256: string) {
    const current = await readHealthProbeTarget(tx, this.installation);
    if (bindingSha256 !== sha256(JSON.stringify(current.binding))) throw new DomainError('version_conflict');
  }
}

// Keep the environment locked through the caller's eligibility checks and commit.
export async function readHealthProbeTarget(tx: Transaction, { environmentId, enrollmentSha256, mappingSha256 }: OperationsHealthInstallation,
  ownReleaseOperationId?: string) {
  await lockEnvironmentForEffect(tx, environmentId);
  const [enrollment] = await tx.select().from(operationsTargets)
    .where(and(eq(operationsTargets.environmentId, environmentId), eq(operationsTargets.sha256, enrollmentSha256))).for('share');
  if (!enrollment) throw new DomainError('unavailable');
  const registered = readOperationsEnrollment(enrollment);
  const [hold] = await tx.select({ id: operationsExecutions.id }).from(operationsExecutions)
    .where(and(eq(operationsExecutions.environmentId, environmentId), eq(operationsExecutions.state, 'reserved'))).limit(1);
  if (hold) throw new DomainError('conflict');

  const current = await readPublishedOperationsDeployment(tx, { environmentId, projectId: enrollment.projectId },
    ownReleaseOperationId ? { ownReleaseOperationId } : undefined);
  if (current.applicationId !== enrollment.applicationId || current.mappingSha256 !== mappingSha256 ||
      current.mappingSha256 !== registered.releaseTargetSha256 || current.targetRevision !== registered.releaseTargetRevision) {
    throw new DomainError('version_conflict');
  }
  const binding = operationsHealthBindingSchema.parse({
    version: 1, environmentId, projectId: current.projectId, applicationId: current.applicationId,
    targetRevision: current.targetRevision, mappingSha256, enrollmentRevision: enrollment.revision, enrollmentSha256,
    releaseOperationId: current.releaseOperationId, restoreExecutionId: 'restoreExecutionId' in current ? current.restoreExecutionId : null,
    publicationProofSha256: current.proofSha256, containerId: current.containerId, manifestDigest: current.manifestDigest,
    configDigest: current.configDigest,
  });
  return { binding, target: current.releaseTarget, version: current.version, publication: current };
}

async function recordIncidentSignal(tx: Transaction, binding: HealthProbe['binding'], bindingSha256: string,
  signal: OperationsHealthSignal, recordedAt: Date) {
  const [open] = await tx.select().from(operationsIncidents)
    .where(and(eq(operationsIncidents.environmentId, binding.environmentId), isNull(operationsIncidents.closedAt))).limit(1);
  const matching = open?.bindingSha256 === bindingSha256 ? open : undefined;
  if (signal.status === 'unavailable') return matching?.id ?? null;
  if (open && (!matching || signal.status === 'healthy')) {
    await tx.update(operationsIncidents)
      .set({ closedAt: recordedAt, closedReason: matching ? 'recovered' : 'target_changed' })
      .where(eq(operationsIncidents.id, open.id));
  }
  if (signal.status === 'healthy') return matching?.id ?? null;
  if (matching) {
    await tx.update(operationsIncidents).set({ lastUnhealthyAt: recordedAt, unhealthySamples: matching.unhealthySamples + 1 })
      .where(eq(operationsIncidents.id, matching.id));
    return matching.id;
  }
  const [incident] = await tx.insert(operationsIncidents).values({
    environmentId: binding.environmentId, bindingSha256, binding, openedAt: recordedAt, lastUnhealthyAt: recordedAt, unhealthySamples: 1,
  }).returning({ id: operationsIncidents.id });
  if (!incident) throw new DomainError('unavailable');
  return incident.id;
}
