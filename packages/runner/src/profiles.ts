import { createHash } from 'node:crypto';
import { inspectionPlanSchema, type InspectionPlan } from '@itervane/contracts';

export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const sourceLimits = Object.freeze({ maxFiles: 5000, maxFileBytes: 2097152, maxSourceBytes: 33554432, maxCommitBytes: 65536 });
export const gitleaksConfig = 'title = "Itervane protected snapshot profile v1"\n[extend]\nuseDefault = true\n';
export const trivyConfig = 'scan:\n  scanners:\n    - vuln\n';
export const scannerProfiles = [
  { scanner: 'gitleaks', version: '8.30.1', policySha256: sha256(gitleaksConfig), coverage: 'snapshot-secret-patterns' },
  { scanner: 'trivy', version: '0.76.2', policySha256: sha256(trivyConfig), coverage: 'npm-lockfile-vulnerabilities' },
] as const;

export function createInspectionPlan(input: Pick<InspectionPlan, 'taskId' | 'runId' | 'requestedSource'>) {
  const document = inspectionPlanSchema.parse({ version: 1, ...input,
    isolation: { kind: 'disposable_vm', driver: 'qemu-kvm-libvirt', verification: 'required' },
    network: { fetch: 'registered_https_only', scan: 'deny' },
    limits: { cpu: 2, memoryMiB: 2048, diskMiB: 8192, timeoutSeconds: 180,
      maxFiles: 5000, maxFileBytes: 2097152, maxSourceBytes: 33554432, maxReportBytes: 4194304 }, scanners: scannerProfiles });
  return { document, sha256: inspectionPlanHash(document) };
}
export function inspectionPlanHash(input: unknown) { return sha256(JSON.stringify(inspectionPlanSchema.parse(input))); }

// These are guest command descriptions, not a host executor. Paths belong to a future verified VM layout.
export const scannerCommands = Object.freeze({
  gitleaks: ['dir', '/worktree', '--config', '/policy/gitleaks.toml', '--gitleaks-ignore-path', '/policy/empty.ignore',
    '--ignore-gitleaks-allow', '--redact=100', '--max-archive-depth=0', '--max-decode-depth=0', '--no-banner',
    '--exit-code=10', '--report-format=json', '--report-path', '/output/gitleaks.json'],
  trivy: ['filesystem', '--config', '/policy/trivy.yaml', '--ignorefile', '/policy/empty.ignore', '--scanners=vuln',
    '--pkg-types=library', '--offline-scan', '--skip-db-update', '--skip-java-db-update', '--skip-check-update',
    '--list-all-pkgs', '--exit-code=10', '--format=json', '--output', '/output/trivy.json', '/worktree'],
} as const);
