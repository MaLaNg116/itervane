import { randomUUID } from 'node:crypto';
import { qualifiedInspectionResponseSchema, type SourceManifest } from '@itervane/contracts';
import { expect, it } from 'vitest';
import { scannerProfiles, sha256 } from '../../src/profiles.js';
import { preparePublishedCodeScan } from '../../src/published-code-scan.js';
import {
  canonicalPublishedInspectionCommand, readPublishedInspectionCommand, requirePublishedInspectionCommand,
} from '../../src/published-inspection-command.js';
import { verifyQualifiedInspectionReceipt } from '../../src/qualified-client.js';
import { publishedCodeRuleFixture, sealDocument } from '../helpers/published-code-rule.js';

const profile = {
  version: 1, engine: 'semgrep_ce', engineVersion: '1.170.0', engineInputsSha256: sha256('engine'), runnerImageSha256: sha256('scan image'),
} as const;

it('admits only canonical commands for the current task, image and materialized source', () => {
  const rules = publishedCodeRuleFixture(profile);
  const from = { commit: 'd'.repeat(40), baseSnapshotSha256: sha256('previous source') };
  const command = canonicalPublishedInspectionCommand(rules, from);
  const { taskId, projectId } = rules.snapshot.document;
  const scope = {
    version: 1, requestId: randomUUID(), runId: randomUUID(), taskId, projectId, repositoryId: randomUUID(), commit: 'a'.repeat(40),
    generation: 1, fence: 1, planSha256: sha256('scan plan'), workspaceSha256: sha256('workspace'), publishedCode: command.binding, materializedFrom: from,
  } as const;
  expect(readPublishedInspectionCommand(command.bytes)).toEqual(command);
  expect(() => readPublishedInspectionCommand(Buffer.concat([command.bytes, Buffer.from('\n')]))).toThrow('published_inspection_command_integrity');
  expect(() => requirePublishedInspectionCommand(scope, profile.runnerImageSha256, command)).not.toThrow();
  expect(() => requirePublishedInspectionCommand(scope, sha256('different image'), command)).toThrow('published_inspection_command_binding');
  expect(() => requirePublishedInspectionCommand({ ...scope, projectId: randomUUID() }, profile.runnerImageSha256, command))
    .toThrow('published_inspection_command_binding');
  const { materializedFrom: _materialized, ...original } = scope;
  expect(() => requirePublishedInspectionCommand(original, profile.runnerImageSha256, command)).toThrow('published_inspection_command_binding');
});

it('recomputes coverage from the complete manifest and requires the matching inspection proof', () => {
  const command = canonicalPublishedInspectionCommand(publishedCodeRuleFixture(profile));
  const binding = { imageSha256: profile.runnerImageSha256, originSha256: sha256('registered source') };
  const { taskId, projectId } = command.rules.input.snapshot.document;
  const source = { repositoryId: randomUUID(), commit: 'a'.repeat(40) };
  const scope = {
    version: 1, requestId: randomUUID(), runId: randomUUID(), taskId, projectId, ...source,
    generation: 1, fence: 1, planSha256: sha256('scan plan'), workspaceSha256: sha256('workspace'), publishedCode: command.binding,
  } as const;
  const snapshot = sealDocument({
    version: 1 as const, source, objectFormat: 'sha1' as const, tree: 'b'.repeat(40),
    files: [{ path: 'app/readiness.mjs', mode: '100644' as const, bytes: 1, sha256: sha256('0') }], totalBytes: 1,
  });
  const manifest: SourceManifest = { ...snapshot.document, sha256: snapshot.sha256 };
  const scan = preparePublishedCodeScan(command.rules, manifest);
  const reports = [{ language: 'javascript', status: 'checked', reportSha256: sha256('engine observation'), findings: [] }];
  const domainId = randomUUID();
  const receipt = qualifiedInspectionResponseSchema.parse({
    kind: 'receipt', scope, domainId, ...binding, commitSha256: sha256('commit object'), cleanupConfirmed: true, sessionVerified: true,
    snapshot: { ...source, runId: domainId, files: 1, totalBytes: manifest.totalBytes, manifestSha256: manifest.sha256, tree: manifest.tree,
      inputsSha256: sha256('scanner inputs'),
      readOnly: true, offline: true, publishedCode: { commandSha256: command.binding.commandSha256, manifest, scan: sealDocument({ basis: scan.basis, reports }) },
      reports: scannerProfiles.map(profile => ({ scanner: profile.scanner, version: profile.version, policySha256: profile.policySha256,
        snapshotSha256: manifest.sha256, status: 'completed', reason: null, findings: [],
        database: profile.scanner === 'trivy' ? { sha256: sha256('offline database'), updatedAt: '2026-10-04T00:00:00Z' } : null,
      })),
    },
  });
  if (receipt.kind !== 'receipt') throw new Error('Expected inspection receipt fixture');
  expect(() => verifyQualifiedInspectionReceipt(receipt, scope, binding, scannerProfiles, command)).not.toThrow();
  expect(() => verifyQualifiedInspectionReceipt(receipt, scope, binding)).toThrow('published_inspection_command_binding');
  const broken = structuredClone(receipt);
  broken.snapshot.publishedCode!.manifest.files[0]!.path = 'app/exchanged.mjs';
  expect(() => verifyQualifiedInspectionReceipt(broken, scope, binding, scannerProfiles, command)).toThrow('published_inspection_manifest_binding');
  delete broken.snapshot.publishedCode;
  expect(qualifiedInspectionResponseSchema.safeParse(broken).success).toBe(false);
});
