import { expect, it } from 'vitest';
import { sha256 } from '../../src/profiles.js';
import { scanFindingId } from '../../src/scan-finding-id.js';
import type { ScanSummary } from '../../src/scans.js';
import { compareVerificationScans } from '../../src/verification-scan-comparison.js';

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
