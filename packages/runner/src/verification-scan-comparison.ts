import { scanFindingId } from './scan-finding-id.js';
import type { ScanSummary } from './scans.js';

const scanners = ['gitleaks', 'trivy'] as const;
type Scanner = typeof scanners[number];
type Finding = ScanSummary['findings'][number];
type ScannedSnapshot = { manifestSha256: string; reports: readonly [ScanSummary, ScanSummary] };
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

function reportBound(report: ScanSummary, scanner: Scanner, manifestSha256: string) {
  return report.scanner === scanner && report.snapshotSha256 === manifestSha256
    && (report.status !== 'completed' || ((scanner === 'trivy') === (report.database !== null) && report.reason === null))
    && report.findings.every(finding => finding.id === scanFindingId(scanner, manifestSha256, finding))
    && new Set(report.findings.map(finding => finding.id)).size === report.findings.length;
}

function addFinding(groups: Map<string, FindingGroup>, scanner: Scanner, finding: Finding, side: 'beforeIds' | 'afterIds') {
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

/** Compare normalized evidence from the same protected scanner profiles. */
export function compareVerificationScans(before: ScannedSnapshot, after: ScannedSnapshot): Unavailable | Compared {
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
