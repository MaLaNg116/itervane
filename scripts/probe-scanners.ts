import { randomBytes, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { normalizeScan, scannerCommands, gitleaksConfig, trivyConfig, type ScanSummary } from '@itervane/runner';
import type { Check } from '@itervane/contracts';
import { sourceFingerprint } from '../packages/verification/src/report.js';
import { trustedGitFixture } from '../packages/runner/test/helpers/trusted-git.js';
import { scannerTools } from './scanner-tools.js';

// No caller-provided source path, URL, shell, environment or scanner executable is accepted.
if (process.argv.length !== 2) throw new Error('trusted_fixture_probe_accepts_no_arguments');
const checks: Check[] = []; const fixtures: Awaited<ReturnType<typeof trustedGitFixture>>[] = [];
const evidence: { source: { repositoryId: string; commit: string }; tree: string; manifestSha256: string; scans: ScanSummary[] }[] = [];
const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
const invoke = (binary: string, args: string[], cwd: string, timeout = 180_000) => new Promise<{ code: number | null; timedOut: boolean; diagnostic: string }>(done => {
  execFile(binary, args, { cwd, env, timeout, killSignal: 'SIGKILL', maxBuffer: 4194304 }, (error, _stdout, stderr) => {
    const diagnostic = /unknown flag/i.test(stderr) ? 'unsupported_flag' : /x509|certificate/i.test(stderr) ? 'tls_error'
      : /unauthorized|denied|401|403/i.test(stderr) ? 'registry_access' : /timeout|no such host|connection/i.test(stderr) ? 'registry_network' : 'scanner_failure';
    done({ code: error ? typeof error.code === 'number' ? error.code : null : 0, timedOut: Boolean(error?.killed), diagnostic });
  });
});
async function fileHash(path: string) { const hash = createHash('sha256'); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest('hex'); }
const add = (id: string, passed: boolean, detail: string) => checks.push({ id, status: passed ? 'passed' : 'failed', detail });
try {
  const tools = await scannerTools();
  let databaseReady = false;
  for (const dirty of [true, false]) {
    const canary = dirty ? `api_key = "${randomBytes(32).toString('hex')}" # gitleaks:allow\n` : 'api_key = process.env.EXAMPLE_KEY\n';
    const version = dirty ? '4.17.20' : '4.17.21';
    const lock = { name: 'trusted-scanner-fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {
      '': { name: 'trusted-scanner-fixture', version: '1.0.0', dependencies: { lodash: version } },
      'node_modules/lodash': { version, resolved: `https://registry.npmjs.org/lodash/-/lodash-${version}.tgz` },
    } };
    const fixture = await trustedGitFixture('sha1', { 'config.txt': Buffer.from(canary), 'package-lock.json': Buffer.from(JSON.stringify(lock)),
      '.gitleaks.toml': Buffer.from('title="Project cannot disable protected scanning"\n'), '.gitleaksignore': Buffer.from('*\n'), '.trivyignore': Buffer.from('CVE-2021-23337\n') });
    fixtures.push(fixture);
    const entry = { source: fixture.source, tree: fixture.tree, manifestSha256: fixture.manifest.sha256, scans: [] as ScanSummary[] }; evidence.push(entry);
    const source = resolve(fixture.root, 'scan-source'); const policy = resolve(fixture.root, 'policy'); const output = resolve(fixture.root, 'output');
    for (const directory of [source, policy, output]) await mkdir(directory);
    for (const file of fixture.files) await writeFile(resolve(source, file.path), file.content);
    await writeFile(resolve(policy, 'gitleaks.toml'), gitleaksConfig); await writeFile(resolve(policy, 'trivy.yaml'), trivyConfig); await writeFile(resolve(policy, 'empty.ignore'), '');
    const args = (name: keyof typeof scannerCommands) => [...scannerCommands[name]].map(value => value.replace('/worktree', source).replace('/policy', policy).replace('/output', output));
    const result = await invoke(tools.gitleaks, args('gitleaks'), fixture.root);
    const summary = normalizeScan('gitleaks', { manifest: fixture.manifest, sourceRoot: source, exitCode: result.code, timedOut: result.timedOut,
      report: await readFile(resolve(output, 'gitleaks.json'), 'utf8').catch(() => '') });
    entry.scans.push(summary);
    add(dirty ? 'gitleaks-positive' : 'gitleaks-fixed', summary.status === 'completed' && (dirty ? summary.findings.length > 0 : summary.findings.length === 0),
      'Pinned real CLI inspected generated files; project ignore/config and inline allow comments cannot disable the protected profile. No raw report is published.');
    const cache = resolve(fixtures[0]!.root, 'trivy-cache');
    if (dirty) {
      const missing = await invoke(tools.trivy, [...args('trivy'), '--cache-dir', cache], fixture.root);
      add('trivy-missing-database', missing.code === 1 && !missing.timedOut, 'An offline scan without a database failed instead of reporting zero vulnerabilities.');
      const prepared = await invoke(tools.trivy, ['image', '--download-db-only', '--db-repository', 'ghcr.io/aquasecurity/trivy-db:2', '--cache-dir', cache, '--no-progress'], fixture.root);
      databaseReady = prepared.code === 0;
      if (!databaseReady) checks.push({ id: 'trivy-database', status: 'blocked', detail: `Official vulnerability database could not be prepared (${prepared.diagnostic}); dependency scanning was not accepted.` });
    }
    if (!databaseReady) continue;
    const databasePath = resolve(cache, 'db/trivy.db'); const databaseSha = await fileHash(databasePath);
    const metadata = JSON.parse(await readFile(resolve(cache, 'db/metadata.json'), 'utf8')) as { UpdatedAt: string };
    const scanned = await invoke(tools.trivy, [...args('trivy'), '--cache-dir', cache], fixture.root);
    const normalized = normalizeScan('trivy', { manifest: fixture.manifest, sourceRoot: source, exitCode: scanned.code, timedOut: scanned.timedOut,
      report: await readFile(resolve(output, 'trivy.json'), 'utf8').catch(() => ''), database: { sha256: databaseSha, updatedAt: metadata.UpdatedAt } });
    entry.scans.push(normalized);
    const knownIssue = normalized.findings.some(finding => finding.ruleId === 'CVE-2021-23337');
    add(dirty ? 'trivy-positive' : 'trivy-fixed-cve', normalized.status === 'completed' && (dirty ? knownIssue : !knownIssue) && await fileHash(databasePath) === databaseSha,
      'Real pinned Trivy scanned a generated npm lockfile offline, bound to a fresh database hash. Fix checks the specified CVE, not a global safety claim.');
  }
} catch { checks.push({ id: 'scanner-execution', status: 'failed', detail: 'Trusted scanner verification did not complete; raw process output, paths and input bytes are omitted.' }); }
finally { await Promise.all(fixtures.map(fixture => fixture.close())); }
const status = checks.some(check => check.status === 'failed') ? 'failed' : checks.some(check => check.status === 'blocked') ? 'blocked' : 'passed';
const report = { status, scope: 'maintainer-generated-fixtures-only', runtimeQualified: false, checkedAt: new Date().toISOString(), sourceFingerprint: await sourceFingerprint(), checks, evidence };
await mkdir('.reports/p1-d', { recursive: true }); await writeFile('.reports/p1-d/scanners.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ ...report, evidence: evidence.map(entry => ({ ...entry, scans: entry.scans.map(scan => ({ ...scan, findings: { count: scan.findings.length } })) })) }, null, 2));
process.exitCode = status === 'passed' ? 0 : status === 'blocked' ? 2 : 1;
