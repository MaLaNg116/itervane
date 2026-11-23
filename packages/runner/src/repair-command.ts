import { repairCommandByteLimit, repairObservationCommandSchema, repairPatchSchema, repairWorkspaceSchema,
  standardHealthRepairPath, type NpmRepairScope } from '@itervane/contracts';
import { sha256 } from './profiles.js';
import { sourcePath } from './snapshot.js';

const byPath = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right));

function canonicalNpmRepairs(scopes?: readonly NpmRepairScope[]) {
  return scopes?.map(scope => ({ ...scope, lockPath: sourcePath(scope.lockPath) }))
    .sort((left, right) => byPath(left.lockPath, right.lockPath) || left.findingId.localeCompare(right.findingId));
}

export function protectedRepairPath(path: string, protectedPaths: readonly string[]) {
  const folded = path.toLowerCase();
  return protectedPaths.some(value => {
    const prefix = value.toLowerCase();
    return folded === prefix || folded.startsWith(prefix + '/');
  });
}

export function canonicalRepairCommand(rawWorkspace: unknown, rawPatch: unknown) {
  const input = repairWorkspaceSchema.parse(rawWorkspace);
  const npmRepairs = canonicalNpmRepairs(input.npmRepairs);
  const workspace = { ...input, editablePaths: input.editablePaths.map(sourcePath).sort(byPath),
    protectedPaths: input.protectedPaths.map(sourcePath).sort(byPath), ...(npmRepairs ? { npmRepairs } : {}) };
  const proposal = repairPatchSchema.parse(rawPatch);
  const patch = { ...proposal, files: proposal.files.map(file => ({ ...file, path: sourcePath(file.path) }))
    .sort((left, right) => byPath(left.path, right.path)) };
  if (patch.baseSnapshotSha256 !== workspace.baseSnapshotSha256) throw new Error('repair-base');
  if (workspace.healthReproductionSha256 && (npmRepairs?.length || workspace.editablePaths.length !== 1
      || workspace.editablePaths[0] !== standardHealthRepairPath || patch.files.length !== 1
      || patch.files[0]?.path !== standardHealthRepairPath)) throw new Error('repair-scope');
  const bytes = Buffer.from(JSON.stringify({ workspace, patch }));
  if (bytes.length > repairCommandByteLimit) throw new Error('repair-size');
  return { workspace, patch, bytes, workspaceSha256: sha256(JSON.stringify(workspace)), patchSha256: sha256(JSON.stringify(patch)) };
}

export function canonicalRepairObservation(raw: unknown) {
  const data = repairObservationCommandSchema.parse(raw);
  const npmRepairs = canonicalNpmRepairs(data.workspace.npmRepairs);
  const workspace = { ...data.workspace, protectedPaths: data.workspace.protectedPaths.map(sourcePath).sort(byPath),
    ...(npmRepairs ? { npmRepairs } : {}) };
  const targets = data.targets.map(target => 'kind' in target ? target : { ...target, path: sourcePath(target.path) })
    .sort((left, right) => left.findingId.localeCompare(right.findingId) || byPath(left.path, right.path));
  const [first] = targets;
  if (workspace.healthReproductionSha256 ? targets.length !== 1 || !first || !('kind' in first)
      || first.findingId !== workspace.healthReproductionSha256 || npmRepairs?.length
    : targets.some(target => 'kind' in target)) throw new Error('repair-scope');
  const bytes = Buffer.from(JSON.stringify({ workspace, targets }));
  if (bytes.length > repairCommandByteLimit) throw new Error('repair-size');
  return { workspace, targets, bytes };
}
