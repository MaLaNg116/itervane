import { randomUUID } from 'node:crypto';
import { MemorySaver } from '@langchain/langgraph';
import { createFormalOperations, sha256 } from '@itervane/agent';
import type { Locale } from '@itervane/contracts';
import { expect, it, vi } from 'vitest';
import { restoreState, type AgentState } from '../../../agent/src/state.js';
import { chooseOperationsSection as choose, operationsDecision as decision, operationsFixture, scriptedOperations } from '../../src/agent/operations-fixture.js';

function fixture(locale: Locale, state: 'running' | 'exited') {
  const sample = operationsFixture(locale, state);
  return { ...sample, checkpointer: new MemorySaver(), read: vi.fn(sample.read), authorize: vi.fn(sample.authorize) };
}

it.each([
  { locale: 'zh-CN', state: 'exited', path: ['container', 'logs', 'release'], hypothesis: 'application_error', recommendation: 'review_rollback' },
  { locale: 'en', state: 'running', path: ['container', 'metrics', 'release'], hypothesis: 'memory_pressure', recommendation: 'continue_observation' },
] as const)('chooses $path after observing a $state container and returns a diagnosis in $locale', async ({ locale, state, path, hypothesis, recommendation }) => {
  const sample = fixture(locale, state);
  const script = scriptedOperations();
  const complete = vi.fn(script.complete);
  const result = await createFormalOperations({ ...sample, model: { ...script, complete } }).run();
  expect(result).toMatchObject({ origin: 'formal_operations', role: 'operations', status: 'completed', reason: 'operations_review_complete',
    releaseEligible: false, usage: { turns: 4, toolCalls: 3 },
    formalOperations: {
      hypotheses: [{ code: hypothesis, evidenceIds: [result.evidence[1]?.id] }],
      recommendation: { code: recommendation, evidenceIds: [result.evidence[0]?.id, result.evidence[2]?.id] },
      previousReleaseOperationId: state === 'exited' ? sample.previousReleaseOperationId : null,
      facts: path.map((section, index) => ({ section, evidenceId: result.evidence[index]?.id, proofSha256: sha256(section) })),
    },
    operationsPresentation: { locale, recommendation: locale === 'zh-CN' ? '审查是否恢复到上一已核验版本。' : 'Continue observing the deployment.' },
  });
  expect(sample.read.mock.calls.map(([call]) => call.section)).toEqual(path);
  expect(complete.mock.calls[0]?.[0].tools.map(tool => tool.name)).toEqual(['read_operations', 'request_human']);
  for (const [request] of complete.mock.calls) {
    expect(request.tools.every(tool => ['read_operations', 'finish_role', 'request_human'].includes(tool.name))).toBe(true);
    const messages = JSON.stringify(request.conversation);
    expect(messages).not.toContain(sample.serverId);
    expect(messages).not.toContain(sample.input.document.request.containerId);
    expect(messages).not.toContain(sample.input.document.request.grantId);
    expect(messages).not.toContain(sample.input.document.request.source.repositoryId);
  }
});

it.each(['invented_reference', 'unsupported_action', 'unobserved_memory'] as const)('stops a diagnosis with %s without authorizing a change', async reason => {
  const sample = fixture('en', 'running');
  const script = scriptedOperations();
  if (reason === 'unobserved_memory') sample.read.mockImplementation(async ({ section }) => ({
    proofSha256: sha256(section),
    result: section === 'metrics' ? {
      containerId: sample.facts.container.containerId, serverId: sample.serverId, observedAt: sample.facts.container.observedAt,
      period: '1h', status: 'unavailable', reason: 'no_samples',
    } : sample.facts[section],
  }));
  const result = await createFormalOperations({ ...sample, model: { ...script, async complete(request) {
    const turn = await script.complete(request);
    const call = turn.calls[0];
    if (call?.name !== 'finish_role' || reason === 'unobserved_memory') return turn;
    const recommendation = reason === 'unsupported_action' ? { code: 'review_restart', evidenceIds: [sha256('missing')] }
      : { code: 'human_review', evidenceIds: [sha256('missing')] };
    const context = request.conversation[0];
    if (reason === 'unsupported_action' && context?.kind === 'user') {
      const { evidenceIndex } = JSON.parse(context.text) as { evidenceIndex: { id: string }[] };
      recommendation.evidenceIds = evidenceIndex.map(item => item.id);
    }
    return decision('finish_role', { hypotheses: [], recommendation });
  } } }).run();
  expect(result).toMatchObject({ status: 'requires_human', reason: 'no_progress', formalOperations: null, usage: { toolCalls: 3 } });
});

