import { isNpmRepairArtifact, npmRegistryTarball, npmRepairPaths, type NpmRepairScope, type RepairPatch } from '@itervane/contracts';
import { findNodeAtLocation, parseTree, type Node as JsonNode, type ParseError } from 'jsonc-parser';
import { repairText } from './guest-repair-source.js';
import { sha256 } from './profiles.js';

const leafFields = new Set(['version', 'resolved', 'integrity', 'license']);
const resolutionFields = ['workspaces', 'overrides', 'resolutions', 'bundledDependencies', 'bundleDependencies'];
const dependencyKinds = ['optionalDependencies', 'devDependencies', 'peerDependencies'];
type FilePatch = RepairPatch['files'][number];

function strictObject(text: string) {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  if (errors.length || root?.type !== 'object') return;
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    const keys = new Set<string>();
    for (const child of node.children ?? []) {
      if (node.type === 'object') {
        const key = child.children?.[0]?.value;
        if (typeof key !== 'string' || keys.has(key)) return;
        keys.add(key);
      }
      pending.push(child);
    }
  }
  return root;
}

function field(root: JsonNode, path: string[], expected: string) {
  const node = findNodeAtLocation(root, path);
  return node?.type === 'string' && node.value === expected ? node : undefined;
}

function edit(text: string, from: number, to: number, replacement: string) {
  return { startByte: Buffer.byteLength(text.slice(0, from)), endByte: Buffer.byteLength(text.slice(0, to)), replacement };
}

function replaceString(text: string, node: JsonNode, value: string) {
  return edit(text, node.offset, node.offset + node.length, JSON.stringify(value));
}

/** Compute the pair from sealed bytes. No source string is used as replacement text. */
export function npmRepairPair(contents: ReadonlyMap<string, Buffer>, { lockPath, approval }: NpmRepairScope): FilePatch[] | undefined {
  const [lockFile, manifestFile] = npmRepairPaths(lockPath);
  const lockBytes = contents.get(lockFile);
  const manifestBytes = contents.get(manifestFile);
  if (!lockBytes || !manifestBytes) return;
  const lock = repairText(lockBytes);
  const manifest = repairText(manifestBytes);
  if (lock === null || manifest === null) return;

  try {
    const lockTree = strictObject(lock);
    const manifestTree = strictObject(manifest);
    if (!lockTree || !manifestTree || findNodeAtLocation(lockTree, ['lockfileVersion'])?.value !== 3) return;
    const lockRoot = findNodeAtLocation(lockTree, ['packages', '']);
    if (lockRoot?.type !== 'object') return;
    const { name, installedVersion, fixedVersion, integrity } = approval;
    if ([lockRoot, manifestTree].some(root => resolutionFields.some(key => findNodeAtLocation(root, [key]))
      || dependencyKinds.some(key => findNodeAtLocation(root, [key, name])))) return;

    const dependency = field(manifestTree, ['dependencies', name], installedVersion);
    const locked = field(lockRoot, ['dependencies', name], installedVersion);
    const leaf = findNodeAtLocation(lockTree, ['packages', `node_modules/${name}`]);
    if (!dependency || !locked || leaf?.type !== 'object'
      || !leaf.children?.every(property => leafFields.has(property.children?.[0]?.value))) return;

    const version = field(leaf, ['version'], installedVersion);
    const resolved = field(leaf, ['resolved'], npmRegistryTarball(name, installedVersion));
    const existingIntegrity = findNodeAtLocation(leaf, ['integrity']);
    if (!version || !resolved || (existingIntegrity && existingIntegrity.type !== 'string')) return;
    const insertAfter = resolved.offset + resolved.length;
    const lockEdits = [
      replaceString(lock, locked, fixedVersion),
      replaceString(lock, version, fixedVersion),
      replaceString(lock, resolved, npmRegistryTarball(name, fixedVersion)),
      existingIntegrity ? replaceString(lock, existingIntegrity, integrity)
        : edit(lock, insertAfter, insertAfter, `, "integrity": ${JSON.stringify(integrity)}`),
    ].sort((left, right) => left.startByte - right.startByte);

    return [
      { path: lockFile, beforeSha256: sha256(lockBytes), edits: lockEdits },
      { path: manifestFile, beforeSha256: sha256(manifestBytes), edits: [replaceString(manifest, dependency, fixedVersion)] },
    ];
  } catch { return undefined; }
}

export function requireNpmRepairPatch(contents: ReadonlyMap<string, Buffer>, files: readonly FilePatch[], scopes: readonly NpmRepairScope[]) {
  const expected = new Map<string, FilePatch>();
  for (const scope of scopes) {
    const pair = npmRepairPair(contents, scope);
    if (!pair) throw new Error('repair-precondition');
    for (const file of pair) {
      if (expected.has(file.path)) throw new Error('repair-scope');
      expected.set(file.path, file);
    }
  }
  const changes = files.filter(file => isNpmRepairArtifact(file.path));
  if (changes.length !== expected.size || changes.some(file => JSON.stringify(file) !== JSON.stringify(expected.get(file.path)))) {
    throw new Error('repair-scope');
  }
}
