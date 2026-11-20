import { createAgentHarness, receiptSchema, sha256, type AgentFixtureHost, type AgentReceipt, type AgentSpec } from '@itervane/agent';
import { MemorySaver } from '@langchain/langgraph';
import type { ModelAdapter } from '@itervane/model';
import { expect, it, vi } from 'vitest';
import { createDeliveryFixture } from '../../src/agent/fixture.js';
import { scriptedModel } from '../../src/agent/scripted-model.js';

function modelChoosing(name: string, input: unknown = {}): ModelAdapter {
  return { protocol: 'anthropic', async complete() {
    return { text: 'fixture-only-unused-model-text', calls: [{ id: 'call', name, input }], tokenUsage: 1 };
  } };
}
function alter(host: AgentFixtureHost, replace: (receipt: AgentReceipt) => AgentReceipt): AgentFixtureHost {
  return { ...host, async observe(input) { return replace(receiptSchema.parse(await host.observe(input))); } };
}

it.each([
  ['display', 'zh-CN', 'empty_message', 'fill_empty_message'],
  ['pagination', 'en', 'page_size', 'default_page_size'],
] as const)('follows the observed %s section through independently verified repair', async (name, locale, finding, template) => {
  const { spec, host } = createDeliveryFixture(name, locale);
  const model = scriptedModel(locale);
  const complete = vi.fn(model.complete);
  const agent = createAgentHarness({ model: { ...model, complete }, checkpointer: new MemorySaver(), host });
  const result = await agent.run(spec);
  expect(result).toMatchObject({ status: 'completed', reason: 'fixture_complete', origin: 'trusted_fixture', releaseEligible: false });
  expect(result.message).toMatch(locale === 'zh-CN' ? /可信样例/ : /trusted fixture/);
  const investigation = result.trace.filter(item => item.role === 'audit' && item.tool === 'read_context');
  expect(investigation.map(item => result.evidence.find(evidence => evidence.id === item.evidenceId)?.data))
    .toMatchObject([{ section: 'overview' }, { section: name }]);
  const afterOverview = complete.mock.calls[1]?.[0];
  const call = afterOverview?.conversation[1];
  expect(call).toMatchObject({
    kind: 'assistant', turn: { text: '', calls: [{ name: 'read_context', input: { section: 'overview' } }] },
  });
  const originalId = call?.kind === 'assistant' ? call.turn.calls[0]?.id : undefined;
  expect(afterOverview?.conversation[2]).toMatchObject({
    kind: 'observations', observations: [{ callId: originalId, output: JSON.stringify({ evidenceId: investigation[0]?.evidenceId }) }],
  });
  expect(afterOverview?.tools.find(item => item.name === 'read_context')?.inputSchema).toMatchObject({
    properties: { section: { enum: ['display', 'pagination'] } },
  });
  expect(result.audit?.findings).toMatchObject([{ id: finding, certainty: 'confirmed' }]);
  const candidate = result.repairs[0]?.candidate;
  expect(candidate).toMatchObject({ baseSha256: spec.snapshotSha256, templateIds: [template] });
  expect(candidate?.diff).toContain('+++ b/settings.json');
  expect(sha256(candidate!.diff)).toBe(candidate!.diffSha256);
  expect(result.verifications[0]).toMatchObject({
    snapshotSha256: candidate!.snapshotSha256, outcome: 'verified_fixture',
    resolved: [finding], remaining: [], added: [], unverified: [],
  });
  expect(result.verifications[0]?.checks.map(check => check.status)).toEqual(['passed', 'passed', 'passed']);
  expect(await agent.run(spec)).toEqual(result);
});

it('catches an unrelated settings regression and repairs the issue on a fresh candidate', async () => {
  const { spec, host } = createDeliveryFixture('display', 'en');
  const agent = createAgentHarness({ model: scriptedModel('en', { tryBroadTemplate: true }), checkpointer: new MemorySaver(), host });
  const result = await agent.run(spec);
  expect(result.status).toBe('completed');
  expect(result.repairs.map(item => item.candidate.snapshotSha256)).toHaveLength(2);
  expect(result.repairs[0]?.candidate.snapshotSha256).not.toBe(result.repairs[1]?.candidate.snapshotSha256);
  expect(result.verifications).toMatchObject([
    { outcome: 'needs_repair', added: ['status_label_changed'] },
    { outcome: 'verified_fixture', added: [], resolved: ['empty_message'] },
  ]);
});

