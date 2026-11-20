import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { repairCandidateManifestSchema, repairPatchLimits, repairPatchSchema } from '@itervane/contracts';
import { describe, expect, it } from 'vitest';
import { publishGuestRepair } from '../../src/guest-repair.js';
import { publishGuestSnapshot, readGuestSnapshot } from '../../src/guest-snapshot.js';
import { sha256 } from '../../src/profiles.js';
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
  it('replays the same patch into an independent candidate with exact bytes and stable digests', async () => {
    const text = Buffer.from('first\r\n示例\r\nlast\r\n');
    const script = Buffer.from('#!/bin/sh\nprintf old\n');
    const binary = Buffer.from([0, 255, 10]);
    const sample = await trustedGitFixture('sha1', { 'src/value.txt': text, 'check.sh': script, 'baseline/data': binary });
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
      const exported = await readFile(join(candidate, 'patch.json'), 'utf8');
      expect(sha256(exported)).toBe(firstReceipt.patchSha256);
      expect(exported).not.toContain('示例');
      expect(() => publishGuestRepair(ready, first, workspace, patch)).toThrow('repair-publication-exists');
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
