import { randomUUID } from 'node:crypto';
import { MemorySaver } from '@langchain/langgraph';
import { createFormalRuleExtraction, learningCandidateSemanticSha256, sha256, type AgentEvidence } from '@itervane/agent';
import { learningCandidateSchema, learningCaseDocumentSchema, learningKnowledgeSchema, type LearningCaseFacts, type Locale } from '@itervane/contracts';
import type { ModelAdapter } from '@itervane/model';
import { expect, it, vi } from 'vitest';
import { restoreState, type AgentState } from '../../../agent/src/state.js';

const text = { en: { title: 'Follow-up health response', appliesTo: 'Standard applications', limitation: 'Review intentional maintenance branches.' },
  'zh-CN': { title: '健康续测响应', appliesTo: '标准应用', limitation: '核对有意设置的维护分支。' } };
const codeRule = learningCandidateSchema.parse({ kind: 'code_rule', key: 'fixed-unhealthy-response', text,
  check: { engine: 'semgrep_ce', language: 'javascript', pattern: '$RESPONSE.writeHead(503, ...)' },
  samples: { violation: 'reply.writeHead(503, {});', corrected: 'reply.writeHead(200, {});', lookalike: 'log.write(503);' },
});
const runbook = learningCandidateSchema.parse({ kind: 'runbook', key: 'recover-stopped-release', text,
  action: 'restart_current_publication', when: { observedStates: ['dead', 'exited'] },
  controls: { publicationBinding: 'exact', approval: 'portal_and_whiskers', maxNativeAttempts: 1,
    stopOn: ['target_drift', 'unknown_outcome', 'failed_health'] },
  success: { instance: 'same', newerStart: true, healthStatus: 200, access: 'protected' },
  samples: { eligible: { observedState: 'exited', publication: 'current', approvals: 'both' },
    healthy: { observedState: 'running', publication: 'current', approvals: 'both' },
    stale: { observedState: 'exited', publication: 'superseded', approvals: 'both' },
    unapproved: { observedState: 'exited', publication: 'current', approvals: 'missing' } },
});

function fixture(kind: 'code' | 'ops', locale: Locale, existing?: { key: string; matching: boolean }) {
  const projectId = randomUUID();
  const facts: LearningCaseFacts = kind === 'ops' ? {
    category: 'recovered_stopped_instance', diagnosisSha256: sha256('verified diagnosis'), proposalSha256: sha256('approved proposal'),
    releaseOperationId: randomUUID(), executionId: randomUUID(), actionTaskId: randomUUID(), diagnosisState: 'exited',
    restartAttempt: 1, result: 'verified_recovered', sameInstance: true, healthStatus: 200, anonymousStatus: 401,
  } : {
    category: 'reproduced_health_failure', originalSnapshotSha256: sha256('original source'), repairedSnapshotSha256: sha256('fixed source'),
    patchSha256: sha256('repair patch'), verificationReceiptSha256: sha256('second VM'), reproductionSha256: sha256('first VM'),
    sourceComparison: { introduced: 0, resolved: 0, remaining: 0 }, originalHealthStatus: 503, repairedHealthStatus: 200,
  };
  const document = learningCaseDocumentSchema.parse({ version: 1, projectId, taskId: randomUUID(), runId: randomUUID(),
    generation: 1, dataClass: 'public', facts, evidenceSha256: sha256('settled evidence'), recordedAt: new Date().toISOString() });
  const record = { caseId: randomUUID(), sha256: sha256(JSON.stringify(document)), document };
  const candidate = kind === 'code' ? codeRule : runbook;
  const knowledge = learningKnowledgeSchema.parse({
    category: facts.category,
    cases: [{ caseId: randomUUID(), sha256: sha256('another case') }],
    candidates: existing ? [{ id: randomUUID(), kind: candidate.kind, key: existing.key,
      semanticSha256: existing.matching ? learningCandidateSemanticSha256(candidate) : sha256('other scope') }] : [],
  });
  return {
    caseRecord: record, knowledge, knowledgeSha256: sha256(JSON.stringify(knowledge)), candidate,
    coordinates: { taskId: randomUUID(), runId: randomUUID(), generation: 1, projectId, locale,
      source: { repositoryId: randomUUID(), commit: 'a'.repeat(40) } },
    checkpointer: new MemorySaver(), providerSha256: sha256('stable provider'),
    authorize: vi.fn<Parameters<typeof createFormalRuleExtraction>[0]['authorize']>(async () => true),
  };
}

