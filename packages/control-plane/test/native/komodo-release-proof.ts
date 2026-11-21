import { deepStrictEqual, equal, notEqual, ok } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { komodoResourceIdSchema, releaseKomodoCompletionSchema } from '@itervane/contracts';
import type { Database } from '../../src/persistence/database.js';
import type { KomodoInterruption, runKomodoReleaseFixture } from './komodo-release-worker.js';

type Tick = Awaited<ReturnType<typeof runKomodoReleaseFixture>>;
type Trial = {
  database: Database; taskId: string; operationId: string; reference: string; configDigest: string;
  tick: (materializer?: string) => Promise<Tick>;
  interrupt: (boundary: KomodoInterruption['boundary']) => Promise<KomodoInterruption>;
  observeContainer: (reference: string, configDigest: string) => Promise<{ reference: string; configDigest: string }>;
};

async function waitForFixture<T>(read: () => Promise<T | undefined>, label: string, timeout = 15_000): Promise<T> {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const current = await read();
    if (current !== undefined) return current;
    await delay(180);
  }
  throw new Error(label + '_timeout');
}

async function expired(trial: Trial, fence: number) {
  await waitForFixture(async () => {
    const { rows: [row] } = await trial.database.pool.query<{ expired: boolean }>(
      'SELECT lease_until<=clock_timestamp() AS expired FROM itervane.execution_slot WHERE task_id=$1 AND fence=$2',
      [trial.taskId, fence]);
    return row?.expired ? true : undefined;
  }, 'komodo_lease_expiry');
}

async function readLedger(trial: Trial) {
  return (await trial.database.pool.query<{
    kind: string; state: string; prepared_fence: number; settled_fence: number | null; external_update_id: string | null; proof: unknown;
  }>(`SELECT kind,state,prepared_fence,settled_fence,external_update_id,proof
      FROM itervane.formal_release_steps WHERE operation_id=$1 AND kind IN ('komodo_config', 'komodo_dispatch') ORDER BY kind`,
  [trial.operationId])).rows;
}

async function keptEnvironment(trial: Trial, outcome: string) {
  const { rows: [operation] } = await trial.database.pool.query(
    'SELECT state,wakeup_job_id,observation FROM itervane.release_operations WHERE id=$1', [trial.operationId]);
  deepStrictEqual(operation, { state: 'reconciling', wakeup_job_id: null, observation: null });
  const { rows: [slot] } = await trial.database.pool.query('SELECT task_id FROM itervane.execution_slot WHERE id=1');
  equal(slot?.task_id, null);
  const { rows: [last] } = await trial.database.pool.query(`SELECT type,state FROM itervane.task_events
    WHERE task_id=$1 ORDER BY sequence DESC LIMIT 1`, [trial.taskId]);
  deepStrictEqual(last, { type: outcome, state: 'reconciling' });
}

function noWrites(tick: Tick, registryReads = 0) {
  equal(tick.imports, 0);
  equal(tick.registryReads, registryReads);
  equal(tick.configurationWrites, 0);
  equal(tick.dispatches, 0);
}

export async function proveKnownKomodoRecovery(trial: Trial, registryFence: number) {
  await expired(trial, registryFence);
  // The preceding Registry observation used a recovery attempt. Reconciliation schedules its next wakeup with a delay.
  const handoff = await waitForFixture(async () => {
    const current = await trial.tick();
    if (current.status !== 'idle') return current;
    noWrites(current);
  }, 'komodo_registry_handoff');
  ok(handoff.status === 'komodo_ready');
  equal(handoff.mode, 'registry_recovery');
  ok(handoff.fence > registryFence);
  noWrites(handoff, 1);

  const configured = await trial.interrupt('configured');
  ok(configured.fence > handoff.fence);
  equal(configured.configurationWrites, 1);
  equal(configured.dispatches, 0);
  equal(configured.imageReference, trial.reference);
  const configRows = await readLedger(trial);
  deepStrictEqual(configRows, [{ kind: 'komodo_config', state: 'prepared', prepared_fence: configured.fence,
    settled_fence: null, external_update_id: null, proof: null }]);
  await expired(trial, configured.fence);
  const readConfig = await trial.tick();
  ok(readConfig.status === 'komodo_ready');
  equal(readConfig.mode, 'komodo_recovery');
  ok(readConfig.fence > configured.fence);
  noWrites(readConfig);

  const deployed = await trial.interrupt('update-recorded');
  ok(deployed.fence > readConfig.fence);
  equal(deployed.configurationWrites, 0);
  equal(deployed.dispatches, 1);
  const updateId = komodoResourceIdSchema.parse(deployed.updateId);
  const prepared = await readLedger(trial);
  equal(prepared[1]?.state, 'prepared');
  equal(prepared[1]?.external_update_id, updateId);
  equal(prepared[1]?.settled_fence, null);
  await expired(trial, deployed.fence);
  const complete = await waitForFixture(async () => {
    const current = await trial.tick();
    noWrites(current);
    if (current.status === 'awaiting_rollout') return current;
    ok(current.status === 'idle' || current.status === 'requeued');
  }, 'komodo_result_observation', 70_000);
  ok(complete.fence > deployed.fence && complete.updateReads > 0);
  equal(complete.mode, 'komodo_recovery');
  const [config, dispatch] = await readLedger(trial);
  ok(config && dispatch);
  equal(config.settled_fence, readConfig.fence);
  equal(dispatch.prepared_fence, deployed.fence);
  equal(dispatch.settled_fence, complete.fence);
  const result = releaseKomodoCompletionSchema.parse(dispatch.proof);
  equal(result.updateId, updateId);
  equal(result.success, true);
  const running = await trial.observeContainer(trial.reference, trial.configDigest);
  await keptEnvironment(trial, 'task.release_komodo_awaiting_rollout');
  return { operationId: trial.operationId, configuredFence: configured.fence, observedConfigFence: readConfig.fence,
    dispatchFence: deployed.fence, observedDispatchFence: complete.fence, updateId, running, writes: { configuration: 1, dispatch: 1 } };
}

export async function proveUnknownKomodoDispatch(trial: Trial, materializer: string, knownUpdateId: string) {
  const imported = await trial.tick(materializer);
  ok(imported.status === 'komodo_ready');
  equal(imported.mode, 'import');
  equal(imported.imports, 1);
  equal(imported.configurationWrites, 0);
  equal(imported.dispatches, 0);
  const lost = await trial.interrupt('update-unrecorded');
  ok(lost.fence > imported.fence);
  equal(lost.configurationWrites, 1);
  equal(lost.dispatches, 1);
  const actualUpdateId = komodoResourceIdSchema.parse(lost.updateId);
  notEqual(actualUpdateId, knownUpdateId);
  const [config, dispatch] = await readLedger(trial);
  ok(config && dispatch);
  equal(config.state, 'confirmed');
  equal(dispatch.state, 'prepared');
  equal(dispatch.external_update_id, null);
  await expired(trial, lost.fence);
  const skipped = await trial.tick();
  equal(skipped.status, 'idle');
  noWrites(skipped);
  equal(skipped.updateReads, 0);
  deepStrictEqual(await readLedger(trial), [config, dispatch]);
  await keptEnvironment(trial, 'task.release_komodo_manual_review');
  const running = await trial.observeContainer(trial.reference, trial.configDigest);
  return { operationId: trial.operationId, dispatchFence: lost.fence, actualUpdateId, running, retainedForManualReview: true,
    writes: { configuration: 1, dispatch: 1 } };
}
