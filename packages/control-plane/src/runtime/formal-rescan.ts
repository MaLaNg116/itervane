import { randomUUID } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import {
  qualifiedInspectionStatusSchema, qualifiedVerificationResponseSchema,
  type QualifiedInspectionStatus, type QualifiedVerificationReceipt, type QualifiedVerificationResponse, type VerificationProfile,
} from '@itervane/contracts';
import {
  canonicalVerificationCommand, compareVerificationScans, prepareQualifiedVerificationRequest, sha256, verifyQualifiedVerificationReceipt,
  type QualifiedInspectionClient,
} from '@itervane/runner';
import { formalRescanAttempts, repositories } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { ExecutionLost, type ExecutionScope } from './authority.js';
import type { ExecutionCoordinator } from './coordinator.js';
import { prepareFormalVerificationInput } from './verification-input.js';

export type RescanRunner = Pick<QualifiedInspectionClient, 'observe' | 'verify'>;
type Attempt = typeof formalRescanAttempts.$inferSelect;
type Basis = Awaited<ReturnType<typeof prepareFormalVerificationInput>>;
type Rejection = Extract<QualifiedVerificationResponse, { kind: 'rejected' }>;
type RescanResult = { kind: 'scanned'; receipt: QualifiedVerificationReceipt; comparison: ReturnType<typeof compareVerificationScans> };

const notReady = (): Rejection =>
  ({ kind: 'rejected', requestId: null, domainId: null, code: 'not_ready', cleanup: 'not_started' });
const uncertain = (requestId: string): Rejection =>
  ({ kind: 'rejected', requestId, domainId: null, code: 'cleanup_unproven', cleanup: 'unknown' });

function dispatch(basis: Basis, attempt: Attempt) {
  const command = canonicalVerificationCommand({ input: basis.document, repair: basis.repair });
  const request = prepareQualifiedVerificationRequest({ requestId: attempt.requestId, fence: attempt.fence,
    workspaceSha256: attempt.workspaceSha256, origin: basis.origin,
  }, command);
  if (basis.sha256 !== request.verificationInputSha256 || attempt.inputSha256 !== basis.sha256
      || attempt.imageSha256 !== request.runnerImageSha256 || attempt.originSha256 !== sha256(basis.origin)) {
    throw new Error('formal_rescan_attempt_binding');
  }
  return { basis, attempt, command, request };
}

function checked(raw: unknown, plan: ReturnType<typeof dispatch>): Rejection | RescanResult {
  const { basis, attempt, command, request } = plan;
  const receipt = qualifiedVerificationResponseSchema.parse(raw);
  if (receipt.kind === 'rejected') {
    if (receipt.requestId !== request.requestId || (receipt.cleanup === 'confirmed' && !receipt.domainId)
        || (receipt.cleanup === 'not_started' && receipt.domainId)) throw new Error('formal_rescan_rejection_binding');
    return receipt;
  }
  verifyQualifiedVerificationReceipt(receipt, request, command);
  const { snapshot } = receipt;
  const original = basis.scan.snapshot;
  if (receipt.commitSha256 !== basis.scan.commitSha256 || snapshot.tree !== original.tree
      || snapshot.files !== original.files || snapshot.totalBytes !== original.totalBytes
      || (attempt.receiptSha256 && attempt.receiptSha256 !== sha256(JSON.stringify(receipt)))) {
    throw new Error('formal_rescan_receipt_integrity');
  }
  return { kind: 'scanned', receipt, comparison: compareVerificationScans(snapshot, snapshot.target ?? snapshot) };
}

async function settle(tx: Transaction, scope: ExecutionScope, attempt: Attempt, state: 'closed' | 'uncertain' | 'recorded',
  receipt?: QualifiedVerificationReceipt) {
  const [updated] = await tx.update(formalRescanAttempts).set({
    state, settledFence: scope.fence, settledWorkerId: scope.workerId, settledAt: sql`clock_timestamp()`,
    receipt, receiptSha256: receipt && sha256(JSON.stringify(receipt)),
  }).where(and(eq(formalRescanAttempts.requestId, attempt.requestId), eq(formalRescanAttempts.state, attempt.state)))
    .returning({ id: formalRescanAttempts.requestId });
  if (!updated) throw new ExecutionLost();
}

