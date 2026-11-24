import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../../src/profiles.js';
import { preparePublishedCodeRules } from '../../src/published-code-rules.js';
import { normalizePublishedCodeScan, preparePublishedCodeScan, verifyPublishedCodeScanEvidence } from '../../src/published-code-scan.js';
import { publishedCodeRuleFixture, sealDocument } from '../helpers/published-code-rule.js';

const profile = { version: 1, engine: 'semgrep_ce', engineVersion: '1.170.0',
  engineInputsSha256: sha256('pinned engine'), runnerImageSha256: sha256('current image') } as const;
const file = (path: string) => ({ path, mode: '100644' as const, bytes: 52, sha256: sha256(path) });
const manifest = { source: { repositoryId: randomUUID(), commit: 'a'.repeat(40) }, sha256: sha256('fixed manifest'),
  files: [file('apps/health.mjs'), file('apps/other.cjs'), file('docs/health.md')] };

describe('published rule selection', () => {
  it('requires the exact accepted snapshot and stable package keys', () => {
    const input = publishedCodeRuleFixture(profile, ['javascript', 'typescript']);
    const prepared = preparePublishedCodeRules(input);
    expect(prepared.groups.map(group => group.ruleKeys)).toEqual([['published-health-javascript'], ['published-health-typescript']]);
    expect(prepared.groups[0]!.config).not.toContain('candidate-health-reply');
    expect(prepared.input.rules[0]?.validation.projectId).not.toBe(input.snapshot.document.projectId);
    expect(() => preparePublishedCodeRules({ ...input, rules: input.rules.slice(1) })).toThrow('published_code_rule_snapshot_binding');
    expect(() => preparePublishedCodeRules({ ...input, rules: [...input.rules].reverse() })).toThrow('published_code_rule_version_binding');
    expect(() => preparePublishedCodeRules({ ...input, snapshot: { ...input.snapshot, sha256: sha256('replaced snapshot') } }))
      .toThrow('published_code_rule_snapshot_binding');
  });

  it('rejects a changed candidate, review, and engine inputs', () => {
    const input = publishedCodeRuleFixture(profile);
    const [rule] = input.rules;
    const changed = { ...rule, package: { ...rule!.package, candidate: { ...rule!.package.candidate,
      check: { ...rule!.package.candidate.check, pattern: '$RESPONSE.status(200).json(...)' },
    } } };
    expect(() => preparePublishedCodeRules({ ...input, rules: [changed] })).toThrow('published_code_rule_version_binding');
    expect(() => preparePublishedCodeRules({ ...input, rules: [{ ...rule, review: { ...rule!.review, reviewedBy: randomUUID() } }] }))
      .toThrow('published_code_rule_version_binding');
    expect(() => preparePublishedCodeRules({ ...input, profile: { ...profile, engineInputsSha256: sha256('different wheel') } }))
      .toThrow('published_code_rule_validation_profile');
  });

  it('recomputes the positive and negative sample outcome even when the envelope hashes agree', () => {
    const input = publishedCodeRuleFixture(profile);
    const rule = input.rules[0]!;
    if (rule.validation.evidence.kind !== 'code_rule') throw new Error('Expected code rule fixture');
    const result = rule.validation.evidence.receipt.proof.result;
    const corrected = result.samples[1]!;
    if (corrected.status !== 'checked') throw new Error('Expected checked sample fixture');
    corrected.matches = 1;
    rule.package.validation.sha256 = sealDocument(rule.validation).sha256;
    const entry = input.snapshot.document.entries[0]!;
    entry.versionSha256 = sealDocument(rule.package).sha256;
    rule.review.versionSha256 = entry.versionSha256;
    entry.reviewSha256 = sealDocument(rule.review).sha256;
    input.snapshot = sealDocument(input.snapshot.document);
    expect(() => preparePublishedCodeRules(input)).toThrow('runner_rule_validation_receipt_binding');
  });
});

