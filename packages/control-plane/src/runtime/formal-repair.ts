import { createFormalRepair } from '@itervane/agent';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { DomainError } from '../service/errors.js';
import { prepareFormalRepairInput } from '../service/formal-repair.js';
import type { ExecutionScope } from './authority.js';
import { GuardedCheckpointer } from './checkpointer.js';
import type { ExecutionCoordinator } from './coordinator.js';
import type { AuditModel } from './formal-audit.js';
import { FormalRepairExecution, type RepairPolicy, type RepairRunner } from './repair-execution.js';
import { observeFormalRepairTargets, type RepairObservationRunner } from './repair-observation.js';

export type FormalRepairOptions = RepairPolicy & { runner: RepairRunner & RepairObservationRunner };

export async function runFormalRepair(coordinator: ExecutionCoordinator, scope: ExecutionScope, saver: PostgresSaver,
  model: AuditModel, options: FormalRepairOptions, signal: AbortSignal) {
  signal.throwIfAborted();
  const input = await coordinator.withLease(scope, (tx, { task }) => prepareFormalRepairInput(tx, task, scope));
  const checkpointer = new GuardedCheckpointer(coordinator, scope, saver, { repairInputSha256: input.sha256, signal });
  const execution = new FormalRepairExecution(coordinator, options);
  const repair = createFormalRepair({
    input, audit: input.audit, model: model.adapter, providerSha256: model.providerSha256, checkpointer,
    authorize: (_agent, active) => coordinator.withLease(scope, async () => !active.aborted),
    readTargets: (ids, active) => observeFormalRepairTargets(coordinator, scope, ids, options, active),
    apply: (proposal, active) => execution.apply(scope, proposal, active),
  });
  const report = await repair.run({ signal });
  signal.throwIfAborted();
  await coordinator.withLease(scope, async () => {});
  if (report.reason === 'permission_denied') throw new DomainError('forbidden');
  if (!report.checkpointId) throw new DomainError('unavailable');
  return report;
}
