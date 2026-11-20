import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Schema } from '@itervane/contracts';
import { z } from 'zod';
import { exerciseGuestRepair } from './guest-repair-fixture.js';
import { readBoundedFile, readGuestSnapshot } from './guest-snapshot.js';
import { scannerCommands, scannerProfiles, sha256 } from './profiles.js';
import { normalizeScan, type ScanSummary } from './scans.js';

export const INSPECTION_TOOLS = '/usr/local/libexec/itervane-inspection';
export const INSPECTION_SOURCE = '/var/lib/itervane-inspection-source';
export const INSPECTION_OUTPUT = '/var/lib/itervane-inspection-output';
export const MAX_DATABASE_BYTES = 2560 * 1024 * 1024;
const reportBytes = 4 * 1024 * 1024;
const controls = 'fixtures/runner/inspection-input';
const expectedCve = 'CVE-2021-23337';
const assetLimit = 180 * 1024 * 1024;
export const inspectionFailures = [
  'snapshot-rejected', 'scan-boundary', 'scan-inputs', 'scan-gitleaks',
  'scan-trivy', 'scan-controls', 'scan-integrity',
] as const;
type Scanner = ScanSummary['scanner'];

const inputsSchema = z.strictObject({
  nodeSha256: sha256Schema, workerSha256: sha256Schema, gitleaksSha256: sha256Schema, trivySha256: sha256Schema,
  databaseSha256: sha256Schema, databaseMetadataSha256: sha256Schema, databaseUpdatedAt: z.iso.datetime(),
});
export type InspectionInputs = z.infer<typeof inputsSchema>;

export async function fileDigest(path: string, maxBytes: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size <= 0 || info.size > maxBytes) throw new Error('scan-inputs');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of file.createReadStream({ end: info.size, autoClose: false })) {
      bytes += chunk.length;
      hash.update(chunk);
    }
    if (bytes !== info.size) throw new Error('scan-inputs');
    return hash.digest('hex');
  } finally { await file.close(); }
}

export function databaseUpdatedAt(metadata: Uint8Array) {
  return z.iso.datetime().parse(JSON.parse(Buffer.from(metadata).toString('utf8')).UpdatedAt);
}

async function verifyInputs(tools: string) {
  const inputsBytes = readBoundedFile(join(tools, 'inputs.json'), 2048);
  const inputs = inputsSchema.parse(JSON.parse(inputsBytes.toString('utf8')));
  const files = [
    ['node', inputs.nodeSha256, assetLimit], ['worker.mjs', inputs.workerSha256, reportBytes],
    ['gitleaks', inputs.gitleaksSha256, assetLimit], ['trivy', inputs.trivySha256, assetLimit],
    ['cache/db/trivy.db', inputs.databaseSha256, MAX_DATABASE_BYTES],
  ] as const;
  for (const [file, expected, maximum] of files) {
    if (await fileDigest(join(tools, file), maximum) !== expected) throw new Error('scan-inputs');
  }
  const metadata = readBoundedFile(join(tools, 'cache/db/metadata.json'), 4096);
  if (sha256(metadata) !== inputs.databaseMetadataSha256 || databaseUpdatedAt(metadata) !== inputs.databaseUpdatedAt
      || Date.now() - Date.parse(inputs.databaseUpdatedAt) > 72 * 3600_000
      || Date.parse(inputs.databaseUpdatedAt) > Date.now() + 300_000) throw new Error('scan-inputs');
  for (const profile of scannerProfiles) {
    const name = profile.scanner === 'trivy' ? 'trivy.yaml' : 'gitleaks.toml';
    if (sha256(readBoundedFile(join(tools, 'policy', name), 4096)) !== profile.policySha256) throw new Error('scan-inputs');
  }
  if (readBoundedFile(join(tools, 'policy', 'empty.ignore'), 0).length) throw new Error('scan-inputs');
  return { inputs, inputsSha256: sha256(inputsBytes) };
}

