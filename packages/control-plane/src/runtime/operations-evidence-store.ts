import {
  operationsDiagnosisObservationSchema, operationsDiagnosisSectionSchema, sha256Schema, type OperationsDiagnosisObservation,
  type OperationsDiagnosisSection,
} from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, eq, sql } from 'drizzle-orm';
import type { OperationsWorkflowScope } from '../config.js';
import { operationsDiagnosisReads, runRuntime } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { DomainError, parseInput } from '../service/errors.js';
import { BudgetExhausted, ExecutionLost, type ExecutionScope } from './authority.js';
import type { ExecutionCoordinator } from './coordinator.js';
import { OperationsExecutionError, requireCurrentOperationsTarget } from './operations-execution.js';

type Target = Awaited<ReturnType<typeof requireCurrentOperationsTarget>>;
type Read = typeof operationsDiagnosisReads.$inferSelect;
type DiagnosisInstallation = OperationsWorkflowScope & { diagnosisProviderSha256: string };

function observationForTarget(raw: unknown, target: Target) {
  const observed = operationsDiagnosisObservationSchema.safeParse(raw);
  if (!observed.success) throw new OperationsExecutionError('operations_invalid_observation');
  const data = observed.data;
  const matches = data.section === 'release'
    ? data.result.current.operationId === target.releaseOperationId && data.result.current.manifestDigest === target.manifestDigest
    : data.result.containerId === target.containerId && data.result.serverId === target.whiskers.serverId;
  if (!matches) throw new OperationsExecutionError('operations_invalid_observation');
  return data;
}

function receiptHash(row: Pick<Read, 'runId' | 'operationId'>, evidence: OperationsDiagnosisObservation) {
  return sha256(JSON.stringify({ version: 1, runId: row.runId, operationId: row.operationId, evidence }));
}

function recordedEvidence(row: Read, target: Target) {
  const evidence = observationForTarget(row.document, target);
  if (evidence.section !== row.section || receiptHash(row, evidence) !== row.sha256) {
    throw new OperationsExecutionError('operations_invalid_observation');
  }
  return evidence;
}

function readKey(runId: string, section: OperationsDiagnosisSection) {
  return and(eq(operationsDiagnosisReads.runId, runId), eq(operationsDiagnosisReads.section, section));
}

export class OperationsEvidenceStore {
  constructor(private readonly coordinator: ExecutionCoordinator, private readonly installed: DiagnosisInstallation) {}

  private withAuthority<T>(scope: ExecutionScope, action: (tx: Transaction, target: Target,
    budget: Pick<typeof runRuntime.$inferSelect, 'toolsUsed' | 'maxTools'>) => Promise<T>) {
    return this.coordinator.withLease(scope, async (tx, current) => {
      if (current.operationsDiagnosis?.providerSha256 !== this.installed.diagnosisProviderSha256) {
        throw new OperationsExecutionError('operations_unavailable');
      }
      const target = await requireCurrentOperationsTarget(tx, current.task, current.operationsRequest, this.installed);
      return action(tx, target, current.runtime);
    });
  }

  async reserve(scope: ExecutionScope, section: OperationsDiagnosisSection, operationId: string) {
    parseInput(operationsDiagnosisSectionSchema, section);
    parseInput(sha256Schema, operationId);
    return this.withAuthority(scope, async (tx, target, budget) => {
      const key = readKey(scope.runId, section);
      const [row] = await tx.select().from(operationsDiagnosisReads).where(key);
      if (row && row.operationId !== operationId) throw new DomainError('version_conflict');
      if (row?.state === 'recorded') return { state: 'recorded' as const, evidence: recordedEvidence(row, target) };

      if (row) {
        if (row.fence >= scope.fence) throw new DomainError('conflict');
        if (row.attempts >= 2) throw new BudgetExhausted();
        await tx.update(operationsDiagnosisReads).set({ fence: scope.fence, workerId: scope.workerId, attempts: row.attempts + 1 }).where(key);
      } else {
        if (budget.toolsUsed >= budget.maxTools) throw new BudgetExhausted();
        await tx.update(runRuntime).set({ toolsUsed: budget.toolsUsed + 1 }).where(eq(runRuntime.runId, scope.runId));
        const [inserted] = await tx.insert(operationsDiagnosisReads).values({
          runId: scope.runId, section, operationId, workerId: scope.workerId, fence: scope.fence, attempts: 1, state: 'reserved',
        }).onConflictDoNothing().returning({ section: operationsDiagnosisReads.section });
        if (!inserted) throw new DomainError('version_conflict');
      }
      return { state: 'reserved' as const, target: { ...target.whiskers, containerId: target.containerId } };
    });
  }

  async record(scope: ExecutionScope, operationId: string, raw: unknown) {
    parseInput(sha256Schema, operationId);
    return this.withAuthority(scope, async (tx, target) => {
      const evidence = observationForTarget(raw, target);
      const key = readKey(scope.runId, evidence.section);
      const [row] = await tx.select().from(operationsDiagnosisReads).where(key);
      if (!row || row.operationId !== operationId) throw new DomainError('version_conflict');
      const fingerprint = receiptHash(row, evidence);
      if (row.state === 'recorded') {
        if (fingerprint !== row.sha256) throw new DomainError('version_conflict');
        return recordedEvidence(row, target);
      }
      if (row.fence !== scope.fence || row.workerId !== scope.workerId) throw new ExecutionLost();
      await tx.update(operationsDiagnosisReads).set({
        state: 'recorded', document: evidence, sha256: fingerprint, recordedAt: sql`clock_timestamp()`,
      }).where(key);
      return evidence;
    });
  }
}