const decision = (name: string, input: unknown) => ({ text: '', calls: [{ id: 'decision', name, input }], tokenUsage: 24 });
function modelFor(finish: (evidence: AgentEvidence[]) => object, readOrder: 'case_first' | 'index_first' = 'case_first') {
  return { protocol: 'anthropic' as const, complete: vi.fn<ModelAdapter['complete']>(async request => {
    const context = request.conversation[0];
    if (context?.kind !== 'user') throw new Error('Missing extraction context');
    const { observations } = JSON.parse(context.text) as { observations: AgentEvidence[] };
    const caseRead = observations.some(item => item.data.kind === 'learning_case');
    const indexRead = observations.some(item => item.data.kind === 'learning_knowledge');
    if (!caseRead && (readOrder === 'case_first' || indexRead)) return decision('read_learning_case', {});
    if (!indexRead) return decision('search_learning_knowledge', {});
    return decision('finish_role', { evidenceIds: observations.map(item => item.id), rationale: 'Verified outcomes support a bounded proposal.', ...finish(observations) });
  }) };
}

it.each([['code', 'en', 'case_first'], ['ops', 'zh-CN', 'index_first']] as const)(
  'proposes a %s candidate in %s after two observations', async (kind, locale, order) => {
    const sample = fixture(kind, locale);
    const model = modelFor(() => ({ outcome: 'candidate', candidate: sample.candidate }), order);
    const result = await createFormalRuleExtraction({ ...sample, model }).run();
    expect(result).toMatchObject({ status: 'completed', origin: 'formal_rule_extraction', role: 'rule-extraction',
      reason: 'rule_extraction_complete', checkpointId: expect.any(String), releaseEligible: false, usage: { turns: 3, toolCalls: 2 },
      formalRuleExtraction: { caseId: sample.caseRecord.caseId, caseSha256: sample.caseRecord.sha256, knowledgeSha256: sample.knowledgeSha256,
        result: { outcome: 'candidate', candidate: sample.candidate } } });
    const calls = model.complete.mock.calls;
    expect(calls[0]?.[0].tools.map(tool => tool.name)).toEqual(['read_learning_case', 'search_learning_knowledge', 'request_human']);
    expect(calls[2]?.[0].tools.map(tool => tool.name)).toEqual(['finish_role', 'request_human']);
    for (const [request] of calls) expect(JSON.stringify(request.conversation)).not.toContain(sample.coordinates.source.repositoryId);
  });

it('allows the model to retain the case or cite a known duplicate while rejecting renamed equivalent checks', async () => {
  const retained = fixture('code', 'en');
  expect(await createFormalRuleExtraction({ ...retained, model: modelFor(() => ({ outcome: 'retain_case', reason: 'insufficient_generalization' })) }).run())
    .toMatchObject({ status: 'completed', formalRuleExtraction: { result: { outcome: 'retain_case' } } });
  const duplicate = fixture('code', 'en', { key: 'differently-named-check', matching: true });
  const existingCandidateId = duplicate.knowledge.candidates[0]!.id;
  expect(await createFormalRuleExtraction({ ...duplicate, model: modelFor(() => ({ outcome: 'duplicate', existingCandidateId })) }).run())
    .toMatchObject({ status: 'completed', formalRuleExtraction: { result: { outcome: 'duplicate', existingCandidateId } } });
  const renamed = fixture('code', 'en', { key: 'differently-named-check', matching: true });
  expect(await createFormalRuleExtraction({ ...renamed, model: modelFor(() => ({ outcome: 'candidate', candidate: renamed.candidate })) }).run())
    .toMatchObject({ status: 'requires_human', reason: 'no_progress', formalRuleExtraction: null });
});