async function reserve(tx: Transaction, scope: ExecutionScope, basis: Basis, status?: QualifiedInspectionStatus) {
  const [active] = await tx.select().from(formalRescanAttempts)
    .where(and(eq(formalRescanAttempts.runId, scope.runId), ne(formalRescanAttempts.state, 'closed')));
  if (active?.state === 'recorded') {
    const outcome = checked(active.receipt, dispatch(basis, active));
    if (outcome.kind !== 'scanned') throw new Error('formal_rescan_receipt_missing');
    return { outcome };
  }
  if (active) {
    const knownIdle = status?.state === 'idle' && status.workspaceSha256 === active.workspaceSha256
      && status.imageSha256 === active.imageSha256 && active.originSha256 === sha256(basis.origin);
    if (active.fence >= scope.fence || !knownIdle) return { outcome: uncertain(active.requestId) };
    await settle(tx, scope, active, 'closed');
  }
  if (status?.state !== 'idle' || status.imageSha256 !== basis.document.profile.runnerImageSha256) return { outcome: notReady() };
  const [previous] = await tx.select({ id: formalRescanAttempts.requestId }).from(formalRescanAttempts)
    .where(and(eq(formalRescanAttempts.runId, scope.runId), eq(formalRescanAttempts.fence, scope.fence)));
  if (previous) return { outcome: notReady() };
  const [attempt] = await tx.insert(formalRescanAttempts).values({
    requestId: randomUUID(), runId: scope.runId, inputSha256: basis.sha256, fence: scope.fence, workerId: scope.workerId,
    workspaceSha256: status.workspaceSha256, imageSha256: status.imageSha256, originSha256: sha256(basis.origin),
  }).returning();
  if (!attempt) throw new ExecutionLost();
  return { plan: dispatch(basis, attempt) };
}

async function requireReservation(tx: Transaction, { request, attempt }: ReturnType<typeof dispatch>) {
  const [active] = await tx.select({ state: formalRescanAttempts.state }).from(formalRescanAttempts)
    .where(eq(formalRescanAttempts.requestId, attempt.requestId));
  const [repo] = await tx.select({ origin: repositories.url }).from(repositories)
    .where(and(eq(repositories.id, request.repositoryId), eq(repositories.projectId, request.projectId))).for('share');
  if (active?.state !== 'reserved' || repo?.origin !== request.origin) throw new ExecutionLost();
}

/** Reserve before dispatch and publish only a receipt bound to the current authorized execution. */
export async function runFormalRescan(coordinator: ExecutionCoordinator, scope: ExecutionScope, profile: VerificationProfile,
  runner: RescanRunner, signal?: AbortSignal): Promise<Rejection | RescanResult> {
  signal?.throwIfAborted();
  await coordinator.withLease(scope, async () => undefined);
  const status = qualifiedInspectionStatusSchema.safeParse(await runner.observe(signal).catch(() => null)).data;
  const selection = await coordinator.withLease(scope, async (tx, { task }) => {
    signal?.throwIfAborted();
    return reserve(tx, scope, await prepareFormalVerificationInput(tx, task, scope, profile), status);
  });
  if (selection.outcome) return selection.outcome;
  const plan = selection.plan;
  const { basis, attempt, request } = plan;
  let pulsed = false;
  let denied: { error: unknown } | undefined;
  const authorize = async () => {
    try {
      signal?.throwIfAborted();
      await coordinator.withLease(scope, tx => requireReservation(tx, plan));
      pulsed = true;
    } catch (error) {
      denied = { error };
      throw error;
    }
  };
  let outcome: Rejection | RescanResult;
  try {
    const raw = await runner.verify(request, basis.document, basis.repair, authorize, signal);
    outcome = checked(raw, plan);
    if (outcome.kind === 'scanned' && !pulsed) throw new Error('formal_rescan_authorization_missing');
  } catch { outcome = uncertain(attempt.requestId); }
  const cleanup = outcome.kind === 'scanned' || outcome.cleanup !== 'unknown' ? 'closed' : 'uncertain';
  try {
    if (denied) throw denied.error;
    signal?.throwIfAborted();
    return await coordinator.withLease(scope, async tx => {
      signal?.throwIfAborted();
      await requireReservation(tx, plan);
      await settle(tx, scope, attempt, outcome.kind === 'scanned' ? 'recorded' : cleanup,
        outcome.kind === 'scanned' ? outcome.receipt : undefined);
      signal?.throwIfAborted();
      return outcome;
    });
  } catch (error) {
    await coordinator.withLease(scope, tx => settle(tx, scope, attempt, cleanup), { allowCancel: true, authorize: false }).catch(() => undefined);
    throw error;
  }
}
