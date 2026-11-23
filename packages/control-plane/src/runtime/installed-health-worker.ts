import type { OperationsHealthSignal } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import type { healthWorkerConfig } from '../config.js';
import type { Database } from '../persistence/database.js';
import { lockEnvironmentForEffect } from '../service/environment-effects.js';
import { DomainError } from '../service/errors.js';
import { OperationsHealthJournal } from '../service/operations-health.js';
import { OperationsIncidentScheduler } from '../service/operations-incident-scheduler.js';
import { readInstalledOperationsEnrollment } from '../service/operations-targets.js';
import { readInstalledReleaseTarget } from '../service/release-targets.js';
import { targetForKomodo } from './formal-komodo-steps.js';
import { KomodoReleaseClient, KomodoReleaseError } from './release-komodo.js';
import { createKeycloakRolloutTokenSource, ReleaseRolloutVerifier } from './release-rollout.js';
import { ReleaseIngressError } from './release-traefik.js';

type UnavailableHealthReason = Extract<OperationsHealthSignal, { status: 'unavailable' }>['reason'];

function unavailableHealthReason(error: unknown): UnavailableHealthReason | undefined {
  if (error instanceof KomodoReleaseError) return error.reason === 'binding' ? 'target_changed' : 'komodo_unavailable';
  if (error instanceof ReleaseIngressError) {
    if (error.reason === 'probe_identity') return 'probe_identity';
    if (error.reason === 'runtime_changed' || error.reason === 'rollout_profile' || error.reason === 'ingress_route') return 'target_changed';
    return 'ingress_unavailable';
  }
}

export class OperationsHealthWorker {
  constructor(private readonly journal: OperationsHealthJournal,
    private readonly verifier: Pick<ReleaseRolloutVerifier, 'observeApplicationHealth'>,
    private readonly scheduler?: OperationsIncidentScheduler) {}

  async tick(signal?: AbortSignal) {
    try {
      signal?.throwIfAborted();
      const { probe, target, version } = await this.journal.prepareProbe();
      const deadline = AbortSignal.timeout(30_000);
      const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const authorize = () => this.journal.authorizeProbe(probe);
      let outcome: OperationsHealthSignal;
      try {
        outcome = await this.verifier.observeApplicationHealth({
          check: target.rolloutCheck, rolloutCheckSha256: target.rolloutCheckSha256, target: targetForKomodo(target),
          image: probe.binding, containerId: probe.binding.containerId, version,
        }, authorize, active);
      } catch (error) {
        signal?.throwIfAborted();
        const reason = deadline.aborted ? 'ingress_unavailable' : unavailableHealthReason(error);
        if (!reason) throw error;
        outcome = { status: 'unavailable', reason, evidenceSha256: sha256(JSON.stringify({ version: 1, reason, binding: probe.binding })) };
      }
      signal?.throwIfAborted();
      const sample = await this.journal.recordProbe(probe, outcome);
      signal?.throwIfAborted();
      const diagnosis = await this.scheduler?.tick();
      return { status: 'recorded' as const, outcome, ...sample, ...(diagnosis ? { diagnosis } : {}) };
    } catch (error) {
      if (error instanceof DomainError && ['not_found', 'unsupported_state', 'unavailable', 'version_conflict', 'conflict'].includes(error.code)) {
        return { status: 'skipped' as const, reason: error.code };
      }
      throw error;
    }
  }
}

export async function createInstalledHealthWorker(database: Database, config: ReturnType<typeof healthWorkerConfig>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { installed, incidentMonitorId } = config;
  const release = await readInstalledReleaseTarget(database, installed);
  await database.db.transaction(async tx => {
    await lockEnvironmentForEffect(tx, installed.environmentId);
    await readInstalledOperationsEnrollment(tx, installed);
  });
  const reader = KomodoReleaseClient.readOnly(targetForKomodo(release), config.reader);
  await reader.verifyInstallation(signal);
  const scheduler = incidentMonitorId ? new OperationsIncidentScheduler(database, { ...installed, monitorId: incidentMonitorId }) : undefined;
  return new OperationsHealthWorker(new OperationsHealthJournal(database, installed),
    new ReleaseRolloutVerifier(reader, createKeycloakRolloutTokenSource(release.rolloutCheck.probeIdentity, config.probeSecret)), scheduler);
}
