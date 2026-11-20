import { repairCommandByteLimit, repairPatchSchema, repairWorkspaceSchema } from '@itervane/contracts';
import { sha256 } from './profiles.js';
import { sourcePath } from './snapshot.js';

const byPath = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right));

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
