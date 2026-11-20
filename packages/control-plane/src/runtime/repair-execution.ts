import { randomUUID } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import {
  qualifiedInspectionStatusSchema, qualifiedRepairRequestSchema, qualifiedRepairResponseSchema, repairPatchSchema, sha256Schema,
  type QualifiedInspectionReceipt, type QualifiedInspectionStatus, type QualifiedRepairRequest, type QualifiedRepairResponse, type RepairPatch,
} from '@itervane/contracts';
import { canonicalRepairCommand, sha256, sourcePath, verifyQualifiedRepairReceipt, type QualifiedInspectionClient } from '@itervane/runner';
import { formalRepairAttempts, formalRepairOperations, repositories } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { DomainError, parseInput } from '../service/errors.js';
import { prepareFormalRepairInput } from '../service/formal-repair.js';
import { currentInspectionAttempt, readInspectionEvidence } from '../service/inspection-evidence.js';
import { readInspectionPlan } from '../service/inspections.js';
import { ExecutionLost, type ExecutionScope, type TaskRow } from './authority.js';
import type { ExecutionCoordinator } from './coordinator.js';

export type RepairRunner = Pick<QualifiedInspectionClient, 'observe' | 'repair'>;
type Command = ReturnType<typeof canonicalRepairCommand>;
type Attempt = typeof formalRepairAttempts.$inferSelect;
type Outcome = Extract<QualifiedRepairResponse, { kind: 'rejected' }>;
type RepairProposal = { callKeySha256: string; findingIds: readonly string[]; patch: RepairPatch };
type Dispatch = { request: QualifiedRepairRequest; command: Command; attempt: Attempt; scan: QualifiedInspectionReceipt };

const unavailable = (requestId: string | null = null): Outcome =>
  ({ kind: 'rejected', requestId, domainId: null, code: 'not_ready', cleanup: 'not_started' });
const unknown = (requestId: string): Outcome =>
  ({ kind: 'rejected', requestId, domainId: null, code: 'cleanup_unproven', cleanup: 'unknown' });

async function existingOperation(tx: Transaction, runId: string, callKeySha256: string) {
  const [operation] = await tx.select().from(formalRepairOperations)
    .where(and(eq(formalRepairOperations.runId, runId), eq(formalRepairOperations.callKeySha256, callKeySha256)));
  return operation;
}

async function activeAttempt(tx: Transaction, operationId: string) {
  const [attempt] = await tx.select().from(formalRepairAttempts)
    .where(and(eq(formalRepairAttempts.operationId, operationId), ne(formalRepairAttempts.state, 'closed')));
  return attempt;
}

async function requireReservation(tx: Transaction, request: QualifiedRepairRequest) {
  const active = await activeAttempt(tx, request.operationId);
  const [repo] = await tx.select({ origin: repositories.url }).from(repositories)
    .where(and(eq(repositories.id, request.repositoryId), eq(repositories.projectId, request.projectId))).for('share');
  if (active?.state !== 'reserved' || active.requestId !== request.requestId || repo?.origin !== request.origin) throw new ExecutionLost();
}

async function repairBasis(tx: Transaction, task: TaskRow, scope: ExecutionScope) {
  const input = await prepareFormalRepairInput(tx, task, scope);
  const plan = await readInspectionPlan(tx, task, scope.runId);
  const inspection = await currentInspectionAttempt(tx, scope.runId);
  const [repo] = await tx.select({ origin: repositories.url }).from(repositories)
    .where(and(eq(repositories.id, task.repositoryId), eq(repositories.projectId, task.projectId))).for('share');
  if (!plan || !inspection || !repo) throw new DomainError('unavailable');
  const scan = readInspectionEvidence(inspection, plan);
  const reference = input.document.inspection;
  if (scan.sha256 !== reference.receiptSha256 || inspection.requestId !== reference.requestId || plan.sha256 !== reference.planSha256
      || scan.receipt.snapshot.manifestSha256 !== reference.snapshotSha256 || scan.receipt.originSha256 !== sha256(repo.origin)) {
    throw new Error('repair_inspection_binding');
  }
  return { input, scan: scan.receipt, origin: repo.origin };
}

function editablePaths(scan: QualifiedInspectionReceipt, findingIds: readonly string[]) {
  const findings = new Map(scan.snapshot.reports.flatMap(report =>
    report.findings.map(finding => [finding.id, { path: finding.path, scanner: report.scanner }] as const)));
  const paths = new Set<string>();
  for (const id of findingIds) {
    const entry = findings.get(id);
    if (!entry) throw new Error('repair_finding_binding');
    paths.add(entry.path);
    if (entry.scanner === 'trivy' && /(?:^|\/)package-lock\.json$/.test(entry.path)) {
      paths.add(entry.path.replace(/package-lock\.json$/, 'package.json'));
    }
  }
  return paths;
}

