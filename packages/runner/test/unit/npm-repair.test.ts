import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { npmRegistryTarball, npmUpgradeApprovalsSchema, qualifiedRepairObservationRequestSchema, type NpmRepairScope,
  type QualifiedRepairObservationReceipt, type RepairTarget } from '@itervane/contracts';
import { describe, expect, it } from 'vitest';
import { observeQualifiedRepairTargets } from '../../src/guest-repair-observation.js';
import { publishGuestRepair } from '../../src/guest-repair.js';
import { publishGuestSnapshot } from '../../src/guest-snapshot.js';
import { npmRepairPair } from '../../src/npm-repair.js';
import { sha256 } from '../../src/profiles.js';
import { verifyQualifiedRepairObservation } from '../../src/qualified-client.js';
import { canonicalRepairObservation } from '../../src/repair-command.js';
import { trustedGitFixture } from '../helpers/trusted-git.js';

const lockPath = 'demo/package-lock.json';
const manifestPath = 'demo/package.json';
const name = '@example/leaf';
const previous = '1.0.0';
const next = '1.1.0';
const approval: NpmRepairScope['approval'] = { advisoryId: 'CVE-2021-23337', name, installedVersion: previous,
  fixedVersion: next, integrity: `sha512-${'A'.repeat(86)}==`,
};
const scope: NpmRepairScope = { findingId: sha256('approved advisory'), lockPath, approval };
const scripts = { keep: 'synthetic-script-marker' };
const manifestRecord = { name: '示例', scripts, dependencies: { [name]: previous, other: '2.3.4' } };
const lockRecord = { lockfileVersion: 3, packages: {
  '': { name: '示例', dependencies: manifestRecord.dependencies },
  [`node_modules/${name}`]: { version: previous, resolved: npmRegistryTarball(name, previous) },
  'node_modules/other': { version: '2.3.4', resolved: npmRegistryTarball('other', '2.3.4') },
} };
const document = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const input = new Map([[lockPath, document(lockRecord)], [manifestPath, document(manifestRecord)]]);

it('requires exact reviewed upgrades and rejects ambiguous package or JSON resolution', () => {
  expect(npmUpgradeApprovalsSchema.safeParse([approval]).success).toBe(true);
  expect(npmUpgradeApprovalsSchema.safeParse([approval, { ...approval, fixedVersion: '1.2.0' }]).success).toBe(false);
  expect(npmUpgradeApprovalsSchema.safeParse([{ ...approval, fixedVersion: previous }]).success).toBe(false);
  const variants = [
    new Map([[lockPath, input.get(lockPath)!]]),
    new Map(input).set(lockPath, document({ ...lockRecord, lockfileVersion: 2 })),
    new Map(input).set(manifestPath, document({ ...manifestRecord, overrides: { [name]: previous } })),
    new Map(input).set(manifestPath, document({ ...manifestRecord, dependencies: { [name]: '^1.0.0' } })),
    new Map(input).set(manifestPath, Buffer.from(`{"dependencies":{"${name}":"2.0.0","\\u0040example/leaf":"1.0.0"}}`)),
    new Map(input).set(lockPath, document({ ...lockRecord, packages: { ...lockRecord.packages,
      [`node_modules/${name}`]: { version: previous, resolved: 'https://elsewhere.example/leaf.tgz' },
    } })),
    new Map(input).set(lockPath, document({ ...lockRecord, packages: { ...lockRecord.packages,
      [`node_modules/${name}`]: { ...lockRecord.packages[`node_modules/${name}`], dependencies: { another: '1.0.0' } },
    } })),
  ];
  for (const files of variants) expect(npmRepairPair(files, scope)).toBeUndefined();
  expect(npmRepairPair(input, scope)).toHaveLength(2);
});

