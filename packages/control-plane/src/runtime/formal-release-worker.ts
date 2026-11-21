import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import type { ReleaseRegistryImageProof } from '@itervane/contracts';
import type { QualifiedInspectionClient } from '@itervane/runner';
import { formalReleaseQueue, type Database } from '../persistence/database.js';
import type { InstalledReleaseTarget } from '../service/release-targets.js';
import { ExecutionLost } from './authority.js';
import { ExecutionCoordinator } from './coordinator.js';
import { FormalKomodoSteps } from './formal-komodo-steps.js';
import { FormalReleaseCoordinator, ReleaseAuthorityRejected, type FormalReleaseScope, type RegistryPendingReason } from './formal-release-claim.js';
import { FormalReleaseSteps } from './formal-release-steps.js';
import type { KomodoReleaseClient } from './release-komodo.js';
import type { KomodoContinuation } from './release-queue.js';
import type { ReleaseRegistryPublisher } from './release-registry.js';

type ReleaseBackend = {
  origin: string;
  installed?: InstalledReleaseTarget;
  registry: Pick<ReleaseRegistryPublisher, 'publish' | 'observe'>;
  runner?: Pick<QualifiedInspectionClient, 'withRetainedArchive'>;
  komodo?: Pick<KomodoReleaseClient, 'inspectTarget' | 'configureImage' | 'dispatch' | 'observeUpdate'>;
};

type ReleaseTick =
  | { status: 'idle' }
  | { status: 'registry_verified'; scope: FormalReleaseScope; proof: ReleaseRegistryImageProof }
  | { status: KomodoContinuation | 'yielded' | 'lease_lost'; scope: FormalReleaseScope };

export class FormalReleaseWorker {
  readonly workerId = randomUUID();
  readonly leaseSeconds: number;
  private readonly release: FormalReleaseCoordinator;
  private readonly steps: FormalReleaseSteps;
  private readonly komodo: FormalKomodoSteps;

  constructor(private readonly database: Database, private readonly backend: ReleaseBackend, options: { leaseSeconds?: number } = {}) {
    const coordinator = new ExecutionCoordinator(database, options);
    this.leaseSeconds = coordinator.leaseSeconds;
    this.release = new FormalReleaseCoordinator(coordinator, backend.origin, backend.installed);
    this.steps = new FormalReleaseSteps(this.release);
    this.komodo = new FormalKomodoSteps(this.release);
  }

