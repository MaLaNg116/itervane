import { execFileSync } from 'node:child_process';
import {
  chmodSync, closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readdirSync, readSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { sourceRefSchema, sha256Schema } from '@itervane/contracts';
import { z } from 'zod';
import { sourceLimits } from './profiles.js';
import { sourcePath, verifySourceSnapshot, type SourceManifest } from './snapshot.js';

const regularMode = z.enum(['100644', '100755']);
const entrySchema = z.strictObject({ path: z.string().min(1).max(240), mode: regularMode });
const publicationSchema = z.strictObject({
  runId: z.uuidv4(), source: sourceRefSchema, manifestSha256: sha256Schema,
  mode: z.enum(['fixture', 'qualified', 'repair', 'repair-observation', 'verification']),
  entries: z.array(entrySchema).min(1).max(sourceLimits.maxFiles),
});
const publicationBytes = 3 * 1024 * 1024;
const gitEnv = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
type Source = SourceManifest['source'];
type Entry = z.infer<typeof entrySchema>;

function gitRead(repository: string, args: string[], maxBuffer: number, input?: string) {
  return execFileSync('/usr/bin/git', ['-C', repository, '--no-replace-objects', ...args], {
    maxBuffer, input, env: gitEnv, timeout: 15_000, killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function readGitObjects(repository: string, source: Source) {
  const records = decoder.decode(gitRead(repository, ['ls-tree', '-rz', '--full-tree', source.commit],
    sourceLimits.maxFiles * 600)).split('\0');
  if (records.pop() !== '' || records.length === 0 || records.length > sourceLimits.maxFiles) throw new Error('snapshot-tree');
  const objectId = new RegExp(`^[0-9a-f]{${source.commit.length}}$`);
  const entries = records.map(record => {
    const tab = record.indexOf('\t');
    const [mode, type, oid, ...extra] = record.slice(0, tab).split(' ');
    if (tab < 0 || type !== 'blob' || !oid || !objectId.test(oid) || extra.length) throw new Error('snapshot-tree');
    return { mode: regularMode.parse(mode), oid, path: sourcePath(record.slice(tab + 1)) };
  });
  const queries = [source.commit, ...entries.map(entry => entry.oid)];
  const bytes = gitRead(repository, ['cat-file', '--batch'],
    sourceLimits.maxSourceBytes + sourceLimits.maxCommitBytes + queries.length * 96, queries.join('\n') + '\n');
  let position = 0;
  const contents = queries.map((oid, index) => {
    const split = bytes.indexOf(10, position);
    if (split < position || split - position > 95) throw new Error('snapshot-object');
    const [actual, type, sizeText, ...extra] = bytes.toString('ascii', position, split).split(' ');
    const size = Number(sizeText);
    const isCommit = index === 0;
    const maxBytes = isCommit ? sourceLimits.maxCommitBytes : sourceLimits.maxFileBytes;
    if (actual !== oid || type !== (isCommit ? 'commit' : 'blob') || extra.length
        || !sizeText || !/^(?:0|[1-9]\d{0,7})$/.test(sizeText) || size > maxBytes) throw new Error('snapshot-object');
    const end = split + 1 + size;
    if (end >= bytes.length || bytes[end] !== 10) throw new Error('snapshot-object');
    position = end + 1;
    return bytes.subarray(split + 1, end);
  });
  if (position !== bytes.length) throw new Error('snapshot-object');
  const [commitObject, ...blobs] = contents;
  const files = entries.map(({ path, mode }, index) => ({ path, mode, content: blobs[index]! }));
  return { commitObject: commitObject!, files };
}

export function readBoundedFile(path: string, maxBytes: number) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) throw new Error('snapshot-file');
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) throw new Error('snapshot-file');
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null)) throw new Error('snapshot-file');
    return bytes;
  } finally { closeSync(fd); }
}

function createTree(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o2750 });
}

function publishFile(path: string, data: Uint8Array | string) {
  writeFileSync(path, data, { flag: 'wx', mode: 0o440 });
}

export function isNpmLock(path: string) {
  return /(?:^|\/)package-lock\.json$/.test(path);
}

