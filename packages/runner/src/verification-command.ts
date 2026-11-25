import { publishedVerificationCommandByteLimit, verificationCommandByteLimit, verificationCommandSchema,
  type QualifiedVerificationReceipt } from '@itervane/contracts';
import { sha256 } from './profiles.js';
import { canonicalRepairCommand } from './repair-command.js';
import { preparePublishedCodeRules } from './published-code-rules.js';
import { preparePublishedCodeScan, verifyPublishedCodeScanEvidence } from './published-code-scan.js';

export function canonicalVerificationCommand(raw: unknown) {
  const { input, repair, publishedCodeRules } = verificationCommandSchema.parse(raw);
  const { subject, source, inspection } = input;
  const command = repair && canonicalRepairCommand(repair.workspace, repair.patch);
  if (subject.kind === 'repair') {
    if (!command || sha256(command.bytes) !== subject.commandSha256 || command.patchSha256 !== subject.patchSha256
      || command.workspace.operationId !== subject.operationId || command.workspace.repairInputSha256 !== subject.inputSha256
      || command.workspace.baseSnapshotSha256 !== inspection.snapshotSha256
      || command.workspace.source.repositoryId !== source.repositoryId || command.workspace.source.commit !== source.commit) {
      throw new Error('verification-repair-binding');
    }
  } else if (command) {
    throw new Error('verification-repair-binding');
  }
  const published = publishedCodeRules && preparePublishedCodeRules(publishedCodeRules);
  const snapshot = published?.input.snapshot;
  if (Boolean(input.publishedCode) !== Boolean(published) || (published && (
    !published.groups.length || snapshot?.document.taskId !== input.taskId || snapshot.document.projectId !== input.projectId
    || snapshot.sha256 !== input.publishedCode?.snapshotSha256 || published.sha256 !== input.publishedCode.ruleSetSha256
    || published.input.profile.runnerImageSha256 !== input.profile.runnerImageSha256
  ))) throw new Error('verification-published-rule-binding');
  const material = command && { workspace: command.workspace, patch: command.patch };
  const bytes = Buffer.from(JSON.stringify({ input, repair: material, ...(published ? { publishedCodeRules: published.input } : {}) }));
  if (bytes.length > (published ? publishedVerificationCommandByteLimit : verificationCommandByteLimit)) throw new Error('verification-command-limit');
  return { input, repair: material, published, inputSha256: sha256(JSON.stringify(input)), bytes };
}

export function verifyPublishedVerificationProof(receipt: QualifiedVerificationReceipt, command: ReturnType<typeof canonicalVerificationCommand>) {
  const { snapshot } = receipt;
  const { input, published } = command;
  const proof = snapshot.publishedCode;
  if (!published && !proof) return;
  if (!published || !proof || proof.kind !== input.subject.kind) throw new Error('runner_verification_published_proof_binding');
  const { manifest } = proof;
  if (manifest.source.repositoryId !== input.source.repositoryId || manifest.source.commit !== input.source.commit
      || manifest.files.length !== snapshot.files) throw new Error('runner_verification_published_manifest_binding');
  const expected = input.subject.manifestSha256;
  if (proof.kind === 'original') {
    const { sha256: digest, ...body } = proof.manifest;
    if (digest !== expected || sha256(JSON.stringify(body)) !== expected
        || body.tree !== snapshot.tree || body.objectFormat !== 'sha1' || body.totalBytes !== snapshot.totalBytes) {
      throw new Error('runner_verification_published_manifest_binding');
    }
  } else if (sha256(JSON.stringify(proof.manifest)) !== expected || proof.manifest.baseSnapshotSha256 !== snapshot.manifestSha256
      || proof.manifest.totalBytes !== snapshot.target?.totalBytes) {
    throw new Error('runner_verification_published_manifest_binding');
  }
  verifyPublishedCodeScanEvidence(preparePublishedCodeScan(published, { ...manifest, sha256: expected }), proof.scan);
}
