import { randomUUID } from 'node:crypto';
import { formalRepairContinuationSchema, formalRepairRetrySchema, formalVerificationInputSchema, linkedHealthRepairSchema, repairCommandSchema,
  standardVerificationProfileSchema, type FormalRepairContinuation, type FormalRepairRetry, type FormalVerificationInput,
  type FormalVerificationResult } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../persistence/database.js';
import { formalRepairOperations, formalRepairRetries, formalVerificationInputs, runRuntime, taskRuns, tasks } from '../persistence/schema.js';
import { appendEvent, enqueue, ExecutionLost, type ExecutionScope, type TaskRow } from '../runtime/authority.js';
import { requireProjectAccess, requireStoredActor, type Transaction } from './access.js';

export function verificationProfileFingerprint(profile: unknown) {
  return sha256(JSON.stringify(standardVerificationProfileSchema.parse(profile)));
}

function observedFailure(result: FormalVerificationResult): FormalRepairRetry['previous']['failure'] | undefined {
  const { source, build, baseline } = result.evidence;
  if (source.status !== 'compared') return;
  if (result.review?.outcome === 'source_findings') {
    const { status: _status, ...counts } = source;
    return { outcome: 'source_findings', ...counts };
  }
  if (result.review?.outcome !== 'checks_failed') return;
  const buildCode = build.status === 'failed' ? build.code : null;
  const checks = baseline.status === 'failed' ? baseline.failures : [];
  const actionable = buildCode === 'bundle_failed' || buildCode === 'output_invalid'
    || checks.some(check => check.code === 'unexpected_status' || check.code === 'unexpected_content' || check.code === 'missing_page_asset');
  return actionable ? { outcome: 'checks_failed', buildCode, checks } : undefined;
}

export async function prepareRepairRetry(tx: Transaction, task: TaskRow, scope: ExecutionScope, result: FormalVerificationResult,
  resultSha256: string, repairPolicySha256: string) {
  if (task.generation !== 1) return;
  const failure = observedFailure(result);
  if (!failure) return;
  const [stored] = await tx.select().from(formalVerificationInputs).where(eq(formalVerificationInputs.runId, scope.runId));
  const input = formalVerificationInputSchema.parse(stored?.document);
  if (!stored || stored.sha256 !== result.inputSha256 || sha256(JSON.stringify(input)) !== stored.sha256
      || input.taskId !== task.id || input.projectId !== task.projectId || input.runId !== scope.runId
      || input.generation !== task.generation || input.subject.manifestSha256 !== result.evidence.binding.subjectManifestSha256) {
    throw new Error('formal_repair_retry_input_binding');
  }
  if (input.subject.kind !== 'repair') return;
  const [operation] = await tx.select().from(formalRepairOperations)
    .where(and(eq(formalRepairOperations.runId, scope.runId), eq(formalRepairOperations.operationId, input.subject.operationId)));
  if (!operation || operation.inputSha256 !== input.subject.inputSha256 || operation.commandSha256 !== input.subject.commandSha256
      || sha256(operation.command) !== operation.commandSha256) throw new Error('formal_repair_retry_patch_binding');
  const { patch } = repairCommandSchema.parse(JSON.parse(operation.command));
  if (patch.baseSnapshotSha256 !== input.inspection.snapshotSha256 || sha256(JSON.stringify(patch)) !== input.subject.patchSha256) {
    throw new Error('formal_repair_retry_patch_binding');
  }
  const edits = patch.files.flatMap(file => file.edits);
  const patchShape = { files: patch.files.length, removedBytes: edits.reduce((total, edit) => total + edit.endByte - edit.startByte, 0),
    replacementBytes: edits.reduce((total, edit) => total + Buffer.byteLength(edit.replacement), 0) };

  const document = formalRepairRetrySchema.parse({
    version: 1, taskId: task.id, projectId: task.projectId, runId: randomUUID(), generation: scope.generation + 1,
    source: input.source, baseSnapshotSha256: input.inspection.snapshotSha256, catalogSha256: input.catalogSha256,
    verificationProfileSha256: verificationProfileFingerprint(input.profile), repairPolicySha256,
    previous: { previousRunId: scope.runId, verificationResultSha256: resultSha256, receiptSha256: result.receiptSha256,
      candidateManifestSha256: input.subject.manifestSha256, patchSha256: input.subject.patchSha256,
      operationId: input.subject.operationId, patchShape, failure },
  });
  const { grantId } = await requireProjectAccess(tx, await requireStoredActor(tx, task.requestedBy), task.projectId, true);
  return { document, grantId, sha256: sha256(JSON.stringify(document)) };
}

