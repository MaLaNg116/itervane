import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runProbeLoop, type ProbeTool } from '../../src/model/loop.js';
import type { ModelAdapter, ModelTurn } from '@itervane/model';

const call = (name: string, input: unknown = {}): ModelTurn => ({ text: '', calls: [{ id: 'call-1', name, input }], tokenUsage: 10 });
function fake(turns: ModelTurn[]): ModelAdapter {
  let index = 0;
  return { protocol: 'anthropic', complete: async () => turns[index++] ?? call('inspect') };
}
function fixture(): ProbeTool[] {
  const input = z.object({}).strict();
  return ['inspect', 'finish_audit'].map(name => ({ definition: { name, description: name, inputSchema: z.toJSONSchema(input) }, input, execute: async () => ({ observed: true }) }));
}

describe('bounded observation-driven loop', () => {
  it('provides actual tool observations to the next model turn', async () => {
    let sawObservation = false;
    const adapter: ModelAdapter = { protocol: 'anthropic', complete: async ({ conversation }) => {
      if (conversation.length === 1) return call('inspect');
      const latest = conversation.at(-1);
      sawObservation = latest?.kind === 'observations' && latest.observations[0]?.output.includes('observed') === true;
      return call('finish_audit');
    } };
    const result = await runProbeLoop({ adapter, tools: fixture(), goal: 'audit', signal: new AbortController().signal, acceptFinish: (_, trace) => trace.length === 1 });
    expect(result.status).toBe('completed');
    expect(sawObservation).toBe(true);
  });
  it('does not accept unsupported completion claims', async () => {
    const result = await runProbeLoop({ adapter: fake([call('finish_audit')]), tools: fixture(), goal: 'audit', maxTurns: 1, signal: new AbortController().signal, acceptFinish: () => false });
    expect(result.status).toBe('needs_human');
    expect(result.trace).toHaveLength(0);
  });
  it('refuses nonexistent tools and invalid arguments before execution', async () => {
    const result = await runProbeLoop({ adapter: fake([call('host_shell', { command: 'ignored' }), call('inspect', { approved: true })]), tools: fixture(), goal: 'audit', maxTurns: 2, signal: new AbortController().signal, acceptFinish: () => true });
    expect(result.trace).toHaveLength(0);
    expect(result.status).toBe('needs_human');
  });
  it('stops repeated actions without progress', async () => {
    const result = await runProbeLoop({ adapter: fake([]), tools: fixture(), goal: 'audit', signal: new AbortController().signal, acceptFinish: () => false });
    expect(result.reason).toBe('no_progress');
    expect(result.trace).toHaveLength(2);
  });
  it('does not execute a tool after cancellation', async () => {
    const controller = new AbortController();
    const adapter: ModelAdapter = { protocol: 'anthropic', complete: async () => { controller.abort(); return call('inspect'); } };
    const result = await runProbeLoop({ adapter, tools: fixture(), goal: 'audit', signal: controller.signal, acceptFinish: () => true });
    expect(result.status).toBe('cancelled');
    expect(result.trace).toHaveLength(0);
  });
  it('stops before executing tool calls that exceed the token budget', async () => {
    const result = await runProbeLoop({ adapter: fake([call('inspect')]), tools: fixture(), goal: 'audit', signal: new AbortController().signal, maxTokens: 1, acceptFinish: () => true });
    expect(result.reason).toBe('token_budget');
    expect(result.trace).toHaveLength(0);
  });
  it('bounds invalid tool calls and rejects malformed usage data', async () => {
    const many = { text: '', tokenUsage: 0, calls: Array.from({ length: 10 }, (_, n) => ({ id: String(n), name: 'unknown', input: {} })) };
    const budget = await runProbeLoop({ adapter: fake([many]), tools: fixture(), goal: 'audit', signal: new AbortController().signal, maxToolCalls: 3, acceptFinish: () => true });
    expect(budget.reason).toBe('tool_budget');
    expect(budget.trace).toHaveLength(0);
    const malformed = await runProbeLoop({ adapter: fake([{ ...call('inspect'), tokenUsage: -1 }]), tools: fixture(), goal: 'audit', signal: new AbortController().signal, acceptFinish: () => true });
    expect(malformed.reason).toBe('invalid_model_result');
    expect(malformed.trace).toHaveLength(0);
  });
});
