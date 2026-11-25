import type { PublishedCodeScanBasis, PublishedCodeScanReport } from '@itervane/contracts';
import { expect, it } from 'vitest';
import { sha256 } from '../../src/profiles.js';
import { scanFindingId } from '../../src/scan-finding-id.js';
import type { ScanSummary } from '../../src/scans.js';
import { compareVerificationScans } from '../../src/verification-scan-comparison.js';
import { sealDocument } from '../helpers/published-code-rule.js';

function snapshot(name: string) {
  const manifestSha256 = sha256(name);
  const reports = (['gitleaks', 'trivy'] as const).map((scanner): ScanSummary => ({
    scanner, version: '1.0.0', policySha256: sha256(scanner), snapshotSha256: manifestSha256,
    status: 'completed', reason: null, findings: [],
    database: scanner === 'trivy' ? { sha256: sha256('advisory database'), updatedAt: '2026-01-01T00:00:00Z' } : null,
  })) as [ScanSummary, ScanSummary];
  return { manifestSha256, reports };
}

function secret(report: ScanSummary, path: string, line: number) {
  const finding = { ruleId: 'test-pattern', path, line, severity: 'high' as const };
  const id = scanFindingId(report.scanner, report.snapshotSha256, finding);
  report.findings.push({ ...finding, id });
  return id;
}

function dependency(report: ScanSummary, installedVersion: string) {
  const finding = { ruleId: 'GHSA-abcd-efgh-ijkl', path: 'package-lock.json', line: null, severity: 'high' as const,
    npm: { name: 'demo-package', installedVersion, fixedVersions: ['2.0.0'] },
  };
  const id = scanFindingId(report.scanner, report.snapshotSha256, finding);
  report.findings.push({ ...finding, id });
  return id;
}

it('counts a moved line as remaining and tracks an independently removed and added group', () => {
  const before = snapshot('original');
  const after = snapshot('candidate');
  const oldId = secret(before.reports[0], 'config.txt', 3);
  const newId = secret(after.reports[0], 'config.txt', 4);
  secret(before.reports[0], 'old-config.txt', 1);
  secret(after.reports[0], 'new-config.txt', 8);

  expect(compareVerificationScans(before, after)).toMatchObject({
    status: 'compared', totals: { introduced: 1, resolved: 1, remaining: 1 },
    groups: expect.arrayContaining([{ scanner: 'gitleaks', ruleId: 'test-pattern', path: 'config.txt',
      dependency: null, beforeIds: [oldId], afterIds: [newId],
    }]),
  });
});

it('preserves a fresh match on the upgraded package even when the advisory identifier is unchanged', () => {
  const before = snapshot('original');
  const after = snapshot('candidate');
  const oldId = dependency(before.reports[1], '1.0.0');
  const newId = dependency(after.reports[1], '1.1.0');

  expect(compareVerificationScans(before, after)).toMatchObject({
    status: 'compared', totals: { introduced: 1, resolved: 1, remaining: 0 },
    groups: [
      { dependency: { name: 'demo-package', installedVersion: '1.0.0' }, beforeIds: [oldId], afterIds: [] },
      { dependency: { name: 'demo-package', installedVersion: '1.1.0' }, beforeIds: [], afterIds: [newId] },
    ],
  });
});

it('requires complete and comparable protected evidence for both snapshots', () => {
  const before = snapshot('original');
  const after = snapshot('candidate');
  const trivy = after.reports[1];
  trivy.status = 'unavailable';
  expect(compareVerificationScans(before, after)).toEqual({ status: 'unavailable', reason: 'incomplete_coverage', scanner: 'trivy' });
  trivy.status = 'completed';
  trivy.database = { ...trivy.database!, sha256: sha256('different database') };
  expect(compareVerificationScans(before, after)).toEqual({ status: 'unavailable', reason: 'profile_mismatch', scanner: 'trivy' });
  trivy.database = null;
  expect(compareVerificationScans(before, after)).toEqual({ status: 'unavailable', reason: 'report_binding', scanner: 'trivy' });
  after.reports[0].snapshotSha256 = before.manifestSha256;
  expect(compareVerificationScans(before, after)).toEqual({ status: 'unavailable', reason: 'report_binding', scanner: 'gitleaks' });
});

