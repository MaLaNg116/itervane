import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { toolResultSchema } from '@itervane/contracts';
import { repositories, runRuntime, toolCalls } from '../persistence/schema.js';
import { DomainError } from '../service/errors.js';
import { appendEvent, BudgetExhausted, ExecutionLost, type ExecutionScope } from './authority.js';
import { ExecutionCoordinator } from './coordinator.js';
import { prepareInspection } from '../service/inspections.js';

type ToolResult = z.infer<typeof toolResultSchema>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const emptyArguments = z.object({}).strict();
export const preflightTools = Object.freeze({
  'project.describe': { effect: 'read', target: 'current-project' },
  'source.inspect': { effect: 'read', target: 'current-source', requires: 'verified-vm-runner' },
});

export class ToolGateway {
  constructor(readonly coordinator: ExecutionCoordinator) {}

  async call(scope: ExecutionScope, name: string, args: unknown, callKey: string): Promise<ToolResult> {
    if (!callKey || callKey.length > 128 || name.length > 128) throw new DomainError('invalid_input');
    const serialized = JSON.stringify({ name, args });
    if (serialized.length > 16_384) throw new DomainError('invalid_input');
    const keyHash = digest(callKey); const inputHash = digest(serialized);
    const tool = name === 'project.describe' || name === 'source.inspect' ? name : 'unsupported';
    const cached = await this.coordinator.withLease(scope, async (tx, { runtime }) => {
      const [existing] = await tx.select().from(toolCalls).where(and(eq(toolCalls.runId, scope.runId), eq(toolCalls.keyHash, keyHash)));
      if (existing) {
        if (existing.inputHash !== inputHash) throw new DomainError('idempotency_conflict');
        if (existing.result) return toolResultSchema.parse(existing.result);
        // 本目录只有只读工具；崩溃后未落结果的预留可以重放，不重复扣预算。
        await tx.update(toolCalls).set({ fence: scope.fence }).where(and(eq(toolCalls.runId, scope.runId), eq(toolCalls.keyHash, keyHash)));
        return null;
      }
      if (runtime.toolsUsed >= runtime.maxTools) throw new BudgetExhausted();
      await tx.update(runRuntime).set({ toolsUsed: runtime.toolsUsed + 1 }).where(eq(runRuntime.runId, scope.runId));
      await tx.insert(toolCalls).values({ runId: scope.runId, keyHash, inputHash, tool, fence: scope.fence, status: 'reserved' });
      return null;
    });
    if (cached) return cached;

    // 工具执行与预留分开；每次入口及结果写入都重新检查权限和执行权。
    const result = await this.coordinator.withLease(scope, async (tx, { task }): Promise<ToolResult> => {
      if (tool === 'unsupported') return { status: 'business_error', code: 'tool_denied', retryable: false };
      if (!emptyArguments.safeParse(args).success) return { status: 'business_error', code: 'invalid_arguments', retryable: false };
      if (tool === 'source.inspect') {
        await prepareInspection(tx, task, scope.runId, scope.fence);
        return { status: 'business_error', code: 'runner_unavailable', retryable: false };
      }
      const [repository] = await tx.select().from(repositories)
        .where(and(eq(repositories.id, task.repositoryId), eq(repositories.projectId, task.projectId)));
      if (!repository) throw new DomainError('not_found');
      const data = { projectId: task.projectId, repositoryId: repository.id, commit: task.commit, dataClass: task.dataClass };
      return { status: 'success', evidence: [{ id: randomUUID(), sha256: digest(JSON.stringify(data)), kind: 'observation' }], data };
    });
    return this.coordinator.withLease(scope, async (tx, { task }) => {
      const [existing] = await tx.select().from(toolCalls).where(and(eq(toolCalls.runId, scope.runId), eq(toolCalls.keyHash, keyHash)));
      if (existing?.result) return toolResultSchema.parse(existing.result);
      const [updated] = await tx.update(toolCalls).set({ status: result.status, result })
        .where(and(eq(toolCalls.runId, scope.runId), eq(toolCalls.keyHash, keyHash), eq(toolCalls.fence, scope.fence))).returning();
      if (!updated) throw new ExecutionLost();
      await appendEvent(tx, task, 'task.tool_observed', 'running', { workerId: scope.workerId, reason: tool });
      return toolResultSchema.parse(result);
    });
  }
}
