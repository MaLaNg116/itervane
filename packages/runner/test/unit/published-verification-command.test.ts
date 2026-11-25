import { randomUUID } from 'node:crypto';
import {
  formalVerificationInputSchema, qualifiedVerificationResponseSchema, repairCandidateManifestSchema, sourceManifestSchema,
  type FormalVerificationInput,
} from '@itervane/contracts';
import { expect, it } from 'vitest';
import { scannerProfiles, sha256 } from '../../src/profiles.js';
import { preparePublishedCodeRules } from '../../src/published-code-rules.js';
import { preparePublishedCodeScan } from '../../src/published-code-scan.js';
import { prepareQualifiedVerificationRequest, verifyQualifiedVerificationReceipt } from '../../src/qualified-client.js';
import { canonicalRepairCommand } from '../../src/repair-command.js';
import { canonicalVerificationCommand } from '../../src/verification-command.js';
import { publishedCodeRuleFixture, sealDocument } from '../helpers/published-code-rule.js';

it.each(['original', 'repair'] as const)('requires independently measured rule evidence over the %s manifest', kind => {
  const image = sha256('verified image');
  const engine = { version: 1, engine: 'semgrep_ce', engineVersion: '1.170.0', engineInputsSha256: sha256('fixed engine'),
    runnerImageSha256: image } as const;
  const rules = preparePublishedCodeRules(publishedCodeRuleFixture(engine));
  const { taskId, projectId } = rules.input.snapshot.document;
  const source = { repositoryId: randomUUID(), commit: 'a'.repeat(40) };
  const file = { path: 'app/readiness.mjs', mode: '100644' as const, bytes: 1, sha256: sha256('0') };
  const tree = 'b'.repeat(40);
  const original = sealDocument({ version: 1, source, objectFormat: 'sha1', tree, files: [file], totalBytes: 1 });
  const originalManifest = sourceManifestSchema.parse({ ...original.document, sha256: original.sha256 });
  const candidate = sealDocument(repairCandidateManifestSchema.parse({
    version: 1, source, baseSnapshotSha256: original.sha256, files: [{ ...file, bytes: 2, sha256: sha256('ok') }], totalBytes: 2,
  }));
  const repair = kind === 'repair' ? canonicalRepairCommand({
    version: 1, operationId: randomUUID(), repairInputSha256: sha256('repair input'), source, baseSnapshotSha256: original.sha256,
    editablePaths: [file.path], protectedPaths: [],
  }, { version: 1, baseSnapshotSha256: original.sha256, files: [
    { path: file.path, beforeSha256: file.sha256, edits: [{ startByte: 0, endByte: 1, replacement: 'ok' }] },
  ] }) : null;
  const subject: FormalVerificationInput['subject'] = repair ? {
    kind: 'repair', operationId: repair.workspace.operationId, inputSha256: repair.workspace.repairInputSha256,
    manifestSha256: candidate.sha256, commandSha256: sha256(repair.bytes), patchSha256: repair.patchSha256,
    requestId: randomUUID(), checkpointId: randomUUID(), resultSha256: sha256('candidate result'), receiptSha256: sha256('repair receipt'),
  } : { kind: 'original', manifestSha256: original.sha256 };
  const input = formalVerificationInputSchema.parse({
    version: 1, taskId, projectId, runId: randomUUID(), generation: 1, source, locale: 'en', dataClass: 'synthetic',
    inspection: { requestId: randomUUID(), planSha256: sha256('inspection plan'), receiptSha256: sha256('original inspection'),
      snapshotSha256: original.sha256 },
    audit: { checkpointId: randomUUID(), inputSha256: sha256('audit input'), resultSha256: sha256('audit result') },
    catalogSha256: sha256('catalog'),
    profile: { id: 'verification', policySha256: sha256('policy'), baselineSha256: sha256('baseline'),
      scannerInputsSha256: sha256('offline scanner bundle'), runnerImageSha256: image },
    subject, publishedCode: { snapshotSha256: rules.input.snapshot.sha256, inspectionScanSha256: sha256('inspection code report'),
      ruleSetSha256: rules.sha256 },
  });
  const material = repair && { workspace: repair.workspace, patch: repair.patch };
  expect(() => canonicalVerificationCommand({ input, repair: material })).toThrow('verification-published-rule-binding');
  const command = canonicalVerificationCommand({ input, repair: material, publishedCodeRules: rules.input });
  const request = prepareQualifiedVerificationRequest({ requestId: randomUUID(), fence: 2, workspaceSha256: sha256('isolated host'),
    origin: 'https://example.invalid/project.git' }, command);
  const { origin, ...scope } = request;
  expect(scope.publishedCodeRuleSetSha256).toBe(rules.sha256);
  const domainId = randomUUID();
  const readings = (manifestSha256: string) => scannerProfiles.map(profile => ({
    ...profile, status: 'completed', reason: null, snapshotSha256: manifestSha256, findings: [],
    database: profile.scanner === 'trivy' ? { sha256: sha256('offline db'), updatedAt: '2026-10-04T00:00:00Z' } : null,
  })).map(({ coverage: _coverage, ...report }) => report);
  const manifest = repair ? candidate.document : originalManifest;
  const scan = preparePublishedCodeScan(rules, { ...manifest, sha256: subject.manifestSha256 });
  const receipt = qualifiedVerificationResponseSchema.parse({
    kind: 'verification_receipt', scope, domainId, imageSha256: image, originSha256: sha256(origin), commitSha256: sha256('commit object'),
    cleanupConfirmed: true, sessionVerified: true,
    snapshot: { ...source, runId: domainId, tree, files: 1, totalBytes: 1, manifestSha256: original.sha256, readOnly: true, offline: true,
      verificationInputSha256: command.inputSha256, commandSha256: scope.commandSha256, inputsSha256: input.profile.scannerInputsSha256,
      reports: readings(original.sha256),
      target: repair ? { manifestSha256: candidate.sha256, patchSha256: repair.patchSha256, totalBytes: 2, reports: readings(candidate.sha256) } : null,
      publishedCode: { kind, manifest, scan: sealDocument({ basis: scan.basis, reports: [
        { language: 'javascript', status: 'checked', reportSha256: sha256('measured report'), findings: [] },
      ] }) },
    },
  });
  if (receipt.kind !== 'verification_receipt') throw new Error('Expected verification receipt fixture');
  expect(() => verifyQualifiedVerificationReceipt(receipt, request, command)).not.toThrow();
  const damaged = structuredClone(receipt);
  damaged.snapshot.publishedCode!.manifest.files[0]!.sha256 = sha256('another file');
  expect(() => verifyQualifiedVerificationReceipt(damaged, request, command)).toThrow('runner_verification_published_manifest_binding');
  delete damaged.snapshot.publishedCode;
  expect(qualifiedVerificationResponseSchema.safeParse(damaged).success).toBe(false);
});
