import { releaseKomodoConfigurationSchema, releaseKomodoUpdateSchema, releaseRegistryHost, type OperationsRestorePlan } from '@itervane/contracts';
import type { operationsRestoreSteps } from '../persistence/schema.js';
import { DomainError, parseInput } from '../service/errors.js';

export type OperationsRestoreStep = typeof operationsRestoreSteps.$inferSelect.kind;

export function restoreImageReference(target: OperationsRestorePlan['target'], manifestDigest: string) {
  return `${releaseRegistryHost(target.registryOrigin)}/${target.imageRepository}@${manifestDigest}`;
}

export function parseRestoreStepReceipt(plan: OperationsRestorePlan, step: OperationsRestoreStep, raw: unknown) {
  const { target } = plan;
  if (step === 'configure') {
    const configuration = parseInput(releaseKomodoConfigurationSchema, raw);
    if (configuration.deploymentId !== target.deploymentId || configuration.serverId !== target.serverId
        || configuration.runtimeConfigSha256 !== target.runtimeConfigSha256
        || configuration.imageReference !== restoreImageReference(target, plan.restore.manifestDigest)) throw new DomainError('version_conflict');
    return configuration;
  }
  const update = parseInput(releaseKomodoUpdateSchema, raw);
  if (update.deploymentId !== target.deploymentId || update.actorId !== target.komodo.actorId) throw new DomainError('version_conflict');
  return update;
}
