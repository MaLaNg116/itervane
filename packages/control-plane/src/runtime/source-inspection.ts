import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  qualifiedInspectionRequestSchema, qualifiedInspectionResponseSchema, qualifiedInspectionStatusSchema,
  type CodeRuleValidationProfile, type QualifiedInspectionResponse, type QualifiedInspectionStatus, type ToolResult,
} from '@itervane/contracts';
import { canonicalPublishedInspectionCommand, sha256, type PublishedInspectionCommand, type QualifiedInspectionClient } from '@itervane/runner';
import { inspectionAttempts, repositories } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { DomainError } from '../service/errors.js';
import {
  currentInspectionAttempt, inspectionCoverage, readInspectionEvidence, verifyInspectionEvidence, type InspectionAttempt,
} from '../service/inspection-evidence.js';
import { prepareInspection } from '../service/inspections.js';
import { matchesLinkedRepairSource } from '../service/operations-repair-proposals.js';
import { readTaskPublishedCodeRules } from '../service/task-published-code-rules.js';
import { readTaskRuleSnapshot } from '../service/task-rule-snapshots.js';
import { ExecutionLost, type ExecutionScope, type TaskRow } from './authority.js';
import type { ExecutionCoordinator } from './coordinator.js';

export type InspectionRunner = Pick<QualifiedInspectionClient, 'observe' | 'inspect'>;
type Publish = (tx: Transaction, task: TaskRow, result: ToolResult, requestId?: string) => Promise<ToolResult>;
const unavailable = { status: 'business_error', code: 'runner_unavailable', retryable: false } as const;
const checkFailed = { status: 'infrastructure_error', code: 'inspection_failed', retryable: true } as const;
const unsupported = { status: 'business_error', code: 'inspection_unsupported', retryable: false } as const;
const sourceMismatch = { status: 'business_error', code: 'inspection_source_mismatch', retryable: false } as const;
const unknown = (requestId: string) => ({ status: 'unknown', operationId: requestId, requiresReconciliation: true } as const);

function observation(evidence: ReturnType<typeof verifyInspectionEvidence>): ToolResult {
  const { requestId } = evidence.receipt.scope;
  return { status: 'success', evidence: [{ id: requestId, sha256: evidence.sha256, kind: 'scan' }],
    data: { requestId, coverage: inspectionCoverage(evidence.receipt) } };
}

async function settleAttempt(tx: Transaction, scope: ExecutionScope, attempt: InspectionAttempt,
  state: 'closed' | 'uncertain' | 'recorded', evidence?: ReturnType<typeof verifyInspectionEvidence>) {
  const [updated] = await tx.update(inspectionAttempts).set({
    state, settledFence: scope.fence, settledAt: sql`clock_timestamp()`,
    receipt: evidence?.receipt, receiptSha256: evidence?.sha256,
  }).where(and(eq(inspectionAttempts.requestId, attempt.requestId), eq(inspectionAttempts.state, attempt.state)))
    .returning({ id: inspectionAttempts.requestId });
  if (!updated) throw new ExecutionLost();
}

function checkRejection(response: Extract<QualifiedInspectionResponse, { kind: 'rejected' }>) {
  if (response.cleanup === 'unknown') return unknown(response.requestId!);
  if (response.code === 'origin_denied') return unsupported;
  return response.code === 'not_ready' ? unavailable : checkFailed;
}

export class SourceInspection {
  constructor(private readonly coordinator: ExecutionCoordinator, private readonly runner?: InspectionRunner,
    private readonly ruleProfile?: CodeRuleValidationProfile) {}

