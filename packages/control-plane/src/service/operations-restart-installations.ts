import {
  idSchema, operationsRestartInstallationSchema, type OperationsRestartInstallation, type OperationsRestartWriterProof,
} from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { OperationsEnrollmentScope } from '../config.js';
import type { Database } from '../persistence/database.js';
import { environments, formalReleaseTargets, operationsRestartInstallations, operationsTargets } from '../persistence/schema.js';
import { reconcileUnavailableRestart } from '../runtime/operations-restart-request.js';
import type { Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { lockEnvironmentForEffect } from './environment-effects.js';
import { readOperationsEnrollment } from './operations-targets.js';

const installationChange = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('register'), expectedActiveId: idSchema.nullable(), installation: operationsRestartInstallationSchema }),
  z.strictObject({ action: z.literal('retire'), environmentId: idSchema, installationId: idSchema }),
]);

type InstallationRow = typeof operationsRestartInstallations.$inferSelect;
type WriterReference = Pick<OperationsRestartWriterProof, 'installationId' | 'credentialSha256'>
  & Partial<Pick<OperationsRestartWriterProof, 'installationSha256'>>;

function readInstallation(row: InstallationRow) {
  const document = operationsRestartInstallationSchema.parse(row.document);
  if (document.installationId !== row.id || document.environmentId !== row.environmentId
      || document.enrollmentSha256 !== row.enrollmentSha256 || document.credentialSha256 !== row.credentialSha256
      || sha256(JSON.stringify(document)) !== row.installationSha256) throw new Error('operations_restart_writer_integrity');
  return document;
}

function installationReceipt(row: InstallationRow) {
  readInstallation(row);
  return { installationId: row.id, environmentId: row.environmentId, installationSha256: row.installationSha256,
    retiredAt: row.retiredAt };
}

async function retireWriter(tx: Transaction, database: Database, row: InstallationRow) {
  const [retired] = await tx.update(operationsRestartInstallations).set({ retiredAt: sql`clock_timestamp()` })
    .where(and(eq(operationsRestartInstallations.id, row.id), isNull(operationsRestartInstallations.retiredAt))).returning();
  if (!retired) throw new DomainError('version_conflict');
  await reconcileUnavailableRestart(tx, database, { writerInstallationId: retired.id });
  return retired;
}

export async function changeOperationsRestartInstallation(database: Database, raw: unknown) {
  const input = parseInput(installationChange, raw);
  const environmentId = input.action === 'register' ? input.installation.environmentId : input.environmentId;
  return database.db.transaction(async tx => {
    await lockEnvironmentForEffect(tx, environmentId);
    if (input.action === 'retire') {
      const [found] = await tx.select().from(operationsRestartInstallations)
        .where(and(eq(operationsRestartInstallations.id, input.installationId), eq(operationsRestartInstallations.environmentId, environmentId)));
      if (!found) throw new DomainError('not_found');
      return installationReceipt(found.retiredAt ? found : await retireWriter(tx, database, found));
    }

    const document = input.installation;
    const [bound] = await tx.select({ target: operationsTargets, release: formalReleaseTargets })
      .from(operationsTargets).innerJoin(environments, and(eq(environments.id, operationsTargets.environmentId), eq(environments.access, 'protected')))
      .innerJoin(formalReleaseTargets, eq(formalReleaseTargets.environmentId, operationsTargets.environmentId))
      .where(eq(operationsTargets.environmentId, environmentId)).for('share');
    if (!bound) throw new DomainError('unsupported_state');
    const enrollment = readOperationsEnrollment(bound.target);
    if (bound.target.sha256 !== document.enrollmentSha256 || bound.release.revision !== enrollment.releaseTargetRevision
        || bound.release.sha256 !== enrollment.releaseTargetSha256 || enrollment.whiskers.origin !== document.whiskers.origin
        || enrollment.whiskers.serverId !== document.whiskers.serverId) throw new DomainError('version_conflict');

    const installationSha256 = sha256(JSON.stringify(document));
    const [current] = await tx.select().from(operationsRestartInstallations)
      .where(and(eq(operationsRestartInstallations.environmentId, environmentId), isNull(operationsRestartInstallations.retiredAt)));
    if (current?.id === document.installationId && current.installationSha256 === installationSha256) return installationReceipt(current);
    if ((current?.id ?? null) !== input.expectedActiveId) throw new DomainError('version_conflict');
    if (current) await retireWriter(tx, database, current);
    const [registered] = await tx.insert(operationsRestartInstallations).values({
      id: document.installationId, environmentId, enrollmentSha256: document.enrollmentSha256,
      credentialSha256: document.credentialSha256, installationSha256, document,
    }).onConflictDoNothing().returning();
    if (!registered) throw new DomainError('version_conflict');
    return installationReceipt(registered);
  });
}

export async function requireOperationsRestartWriter(tx: Transaction, scope: OperationsEnrollmentScope,
  whiskers: OperationsRestartInstallation['whiskers'], reference: WriterReference) {
  const [row] = await tx.select().from(operationsRestartInstallations).where(and(
    eq(operationsRestartInstallations.id, reference.installationId),
    eq(operationsRestartInstallations.environmentId, scope.environmentId),
    eq(operationsRestartInstallations.enrollmentSha256, scope.enrollmentSha256),
    isNull(operationsRestartInstallations.retiredAt),
  )).for('share');
  if (!row || row.credentialSha256 !== reference.credentialSha256
      || (reference.installationSha256 !== undefined && row.installationSha256 !== reference.installationSha256)) {
    throw new DomainError('version_conflict');
  }
  const document = readInstallation(row);
  if (document.whiskers.origin !== whiskers.origin || document.whiskers.serverId !== whiskers.serverId) {
    throw new DomainError('version_conflict');
  }
  return row;
}
