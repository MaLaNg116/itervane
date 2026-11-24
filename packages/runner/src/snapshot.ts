import { createHash } from 'node:crypto';
import { sourceRefSchema, type SourceManifest } from '@itervane/contracts';
import { sha256, sourceLimits } from './profiles.js';

export class SourceInputError extends Error {
  constructor(readonly code: 'path_rejected' | 'source_limit' | 'unsupported_entry' | 'commit_mismatch' | 'tree_mismatch') { super(code); }
}
export function sourcePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 240 || Buffer.byteLength(value) > 512 || value.normalize('NFC') !== value) throw new SourceInputError('path_rejected');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[\u0000-\u001f\u007f\\:<>"|?*%]/.test(part)
    || /[. ]$/.test(part) || /^\.git$/i.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new SourceInputError('path_rejected');
  return value;
}
type FileInput = { path: string; mode: string; content: Uint8Array };
type Node = { kind: 'tree'; children: Map<string, Node> } | { kind: 'blob'; mode: string; oid: string };
export type { SourceManifest } from '@itervane/contracts';

/** Receives bytes only. Fetching, checkout, archive extraction and execution are deliberately absent. */
export function verifySourceSnapshot(raw: { source: unknown; commitObject: Uint8Array; files: readonly FileInput[] }): SourceManifest {
  const source = sourceRefSchema.parse(raw.source);
  const objectFormat: 'sha1' | 'sha256' = source.commit.length === 40 ? 'sha1' : 'sha256';
  const gitHash = (kind: string, data: Uint8Array) => createHash(objectFormat).update(`${kind} ${data.byteLength}\0`).update(data).digest('hex');
  if (!(raw.commitObject instanceof Uint8Array) || raw.commitObject.byteLength > sourceLimits.maxCommitBytes || !Array.isArray(raw.files) || raw.files.length > sourceLimits.maxFiles) throw new SourceInputError('source_limit');
  if (gitHash('commit', raw.commitObject) !== source.commit) throw new SourceInputError('commit_mismatch');
  const header = Buffer.from(raw.commitObject).toString('utf8').split('\n\n')[0] ?? '';
  const tree = new RegExp(`^tree ([a-f0-9]{${source.commit.length}})\\n`).exec(header)?.[1];
  if (!tree || !/^author .+$/m.test(header) || !/^committer .+$/m.test(header)) throw new SourceInputError('commit_mismatch');
  const root: Extract<Node, { kind: 'tree' }> = { kind: 'tree', children: new Map() };
  const names = new Set<string>(); let totalBytes = 0;
  const files: SourceManifest['files'] = [];
  for (const file of raw.files) {
    const path = sourcePath(file.path); const folded = path.toLowerCase();
    if (names.has(folded)) throw new SourceInputError('path_rejected'); names.add(folded);
    if (file.mode !== '100644' && file.mode !== '100755') throw new SourceInputError('unsupported_entry');
    if (!(file.content instanceof Uint8Array) || file.content.byteLength > sourceLimits.maxFileBytes || (totalBytes += file.content.byteLength) > sourceLimits.maxSourceBytes) throw new SourceInputError('source_limit');
    if (/^version https:\/\/git-lfs.github.com\/spec\/v1\r?\n/.test(Buffer.from(file.content.subarray(0, 128)).toString('utf8'))) throw new SourceInputError('unsupported_entry');
    const parts = path.split('/'); let node = root;
    for (const part of parts.slice(0, -1)) {
      const found = node.children.get(part);
      if (found && found.kind !== 'tree') throw new SourceInputError('path_rejected');
      if (!found) node.children.set(part, { kind: 'tree', children: new Map() });
      node = node.children.get(part) as typeof root;
    }
    const name = parts.at(-1)!;
    if (node.children.has(name)) throw new SourceInputError('path_rejected');
    node.children.set(name, { kind: 'blob', mode: file.mode, oid: gitHash('blob', file.content) });
    files.push({ path, mode: file.mode, bytes: file.content.byteLength, sha256: sha256(file.content) });
  }
  // Git compares a directory as "name/", not simply locale-sorted path strings.
  const treeHash = (node: typeof root): string => gitHash('tree', Buffer.concat([...node.children.entries()]
    .sort(([a, x], [b, y]) => Buffer.compare(Buffer.from(a + (x.kind === 'tree' ? '/' : '')), Buffer.from(b + (y.kind === 'tree' ? '/' : ''))))
    .map(([name, child]) => Buffer.concat([Buffer.from(`${child.kind === 'tree' ? '40000' : child.mode} ${name}\0`), Buffer.from(child.kind === 'tree' ? treeHash(child) : child.oid, 'hex')]))));
  if (treeHash(root) !== tree) throw new SourceInputError('tree_mismatch');
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  // Also reject directory case collisions and a file used as a case-insensitive ancestor.
  const paths = new Map<string, string>();
  for (const file of files) for (let end = 1, parts = file.path.split('/'); end <= parts.length; end++) {
    const path = parts.slice(0, end).join('/'); const old = paths.get(path.toLowerCase());
    if (old !== undefined && old !== path) throw new SourceInputError('path_rejected'); paths.set(path.toLowerCase(), path);
  }
  const body = { version: 1 as const, source, objectFormat, tree, files, totalBytes };
  return { ...body, sha256: sha256(JSON.stringify(body)) };
}
