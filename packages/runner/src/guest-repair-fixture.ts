import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { publishGuestRepair } from './guest-repair.js';
import { readBoundedFile, readGuestSnapshot } from './guest-snapshot.js';
import { sha256 } from './profiles.js';

const path = 'fixtures/runner/inspection-input/README.md';
const replacement = '\nRepair replays against the sealed snapshot.\n';

/** Used by the fixed native sample in the sealed scanner namespace. */
export function exerciseGuestRepair(ready: string, output: string, manifest: ReturnType<typeof readGuestSnapshot>['manifest']) {
  const file = manifest.files.find(entry => entry.path === path);
  assert.ok(file);
  const source = join(ready, 'worktree', path);
  const original = readBoundedFile(source, file.bytes);
  const chineseStartByte = original.indexOf(Buffer.from('离'));
  assert.ok(chineseStartByte >= 0);
  const first = join(output, 'repair-first');
  const second = join(output, 'repair-replay');
  mkdirSync(first, { mode: 0o700 });
  mkdirSync(second, { mode: 0o700 });

  const workspace = {
    version: 1, operationId: randomUUID(), source: manifest.source, repairInputSha256: sha256('native repair fixture'),
    baseSnapshotSha256: manifest.sha256, editablePaths: [path], protectedPaths: [],
  };
  const edit = { startByte: original.length, endByte: original.length, replacement };
  const proposed = { path, beforeSha256: file.sha256, edits: [edit] };
  const patch = { version: 1, baseSnapshotSha256: manifest.sha256, files: [proposed] };
  assert.throws(() => publishGuestRepair(ready, first, { ...workspace, protectedPaths: [path] }, patch), { message: 'repair-scope' });
  assert.throws(() => publishGuestRepair(ready, first, workspace, {
    ...patch, files: [{ ...proposed, beforeSha256: sha256('stale revision') }],
  }), { message: 'repair-precondition' });
  assert.throws(() => publishGuestRepair(ready, first, workspace, {
    ...patch, files: [{ ...proposed, edits: [{ ...edit, startByte: chineseStartByte + 1, endByte: chineseStartByte + 3 }] }],
  }), { message: 'repair-range' });
  assert.deepEqual(readdirSync(first), []);

  const receipt = publishGuestRepair(ready, first, workspace, patch);
  const replay = publishGuestRepair(ready, second, workspace, patch);
  assert.deepEqual(replay, receipt);
  const expected = Buffer.concat([original, Buffer.from(replacement)]);
  for (const directory of [first, second]) {
    assert.deepEqual(readBoundedFile(join(directory, 'candidate', 'worktree', path), expected.length), expected);
  }
  assert.equal(readGuestSnapshot(ready).manifest.sha256, manifest.sha256);
  assert.deepEqual(readBoundedFile(source, file.bytes), original);
  assert.equal(receipt.changes[0]?.afterSha256, sha256(expected));
  return {
    path, baseSnapshotSha256: manifest.sha256, beforeSha256: file.sha256, afterSha256: sha256(expected),
    patchSha256: receipt.patchSha256, candidateManifestSha256: receipt.candidateManifestSha256, replayed: true,
    protectedRejected: true, staleRejected: true, rangeRejected: true, originalRetained: true,
  };
}
