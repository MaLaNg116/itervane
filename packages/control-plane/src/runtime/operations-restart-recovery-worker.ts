import { ExecutionLost } from './authority.js';
import { withOperationsLeaseHeartbeat, type OperationsExecutionCoordinator, type OperationsExecutionLease } from './operations-execution-lease.js';
import { RestartRecoveryRejected, type RecoveryFailure } from './operations-restart-recovery.js';
import { KomodoReleaseError } from './release-komodo.js';
import type { ReleaseRolloutVerifier } from './release-rollout.js';
import { ReleaseIngressError } from './release-traefik.js';

function readFailure(error: unknown): RecoveryFailure | undefined {
  if (error instanceof RestartRecoveryRejected) return error.reason;
  if (error instanceof KomodoReleaseError) return error.reason === 'binding' ? 'target_changed'
    : error.step === 'InspectDeploymentContainer' && error.reason === 'response' ? 'unhealthy' : 'unavailable';
  if (error instanceof ReleaseIngressError) {
    if (error.reason === 'health_failed') return 'unhealthy';
    if (error.reason === 'ingress_unavailable' || error.reason === 'probe_identity') return 'unavailable';
    return 'target_changed';
  }
}

export class OperationsRestartRecoveryWorker {
  constructor(private readonly execution: OperationsExecutionCoordinator, private readonly verifier: Pick<ReleaseRolloutVerifier, 'observeRestart'>) {}

  async verify(scope: OperationsExecutionLease, signal?: AbortSignal) {
    return withOperationsLeaseHeartbeat(this.execution, scope, signal, async live => {
      try {
        live.throwIfAborted();
        const { subject, baseline } = await this.execution.authorizeRestartRecovery(scope);
        const authorize = async () => {
          live.throwIfAborted();
          await this.execution.authorizeRestartRecovery(scope);
        };
        const observation = await this.verifier.observeRestart(subject, baseline, authorize, live);
        live.throwIfAborted();
        return await this.execution.settleRestartRecovery(scope, observation);
      } catch (error) {
        if (error instanceof ExecutionLost || live.aborted) return 'lease_lost' as const;
        const failure = readFailure(error);
        if (!failure) throw error;
        try { return await this.execution.deferRestartRecovery(scope, failure); }
        catch (settlement) {
          if (settlement instanceof ExecutionLost) return 'lease_lost' as const;
          throw settlement;
        }
      }
    });
  }
}
