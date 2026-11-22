import { ExecutionLost } from './authority.js';
import { withOperationsLeaseHeartbeat, type OperationsExecutionCoordinator, type OperationsExecutionLease } from './operations-execution-lease.js';
import { RestoreRecoveryRejected, type RestoreReadFailure } from './operations-restore-recovery.js';
import { KomodoReleaseError, type KomodoReleaseClient } from './release-komodo.js';
import type { ReleaseRolloutVerifier } from './release-rollout.js';
import { ReleaseIngressError } from './release-traefik.js';

function readFailure(error: unknown): RestoreReadFailure | undefined {
  if (error instanceof RestoreRecoveryRejected) return error.reason;
  if (error instanceof KomodoReleaseError) return error.reason === 'binding' ? 'target_changed' : 'unavailable';
  if (error instanceof ReleaseIngressError) {
    if (error.reason === 'health_failed') return 'unhealthy';
    if (error.reason === 'ingress_unavailable' || error.reason === 'probe_identity') return 'unavailable';
    return 'target_changed';
  }
}

export class OperationsRestoreRecoveryWorker {
  constructor(private readonly execution: OperationsExecutionCoordinator,
    private readonly reader: Pick<ReturnType<typeof KomodoReleaseClient.readOnly>, 'observeUpdate'>,
    private readonly verifier: Pick<ReleaseRolloutVerifier, 'observe'>) {}

  async verify(scope: OperationsExecutionLease, signal?: AbortSignal) {
    return withOperationsLeaseHeartbeat(this.execution, scope, signal, async live => {
      try {
        live.throwIfAborted();
        const expected = await this.execution.authorizeRestoreRecovery(scope);
        const authorize = async () => {
          live.throwIfAborted();
          const current = await this.execution.authorizeRestoreRecovery(scope);
          if (current.intent.sha256 !== expected.intent.sha256 || current.updateId !== expected.updateId) throw new ExecutionLost();
        };
        const update = await this.reader.observeUpdate(expected.subject.target, expected.updateId, authorize, live);
        if (update.status !== 'Complete') return await this.execution.deferRestoreRecovery(scope, 'update_pending');
        if (!update.success) return await this.execution.deferRestoreRecovery(scope, 'update_failed');
        const runtime = await this.verifier.observe(expected.subject, authorize, live);
        return await this.execution.settleRestoreRecovery(scope, { update, runtime });
      } catch (error) {
        if (error instanceof ExecutionLost) return 'lease_lost' as const;
        const known = readFailure(error);
        if (!known) throw error;
        try { return await this.execution.deferRestoreRecovery(scope, known); }
        catch (settlement) {
          if (settlement instanceof ExecutionLost) return 'lease_lost' as const;
          throw settlement;
        }
      }
    });
  }
}
