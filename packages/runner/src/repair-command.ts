import { repairCommandByteLimit, repairObservationCommandSchema, repairPatchSchema, repairWorkspaceSchema } from '@itervane/contracts';
import { sha256 } from './profiles.js';
import { sourcePath } from './snapshot.js';

const byPath = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right));

export function protectedRepairPath(path: string, protectedPaths: readonly string[]) {
  const folded = path.toLowerCase();
  return protectedPaths.some(value => {
    const prefix = value.toLowerCase();
    return folded === prefix || folded.startsWith(prefix + '/');
  });
}

export function canonicalRepairCommand(rawWorkspace: unknown, rawPatch: unknown) {
  const input = repairWorkspaceSchema.parse(rawWorkspace);
  const workspace = { ...input, editablePaths: input.editablePaths.map(sourcePath).sort(byPath),
    protectedPaths: input.protectedPaths.map(sourcePath).sort(byPath) };
  const proposal = repairPatchSchema.parse(rawPatch);
  const patch = { ...proposal, files: proposal.files.map(file => ({ ...file, path: sourcePath(file.path) }))
    .sort((left, right) => byPath(left.path, right.path)) };
  if (patch.baseSnapshotSha256 !== workspace.baseSnapshotSha256) throw new Error('repair-base');
  const bytes = Buffer.from(JSON.stringify({ workspace, patch }));
  if (bytes.length > repairCommandByteLimit) throw new Error('repair-size');
  return { workspace, patch, bytes, workspaceSha256: sha256(JSON.stringify(workspace)), patchSha256: sha256(JSON.stringify(patch)) };
}

export function canonicalRepairObservation(raw: unknown) {
  const data = repairObservationCommandSchema.parse(raw);
  const workspace = { ...data.workspace, protectedPaths: data.workspace.protectedPaths.map(sourcePath).sort(byPath) };
  const targets = data.targets.map(target => ({ ...target, path: sourcePath(target.path) }))
    .sort((left, right) => left.findingId.localeCompare(right.findingId) || byPath(left.path, right.path));
  const bytes = Buffer.from(JSON.stringify({ workspace, targets }));
  if (bytes.length > repairCommandByteLimit) throw new Error('repair-size');
  return { workspace, targets, bytes };
}
