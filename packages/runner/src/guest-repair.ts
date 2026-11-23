import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  healthRepairSourceBytes, qualifiedGuestRepairProofSchema, repairCandidateManifestSchema, repairCandidateReceiptSchema,
  repairCommandByteLimit, repairCommandSchema,
  type RepairPatch,
} from '@itervane/contracts';
import { isNpmLock, readBoundedFile, readGuestSnapshotData, readPublishedWorktree } from './guest-snapshot.js';
import { sha256, sourceLimits } from './profiles.js';
import { canonicalRepairCommand, protectedRepairPath } from './repair-command.js';
import { readRepairSource, repairText } from './guest-repair-source.js';
import { requireNpmRepairPatch } from './npm-repair.js';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
type RepairCommand = ReturnType<typeof canonicalRepairCommand>;
const publishedMode = (mode: '100644' | '100755') => mode === '100755' ? 0o550 : 0o440;

function editText(content: Buffer, edits: RepairPatch['files'][number]['edits']) {
  if (repairText(content) === null) throw new Error('repair-text');

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

function prepareCandidate({ manifest: base, files }: ReturnType<typeof readGuestSnapshotData>, command: RepairCommand) {
  const { workspace, patch, workspaceSha256, patchSha256 } = command;
  if (workspace.source.repositoryId !== base.source.repositoryId || workspace.source.commit !== base.source.commit
      || workspace.baseSnapshotSha256 !== base.sha256) throw new Error('repair-base');

  const editable = new Set(workspace.editablePaths);
  const contents = new Map(files.map(file => [file.path, file.content]));
  const metadata = new Map(base.files.map(file => [file.path, file]));
  requireNpmRepairPatch(contents, patch.files, workspace.npmRepairs ?? []);
  const changes: { path: string; beforeSha256: string; afterSha256: string; beforeBytes: number; afterBytes: number; edits: number }[] = [];
  let totalBytes = base.totalBytes;
  for (const { path, beforeSha256, edits } of patch.files) {
    if (!editable.has(path) || protectedRepairPath(path, workspace.protectedPaths)) {
      throw new Error('repair-scope');
    }
    const before = metadata.get(path);
    const original = contents.get(path);
    if (!before || !original || before.sha256 !== beforeSha256) throw new Error('repair-precondition');
    const updated = editText(original, edits);
    if (workspace.healthReproductionSha256 && (!original.length || !updated.length
        || original.length > healthRepairSourceBytes || updated.length > healthRepairSourceBytes)) throw new Error('repair-scope');
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
    workspaceSha256, baseSnapshotSha256: base.sha256, patchSha256,
    candidateManifestSha256: sha256(JSON.stringify(manifest)), changes,
  });
  return { contents, manifest, patch, receipt };
}

/** Verify a reconstructed candidate by its independently recorded manifest. */
export function readGuestCandidate(ready: string, expectedManifestSha256: string) {
  const manifest = repairCandidateManifestSchema.parse(JSON.parse(readBoundedFile(join(ready, 'manifest.json'), 4 * 1024 * 1024).toString('utf8')));
  if (sha256(JSON.stringify(manifest)) !== expectedManifestSha256) throw new Error('repair-candidate-integrity');
  const files = readPublishedWorktree(ready, manifest.files);
  for (const [index, file] of files.entries()) {
    const { sha256: expected, bytes, mode } = manifest.files[index]!;
    const permissions = lstatSync(join(ready, 'worktree', file.path)).mode & 0o777;
    if (file.content.length !== bytes || sha256(file.content) !== expected || permissions !== publishedMode(mode)) {
      throw new Error('repair-candidate-integrity');
    }
  }
  return { manifest, files };
}

function publishCandidate(output: string, snapshot: ReturnType<typeof readGuestSnapshotData>, command: RepairCommand,
  expectedManifestSha256?: string) {
  const target = join(output, 'candidate');
  if (lstatSync(target, { throwIfNoEntry: false })) throw new Error('repair-publication-exists');
  const { contents, manifest, patch, receipt } = prepareCandidate(snapshot, command);
  if (expectedManifestSha256 !== undefined && receipt.candidateManifestSha256 !== expectedManifestSha256) {
    throw new Error('verify-replay');
  }
  const staging = mkdtempSync(join(output, '.candidate-'));
  try {
    const inventory = join(staging, 'npm');
    mkdirSync(inventory, { mode: 0o750 });
    for (const file of manifest.files) {
      const destination = join(staging, 'worktree', file.path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o750 });
      writeFileSync(destination, contents.get(file.path)!, { flag: 'wx', mode: publishedMode(file.mode) });
      if (isNpmLock(file.path)) {
        const projected = join(inventory, file.path);
        mkdirSync(dirname(projected), { recursive: true, mode: 0o750 });
        linkSync(destination, projected);
      }
    }
    writeFileSync(join(staging, 'patch.json'), JSON.stringify(patch), { flag: 'wx', mode: 0o440 });
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o440 });
    writeFileSync(join(staging, 'receipt.json'), JSON.stringify(receipt), { flag: 'wx', mode: 0o440 });
    readGuestCandidate(staging, receipt.candidateManifestSha256);
    if (expectedManifestSha256 !== undefined) chmodSync(staging, 0o2750);
    renameSync(staging, target);
    return receipt;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** The sealed guest supplies a read-only publication and a private writable output directory. */
export function publishGuestRepair(ready: string, output: string, rawWorkspace: unknown, rawPatch: unknown) {
  const command = canonicalRepairCommand(rawWorkspace, rawPatch);
  return publishCandidate(output, readGuestSnapshotData(ready), command);
}

/** Publish a verified replay in the acquisition tree for the read-only scanner mount. */
export function publishGuestVerificationCandidate(output: string, snapshot: ReturnType<typeof readGuestSnapshotData>,
  material: Pick<RepairCommand, 'workspace' | 'patch'>, expectedManifestSha256: string) {
  if (snapshot.mode !== 'verification') throw new Error('verify-binding');
  return publishCandidate(output, snapshot, canonicalRepairCommand(material.workspace, material.patch), expectedManifestSha256);
}

export function repairQualifiedGuestSnapshot(source: string, output: string) {
  const bytes = readBoundedFile(join(source, 'repair-command.json'), repairCommandByteLimit);
  let command: RepairCommand;
  try {
    const raw = repairCommandSchema.parse(JSON.parse(decoder.decode(bytes)));
    command = canonicalRepairCommand(raw.workspace, raw.patch);
  } catch (error) {
    if (error instanceof Error && error.message === 'repair-base') throw error;
    throw new Error('repair-invalid');
  }
  if (!bytes.equals(command.bytes)) throw new Error('repair-invalid');
  const { fixed, proof } = readRepairSource(source, bytes, 'repair');
  const candidate = publishCandidate(output, fixed, command);
  return qualifiedGuestRepairProofSchema.parse({ ...proof, candidate });
}
