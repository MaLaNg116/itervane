import { operationsRestartInstallationSchema, type OperationsRestartWriterProof } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, eq } from 'drizzle-orm';
import { createApi } from '../api.js';
import type { runtimeConfig } from '../config.js';
import { readInstallationFile } from '../installation-files.js';
import type { Database } from '../persistence/database.js';
import { environments, formalReleaseTargets, operationsTargets } from '../persistence/schema.js';
import { lockEnvironmentForEffect } from '../service/environment-effects.js';
import { requireOperationsRestartWriter } from '../service/operations-restart-installations.js';
import { readOperationsEnrollment } from '../service/operations-targets.js';
import { readReleaseTarget } from '../service/release-targets.js';

export async function createInstalledApi(database: Database, config: ReturnType<typeof runtimeConfig>,
  options: { logger?: boolean; portalRoot?: string } = {}) {
  const { restartApiInstallationFile, restoreApi, operationsApi, portalClientId } = config;
  // Fastify is thenable. Return it inside an object so callers can attach lifecycle hooks before readiness.
  if (!restartApiInstallationFile && !restoreApi) return { app: createApi(database, config, options) };
  const operation = restoreApi ? 'restore' : 'restart';
  if (!operationsApi?.diagnosisProviderSha256 || !portalClientId || portalClientId === 'signed-access-token') {
    throw new Error(`operations_${operation}_api_requires_formal_diagnosis_and_portal`);
  }
  if (restoreApi && (restoreApi.environmentId !== operationsApi.environmentId || restoreApi.enrollmentSha256 !== operationsApi.enrollmentSha256)) {
    throw new Error('operations_restore_api_enrollment_mismatch');
  }
  let writer: OperationsRestartWriterProof | undefined;
  if (restartApiInstallationFile) {
    const document = operationsRestartInstallationSchema.parse(JSON.parse((await readInstallationFile(restartApiInstallationFile)).toString('utf8')));
    if (document.environmentId !== operationsApi.environmentId || document.enrollmentSha256 !== operationsApi.enrollmentSha256) {
      throw new Error('operations_restart_api_enrollment_mismatch');
    }
    writer = { installationId: document.installationId, installationSha256: sha256(JSON.stringify(document)), credentialSha256: document.credentialSha256 };
  }

  await database.db.transaction(async tx => {
    await lockEnvironmentForEffect(tx, operationsApi.environmentId);
    const [bound] = await tx.select({ enrollment: operationsTargets, release: formalReleaseTargets }).from(operationsTargets)
      .innerJoin(environments, and(eq(environments.id, operationsTargets.environmentId), eq(environments.access, 'protected'),
        eq(environments.projectId, operationsTargets.projectId), eq(environments.applicationId, operationsTargets.applicationId)))
      .innerJoin(formalReleaseTargets, and(eq(formalReleaseTargets.environmentId, environments.id),
        eq(formalReleaseTargets.projectId, environments.projectId), eq(formalReleaseTargets.applicationId, environments.applicationId)))
      .where(and(eq(operationsTargets.environmentId, operationsApi.environmentId), eq(operationsTargets.sha256, operationsApi.enrollmentSha256)))
      .for('share');
    if (!bound) throw new Error(`operations_${operation}_api_enrollment_required`);
    const current = readOperationsEnrollment(bound.enrollment);
    if (bound.release.revision !== current.releaseTargetRevision || bound.release.sha256 !== current.releaseTargetSha256) {
      throw new Error(`operations_${operation}_api_release_mapping_changed`);
    }
    if (restoreApi) {
      const release = readReleaseTarget(bound.release);
      if (bound.release.sha256 !== restoreApi.mappingSha256 || !release.komodo || !release.registryOrigin || !release.rolloutCheck) {
        throw new Error('operations_restore_api_release_mapping_changed');
      }
    }
    if (writer) await requireOperationsRestartWriter(tx, operationsApi, current.whiskers, writer);
  });
  return { app: createApi(database, config, { ...options,
    ...(writer ? { operationsRestartWriter: writer } : {}), ...(restoreApi ? { operationsRestoreTarget: restoreApi } : {}),
  }) };
}