function invoke(scanner: Scanner, tools: string, ready: string, output: string, cache?: string) {
  const sourceRoot = join(ready, scanner === 'trivy' ? 'npm' : 'worktree');
  const policy = join(tools, 'policy');
  const args = scannerCommands[scanner].map(arg => arg.replace('/worktree', sourceRoot)
    .replace('/policy', policy).replace('/output', output));
  if (cache) args.push('--cache-dir', cache, '--cache-backend', 'memory', '--no-progress');
  const result = spawnSync(join(tools, scanner), args, {
    cwd: output, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: output, GOMAXPROCS: '2' },
    maxBuffer: 256 * 1024, timeout: 25_000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: result.status, timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT', sourceRoot };
}

function readScanReport(output: string, scanner: Scanner) {
  try { return readBoundedFile(join(output, scanner + '.json'), reportBytes).toString('utf8'); }
  catch { return ''; }
}

function fixtureControls(gitleaks: ScanSummary, trivy: ScanSummary) {
  const secret = (variant: string) => gitleaks.findings.some(finding => finding.path === `${controls}/${variant}/config.txt`);
  const vulnerability = (variant: string) => trivy.findings.some(finding => finding.ruleId === expectedCve
    && finding.path === `${controls}/${variant}/package-lock.json`);
  if (!secret('original') || secret('updated') || !vulnerability('original') || vulnerability('updated')) throw new Error('scan-controls');
}

function summarize(scan: ScanSummary) {
  return { version: scan.version, policySha256: scan.policySha256,
    findings: scan.findings.length, resultSha256: sha256(JSON.stringify(scan)) };
}

/** Runs from the sealed scan service after its kernel boundary checks. */
export async function inspectGuestSnapshot(ready: string, tools: string) {
  const { runId, mode, manifest } = readGuestSnapshot(ready);
  if (mode === 'repair') throw new Error('scan-boundary');
  const { inputs, inputsSha256 } = await verifyInputs(tools);
  const output = mkdtempSync(join(tmpdir(), 'itervane-raw-scan-'));
  try {
    const gitleaksResult = invoke('gitleaks', tools, ready, output);
    const gitleaks = normalizeScan('gitleaks', { manifest, exitCode: gitleaksResult.code, sourceRoot: gitleaksResult.sourceRoot,
      timedOut: gitleaksResult.timedOut, report: readScanReport(output, 'gitleaks') });
    if (mode === 'fixture') {
      if (gitleaks.status !== 'completed') throw new Error('scan-gitleaks');
      const missing = join(output, 'missing-cache');
      mkdirSync(missing);
      const rejected = invoke('trivy', tools, ready, output, missing);
      if (rejected.code !== 1 || rejected.timedOut) throw new Error('scan-trivy');
    }

    const trivyResult = invoke('trivy', tools, ready, output, join(tools, 'cache'));
    const trivy = normalizeScan('trivy', { manifest, exitCode: trivyResult.code, sourceRoot: trivyResult.sourceRoot,
      timedOut: trivyResult.timedOut, report: readScanReport(output, 'trivy'),
      database: { sha256: inputs.databaseSha256, updatedAt: inputs.databaseUpdatedAt } });
    const checked = readGuestSnapshot(ready);
    if (await fileDigest(join(tools, 'cache/db/trivy.db'), MAX_DATABASE_BYTES) !== inputs.databaseSha256
        || checked.runId !== runId || checked.mode !== mode || checked.manifest.sha256 !== manifest.sha256) throw new Error('scan-integrity');
    const proof = {
      runId, commit: manifest.source.commit, tree: manifest.tree, manifestSha256: manifest.sha256,
      files: manifest.files.length, totalBytes: manifest.totalBytes, inputsSha256, readOnly: true, offline: true,
    };
    if (mode === 'qualified') return { ...proof, repositoryId: manifest.source.repositoryId, reports: [gitleaks, trivy] };
    if (trivy.status !== 'completed') throw new Error('scan-trivy');
    fixtureControls(gitleaks, trivy);
    let repair: ReturnType<typeof exerciseGuestRepair>;
    try { repair = exerciseGuestRepair(ready, output, manifest); }
    catch { throw new Error('scan-integrity'); }
    return {
      ...proof, controlsChecked: true, missingDatabaseRejected: true, repair,
      gitleaks: summarize(gitleaks),
      trivy: { ...summarize(trivy), databaseSha256: inputs.databaseSha256, databaseUpdatedAt: inputs.databaseUpdatedAt },
    };
  } finally { rmSync(output, { recursive: true, force: true }); }
}
