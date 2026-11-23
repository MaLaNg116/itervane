import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  qualifiedInspectionStatusSchema, qualifiedRepairObservationRequestSchema, qualifiedRepairObservationResponseSchema,
  repairPatchLimits, repairTargetsSchema, sha256Schema, type QualifiedRepairObservationResponse,
} from '@itervane/contracts';
import { canonicalRepairObservation, sha256, verifyQualifiedRepairObservation, type QualifiedInspectionClient } from '@itervane/runner';
import { formalRepairInputs, repositories } from '../persistence/schema.js';
import { DomainError, parseInput } from '../service/errors.js';
import { requireCurrentLinkedHealthRepair } from '../service/operations-repair-proposals.js';
import { ExecutionLost, type ExecutionScope } from './authority.js';
import type { ExecutionCoordinator } from './coordinator.js';
import { repairBasis, repairTargets, type RepairPolicy } from './repair-execution.js';

const findingsSchema = z.array(sha256Schema).min(1).max(repairPatchLimits.files)
  .refine(ids => new Set(ids).size === ids.length);
export type RepairObservationRunner = Pick<QualifiedInspectionClient, 'observe' | 'observeRepair'>;

/** Read the exact targets of the published audit while the current repair execution lease holds. */
export async function observeFormalRepairTargets(coordinator: ExecutionCoordinator, scope: ExecutionScope,
  rawFindingIds: readonly string[], options: RepairPolicy & { runner: RepairObservationRunner },
  signal?: AbortSignal): Promise<QualifiedRepairObservationResponse> {
  signal?.throwIfAborted();
  const findingIds = parseInput(findingsSchema, rawFindingIds);
  const { input, scan, origin } = await coordinator.withLease(scope, (tx, { task }) => repairBasis(tx, task, scope));
  if (findingIds.some(id => !input.document.findingIds.includes(id))) throw new DomainError('forbidden');
  const { healthReproduction } = input.document;
  const { targets: found, npmRepairs } = repairTargets(scan, findingIds, options.npmApprovals, healthReproduction);
  const targets = parseInput(repairTargetsSchema, found);
  const { taskId, runId, projectId, generation, source } = input.document;
  const baseSnapshotSha256 = input.document.inspection.snapshotSha256;
  const workspace = { version: 1 as const, operationId: randomUUID(), repairInputSha256: input.sha256,
    source, baseSnapshotSha256, protectedPaths: options.protectedPaths.slice(), ...(npmRepairs.length ? { npmRepairs } : {}),
    ...(healthReproduction ? { healthReproductionSha256: healthReproduction.receiptSha256 } : {}) };
  const command = canonicalRepairObservation({ workspace, targets });
  const status = qualifiedInspectionStatusSchema.safeParse(await options.runner.observe(signal).catch(() => null)).data;
  signal?.throwIfAborted();
  if (status?.state !== 'idle') return { kind: 'rejected', requestId: null, domainId: null, cleanup: 'not_started', code: 'not_ready' };

  const request = qualifiedRepairObservationRequestSchema.parse({
    version: 1, operation: 'observe_repair', operationId: workspace.operationId, repairInputSha256: input.sha256, baseSnapshotSha256,
    commandSha256: sha256(command.bytes), commandBytes: command.bytes.length, workspaceSha256: status.workspaceSha256,
    taskId, runId, projectId, generation, ...source, origin, fence: scope.fence, requestId: randomUUID(),
  });
  let authorized = false;
  let denied: { error: unknown } | undefined;
  const requireCurrent = async () => {
    signal?.throwIfAborted();
    await coordinator.withLease(scope, async (tx, { task }) => {
      if (input.retry && 'kind' in input.retry) await requireCurrentLinkedHealthRepair(tx, task, input.retry);
      const [stored] = await tx.select({ sha256: formalRepairInputs.sha256 }).from(formalRepairInputs)
        .where(eq(formalRepairInputs.runId, runId));
      const [repo] = await tx.select({ url: repositories.url }).from(repositories)
        .where(and(eq(repositories.id, source.repositoryId), eq(repositories.projectId, projectId))).for('share');
      if (stored?.sha256 !== input.sha256 || repo?.url !== origin) throw new ExecutionLost();
    });
  };
  const authorize = async () => {
    try {
      await requireCurrent();
      authorized = true;
    } catch (error) {
      denied = { error };
      throw error;
    }
  };

  let outcome: QualifiedRepairObservationResponse;
  try {
    outcome = qualifiedRepairObservationResponseSchema.parse(await options.runner.observeRepair(request, command.workspace, command.targets, authorize, signal));
    if (outcome.kind === 'repair_observation') {
      verifyQualifiedRepairObservation(outcome, request, command, status.imageSha256);
      if (!authorized || outcome.commitSha256 !== scan.commitSha256 || outcome.snapshot.tree !== scan.snapshot.tree
          || outcome.snapshot.files !== scan.snapshot.files) throw new Error('repair_observation_binding');
    } else if (outcome.requestId !== request.requestId || (outcome.cleanup === 'confirmed' && !outcome.domainId)
      || (outcome.cleanup === 'not_started' && outcome.domainId)) throw new Error('repair_observation_rejection');
  } catch {
    outcome = { kind: 'rejected', requestId: request.requestId, domainId: null, cleanup: authorized ? 'unknown' : 'not_started',
      code: authorized ? 'cleanup_unproven' : 'not_ready' };
  }
  if (denied) throw denied.error;
  await requireCurrent();
  return outcome;
}