  async run(scope: ExecutionScope, publish: Publish, signal?: AbortSignal): Promise<ToolResult> {
    const initial = await this.coordinator.withLease(scope, async (tx, { task }) => {
      await prepareInspection(tx, task, scope.runId, scope.fence);
      return currentInspectionAttempt(tx, scope.runId);
    });
    let status: QualifiedInspectionStatus | null = null;
    if (this.runner && initial?.state !== 'recorded' && initial?.fence !== scope.fence) {
      const probed = qualifiedInspectionStatusSchema.safeParse(await this.runner.observe(signal));
      status = probed.success ? probed.data : null;
    }

    const reserved = await this.coordinator.withLease(scope, async (tx, { task, linkedRepair }) => {
      signal?.throwIfAborted();
      const plan = await prepareInspection(tx, task, scope.runId, scope.fence);
      const pending = await currentInspectionAttempt(tx, scope.runId);
      if (pending?.state === 'recorded' && pending.workspaceSha256) {
        const snapshot = pending.publishedCode ? null : await readTaskRuleSnapshot(tx, task);
        if (snapshot?.document.entries.some(entry => entry.kind === 'code_rule')) return { result: await publish(tx, task, unavailable) };
        const evidence = await readInspectionEvidence(tx, pending, plan);
        const recorded = linkedRepair && !matchesLinkedRepairSource(linkedRepair.frozen, evidence.receipt) ? sourceMismatch : observation(evidence);
        return { result: await publish(tx, task, recorded, pending.requestId) };
      }
      if (pending?.state === 'reserved' && pending.fence === scope.fence) throw new ExecutionLost();
      if (pending) {
        const sameIdleWorkspace = status?.state === 'idle' && status.workspaceSha256 === pending.workspaceSha256;
        if (pending.fence >= scope.fence || !sameIdleWorkspace || pending.state === 'recorded') {
          if (pending.fence < scope.fence && pending.state === 'reserved') await settleAttempt(tx, scope, pending, 'uncertain');
          return { result: await publish(tx, task, unknown(pending.requestId), pending.requestId) };
        }
        await settleAttempt(tx, scope, pending, 'closed');
      }
      if (!this.runner || status?.state !== 'idle') return { result: await publish(tx, task, unavailable) };
      const [alreadyTried] = await tx.select({ id: inspectionAttempts.requestId }).from(inspectionAttempts)
        .where(and(eq(inspectionAttempts.runId, scope.runId), eq(inspectionAttempts.fence, scope.fence)));
      if (alreadyTried) return { result: await publish(tx, task, checkFailed, alreadyTried.id) };

      const [repo] = await tx.select().from(repositories)
        .where(and(eq(repositories.id, task.repositoryId), eq(repositories.projectId, task.projectId))).for('share');
      if (!repo) throw new DomainError('not_found');
      const frozen = linkedRepair?.frozen;
      const originSha256 = sha256(repo.url);
      if (frozen && originSha256 !== frozen.source.originSha256) return { result: await publish(tx, task, sourceMismatch) };
      const materializedFrom = frozen?.source.patchSha256 ? { commit: frozen.source.git.commit,
        baseSnapshotSha256: frozen.source.originalSnapshotSha256 } : undefined;
      let command: PublishedInspectionCommand | undefined;
      try {
        const rules = await readTaskPublishedCodeRules(tx, task, this.ruleProfile);
        if (rules) {
          if (rules.profile.runnerImageSha256 !== status.imageSha256) return { result: await publish(tx, task, unavailable) };
          command = canonicalPublishedInspectionCommand(rules, materializedFrom);
        }
      } catch (error) {
        if (error instanceof Error && ['published_inspection_profile_unavailable', 'published_code_rule_validation_profile'].includes(error.message)) {
          return { result: await publish(tx, task, unavailable) };
        }
        throw error;
      }
      const parsed = qualifiedInspectionRequestSchema.safeParse({ version: 1, taskId: task.id, runId: scope.runId,
        projectId: task.projectId, requestId: randomUUID(), repositoryId: repo.id, commit: task.commit,
        generation: scope.generation, fence: scope.fence, planSha256: plan.sha256, workspaceSha256: status.workspaceSha256, origin: repo.url,
        ...(materializedFrom ? { materializedFrom } : {}),
        ...(command ? { publishedCode: command.binding } : {}),
      });
      if (!parsed.success) return { result: await publish(tx, task, unsupported) };

      const { origin: _origin, version: _version, publishedCode: _publishedCode, ...coordinates } = parsed.data;
      const [attempt] = await tx.insert(inspectionAttempts).values({ ...coordinates, workerId: scope.workerId,
        imageSha256: status.imageSha256, originSha256,
        ...(command ? { publishedCode: { binding: command.binding, snapshotSha256: command.rules.input.snapshot.sha256,
          profile: command.rules.input.profile } } : {}),
      }).returning();
      if (!attempt) throw new ExecutionLost();
      return { attempt, request: parsed.data, plan: plan.document, frozen, command };
    });
    if ('result' in reserved) return reserved.result!;

    const { attempt, request, plan, frozen, command } = reserved;
    let authoritySeen = false;
    let authorityFailure: { error: unknown } | undefined;
    const authorize = async () => {
      try {
        signal?.throwIfAborted();
        await this.coordinator.withLease(scope, async tx => {
          const current = await currentInspectionAttempt(tx, scope.runId);
          const [repo] = await tx.select({ url: repositories.url }).from(repositories)
            .where(and(eq(repositories.id, request.repositoryId), eq(repositories.projectId, request.projectId))).for('share');
          if (current?.state !== 'reserved' || current.requestId !== request.requestId || repo?.url !== request.origin) throw new ExecutionLost();
        });
        authoritySeen = true;
      } catch (error) {
        authorityFailure = { error };
        throw error;
      }
    };
    let evidence: ReturnType<typeof verifyInspectionEvidence> | undefined;
    let cleanupProven = false;
    let result: ToolResult;
    try {
      const runner = this.runner!;
      const response = qualifiedInspectionResponseSchema.parse(await (command
        ? runner.inspect(request, authorize, signal, command) : runner.inspect(request, authorize, signal)));
      if (response.kind === 'receipt') {
        if (!authoritySeen) throw new Error('inspection_without_authority');
        const measured = verifyInspectionEvidence(response, attempt, plan, command);
        cleanupProven = true;
        if (frozen && !matchesLinkedRepairSource(frozen, measured.receipt)) result = sourceMismatch;
        else { evidence = measured; result = observation(evidence); }
      } else {
        if (response.requestId !== request.requestId || (response.cleanup === 'confirmed' && !response.domainId)
            || (response.cleanup === 'not_started' && response.domainId)) throw new Error('inspection_rejection_binding');
        cleanupProven = response.cleanup !== 'unknown';
        result = checkRejection(response);
      }
    } catch {
      result = unknown(request.requestId);
    }

    try {
      if (authorityFailure) throw authorityFailure.error;
      return await this.coordinator.withLease(scope, async (tx, { task }) => {
        signal?.throwIfAborted();
        await settleAttempt(tx, scope, attempt, evidence ? 'recorded' : cleanupProven ? 'closed' : 'uncertain', evidence);
        return publish(tx, task, result, request.requestId);
      });
    } catch (error) {
      // An ineligible caller can retain cleanup state, never a scanner result. A new fence must observe if this fails.
      await this.coordinator.withLease(scope, async tx => {
        const current = await currentInspectionAttempt(tx, scope.runId);
        if (current?.state === 'reserved' && current.requestId === request.requestId) {
          await settleAttempt(tx, scope, current, cleanupProven ? 'closed' : 'uncertain');
        }
      }, { authorize: false, allowCancel: true }).catch(() => undefined);
      throw error;
    }
  }
}
