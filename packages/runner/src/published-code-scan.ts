import {
  publishedCodeScanEvidenceSchema, publishedCodeScanMatchLimit, publishedCodeScanPositionSchema, publishedCodeScanReportByteLimit,
  type CodeRuleLanguage, type PublishedCodeScanBasis, type PublishedCodeScanFinding, type PublishedCodeScanReport,
} from '@itervane/contracts';
import { posix } from 'node:path';
import { z } from 'zod';
import { sha256, sourceLimits } from './profiles.js';
import type { PreparedPublishedCodeRules } from './published-code-rules.js';
import type { SourceManifest } from './snapshot.js';

const canonicalExtensions = new Map<string, readonly [CodeRuleLanguage, string]>([
  ['.js', ['javascript', '.js']], ['.cjs', ['javascript', '.js']], ['.mjs', ['javascript', '.js']], ['.jsx', ['javascript', '.jsx']],
  ['.ts', ['typescript', '.ts']], ['.cts', ['typescript', '.ts']], ['.mts', ['typescript', '.ts']], ['.tsx', ['typescript', '.tsx']],
]);
const rawReport = z.object({
  version: z.string().min(1).max(24),
  errors: z.array(z.unknown()).max(publishedCodeScanMatchLimit),
  paths: z.object({ scanned: z.array(z.string().max(48)).max(sourceLimits.maxFiles), skipped: z.array(z.unknown()).optional() }),
  results: z.array(z.object({
    check_id: z.string().max(64), path: z.string().max(48),
    start: publishedCodeScanPositionSchema, end: publishedCodeScanPositionSchema,
  })).max(publishedCodeScanMatchLimit),
});

type Manifest = Pick<SourceManifest, 'source' | 'files' | 'sha256'>;
export function preparePublishedCodeScan(rules: PreparedPublishedCodeRules, manifest: Manifest) {
  const { input } = rules;
  const groups = rules.groups.map(group => {
    const targets = manifest.files.flatMap(file => {
      const extension = canonicalExtensions.get(posix.extname(file.path).toLowerCase());
      return extension?.[0] === group.language ? [{ file, extension: extension[1] }] : [];
    }).map(({ file, extension }, index) => ({ ...file, alias: 'target-' + index + extension }));
    return { ...group, targets, targetsSha256: sha256(JSON.stringify(targets)) };
  });
  const basis: PublishedCodeScanBasis = {
    version: 1, taskId: input.snapshot.document.taskId, projectId: input.snapshot.document.projectId,
    source: manifest.source, manifestSha256: manifest.sha256, snapshotSha256: input.snapshot.sha256, ruleSetSha256: rules.sha256,
    profile: input.profile, batches: groups.map(({ language, configSha256, targets, targetsSha256 }) =>
      ({ language, configSha256, targetsSha256, fileCount: targets.length })),
  };
  return { basis, groups };
}
export type PreparedPublishedCodeScan = ReturnType<typeof preparePublishedCodeScan>;
type Group = PreparedPublishedCodeScan['groups'][number];
type Unavailable = Extract<PublishedCodeScanReport, { status: 'unavailable' }>;

function matchesSource(finding: PublishedCodeScanFinding, bytes: number) {
  const { start, end } = finding;
  return start.offset < end.offset && end.offset <= bytes && start.line <= end.line
    && (start.line !== end.line || start.col < end.col)
    && [start, end].every(point => point.line + point.col - 2 <= point.offset);
}

function compare(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
function compareFindings(a: PublishedCodeScanFinding, b: PublishedCodeScanFinding) {
  return compare(a.path, b.path) || compare(a.ruleKey, b.ruleKey)
    || a.start.offset - b.start.offset || a.end.offset - b.end.offset;
}
function stagedPath(path: string) { return path.startsWith('./') ? path.slice(2) : path; }

export function normalizePublishedCodeScan(group: Group, engineVersion: string, run: {
  exitCode: number | null; timedOut: boolean; overflow: boolean; stdout: Buffer;
}): PublishedCodeScanReport {
  const { language, targets, ruleKeys } = group;
  const unavailable = (reason: Unavailable['reason']): Unavailable => ({ language, status: 'unavailable', reason });
  if (!targets.length) return { language, status: 'not_applicable' };
  if (run.timedOut) return unavailable('timeout');
  if (run.overflow || run.stdout.length > publishedCodeScanReportByteLimit) return unavailable('invalid_report');
  if (run.exitCode === null) return unavailable('engine_unavailable');
  if (run.exitCode !== 0) return unavailable('command_failed');
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(run.stdout)); }
  catch { return unavailable('invalid_report'); }
  const result = rawReport.safeParse(raw);
  if (!result.success) return unavailable('invalid_report');
  const observed = result.data;
  if (observed.version !== engineVersion) return unavailable('version_mismatch');
  const byAlias = new Map(targets.map(file => [file.alias, file]));
  const scanned = new Set(observed.paths.scanned.map(stagedPath));
  if (observed.errors.length || observed.paths.skipped?.length || scanned.size !== targets.length
      || observed.paths.scanned.length !== targets.length || [...scanned].some(path => !byAlias.has(path))) {
    return unavailable('incomplete_coverage');
  }
  const findings: PublishedCodeScanFinding[] = [];
  for (const match of observed.results) {
    const file = byAlias.get(stagedPath(match.path));
    if (!file || !ruleKeys.includes(match.check_id)) return unavailable('invalid_match');
    const finding = { ruleKey: match.check_id, path: file.path, start: match.start, end: match.end };
    if (!matchesSource(finding, file.bytes)) return unavailable('invalid_match');
    findings.push(finding);
  }
  findings.sort(compareFindings);
  if (findings.some((item, index) => index > 0 && compareFindings(findings[index - 1]!, item) === 0)) return unavailable('invalid_match');
  return { language, status: 'checked', reportSha256: sha256(run.stdout), findings };
}

/** Verifies source, rule and coverage bindings against the independently prepared plan. */
export function verifyPublishedCodeScanEvidence(scan: PreparedPublishedCodeScan, raw: unknown) {
  const evidence = publishedCodeScanEvidenceSchema.parse(raw);
  const { document } = evidence;
  if (evidence.sha256 !== sha256(JSON.stringify(document)) || JSON.stringify(document.basis) !== JSON.stringify(scan.basis)
      || document.reports.length !== scan.groups.length) throw new Error('published_code_scan_evidence_binding');
  for (const [index, report] of document.reports.entries()) {
    const group = scan.groups[index]!;
    if (report.language !== group.language || (report.status === 'not_applicable') !== (group.targets.length === 0)) {
      throw new Error('published_code_scan_coverage_binding');
    }
    if (report.status !== 'checked') continue;
    const paths = new Map(group.targets.map(file => [file.path, file.bytes]));
    for (const [position, finding] of report.findings.entries()) {
      const bytes = paths.get(finding.path);
      if (bytes === undefined || !group.ruleKeys.includes(finding.ruleKey) || !matchesSource(finding, bytes)
          || (position > 0 && compareFindings(report.findings[position - 1]!, finding) >= 0)) {
        throw new Error('published_code_scan_finding_binding');
      }
    }
  }
  return evidence;
}
