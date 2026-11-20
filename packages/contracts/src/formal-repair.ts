import { z } from 'zod';
import { auditFindingsPerScan, formalAuditInputSchema } from './formal-audit.js';
import { sha256Schema, sourceContentLimits } from './inspection.js';
import { idSchema, sourceRefSchema } from './primitives.js';

export const formalRepairInputSchema = formalAuditInputSchema.pick({
  version: true, taskId: true, projectId: true, runId: true, generation: true,
  source: true, locale: true, dataClass: true, inspection: true,
}).extend({
  audit: z.strictObject({ inputSha256: sha256Schema, resultSha256: sha256Schema, checkpointId: idSchema }),
  catalogSha256: sha256Schema,
  findingIds: z.array(sha256Schema).max(2 * auditFindingsPerScan).refine(ids => new Set(ids).size === ids.length),
});
export type FormalRepairInput = z.infer<typeof formalRepairInputSchema>;

export const repairPatchLimits = Object.freeze({ files: 8, editsPerFile: 16, replacementBytes: 128 * 1024, documentBytes: 512 * 1024 });
const utf8 = new TextEncoder();
const bytes = (value: string) => utf8.encode(value).byteLength;
const pathSchema = z.string().min(1).max(240).refine(path => path.isWellFormed());
const uniquePaths = (paths: string[]) => new Set(paths.map(path => path.toLowerCase())).size === paths.length;
const offset = z.int().min(0).max(sourceContentLimits.maxFileBytes);

// The execution service supplies the workspace. Only the patch is an edit proposal.
export const repairWorkspaceSchema = z.strictObject({
  version: z.literal(1), operationId: idSchema, repairInputSha256: sha256Schema,
  source: sourceRefSchema, baseSnapshotSha256: sha256Schema,
  editablePaths: z.array(pathSchema).min(1).max(repairPatchLimits.files).refine(uniquePaths),
  protectedPaths: z.array(pathSchema).max(sourceContentLimits.maxFiles).refine(uniquePaths),
});
export type RepairWorkspace = z.infer<typeof repairWorkspaceSchema>;

const repairEditSchema = z.strictObject({
  startByte: offset, endByte: offset,
  replacement: z.string().max(repairPatchLimits.replacementBytes).refine(value =>
    value.isWellFormed() && bytes(value) <= repairPatchLimits.replacementBytes && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)),
}).refine(edit => edit.startByte < edit.endByte || (edit.startByte === edit.endByte && edit.replacement.length > 0));
const repairFilePatchSchema = z.strictObject({
  path: pathSchema, beforeSha256: sha256Schema, edits: z.array(repairEditSchema).min(1).max(repairPatchLimits.editsPerFile),
}).refine(file => file.edits.every((edit, index) => {
  const previous = file.edits[index - 1];
  return !previous || (edit.startByte >= previous.endByte && edit.startByte > previous.startByte);
}), 'Edits must be ordered and disjoint');
export const repairPatchSchema = z.strictObject({
  version: z.literal(1), baseSnapshotSha256: sha256Schema,
  files: z.array(repairFilePatchSchema).min(1).max(repairPatchLimits.files),
}).refine(patch => uniquePaths(patch.files.map(file => file.path))
  && patch.files.flatMap(file => file.edits).reduce((total, edit) => total + bytes(edit.replacement), 0) <= repairPatchLimits.replacementBytes
  && bytes(JSON.stringify(patch)) <= repairPatchLimits.documentBytes);
export type RepairPatch = z.infer<typeof repairPatchSchema>;

export const repairCommandByteLimit = 2 * 1024 * 1024;
export const repairCommandSchema = z.strictObject({ workspace: repairWorkspaceSchema, patch: repairPatchSchema });

