import { randomUUID } from 'node:crypto';
import type { restoreWorkerConfig } from '../config.js';
import { operationsRestoreQueue, type Database } from '../persistence/database.js';
import { lockEnvironmentForEffect } from '../service/environment-effects.js';
import { readInstalledOperationsEnrollment } from '../service/operations-targets.js';
import { readInstalledReleaseTarget } from '../service/release-targets.js';
import { ExecutionCoordinator } from './coordinator.js';
import { targetForKomodo } from './formal-komodo-steps.js';
import { OperationsExecutionCoordinator } from './operations-execution-lease.js';
import { OperationsRestoreRecoveryWorker } from './operations-restore-recovery-worker.js';
import { OperationsRestoreWorker } from './operations-restore-worker.js';
import { KomodoReleaseClient } from './release-komodo.js';
import { createKeycloakRolloutTokenSource, ReleaseRolloutVerifier } from './release-rollout.js';

export class RestoreQueueWorker {
  readonly workerId = randomUUID();

  constructor(private readonly coordinator: OperationsExecutionCoordinator,
    private readonly writer: Pick<OperationsRestoreWorker, 'dispatch'>, private readonly observer: Pick<OperationsRestoreRecoveryWorker, 'verify'>) {}

  async tick(signal?: AbortSignal) {
    const scope = await this.coordinator.claimNext(this.workerId, 'rollback', signal);
    if (!scope) return 'idle' as const;
    return scope.mode === 'reconcile' ? this.observer.verify(scope, signal) : this.writer.dispatch(scope, signal);
  }
}

export async function createInstalledRestoreWorker(database: Database, config: ReturnType<typeof restoreWorkerConfig>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!await database.boss.getQueue(operationsRestoreQueue)) throw new Error('operations_restore_queue_required');
  const { installed } = config;
  const release = await readInstalledReleaseTarget(database, installed);
  await database.db.transaction(async tx => {
    await lockEnvironmentForEffect(tx, installed.environmentId);
    await readInstalledOperationsEnrollment(tx, installed);
  });

  const writer = new KomodoReleaseClient(release.komodo.origin, { ...config.writer, actorId: release.komodo.actorId });
  const reader = KomodoReleaseClient.readOnly(targetForKomodo(release), config.reader);
  await Promise.all([writer.verifyCredentialOwner(signal), reader.verifyInstallation(signal)]);

  const verifier = new ReleaseRolloutVerifier(reader, createKeycloakRolloutTokenSource(release.rolloutCheck.probeIdentity, config.probeSecret));
  const coordinator = new OperationsExecutionCoordinator(new ExecutionCoordinator(database, { leaseSeconds: config.leaseSeconds }), installed);
  const sender = new OperationsRestoreWorker(coordinator, { ...installed, network: release.rolloutCheck.network }, writer, reader);
  return new RestoreQueueWorker(coordinator, sender, new OperationsRestoreRecoveryWorker(coordinator, reader, verifier));
}
