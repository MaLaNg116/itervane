import { equal, fail, ok } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { idSchema, komodoResourceIdSchema, releaseRegistryOriginSchema } from '@itervane/contracts';
import { QualifiedInspectionClient, type QualifiedControllerAddress } from '@itervane/runner';
import { z } from 'zod';
import { openDatabase } from '../../src/persistence/database.js';
import { FormalReleaseWorker } from '../../src/runtime/formal-release-worker.js';
import { KomodoReleaseClient } from '../../src/runtime/release-komodo.js';
import { ReleaseRegistryPublisher } from '../../src/runtime/release-registry.js';

const boundarySchema = z.enum(['tick', 'configured', 'update-recorded', 'update-unrecorded']);
const fixtureSchema = z.strictObject({
  origin: z.literal('http://127.0.0.1:49120'), actorId: komodoResourceIdSchema,
  key: z.string().min(1).max(512), secret: z.string().min(1).max(512),
});

export type KomodoInterruption = {
  pid: number; operationId: string; fence: number;
  boundary: 'configured' | 'update-recorded' | 'update-unrecorded'; updateId?: string; imageReference?: string;
  configurationWrites: number; dispatches: number;
};

export async function runKomodoReleaseFixture(databaseUrl: string, address: QualifiedControllerAddress,
  rawOperationId: unknown, rawRegistryOrigin: string, materializer: string, rawBoundary: unknown) {
  const operationId = idSchema.parse(rawOperationId);
  const registryOrigin = releaseRegistryOriginSchema.parse(rawRegistryOrigin);
  const boundary = boundarySchema.parse(rawBoundary);
  ok(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(registryOrigin));
  const raw = process.env.ITERVANE_NATIVE_KOMODO_FIXTURE;
  ok(raw && raw.length <= 1500);
  const { origin, ...credentials } = fixtureSchema.parse(JSON.parse(raw));
  const client = new KomodoReleaseClient(origin, credentials);
  const database = await openDatabase(databaseUrl);
  let imports = 0;
  let registryReads = 0;
  let configurationWrites = 0;
  let dispatches = 0;
  let updateReads = 0;
  const imported = materializer !== '-';
  try {
    const registry = new ReleaseRegistryPublisher({ origin: registryOrigin }, {
      materializer: imported ? materializer : '/itervane-test-unavailable/materializer', skopeo: '/usr/bin/skopeo',
    });
    const pause = async (kind: 'komodo_config' | 'komodo_dispatch', observed: { updateId?: string; imageReference?: string }) => {
      if (boundary === 'tick') fail('unexpected_komodo_fixture_pause');
      const { rows: [step] } = await database.pool.query<{ state: string; prepared_fence: number; external_update_id: string | null }>(
        'SELECT state,prepared_fence,external_update_id FROM itervane.formal_release_steps WHERE operation_id=$1 AND kind=$2',
        [operationId, kind]);
      ok(step);
      equal(step.state, 'prepared');
      equal(step.external_update_id, boundary === 'update-recorded' ? observed.updateId : null);
      const marker: KomodoInterruption = { pid: process.pid, operationId, fence: step.prepared_fence,
        boundary, configurationWrites, dispatches, ...observed };
      console.log(JSON.stringify(marker));
      await delay(45_000);
      fail('komodo_fixture_interruption_missing');
    };
    const worker = new FormalReleaseWorker(database, {
      origin: registryOrigin,
      registry: {
        publish: (...args) => { imports++; return registry.publish(...args); },
        observe: (...args) => { registryReads++; return registry.observe(...args); },
      },
      ...(imported ? { runner: new QualifiedInspectionClient(address) } : {}),
      komodo: {
        inspectTarget: (...args) => client.inspectTarget(...args),
        async configureImage(target, image, write, signal, read) {
          const result = await client.configureImage(target, image, async () => { await write(); configurationWrites++; }, signal, read);
          if (boundary === 'configured') await pause('komodo_config', { imageReference: result.imageReference });
          return result;
        },
        async dispatch(target, manifest, write, signal, read) {
          const result = await client.dispatch(target, manifest, async () => { await write(); dispatches++; }, signal, read);
          if (boundary === 'update-unrecorded') await pause('komodo_dispatch', { updateId: result.updateId });
          return result;
        },
        async observeUpdate(target, updateId, authorize, signal) {
          if (boundary === 'update-recorded') {
            await authorize();
            await pause('komodo_dispatch', { updateId });
          }
          updateReads++;
          return client.observeUpdate(target, updateId, authorize, signal);
        },
      },
    }, { leaseSeconds: 6 });
    const result = await worker.tick();
    if (boundary !== 'tick') fail('komodo_fixture_did_not_pause');
    const counts = { imports, registryReads, configurationWrites, dispatches, updateReads };
    if (result.status === 'idle') return { status: result.status, ...counts };
    equal(result.scope.operationId, operationId);
    return { status: result.status, mode: result.scope.mode, fence: result.scope.fence, ...counts };
  } finally { await database.close(); }
}