export const repairObservationWorkspaceSchema = repairWorkspaceSchema.omit({ editablePaths: true });
export const repairTargetSchema = z.strictObject({
  findingId: sha256Schema, path: pathSchema, scanner: z.enum(['gitleaks', 'trivy']), line: z.int().min(1).max(100000000).nullable(),
});
const uniqueTargets = (targets: Array<{ findingId: string; path: string }>) =>
  new Set(targets.map(target => target.findingId + ':' + target.path.toLowerCase())).size === targets.length;
export const repairTargetsSchema = z.array(repairTargetSchema).min(1).max(repairPatchLimits.files).refine(uniqueTargets);
export const repairObservationCommandSchema = z.strictObject({ workspace: repairObservationWorkspaceSchema, targets: repairTargetsSchema });
export const repairTemplateIdSchema = z.enum(['remove-env-entry-v1']);
const observedRangeSchema = z.strictObject({ startByte: offset, endByte: offset, sha256: sha256Schema })
  .refine(range => range.startByte < range.endByte);
const observedFileSchema = z.strictObject({ sha256: sha256Schema, bytes: offset });
const repairTargetObservationSchema = repairTargetSchema.extend({
  status: z.enum(['text', 'binary', 'protected', 'missing']),
  file: observedFileSchema.nullable(), range: observedRangeSchema.nullable(),
  templates: z.array(repairTemplateIdSchema).max(1),
}).refine(target => {
  if (target.status === 'protected' || target.status === 'missing') return !target.file && !target.range && !target.templates.length;
  if (!target.file) return false;
  if (target.range && (target.status !== 'text' || target.line === null || target.range.endByte > target.file.bytes)) return false;
  return target.templates.length === 0 || (target.range !== null && target.scanner === 'gitleaks');
});
export const repairObservationSchema = z.strictObject({
  version: z.literal(1), operationId: idSchema, repairInputSha256: sha256Schema, baseSnapshotSha256: sha256Schema,
  targets: z.array(repairTargetObservationSchema).min(1).max(repairPatchLimits.files).refine(uniqueTargets),
});
export type RepairTarget = z.infer<typeof repairTargetSchema>;
export type RepairObservationWorkspace = z.infer<typeof repairObservationWorkspaceSchema>;
export type RepairObservation = z.infer<typeof repairObservationSchema>;

const candidateManifestFile = z.strictObject({
  path: pathSchema, mode: z.enum(['100644', '100755']), bytes: offset, sha256: sha256Schema,
});
export const repairCandidateManifestSchema = z.strictObject({
  version: z.literal(1), source: sourceRefSchema, baseSnapshotSha256: sha256Schema,
  files: z.array(candidateManifestFile).min(1).max(sourceContentLimits.maxFiles),
  totalBytes: z.int().min(0).max(sourceContentLimits.maxSourceBytes),
}).refine(manifest => uniquePaths(manifest.files.map(file => file.path))
  && manifest.totalBytes === manifest.files.reduce((total, file) => total + file.bytes, 0));
export type RepairCandidateManifest = z.infer<typeof repairCandidateManifestSchema>;

const candidateChange = z.strictObject({
  path: pathSchema, beforeSha256: sha256Schema, afterSha256: sha256Schema, beforeBytes: offset, afterBytes: offset,
  edits: z.int().min(1).max(repairPatchLimits.editsPerFile),
}).refine(change => change.beforeSha256 !== change.afterSha256);
export const repairCandidateReceiptSchema = z.strictObject({
  version: z.literal(1), operationId: idSchema, repairInputSha256: sha256Schema, workspaceSha256: sha256Schema,
  baseSnapshotSha256: sha256Schema, patchSha256: sha256Schema, candidateManifestSha256: sha256Schema,
  changes: z.array(candidateChange).min(1).max(repairPatchLimits.files),
}).refine(receipt => receipt.baseSnapshotSha256 !== receipt.candidateManifestSha256 && uniquePaths(receipt.changes.map(change => change.path)));
export type RepairCandidateReceipt = z.infer<typeof repairCandidateReceiptSchema>;