it('bounds repeated reads and denies tool arguments carrying other targets', async () => {
  const sample = fixture('en', 'exited');
  const repeated = await createFormalOperations({ ...sample, model: { protocol: 'anthropic', async complete() {
    return choose('container');
  } } }).run();
  expect(repeated).toMatchObject({ status: 'requires_human', reason: 'no_progress', usage: { turns: 4, toolCalls: 1 } });
  expect(sample.read).toHaveBeenCalledOnce();
  const other = fixture('en', 'running');
  const injected = await createFormalOperations({ ...other, model: { protocol: 'anthropic', async complete() {
    return decision('read_operations', { section: 'container', containerId: sha256('unrelated') });
  } } }).run();
  expect(injected).toMatchObject({ status: 'requires_human', reason: 'no_progress', usage: { toolCalls: 0 } });
  expect(other.read).not.toHaveBeenCalled();
});

it('rejects cross-target and mismatched admission proofs before using them as evidence', async () => {
  const sample = fixture('en', 'exited');
  sample.read.mockResolvedValueOnce({ proofSha256: sha256('container'), result: { ...sample.facts.container, serverId: 'another' } });
  const model = scriptedOperations();
  expect(() => createFormalOperations({ ...sample, model, input: { ...sample.input,
    document: { ...sample.input.document, requestSha256: sha256('another request') } } })).toThrow('formal_operations_input_binding');
  const result = await createFormalOperations({ ...sample, model }).run();
  expect(result).toMatchObject({ status: 'requires_human', reason: 'invalid_receipt', formalOperations: null, trace: [], evidence: [] });
});

it('resumes the same reserved observation and revalidates the final report and permission', async () => {
  const sample = fixture('zh-CN', 'exited');
  const script = scriptedOperations();
  const complete = vi.fn(script.complete);
  const agent = () => createFormalOperations({ ...sample, model: { ...script, complete } });
  const decided = await agent().run({ pauseAfter: 'decision' });
  expect(decided).toMatchObject({ status: 'paused', usage: { turns: 1, toolCalls: 0 } });
  const reserved = await agent().run({ pauseAfter: 'reservation' });
  expect(reserved).toMatchObject({ status: 'paused', usage: { turns: 1, toolCalls: 1 } });
  expect(sample.read).not.toHaveBeenCalled();
  const result = await agent().run();
  expect(result).toMatchObject({ status: 'completed', checkpointId: expect.any(String), usage: { turns: 4, toolCalls: 3 } });
  expect(sample.read.mock.calls[0]?.[0]).toMatchObject({ section: 'container', operationId: sha256(result.bindingSha256 + ':1') });
  expect(await agent().run()).toEqual(result);
  expect(complete).toHaveBeenCalledTimes(4);

  const scope = sample.authorize.mock.calls[0]![0];
  const saved = await sample.checkpointer.getTuple({ configurable: { thread_id: `operations:${result.runId}` } });
  const state = saved?.checkpoint.channel_values.state as AgentState;
  expect(restoreState(state, scope.spec, result.bindingSha256, 'formal_operations')?.formalOperations).toEqual(result.formalOperations);
  const tampered = { ...state, formalOperations: { ...state.formalOperations!, previousReleaseOperationId: randomUUID() } };
  expect(restoreState(tampered, scope.spec, result.bindingSha256, 'formal_operations')).toBeUndefined();

  sample.authorize.mockResolvedValue(false);
  expect(await agent().run()).toMatchObject({ reason: 'permission_denied', formalOperations: null, evidence: [], trace: [] });
  expect(sample.read).toHaveBeenCalledTimes(3);
});