it('escalates an unavailable check and an exhausted repair limit', async () => {
  const { spec, host } = createDeliveryFixture('display', 'en', { maxRepairs: 1 });
  const model = scriptedModel('en', { tryBroadTemplate: true });
  const unavailable = alter(host, receipt => receipt.data.kind === 'check' && receipt.data.result.check === 'baseline'
    ? { ...receipt, data: { kind: 'check', result: { check: 'baseline', status: 'unavailable', findingIds: [] } } } : receipt);
  const first = await createAgentHarness({ model, checkpointer: new MemorySaver(), host: unavailable }).run(spec);
  expect(first).toMatchObject({
    status: 'requires_human', reason: 'check_unavailable',
    verifications: [{ outcome: 'unverified', resolved: [], unverified: ['baseline'] }],
  });
  const second = await createAgentHarness({ model, checkpointer: new MemorySaver(), host }).run(spec);
  expect(second).toMatchObject({ status: 'requires_human', reason: 'repair_limit' });
});

it('requires the full set of check receipts even when the model declares success', async () => {
  const { spec, host } = createDeliveryFixture('display', 'en');
  const script = scriptedModel('en');
  const model: ModelAdapter = { ...script, async complete(input) {
    const message = input.conversation[0];
    const context = message?.kind === 'user' ? JSON.parse(message.text) : {};
    if (context.role !== 'verify' || !context.observations.length) return script.complete(input);
    return modelChoosing('finish_role', { summary: 'Everything passed', evidenceIds: [context.observations[0].id] }).complete(input);
  } };
  const result = await createAgentHarness({ model, host, checkpointer: new MemorySaver() }).run(spec);
  expect(result).toMatchObject({ status: 'requires_human', reason: 'no_progress', verifications: [] });
  expect(result.trace.filter(item => item.role === 'verify').map(item => item.tool)).toEqual(['read_candidate']);
});

it('keeps incomplete audit coverage at the human boundary', async () => {
  const { spec, host } = createDeliveryFixture('pagination', 'en');
  const partial = alter(host, receipt => receipt.data.kind === 'findings'
    ? { ...receipt, data: { ...receipt.data, coverage: 'partial', limits: ['Only one fixture file was available.'] } } : receipt);
  const result = await createAgentHarness({ host: partial, model: scriptedModel('en'), checkpointer: new MemorySaver() }).run(spec);
  expect(result).toMatchObject({ status: 'requires_human', reason: 'audit_incomplete', audit: { coverage: 'partial' }, repairs: [] });
});

it.each([
  ['scope', { bindingSha256: '0'.repeat(64) }],
  ['snapshot', { snapshotSha256: '0'.repeat(64) }],
] as const)('rejects a receipt bound to a different %s', async (_, replacement) => {
  const { spec, host } = createDeliveryFixture('display', 'en');
  const invalid = alter(host, receipt => ({ ...receipt, ...replacement }));
  const result = await createAgentHarness({ host: invalid, model: scriptedModel('en'), checkpointer: new MemorySaver() }).run(spec);
  expect(result).toMatchObject({ status: 'requires_human', reason: 'invalid_receipt', trace: [], evidence: [] });
});

it.each([
  ['forbidden role', 'draft_repair', { templateIds: ['fill_empty_message'] }],
  ['extra arguments', 'read_context', { section: 'overview', project: 'other' }],
  ['unsupported action', 'request_unknown_tool', {}],
  ['invented evidence', 'finish_role', { summary: 'All clear', evidenceIds: ['0'.repeat(64)], explanations: [] }],
] as const)('rejects %s before any observation and omits free model text from persisted state', async (_, name, args) => {
  const { spec, host } = createDeliveryFixture('display', 'en');
  const checkpointer = new MemorySaver();
  const observe = vi.fn(host.observe);
  const model = modelChoosing(name, args);
  const result = await createAgentHarness({ model, host: { ...host, observe }, checkpointer }).run(spec);
  expect(result).toMatchObject({ status: 'requires_human', reason: 'no_progress', usage: { turns: 3, toolCalls: 0 } });
  expect(observe).not.toHaveBeenCalled();
  for await (const record of checkpointer.list({ configurable: { thread_id: `fixture-agent:${spec.runId}` } })) {
    expect(JSON.stringify(record)).not.toContain('fixture-only-unused-model-text');
  }
});

it.each([
  ['turn_budget', { maxTurns: 1 }, 1, 1],
  ['tool_budget', { maxToolCalls: 1 }, 2, 1],
  ['token_budget', { maxTokens: 1 }, 1, 0],
] as const)('reserves calls and stops at the %s limit', async (reason, limits, turns, toolCalls) => {
  const { spec, host } = createDeliveryFixture('display', 'en', limits);
  const script = scriptedModel('en');
  const complete = vi.fn(script.complete);
  const result = await createAgentHarness({ host, model: { ...script, complete }, checkpointer: new MemorySaver() }).run(spec);
  expect(result).toMatchObject({ status: 'requires_human', reason, usage: { turns, toolCalls } });
  expect(complete).toHaveBeenCalledTimes(turns);
  expect(complete.mock.calls[0]?.[0].maxOutputTokens).toBe('maxTokens' in limits ? limits.maxTokens : 1_024);
});

