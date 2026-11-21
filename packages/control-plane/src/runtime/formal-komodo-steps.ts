import {
  type FormalReleaseTarget, type ReleaseKomodoCompletion, type ReleaseKomodoConfiguration, type ReleaseKomodoIntent,
  type komodoReleasePhases, releaseKomodoCompletionSchema, releaseKomodoConfigurationSchema, releaseKomodoIntentSchema,
  releaseKomodoUpdateSchema,
} from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, eq, sql } from 'drizzle-orm';
import { formalReleaseSteps, runRuntime } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { DomainError, parseInput } from '../service/errors.js';
import { appendEvent, ExecutionLost, type TaskRow } from './authority.js';
import { ReleaseAuthorityRejected, type FormalReleaseCoordinator, type FormalReleaseScope } from './formal-release-claim.js';
import { releaseStepEvent, requireMatchingRegistryImage } from './formal-release-steps.js';
import type { KomodoReleaseTarget } from './release-komodo.js';
import { lockKomodoSteps, type KomodoStepKind } from './release-queue.js';

const preparedPhase = {
  komodo_config: 'release_komodo_config_prepared',
  komodo_dispatch: 'release_komodo_dispatch_prepared',
} as const;
type KomodoStep = KomodoStepKind;
type Phase = typeof komodoReleasePhases[number];

function targetForKomodo(mapping: FormalReleaseTarget & { registryOrigin: string }): KomodoReleaseTarget {
  const { komodo, registryOrigin, deploymentId, serverId, imageRepository, runtimeConfigSha256 } = mapping;
  if (!komodo) throw new ReleaseAuthorityRejected('release_target_changed');
  return { komodo, registryOrigin, deploymentId, serverId, imageRepository, runtimeConfigSha256 };
}

function stepFilter(scope: FormalReleaseScope, kind: KomodoStep | 'registry') {
  return and(eq(formalReleaseSteps.operationId, scope.operationId), eq(formalReleaseSteps.kind, kind));
}

async function readStep(tx: Transaction, scope: FormalReleaseScope, kind: KomodoStep, state: 'prepared' | 'confirmed') {
  const [step] = await tx.select().from(formalReleaseSteps).where(stepFilter(scope, kind)).for('update');
  if (step?.state !== state) throw new ExecutionLost();
  if (state === 'prepared') {
    const recovery = scope.mode === 'komodo_recovery';
    if (recovery ? scope.komodoStep !== kind || step.preparedFence >= scope.fence
      : step.preparedFence !== scope.fence || step.preparedBy !== scope.workerId) throw new ExecutionLost();
  }
  return { ...step, intent: parseInput(releaseKomodoIntentSchema, step.intent) };
}

async function advance(tx: Transaction, task: TaskRow, scope: FormalReleaseScope, phase: Phase) {
  if (scope.mode !== 'komodo_recovery') await tx.update(runRuntime).set({ reason: phase }).where(eq(runRuntime.runId, scope.runId));
  await appendEvent(tx, task, `task.${phase}`, task.state, releaseStepEvent(scope));
}

async function prepare(tx: Transaction, task: TaskRow, scope: FormalReleaseScope, kind: KomodoStep, intent: ReleaseKomodoIntent) {
  const [created] = await tx.insert(formalReleaseSteps).values({ operationId: scope.operationId, kind, intent,
    preparedFence: scope.fence, preparedBy: scope.workerId, createdAt: sql`clock_timestamp()` }).onConflictDoNothing().returning();
  if (!created) throw new DomainError('conflict');
  await advance(tx, task, scope, preparedPhase[kind]);
}

async function confirm(tx: Transaction, scope: FormalReleaseScope, kind: KomodoStep,
  proof: ReleaseKomodoConfiguration | ReleaseKomodoCompletion) {
  await tx.update(formalReleaseSteps).set({ state: 'confirmed', proof,
    settledFence: scope.fence, settledBy: scope.workerId, settledAt: sql`clock_timestamp()`,
  }).where(stepFilter(scope, kind));
}

function checkConfiguration(raw: unknown, expected: Pick<ReleaseKomodoConfiguration, 'deploymentId' | 'serverId' | 'runtimeConfigSha256'>) {
  const configuration = parseInput(releaseKomodoConfigurationSchema, raw);
  if (configuration.deploymentId !== expected.deploymentId || configuration.serverId !== expected.serverId
      || configuration.runtimeConfigSha256 !== expected.runtimeConfigSha256) throw new DomainError('conflict');
  return configuration;
}

export class FormalKomodoSteps {
  constructor(private readonly release: FormalReleaseCoordinator) {}

  async readyTarget(scope: FormalReleaseScope) {
    return this.release.withAuthorizedRelease(scope, async (tx, _task, phase, { mapping }) => {
      if (scope.mode !== 'komodo_write' || phase !== 'release_komodo_ready') throw new ExecutionLost();
      const { config, dispatch } = await lockKomodoSteps(tx, scope.operationId);
      if (dispatch || (config && config.state !== 'confirmed')) throw new ExecutionLost();
      return { target: targetForKomodo(mapping), configured: config?.state === 'confirmed' };
    });
  }