const match = {
  check_id: 'published-health-javascript', path: 'target-0.js',
  start: { line: 2, col: 4, offset: 11 }, end: { line: 2, col: 21, offset: 28 },
  extra: { lines: 'synthetic source context must not escape' },
};
const rawReport = { version: profile.engineVersion, errors: [], paths: { scanned: ['target-1.js', './target-0.js'] }, results: [match] };
const execution = (raw: unknown) => ({ stdout: Buffer.from(JSON.stringify(raw)), exitCode: 0, timedOut: false, overflow: false });

describe('source scanning evidence', () => {
  it('requires full inventory and returns only configured rule keys and original ranges', () => {
    const rules = preparePublishedCodeRules(publishedCodeRuleFixture(profile, ['javascript', 'typescript']));
    const scan = preparePublishedCodeScan(rules, manifest);
    expect(scan.basis.batches.map(batch => batch.fileCount)).toEqual([2, 0]);
    const js = normalizePublishedCodeScan(scan.groups[0]!, profile.engineVersion, execution(rawReport));
    const ts = normalizePublishedCodeScan(scan.groups[1]!, profile.engineVersion, execution(rawReport));
    expect(js).toMatchObject({ status: 'checked', findings: [{ ruleKey: match.check_id, path: 'apps/health.mjs', start: match.start, end: match.end }] });
    expect(ts).toEqual({ status: 'not_applicable', language: 'typescript' });
    const evidence = sealDocument({ basis: scan.basis, reports: [js, ts] });
    expect(verifyPublishedCodeScanEvidence(scan, evidence)).toEqual(evidence);
    expect(JSON.stringify(evidence)).not.toContain(match.extra.lines);
    expect(() => verifyPublishedCodeScanEvidence(preparePublishedCodeScan(rules, { ...manifest, sha256: sha256('new manifest') }), evidence))
      .toThrow('published_code_scan_evidence_binding');
    expect(() => verifyPublishedCodeScanEvidence(scan, { ...evidence, sha256: sha256('wrong evidence digest') }))
      .toThrow('published_code_scan_evidence_binding');
    expect(() => verifyPublishedCodeScanEvidence(scan, sealDocument({ ...evidence.document,
      reports: [{ language: 'javascript', status: 'not_applicable' }, ts] }))).toThrow('published_code_scan_coverage_binding');
  });

  it('reports missing files, duplicate coverage, invalid locations and invalid engine bytes as unavailable', () => {
    const scan = preparePublishedCodeScan(preparePublishedCodeRules(publishedCodeRuleFixture(profile)), manifest);
    const normalize = (raw: unknown) => normalizePublishedCodeScan(scan.groups[0]!, profile.engineVersion, execution(raw));
    for (const scanned of [['target-0.js'], ['target-0.js', './target-0.js'], ['target-0.js', 'unknown.js']]) {
      expect(normalize({ ...rawReport, paths: { scanned } })).toMatchObject({ status: 'unavailable', reason: 'incomplete_coverage' });
    }
    expect(normalize({ ...rawReport, version: '0.1.0' })).toMatchObject({ reason: 'version_mismatch' });
    expect(normalize({ ...rawReport, results: [match, match] })).toMatchObject({ reason: 'invalid_match' });
    expect(normalize({ ...rawReport, results: [{ ...match, check_id: 'unknown' }] })).toMatchObject({ reason: 'invalid_match' });
    expect(normalize({ ...rawReport, results: [{ ...match, end: { ...match.end, offset: 53 } }] })).toMatchObject({ reason: 'invalid_match' });
    const invalid = { ...execution(rawReport), stdout: Buffer.from([255]) };
    expect(normalizePublishedCodeScan(scan.groups[0]!, profile.engineVersion, invalid)).toMatchObject({ reason: 'invalid_report' });
    expect(normalizePublishedCodeScan(scan.groups[0]!, profile.engineVersion, { ...invalid, timedOut: true })).toMatchObject({ reason: 'timeout' });
  });
});
