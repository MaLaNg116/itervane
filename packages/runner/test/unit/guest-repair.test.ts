import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { qualifiedRepairRequestSchema, repairCandidateManifestSchema, repairPatchLimits, repairPatchSchema,
  type QualifiedRepairReceipt } from '@itervane/contracts';
import { describe, expect, it } from 'vitest';
import { publishGuestRepair, readGuestCandidate, repairQualifiedGuestSnapshot } from '../../src/guest-repair.js';
import { publishGuestSnapshot, readGuestSnapshot } from '../../src/guest-snapshot.js';
import { sha256 } from '../../src/profiles.js';
import { verifyQualifiedRepairReceipt } from '../../src/qualified-client.js';
import { canonicalRepairCommand } from '../../src/repair-command.js';
import { trustedGitFixture } from '../helpers/trusted-git.js';

it('bounds real byte ranges, file aliases and aggregate replacement size in the patch contract', () => {
  const digest = 'a'.repeat(64);
  const replace = { startByte: 0, endByte: 1, replacement: 'next' };
  const file = { path: 'src/main.ts', beforeSha256: digest, edits: [replace] };
  const patch = { version: 1, baseSnapshotSha256: digest, files: [file] };
  expect(repairPatchSchema.safeParse(patch).success).toBe(true);
  expect(repairPatchSchema.safeParse({ ...patch, files: [file, { ...file, path: 'src/MAIN.ts' }] }).success).toBe(false);
  expect(repairPatchSchema.safeParse({ ...patch, files: [{ ...file, edits: [replace, { ...replace, endByte: 2 }] }] }).success).toBe(false);
  const large = '字'.repeat(Math.floor(repairPatchLimits.replacementBytes / 3));
  expect(repairPatchSchema.safeParse({ ...patch, files: [{ ...file, edits: [{ ...replace, replacement: large },
    { startByte: 1, endByte: 2, replacement: '超出' }] }] }).success).toBe(false);
  expect(repairPatchSchema.safeParse({ ...patch, files: [{ ...file, edits: [{ ...replace, replacement: '\ud800' }] }] }).success).toBe(false);
});