describe.runIf(process.platform === 'linux')('npm pair in the sealed guest', () => {
  it('observes approved UTF-8 edits for both files and revalidates before publishing any candidate', async () => {
    const sample = await trustedGitFixture('sha1', Object.fromEntries(input));
    try {
      const source = join(sample.root, 'source'); const output = join(sample.root, 'output');
      await Promise.all([mkdir(source), mkdir(output)]);
      const domainId = randomUUID(); publishGuestSnapshot(source, sample.root, domainId, sample.source, 'repair-observation');
      const workspace = { version: 1 as const, operationId: randomUUID(), repairInputSha256: sha256('audit evidence'),
        source: sample.source, baseSnapshotSha256: sample.manifest.sha256, protectedPaths: [], npmRepairs: [scope],
      };
      const targets: RepairTarget[] = [lockPath, manifestPath].map(path => ({ path, findingId: scope.findingId, scanner: 'trivy', line: null }));
      const command = canonicalRepairObservation({ workspace, targets });
      const commandFile = join(source, 'repair-observation.json');
      await writeFile(commandFile, command.bytes);
      const proof = observeQualifiedRepairTargets(source);
      expect(proof.observation.targets.map(target => target.npm?.edits.length)).toEqual([4, 1]);
      expect(JSON.stringify(proof)).not.toMatch(/synthetic-script-marker|示例/);
      const request = qualifiedRepairObservationRequestSchema.parse({
        version: 1, operation: 'observe_repair', operationId: workspace.operationId, repairInputSha256: workspace.repairInputSha256,
        baseSnapshotSha256: workspace.baseSnapshotSha256, commandSha256: sha256(command.bytes), commandBytes: command.bytes.length,
        requestId: randomUUID(), taskId: randomUUID(), projectId: randomUUID(), runId: randomUUID(),
        generation: 1, fence: 2, workspaceSha256: sha256('runner'), ...sample.source, origin: 'https://example.invalid/source.git',
      });
      const { origin, ...coordinates } = request;
      const imageSha256 = sha256('guest image');
      const receipt: QualifiedRepairObservationReceipt = { kind: 'repair_observation', scope: coordinates, domainId, imageSha256,
        originSha256: sha256(origin), commitSha256: sha256(sample.commitObject), cleanupConfirmed: true, sessionVerified: true, snapshot: proof,
      };
      expect(() => verifyQualifiedRepairObservation(receipt, request, command, imageSha256)).not.toThrow();
      const spoofed = structuredClone(receipt);
      spoofed.snapshot.observation.targets[1]!.npm!.edits[0]!.replacement = '"different version"';
      expect(() => verifyQualifiedRepairObservation(spoofed, request, command, imageSha256)).toThrow('runner_repair_npm_binding');

      const blocked = canonicalRepairObservation({ workspace: { ...workspace, protectedPaths: [manifestPath] }, targets });
      await writeFile(commandFile, blocked.bytes);
      expect(observeQualifiedRepairTargets(source).observation.targets.every(target => !target.npm)).toBe(true);

      const files = proof.observation.targets.map(target => ({ path: target.path, beforeSha256: target.file!.sha256, edits: target.npm!.edits }));
      const patch = { version: 1, baseSnapshotSha256: workspace.baseSnapshotSha256, files };
      const ready = join(source, 'ready');
      const apply = { ...workspace, editablePaths: files.map(file => file.path) };
      expect(() => publishGuestRepair(ready, output, { ...apply, npmRepairs: undefined }, patch)).toThrow('repair-scope');
      expect(() => publishGuestRepair(ready, output, apply, { ...patch, files: files.slice(1) })).toThrow('repair-scope');
      const edited = structuredClone(patch);
      edited.files[1]!.edits[0]!.replacement = '"2.0.0"';
      expect(() => publishGuestRepair(ready, output, apply, edited)).toThrow('repair-scope');
      expect(await readdir(output)).toEqual([]);
      const candidate = publishGuestRepair(ready, output, apply, patch);
      const tree = join(output, 'candidate', 'worktree');
      const updatedManifest = JSON.parse(await readFile(join(tree, manifestPath), 'utf8'));
      const updatedLock = JSON.parse(await readFile(join(tree, lockPath), 'utf8'));
      expect(updatedManifest).toEqual({ ...manifestRecord, dependencies: { ...manifestRecord.dependencies, [name]: next } });
      expect(updatedLock).toEqual({ ...lockRecord, packages: {
        ...lockRecord.packages, '': { ...lockRecord.packages[''], dependencies: updatedManifest.dependencies },
        [`node_modules/${name}`]: { version: next, resolved: npmRegistryTarball(name, next), integrity: approval.integrity },
      } });
      expect(candidate.changes.map(change => change.path)).toEqual([lockPath, manifestPath]);
      expect(await readFile(join(ready, 'worktree', lockPath))).toEqual(input.get(lockPath));
    } finally { await sample.close(); }
  });
});
