import { createFormalVerification, sha256 } from '@itervane/agent';
import { expect, it, vi } from 'vitest';
import { scriptedVerification, verificationDecision, verificationFixture } from '../../src/agent/verification-fixture.js';

it.each([
  { locale: 'en', regression: false, sections: ['baseline', 'image', 'source', 'build'], outcome: 'observed' },
  { locale: 'zh-CN', regression: true, sections: ['baseline', 'source', 'build'], outcome: 'checks_failed' },
] as const)('takes the verification path supported by the observed baseline in $locale', async ({ locale, regression, sections, outcome }) => {
  const fixture = verificationFixture(locale, regression);
  const model = scriptedVerification(locale);
  const complete = vi.fn(model.complete);
  const result = await createFormalVerification({ ...fixture, model: { ...model, complete } }).run();
  expect(result).toMatchObject({
    origin: 'formal_verification', role: 'verify', status: 'completed', reason: 'verification_review_complete', releaseEligible: false,
    formalVerification: { outcome, unverified: regression ? ['image'] : [], receiptSha256: fixture.evidence.binding.receiptSha256 },
  });
  expect(result.evidence.map(item => item.data.kind === 'verification_section' && item.data.section)).toEqual(sections);
  expect(result.formalVerification?.followUps).toHaveLength(regression ? 1 : 0);
  expect(result.message).toMatch(locale === 'zh-CN' ? /复验意见/ : /verification review/);
  expect(complete.mock.calls[0]?.[0].tools.map(tool => tool.name)).toEqual(['read_verification', 'request_human']);
  for (const [request] of complete.mock.calls) {
    expect(request.tools.every(tool => ['read_verification', 'finish_role', 'request_human'].includes(tool.name))).toBe(true);
    expect(JSON.stringify(request.conversation)).not.toContain(fixture.input.document.source.repositoryId);
  }
  expect(await fixture.checkpointer.getTuple({ configurable: { thread_id: `verify:${result.runId}` } })).toBeDefined();
});

it('fails before calling the model when the candidate coordinates do not match', () => {
  const fixture = verificationFixture('en');
  const model = scriptedVerification('en');
  const complete = vi.fn(model.complete);
  fixture.evidence.binding.generation++;
  expect(() => createFormalVerification({ ...fixture, model: { ...model, complete } })).toThrow('formal_verification_evidence_binding');
  expect(complete).not.toHaveBeenCalled();
});

it.each([
  ['apply_repair_patch', {}],
  ['read_verification', { section: 'image' }],
  ['finish_role', { summary: 'Unproven conclusion', evidenceIds: [sha256('a'), sha256('b'), sha256('c')], followUps: [] }],
] as const)('stops unsupported model calls to %s before observing evidence', async (name, args) => {
  const result = await createFormalVerification({
    ...verificationFixture('en'), model: { protocol: 'anthropic', async complete() { return verificationDecision(name, args); } },
  }).run();
  expect(result).toMatchObject({ status: 'requires_human', reason: 'no_progress', usage: { turns: 3, toolCalls: 0 },
    formalVerification: null, trace: [], evidence: [], releaseEligible: false });
});

it('requires actual evidence to support the follow-up advice', async () => {
  const fixture = verificationFixture('zh-CN', true);
  const script = scriptedVerification('zh-CN');
  const result = await createFormalVerification({ ...fixture, model: { ...script, async complete(request) {
    const turn = await script.complete(request);
    const call = turn.calls[0];
    if (call?.name !== 'finish_role') return turn;
    return verificationDecision('finish_role', { ...(call.input as object),
      followUps: [{ evidenceId: sha256('absent item'), detail: '缺少证据的建议' }] });
  } } }).run();
  expect(result).toMatchObject({ status: 'requires_human', reason: 'no_progress', usage: { toolCalls: 3 }, formalVerification: null });
});

it.each([
  ['en', 'Shorten the verification summary'],
  ['zh-CN', '请把复验摘要缩短'],
] as const)('explains how to correct an oversized completion without rereading evidence in %s', async (locale, feedback) => {
  const script = scriptedVerification(locale);
  let completions = 0;
  const result = await createFormalVerification({ ...verificationFixture(locale), model: { ...script, async complete(request) {
    const turn = await script.complete(request);
    const call = turn.calls[0];
    if (call?.name !== 'finish_role') return turn;
    if (++completions === 1) return verificationDecision('finish_role', { ...(call.input as object), summary: 'a'.repeat(481) });
    expect(JSON.stringify(request.conversation)).toContain(feedback);
    return turn;
  } } }).run();
  expect(completions).toBe(2);
  expect(result).toMatchObject({ status: 'completed', formalVerification: { outcome: 'observed' }, usage: { toolCalls: 4 } });
});
