import type { PublishedCodeScanEvidence } from '@itervane/contracts';
import { sha256 } from './profiles.js';
import { scanFindingId } from './scan-finding-id.js';
import type { ScanSummary } from './scans.js';

const scanners = ['gitleaks', 'trivy'] as const;
type ProtectedScanner = typeof scanners[number];
type Scanner = ProtectedScanner | 'semgrep_ce';
type Finding = ScanSummary['findings'][number];
type ScannedSnapshot = { manifestSha256: string; reports: readonly [ScanSummary, ScanSummary] };
type CodeScans = { before: PublishedCodeScanEvidence | undefined; after: PublishedCodeScanEvidence | undefined };
type FindingGroup = {
  scanner: Scanner;
  ruleId: string;
  path: string;
  dependency: { name: string; installedVersion: string } | null;
  beforeIds: string[];
  afterIds: string[];
};
type Unavailable = {
  status: 'unavailable';
  reason: 'report_binding' | 'incomplete_coverage' | 'profile_mismatch';
  scanner: Scanner;
};
type Compared = {
  status: 'compared';
  groups: FindingGroup[];
  totals: { introduced: number; resolved: number; remaining: number };
};

function reportBound(report: ScanSummary, scanner: ProtectedScanner, manifestSha256: string) {
  return report.scanner === scanner && report.snapshotSha256 === manifestSha256
    && (report.status !== 'completed' || ((scanner === 'trivy') === (report.database !== null) && report.reason === null))
    && report.findings.every(finding => finding.id === scanFindingId(scanner, manifestSha256, finding))
    && new Set(report.findings.map(finding => finding.id)).size === report.findings.length;
}

function addFinding(groups: Map<string, FindingGroup>, scanner: Scanner, finding: Pick<Finding, 'id' | 'ruleId' | 'path' | 'npm'>,
  side: 'beforeIds' | 'afterIds') {
  const { ruleId, path, npm: coordinates } = finding;
  const dependency = coordinates ? { name: coordinates.name, installedVersion: coordinates.installedVersion } : null;
  // Gitleaks locates occurrences by line, which may shift when another line is edited.
  const key = JSON.stringify([scanner, path, ruleId, dependency]);
  let group = groups.get(key);
  if (!group) {
    group = { scanner, ruleId, path, dependency, beforeIds: [], afterIds: [] };
    groups.set(key, group);
  }
  group[side].push(finding.id);
}

function addCodeFindings(groups: Map<string, FindingGroup>, scans: CodeScans, before: ScannedSnapshot, after: ScannedSnapshot): Unavailable | undefined {
  const unavailable = (reason: Unavailable['reason']): Unavailable => ({ status: 'unavailable', reason, scanner: 'semgrep_ce' });
  if (!scans.before || !scans.after) return unavailable('report_binding');
  const { basis: left, reports: oldReports } = scans.before.document;
  const { basis: right, reports: newReports } = scans.after.document;
  if (scans.before.sha256 !== sha256(JSON.stringify(scans.before.document)) || scans.after.sha256 !== sha256(JSON.stringify(scans.after.document))
      || left.manifestSha256 !== before.manifestSha256 || right.manifestSha256 !== after.manifestSha256
      || left.taskId !== right.taskId || left.projectId !== right.projectId || left.snapshotSha256 !== right.snapshotSha256
      || left.source.repositoryId !== right.source.repositoryId || left.source.commit !== right.source.commit) return unavailable('report_binding');
  if (left.profile.engine !== right.profile.engine || left.profile.engineVersion !== right.profile.engineVersion
      || left.profile.engineInputsSha256 !== right.profile.engineInputsSha256
      || (left.profile.runnerImageSha256 === right.profile.runnerImageSha256 && left.ruleSetSha256 !== right.ruleSetSha256)
      || left.batches.length === 0 || left.batches.length !== right.batches.length) return unavailable('profile_mismatch');
  if (oldReports.length !== left.batches.length || newReports.length !== right.batches.length) return unavailable('incomplete_coverage');

  const sameManifest = before.manifestSha256 === after.manifestSha256;
  for (const [index, batch] of left.batches.entries()) {
    const target = right.batches[index]!;
    const oldReport = oldReports[index]!;
    const newReport = newReports[index]!;
    if (batch.language !== target.language || batch.configSha256 !== target.configSha256 || batch.fileCount !== target.fileCount) {
      return unavailable('profile_mismatch');
    }
    if (oldReport.language !== batch.language || newReport.language !== target.language
        || oldReport.status === 'unavailable' || newReport.status === 'unavailable'
        || (oldReport.status === 'not_applicable') !== (batch.fileCount === 0) || oldReport.status !== newReport.status) {
      return unavailable('incomplete_coverage');
    }
    const oldFindings = oldReport.status === 'checked' ? oldReport.findings : [];
    const newFindings = newReport.status === 'checked' ? newReport.findings : [];
    if (sameManifest && (batch.targetsSha256 !== target.targetsSha256 || JSON.stringify(oldFindings) !== JSON.stringify(newFindings))) {
      return unavailable('report_binding');
    }
    const observations = [[scans.before.sha256, oldFindings, 'beforeIds'], [scans.after.sha256, newFindings, 'afterIds']] as const;
    for (const [digest, findings, side] of observations) {
      for (const { ruleKey, path, start, end } of findings) {
        const id = sha256(JSON.stringify([digest, ruleKey, path, start, end]));
        addFinding(groups, 'semgrep_ce', { id, ruleId: ruleKey, path }, side);
      }
    }
  }
}

/** Compare normalized evidence from the same protected scanner and pinned code rule inputs. */
export function compareVerificationScans(before: ScannedSnapshot, after: ScannedSnapshot, code?: CodeScans): Unavailable | Compared {
  const groups = new Map<string, FindingGroup>();
  for (const [index, scanner] of scanners.entries()) {
    const left = before.reports[index]!;
    const right = after.reports[index]!;
    if (!reportBound(left, scanner, before.manifestSha256) || !reportBound(right, scanner, after.manifestSha256)) {
      return { status: 'unavailable', reason: 'report_binding', scanner };
    }
    if (left.status !== 'completed' || right.status !== 'completed') {
      return { status: 'unavailable', reason: 'incomplete_coverage', scanner };
    }
    if (left.version !== right.version || left.policySha256 !== right.policySha256
        || left.database?.sha256 !== right.database?.sha256) {
      return { status: 'unavailable', reason: 'profile_mismatch', scanner };
    }
    for (const finding of left.findings) addFinding(groups, scanner, finding, 'beforeIds');
    for (const finding of right.findings) addFinding(groups, scanner, finding, 'afterIds');
  }
  if (code) {
    const unavailable = addCodeFindings(groups, code, before, after);
    if (unavailable) return unavailable;
  }
  const totals = { introduced: 0, resolved: 0, remaining: 0 };
  const orderedGroups = [...groups.keys()].sort().map(key => groups.get(key)!);
  for (const group of orderedGroups) {
    group.beforeIds.sort();
    group.afterIds.sort();
    totals.introduced += Math.max(0, group.afterIds.length - group.beforeIds.length);
    totals.resolved += Math.max(0, group.beforeIds.length - group.afterIds.length);
    totals.remaining += Math.min(group.beforeIds.length, group.afterIds.length);
  }
  return { status: 'compared', groups: orderedGroups, totals };
}
