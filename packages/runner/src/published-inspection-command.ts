import {
  publishedInspectionCommandByteLimit, publishedInspectionCommandSchema,
  type MaterializedSourceBasis, type QualifiedInspectionReceipt, type QualifiedInspectionScope,
} from '@itervane/contracts';
import { sha256 } from './profiles.js';
import { preparePublishedCodeRules } from './published-code-rules.js';
import { preparePublishedCodeScan, verifyPublishedCodeScanEvidence } from './published-code-scan.js';
import { sourcePath } from './snapshot.js';

export function canonicalPublishedInspectionCommand(input: unknown, materializedFrom?: MaterializedSourceBasis) {
  const rules = preparePublishedCodeRules(input);
  if (!rules.groups.length) throw new Error('published_inspection_rules_required');
  const document = publishedInspectionCommandSchema.parse({ version: 1, rules: rules.input, materializedFrom });
  const bytes = Buffer.from(JSON.stringify(document));
  if (bytes.length > publishedInspectionCommandByteLimit) throw new Error('published_inspection_command_size');
  const binding = { commandSha256: sha256(bytes), commandBytes: bytes.length, runnerImageSha256: rules.input.profile.runnerImageSha256 };
  return { rules, materializedFrom: document.materializedFrom, bytes, binding };
}
export type PublishedInspectionCommand = ReturnType<typeof canonicalPublishedInspectionCommand>;

export function readPublishedInspectionCommand(bytes: Buffer) {
  if (bytes.length === 0 || bytes.length > publishedInspectionCommandByteLimit) throw new Error('published_inspection_command_size');
  const command = publishedInspectionCommandSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  const prepared = canonicalPublishedInspectionCommand(command.rules, command.materializedFrom);
  if (!prepared.bytes.equals(bytes)) throw new Error('published_inspection_command_integrity');
  return prepared;
}

export function requirePublishedInspectionCommand(scope: QualifiedInspectionScope, imageSha256: string, command?: PublishedInspectionCommand) {
  if (Boolean(scope.publishedCode) !== Boolean(command)) throw new Error('published_inspection_command_binding');
  if (!command) return;
  const { document } = command.rules.input.snapshot;
  if (JSON.stringify(scope.publishedCode) !== JSON.stringify(command.binding)
      || command.binding.commandSha256 !== sha256(command.bytes) || command.binding.commandBytes !== command.bytes.length
      || imageSha256 !== command.binding.runnerImageSha256 || scope.taskId !== document.taskId || scope.projectId !== document.projectId
      || JSON.stringify(scope.materializedFrom) !== JSON.stringify(command.materializedFrom)) {
    throw new Error('published_inspection_command_binding');
  }
}

export function verifyPublishedInspectionProof(receipt: QualifiedInspectionReceipt, command?: PublishedInspectionCommand) {
  requirePublishedInspectionCommand(receipt.scope, receipt.imageSha256, command);
  const { snapshot } = receipt;
  const proof = snapshot.publishedCode;
  if (!command && !proof) return;
  if (!command || !proof || proof.commandSha256 !== command.binding.commandSha256) throw new Error('published_inspection_proof_binding');
  const { sha256: digest, ...manifest } = proof.manifest;
  if (digest !== snapshot.manifestSha256 || digest !== sha256(JSON.stringify(manifest)) || manifest.tree !== snapshot.tree
      || manifest.objectFormat !== 'sha1' || manifest.source.repositoryId !== snapshot.repositoryId || manifest.source.commit !== snapshot.commit
      || manifest.totalBytes !== snapshot.totalBytes || manifest.files.length !== snapshot.files) throw new Error('published_inspection_manifest_binding');
  let previous: string | undefined;
  let bytes = 0;
  const seen = new Set<string>();
  for (const file of manifest.files) {
    const path = sourcePath(file.path);
    const key = path.toLowerCase();
    if (seen.has(key) || (previous !== undefined && Buffer.compare(Buffer.from(previous), Buffer.from(path)) >= 0)) {
      throw new Error('published_inspection_manifest_binding');
    }
    seen.add(key);
    previous = path;
    bytes += file.bytes;
  }
  if (bytes !== manifest.totalBytes) throw new Error('published_inspection_manifest_binding');
  verifyPublishedCodeScanEvidence(preparePublishedCodeScan(command.rules, proof.manifest), proof.scan);
}
