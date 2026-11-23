import { deepStrictEqual, equal, match, notEqual, ok } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import type { OperationsHealthSignal } from '@itervane/contracts';
import { asc, eq } from 'drizzle-orm';
import type { Database } from '../../src/persistence/database.js';
import { operationsHealthSamples, operationsIncidentDiagnoses, operationsIncidents } from '../../src/persistence/schema.js';
import type { OperationsHealthWorker } from '../../src/runtime/installed-health-worker.js';
import type { OperationsIncidentScheduler } from '../../src/service/operations-incident-scheduler.js';

type ProbeEvent = 'healthy' | Exclude<OperationsHealthSignal, { status: 'healthy' }>['reason'];
type QueuedDiagnosis = Extract<Awaited<ReturnType<OperationsIncidentScheduler['tick']>>, { status: 'queued' }>;

export async function proveInstalledHealthProbe(fixture: {
  database: Database;
  install: () => Promise<OperationsHealthWorker>;
  caFile: string;
  environmentId: string;
  releaseOperationId: string;
  containerId: string;
  monitorId: string;
  diagnose: (queued: QueuedDiagnosis) => Promise<{
    runId: string; releaseOperationId: string; sha256: string; recommendation: string; previousReleaseOperationId: string | null;
    sections: readonly string[]; matchedPublishedTarget: boolean; httpMcpAgreement: boolean; model: string;
  }>;
  revokeMonitor: () => Promise<void>;
  stopContainer: () => Promise<void>;
  startContainer: () => Promise<void>;
  failHealth: () => Promise<void>;
  restoreHealth: () => Promise<void>;
  stopIdentity: () => Promise<void>;
  startIdentity: () => Promise<void>;
}) {
  const { database, environmentId, releaseOperationId, containerId } = fixture;
  const trusted = getCACertificates('default');
  const certificates = readFileSync(fixture.caFile, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  ok(certificates?.length === 2);
  setDefaultCACertificates([...trusted, ...certificates]);
  try {
    let worker = await fixture.install();
    const signals: ProbeEvent[] = [];
    const sequences: number[] = [];
    const read = async (expected: ProbeEvent) => {
      const result = await worker.tick();
      ok(result.status === 'recorded', `health_probe_${expected}: ${JSON.stringify(result)}`);
      const actual = result.outcome.status === 'healthy' ? 'healthy' : result.outcome.reason;
      equal(actual, expected, `health_probe_${expected}: ${JSON.stringify(result.outcome)}`);
      equal(result.replayed, false);
      match(result.outcome.evidenceSha256, /^[a-f0-9]{64}$/);
      signals.push(actual);
      sequences.push(result.sequence);
      return result;
    };
    const incidents = () => database.db.select().from(operationsIncidents).where(eq(operationsIncidents.environmentId, environmentId))
      .orderBy(asc(operationsIncidents.openedAt), asc(operationsIncidents.id));

    const healthy = await read('healthy');
    equal(healthy.incidentId, null);
    deepStrictEqual(healthy.diagnosis, { status: 'idle', reason: 'no_incident' });
    await fixture.stopContainer();
    const stoppedSample = await read('runtime_stopped');
    const { incidentId: stopped, diagnosis: queued } = stoppedSample;
    ok(stopped);
    ok(queued?.status === 'queued');
    equal(queued.incidentId, stopped);
    equal(queued.attempt, 1);
    equal(queued.sampleSequence, stoppedSample.sequence);
    worker = await fixture.install();
    const afterReinstall = await read('runtime_stopped');
    equal(afterReinstall.incidentId, stopped);
    deepStrictEqual(afterReinstall.diagnosis, { status: 'active', taskId: queued.taskId });
    const receipt = await fixture.diagnose(queued);
    equal(receipt.runId, queued.runId);
    equal(receipt.releaseOperationId, releaseOperationId);
    match(receipt.sha256, /^[a-f0-9]{64}$/);
    await fixture.revokeMonitor();
    await fixture.startContainer();
    equal((await read('healthy')).incidentId, stopped);

    await fixture.failHealth();
    const { incidentId: degraded, diagnosis: revoked } = await read('application_unhealthy');
    ok(degraded);
    notEqual(degraded, stopped);
    deepStrictEqual(revoked, { status: 'skipped', reason: 'forbidden' });
    await fixture.stopIdentity();
    equal((await read('probe_identity')).incidentId, degraded);
    const stillOpen = (await incidents()).filter(row => row.closedAt === null);
    deepStrictEqual(stillOpen.map(row => [row.id, row.unhealthySamples]), [[degraded, 1]]);

    await fixture.startIdentity();
    await fixture.restoreHealth();
    equal((await read('healthy')).incidentId, degraded);
    const closed = await incidents();
    deepStrictEqual(closed.map(row => [row.id, row.closedReason, row.unhealthySamples]),
      [[stopped, 'recovered', 2], [degraded, 'recovered', 1]]);
    const samples = await database.db.select().from(operationsHealthSamples).where(eq(operationsHealthSamples.environmentId, environmentId))
      .orderBy(asc(operationsHealthSamples.sequence));
    deepStrictEqual(samples.map(sample => sample.sequence), sequences);
    deepStrictEqual(samples.map(sample => sample.incidentId), [null, stopped, stopped, stopped, degraded, degraded, degraded]);
    for (const { binding } of [...samples, ...closed]) {
      equal(binding.releaseOperationId, releaseOperationId);
      equal(binding.containerId, containerId);
    }
    const admissions = await database.db.select().from(operationsIncidentDiagnoses).where(eq(operationsIncidentDiagnoses.environmentId, environmentId));
    deepStrictEqual(admissions.map(row => [row.incidentId, row.taskId, row.runId, row.monitorId, row.attempt, row.sampleSequence]),
      [[stopped, queued.taskId, queued.runId, fixture.monitorId, 1, stoppedSample.sequence]]);
    return { releaseOperationId, containerId, signals, samples: samples.length, incidents: closed.length,
      unknownPreserved: true, eachRecovered: true, diagnosis: { ...receipt, incidentId: stopped, taskId: queued.taskId,
        attempt: queued.attempt, sampleSequence: queued.sampleSequence, admissions: admissions.length,
        sameTaskAfterReinstall: true, skippedAfterRevocation: true } };
  } finally { setDefaultCACertificates(trusted); }
}
