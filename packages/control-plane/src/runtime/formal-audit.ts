import { createFormalAudit } from '@itervane/agent';
import type { StandardVerificationProfile } from '@itervane/contracts';
import { createAnthropic, createOpenAI, type ModelAdapter } from '@itervane/model';
import { sha256 } from '@itervane/runner';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { workerConfig } from '../config.js';
import { DomainError } from '../service/errors.js';
import { prepareFormalAuditInput, publishFormalAudit } from '../service/formal-audit.js';
import type { ExecutionScope } from './authority.js';
import { GuardedCheckpointer } from './checkpointer.js';
import type { ExecutionCoordinator } from './coordinator.js';
import { prepareFormalVerificationInput } from './verification-input.js';

export type AuditModel = Readonly<{ adapter: ModelAdapter; providerSha256: string }>;

export function configuredAuditModel(config: NonNullable<ReturnType<typeof workerConfig>['auditModel']>): AuditModel {
  const { protocol, baseURL, model, apiKey } = config;
  const connect = protocol === 'anthropic' ? createAnthropic : createOpenAI;
  return { adapter: connect({ baseURL, model, apiKey }), providerSha256: sha256(JSON.stringify({ protocol, baseURL, model })) };
}

export async function runFormalAudit(coordinator: ExecutionCoordinator, scope: ExecutionScope, saver: PostgresSaver,
  model: AuditModel | undefined, signal: AbortSignal, allowRepair: boolean, verification?: StandardVerificationProfile) {
  const prepared = await coordinator.withLease(scope, (tx, { task }) => prepareFormalAuditInput(tx, task, scope));
  if (!model) return 'unavailable' as const;
  const checkpointer = new GuardedCheckpointer(coordinator, scope, saver, { auditInputSha256: prepared.sha256, signal });
  const audit = createFormalAudit({ input: prepared, inspection: prepared.inspection, model: model.adapter, providerSha256: model.providerSha256,
    checkpointer, authorize: (_scope, active) => coordinator.withLease(scope, async () => !active.aborted),
  });
  const report = await audit.run({ signal });
  signal.throwIfAborted();
  if (!report.checkpointId) await coordinator.withLease(scope, async () => {});
  if (report.reason === 'permission_denied') throw new DomainError('forbidden');
  if (!report.checkpointId) throw new DomainError('unavailable');
  return coordinator.withLease(scope, async (tx, { task }) => {
    const next = await publishFormalAudit(tx, task, scope, prepared, report, model.adapter.protocol, signal, allowRepair, verification !== undefined);
    if (next === 'verification_pending' && verification) await prepareFormalVerificationInput(tx, task, scope, verification);
    signal.throwIfAborted();
    return next;
  });
}
