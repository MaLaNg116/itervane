import { createHash } from 'node:crypto';
import type { RunnableConfig } from '@langchain/core/runnables';
import { BaseCheckpointSaver, type ChannelVersions, type Checkpoint, type CheckpointMetadata,
  type CheckpointTuple, type PendingWrite } from '@langchain/langgraph-checkpoint';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { and, eq } from 'drizzle-orm';
import { sha256Schema } from '@itervane/contracts';
import { checkpointWrites, formalAuditInputs, formalAuditRuntime, runRuntime } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { ExecutionLost, type ExecutionScope } from './authority.js';
import { ExecutionCoordinator } from './coordinator.js';

/** Only this logical run's published checkpoint is a valid recovery entry point. */
export class GuardedCheckpointer extends BaseCheckpointSaver {
  readonly threadId: string;
  private readonly graph: 'preflight' | 'audit';
  private readonly auditInputSha256: string | undefined;
  private readonly signal: AbortSignal | undefined;
  constructor(readonly coordinator: ExecutionCoordinator, readonly scope: ExecutionScope, readonly storage: PostgresSaver,
    options?: { auditInputSha256: string; signal?: AbortSignal }) {
    super(storage.serde);
    this.auditInputSha256 = options ? sha256Schema.parse(options.auditInputSha256) : undefined;
    this.signal = options?.signal;
    this.graph = options ? 'audit' : 'preflight';
    this.threadId = options ? `audit:${scope.runId}` : scope.runId;
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

  private async publication(tx: Transaction, runtime: typeof runRuntime.$inferSelect) {
    this.signal?.throwIfAborted();
    if (!this.auditInputSha256) return runtime;
    const [input] = await tx.select({ sha256: formalAuditInputs.sha256 }).from(formalAuditInputs)
      .where(eq(formalAuditInputs.runId, this.scope.runId));
    if (input?.sha256 !== this.auditInputSha256) throw new ExecutionLost();
    const [pointer] = await tx.select().from(formalAuditRuntime).where(eq(formalAuditRuntime.runId, this.scope.runId));
    if (pointer && pointer.inputSha256 !== this.auditInputSha256) throw new ExecutionLost();
    return pointer ?? { checkpointId: null, checkpointStep: -2 };
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.bind(config);
    return this.coordinator.withLease(this.scope, async (tx, { runtime }) => {
      const { checkpointId } = await this.publication(tx, runtime);
      if (!checkpointId) return undefined;
      if (config.configurable?.checkpoint_id && config.configurable.checkpoint_id !== checkpointId) throw new ExecutionLost();
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
    return this.coordinator.withLease(this.scope, async (tx, { runtime }) => {
      const published = await this.publication(tx, runtime);
      // 用图的持久化 step 排序；跨进程的系统时钟回拨不能使 UUID 时间排序阻塞进展。
      if (!Number.isSafeInteger(metadata.step)) throw new Error('Invalid checkpoint step');
      const next = await this.storage.put(bound, checkpoint, metadata, newVersions);
      // A retiring Worker may still hold its lease. Prevent its abort from becoming user cancellation on recovery.
      this.signal?.throwIfAborted();
      if (!published.checkpointId || metadata.step > published.checkpointStep) {
        const pointer = { checkpointId: checkpoint.id, checkpointStep: metadata.step };
        if (this.auditInputSha256) {
          const audit = { ...pointer, inputSha256: this.auditInputSha256, publishedFence: this.scope.fence, workerId: this.scope.workerId };
          await tx.insert(formalAuditRuntime).values({ runId: this.scope.runId, ...audit })
            .onConflictDoUpdate({ target: formalAuditRuntime.runId, set: audit });
        } else {
          await tx.update(runRuntime).set(pointer).where(eq(runRuntime.runId, this.scope.runId));
        }
      }
      return next;
    });
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string, taskPath?: string): Promise<void> {
    const bound = this.bind(config);
    await this.coordinator.withLease(this.scope, async (tx, { runtime }) => {
      if (typeof bound.configurable?.checkpoint_id !== 'string') throw new ExecutionLost();
      if (this.auditInputSha256) await this.publication(tx, runtime);
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
