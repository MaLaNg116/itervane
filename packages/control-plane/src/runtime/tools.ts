import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { toolResultSchema, type CodeRuleValidationProfile, type ToolResult } from '@itervane/contracts';
import { repositories, runRuntime, toolCalls } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { DomainError } from '../service/errors.js';
import { appendEvent, BudgetExhausted, ExecutionLost, type ExecutionScope, type TaskRow } from './authority.js';
import { ExecutionCoordinator } from './coordinator.js';
import { SourceInspection, type InspectionRunner } from './source-inspection.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const emptyArguments = z.object({}).strict();
export const preflightTools = Object.freeze({
  'project.describe': { effect: 'read', target: 'current-project' },
  'source.inspect': { effect: 'read', target: 'current-source', requires: 'verified-vm-runner' },
});

export class ToolGateway {
  private readonly inspection: SourceInspection;
  constructor(readonly coordinator: ExecutionCoordinator, runner?: InspectionRunner, ruleProfile?: CodeRuleValidationProfile) {
    this.inspection = new SourceInspection(coordinator, runner, ruleProfile);
  }

  async call(scope: ExecutionScope, name: string, args: unknown, callKey: string, signal?: AbortSignal): Promise<ToolResult> {
    signal?.throwIfAborted();
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
        // 重领未写结果的调用不重复扣预算。Runner 派发还须另行核对检查尝试。
        await tx.update(toolCalls).set({ fence: scope.fence }).where(and(eq(toolCalls.runId, scope.runId), eq(toolCalls.keyHash, keyHash)));
        return null;
      }
      if (runtime.toolsUsed >= runtime.maxTools) throw new BudgetExhausted();
      await tx.update(runRuntime).set({ toolsUsed: runtime.toolsUsed + 1 }).where(eq(runRuntime.runId, scope.runId));
      await tx.insert(toolCalls).values({ runId: scope.runId, keyHash, inputHash, tool, fence: scope.fence, status: 'reserved' });
      return null;
    });
    if (cached) return cached;

    const valid = emptyArguments.safeParse(args).success;
    if (tool === 'source.inspect' && valid) {
      return this.inspection.run(scope, (tx, task, result, requestId) =>
        this.publish(tx, task, scope, keyHash, tool, result, requestId), signal);
    }
    return this.coordinator.withLease(scope, async (tx, { task }) => {
      if (tool === 'unsupported' || !valid) return this.publish(tx, task, scope, keyHash, tool,
        { status: 'business_error', code: tool === 'unsupported' ? 'tool_denied' : 'invalid_arguments', retryable: false });
      const [repository] = await tx.select().from(repositories)
        .where(and(eq(repositories.id, task.repositoryId), eq(repositories.projectId, task.projectId)));
      if (!repository) throw new DomainError('not_found');
      const data = { projectId: task.projectId, repositoryId: repository.id, commit: task.commit, dataClass: task.dataClass };
      return this.publish(tx, task, scope, keyHash, tool,
        { status: 'success', evidence: [{ id: randomUUID(), sha256: digest(JSON.stringify(data)), kind: 'observation' }], data });
    });
  }

  private async publish(tx: Transaction, task: TaskRow, scope: ExecutionScope, keyHash: string,
    tool: keyof typeof preflightTools | 'unsupported', result: ToolResult, requestId?: string): Promise<ToolResult> {
    const [existing] = await tx.select().from(toolCalls).where(and(eq(toolCalls.runId, scope.runId), eq(toolCalls.keyHash, keyHash)));
    if (existing?.result) return toolResultSchema.parse(existing.result);
    const checked = toolResultSchema.parse(result);
    const [updated] = await tx.update(toolCalls).set({ status: checked.status, result: checked })
      .where(and(eq(toolCalls.runId, scope.runId), eq(toolCalls.keyHash, keyHash), eq(toolCalls.fence, scope.fence)))
      .returning({ key: toolCalls.keyHash });
    if (!updated) throw new ExecutionLost();
    await appendEvent(tx, task, 'task.tool_observed', 'running', { workerId: scope.workerId, reason: tool,
      observation: { runId: scope.runId, toolCallKeySha256: keyHash, ...(requestId ? { inspectionRequestId: requestId } : {}) } });
    return checked;
  }
}
