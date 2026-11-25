import { expect, it } from 'vitest';
import { learningCandidateSchema, type CodeRuleValidationBasis, type RuleSampleKind } from '@itervane/contracts';
import { compareRunbookRecovery, digest, evaluateRunbookSamples, normalizeCodeRuleSample, prepareCodeRuleValidation, selectRunbookAction, summarizeCodeRuleSamples } from '../../src/index.js';

const reference = { candidateId: 'aaaaaaa0-aaaa-4aaa-8aaa-aaaaaaaaaaaa', extractionResultSha256: digest('candidate evidence') };
const profile = { version: 1, engine: 'semgrep_ce', engineVersion: '1.170.0', engineInputsSha256: digest('scanner pack'), runnerImageSha256: digest('sealed image') };
const text = { title: 'Review fixed unavailable responses', appliesTo: 'Health handlers', limitation: 'Advisory check for intentional maintenance' };
const code = {
  kind: 'code_rule', key: 'literal-health-error-response',
  check: { engine: 'semgrep_ce', language: 'javascript', pattern: '$RESPONSE.status(503).json(...)', patternNot: 'maintenance.status(503).json(...)' },
  text: { en: text, 'zh-CN': { title: '检查写死的不可用响应', appliesTo: '健康处理器', limitation: '人工确认有意设置的维护返回' } },
  samples: { violation: 'reply.status(503).json({});\r\n', corrected: 'reply.status(200).json({});', lookalike: 'const seenStatus = 503;' },
};
const runbook = learningCandidateSchema.parse({
  kind: 'runbook', key: 'restart-verified-stopped-instance', text: code.text,
  action: 'restart_current_publication', when: { observedStates: ['exited'] },
  controls: { publicationBinding: 'exact', approval: 'portal_and_whiskers', maxNativeAttempts: 1,
    stopOn: ['target_drift', 'unknown_outcome', 'failed_health'] },
  success: { instance: 'same', newerStart: true, healthStatus: 200, access: 'protected' },
  samples: {
    eligible: { observedState: 'exited', publication: 'current', approvals: 'both' },
    healthy: { observedState: 'running', publication: 'current', approvals: 'both' },
    stale: { observedState: 'exited', publication: 'superseded', approvals: 'both' },
    unapproved: { observedState: 'exited', publication: 'current', approvals: 'missing' },
  },
});

function output(basis: CodeRuleValidationBasis, kind: RuleSampleKind, matches = 0) {
  const file = basis.samples.find(sample => sample.name === kind)!.file;
  return {
    version: basis.profile.engineVersion,
    errors: [], paths: { scanned: ['./' + file] },
    results: Array.from({ length: matches }, (_, index) => ({ check_id: basis.ruleKey, path: file,
      start: { line: 1, col: 1 + index }, end: { line: 1, col: 20 + index }, extra: { lines: 'untrusted source report' } })),
  };
}

it('prepares only a single declarative rule and binds the profile, config and ordered sample digests', () => {
  const prepared = prepareCodeRuleValidation(code, reference, profile);
  expect(prepared.basis).toMatchObject({ ...reference, profile, configSha256: digest(prepared.config) });
  expect(prepared.basis.samples.map(sample => sample.file)).toEqual(['violation.js', 'corrected.js', 'lookalike.js']);
  expect(prepared.basis.samples.every((item, index) => item.sha256 === digest(prepared.files[index]!.content))).toBe(true);
  expect(prepared.files[0]?.content).not.toContain('\r');
  expect(prepared.sha256).toBe(digest(JSON.stringify(prepared.basis)));
  expect(JSON.parse(prepared.config)).toEqual({ rules: [{ id: code.key, languages: ['javascript'], message: 'Review this match.', severity: 'WARNING',
    patterns: [{ pattern: code.check.pattern }, { 'pattern-not': code.check.patternNot }] }] });
  expect(() => prepareCodeRuleValidation({ ...code, command: 'unavailable' }, reference, profile)).toThrow();
});

