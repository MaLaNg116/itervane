import type { RunnableConfig } from '@langchain/core/runnables';
import { BaseCheckpointSaver, type ChannelVersions, type Checkpoint, type CheckpointMetadata,
  type CheckpointTuple, type PendingWrite } from '@langchain/langgraph-checkpoint';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { and, eq } from 'drizzle-orm';
import { checkpointWrites, runRuntime } from '../persistence/schema.js';
import { ExecutionLost, type ExecutionScope } from './authority.js';
import { ExecutionCoordinator } from './coordinator.js';

/** Only this logical run's published checkpoint is a valid recovery entry point. */
export class GuardedCheckpointer extends BaseCheckpointSaver {
  constructor(readonly coordinator: ExecutionCoordinator, readonly scope: ExecutionScope, readonly storage: PostgresSaver) { super(storage.serde); }

  // PostgresSaver 为分叉重算加入随机版本后缀，避免未发布分支占用同一个 blob key。
  override getNextVersion(current: number | undefined): number { return this.storage.getNextVersion(current); }

  private async hashWrite(write: unknown) {
    const [type, bytes] = await this.serde.dumpsTyped(write);
    return createHash('sha256').update(type).update(bytes).digest('hex');
  }

  private bind(config: RunnableConfig): RunnableConfig {
    if (config.configurable?.thread_id !== this.scope.runId || config.configurable?.checkpoint_ns) throw new ExecutionLost();
    return { configurable: { thread_id: this.scope.runId, checkpoint_ns: '',
      ...(config.configurable?.checkpoint_id ? { checkpoint_id: config.configurable.checkpoint_id } : {}) } };
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.bind(config);
    return this.coordinator.withLease(this.scope, async (tx, { runtime }) => {
      if (!runtime.checkpointId) return undefined;
      if (config.configurable?.checkpoint_id && config.configurable.checkpoint_id !== runtime.checkpointId) throw new ExecutionLost();
      const tuple = await this.storage.getTuple({ configurable: { thread_id: this.scope.runId, checkpoint_ns: '', checkpoint_id: runtime.checkpointId } });
      if (!tuple) throw new Error('Published checkpoint is missing');
      const published = new Set((await tx.select().from(checkpointWrites).where(and(eq(checkpointWrites.runId, this.scope.runId),
        eq(checkpointWrites.checkpointId, runtime.checkpointId)))).map(row => row.writeHash));
      const hashes = await Promise.all((tuple.pendingWrites ?? []).map(write => this.hashWrite(write)));
      return { ...tuple, pendingWrites: (tuple.pendingWrites ?? []).filter((_write, index) => published.has(hashes[index]!)) };
    });
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, newVersions: ChannelVersions): Promise<RunnableConfig> {
    const bound = this.bind(config);
    return this.coordinator.withLease(this.scope, async (tx, { runtime }) => {
      const next = await this.storage.put(bound, checkpoint, metadata, newVersions);
      // 用图的持久化 step 排序；跨进程的系统时钟回拨不能使 UUID 时间排序阻塞进展。
      if (!Number.isSafeInteger(metadata.step)) throw new Error('Invalid checkpoint step');
      if (!runtime.checkpointId || metadata.step > runtime.checkpointStep) {
        await tx.update(runRuntime).set({ checkpointId: checkpoint.id, checkpointStep: metadata.step }).where(eq(runRuntime.runId, this.scope.runId));
      }
      return next;
    });
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string, taskPath?: string): Promise<void> {
    const bound = this.bind(config);
    await this.coordinator.withLease(this.scope, async tx => {
      if (typeof bound.configurable?.checkpoint_id !== 'string') throw new ExecutionLost();
      await this.storage.putWrites(bound, writes, taskId, taskPath);
      if (writes.length) await tx.insert(checkpointWrites).values(await Promise.all(writes.map(async ([channel, value]) => ({
        runId: this.scope.runId, checkpointId: bound.configurable!.checkpoint_id as string, writeHash: await this.hashWrite([taskId, channel, value]),
      })))).onConflictDoNothing();
    });
  }

  async *list(): AsyncGenerator<CheckpointTuple> { throw new Error('Checkpoint history is not a runtime recovery API'); }
  async deleteThread(): Promise<void> { throw new Error('Runtime cannot delete checkpoint history'); }
}
import { createHash } from 'node:crypto';
