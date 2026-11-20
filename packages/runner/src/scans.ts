import { z } from 'zod';
import { scannerProfiles, sha256 } from './profiles.js';
import { sourcePath, type SourceManifest } from './snapshot.js';

type Scanner = 'gitleaks' | 'trivy';
type Finding = { id: string; ruleId: string; path: string; line: number | null; severity: 'unknown' | 'low' | 'medium' | 'high' | 'critical' };
export type ScanSummary = {
  scanner: Scanner; version: string; policySha256: string; snapshotSha256: string;
  status: 'completed' | 'failed' | 'unavailable' | 'unsupported';
  reason: 'timeout' | 'scanner_error' | 'invalid_report' | 'missing_inventory' | 'database_unavailable' | 'empty_source' | null;
  findings: Finding[]; database: { sha256: string; updatedAt: string } | null;
};
type Input = { manifest: SourceManifest; report: string; exitCode: number | null; timedOut?: boolean; sourceRoot?: string;
  database?: { sha256: string; updatedAt: string }; now?: number };
const record = z.record(z.string(), z.unknown());
const severity = z.enum(['unknown', 'low', 'medium', 'high', 'critical']);
const line = z.number().int().positive().max(100_000_000);
const databaseSchema = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), updatedAt: z.iso.datetime() }).strict();
function filePath(value: unknown, input: Input) {
  if (typeof value !== 'string') throw new Error('invalid_report');
  const root = (input.sourceRoot ?? '/worktree').replaceAll('\\', '/').replace(/\/$/, '');
  let path = value.replaceAll('\\', '/');
  if (path.startsWith(root + '/')) path = path.slice(root.length + 1);
  else if (path.startsWith('./')) path = path.slice(2);
  path = sourcePath(path);
  if (!input.manifest.files.some(file => file.path === path)) throw new Error('invalid_report');
  return path;
}

/** Raw reports are never returned. Known fields are rebuilt; secrets, snippets and stderr are discarded. */
export function normalizeScan(scanner: Scanner, input: Input): ScanSummary {
  const profile = scannerProfiles.find(value => value.scanner === scanner)!;
  const base = { scanner, version: profile.version, policySha256: profile.policySha256, snapshotSha256: input.manifest.sha256 };
  const stopped = (status: ScanSummary['status'], reason: ScanSummary['reason']): ScanSummary => ({ ...base, status, reason, findings: [], database: null });
  if (input.timedOut) return stopped('failed', 'timeout');
  if (input.exitCode !== 0 && input.exitCode !== 10) return stopped('failed', 'scanner_error');
  if (!input.manifest.files.length) return stopped('unsupported', 'empty_source');
  let database: ScanSummary['database'] = null;
  if (scanner === 'trivy') {
    const parsed = databaseSchema.safeParse(input.database); const now = input.now ?? Date.now();
    if (!parsed.success || !Number.isFinite(now) || now - Date.parse(parsed.data.updatedAt) > 72 * 3600_000 || Date.parse(parsed.data.updatedAt) > now + 300_000) return stopped('unavailable', 'database_unavailable');
    database = parsed.data;
  }
  try {
    if (Buffer.byteLength(input.report) > 4194304) throw new Error('invalid_report');
    const parsed: unknown = JSON.parse(input.report); const findings: Finding[] = [];
    const add = (ruleId: string, path: string, findingLine: number | null, risk: Finding['severity']) => {
      const id = sha256(JSON.stringify([scanner, input.manifest.sha256, ruleId, path, findingLine]));
      findings.push({ id, ruleId, path, line: findingLine, severity: risk });
      if (findings.length > 2000) throw new Error('invalid_report');
    };
    if (scanner === 'gitleaks') {
      const entries = z.array(record).max(2000).parse(parsed === null ? [] : parsed);
      for (const entry of entries) {
        const ruleId = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/).parse(entry.RuleID);
        add(ruleId, filePath(entry.File, input), line.parse(entry.StartLine), 'high');
      }
    } else {
      const report = record.parse(parsed);
      if (report.SchemaVersion !== 2) throw new Error('invalid_report');
      const results = z.array(record).max(5000).parse(report.Results ?? []); let packages = 0;
      for (const result of results) {
        if (result.Class !== 'lang-pkgs' || result.Type !== 'npm') throw new Error('invalid_report');
        const path = filePath(result.Target, input);
        if (!/(?:^|\/)package-lock\.json$/.test(path)) throw new Error('invalid_report');
        packages += z.array(record).max(100_000).parse(result.Packages ?? []).length;
        for (const issue of z.array(record).max(2000).parse(result.Vulnerabilities ?? [])) {
          const ruleId = z.string().regex(/^(?:CVE-\d{4}-\d{4,12}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/).parse(issue.VulnerabilityID);
          add(ruleId, path, null, severity.parse(String(issue.Severity ?? 'unknown').toLowerCase()));
        }
      }
      if (packages === 0) return stopped('unsupported', 'missing_inventory');
    }
    if ((findings.length > 0) !== (input.exitCode === 10)) throw new Error('invalid_report');
    const unique = [...new Map(findings.map(value => [value.id, value])).values()].sort((a, b) => a.id.localeCompare(b.id, 'en'));
    return { ...base, status: 'completed', reason: null, findings: unique, database };
  } catch { return stopped('failed', 'invalid_report'); }
}
