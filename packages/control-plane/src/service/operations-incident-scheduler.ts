import { operationsHealthSignalSchema } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../persistence/database.js';
import { operationsHealthSamples, operationsIncidentDiagnoses, operationsIncidents, tasks } from '../persistence/schema.js';
import type { Transaction } from './access.js';
import { DomainError } from './errors.js';
import { readHealthProbeTarget } from './operations-health.js';
import { readActiveIncidentMonitor, requireIncidentMonitorActor, type IncidentMonitorInstallation } from './operations-incident-monitor.js';
import { readOperationsObservationTarget } from './operations-targets.js';
import { databaseNow } from './releases.js';
import { TaskService } from './tasks.js';

const cooldownMs = 120_000;
const maxSampleAgeMs = 360_000;
const maxAttempts = 3;
const stoppedTasks = new Set(['failed', 'cancelled', 'needs_human']);

export class OperationsIncidentScheduler {
  private readonly tasks: TaskService;

  constructor(private readonly database: Database, private readonly installation: IncidentMonitorInstallation) {
    this.tasks = new TaskService(database);
  }

  async tick() {
    try {
      return await this.database.db.transaction(tx => this.admit(tx));
    } catch (error) {
      if (error instanceof DomainError && ['conflict', 'forbidden', 'not_found', 'unsupported_state', 'unavailable', 'version_conflict'].includes(error.code)) {
        return { status: 'skipped' as const, reason: error.code };
      }
      throw error;
    }
  }

  private async admit(tx: Transaction) {
    // Serializes admissions, health samples, registration changes and native effects for this environment.
    const { binding } = await readHealthProbeTarget(tx, this.installation);
    const { environmentId, projectId } = binding;
    const bindingSha256 = sha256(JSON.stringify(binding));
    const monitor = await readActiveIncidentMonitor(tx, this.installation);
    const actor = await requireIncidentMonitorActor(tx, monitor, projectId);
    const [incident] = await tx.select().from(operationsIncidents).where(and(
      eq(operationsIncidents.environmentId, environmentId), eq(operationsIncidents.bindingSha256, bindingSha256),
      isNull(operationsIncidents.closedAt),
    ));
    if (!incident) return { status: 'idle' as const, reason: 'no_incident' as const };
    if (incident.diagnosisStopReason) return { status: 'stopped' as const, reason: incident.diagnosisStopReason };

    const [last] = await tx.select({ admission: operationsIncidentDiagnoses, state: tasks.state })
      .from(operationsIncidentDiagnoses).innerJoin(tasks, eq(tasks.id, operationsIncidentDiagnoses.taskId))
      .where(eq(operationsIncidentDiagnoses.environmentId, environmentId))
      .orderBy(desc(operationsIncidentDiagnoses.admittedAt), desc(operationsIncidentDiagnoses.sampleSequence)).limit(1);
    const previous = last?.admission.incidentId === incident.id ? last : undefined;
    if (previous && stoppedTasks.has(previous.state)) return this.stop(tx, incident, 'task_stopped');
    if (last && last.state !== 'succeeded' && !stoppedTasks.has(last.state)) {
      return { status: 'active' as const, taskId: last.admission.taskId };
    }

    const [sample] = await tx.select().from(operationsHealthSamples).where(eq(operationsHealthSamples.environmentId, environmentId))
      .orderBy(desc(operationsHealthSamples.sequence)).limit(1);
    const now = await databaseNow(tx);
    if (!sample || sample.incidentId !== incident.id || sample.bindingSha256 !== bindingSha256 ||
        operationsHealthSignalSchema.parse(sample.signal).status !== 'unhealthy' || sample.probeStartedAt > now ||
        now.getTime() - sample.probeStartedAt.getTime() > maxSampleAgeMs ||
        (previous && sample.sequence <= previous.admission.sampleSequence)) {
      return { status: 'idle' as const, reason: 'awaiting_sample' as const };
    }
    const attempt = (previous?.admission.attempt ?? 0) + 1;
    if (attempt > maxAttempts) return this.stop(tx, incident, 'attempt_limit');
    if (last && now.getTime() - last.admission.admittedAt.getTime() < cooldownMs) {
      return { status: 'idle' as const, reason: 'cooldown' as const };
    }

    const target = await readOperationsObservationTarget(tx, actor, { projectId, environmentId });
    const trigger = { incidentId: incident.id, environmentId, bindingSha256, monitorId: monitor.id, attempt, sampleSequence: sample.sequence };
    const { task, replayed } = await this.tasks.insertAuthorizedOperations(tx, target, {
      requestedBy: actor.principalId, requestKey: `incident:${incident.id}:${attempt}`, requestHash: sha256(JSON.stringify(trigger)),
      locale: monitor.locale, providerSha256: monitor.providerSha256, incident: true,
    });
    if (replayed) throw new DomainError('idempotency_conflict');
    await tx.insert(operationsIncidentDiagnoses).values({ ...trigger, taskId: task.id, runId: task.runId, admittedAt: now });
    if (monitor.validUntil <= await databaseNow(tx)) throw new DomainError('forbidden');
    return { status: 'queued' as const, incidentId: incident.id, taskId: task.id, runId: task.runId, attempt, sampleSequence: sample.sequence };
  }

  private async stop(tx: Transaction, incident: Pick<typeof operationsIncidents.$inferSelect, 'id' | 'openedAt'>,
    reason: 'task_stopped' | 'attempt_limit') {
    await tx.update(operationsIncidents).set({ diagnosisStoppedAt: await databaseNow(tx, incident.openedAt), diagnosisStopReason: reason })
      .where(eq(operationsIncidents.id, incident.id));
    return { status: 'stopped' as const, reason };
  }
}
