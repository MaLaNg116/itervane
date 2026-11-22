import { createHash } from 'node:crypto';
import type { RunnableConfig } from '@langchain/core/runnables';
import { BaseCheckpointSaver, type ChannelVersions, type Checkpoint, type CheckpointMetadata,
  type CheckpointTuple, type PendingWrite } from '@langchain/langgraph-checkpoint';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { and, eq } from 'drizzle-orm';
import { sha256Schema } from '@itervane/contracts';
import type { OperationsEnrollmentScope } from '../config.js';
import { checkpointWrites, formalAuditInputs, formalAuditRuntime, formalRepairInputs, formalRepairRuntime,
  formalRescanAttempts, formalVerificationInputs, formalVerificationRuntime, operationsDiagnosisRuntime, runRuntime } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { ExecutionLost, type ExecutionScope } from './authority.js';
import type { CurrentExecution, ExecutionCoordinator } from './coordinator.js';
import { requireCurrentOperationsTarget } from './operations-execution.js';

type OperationsCheckpoint = OperationsEnrollmentScope & { inputSha256: string; providerSha256: string };
type CheckpointOptions = { signal?: AbortSignal } & (
  { auditInputSha256: string; repairInputSha256?: never; verification?: never; operations?: never }
  | { repairInputSha256: string; auditInputSha256?: never; verification?: never; operations?: never }
  | { verification: { inputSha256: string; receiptSha256: string }; auditInputSha256?: never; repairInputSha256?: never; operations?: never }
  | { operations: OperationsCheckpoint; auditInputSha256?: never; repairInputSha256?: never; verification?: never }
);
const formalGraphs = {
  audit: { inputs: formalAuditInputs, pointers: formalAuditRuntime },
  repair: { inputs: formalRepairInputs, pointers: formalRepairRuntime },
  verify: { inputs: formalVerificationInputs, pointers: formalVerificationRuntime },
  operations: { pointers: operationsDiagnosisRuntime },
};

/** Only this logical run's published checkpoint is a valid recovery entry point. */
export class GuardedCheckpointer extends BaseCheckpointSaver {
  readonly threadId: string;
  private readonly graph: 'preflight' | keyof typeof formalGraphs;
  private readonly formalInputSha256: string | undefined;
  private readonly verificationReceiptSha256: string | undefined;
  private readonly operations: OperationsCheckpoint | undefined;
  private readonly signal: AbortSignal | undefined;
  constructor(readonly coordinator: ExecutionCoordinator, readonly scope: ExecutionScope, readonly storage: PostgresSaver,
    options?: CheckpointOptions) {
    super(storage.serde);
    this.formalInputSha256 = options ? sha256Schema.parse(options.operations?.inputSha256 ?? options.verification?.inputSha256
      ?? options.repairInputSha256 ?? options.auditInputSha256) : undefined;
    this.verificationReceiptSha256 = options?.verification && sha256Schema.parse(options.verification.receiptSha256);
    const operations = options?.operations;
    this.operations = operations && { environmentId: operations.environmentId, enrollmentSha256: operations.enrollmentSha256,
      inputSha256: operations.inputSha256, providerSha256: sha256Schema.parse(operations.providerSha256) };
    this.signal = options?.signal;
    this.graph = this.operations ? 'operations' : options?.verification ? 'verify'
      : options?.repairInputSha256 !== undefined ? 'repair' : options ? 'audit' : 'preflight';
    this.threadId = this.graph === 'preflight' ? scope.runId : `${this.graph}:${scope.runId}`;
  }

  // PostgresSaver 为分叉重算加入随机版本后缀，避免未发布分支占用同一个 blob key。
  override getNextVersion(current: number | undefined): number { return this.storage.getNextVersion(current); }

  private async hashWrite(write: unknown) {
    const [type, bytes] = await this.serde.dumpsTyped(write);
    return createHash('sha256').update(type).update(bytes).digest('hex');
  }

  private bind(config: RunnableConfig): RunnableConfig {
    this.signal?.throwIfAborted();
    if (config.configurable?.thread_id !== this.threadId || config.configurable?.checkpoint_ns) throw new ExecutionLost();
    return { configurable: { thread_id: this.threadId, checkpoint_ns: '',
      ...(config.configurable?.checkpoint_id ? { checkpoint_id: config.configurable.checkpoint_id } : {}) } };
  }

