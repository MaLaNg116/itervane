import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  repairCandidateManifestSchema, repairCandidateReceiptSchema, repairPatchSchema, repairWorkspaceSchema,
  type RepairPatch,
} from '@itervane/contracts';
import { readBoundedFile, readGuestSnapshotData } from './guest-snapshot.js';
import { sha256, sourceLimits } from './profiles.js';
import { sourcePath } from './snapshot.js';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const comparePaths = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right));

function editText(content: Buffer, edits: RepairPatch['files'][number]['edits']) {
  try {
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(decoder.decode(content))) throw new Error('control byte');
  } catch { throw new Error('repair-text'); }

  const isBoundary = (offset: number) => offset === content.length || (offset < content.length && (content[offset]! & 0xc0) !== 0x80);
  const parts: Buffer[] = [];
  let position = 0;
  for (const edit of edits) {
    if (!isBoundary(edit.startByte) || !isBoundary(edit.endByte)) throw new Error('repair-range');
    parts.push(content.subarray(position, edit.startByte), Buffer.from(edit.replacement));
    position = edit.endByte;
  }
  parts.push(content.subarray(position));
  const result = Buffer.concat(parts);
  if (result.length > sourceLimits.maxFileBytes) throw new Error('repair-size');
  return result;
}

function prepareCandidate(ready: string, rawWorkspace: unknown, rawPatch: unknown) {
  const request = repairWorkspaceSchema.parse(rawWorkspace);
  const workspace = { ...request, editablePaths: request.editablePaths.map(sourcePath).sort(comparePaths),
    protectedPaths: request.protectedPaths.map(sourcePath).sort(comparePaths) };
  const proposal = repairPatchSchema.parse(rawPatch);
  const patch = { ...proposal, files: proposal.files.map(file => ({ ...file, path: sourcePath(file.path) }))
    .sort((left, right) => comparePaths(left.path, right.path)) };
  const { manifest: base, files } = readGuestSnapshotData(ready);
  if (workspace.source.repositoryId !== base.source.repositoryId || workspace.source.commit !== base.source.commit
      || workspace.baseSnapshotSha256 !== base.sha256 || patch.baseSnapshotSha256 !== base.sha256) throw new Error('repair-base');

  const editable = new Set(workspace.editablePaths);
  const protectedPaths = workspace.protectedPaths.map(path => path.toLowerCase());
  const contents = new Map(files.map(file => [file.path, file.content]));
  const metadata = new Map(base.files.map(file => [file.path, file]));
  const changes: { path: string; beforeSha256: string; afterSha256: string; beforeBytes: number; afterBytes: number; edits: number }[] = [];
  let totalBytes = base.totalBytes;
  for (const { path, beforeSha256, edits } of patch.files) {
    const folded = path.toLowerCase();
    if (!editable.has(path) || protectedPaths.some(protectedPath => folded === protectedPath || folded.startsWith(protectedPath + '/'))) {
      throw new Error('repair-scope');
    }
    const before = metadata.get(path);
    const original = contents.get(path);
    if (!before || !original || before.sha256 !== beforeSha256) throw new Error('repair-precondition');
    const updated = editText(original, edits);
    const afterSha256 = sha256(updated);
    if (afterSha256 === beforeSha256) throw new Error('repair-no-change');
    totalBytes += updated.length - original.length;
    contents.set(path, updated);
    metadata.set(path, { ...before, sha256: afterSha256, bytes: updated.length });
    changes.push({ path, beforeSha256, afterSha256, beforeBytes: original.length, afterBytes: updated.length, edits: edits.length });
  }
  const manifest = repairCandidateManifestSchema.parse({
    version: 1, source: base.source, baseSnapshotSha256: base.sha256, files: [...metadata.values()], totalBytes,
  });
  const receipt = repairCandidateReceiptSchema.parse({
    version: 1, operationId: workspace.operationId, repairInputSha256: workspace.repairInputSha256,
    workspaceSha256: sha256(JSON.stringify(workspace)), baseSnapshotSha256: base.sha256, patchSha256: sha256(JSON.stringify(patch)),
    candidateManifestSha256: sha256(JSON.stringify(manifest)), changes,
  });
  return { contents, manifest, patch, receipt };
}

/** The sealed guest supplies a read-only publication and a private writable output directory. */
export function publishGuestRepair(ready: string, output: string, rawWorkspace: unknown, rawPatch: unknown) {
  const target = join(output, 'candidate');
  if (lstatSync(target, { throwIfNoEntry: false })) throw new Error('repair-publication-exists');
  const { contents, manifest, patch, receipt } = prepareCandidate(ready, rawWorkspace, rawPatch);
  const staging = mkdtempSync(join(output, '.candidate-'));
  try {
    for (const file of manifest.files) {
      const destination = join(staging, 'worktree', file.path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o750 });
      writeFileSync(destination, contents.get(file.path)!, { flag: 'wx', mode: file.mode === '100755' ? 0o550 : 0o440 });
      const published = readBoundedFile(destination, file.bytes);
      if (published.length !== file.bytes || sha256(published) !== file.sha256) throw new Error('repair-candidate-integrity');
    }
    writeFileSync(join(staging, 'patch.json'), JSON.stringify(patch), { flag: 'wx', mode: 0o440 });
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o440 });
    writeFileSync(join(staging, 'receipt.json'), JSON.stringify(receipt), { flag: 'wx', mode: 0o440 });
    renameSync(staging, target);
    return receipt;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