function dispatchFor(basis: Awaited<ReturnType<typeof repairBasis>>, attempt: Attempt, command: Command): Dispatch {
  const { input, scan, origin } = basis;
  const { taskId, projectId, runId, generation, source } = input.document;
  const request = qualifiedRepairRequestSchema.parse({
    version: 1, taskId, projectId, runId, generation, ...source, origin, operation: 'apply_repair',
    requestId: attempt.requestId, operationId: attempt.operationId, fence: attempt.fence, workspaceSha256: attempt.workspaceSha256,
    repairInputSha256: input.sha256, baseSnapshotSha256: input.document.inspection.snapshotSha256,
    commandSha256: sha256(command.bytes), commandBytes: command.bytes.length,
  });
  return { request, attempt, command, scan };
}

function checkedOutcome(raw: unknown, dispatch: Dispatch) {
  const { request, attempt, command, scan } = dispatch;
  const result = qualifiedRepairResponseSchema.parse(raw);
  if (result.kind === 'rejected') {
    if (result.requestId !== request.requestId || (result.cleanup === 'confirmed' && !result.domainId)
        || (result.cleanup === 'not_started' && result.domainId)) throw new Error('repair_rejection_binding');
    return result;
  }
  verifyQualifiedRepairReceipt(result, request, command, attempt.imageSha256);
  if (result.commitSha256 !== scan.commitSha256 || result.snapshot.tree !== scan.snapshot.tree
      || result.snapshot.files !== scan.snapshot.files) throw new Error('repair_origin_evidence');
  return result;
}

async function settle(tx: Transaction, scope: ExecutionScope, attempt: Attempt, state: 'closed' | 'uncertain' | 'recorded',
  receipt?: Extract<QualifiedRepairResponse, { kind: 'repair_receipt' }>) {
  const [updated] = await tx.update(formalRepairAttempts).set({
    state, settledFence: scope.fence, settledWorkerId: scope.workerId, settledAt: sql`clock_timestamp()`,
    receipt, receiptSha256: receipt && sha256(JSON.stringify(receipt)),
  }).where(and(eq(formalRepairAttempts.requestId, attempt.requestId), eq(formalRepairAttempts.state, attempt.state)))
    .returning({ id: formalRepairAttempts.requestId });
  if (!updated) throw new ExecutionLost();
}

export class FormalRepairExecution {
  private readonly protectedPaths: readonly string[];
  private readonly runner: RepairRunner | undefined;

  constructor(private readonly coordinator: ExecutionCoordinator, options: { runner?: RepairRunner; protectedPaths: readonly string[] }) {
    this.protectedPaths = options.protectedPaths.map(sourcePath);
    this.runner = options.runner;
  }

  async apply(scope: ExecutionScope, raw: RepairProposal, signal?: AbortSignal): Promise<QualifiedRepairResponse> {
    signal?.throwIfAborted();
    const callKeySha256 = parseInput(sha256Schema, raw.callKeySha256);
    const patch = parseInput(repairPatchSchema, raw.patch);
    if (!raw.findingIds.length || raw.findingIds.length > 32) throw new DomainError('invalid_input');
    const findingIds = raw.findingIds.map(id => parseInput(sha256Schema, id)).sort();
    if (new Set(findingIds).size !== findingIds.length) throw new DomainError('invalid_input');

    const initial = await this.coordinator.withLease(scope, async (tx, { task }) => {
      await prepareFormalRepairInput(tx, task, scope);
      const operation = await existingOperation(tx, scope.runId, callKeySha256);
      return operation && activeAttempt(tx, operation.operationId);
    });
    let status: QualifiedInspectionStatus | undefined;
    if (this.runner && initial?.state !== 'recorded' && initial?.fence !== scope.fence) {
      status = qualifiedInspectionStatusSchema.safeParse(await this.runner.observe(signal).catch(() => null)).data;
    }
    const proposal = { callKeySha256, findingIds, patch };
    const reservation = await this.coordinator.withLease(scope, (tx, { task }) => {
      signal?.throwIfAborted();
      return this.reserve(tx, scope, task, proposal, status);
    });
    if ('outcome' in reservation) return reservation.outcome;
    return this.run(scope, reservation, signal);
  }