  private async publication(tx: Transaction, current: CurrentExecution) {
    this.signal?.throwIfAborted();
    if (this.graph === 'preflight') {
      if (current.run.role === 'operations') throw new ExecutionLost();
      return current.runtime;
    }
    if (!this.formalInputSha256) throw new ExecutionLost();
    if (this.graph === 'operations') {
      if (!this.operations || current.operationsDiagnosis?.sha256 !== this.formalInputSha256
          || current.operationsDiagnosis?.providerSha256 !== this.operations.providerSha256) throw new ExecutionLost();
      await requireCurrentOperationsTarget(tx, current.task, current.operationsRequest, this.operations);
    } else {
      const { inputs } = formalGraphs[this.graph];
      const [input] = await tx.select({ sha256: inputs.sha256 }).from(inputs).where(eq(inputs.runId, this.scope.runId));
      if (input?.sha256 !== this.formalInputSha256) throw new ExecutionLost();
    }
    if (this.verificationReceiptSha256) {
      const [rescan] = await tx.select({ receiptSha256: formalRescanAttempts.receiptSha256 }).from(formalRescanAttempts).where(and(
        eq(formalRescanAttempts.runId, this.scope.runId), eq(formalRescanAttempts.inputSha256, this.formalInputSha256),
        eq(formalRescanAttempts.state, 'recorded')));
      if (rescan?.receiptSha256 !== this.verificationReceiptSha256) throw new ExecutionLost();
    }
    const { pointers } = formalGraphs[this.graph];
    const [pointer] = await tx.select().from(pointers).where(eq(pointers.runId, this.scope.runId));
    if (pointer && (pointer.inputSha256 !== this.formalInputSha256
        || (this.verificationReceiptSha256 && (!('receiptSha256' in pointer) || pointer.receiptSha256 !== this.verificationReceiptSha256)))) {
      throw new ExecutionLost();
    }
    return pointer ?? { checkpointId: null, checkpointStep: -2 };
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.bind(config);
    return this.coordinator.withLease(this.scope, async (tx, current) => {
      const { checkpointId } = await this.publication(tx, current);
      if (config.configurable?.checkpoint_id && config.configurable.checkpoint_id !== checkpointId) throw new ExecutionLost();
      if (!checkpointId) return undefined;
      const tuple = await this.storage.getTuple({ configurable: { thread_id: this.threadId, checkpoint_ns: '', checkpoint_id: checkpointId } });
      if (!tuple) throw new Error('Published checkpoint is missing');
      const published = new Set((await tx.select().from(checkpointWrites).where(and(eq(checkpointWrites.runId, this.scope.runId),
        eq(checkpointWrites.graph, this.graph), eq(checkpointWrites.checkpointId, checkpointId)))).map(row => row.writeHash));
      const hashes = await Promise.all((tuple.pendingWrites ?? []).map(write => this.hashWrite(write)));
      return { ...tuple, pendingWrites: (tuple.pendingWrites ?? []).filter((_write, index) => published.has(hashes[index]!)) };
    });
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, newVersions: ChannelVersions): Promise<RunnableConfig> {
    const bound = this.bind(config);
    return this.coordinator.withLease(this.scope, async (tx, current) => {
      const published = await this.publication(tx, current);
      // 用图的持久化 step 排序；跨进程的系统时钟回拨不能使 UUID 时间排序阻塞进展。
      if (!Number.isSafeInteger(metadata.step)) throw new Error('Invalid checkpoint step');
      if (this.graph === 'operations' && published.checkpointId === checkpoint.id) throw new ExecutionLost();
      const next = await this.storage.put(bound, checkpoint, metadata, newVersions);
      // A retiring Worker may still hold its lease. Prevent its abort from becoming user cancellation on recovery.
      this.signal?.throwIfAborted();
      if (!published.checkpointId || metadata.step > published.checkpointStep) {
        const pointer = { checkpointId: checkpoint.id, checkpointStep: metadata.step };
        if (this.graph === 'preflight') {
          await tx.update(runRuntime).set(pointer).where(eq(runRuntime.runId, this.scope.runId));
        } else if (this.formalInputSha256) {
          const formal = { ...pointer, inputSha256: this.formalInputSha256, publishedFence: this.scope.fence, workerId: this.scope.workerId };
          if (this.verificationReceiptSha256) {
            const verification = { ...formal, receiptSha256: this.verificationReceiptSha256 };
            await tx.insert(formalVerificationRuntime).values({ runId: this.scope.runId, ...verification })
              .onConflictDoUpdate({ target: formalVerificationRuntime.runId, set: verification });
          } else {
            const { pointers } = formalGraphs[this.graph];
            await tx.insert(pointers).values({ runId: this.scope.runId, ...formal })
              .onConflictDoUpdate({ target: pointers.runId, set: formal });
          }
        }
      }
      return next;
    });
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string, taskPath?: string): Promise<void> {
    const bound = this.bind(config);
    await this.coordinator.withLease(this.scope, async (tx, current) => {
      if (typeof bound.configurable?.checkpoint_id !== 'string') throw new ExecutionLost();
      await this.publication(tx, current);
      await this.storage.putWrites(bound, writes, taskId, taskPath);
      this.signal?.throwIfAborted();
      if (writes.length) await tx.insert(checkpointWrites).values(await Promise.all(writes.map(async ([channel, value]) => ({
        runId: this.scope.runId, graph: this.graph, checkpointId: bound.configurable!.checkpoint_id as string, writeHash: await this.hashWrite([taskId, channel, value]),
      })))).onConflictDoNothing();
    });
  }

  async *list(): AsyncGenerator<CheckpointTuple> { throw new Error('Checkpoint history is not a runtime recovery API'); }
  async deleteThread(): Promise<void> { throw new Error('Runtime cannot delete checkpoint history'); }
}
