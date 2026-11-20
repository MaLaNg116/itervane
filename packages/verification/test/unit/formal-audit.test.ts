import { randomUUID } from 'node:crypto';
import { createFormalAudit, sha256, type AgentEvidence } from '@itervane/agent';
import { formalAuditInputSchema, qualifiedInspectionResponseSchema, type Locale, type QualifiedInspectionReceipt } from '@itervane/contracts';
import type { ModelAdapter } from '@itervane/model';
import { catalogSnapshot } from '@itervane/rules';
import { MemorySaver } from '@langchain/langgraph';
import { expect, it, vi } from 'vitest';

const omittedPath = 'fixture-source-path-excluded-from-model.json';
const policySha256 = sha256('approved-policy');
const providerSha256 = sha256('approved-provider');

function auditFixture(locale: Locale, secretMatches: number, dependencyMatch = true) {
  const scope = {
    version: 1, requestId: randomUUID(), taskId: randomUUID(), runId: randomUUID(),
    projectId: randomUUID(), repositoryId: randomUUID(), commit: '0'.repeat(40), generation: 1,
    fence: 1, planSha256: policySha256, workspaceSha256: sha256('workspace'),
  };
  const snapshotSha256 = sha256('source-manifest');
  const scans: QualifiedInspectionReceipt['snapshot']['reports'] = [
    { scanner: 'gitleaks', version: '8.30.1', policySha256, snapshotSha256, status: 'completed', reason: null, database: null,
      findings: Array.from({ length: secretMatches }, (_, index) => ({
        id: sha256(`pattern-${index}`), ruleId: 'fixture-pattern', path: omittedPath, line: index + 1, severity: 'unknown',
      })) },
    { scanner: 'trivy', version: '0.70.0', policySha256, snapshotSha256, status: 'completed', reason: null,
      database: { sha256: sha256('advisory-db'), updatedAt: '2026-11-20T04:00:00Z' },
      findings: dependencyMatch ? [{ id: sha256('dependency'), ruleId: 'TEST-Advisory.1', path: omittedPath, line: null, severity: 'high' }] : [] },
  ];
  const inspection = qualifiedInspectionResponseSchema.parse({
    kind: 'receipt', scope, domainId: randomUUID(), imageSha256: sha256('guest'),
    originSha256: sha256('origin'), commitSha256: sha256(scope.commit), cleanupConfirmed: true, sessionVerified: true,
    snapshot: { runId: scope.runId, repositoryId: scope.repositoryId, commit: scope.commit, tree: '1'.repeat(40),
      manifestSha256: snapshotSha256, files: 4, totalBytes: 2_000, inputsSha256: sha256('guest-inputs'),
      readOnly: true, offline: true, reports: scans },
  });
  if (inspection.kind !== 'receipt') throw new Error('Expected receipt fixture');
  const document = formalAuditInputSchema.parse({
    version: 1, taskId: scope.taskId, runId: scope.runId, projectId: scope.projectId, generation: scope.generation,
    dataClass: 'synthetic', source: { repositoryId: scope.repositoryId, commit: scope.commit },
    purposeSha256: sha256('fixture purpose'), locale, catalog: catalogSnapshot(),
    inspection: { requestId: scope.requestId, receiptSha256: sha256(JSON.stringify(inspection)), snapshotSha256, planSha256: scope.planSha256 },
  });
  return { inspection, input: { document, sha256: sha256(JSON.stringify(document)) }, providerSha256,
    checkpointer: new MemorySaver(), authorize: async () => true };
}

function decision(name: string, input: unknown) {
  return { text: '', calls: [{ id: 'call', name, input }], tokenUsage: 20 };
}

