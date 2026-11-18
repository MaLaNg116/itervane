import { afterAll, beforeAll, expect, it } from 'vitest';
import { normalizeScan } from '../../src/scans.js';
import { trustedGitFixture } from '../helpers/trusted-git.js';

let fixture: Awaited<ReturnType<typeof trustedGitFixture>>;
beforeAll(async () => { fixture = await trustedGitFixture('sha1', { 'package-lock.json': Buffer.from('{}\n') }); });
afterAll(async () => { await fixture?.close(); });
const database = { sha256: 'd'.repeat(64), updatedAt: '2026-01-01T00:00:00Z' }; const now = Date.parse(database.updatedAt);
const gitleaks = (extra = {}) => JSON.stringify([{ RuleID: 'generic-api-key', File: '/worktree/package-lock.json', StartLine: 1, ...extra }]);
const trivy = (extra = {}) => JSON.stringify({ SchemaVersion: 2, Results: [{ Target: 'package-lock.json', Class: 'lang-pkgs', Type: 'npm', Packages: [{ Name: 'example' }],
  Vulnerabilities: [{ VulnerabilityID: 'CVE-2021-23337', Severity: 'HIGH', ...extra }] }] });

it('rebuilds findings from allowed fields and binds them to the verified source rather than copying raw secrets', () => {
  const summary = normalizeScan('gitleaks', { manifest: fixture.manifest, exitCode: 10,
    report: gitleaks({ Secret: 'never-echo-this', Match: 'never-echo-this', Description: 'never-echo-this', Author: 'never-echo-this' }) });
  expect(summary.status).toBe('completed'); expect(summary.findings).toHaveLength(1);
  expect(summary.snapshotSha256).toBe(fixture.manifest.sha256); expect(JSON.stringify(summary)).not.toContain('never-echo-this');
  expect(summary.findings[0]).toMatchObject({ ruleId: 'generic-api-key', path: 'package-lock.json', line: 1 });
});

it('does not turn process failures, timeouts, malformed JSON or inconsistent exit codes into a clean scan', () => {
  for (const input of [{ exitCode: 1, report: '[]' }, { exitCode: null, report: '[]', timedOut: true }, { exitCode: 0, report: '{' },
    { exitCode: 0, report: gitleaks() }, { exitCode: 10, report: '[]' }, { exitCode: 10, report: gitleaks({ File: '../outside' }) }]) {
    const result = normalizeScan('gitleaks', { manifest: fixture.manifest, ...input }); expect(result.status).toBe('failed'); expect(result.findings).toEqual([]);
  }
});

it('requires fresh database provenance and a supported dependency inventory even for a syntactically valid report', () => {
  const input = { manifest: fixture.manifest, report: trivy(), exitCode: 10, now };
  expect(normalizeScan('trivy', input).status).toBe('unavailable');
  expect(normalizeScan('trivy', { ...input, database, now: now + 73 * 3600_000 }).status).toBe('unavailable');
  expect(normalizeScan('trivy', { ...input, database, now: now - 3600_000 }).status).toBe('unavailable');
  expect(normalizeScan('trivy', { ...input, database, exitCode: 0, report: JSON.stringify({ SchemaVersion: 2, Results: [] }) })).toMatchObject({ status: 'unsupported', reason: 'missing_inventory' });
});

it('keeps database identity, known vulnerability IDs and severity while removing package text and source snippets', () => {
  const result = normalizeScan('trivy', { manifest: fixture.manifest, report: trivy({ Title: 'never-echo-this', PkgName: 'never-echo-this', Code: 'never-echo-this' }), exitCode: 10, database, now });
  expect(result).toMatchObject({ status: 'completed', database, findings: [{ ruleId: 'CVE-2021-23337', severity: 'high' }] });
  expect(JSON.stringify(result)).not.toContain('never-echo-this');
});

it('recognizes zero findings only for a completed supported scan and rejects out-of-snapshot locations', () => {
  expect(normalizeScan('gitleaks', { manifest: fixture.manifest, report: '[]', exitCode: 0 })).toMatchObject({ status: 'completed', findings: [] });
  const wrong = JSON.parse(trivy()) as { Results: { Target: string }[] }; wrong.Results[0]!.Target = '/etc/passwd';
  expect(normalizeScan('trivy', { manifest: fixture.manifest, report: JSON.stringify(wrong), exitCode: 10, database, now }).status).toBe('failed');
});
