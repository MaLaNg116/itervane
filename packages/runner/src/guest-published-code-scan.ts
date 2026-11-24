import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishedCodeScanReportByteLimit, type PublishedCodeScanReport } from '@itervane/contracts';
import { invokeGuestSemgrep, verifySemgrepEngine } from './guest-rule-validation.js';
import { sha256, sourceLimits } from './profiles.js';
import type { PreparedPublishedCodeRules } from './published-code-rules.js';
import {
  normalizePublishedCodeScan, preparePublishedCodeScan, verifyPublishedCodeScanEvidence, type PreparedPublishedCodeScan,
} from './published-code-scan.js';
import type { readGuestSnapshotData } from './guest-snapshot.js';

type Files = ReturnType<typeof readGuestSnapshotData>['files'];
type Group = PreparedPublishedCodeScan['groups'][number];

function scanGroup(group: Group, directory: string, engineVersion: string, byPath: ReadonlyMap<string, Files[number]>) {
  const workdir = mkdtempSync(join(tmpdir(), 'itervane-published-code-'));
  try {
    writeFileSync(join(workdir, 'rule.json'), group.config, { flag: 'wx', mode: 0o400 });
    for (const target of group.targets) {
      const file = byPath.get(target.path);
      if (!file || file.mode !== target.mode || file.content.length !== target.bytes || sha256(file.content) !== target.sha256) {
        throw new Error('published_code_scan_source_binding');
      }
      // Use a closed, neutral staging tree. The repository cannot supply config, ignores or command arguments.
      writeFileSync(join(workdir, target.alias), file.content, { flag: 'wx', mode: 0o400 });
    }
    const run = invokeGuestSemgrep(directory, workdir, group.targets.map(file => file.alias), {
      targetBytes: sourceLimits.maxFileBytes, reportBytes: publishedCodeScanReportByteLimit, timeoutMs: 25_000,
    });
    const error = (run.error as NodeJS.ErrnoException | undefined)?.code;
    return normalizePublishedCodeScan(group, engineVersion, {
      exitCode: run.status, timedOut: error === 'ETIMEDOUT', overflow: error === 'ENOBUFS', stdout: run.stdout ?? Buffer.alloc(0),
    });
  } finally { rmSync(workdir, { recursive: true, force: true }); }
}

/** Uses bytes already verified in the sealed guest scanner. */
export async function runPublishedCodeScan(directory: string, rules: PreparedPublishedCodeRules, source: {
  manifest: Parameters<typeof preparePublishedCodeScan>[1];
  files: Files;
}) {
  const scan = preparePublishedCodeScan(rules, source.manifest);
  const byPath = new Map(source.files.map(file => [file.path, file]));
  if (byPath.size !== source.files.length || byPath.size !== source.manifest.files.length) throw new Error('published_code_scan_source_binding');
  const { profile } = scan.basis;
  let engineAvailable = true;
  if (scan.groups.some(group => group.targets.length)) {
    try { await verifySemgrepEngine(directory, profile); } catch { engineAvailable = false; }
  }
  const reports = scan.groups.map((group): PublishedCodeScanReport => {
    if (!group.targets.length) return { language: group.language, status: 'not_applicable' };
    if (!engineAvailable) return { language: group.language, status: 'unavailable', reason: 'engine_unavailable' };
    return scanGroup(group, directory, profile.engineVersion, byPath);
  });
  const document = { basis: scan.basis, reports };
  return verifyPublishedCodeScanEvidence(scan, { document, sha256: sha256(JSON.stringify(document)) });
}