const investigate: ModelAdapter['complete'] = async ({ conversation, tools }) => {
  const context = conversation[0];
  if (context?.kind !== 'user') throw new Error('Expected user context');
  const { observations } = JSON.parse(context.text) as { observations: AgentEvidence[] };
  const scans = observations.flatMap(({ id, data }) => data.kind === 'scan' ? [{ ...data, id }] : []);
  const secrets = scans.find(scan => scan.scanner === 'gitleaks');
  if (!secrets) return decision('read_scan', { scanner: 'gitleaks' });
  if (secrets.findings.length && tools.some(tool => tool.name === 'read_rule')
    && !observations.some(item => item.data.kind === 'rule')) return decision('read_rule', { ruleId: 'bounded-review-context' });
  if (scans.length < 2) return decision('read_scan', { scanner: 'trivy' });
  return decision('finish_role', {
    summary: 'Evidence review checklist', evidenceIds: observations.map(item => item.id),
    explanations: scans.flatMap(scan => scan.findings.map(finding => ({ findingId: finding.id,
      impact: 'Review the pattern or advisory with the owner.', suggestion: 'Confirm the scope and address the affected dependency or value.' }))),
  });
};

it.each([
  { locale: 'zh-CN', secretMatches: 1, expected: ['read_scan', 'read_rule', 'read_scan'] },
  { locale: 'en', secretMatches: 0, expected: ['read_scan', 'read_scan'] },
] as const)('follows protected scanner observations to a scoped checklist in $locale', async ({ locale, secretMatches, expected }) => {
  const fixture = auditFixture(locale, secretMatches);
  const complete = vi.fn(investigate);
  const result = await createFormalAudit({ ...fixture, model: { protocol: 'anthropic', complete } }).run();
  expect(result).toMatchObject({ status: 'completed', reason: 'audit_complete', origin: 'formal_audit', role: 'audit', releaseEligible: false });
  expect(result.trace.map(event => event.tool)).toEqual(expected);
  expect(result.audit).toMatchObject({ coverage: 'complete' });
  expect(result.audit?.findings).toContainEqual(expect.objectContaining({
    id: sha256('dependency'), ruleId: 'TEST-Advisory.1', severity: 'high', certainty: 'confirmed',
  }));
  if (secretMatches) expect(result.audit?.findings).toContainEqual(expect.objectContaining({ id: sha256('pattern-0'), certainty: 'suspected' }));
  expect(result.message).toMatch(locale === 'zh-CN' ? /审计清单/ : /audit checklist/);
  expect(result.repairs).toEqual([]);
  for (const [request] of complete.mock.calls) {
    expect(JSON.stringify(request.conversation)).not.toContain(omittedPath);
    expect(JSON.stringify(request.conversation)).not.toContain(fixture.input.document.source.repositoryId);
    expect(request.tools.map(tool => tool.name)).not.toContain('draft_repair');
    expect(request.tools.map(tool => tool.name)).not.toContain('read_context');
  }
  expect(await fixture.checkpointer.getTuple({ configurable: { thread_id: `audit:${result.runId}` } })).toBeDefined();
  expect(await fixture.checkpointer.getTuple({ configurable: { thread_id: `fixture-agent:${result.runId}` } })).toBeUndefined();
});

it('rejects findings outside the pinned receipt before a model call', () => {
  const fixture = auditFixture('en', 1);
  const complete = vi.fn(investigate);
  fixture.inspection.snapshot.reports[0].findings[0]!.ruleId = 'modified-pattern';
  expect(() => createFormalAudit({ ...fixture, model: { protocol: 'anthropic', complete } })).toThrow('formal_audit_receipt_binding');
  expect(complete).not.toHaveBeenCalled();
});

it('stops when a model repeatedly proposes repair or a rule outside the pinned catalog', async () => {
  const fixture = auditFixture('en', 0);
  const complete = vi.fn<ModelAdapter['complete']>()
    .mockResolvedValueOnce(decision('draft_repair', { templateIds: ['unknown'] }))
    .mockResolvedValue(decision('read_rule', { ruleId: 'unknown' }));
  const result = await createFormalAudit({ ...fixture, model: { protocol: 'anthropic', complete } }).run();
  expect(result).toMatchObject({ status: 'requires_human', reason: 'no_progress', audit: null, usage: { turns: 3, toolCalls: 0 } });
});

