import type { InstalledReleaseTarget } from '../service/release-targets.js';
import { DomainError } from '../service/errors.js';
import { ExecutionLost } from './authority.js';
import { withOperationsLeaseHeartbeat, type OperationsExecutionCoordinator, type OperationsExecutionLease } from './operations-execution-lease.js';
import { restoreImageReference } from './operations-restore-steps.js';
import type { KomodoReleaseClient } from './release-komodo.js';

export class OperationsRestoreWorker {
  constructor(private readonly execution: OperationsExecutionCoordinator,
    private readonly installation: InstalledReleaseTarget & { network: string },
    private readonly writer: Pick<KomodoReleaseClient, 'configureImage' | 'dispatch'>,
    private readonly reader: Pick<ReturnType<typeof KomodoReleaseClient.readOnly>, 'inspectTarget' | 'inspectStoppedRuntime'>) {}

  async dispatch(scope: OperationsExecutionLease, signal?: AbortSignal) {
    if (scope.mode !== 'dispatch') throw new ExecutionLost();
    return withOperationsLeaseHeartbeat(this.execution, scope, signal, async live => {
      try { await this.send(scope, live); }
      catch (error) { if (error instanceof ExecutionLost) return 'lease_lost' as const; }
      try { return await this.execution.deferRestore(scope); }
      catch (error) {
        if (error instanceof ExecutionLost) return 'lease_lost' as const;
        throw error;
      }
    });
  }

  private async send(scope: OperationsExecutionLease, signal: AbortSignal) {
    signal.throwIfAborted();
    await this.execution.prepareRestoreDispatch(scope, this.installation);
    const intent = await this.execution.readRestoreIntent(scope);
    const { plan, sha256 } = intent;
    const { target, current, restore } = plan;
    const observe = async () => {
      if ((await this.execution.readRestoreIntent(scope)).sha256 !== sha256) throw new ExecutionLost();
    };
    await this.writer.configureImage(target, {
      previousImage: restoreImageReference(target, current.manifestDigest), manifestDigest: restore.manifestDigest,
    }, async () => {
      const stopped = await this.reader.inspectStoppedRuntime(target, current, this.installation.network, observe, signal);
      if (stopped.containerId !== current.containerId) throw new DomainError('version_conflict');
      signal.throwIfAborted();
      await this.execution.beginRestoreStep(scope, 'configure', sha256);
    }, signal, observe);
    const configuration = await this.reader.inspectTarget(target, observe, signal);
    await this.execution.recordRestoreStep(scope, 'configure', sha256, configuration);
    const received = await this.writer.dispatch(target, restore.manifestDigest,
      () => this.execution.beginRestoreStep(scope, 'deploy', sha256), signal, observe);
    await this.execution.recordRestoreStep(scope, 'deploy', sha256, received);
  }
}
