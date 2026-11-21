import { randomUUID } from 'node:crypto';
import { createFormalRepair, sha256, type AgentEvidence } from '@itervane/agent';
import type { Locale } from '@itervane/contracts';
import type { ModelAdapter, ModelTurn } from '@itervane/model';
import { expect, it, vi } from 'vitest';
import { omittedPath } from '../../src/agent/formal-fixture.js';
import { fixtureAuditNarrative, syntheticNpmRepairFixture, syntheticRepairFixture, updatedFixtureManifest } from '../../src/agent/repair-fixture.js';

type ModelRequest = Parameters<ModelAdapter['complete']>[0];

function decision(name: string, input: unknown): ModelTurn {
  return { text: '', calls: [{ id: 'call', name, input }], tokenUsage: 20 };
}

function readEvidence(request: ModelRequest) {
  const context = request.conversation[0];
  if (context?.kind !== 'user') throw new Error('Expected repair context');
  const { observations } = JSON.parse(context.text) as { observations: AgentEvidence[] };
  return {
    target: observations.find(item => item.data.kind === 'repair_targets'),
    candidate: observations.find(item => item.data.kind === 'repair_candidate'),
  };
}

function repairFixture(locale: Locale, template: boolean) {
  const fixture = syntheticRepairFixture(locale, template);
  const { finding } = fixture;
  const readTargets = vi.fn(fixture.readTargets);
  const apply = vi.fn(fixture.apply);
  const complete = vi.fn<ModelAdapter['complete']>(async request => {
    const { target, candidate } = readEvidence(request);
    if (candidate) return decision('finish_role', { summary: locale === 'zh-CN' ? '已移除疑似凭据行。' : 'Updated the fixture version.', evidenceId: candidate.id });
    if (!target || target.data.kind !== 'repair_targets') return decision('read_repair_targets', { findingIds: [finding.id] });
    const observation = target.data.observation.targets[0]!;
    if (observation.templates.length) return decision('apply_repair_template',
      { observationId: target.id, targetIndex: 0, templateId: observation.templates[0] });
    return decision('apply_repair_patch', { observationId: target.id, targets: [{ targetIndex: 0,
      edits: [{ startByte: 0, endByte: observation.file!.bytes, replacement: updatedFixtureManifest }] }] });
  });
  const model = { protocol: 'anthropic' as const, complete };
  return { ...fixture, readTargets, apply, model };
}

it('applies both npm files from one observation and rejects partial and substituted edits before calling the host', async () => {
  const fixture = syntheticNpmRepairFixture('en');
  const apply = vi.fn(fixture.apply);
  let attempts = 0;
  const complete: ModelAdapter['complete'] = async request => {
    const { target, candidate } = readEvidence(request);
    if (candidate) return decision('finish_role', { summary: 'Prepared the approved upgrade.', evidenceId: candidate.id });
    if (!target || target.data.kind !== 'repair_targets') return decision('read_repair_targets', { findingIds: [fixture.finding.id] });
    const targets = target.data.observation.targets.map((_, targetIndex) => ({ targetIndex }));
    const edit = target.data.observation.targets[0]!.npm!.edits[0]!;
    const altered = [{ targetIndex: 0, edits: [{ ...edit, replacement: '"9.0.0"' }] }, targets[1]!];
    attempts++;
    return decision('apply_repair_patch', { observationId: target.id, targets: attempts === 1 ? targets.slice(1) : attempts === 2 ? altered : targets });
  };
  const report = await createFormalRepair({ ...fixture, model: { protocol: 'anthropic', complete }, apply }).run();
  expect(report).toMatchObject({ reason: 'repair_complete', status: 'completed' });
  expect(report.evidence.filter(entry => entry.data.kind === 'repair_failure')).toHaveLength(2);
  expect(apply).toHaveBeenCalledTimes(1);
  const applied = report.evidence.find(entry => entry.data.kind === 'repair_candidate')?.data;
  expect(applied?.kind === 'repair_candidate' && applied.candidate.changes.map(({ path, afterSha256 }) => ({ path, afterSha256 })))
    .toEqual(fixture.files.map(file => ({ path: file.path, afterSha256: sha256(file.expected) })));
});