  async prepareConfiguration(scope: FormalReleaseScope, observed: unknown) {
    return this.release.withAuthorizedRelease(scope, async (tx, task, phase, { mapping, manifest }) => {
      if (phase !== 'release_registry_verified' && phase !== 'release_komodo_ready') throw new DomainError('unsupported_state');
      const [registry] = await tx.select().from(formalReleaseSteps).where(stepFilter(scope, 'registry'));
      if (registry?.state !== 'confirmed') throw new DomainError('unsupported_state');
      if (scope.mode === 'import' && (registry.preparedFence !== scope.fence || registry.preparedBy !== scope.workerId)) {
        throw new ExecutionLost();
      }
      const image = requireMatchingRegistryImage(registry.proof, mapping, manifest.image);
      const target = targetForKomodo(mapping);
      const before = checkConfiguration(observed, target);
      const { revision, mappingSha256 } = manifest.target;
      const intent = { ...target.komodo, revision, mappingSha256, deploymentId: target.deploymentId, serverId: target.serverId,
        runtimeConfigSha256: target.runtimeConfigSha256, imageReference: image.reference, previousImageSha256: sha256(before.imageReference) };
      await prepare(tx, task, scope, 'komodo_config', intent);
      return { target, previousImage: before.imageReference, manifestDigest: image.manifestDigest };
    });
  }

  async authorizeWrite(scope: FormalReleaseScope, kind: KomodoStep) {
    await this.release.withAuthorizedRelease(scope, async (tx, _task, phase) => {
      if (phase !== preparedPhase[kind]) throw new ExecutionLost();
      const step = await readStep(tx, scope, kind, 'prepared');
      if (step.externalUpdateId) throw new ExecutionLost();
    });
  }

  async confirmConfiguration(scope: FormalReleaseScope, observed: unknown) {
    return this.release.withKomodoObservation(scope, preparedPhase.komodo_config, async (tx, task) => {
      const { intent } = await readStep(tx, scope, 'komodo_config', 'prepared');
      const proof = checkConfiguration(observed, intent);
      if (proof.imageReference !== intent.imageReference) throw new DomainError('conflict');
      await confirm(tx, scope, 'komodo_config', proof);
      await advance(tx, task, scope, 'release_komodo_configured');
      return proof;
    });
  }

  async configurationObservation(scope: FormalReleaseScope) {
    return this.release.withKomodoObservation(scope, preparedPhase.komodo_config, async (tx, _task, mapping) => {
      await readStep(tx, scope, 'komodo_config', 'prepared');
      return targetForKomodo(mapping);
    });
  }

  async prepareDispatch(scope: FormalReleaseScope) {
    return this.release.withAuthorizedRelease(scope, async (tx, task, phase, { mapping, manifest }) => {
      if (phase !== 'release_komodo_configured' && phase !== 'release_komodo_ready') throw new DomainError('unsupported_state');
      const { intent } = await readStep(tx, scope, 'komodo_config', 'confirmed');
      await prepare(tx, task, scope, 'komodo_dispatch', intent);
      return { target: targetForKomodo(mapping), manifestDigest: manifest.image.manifestDigest };
    });
  }

  async authorizeDispatchReceipt(scope: FormalReleaseScope) {
    await this.release.withKomodoObservation(scope, preparedPhase.komodo_dispatch, async tx => {
      const { externalUpdateId } = await readStep(tx, scope, 'komodo_dispatch', 'prepared');
      if (externalUpdateId) throw new ExecutionLost();
    }, false);
  }

  async recordUpdate(scope: FormalReleaseScope, received: unknown) {
    const update = parseInput(releaseKomodoUpdateSchema, received);
    return this.release.withKomodoObservation(scope, preparedPhase.komodo_dispatch, async (tx, task) => {
      const { intent, externalUpdateId } = await readStep(tx, scope, 'komodo_dispatch', 'prepared');
      if (externalUpdateId || update.deploymentId !== intent.deploymentId || update.actorId !== intent.actorId) {
        throw new DomainError('conflict');
      }
      await tx.update(formalReleaseSteps).set({ externalUpdateId: update.updateId }).where(stepFilter(scope, 'komodo_dispatch'));
      await advance(tx, task, scope, 'release_komodo_update_recorded');
      return update.updateId;
    }, false);
  }

  async dispatchObservation(scope: FormalReleaseScope) {
    return this.release.withKomodoObservation(scope, 'release_komodo_update_recorded', async (tx, _task, mapping) => {
      const { externalUpdateId } = await readStep(tx, scope, 'komodo_dispatch', 'prepared');
      if (!externalUpdateId) throw new ExecutionLost();
      return { target: targetForKomodo(mapping), updateId: externalUpdateId };
    });
  }

  async confirmDispatch(scope: FormalReleaseScope, observed: unknown) {
    const proof = parseInput(releaseKomodoCompletionSchema, observed);
    return this.release.withKomodoObservation(scope, 'release_komodo_update_recorded', async (tx, task) => {
      const { intent, externalUpdateId } = await readStep(tx, scope, 'komodo_dispatch', 'prepared');
      if (proof.updateId !== externalUpdateId || proof.deploymentId !== intent.deploymentId || proof.actorId !== intent.actorId) {
        throw new DomainError('conflict');
      }
      await confirm(tx, scope, 'komodo_dispatch', proof);
      await advance(tx, task, scope, 'release_komodo_dispatch_observed');
      return proof;
    });
  }
}
