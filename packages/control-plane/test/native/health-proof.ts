import { deepStrictEqual, equal, match, notEqual, ok } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import type { OperationsHealthSignal } from '@itervane/contracts';
import { asc, eq } from 'drizzle-orm';
import type { Database } from '../../src/persistence/database.js';
import { operationsHealthSamples, operationsIncidents } from '../../src/persistence/schema.js';
import type { OperationsHealthWorker } from '../../src/runtime/installed-health-worker.js';

type ProbeEvent = 'healthy' | Exclude<OperationsHealthSignal, { status: 'healthy' }>['reason'];

export async function proveInstalledHealthProbe(fixture: {
  database: Database;
  install: () => Promise<OperationsHealthWorker>;
  caFile: string;
  environmentId: string;
  releaseOperationId: string;
  containerId: string;
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
    const worker = await fixture.install();
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
      return result.incidentId;
    };
    const incidents = () => database.db.select().from(operationsIncidents).where(eq(operationsIncidents.environmentId, environmentId))
      .orderBy(asc(operationsIncidents.openedAt), asc(operationsIncidents.id));

    equal(await read('healthy'), null);
    await fixture.stopContainer();
    const stopped = await read('runtime_stopped');
    ok(stopped);
    await fixture.startContainer();
    equal(await read('healthy'), stopped);

    await fixture.failHealth();
    const degraded = await read('application_unhealthy');
    ok(degraded);
    notEqual(degraded, stopped);
    await fixture.stopIdentity();
    equal(await read('probe_identity'), degraded);
    const stillOpen = (await incidents()).filter(row => row.closedAt === null);
    deepStrictEqual(stillOpen.map(row => [row.id, row.unhealthySamples]), [[degraded, 1]]);

    await fixture.startIdentity();
    await fixture.restoreHealth();
    equal(await read('healthy'), degraded);
    const closed = await incidents();
    deepStrictEqual(closed.map(row => [row.id, row.closedReason, row.unhealthySamples]),
      [[stopped, 'recovered', 1], [degraded, 'recovered', 1]]);
    const samples = await database.db.select().from(operationsHealthSamples).where(eq(operationsHealthSamples.environmentId, environmentId))
      .orderBy(asc(operationsHealthSamples.sequence));
    deepStrictEqual(samples.map(sample => sample.sequence), sequences);
    deepStrictEqual(samples.map(sample => sample.incidentId), [null, stopped, stopped, degraded, degraded, degraded]);
    for (const { binding } of [...samples, ...closed]) {
      equal(binding.releaseOperationId, releaseOperationId);
      equal(binding.containerId, containerId);
    }
    return { releaseOperationId, containerId, signals, samples: samples.length, incidents: closed.length,
      unknownPreserved: true, eachRecovered: true };
  } finally { setDefaultCACertificates(trusted); }
}
