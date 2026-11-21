import { createFormalVerification } from '@itervane/agent';
import type { VerificationProfile } from '@itervane/contracts';
import type { QualifiedInspectionClient } from '@itervane/runner';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { eq } from 'drizzle-orm';
import { formalVerificationRuntime } from '../persistence/schema.js';
import { DomainError } from '../service/errors.js';
import { ExecutionLost, type ExecutionScope } from './authority.js';
import { GuardedCheckpointer } from './checkpointer.js';
import type { ExecutionCoordinator } from './coordinator.js';
import type { AuditModel } from './formal-audit.js';
import { runFormalRescan, type RescanRunner } from './formal-rescan.js';
import { prepareFormalVerificationInput } from './verification-input.js';

export type FormalVerificationOptions = {
  runner: RescanRunner & Partial<Pick<QualifiedInspectionClient, 'verifyArchive'>>;
  profile: VerificationProfile;
};

export async function runFormalVerification(coordinator: ExecutionCoordinator, scope: ExecutionScope, saver: PostgresSaver,
  model: AuditModel, options: FormalVerificationOptions, signal: AbortSignal) {
  const { profile, runner } = options;
  const rescan = await runFormalRescan(coordinator, scope, profile, runner, signal);
  if (rescan.kind === 'rejected') return rescan;
  signal.throwIfAborted();
  const input = await coordinator.withLease(scope, (tx, { task }) => prepareFormalVerificationInput(tx, task, scope, profile));
  const verification = { inputSha256: input.sha256, receiptSha256: rescan.evidence.binding.receiptSha256 };
  const checkpointer = new GuardedCheckpointer(coordinator, scope, saver, { verification, signal });
  const agent = createFormalVerification({
    input, evidence: rescan.evidence, checkpointer, model: model.adapter, providerSha256: model.providerSha256,
    authorize: (_agent, active) => coordinator.withLease(scope, async () => !active.aborted),
  });
  const report = await agent.run({ signal });
  signal.throwIfAborted();
  return coordinator.withLease(scope, async tx => {
    if (report.reason === 'permission_denied') throw new DomainError('forbidden');
    if (!report.checkpointId) throw new DomainError('unavailable');
    const [pointer] = await tx.select().from(formalVerificationRuntime).where(eq(formalVerificationRuntime.runId, scope.runId));
    if (pointer?.checkpointId !== report.checkpointId || pointer.inputSha256 !== verification.inputSha256
        || pointer.receiptSha256 !== verification.receiptSha256) throw new ExecutionLost();
    return { kind: 'reviewed' as const, report, evidence: rescan.evidence };
  });
}