it('offers human review when no approved npm version is present in the observation', async () => {
  const fixture = syntheticNpmRepairFixture('zh-CN', false);
  const apply = vi.fn(fixture.apply);
  const complete: ModelAdapter['complete'] = async request => {
    if (!readEvidence(request).target) return decision('read_repair_targets', { findingIds: [fixture.finding.id] });
    expect(request.tools.map(tool => tool.name)).toEqual(['request_human']);
    return decision('request_human', {});
  };
  const report = await createFormalRepair({ ...fixture, model: { protocol: 'anthropic', complete }, apply }).run();
  expect(report).toMatchObject({ reason: 'manual_review', status: 'requires_human' });
  expect(apply).not.toHaveBeenCalled();
});

it.each([
  ['zh-CN', true, 'apply_repair_template'], ['en', false, 'apply_repair_patch'],
] as const)('uses the actual observation to select a repair in %s', async (locale, template, tool) => {
  const fixture = repairFixture(locale, template);
  const report = await createFormalRepair(fixture).run();
  expect(report).toMatchObject({ status: 'completed', reason: 'repair_complete', origin: 'formal_repair', role: 'repair',
    releaseEligible: false, checkpointId: expect.any(String), formalRepair: { evidenceId: report.evidence.at(-1)?.id },
    usage: { turns: 3, toolCalls: 2 },
  });
  expect(report.trace.map(item => item.tool)).toEqual(['read_repair_targets', tool]);
  const candidate = report.evidence.at(-1)?.data;
  expect(candidate).toMatchObject({ kind: 'repair_candidate', candidate: { changes: [{
    afterSha256: sha256(fixture.expectedText), beforeSha256: sha256(fixture.original.toString('utf8')),
  }] } });
  const requests = fixture.model.complete.mock.calls.map(([request]) => request);
  for (const request of requests) {
    const context = JSON.stringify(request.conversation);
    expect(context).not.toContain(omittedPath);
    expect(context).not.toContain('synthetic-placeholder');
    expect(context).not.toContain(fixtureAuditNarrative);
    expect(request.tools.map(item => item.name)).not.toContain('draft_repair');
  }
  expect(requests[0]!.tools.map(item => item.name)).toEqual(['read_repair_targets', 'request_human']);
  expect(requests[2]!.tools.map(item => item.name)).toEqual(['finish_role', 'request_human']);
  expect(await fixture.checkpointer.getTuple({ configurable: { thread_id: `repair:${report.runId}` } })).toBeDefined();
  expect(await fixture.checkpointer.getTuple({ configurable: { thread_id: `audit:${report.runId}` } })).toBeUndefined();
  expect(await createFormalRepair(fixture).run()).toEqual(report);
  expect(fixture.apply).toHaveBeenCalledTimes(1);
});

it('rejects a changed audit before any repair tool or model can run', () => {
  const fixture = repairFixture('en', true);
  fixture.audit.checklist!.findings[0]!.path = 'out-of-scope';
  expect(() => createFormalRepair(fixture)).toThrow('formal_repair_audit_binding');
  expect(fixture.model.complete).not.toHaveBeenCalled();
  expect(fixture.readTargets).not.toHaveBeenCalled();
});

it('asks for a different proposal after an out-of-range edit and a fabricated finish citation', async () => {
  const fixture = repairFixture('en', true);
  const original = fixture.model.complete.getMockImplementation()!;
  fixture.model.complete.mockImplementationOnce(async () => decision('finish_role', { summary: 'Already fixed', evidenceId: sha256('invented') }))
    .mockImplementationOnce(original).mockImplementationOnce(async request => {
      const { target } = readEvidence(request);
      return decision('apply_repair_patch', { observationId: target!.id, targets: [{ targetIndex: 0,
        edits: [{ startByte: 0, endByte: fixture.original.length, replacement: '' }] }] });
    });
  const report = await createFormalRepair(fixture).run();
  expect(report.reason).toBe('repair_complete');
  expect(report.evidence.map(item => item.data.kind)).toEqual(['repair_targets', 'repair_failure', 'repair_candidate']);
  expect(report.evidence[1]?.data).toMatchObject({ code: 'invalid_proposal' });
  expect(fixture.apply).toHaveBeenCalledTimes(1);
});

