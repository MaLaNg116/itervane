import { readFileSync } from 'node:fs';
import { npmRegistryTarball, npmUpgradeApprovalSchema } from '@itervane/contracts';

export const npmReleaseApproval = npmUpgradeApprovalSchema.parse({
  advisoryId: 'CVE-2022-46175',
  name: 'json5',
  installedVersion: '2.2.1',
  fixedVersion: '2.2.2',
  integrity: 'sha512-46Tk9JiOL2z7ytNQWFLpj99RZkVgeHf87yGQKsIkaPz1qSH9UczKH1rO7K3wgRselo0tYMUNfecYpm/p1vC7tQ==',
});
const previousIntegrity = 'sha512-1hqLFMSrGHRHxav9q9gNjJ5EXznIxGVO09xQRrwplcS8qs28pZ8s8hupZAmqDwZUmVZ2Qb2jnyPOWcDH8m8dlA==';

/** Build input for the pinned synthetic standard app. The older version is scanned as metadata only. */
export function standardNpmReleaseFiles(state: 'before' | 'approved') {
  const standard = new URL('../../../../fixtures/standard-app/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('package.json', standard), 'utf8')) as { dependencies: Record<string, string> };
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', standard), 'utf8')) as {
    packages: Record<string, { dependencies?: Record<string, string>; version?: string; resolved?: string; integrity?: string; license?: string }>;
  };
  const { name, installedVersion, fixedVersion, integrity } = npmReleaseApproval;
  const lockRoot = lock.packages['']?.dependencies;
  const location = 'node_modules/' + name;
  if (!lockRoot || manifest.dependencies[name] || lockRoot[name] || lock.packages[location]) {
    throw new Error('release_fixture_dependency_collision');
  }
  const version = state === 'before' ? installedVersion : fixedVersion;
  manifest.dependencies[name] = version;
  lockRoot[name] = version;
  lock.packages[location] = {
    version, resolved: npmRegistryTarball(name, version), integrity: state === 'before' ? previousIntegrity : integrity, license: 'MIT',
  };
  return { manifest: Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), lock: Buffer.from(JSON.stringify(lock, null, 2) + '\n') };
}