it.each(['forged evidence', 'wrong candidate kind', 'unknown duplicate', 'unapproved native effect'] as const)(
  'rejects %s without producing a candidate', async mode => {
    const sample = fixture('ops', 'en');
    const choices = {
      'forged evidence': { outcome: 'candidate', candidate: runbook, evidenceIds: [sha256('first'), sha256('forged')] },
      'wrong candidate kind': { outcome: 'candidate', candidate: codeRule },
      'unknown duplicate': { outcome: 'duplicate', existingCandidateId: randomUUID() },
      'unapproved native effect': { outcome: 'candidate', candidate: { ...runbook, action: 'arbitrary_action' } },
    };
    const result = await createFormalRuleExtraction({ ...sample, model: modelFor(() => choices[mode]) }).run();
    expect(result).toMatchObject({ status: 'requires_human', reason: 'no_progress', formalRuleExtraction: null,
      usage: { turns: 5, toolCalls: 2 } });
  });

it('refuses foreign cases and bounds provider calls without expanding the observation budget', async () => {
  const sample = fixture('code', 'en');
  const model = { protocol: 'anthropic' as const, async complete() { return decision('read_learning_case', {}); } };
  expect(() => createFormalRuleExtraction({ ...sample, coordinates: { ...sample.coordinates, projectId: randomUUID() }, model }))
    .toThrow('rule_extraction_input_binding');
  expect(() => createFormalRuleExtraction({ ...sample, knowledgeSha256: sha256('wrong index'), model }))
    .toThrow('rule_extraction_input_binding');
  expect(await createFormalRuleExtraction({ ...sample, model }).run()).toMatchObject({
    status: 'requires_human', reason: 'no_progress', usage: { turns: 4, toolCalls: 1 }, formalRuleExtraction: null,
  });
});

it('resumes a reserved observation once and rechecks authorization and the published conclusion', async () => {
  const sample = fixture('ops', 'zh-CN');
  const model = modelFor(() => ({ outcome: 'candidate', candidate: runbook }));
  const agent = () => createFormalRuleExtraction({ ...sample, model });
  expect(await agent().run({ pauseAfter: 'decision' })).toMatchObject({ status: 'paused', usage: { turns: 1, toolCalls: 0 } });
  expect(await agent().run({ pauseAfter: 'reservation' })).toMatchObject({ status: 'paused', usage: { turns: 1, toolCalls: 1 } });
  const result = await agent().run();
  expect(result).toMatchObject({ status: 'completed', usage: { turns: 3, toolCalls: 2 } });
  expect(await agent().run()).toEqual(result);
  expect(model.complete).toHaveBeenCalledTimes(3);
  const checkpoint = await sample.checkpointer.getTuple({ configurable: { thread_id: `rule-extraction:${result.runId}` } });
  const state = checkpoint?.checkpoint.channel_values.state as AgentState;
  const spec = sample.authorize.mock.calls[0]![0].spec;
  expect(restoreState(state, spec, result.bindingSha256, 'formal_rule_extraction')?.formalRuleExtraction).toEqual(result.formalRuleExtraction);
  const forged = { ...state, formalRuleExtraction: { ...state.formalRuleExtraction!, caseId: randomUUID() } };
  expect(restoreState(forged, spec, result.bindingSha256, 'formal_rule_extraction')).toBeUndefined();
  sample.authorize.mockResolvedValue(false);
  expect(await agent().run()).toMatchObject({ reason: 'permission_denied', formalRuleExtraction: null, evidence: [], trace: [] });
});