type PreparedRetry = { document: FormalRepairContinuation; grantId: string; sha256: string };

export function prepareLinkedHealthRepair(task: TaskRow, scope: ExecutionScope, input: FormalVerificationInput,
  result: FormalVerificationResult, resultSha256: string, authorization: {
    grantId: string; verificationProfileSha256: string; repairPolicySha256: string;
  }): PreparedRetry | undefined {
  const { source, build, baseline } = result.evidence;
  if (scope.generation !== 1 || task.generation !== 1 || input.subject.kind !== 'original' || !input.healthRegression
      || result.review?.outcome !== 'checks_failed' || source.status !== 'compared' || source.introduced || source.remaining || source.resolved
      || build.status !== 'built' || baseline.status !== 'passed' || baseline.healthFollowup?.status !== 'unhealthy') return;
  const { grantId, verificationProfileSha256, repairPolicySha256 } = authorization;
  const document = linkedHealthRepairSchema.parse({
    version: 1, kind: 'linked_health', taskId: task.id, projectId: task.projectId, runId: randomUUID(), generation: 2,
    source: input.source, baseSnapshotSha256: input.inspection.snapshotSha256, catalogSha256: input.catalogSha256,
    verificationProfileSha256, repairPolicySha256,
    previous: { previousRunId: scope.runId, verificationResultSha256: resultSha256, receiptSha256: result.receiptSha256,
      subjectManifestSha256: input.subject.manifestSha256, regression: input.healthRegression },
  });
  return { document, grantId, sha256: sha256(JSON.stringify(document)) };
}

export async function enqueueRepairRetry(tx: Transaction, database: Database, task: TaskRow, scope: ExecutionScope, retry: PreparedRetry) {
  const { document, grantId, sha256 } = retry;
  const { runId, generation, previous } = document;
  await tx.insert(taskRuns).values({ id: runId, taskId: task.id, generation, role: 'audit' });
  await tx.insert(runRuntime).values({ runId, taskId: task.id });
  await tx.insert(formalRepairRetries).values({
    runId, taskId: task.id, previousRunId: previous.previousRunId, grantId, workerId: scope.workerId, preparedFence: scope.fence, sha256, document,
  });

  await tx.update(taskRuns).set({ state: 'failed' }).where(eq(taskRuns.id, scope.runId));
  const [current] = await tx.update(tasks).set({ generation })
    .where(and(eq(tasks.id, task.id), eq(tasks.version, task.version), eq(tasks.generation, scope.generation))).returning();
  if (!current) throw new ExecutionLost();
  const next = await appendEvent(tx, current, 'task.repair_retry_queued', 'queued', {
    workerId: scope.workerId, retry: { runId, previousRunId: scope.runId, retrySha256: sha256 },
  });
  await enqueue(tx, database, next, runId);
}

export async function readRepairRetry(tx: Transaction, task: TaskRow, scope: Pick<ExecutionScope, 'runId' | 'generation'>) {
  if (task.generation === 1) return;
  const [stored] = await tx.select().from(formalRepairRetries).where(eq(formalRepairRetries.runId, scope.runId));
  if (!stored) return;
  const retry = formalRepairContinuationSchema.parse(stored.document);
  if (retry.taskId !== task.id || retry.projectId !== task.projectId || retry.runId !== scope.runId
      || retry.generation !== scope.generation || retry.generation !== task.generation
      || retry.source.repositoryId !== task.repositoryId || retry.source.commit !== task.commit
      || retry.previous.previousRunId !== stored.previousRunId || sha256(JSON.stringify(retry)) !== stored.sha256) {
    throw new Error('formal_repair_retry_integrity');
  }
  return retry;
}
