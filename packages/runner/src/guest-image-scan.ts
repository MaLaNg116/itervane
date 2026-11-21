import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ociDigestSchema, qualifiedImageScanSchema } from '@itervane/contracts';
import { z } from 'zod';
import { INSPECTION_TOOLS, verifyGuestInspectionInputs } from './guest-inspection.js';
import { readBoundedFile } from './guest-snapshot.js';
import { sha256 } from './profiles.js';

const workspace = '/var/lib/itervane-image-work';
const policyFlags = [
  '--scanners=vuln', '--pkg-types=os,library', '--offline-scan', '--skip-db-update',
  '--skip-java-db-update', '--skip-check-update', '--list-all-pkgs', '--cache-backend=memory',
  '--parallel=2', '--no-progress', '--exit-code=10', '--format=json',
] as const;
const rawFinding = z.object({
  VulnerabilityID: z.string(), PkgName: z.string(), InstalledVersion: z.string(), Severity: z.string(),
});
const rawResult = z.object({
  Class: z.string(), Type: z.string(),
  Packages: z.array(z.object({ Name: z.string(), Version: z.string() })).max(15_000).optional(),
  Vulnerabilities: z.array(rawFinding).max(2_000).optional(),
});
const rawReport = z.object({
  SchemaVersion: z.literal(2), ArtifactName: z.string(), ArtifactType: z.literal('container_image'),
  Metadata: z.object({ ImageID: ociDigestSchema, OS: z.object({ Family: z.literal('ubuntu') }) }),
  Results: z.array(rawResult).min(2).max(15_000),
});

export async function scanGuestImage(manifest: string, config: string, expectedInputs: string) {
  const manifestDigest = ociDigestSchema.parse(manifest);
  const configDigest = ociDigestSchema.parse(config);
  const { inputs, inputsSha256 } = await verifyGuestInspectionInputs(INSPECTION_TOOLS);
  if (inputsSha256 !== expectedInputs) throw new Error('image_scan_inputs');
  const target = join(workspace, 'layout') + '@' + manifestDigest;
  const reportPath = join(workspace, 'image-scan.json');
  const policy = join(INSPECTION_TOOLS, 'policy');
  const result = spawnSync(join(INSPECTION_TOOLS, 'trivy'), [
    'image', '--input', target, '--config', join(policy, 'trivy.yaml'), '--ignorefile', join(policy, 'empty.ignore'),
    '--cache-dir', join(INSPECTION_TOOLS, 'cache'), '--output', reportPath, ...policyFlags,
  ], {
    cwd: workspace, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: workspace, GOMAXPROCS: '2' },
    timeout: 23_000, killSignal: 'SIGKILL', stdio: 'ignore',
  });
  if (result.status !== 0 && result.status !== 10) throw new Error('image_scan_execution');
  const bytes = readBoundedFile(reportPath, 8 * 1024 * 1024);
  const report = rawReport.parse(JSON.parse(bytes.toString('utf8')));
  if (report.ArtifactName !== target || report.Metadata.ImageID !== configDigest) throw new Error('image_scan_identity');
  let osPackages = 0;
  let npmPackages = 0;
  const findings = new Map<string, object>();
  for (const group of report.Results) {
    if (group.Class === 'os-pkgs' && group.Type === 'ubuntu') osPackages += group.Packages?.length ?? 0;
    else if (group.Class === 'lang-pkgs' && group.Type === 'node-pkg') npmPackages += group.Packages?.length ?? 0;
    else if (group.Vulnerabilities?.length) throw new Error('image_scan_unsupported_package_type');
    for (const item of group.Vulnerabilities ?? []) {
      const finding = { class: group.Class, advisory: item.VulnerabilityID, package: item.PkgName,
        version: item.InstalledVersion, severity: item.Severity };
      findings.set(JSON.stringify(finding), finding);
    }
  }
  return qualifiedImageScanSchema.parse({
    scanner: 'trivy', version: '0.76.2', imageDigest: manifestDigest, configDigest,
    policySha256: sha256(JSON.stringify(policyFlags)), reportSha256: sha256(bytes),
    database: { sha256: inputs.databaseSha256, updatedAt: inputs.databaseUpdatedAt },
    osPackages, npmPackages, findings: [...findings.keys()].sort().map(key => findings.get(key)),
  });
}
