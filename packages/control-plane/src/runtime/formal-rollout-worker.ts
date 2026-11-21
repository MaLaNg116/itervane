import type { ReleaseRolloutFailure } from '@itervane/contracts';
import type { FormalRolloutCoordinator, FormalRolloutScope } from './formal-rollout-claim.js';
import { KomodoReleaseError, type KomodoReleaseClient } from './release-komodo.js';
import type { ReleaseRolloutVerifier } from './release-rollout.js';
import { ReleaseIngressError } from './release-traefik.js';

const ingressFailures = {
  ingress_route: 'release_rollout_ingress_changed',
  anonymous_access: 'release_rollout_ingress_changed',
  rollout_profile: 'release_rollout_ingress_changed',
  ingress_unavailable: 'release_rollout_unavailable',
  probe_identity: 'release_rollout_unavailable',
  health_failed: 'release_rollout_health_failed',
  runtime_changed: 'release_rollout_runtime_changed',
} as const satisfies Record<ReleaseIngressError['reason'], ReleaseRolloutFailure>;

type Binding = Awaited<ReturnType<FormalRolloutCoordinator['authorize']>>;

export class FormalRolloutWorker {
  constructor(private readonly coordinator: FormalRolloutCoordinator, private readonly komodo: Pick<KomodoReleaseClient, 'observeUpdate'>,
    private readonly verifier: Pick<ReleaseRolloutVerifier, 'observe'>) {}

  async tick(workerId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const scope = await this.coordinator.claimNext(workerId);
    if (!scope) return 'idle' as const;
    const binding = await this.coordinator.authorize(scope);
    const authorize = async () => {
      signal?.throwIfAborted();
      await this.coordinator.authorize(scope);
    };

    const result = await this.observe(scope, binding, authorize, signal);
    signal?.throwIfAborted();
    return typeof result === 'string'
      ? this.coordinator.requireManualReview(scope, result)
      : this.coordinator.settle(scope, result);
  }

  private async observe(scope: FormalRolloutScope, binding: Binding, authorize: () => Promise<void>, signal?: AbortSignal) {
    const { target, update, manifest, image } = binding;
    const matchesUpdate = async () => {
      const seen = await this.komodo.observeUpdate(target, update.updateId, authorize, signal);
      return seen.updateId === update.updateId && seen.deploymentId === update.deploymentId && seen.actorId === update.actorId
        && seen.status === update.status && seen.success === update.success;
    };

    try {
      if (!await matchesUpdate()) return 'release_rollout_update_changed' as const;
      if (!update.success) return 'release_rollout_update_failed' as const;
      const runtime = await this.verifier.observe(binding, authorize, signal);
      if (!await matchesUpdate()) return 'release_rollout_update_changed' as const;
      return { version: 1, ...binding.decision, rolloutFence: scope.fence, generation: manifest.generation,
        targetRevision: manifest.target.revision, mappingSha256: manifest.target.mappingSha256, manifestDigest: image.manifestDigest,
        update, runtime };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ReleaseIngressError) return ingressFailures[error.reason];
      if (error instanceof KomodoReleaseError) {
        if (error.reason !== 'binding') return 'release_rollout_unavailable' as const;
        return error.step === 'GetUpdate' ? 'release_rollout_update_changed' as const : 'release_rollout_runtime_changed' as const;
      }
      throw error;
    }
  }
}
