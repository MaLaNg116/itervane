import { z } from 'zod';
import { sha256Schema } from './inspection.js';
import { npmAdvisoryIdSchema, npmPackageNameSchema, npmStableVersionSchema } from './qualified-inspection.js';

const lockName = /(?:^|\/)package-lock\.json$/;
const integritySchema = z.string().regex(/^sha512-[A-Za-z0-9+/]{85}[AQgw]==$/);

export const npmUpgradeApprovalSchema = z.strictObject({
  advisoryId: npmAdvisoryIdSchema, name: npmPackageNameSchema,
  installedVersion: npmStableVersionSchema, fixedVersion: npmStableVersionSchema, integrity: integritySchema,
}).refine(approval => {
  const before = approval.installedVersion.split('.').map(Number);
  const after = approval.fixedVersion.split('.').map(Number);
  const changed = before.findIndex((part, index) => part !== after[index]);
  return changed >= 0 && after[changed]! > before[changed]!;
});
export type NpmUpgradeApproval = z.infer<typeof npmUpgradeApprovalSchema>;

export const npmUpgradeApprovalsSchema = z.array(npmUpgradeApprovalSchema).max(32).refine(approvals =>
  new Set(approvals.map(item => JSON.stringify([item.advisoryId, item.name, item.installedVersion]))).size === approvals.length);

const npmRepairScopeSchema = z.strictObject({
  findingId: sha256Schema, lockPath: z.string().min(1).max(240).refine(path => path.isWellFormed() && lockName.test(path)),
  approval: npmUpgradeApprovalSchema,
});
export const npmRepairScopesSchema = z.array(npmRepairScopeSchema).min(1).max(4)
  .refine(scopes => new Set(scopes.map(scope => scope.findingId)).size === scopes.length);
export type NpmRepairScope = z.infer<typeof npmRepairScopeSchema>;

export const isNpmRepairArtifact = (path: string) => /(?:^|\/)package(?:-lock)?\.json$/i.test(path);
export const npmRepairPaths = (lockPath: string) => [lockPath, lockPath.replace(/package-lock\.json$/, 'package.json')] as const;

export function npmRegistryTarball(name: string, version: string) {
  const basename = name.slice(name.lastIndexOf('/') + 1);
  return `https://registry.npmjs.org/${name}/-/${basename}-${version}.tgz`;
}
