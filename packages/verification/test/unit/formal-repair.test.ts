import { randomUUID } from 'node:crypto';
import { createFormalRepair, sha256, type AgentEvidence } from '@itervane/agent';
import {
  formalAuditResultSchema, formalRepairInputSchema, type Locale, type QualifiedRepairObservationResponse, type QualifiedRepairResponse,
} from '@itervane/contracts';
import type { ModelAdapter, ModelTurn } from '@itervane/model';
import { expect, it, vi } from 'vitest';
import { auditFixture, omittedPath } from '../../src/agent/formal-fixture.js';

type RepairOptions = Parameters<typeof createFormalRepair>[0];
type ModelRequest = Parameters<ModelAdapter['complete']>[0];
const appliedText = '{"name":"fixture","version":"1.1.0"}\n';
const manualFixture = 'fixture value omitted from the model';

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
  const { input: fromAudit, inspection, checkpointer, providerSha256, authorize } = auditFixture(locale, Number(template), !template);
  const { taskId, runId, projectId, generation, source, dataClass, catalog } = fromAudit.document;
  const scanner = template ? 'gitleaks' : 'trivy';
  const finding = inspection.snapshot.reports[template ? 0 : 1].findings[0]!;
  const snapshotSha256 = inspection.snapshot.manifestSha256;
  const audit = formalAuditResultSchema.parse({
    version: 1, taskId, runId, projectId, generation, locale, inputSha256: fromAudit.sha256,
    checkpointId: randomUUID(), inspectionSha256: fromAudit.document.inspection.receiptSha256, snapshotSha256, catalogSha256: catalog.sha256,
    status: 'completed', reason: 'audit_complete', provider: 'anthropic', usage: { turns: 3, toolCalls: 2, tokens: 60 }, evidence: [], trace: [],
    checklist: { summary: manualFixture, coverage: 'complete', limits: ['Fixed policy'], evidenceIds: [sha256('scans')], hypotheses: [],
      findings: [{ ...finding, scanner, certainty: template ? 'suspected' : 'confirmed', impact: manualFixture, suggestion: manualFixture }],
    },
  });
  const document = formalRepairInputSchema.parse({
    version: 1, taskId, runId, projectId, generation, source, dataClass, locale, inspection: fromAudit.document.inspection,
    audit: { inputSha256: fromAudit.sha256, checkpointId: audit.checkpointId, resultSha256: sha256(JSON.stringify(audit)) },
    catalogSha256: catalog.sha256, findingIds: [finding.id],
  });
  const input = { document, sha256: sha256(JSON.stringify(document)) };
  const firstLine = 'DEMO_ONLY=synthetic-placeholder\n';
  const original = Buffer.from(template ? firstLine + 'KEEP=on\n' : '{"name":"fixture","version":"1.0.0"}\n');
  const file = { sha256: sha256(original.toString('utf8')), bytes: original.length };
  const range = template ? { startByte: 0, endByte: Buffer.byteLength(firstLine), sha256: sha256(firstLine) } : null;
  const { planSha256: _plan, ...inspectionScope } = inspection.scope;
  const receipt = () => {
    const domainId = randomUUID();
    const operationId = randomUUID();
    const commandSha256 = sha256(operationId);
    const scope = { ...inspectionScope, version: 1 as const, requestId: randomUUID(), operationId,
      repairInputSha256: input.sha256, baseSnapshotSha256: snapshotSha256, commandSha256, commandBytes: 100,
    };
    const { repositoryId, commit } = source;
    return { scope, domainId, imageSha256: inspection.imageSha256, originSha256: inspection.originSha256, commitSha256: inspection.commitSha256,
      cleanupConfirmed: true as const, sessionVerified: true as const,
      snapshot: { runId: domainId, repositoryId, commit, tree: inspection.snapshot.tree, manifestSha256: snapshotSha256,
        files: inspection.snapshot.files, commandSha256, readOnly: true as const, offline: true as const },
    };
  };
  const readTargets = vi.fn<RepairOptions['readTargets']>(async (ids): Promise<QualifiedRepairObservationResponse> => {
    expect(ids).toEqual([finding.id]);
    const base = receipt();
    return { ...base, kind: 'repair_observation', scope: { ...base.scope, operation: 'observe_repair' },
      snapshot: { ...base.snapshot, observation: { version: 1, operationId: base.scope.operationId, repairInputSha256: input.sha256,
        baseSnapshotSha256: snapshotSha256, targets: [{ findingId: finding.id, path: finding.path, line: finding.line, scanner,
          status: 'text', file, range, templates: template ? ['remove-env-entry-v1'] : [],
        }],
      }},
    };
  });
  const apply = vi.fn<RepairOptions['apply']>(async ({ findingIds, patch }): Promise<QualifiedRepairResponse> => {
    expect(findingIds).toEqual([finding.id]);
    expect(patch.files).toEqual([{ path: finding.path, beforeSha256: file.sha256, edits: [{
      startByte: 0, endByte: range?.endByte ?? file.bytes, replacement: template ? '' : appliedText,
    }] }]);
    const edit = patch.files[0]!.edits[0]!;
    const result = Buffer.concat([original.subarray(0, edit.startByte), Buffer.from(edit.replacement), original.subarray(edit.endByte)]);
    const base = receipt();
    return { ...base, kind: 'repair_receipt', scope: { ...base.scope, operation: 'apply_repair' },
      snapshot: { ...base.snapshot, candidate: { version: 1, operationId: base.scope.operationId, repairInputSha256: input.sha256,
        workspaceSha256: sha256('repair workspace'), baseSnapshotSha256: snapshotSha256, patchSha256: sha256(JSON.stringify(patch)),
        candidateManifestSha256: sha256('candidate manifest'), changes: [{ path: finding.path, beforeSha256: file.sha256,
          afterSha256: sha256(result.toString('utf8')), beforeBytes: original.length, afterBytes: result.length, edits: 1 }],
      }},
    };
  });
  const complete = vi.fn<ModelAdapter['complete']>(async request => {
    const { target, candidate } = readEvidence(request);
    if (candidate) return decision('finish_role', { summary: locale === 'zh-CN' ? '已移除疑似凭据行。' : 'Updated the fixture version.', evidenceId: candidate.id });
    if (!target || target.data.kind !== 'repair_targets') return decision('read_repair_targets', { findingIds: [finding.id] });
    const observation = target.data.observation.targets[0]!;
    if (observation.templates.length) return decision('apply_repair_template',
      { observationId: target.id, targetIndex: 0, templateId: observation.templates[0] });
    return decision('apply_repair_patch', { observationId: target.id, targets: [{ targetIndex: 0,
      edits: [{ startByte: 0, endByte: observation.file!.bytes, replacement: appliedText }] }] });
  });
  const model = { protocol: 'anthropic' as const, complete };
  return { input, audit, checkpointer, providerSha256, authorize, readTargets, apply, model, finding, original };
}

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
    afterSha256: sha256(template ? 'KEEP=on\n' : appliedText), beforeSha256: sha256(fixture.original.toString('utf8')),
  }] } });
  const requests = fixture.model.complete.mock.calls.map(([request]) => request);
  for (const request of requests) {
    const context = JSON.stringify(request.conversation);
    expect(context).not.toContain(omittedPath);
    expect(context).not.toContain('synthetic-placeholder');
    expect(context).not.toContain(manualFixture);
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