  async tick(signal?: AbortSignal): Promise<ReleaseTick> {
    signal?.throwIfAborted();
    await this.release.reconcile(this.workerId);
    signal?.throwIfAborted();
    const [job] = await this.database.boss.fetch(formalReleaseQueue, { includeMetadata: true });
    const scope = job && await this.release.claim(job, this.workerId);
    if (!scope) return { status: 'idle' };

    const controller = new AbortController();
    const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let heartbeat: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (heartbeat || active.aborted) return;
      const renewed = this.heartbeat(scope);
      heartbeat = renewed.then(alive => { if (!alive) controller.abort(new ExecutionLost()); }, error => controller.abort(error))
        .finally(() => { heartbeat = undefined; });
    }, this.leaseSeconds * 1000 / 3);
    try {
      if (scope.mode === 'import') return await this.importImage(scope, active);
      if (scope.mode === 'registry_recovery') return await this.observeRegistry(scope, active);
      return await this.runKomodo(scope, active);
    } catch (error) {
      if (error instanceof ExecutionLost) return { status: 'lease_lost', scope };
      throw error;
    } finally {
      clearInterval(timer);
      await heartbeat;
    }
  }

  private heartbeat(scope: FormalReleaseScope) {
    if (scope.mode === 'import') return this.release.heartbeat(scope);
    if (scope.mode === 'registry_recovery') return this.release.heartbeatRegistryObservation(scope);
    return this.release.heartbeatKomodo(scope);
  }

  private async importImage(scope: FormalReleaseScope, signal: AbortSignal): Promise<ReleaseTick> {
    let prepared = false;
    let proof: ReleaseRegistryImageProof;
    try {
      signal.throwIfAborted();
      if (!this.backend.runner) throw new Error('release_archive_unavailable');
      const archive = await this.steps.prepareArchive(scope);
      proof = await this.backend.runner.withRetainedArchive(archive, async () => {
        await this.release.authorize(scope);
      }, async path => {
        await this.steps.confirmArchive(scope, archive);
        signal.throwIfAborted();
        const { mapping, manifest } = await this.steps.prepareRegistry(scope);
        prepared = true;
        const { archive: ociArchive, manifestDigest, configDigest } = manifest.image;
        return this.backend.registry.publish({
          registryOrigin: mapping.registryOrigin, imageRepository: mapping.imageRepository,
        }, { archive: ociArchive, manifestDigest, configDigest }, path, () => this.release.authorizeRegistryWrite(scope), signal);
      }, signal);
    } catch (error) {
      if (prepared) return this.defer(scope, error);
      if (signal.aborted) return { status: await this.release.yieldClaim(scope) ? 'cancelled' : 'yielded', scope };
      const cancelled = await this.release.stopBeforeRegistry(scope, error instanceof ReleaseAuthorityRejected ? error.reason : undefined);
      return { status: cancelled ? 'cancelled' : 'blocked', scope };
    }
    // Only settle after both the OCI materialization and the transferred archive have been cleaned up.
    return this.verified(scope, proof);
  }

  private async observeRegistry(scope: FormalReleaseScope, signal: AbortSignal): Promise<ReleaseTick> {
    const inspectContext = () => this.release.withRegistryObservation(scope, async (_tx, _task, context) => context);
    let proof: ReleaseRegistryImageProof | null;
    try {
      signal.throwIfAborted();
      const { mapping, manifest } = await inspectContext();
      const { archive, manifestDigest, configDigest } = manifest.image;
      proof = await this.backend.registry.observe({
        registryOrigin: mapping.registryOrigin, imageRepository: mapping.imageRepository,
      }, { archive, manifestDigest, configDigest }, async () => { await inspectContext(); }, signal);
    } catch (error) {
      return this.defer(scope, error);
    }
    if (!proof) return this.defer(scope);
    return this.verified(scope, proof);
  }

  private async verified(scope: FormalReleaseScope, proof: ReleaseRegistryImageProof): Promise<ReleaseTick> {
    let confirmed: ReleaseRegistryImageProof;
    try { confirmed = await this.steps.confirmRegistry(scope, proof); }
    catch (error) { return this.defer(scope, error); }
    if (await this.release.settleRegistryCancellation(scope)) return { status: 'cancelled', scope };
    if (this.backend.komodo) return { status: await this.release.handoffKomodo(scope), scope };
    return { status: 'registry_verified', scope, proof: confirmed };
  }

  private async runKomodo(scope: FormalReleaseScope, signal: AbortSignal): Promise<ReleaseTick> {
    const client = this.backend.komodo;
    try {
      signal.throwIfAborted();
      if (!client) throw new Error('release_komodo_unavailable');
      if (scope.mode === 'komodo_write') {
        const ready = await this.komodo.readyTarget(scope);
        if (!ready.configured) {
          const current = await client.inspectTarget(ready.target, async () => { await this.komodo.readyTarget(scope); }, signal);
          const prepared = await this.komodo.prepareConfiguration(scope, current);
          const checked = await client.configureImage(prepared.target, prepared,
            () => this.komodo.authorizeWrite(scope, 'komodo_config'), signal,
            async () => { await this.komodo.configurationObservation(scope); });
          await this.komodo.confirmConfiguration(scope, checked);
        }
        const prepared = await this.komodo.prepareDispatch(scope);
        const received = await client.dispatch(prepared.target, prepared.manifestDigest,
          () => this.komodo.authorizeWrite(scope, 'komodo_dispatch'), signal, () => this.komodo.authorizeDispatchReceipt(scope));
        await this.komodo.recordUpdate(scope, received);
        await this.observeKomodoUpdate(client, scope, signal);
      } else if (scope.mode === 'komodo_recovery' && scope.komodoStep === 'komodo_config') {
        const target = await this.komodo.configurationObservation(scope);
        const observed = await client.inspectTarget(target, async () => { await this.komodo.configurationObservation(scope); }, signal);
        await this.komodo.confirmConfiguration(scope, observed);
      } else {
        await this.observeKomodoUpdate(client, scope, signal);
      }
    } catch (error) {
      const reason = error instanceof ReleaseAuthorityRejected ? error.reason : 'release_komodo_unavailable';
      return { status: await this.release.finishKomodo(scope, reason), scope };
    }
    return { status: await this.release.finishKomodo(scope), scope };
  }

  private async observeKomodoUpdate(client: NonNullable<ReleaseBackend['komodo']>, scope: FormalReleaseScope, signal: AbortSignal) {
    const { target, updateId } = await this.komodo.dispatchObservation(scope);
    const authorize = async () => { await this.komodo.dispatchObservation(scope); };
    const deadline = performance.now() + 15_000;
    do {
      const observed = await client.observeUpdate(target, updateId, authorize, signal);
      if (observed.status === 'Complete') {
        await this.komodo.confirmDispatch(scope, observed);
        return;
      }
      await wait(1_000, undefined, { signal });
    } while (performance.now() < deadline);
    throw new Error('release_komodo_unavailable');
  }

  private async defer(scope: FormalReleaseScope, error?: unknown): Promise<ReleaseTick> {
    const reason: RegistryPendingReason = error instanceof ReleaseAuthorityRejected && error.reason === 'release_target_changed'
      ? error.reason : error === undefined ? 'release_registry_missing' : 'release_registry_unavailable';
    const queued = await this.release.deferRegistryObservation(scope, reason);
    return { status: queued ? 'requeued' : 'manual_review', scope };
  }
}
