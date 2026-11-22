import { createFormalOperations } from '@itervane/agent';
import { sha256 } from '@itervane/runner';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { OperationsInstallation } from '../config.js';
import { requireStoredActor } from '../service/access.js';
import { DomainError } from '../service/errors.js';
import { readOperationsReleaseEvidence } from '../service/operations-targets.js';
import type { ExecutionScope } from './authority.js';
import { GuardedCheckpointer } from './checkpointer.js';
import type { ExecutionCoordinator } from './coordinator.js';
import type { AuditModel } from './formal-audit.js';
import { publishOperationsDiagnosis } from './operations-diagnosis-result.js';
import { OperationsEvidenceStore, requireCurrentDiagnosis } from './operations-evidence-store.js';
import { OperationsExecutionError, operationsObservationFailure } from './operations-execution.js';
import { WhiskersObservationClient } from './whiskers-observation.js';

type ReadOperations = Parameters<typeof createFormalOperations>[0]['read'];

async function readEvidence(store: OperationsEvidenceStore, scope: ExecutionScope, readKey: string,
  { section, operationId, signal }: Parameters<ReadOperations>[0]) {
  const reserved = await store.reserve(scope, section, operationId, signal);
  if (reserved.state === 'recorded') return reserved.evidence;

  if (section === 'release') {
    const fact = await store.withReservation(scope, section, operationId, signal, async (tx, { task }, { request }) =>
      readOperationsReleaseEvidence(tx, await requireStoredActor(tx, task.requestedBy), request));
    return store.record(scope, operationId, { kind: 'operations_section', section, ...fact }, signal);
  }
  const authorize = () => store.withReservation(scope, section, operationId, signal, async () => {});
  const observer = new WhiskersObservationClient(reserved.target, readKey);
  const reads = {
    container: () => observer.observe(authorize, signal),
    logs: () => observer.observeLogs(authorize, signal),
    metrics: () => observer.observeMetrics(authorize, signal),
  };
  const result = await reads[section]().catch(operationsObservationFailure);
  const proofSha256 = sha256(JSON.stringify({ version: 1, section, result }));
  return store.record(scope, operationId, { kind: 'operations_section', section, proofSha256, result }, signal);
}

export async function runFormalOperations(coordinator: ExecutionCoordinator, scope: ExecutionScope, saver: PostgresSaver,
  installed: OperationsInstallation & { diagnosisProviderSha256: string }, model: AuditModel, signal: AbortSignal) {
  signal.throwIfAborted();
  if (model.providerSha256 !== installed.diagnosisProviderSha256) throw new OperationsExecutionError('operations_unavailable');
  const checkCurrent = () => coordinator.withLease(scope, (tx, current) => requireCurrentDiagnosis(tx, current, installed));
  const { input, target } = await checkCurrent();
  const { environmentId, enrollmentSha256, readKey } = installed;
  const { providerSha256 } = model;
  const checkpointer = new GuardedCheckpointer(coordinator, scope, saver, {
    operations: { inputSha256: input.sha256, providerSha256, environmentId, enrollmentSha256 }, signal,
  });
  const store = new OperationsEvidenceStore(coordinator, installed);
  let readFailure: unknown;
  const agent = createFormalOperations({
    input, serverId: target.whiskers.serverId, checkpointer, model: model.adapter, providerSha256,
    async authorize(_agent, active) {
      await checkCurrent();
      return !active.aborted;
    },
    async read(action) {
      try { return await readEvidence(store, scope, readKey, action); }
      catch (error) { readFailure = error; throw error; }
    },
  });
  const report = await agent.run({ signal });
  signal.throwIfAborted();
  await coordinator.withLease(scope, async (tx, current) => {
    const diagnosis = await requireCurrentDiagnosis(tx, current, installed);
    if (report.status !== 'completed') {
      if (report.reason === 'permission_denied') throw new DomainError('forbidden');
      if (readFailure) throw readFailure;
      if (report.reason === 'deadline') throw new OperationsExecutionError('operations_timeout');
      throw new OperationsExecutionError('operations_review_required');
    }
    await publishOperationsDiagnosis(tx, current.task, scope, diagnosis, report, signal);
  });
}