  private async reserve(tx: Transaction, scope: ExecutionScope, task: TaskRow,
    proposal: RepairProposal & { findingIds: string[] }, status: QualifiedInspectionStatus | undefined): Promise<Dispatch | { outcome: QualifiedRepairResponse }> {
    const basis = await repairBasis(tx, task, scope);
    const { input, scan } = basis;
    const { callKeySha256, findingIds, patch } = proposal;
    if (patch.baseSnapshotSha256 !== input.document.inspection.snapshotSha256) throw new DomainError('conflict');
    if (findingIds.some(id => !input.document.findingIds.includes(id))) throw new DomainError('forbidden');
    const allowed = editablePaths(scan, findingIds);
    const paths = patch.files.map(file => file.path);
    if (paths.some(path => {
      const folded = path.toLowerCase();
      return !allowed.has(path) || this.protectedPaths.some(protectedPath => {
        const prefix = protectedPath.toLowerCase();
        return folded === prefix || folded.startsWith(prefix + '/');
      });
    })) throw new DomainError('forbidden');
    const existing = await existingOperation(tx, scope.runId, callKeySha256);
    const operationId = existing?.operationId ?? randomUUID();
    const command = canonicalRepairCommand({
      version: 1, operationId, repairInputSha256: input.sha256, source: input.document.source,
      baseSnapshotSha256: input.document.inspection.snapshotSha256, editablePaths: paths, protectedPaths: this.protectedPaths,
    }, patch);
    const serialized = command.bytes.toString('utf8');
    if (existing && (existing.inputSha256 !== input.sha256 || existing.command !== serialized
        || existing.commandSha256 !== sha256(command.bytes) || JSON.stringify(existing.findingIds) !== JSON.stringify(findingIds))) {
      throw new DomainError('idempotency_conflict');
    }
    const pending = existing && await activeAttempt(tx, operationId);
    if (pending?.state === 'recorded') {
      const outcome = checkedOutcome(pending.receipt, dispatchFor(basis, pending, command));
      if (outcome.kind !== 'repair_receipt' || sha256(JSON.stringify(outcome)) !== pending.receiptSha256) throw new Error('repair_receipt_integrity');
      return { outcome };
    }
    if (pending) {
      const idle = status?.state === 'idle' && status.workspaceSha256 === pending.workspaceSha256
        && status.imageSha256 === pending.imageSha256 && scan.originSha256 === pending.originSha256;
      if (pending.fence >= scope.fence || !idle) {
        if (pending.fence < scope.fence && pending.state === 'reserved') await settle(tx, scope, pending, 'uncertain');
        return { outcome: unknown(pending.requestId) };
      }
      await settle(tx, scope, pending, 'closed');
    }
    if (!this.runner || status?.state !== 'idle') return { outcome: unavailable() };
    const [alreadyTried] = await tx.select({ id: formalRepairAttempts.requestId }).from(formalRepairAttempts)
      .where(and(eq(formalRepairAttempts.operationId, operationId), eq(formalRepairAttempts.fence, scope.fence)));
    if (alreadyTried) return { outcome: unavailable(alreadyTried.id) };

    if (!existing) await tx.insert(formalRepairOperations).values({
      operationId, runId: scope.runId, callKeySha256, findingIds, command: serialized, commandSha256: sha256(command.bytes),
      inputSha256: input.sha256, preparedFence: scope.fence, workerId: scope.workerId,
    });
    const [attempt] = await tx.insert(formalRepairAttempts).values({
      requestId: randomUUID(), operationId, fence: scope.fence, workerId: scope.workerId,
      workspaceSha256: status.workspaceSha256, imageSha256: status.imageSha256, originSha256: scan.originSha256,
    }).returning();
    if (!attempt) throw new ExecutionLost();
    return dispatchFor(basis, attempt, command);
  }

  private async run(scope: ExecutionScope, dispatch: Dispatch, signal?: AbortSignal): Promise<QualifiedRepairResponse> {
    const { attempt, request, command } = dispatch;
    let authoritySeen = false;
    let denied: { error: unknown } | undefined;
    const authorize = async () => {
      try {
        signal?.throwIfAborted();
        await this.coordinator.withLease(scope, tx => requireReservation(tx, request));
        authoritySeen = true;
      } catch (error) {
        denied = { error };
        throw error;
      }
    };

    let outcome: QualifiedRepairResponse;
    try {
      const result = await this.runner!.repair(request, command.workspace, command.patch, authorize, signal);
      outcome = checkedOutcome(result, dispatch);
      if (outcome.kind === 'repair_receipt' && !authoritySeen) throw new Error('repair_without_authority');
    } catch {
      outcome = unknown(request.requestId);
    }
    const cleaned = outcome.kind === 'repair_receipt' || outcome.cleanup !== 'unknown';
    try {
      if (denied) throw denied.error;
      return await this.coordinator.withLease(scope, async tx => {
        signal?.throwIfAborted();
        await requireReservation(tx, request);
        const receipt = outcome.kind === 'repair_receipt' ? outcome : undefined;
        await settle(tx, scope, attempt, receipt ? 'recorded' : cleaned ? 'closed' : 'uncertain', receipt);
        return outcome;
      });
    } catch (error) {
      // Revocation and cancellation may retain cleanup evidence under the lease.
      await this.coordinator.withLease(scope, async tx => {
        const active = await activeAttempt(tx, attempt.operationId);
        if (active?.state === 'reserved' && active.requestId === request.requestId) {
          await settle(tx, scope, active, cleaned ? 'closed' : 'uncertain');
        }
      }, { authorize: false, allowCancel: true }).catch(() => undefined);
      throw error;
    }
  }
}