it('stops for reconciliation when the repair host cannot confirm cleanup', async () => {
  const fixture = repairFixture('en', true);
  fixture.apply.mockResolvedValueOnce({ kind: 'rejected', requestId: randomUUID(), domainId: null, cleanup: 'unknown', code: 'cleanup_unproven' });
  const report = await createFormalRepair(fixture).run();
  expect(report).toMatchObject({ reason: 'repair_reconciling', status: 'requires_human', formalRepair: null, usage: { turns: 2, toolCalls: 2 } });
  expect(await createFormalRepair(fixture).run()).toEqual(report);
  expect(fixture.apply).toHaveBeenCalledTimes(1);
});

it('denies use of a repaired candidate if the authorization changes during the tool call', async () => {
  const fixture = repairFixture('en', false);
  let allowed = true;
  const apply = fixture.apply.getMockImplementation()!;
  fixture.apply.mockImplementationOnce(async (proposal, signal) => {
    const receipt = await apply(proposal, signal);
    allowed = false;
    return receipt;
  });
  const report = await createFormalRepair({ ...fixture, authorize: async () => allowed }).run();
  expect(report).toMatchObject({ reason: 'permission_denied', status: 'requires_human', evidence: [], formalRepair: null });
  expect(fixture.model.complete).toHaveBeenCalledTimes(2);
});

it('rejects a well-formed receipt for a different patch', async () => {
  const fixture = repairFixture('en', false);
  const apply = fixture.apply.getMockImplementation()!;
  fixture.apply.mockImplementationOnce(async (proposal, signal) => {
    const receipt = await apply(proposal, signal);
    if (receipt.kind === 'repair_receipt') receipt.snapshot.candidate.patchSha256 = sha256('different proposal');
    return receipt;
  });
  const report = await createFormalRepair(fixture).run();
  expect(report).toMatchObject({ reason: 'interrupted_action', status: 'requires_human', formalRepair: null });
  expect(report.evidence.map(item => item.data.kind)).toEqual(['repair_targets']);
  expect(fixture.model.complete).toHaveBeenCalledTimes(2);
});

it('waits for the repair transport to settle after cancellation', async () => {
  const fixture = repairFixture('en', true);
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  fixture.apply.mockImplementationOnce(async (_proposal, signal) => {
    entered.resolve();
    await cleanup.promise;
    expect(signal.aborted).toBe(true);
    return { kind: 'rejected', requestId: randomUUID(), domainId: randomUUID(), cleanup: 'confirmed', code: 'lease_lost' };
  });
  let settled = false;
  const running = createFormalRepair(fixture).run({ signal: controller.signal }).finally(() => { settled = true; });
  try {
    await entered.promise;
    controller.abort();
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
  } finally { cleanup.resolve(); }
  expect(await running).toMatchObject({ reason: 'cancelled', status: 'cancelled', formalRepair: null });
});

it('restores a reserved patch with the same call key and tool budget', async () => {
  const fixture = repairFixture('en', false);
  expect((await createFormalRepair(fixture).run({ pauseAfter: 'decision' })).status).toBe('paused');
  expect((await createFormalRepair(fixture).run({ pauseAfter: 'decision' })).usage).toMatchObject({ turns: 2, toolCalls: 1 });
  const reserved = await createFormalRepair(fixture).run({ pauseAfter: 'reservation' });
  expect(reserved).toMatchObject({ status: 'paused', usage: { turns: 2, toolCalls: 2 } });
  expect(fixture.apply).not.toHaveBeenCalled();
  const report = await createFormalRepair(fixture).run();
  expect(report).toMatchObject({ reason: 'repair_complete', usage: { turns: 3, toolCalls: 2 } });
  expect(fixture.apply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ callKeySha256: sha256(`${reserved.bindingSha256}:2`) }), expect.any(AbortSignal));
});
