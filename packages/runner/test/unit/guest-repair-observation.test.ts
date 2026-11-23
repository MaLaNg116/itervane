import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { healthRepairSourceBytes, qualifiedRepairObservationRequestSchema, qualifiedRepairObservationResponseSchema, standardHealthRepairPath,
  type QualifiedRepairObservationReceipt, type RepairTarget } from '@itervane/contracts';
import { describe, expect, it } from 'vitest';
import { observeQualifiedRepairTargets } from '../../src/guest-repair-observation.js';
import { publishGuestSnapshot } from '../../src/guest-snapshot.js';
import { sha256 } from '../../src/profiles.js';
import { verifyQualifiedRepairObservation } from '../../src/qualified-client.js';
import { canonicalRepairCommand, canonicalRepairObservation } from '../../src/repair-command.js';
import { trustedGitFixture } from '../helpers/trusted-git.js';

describe.runIf(process.platform === 'linux')('repair observations in the sealed guest', () => {
  it('returns byte geometry and an applicable template without original bytes, and refuses other publication modes', async () => {
    const intro = Buffer.from('# 说明\r\n');
    const entry = Buffer.from('EXAMPLE_VALUE="sample_marker"\r\n');
    const env = Buffer.concat([intro, entry]);
    const multiline = Buffer.from('EXAMPLE_VALUE="first\nsecond"\nNEXT_VALUE=third\n');
    const sample = await trustedGitFixture('sha1', { '.env': env, '.env.other': multiline, 'baseline/check': env, 'image.bin': Buffer.from([0, 255]) });
    try {
      const source = join(sample.root, 'source'); const other = join(sample.root, 'other');
      await Promise.all([mkdir(source), mkdir(other)]);
      const domain = randomUUID();
      publishGuestSnapshot(source, sample.root, domain, sample.source, 'repair-observation');
      publishGuestSnapshot(other, sample.root, domain, sample.source, 'repair');
      const workspace = {
        version: 1, operationId: randomUUID(), repairInputSha256: sha256('audit evidence'),
        source: sample.source, baseSnapshotSha256: sample.manifest.sha256, protectedPaths: ['BASELINE'],
      };
      const target = (path: string, line: number): RepairTarget => ({ findingId: sha256(path), scanner: 'gitleaks', path, line });
      const targets = [target('.env', 2), target('.env.other', 3), target('baseline/check', 2), target('image.bin', 1), target('absent', 1)];
      const command = canonicalRepairObservation({ workspace, targets });
      await writeFile(join(source, 'repair-observation.json'), command.bytes);
      await writeFile(join(other, 'repair-observation.json'), command.bytes);
      expect(() => observeQualifiedRepairTargets(other)).toThrow('repair-integrity');
      const proof = observeQualifiedRepairTargets(source);
      const descriptions = new Map(proof.observation.targets.map(value => [value.path, value]));
      expect(descriptions.get('.env')).toMatchObject({ status: 'text', file: { sha256: sha256(env), bytes: env.length },
        range: { startByte: intro.length, endByte: env.length, sha256: sha256(entry) }, templates: ['remove-env-entry-v1'] });
      expect(descriptions.get('.env.other')).toMatchObject({ status: 'text', templates: [] });
      expect(descriptions.get('baseline/check')).toMatchObject({ status: 'protected', file: null, range: null, templates: [] });
      expect(descriptions.get('image.bin')).toMatchObject({ status: 'binary', range: null, templates: [] });
      expect(descriptions.get('absent')).toMatchObject({ status: 'missing', file: null, range: null, templates: [] });
      expect(JSON.stringify(proof)).not.toContain('sample_marker');
      expect(JSON.stringify(proof)).not.toContain('EXAMPLE_VALUE');
      expect((await readdir(source)).sort()).toEqual(['ready', 'repair-observation.json']);
      expect(await readFile(join(source, 'ready', 'worktree', '.env'))).toEqual(env);

      const request = qualifiedRepairObservationRequestSchema.parse({
        version: 1, operation: 'observe_repair', operationId: workspace.operationId, repairInputSha256: workspace.repairInputSha256,
        baseSnapshotSha256: workspace.baseSnapshotSha256, commandSha256: sha256(command.bytes), commandBytes: command.bytes.length,
        requestId: randomUUID(), taskId: randomUUID(), projectId: randomUUID(), runId: randomUUID(),
        generation: 1, fence: 2, workspaceSha256: sha256('runner workspace'), ...sample.source, origin: 'https://example.invalid/source.git',
      });
      const imageSha256 = sha256('image'); const { origin, ...scope } = request;
      const receipt: QualifiedRepairObservationReceipt = { kind: 'repair_observation', scope, domainId: domain, imageSha256,
        originSha256: sha256(origin), commitSha256: sha256(sample.commitObject), cleanupConfirmed: true, sessionVerified: true, snapshot: proof };
      expect(qualifiedRepairObservationResponseSchema.safeParse(receipt).success).toBe(true);
      expect(() => verifyQualifiedRepairObservation(receipt, request, command, imageSha256)).not.toThrow();
      const changed = { ...proof.observation, targets: proof.observation.targets.map(value => 'kind' in value ? value : { ...value, line: 42 }) };
      expect(() => verifyQualifiedRepairObservation({ ...receipt, snapshot: { ...proof, observation: changed } }, request, command, imageSha256))
        .toThrow('runner_repair_observation_binding');
    } finally { await sample.close(); }
  });

  it.each(['bounded', 'oversized'] as const)('read-seals the %s application module under its health receipt', async scenario => {
    const path = standardHealthRepairPath;
    const original = Buffer.from(scenario === 'bounded' ? 'export const status = 503;\n' : 'a'.repeat(healthRepairSourceBytes + 1));
    const sample = await trustedGitFixture('sha1', { [path]: original, 'baseline/other.mjs': Buffer.from('unrelated sample') });
    try {
      const source = join(sample.root, 'source');
      await mkdir(source);
      const domain = randomUUID();
      publishGuestSnapshot(source, sample.root, domain, sample.source, 'repair-observation');
      const healthReproductionSha256 = sha256('old healthy-then-unhealthy receipt');
      const workspace = { version: 1, operationId: randomUUID(), repairInputSha256: sha256('linked repair input'),
        source: sample.source, baseSnapshotSha256: sample.manifest.sha256, protectedPaths: ['baseline'], healthReproductionSha256 };
      const target = { findingId: healthReproductionSha256, path, kind: 'health_reproduction', line: null } as const;
      const command = canonicalRepairObservation({ workspace, targets: [target] });
      expect(() => canonicalRepairObservation({ workspace, targets: [{ ...target, findingId: sha256('different receipt') }] })).toThrow('repair-scope');
      const apply = { ...workspace, editablePaths: [path, 'baseline/other.mjs'] };
      const otherFile = { path: 'baseline/other.mjs', beforeSha256: sha256('unrelated sample'),
        edits: [{ startByte: 0, endByte: 1, replacement: 'a' }] };
      expect(() => canonicalRepairCommand(apply, { version: 1, baseSnapshotSha256: workspace.baseSnapshotSha256, files: [otherFile] }))
        .toThrow('repair-scope');
      await writeFile(join(source, 'repair-observation.json'), command.bytes);
      const proof = observeQualifiedRepairTargets(source);
      const [observed] = proof.observation.targets;
      const file = { sha256: sha256(original), bytes: original.length };
      expect(observed).toMatchObject(scenario === 'bounded'
        ? { ...target, status: 'text', file, range: { startByte: 0, endByte: original.length, sha256: file.sha256 }, sourceText: original.toString() }
        : { ...target, status: 'oversized', file, range: null });
      expect(JSON.stringify(proof)).not.toContain('unrelated sample');
      if (scenario === 'oversized') expect(observed).not.toHaveProperty('sourceText');
      const request = qualifiedRepairObservationRequestSchema.parse({
        version: 1, operation: 'observe_repair', operationId: workspace.operationId, repairInputSha256: workspace.repairInputSha256,
        baseSnapshotSha256: workspace.baseSnapshotSha256, commandSha256: sha256(command.bytes), commandBytes: command.bytes.length,
        requestId: randomUUID(), taskId: randomUUID(), projectId: randomUUID(), runId: randomUUID(),
        generation: 2, fence: 3, workspaceSha256: sha256('runner workspace'), ...sample.source, origin: 'https://example.invalid/source.git',
      });
      const { origin, ...scope } = request;
      const imageSha256 = sha256('runner image');
      const receipt: QualifiedRepairObservationReceipt = { kind: 'repair_observation', scope, domainId: domain, imageSha256,
        originSha256: sha256(origin), commitSha256: sha256(sample.commitObject), cleanupConfirmed: true, sessionVerified: true, snapshot: proof };
      expect(() => verifyQualifiedRepairObservation(receipt, request, command, imageSha256)).not.toThrow();
      if (observed && 'kind' in observed && observed.sourceText) {
        observed.sourceText = observed.sourceText.replace('503', '200');
        expect(() => verifyQualifiedRepairObservation(receipt, request, command, imageSha256)).toThrow('runner_repair_observation_binding');
      }
    } finally { await sample.close(); }
  });
});