it('requires both scans and their real references before finishing', async () => {
  const fixture = auditFixture('en', 0, false);
  const complete = vi.fn<ModelAdapter['complete']>()
    .mockResolvedValueOnce(decision('read_scan', { scanner: 'gitleaks' }))
    .mockResolvedValue(decision('finish_role', { summary: 'Clean', evidenceIds: [sha256('invented')], explanations: [] }));
  const result = await createFormalAudit({ ...fixture, model: { protocol: 'anthropic', complete } }).run();
  expect(result).toMatchObject({ status: 'requires_human', reason: 'no_progress', audit: null, usage: { toolCalls: 1 } });
});

it('preserves the scanner count and requests review when the bounded projection omits findings', async () => {
  const fixture = auditFixture('en', 9);
  const result = await createFormalAudit({ ...fixture, model: { protocol: 'anthropic', complete: investigate } }).run();
  expect(result).toMatchObject({ reason: 'audit_incomplete', status: 'requires_human', audit: { coverage: 'partial' } });
  const scan = result.evidence.find(({ data }) => data.kind === 'scan' && data.scanner === 'gitleaks')?.data;
  expect(scan).toMatchObject({ totalFindings: 9 });
  expect(scan?.kind === 'scan' && scan.findings).toHaveLength(8);
});

it('retains observations after a provider error and rejects a different provider binding on restore', async () => {
  const fixture = auditFixture('en', 1);
  const complete = vi.fn<ModelAdapter['complete']>()
    .mockResolvedValueOnce(decision('read_scan', { scanner: 'gitleaks' }))
    .mockRejectedValue(new Error('provider unavailable'));
  const model = { protocol: 'anthropic', complete } as const;
  const result = await createFormalAudit({ ...fixture, model }).run();
  expect(result).toMatchObject({ reason: 'provider_error', usage: { turns: 2, toolCalls: 1, tokens: 20 } });
  expect(result.evidence).toHaveLength(1);
  expect(await createFormalAudit({ ...fixture, model }).run()).toEqual(result);
  expect(await createFormalAudit({ ...fixture, model, providerSha256: sha256('different-model') }).run())
    .toMatchObject({ reason: 'incompatible_checkpoint', evidence: [] });
  expect(complete).toHaveBeenCalledTimes(2);
});

it('halts at the token budget before dispatching a proposed tool', async () => {
  const fixture = auditFixture('en', 0);
  const complete = vi.fn<ModelAdapter['complete']>().mockResolvedValue({
    ...decision('read_scan', { scanner: 'gitleaks' }), tokenUsage: 20_000,
  });
  const result = await createFormalAudit({ ...fixture, model: { protocol: 'anthropic', complete } }).run();
  expect(result).toMatchObject({ reason: 'token_budget', usage: { toolCalls: 0, tokens: 20_000 }, evidence: [] });
});

it.each(['revoked', 'cancelled'] as const)('discards a model result after the run is %s', async stop => {
  const fixture = auditFixture('en', 0);
  const controller = new AbortController();
  let allowed = true;
  const complete = vi.fn<ModelAdapter['complete']>().mockImplementation(async () => {
    if (stop === 'cancelled') controller.abort();
    else allowed = false;
    return decision('read_scan', { scanner: 'gitleaks' });
  });
  const result = await createFormalAudit({ ...fixture, authorize: async () => allowed, model: { protocol: 'anthropic', complete } })
    .run({ signal: controller.signal });
  expect(result).toMatchObject({ reason: stop === 'revoked' ? 'permission_denied' : 'cancelled', evidence: [], usage: { toolCalls: 0 } });
  expect(complete).toHaveBeenCalledTimes(1);
});

it('requests reconciliation when the reserved model turn has no published result', async () => {
  const fixture = auditFixture('en', 0);
  const complete = vi.fn(investigate);
  const model = { protocol: 'anthropic', complete } as const;
  const paused = await createFormalAudit({ ...fixture, model }).run({ pauseAfter: 'reservation' });
  expect(paused).toMatchObject({ reason: 'checkpoint_paused', usage: { turns: 1, toolCalls: 0 } });
  const result = await createFormalAudit({ ...fixture, model }).run();
  expect(result).toMatchObject({ reason: 'interrupted_action', usage: { turns: 1, toolCalls: 0 } });
  expect(complete).not.toHaveBeenCalled();
});
