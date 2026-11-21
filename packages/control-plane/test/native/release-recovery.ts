import { deepStrictEqual, equal, fail, ok } from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { idSchema, releaseRegistryImageProofSchema, type ReleaseRegistryImageProof } from '@itervane/contracts';
import { QualifiedInspectionClient, type QualifiedControllerAddress } from '@itervane/runner';
import { openDatabase } from '../../src/persistence/database.js';
import { FormalReleaseWorker } from '../../src/runtime/formal-release-worker.js';
import { ReleaseRegistryPublisher } from '../../src/runtime/release-registry.js';

export type RegistryImportMarker = {
  pid: number; operationId: string; fence: number; imported: ReleaseRegistryImageProof; stagingEmpty: true;
};

const probeLeaseSeconds = 6;

function fixtureOperation(rawOperationId: unknown, origin: string) {
  ok(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin));
  return idSchema.parse(rawOperationId);
}

export async function interruptibleRegistryImport(databaseUrl: string, address: QualifiedControllerAddress,
  rawOperationId: unknown, origin: string, materializer: string) {
  const operationId = fixtureOperation(rawOperationId, origin);
  const database = await openDatabase(databaseUrl);
  const runner = new QualifiedInspectionClient(address);
  const originalTmp = process.env.TMPDIR;
  const staging = await mkdtemp(join(tmpdir(), 'itervane-registry-interruption-'));
  process.env.TMPDIR = staging;
  try {
    const registry = new ReleaseRegistryPublisher({ origin }, { materializer, skopeo: '/usr/bin/skopeo' });
    const worker = new FormalReleaseWorker(database, { origin, registry, runner: {
      async withRetainedArchive(expected, authorize, use, signal) {
        const imported = releaseRegistryImageProofSchema.parse(await runner.withRetainedArchive(expected, authorize, use, signal));
        deepStrictEqual(await readdir(staging), []);
        await rm(staging, { recursive: true, force: true });
        const { rows: [intent] } = await database.pool.query<{ state: string; prepared_fence: number; proof: unknown }>(
          "SELECT state,prepared_fence,proof FROM itervane.formal_release_steps WHERE operation_id=$1 AND kind='registry'", [operationId]);
        ok(intent);
        equal(intent.state, 'prepared');
        equal(intent.proof, null);
        const marker: RegistryImportMarker = { pid: process.pid, operationId, fence: intent.prepared_fence, imported, stagingEmpty: true };
        console.log(JSON.stringify(marker));
        // The parent kills this process while the Worker is between cleanup and committing the readback.
        await delay(45_000);
        return fail('registry_fixture_interruption_missing');
      },
    } }, { leaseSeconds: probeLeaseSeconds });
    await worker.tick();
    fail('registry_fixture_import_did_not_pause');
  } finally {
    if (originalTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmp;
    await rm(staging, { recursive: true, force: true });
    await database.close();
  }
}

export async function recoverInterruptedRegistry(databaseUrl: string, rawOperationId: unknown, origin: string) {
  const operationId = fixtureOperation(rawOperationId, origin);
  const database = await openDatabase(databaseUrl);
  try {
    const registry = new ReleaseRegistryPublisher({ origin },
      { materializer: '/itervane-test-unavailable/materializer', skopeo: '/itervane-test-unavailable/skopeo' });
    let observations = 0;
    const worker = new FormalReleaseWorker(database, { origin, registry: {
      publish: async () => fail('registry_recovery_retried_import'),
      observe: (...args) => { observations++; return registry.observe(...args); },
    } }, { leaseSeconds: probeLeaseSeconds });
    const result = await worker.tick();
    if (result.status !== 'registry_verified') fail('registry_recovery_did_not_verify');
    equal(result.scope.operationId, operationId);
    equal(result.scope.mode, 'registry_recovery');
    equal(observations, 1);
    return { operationId, fence: result.scope.fence, proof: result.proof, observations };
  } finally { await database.close(); }
}