function codeScan(manifestSha256: string, report: PublishedCodeScanReport, overrides: Partial<PublishedCodeScanBasis> = {}) {
  const basis: PublishedCodeScanBasis = {
    version: 1, taskId: '64c7f4a1-226e-44da-b431-de27b5f4e678', projectId: '7e11b368-1611-4025-8f9e-69cbcdfc324b',
    source: { repositoryId: '3fb92eb0-e368-4570-ad74-dd52e8de1753', commit: 'a'.repeat(40) },
    manifestSha256, snapshotSha256: sha256('rule snapshot'), ruleSetSha256: sha256('rule command'),
    profile: { version: 1, engine: 'semgrep_ce', engineVersion: '1.170.0', runnerImageSha256: sha256('image'),
      engineInputsSha256: sha256('fixed engine inputs') },
    batches: [{ language: 'javascript', configSha256: sha256('rule config'), targetsSha256: sha256(manifestSha256), fileCount: 3 }],
    ...overrides,
  };
  return sealDocument({ basis, reports: [report] });
}

const checked = (paths: readonly string[], digest = 'scan'): PublishedCodeScanReport => ({
  language: 'javascript', status: 'checked', reportSha256: sha256(digest),
  findings: paths.map(path => ({ ruleKey: 'published-health-javascript', path,
    start: { line: 1, col: 1, offset: 0 }, end: { line: 1, col: 2, offset: 1 } })),
});

it('includes changed, remaining and resolved findings from the pinned rules in the same verdict', () => {
  const before = snapshot('original with issues');
  const after = snapshot('candidate');
  secret(before.reports[0], 'config.txt', 1);
  const left = codeScan(before.manifestSha256, checked(['a.mjs', 'b.mjs']));
  const right = codeScan(after.manifestSha256, checked(['b.mjs', 'c.mjs']), {
    profile: { ...left.document.basis.profile, runnerImageSha256: sha256('rebuilt image') }, ruleSetSha256: sha256('new image command'),
  });
  expect(compareVerificationScans(before, after, { before: left, after: right })).toMatchObject({
    status: 'compared', totals: { introduced: 1, resolved: 2, remaining: 1 },
    groups: expect.arrayContaining([{ scanner: 'semgrep_ce', ruleId: 'published-health-javascript', path: 'b.mjs',
      dependency: null, beforeIds: [expect.any(String)], afterIds: [expect.any(String)] }]),
  });
});

it('blocks a missing or incomplete rule receipt and a changed configuration', () => {
  const before = snapshot('audited source');
  const after = snapshot('built candidate');
  const left = codeScan(before.manifestSha256, checked([]));
  const failed = codeScan(after.manifestSha256, { language: 'javascript', status: 'unavailable', reason: 'timeout' });
  const right = codeScan(after.manifestSha256, checked([]), {
    batches: [{ ...left.document.basis.batches[0]!, configSha256: sha256('different config') }],
  });
  expect(compareVerificationScans(before, after, { before: left, after: undefined }))
    .toEqual({ status: 'unavailable', reason: 'report_binding', scanner: 'semgrep_ce' });
  expect(compareVerificationScans(before, after, { before: left, after: failed }))
    .toEqual({ status: 'unavailable', reason: 'incomplete_coverage', scanner: 'semgrep_ce' });
  expect(compareVerificationScans(before, after, { before: left, after: right }))
    .toEqual({ status: 'unavailable', reason: 'profile_mismatch', scanner: 'semgrep_ce' });
});

it('requires agreeing matches on the same immutable original even if raw evidence differs', () => {
  const original = snapshot('unchanged');
  const left = codeScan(original.manifestSha256, checked(['a.mjs'], 'audit invocation'));
  const right = codeScan(original.manifestSha256, checked(['a.mjs'], 'independent invocation'));
  expect(compareVerificationScans(original, original, { before: left, after: right })).toMatchObject({
    status: 'compared', totals: { introduced: 0, resolved: 0, remaining: 1 },
  });
  const disagree = codeScan(original.manifestSha256, checked([]));
  expect(compareVerificationScans(original, original, { before: left, after: disagree }))
    .toEqual({ status: 'unavailable', reason: 'report_binding', scanner: 'semgrep_ce' });
});