describe.runIf(process.platform === 'linux')('repair publication from verified guest bytes', () => {
  it('requires a canonical private command and a repair snapshot before producing a scoped receipt', async () => {
    const path = 'src/text';
    const original = Buffer.from('Original\n');
    const sample = await trustedGitFixture('sha1', { [path]: original });
    try {
      const source = join(sample.root, 'source'); const scanner = join(sample.root, 'scanner');
      const output = join(sample.root, 'output');
      await Promise.all([mkdir(source), mkdir(scanner), mkdir(output)]);
      const domain = randomUUID();
      publishGuestSnapshot(source, sample.root, domain, sample.source, 'repair');
      publishGuestSnapshot(scanner, sample.root, domain, sample.source, 'qualified');
      const workspace = { version: 1, operationId: randomUUID(), source: sample.source, repairInputSha256: sha256('input'),
        baseSnapshotSha256: sample.manifest.sha256, editablePaths: [path], protectedPaths: [] };
      const patch = { version: 1, baseSnapshotSha256: sample.manifest.sha256, files: [{ path, beforeSha256: sha256(original),
        edits: [{ startByte: 0, endByte: 8, replacement: 'Updated' }] }] };
      const command = canonicalRepairCommand(workspace, patch);
      await writeFile(join(source, 'repair-command.json'), Buffer.concat([command.bytes, Buffer.from('\n')]));
      await writeFile(join(scanner, 'repair-command.json'), command.bytes);
      expect(() => repairQualifiedGuestSnapshot(source, output)).toThrow('repair-invalid');
      expect(() => repairQualifiedGuestSnapshot(scanner, output)).toThrow('repair-integrity');
      expect(await readdir(output)).toEqual([]);
      await writeFile(join(source, 'repair-command.json'), command.bytes);
      const proof = repairQualifiedGuestSnapshot(source, output);
      expect(proof).toMatchObject({ runId: domain, ...sample.source, manifestSha256: sample.manifest.sha256,
        commandSha256: sha256(command.bytes), offline: true, readOnly: true,
        candidate: { operationId: workspace.operationId, patchSha256: command.patchSha256, workspaceSha256: command.workspaceSha256 } });
      expect(JSON.stringify(proof)).not.toContain('Updated');
      const request = qualifiedRepairRequestSchema.parse({ version: 1, operation: 'apply_repair', operationId: workspace.operationId,
        requestId: randomUUID(), taskId: randomUUID(), runId: randomUUID(), projectId: randomUUID(), ...sample.source,
        generation: 1, fence: 3, workspaceSha256: sha256('controller workspace'), repairInputSha256: workspace.repairInputSha256,
        baseSnapshotSha256: proof.manifestSha256, commandSha256: proof.commandSha256, commandBytes: command.bytes.length,
        origin: 'https://example.invalid/source.git' });
      const { origin, ...scope } = request;
      const imageSha256 = sha256('trusted image');
      const receipt: QualifiedRepairReceipt = { kind: 'repair_receipt', scope, domainId: domain, imageSha256,
        originSha256: sha256(origin), commitSha256: sha256(sample.commitObject), cleanupConfirmed: true,
        sessionVerified: true, snapshot: proof };
      expect(() => verifyQualifiedRepairReceipt(receipt, request, command, imageSha256)).not.toThrow();
      expect(() => verifyQualifiedRepairReceipt({ ...receipt, scope: { ...scope, fence: 2 } }, request, command, imageSha256))
        .toThrow('runner_repair_receipt_binding');
      const wrongByteCount = { ...proof.candidate, changes: proof.candidate.changes.map(change => ({ ...change, afterBytes: 20 })) };
      expect(() => verifyQualifiedRepairReceipt({ ...receipt, snapshot: { ...proof, candidate: wrongByteCount } }, request, command, imageSha256))
        .toThrow('runner_repair_receipt_change');
    } finally { await sample.close(); }
  });

  it('replays the same patch into an independent candidate with exact bytes and stable digests', async () => {
    const text = Buffer.from('first\r\n示例\r\nlast\r\n');
    const script = Buffer.from('#!/bin/sh\nprintf old\n');
    const binary = Buffer.from([0, 255, 10]);
    const lock = Buffer.from('{"name":"test-fixture","lockfileVersion":3,"packages":{}}\n');
    const lockPath = 'example/package-lock.json';
    const sample = await trustedGitFixture('sha1', { 'src/value.txt': text, 'check.sh': script, 'baseline/data': binary, [lockPath]: lock });
    try {
      const base = join(sample.root, 'published'); const first = join(sample.root, 'first'); const second = join(sample.root, 'second');
      await Promise.all([mkdir(base), mkdir(first), mkdir(second)]);
      const runId = randomUUID();
      publishGuestSnapshot(base, sample.root, runId, sample.source);
      const ready = join(base, 'ready');
      const workspace = { version: 1, operationId: randomUUID(), source: sample.source, repairInputSha256: sha256('input'),
        baseSnapshotSha256: sample.manifest.sha256, editablePaths: ['src/value.txt', 'check.sh'], protectedPaths: ['baseline'] };
      const patch = { version: 1, baseSnapshotSha256: sample.manifest.sha256, files: [
        { path: 'src/value.txt', beforeSha256: sha256(text), edits: [{ startByte: 7, endByte: 13, replacement: '修复' }] },
        { path: 'check.sh', beforeSha256: sha256(script), edits: [{ startByte: script.length, endByte: script.length, replacement: '# note\n' }] },
      ] };

      const firstReceipt = publishGuestRepair(ready, first, workspace, patch);
      expect(publishGuestRepair(ready, second, { ...workspace, editablePaths: [...workspace.editablePaths].reverse() },
        { ...patch, files: [...patch.files].reverse() })).toEqual(firstReceipt);
      expect(readGuestSnapshot(ready).manifest).toEqual(sample.manifest);
      const candidate = join(first, 'candidate');
      expect(await readFile(join(candidate, 'worktree/src/value.txt'))).toEqual(Buffer.from('first\r\n修复\r\nlast\r\n'));
      expect(await readFile(join(candidate, 'worktree/check.sh'))).toEqual(Buffer.concat([script, Buffer.from('# note\n')]));
      expect(await readFile(join(candidate, 'worktree/baseline/data'))).toEqual(binary);
      const manifest = repairCandidateManifestSchema.parse(JSON.parse(await readFile(join(candidate, 'manifest.json'), 'utf8')));
      expect(manifest.files.find(file => file.path === 'check.sh')?.mode).toBe('100755');
      expect(sha256(JSON.stringify(manifest))).toBe(firstReceipt.candidateManifestSha256);
      expect(readGuestCandidate(candidate, firstReceipt.candidateManifestSha256).manifest).toEqual(manifest);
      expect(() => readGuestCandidate(candidate, sha256('another manifest'))).toThrow('repair-candidate-integrity');
      const projected = join(candidate, 'npm', lockPath);
      expect((await lstat(projected)).ino).toBe((await lstat(join(candidate, 'worktree', lockPath))).ino);
      const exported = await readFile(join(candidate, 'patch.json'), 'utf8');
      expect(sha256(exported)).toBe(firstReceipt.patchSha256);
      expect(exported).not.toContain('示例');
      expect(() => publishGuestRepair(ready, first, workspace, patch)).toThrow('repair-publication-exists');
      await chmod(join(second, 'candidate/worktree/check.sh'), 0o440);
      expect(() => readGuestCandidate(join(second, 'candidate'), firstReceipt.candidateManifestSha256)).toThrow('repair-candidate-integrity');
      await unlink(projected);
      await writeFile(projected, lock, { mode: 0o440 });
      expect(() => readGuestCandidate(candidate, firstReceipt.candidateManifestSha256)).toThrow('snapshot-inventory');
    } finally { await sample.close(); }
  });

  it('leaves the candidate directory empty after any stale, disallowed or invalid file edit', async () => {
    const text = Buffer.from('标记\n'); const other = Buffer.from('baseline\n');
    const sample = await trustedGitFixture('sha1', { 'src/text': text, 'baseline/check': other, 'binary': Buffer.from([0, 255]) });
    try {
      const base = join(sample.root, 'published'); const output = join(sample.root, 'output');
      await Promise.all([mkdir(base), mkdir(output)]);
      publishGuestSnapshot(base, sample.root, randomUUID(), sample.source);
      const ready = join(base, 'ready');
      const workspace = { version: 1, operationId: randomUUID(), source: sample.source, repairInputSha256: sha256('input'),
        baseSnapshotSha256: sample.manifest.sha256, editablePaths: ['src/text', 'baseline/check', 'binary'], protectedPaths: ['BASELINE'] };
      const file = { path: 'src/text', beforeSha256: sha256(text), edits: [{ startByte: 0, endByte: 3, replacement: '新' }] };
      const patch = { version: 1, baseSnapshotSha256: sample.manifest.sha256, files: [file] };
      expect(() => publishGuestRepair(ready, output, workspace, { ...patch, baseSnapshotSha256: sha256('previous tree') })).toThrow('repair-base');
      expect(() => publishGuestRepair(ready, output, workspace, { ...patch, files: [{ ...file, beforeSha256: sha256('old') }] })).toThrow('repair-precondition');
      expect(() => publishGuestRepair(ready, output, workspace, { ...patch, files: [file,
        { ...file, path: 'baseline/check', beforeSha256: sha256(other) }] })).toThrow('repair-scope');
      expect(() => publishGuestRepair(ready, output, workspace, { ...patch, files: [{ ...file, path: '../src/text' }] })).toThrow('path_rejected');
      expect(() => publishGuestRepair(ready, output, workspace, { ...patch, files: [{ ...file,
        edits: [{ startByte: 1, endByte: 3, replacement: 'x' }] }] })).toThrow('repair-range');
      expect(() => publishGuestRepair(ready, output, workspace, { ...patch, files: [{ ...file, path: 'binary',
        beforeSha256: sha256(Buffer.from([0, 255])) }] })).toThrow('repair-text');
      expect(() => publishGuestRepair(ready, output, workspace, { ...patch, files: [{ ...file,
        edits: [{ ...file.edits[0], replacement: '标' }] }] })).toThrow('repair-no-change');
      expect(await readdir(output)).toEqual([]);
      expect(await readFile(join(ready, 'worktree/src/text'))).toEqual(text);
    } finally { await sample.close(); }
  });
});