it('compacts observation text while retaining its evidence reference', async () => {
  const { spec, host } = createDeliveryFixture('display', 'zh-CN', { maxContextBytes: 2_048 });
  const withLongNote = alter(host, receipt => receipt.data.kind === 'context'
    ? { ...receipt, data: { ...receipt.data, text: '合'.repeat(1_200) } } : receipt);
  const complete: ModelAdapter['complete'] = vi.fn(async (input) => {
    const message = input.conversation[0];
    if (message?.kind !== 'user') throw new Error('Missing user context');
    expect(Buffer.byteLength(JSON.stringify(input.conversation)) + Buffer.byteLength(input.system)).toBeLessThanOrEqual(2_048);
    const context = JSON.parse(message.text);
    expect(context.observations).toEqual([]);
    return !context.evidenceIndex.length ? modelChoosing('read_context', { section: 'overview' }).complete(input)
      : modelChoosing('request_human').complete(input);
  });
  const result = await createAgentHarness({ host: withLongNote, model: { protocol: 'anthropic', complete }, checkpointer: new MemorySaver() }).run(spec);
  expect(result).toMatchObject({ status: 'requires_human', reason: 'manual_review', evidence: [expect.objectContaining({ id: expect.any(String) })] });
});

it('rejects a provider batch and offers localized feedback before dispatching a single new decision', async () => {
  const { spec, host } = createDeliveryFixture('display', 'zh-CN');
  const observe = vi.fn(host.observe);
  const complete = vi.fn<ModelAdapter['complete']>(async input => {
    const message = input.conversation[0];
    expect(input.singleTool).toBe(true);
    if (message?.kind !== 'user') throw new Error('Missing user context');
    if (JSON.parse(message.text).feedback?.includes('上一轮提出了多项调用')) return modelChoosing('request_human').complete(input);
    return { text: '', tokenUsage: 1, calls: [
      { id: 'first', name: 'read_context', input: { section: 'overview' } },
      { id: 'second', name: 'read_findings', input: {} },
    ] };
  });
  const result = await createAgentHarness({
    host: { ...host, observe }, model: { protocol: 'anthropic', complete }, checkpointer: new MemorySaver(),
  }).run(spec);
  expect(result).toMatchObject({ status: 'requires_human', reason: 'manual_review', usage: { turns: 2, toolCalls: 0 } });
  expect(observe).not.toHaveBeenCalled();
});

it('stops repeated observations, loss of authorization and cancellation before further effects', async () => {
  const { spec, host } = createDeliveryFixture('display', 'en');
  const run = (currentHost: AgentFixtureHost, model: ModelAdapter, signal?: AbortSignal) =>
    createAgentHarness({ host: currentHost, model, checkpointer: new MemorySaver() }).run(spec, signal ? { signal } : {});
  const repeated = modelChoosing('read_context', { section: 'overview' });
  expect(await run(host, repeated)).toMatchObject({ reason: 'no_progress', usage: { toolCalls: 1 }, evidence: [expect.anything()] });

  let allowed = true;
  const observe = vi.fn(host.observe);
  const revoked = { ...repeated, async complete(input: Parameters<ModelAdapter['complete']>[0]) {
    allowed = false;
    return repeated.complete(input);
  } };
  expect(await run({ ...host, authorize: async () => allowed, observe }, revoked)).toMatchObject({ reason: 'permission_denied' });
  expect(observe).not.toHaveBeenCalled();

  const controller = new AbortController();
  const cancelled = { ...repeated, async complete(input: Parameters<ModelAdapter['complete']>[0]) {
    controller.abort();
    return repeated.complete(input);
  } };
  expect(await run({ ...host, observe }, cancelled, controller.signal)).toMatchObject({ status: 'cancelled', reason: 'cancelled' });
  expect(observe).not.toHaveBeenCalled();
});

it('reports the timer deadline for a hung provider even before the wall clock advances', async () => {
  const limits: Partial<AgentSpec['limits']> = { maxDurationMs: 100 };
  const { spec, host } = createDeliveryFixture('display', 'en', limits);
  const complete = vi.fn<ModelAdapter['complete']>(() => new Promise(() => {}));
  const observe = vi.fn(host.observe);
  const wallClock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  try {
    const result = await createAgentHarness({
      host: { ...host, observe }, model: { protocol: 'anthropic', complete }, checkpointer: new MemorySaver(),
    }).run(spec);
    expect(result).toMatchObject({ status: 'requires_human', reason: 'deadline' });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(observe).not.toHaveBeenCalled();
  } finally {
    wallClock.mockRestore();
  }
});
