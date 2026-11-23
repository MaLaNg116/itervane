import { randomUUID } from 'node:crypto';
import type { restartWorkerConfig } from '../config.js';
import type { Database } from '../persistence/database.js';
import { lockEnvironmentForEffect } from '../service/environment-effects.js';
import { requireOperationsRestartWriter } from '../service/operations-restart-installations.js';
import { readInstalledOperationsEnrollment } from '../service/operations-targets.js';
import { readInstalledReleaseTarget } from '../service/release-targets.js';
import { ExecutionCoordinator } from './coordinator.js';
import { targetForKomodo } from './formal-komodo-steps.js';
import { OperationsExecutionCoordinator } from './operations-execution-lease.js';
import { OperationsRestartRecoveryWorker } from './operations-restart-recovery-worker.js';
import { OperationsRestartWorker } from './operations-restart-worker.js';
import { KomodoReleaseClient } from './release-komodo.js';
import { createKeycloakRolloutTokenSource, ReleaseRolloutVerifier } from './release-rollout.js';
import { loadWhiskersWriter } from './whiskers-writer-installation.js';

export class RestartQueueWorker {
  readonly workerId = randomUUID();

  constructor(private readonly coordinator: OperationsExecutionCoordinator,
    private readonly writer: Pick<OperationsRestartWorker, 'dispatch'>, private readonly observer: Pick<OperationsRestartRecoveryWorker, 'verify'>) {}

  async tick(signal?: AbortSignal) {
    const scope = await this.coordinator.claimNext(this.workerId, 'restart', signal);
    if (!scope) return 'idle' as const;
    return scope.mode === 'reconcile' ? this.observer.verify(scope, signal) : this.writer.dispatch(scope, signal);
  }
}

export async function createInstalledRestartWorker(database: Database, config: ReturnType<typeof restartWorkerConfig>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { installed, files, writeKey } = config;
  const release = await readInstalledReleaseTarget(database, installed);
  const writer = await loadWhiskersWriter(files, writeKey);
  await database.db.transaction(async tx => {
    await lockEnvironmentForEffect(tx, installed.environmentId);
    const enrollment = await readInstalledOperationsEnrollment(tx, installed);
    await requireOperationsRestartWriter(tx, installed, enrollment.whiskers, writer.proof);
  });
  const reader = KomodoReleaseClient.readOnly(targetForKomodo(release), config.komodo);
  await reader.verifyInstallation(signal);
  const verifier = new ReleaseRolloutVerifier(reader, createKeycloakRolloutTokenSource(release.rolloutCheck.probeIdentity, config.probeSecret));
  const coordinator = new OperationsExecutionCoordinator(new ExecutionCoordinator(database, { leaseSeconds: config.leaseSeconds }), installed);
  return new RestartQueueWorker(coordinator, new OperationsRestartWorker(coordinator, verifier, files, writeKey),
    new OperationsRestartRecoveryWorker(coordinator, verifier));
}
