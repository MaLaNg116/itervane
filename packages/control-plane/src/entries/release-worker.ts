import { setTimeout } from 'node:timers/promises';
import { QualifiedInspectionClient } from '@itervane/runner';
import { releaseWorkerConfig } from '../config.js';
import { openDatabase } from '../persistence/database.js';
import { ExecutionLost } from '../runtime/authority.js';
import { FormalReleaseWorker } from '../runtime/formal-release-worker.js';
import { FormalRolloutCoordinator } from '../runtime/formal-rollout-claim.js';
import { FormalRolloutWorker } from '../runtime/formal-rollout-worker.js';
import { KomodoReleaseClient } from '../runtime/release-komodo.js';
import { ReleaseRegistryPublisher } from '../runtime/release-registry.js';
import { createKeycloakRolloutTokenSource, ReleaseRolloutVerifier } from '../runtime/release-rollout.js';
import { readInstalledReleaseTarget } from '../service/release-targets.js';

async function poll(tick: () => Promise<unknown>, failureCode: string, pollMs: number, signal: AbortSignal) {
  while (!signal.aborted) {
    try { await tick(); }
    catch (error) {
      if (!(error instanceof ExecutionLost) && !signal.aborted) console.error(JSON.stringify({ level: 'error', code: failureCode }));
    }
    if (!signal.aborted) await setTimeout(pollMs, undefined, { signal }).catch(() => undefined);
  }
}

try {
  const config = releaseWorkerConfig();
  const database = await openDatabase(config.databaseUrl);
  const controller = new AbortController();
  const stop = () => controller.abort();
  try {
    const target = await readInstalledReleaseTarget(database, config.installed);
    const { registryOrigin, komodo: identity, rolloutCheck } = target;
    const { credentials } = config;
    const registry = new ReleaseRegistryPublisher({ origin: registryOrigin,
      ...(credentials.registry ? { credentials: credentials.registry } : {}) }, config.tools);
    const komodo = new KomodoReleaseClient(identity.origin, {
      actorId: identity.actorId, key: credentials.komodoKey, secret: credentials.komodoSecret,
    });
    await komodo.verifyCredentialOwner(controller.signal);
    const runner = new QualifiedInspectionClient(config.runner);
    const writer = new FormalReleaseWorker(database, { origin: registryOrigin, registry, runner, komodo, installed: config.installed },
      { leaseSeconds: config.leaseSeconds });
    const coordinator = new FormalRolloutCoordinator(database, registryOrigin, undefined, config.installed);
    const verifier = new ReleaseRolloutVerifier(komodo, createKeycloakRolloutTokenSource(rolloutCheck.probeIdentity, credentials.probeSecret));
    const observer = new FormalRolloutWorker(coordinator, komodo, verifier);
    const signal = controller.signal;

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await Promise.all([
      poll(() => writer.tick(signal), 'release_worker_tick_failed', config.pollMs, signal),
      poll(() => observer.tick(writer.workerId, signal), 'rollout_worker_tick_failed', config.pollMs, signal),
    ]);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await database.close();
  }
} catch {
  console.error('Release Worker startup failed. Check the Runner, enrolled release target, local tools, and release credentials.');
  process.exitCode = 1;
}