it('requires a positive match and two covered negatives and rejects substituted sample identities', () => {
  const { basis } = prepareCodeRuleValidation(code, reference, profile);
  const checked = basis.samples.map(({ name }) => normalizeCodeRuleSample(basis, name, {
    exitCode: 0, stdout: JSON.stringify(output(basis, name, name === 'violation' ? 1 : 0)),
  }));
  expect(summarizeCodeRuleSamples(basis, checked)).toMatchObject({ status: 'passed',
    samples: [{ status: 'checked', matches: 1 }, { status: 'checked', matches: 0 }, { status: 'checked', matches: 0 }] });
  expect(JSON.stringify(checked)).not.toContain('untrusted source report');
  expect(summarizeCodeRuleSamples(basis, [checked[0], { ...checked[1], matches: 1 }, checked[2]]).status).toBe('failed');
  expect(summarizeCodeRuleSamples(basis, [{ ...checked[0], matches: 0 }, ...checked.slice(1)]).status).toBe('failed');
  expect(() => summarizeCodeRuleSamples(basis, [checked[0], checked[1], checked[1]])).toThrow('rule_validation_sample_binding');
  expect(() => summarizeCodeRuleSamples(basis, [{ ...checked[0], sha256: digest('substituted bytes') }, ...checked.slice(1)]))
    .toThrow('rule_validation_sample_binding');
});

it.each(['version_mismatch', 'incomplete_coverage', 'invalid_match', 'command_failed', 'engine_unavailable', 'timeout', 'invalid_report'] as const)(
  'keeps %s out of successful sample evidence', reason => {
    const { basis } = prepareCodeRuleValidation(code, reference, profile);
    const report = output(basis, 'corrected', 1);
    const run = {
      version_mismatch: { stdout: JSON.stringify({ ...report, version: '2.0.0' }), exitCode: 0 },
      incomplete_coverage: { stdout: JSON.stringify({ ...report, paths: { scanned: [], skipped: ['ignored'] } }), exitCode: 0 },
      invalid_match: { stdout: JSON.stringify({ ...report, results: [{ ...report.results[0], check_id: 'other-rule' }] }), exitCode: 0 },
      command_failed: { stdout: JSON.stringify(report), exitCode: 2 },
      engine_unavailable: { stdout: '', exitCode: null },
      timeout: { stdout: '', exitCode: null, timedOut: true },
      invalid_report: { stdout: 'a'.repeat(65_537), exitCode: 0 },
    }[reason];
    const failed = normalizeCodeRuleSample(basis, 'corrected', run);
    expect(failed).toMatchObject({ name: 'corrected', status: 'unavailable', reason });
    const result = (kind: RuleSampleKind) => normalizeCodeRuleSample(basis, kind, { exitCode: 0,
      stdout: JSON.stringify(output(basis, kind, kind === 'violation' ? 1 : 0)) });
    expect(summarizeCodeRuleSamples(basis, [result('violation'), failed, result('lookalike')]).status).toBe('unavailable');
  });

it('records only an exit code and a bounded category from scanner failure output', () => {
  const { basis } = prepareCodeRuleValidation(code, reference, profile);
  const result = normalizeCodeRuleSample(basis, 'violation', { exitCode: 1, stdout: 'untrusted report',
    stderr: 'ModuleNotFoundError: No module named "untrusted module detail"' });
  expect(result).toMatchObject({ status: 'unavailable', reason: 'command_failed', detail: { exitCode: 1, cause: 'import' } });
  expect(JSON.stringify(result)).not.toContain('untrusted');
});

it('requires Runbook scope, both approvals, attempts and independent protected readback', () => {
  if (runbook.kind !== 'runbook') throw new Error('Invalid Runbook fixture');
  expect(evaluateRunbookSamples(runbook)).toEqual({
    status: 'passed',
    scenarios: { eligible: 'ready_for_guarded_dispatch', healthy: 'observe_only', stale: 'stop_target_drift',
      unapproved: 'await_approval', exhausted: 'stop_attempt_limit', revoked: 'stop_approval' },
    recovery: { verified: 'verified_recovered', replaced: 'stop_target_drift', unknown: 'stop_unknown',
      unhealthy: 'stop_failed_health', anonymous: 'stop_failed_health' },
  });
  const active = { ...runbook.samples.eligible, priorAttempts: 0 };
  expect(selectRunbookAction(runbook, { ...active, observedState: 'dead' })).toBe('observe_only');
  expect(selectRunbookAction(runbook, { ...active, publication: 'unknown' })).toBe('stop_unknown');
  expect(selectRunbookAction(runbook, { ...active, approvals: 'expired' })).toBe('stop_approval');
  expect(selectRunbookAction(runbook, { ...active, priorAttempts: 1 })).toBe('stop_attempt_limit');
  expect(compareRunbookRecovery(runbook, { nativeOutcome: 'acknowledged', sameInstance: true, newerStart: false,
    healthStatus: 200, anonymousStatus: 401 })).toBe('stop_unknown');
});