/** The caller is the sealed acquisition service and provides the bare Git store. */
export function publishGuestSnapshot(
  base: string, repository: string, runId: string, rawSource: Source,
  mode: z.infer<typeof publicationSchema>['mode'] = 'fixture',
) {
  const source = sourceRefSchema.parse(rawSource);
  const { commitObject, files } = readGitObjects(repository, source);
  const manifest = verifySourceSnapshot({ source, commitObject, files });
  const publication = publicationSchema.parse({
    runId, source, mode, manifestSha256: manifest.sha256, entries: files.map(({ path, mode }) => ({ path, mode })),
  });
  const ready = join(base, 'ready');
  if (lstatSync(ready, { throwIfNoEntry: false })) throw new Error('snapshot-exists');
  const staging = mkdtempSync(join(base, '.staged-'));
  try {
    // The shared parent supplies the inspection group via setgid.
    const tree = join(staging, 'worktree');
    const inventory = join(staging, 'npm');
    createTree(tree);
    createTree(inventory);
    for (const file of files) {
      const path = join(tree, file.path);
      createTree(dirname(path));
      publishFile(path, file.content);
      if (isNpmLock(file.path)) {
        const npm = join(inventory, file.path);
        createTree(dirname(npm));
        linkSync(path, npm);
      }
    }
    publishFile(join(staging, 'commit.object'), commitObject);
    publishFile(join(staging, 'snapshot.json'), JSON.stringify(publication));
    chmodSync(staging, 0o2750);
    renameSync(staging, ready);
    return manifest;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function snapshotPaths(root: string) {
  const files: string[] = []; const directories = [root];
  let visited = 0;
  while (directories.length) {
    const path = directories.pop()!;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const name = join(path, entry.name);
      sourcePath(relative(root, name));
      if (++visited > sourceLimits.maxFiles * 120) throw new Error('snapshot-file');
      if (entry.isDirectory()) directories.push(name);
      else if (entry.isFile() && files.length < sourceLimits.maxFiles) files.push(relative(root, name));
      else throw new Error('snapshot-file');
    }
  }
  return files.sort();
}

function assertPaths(root: string, expected: readonly Entry[]) {
  const paths = snapshotPaths(root);
  if (paths.length !== expected.length || JSON.stringify(paths) !== JSON.stringify(expected.map(entry => entry.path).sort())) {
    throw new Error('snapshot-file');
  }
}

/** Read the entire published tree and verify its restricted npm scan view. */
export function readPublishedWorktree(ready: string, entries: readonly Entry[]) {
  const tree = join(ready, 'worktree');
  const npm = join(ready, 'npm');
  for (const entry of entries) sourcePath(entry.path);
  const locks = entries.filter(entry => isNpmLock(entry.path));
  assertPaths(tree, entries);
  assertPaths(npm, locks);
  for (const lock of locks) {
    const original = lstatSync(join(tree, lock.path));
    const projected = lstatSync(join(npm, lock.path));
    if (!projected.isFile() || projected.dev !== original.dev || projected.ino !== original.ino) throw new Error('snapshot-inventory');
  }
  let total = 0;
  return entries.map(entry => {
    const content = readBoundedFile(join(tree, entry.path), Math.min(sourceLimits.maxFileBytes, sourceLimits.maxSourceBytes - total));
    total += content.length;
    return { ...entry, content };
  });
}

/** Recheck the published bytes in the scanner namespace, where the mount is read-only. */
export function readGuestSnapshotData(ready: string) {
  const publication = publicationSchema.parse(JSON.parse(readBoundedFile(join(ready, 'snapshot.json'), publicationBytes).toString('utf8')));
  const files = readPublishedWorktree(ready, publication.entries);
  const commitObject = readBoundedFile(join(ready, 'commit.object'), sourceLimits.maxCommitBytes);
  const manifest = verifySourceSnapshot({ source: publication.source, commitObject, files });
  if (manifest.sha256 !== publication.manifestSha256) throw new Error('snapshot-manifest');
  return { runId: publication.runId, mode: publication.mode, manifest, files };
}

export function readGuestSnapshot(ready: string) {
  const { runId, mode, manifest } = readGuestSnapshotData(ready);
  return { runId, mode, manifest };
}
