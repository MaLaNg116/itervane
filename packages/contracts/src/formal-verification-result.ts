import { z } from 'zod';
import { auditModelProtocolSchema } from './formal-audit.js';
import { formalVerificationCompletionSchema, formalVerificationEvidenceSchema, verificationSectionSchema } from './formal-verification-evidence.js';
import { localeSchema } from './i18n.js';
import { sha256Schema } from './inspection.js';
import { idSchema } from './primitives.js';
import { qualifiedOciArchiveVerificationSchema } from './qualified-standard-image.js';

const fields = {
  version: z.literal(1), taskId: idSchema, runId: idSchema, projectId: idSchema, generation: z.int().positive(), locale: localeSchema,
  requestId: idSchema, inputSha256: sha256Schema, checkpointId: idSchema, receiptSha256: sha256Schema,
  provider: auditModelProtocolSchema, releaseEligible: z.literal(false),
  usage: z.strictObject({ turns: z.int().min(0).max(10), toolCalls: z.int().min(0).max(6), tokens: z.int().nonnegative() }),
  evidence: formalVerificationEvidenceSchema,
  archiveVerification: qualifiedOciArchiveVerificationSchema.optional(),
  observations: z.array(z.strictObject({ section: verificationSectionSchema, id: sha256Schema })).max(4),
};

export const formalVerificationResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...fields, status: z.literal('reviewed'), reason: z.literal('verification_review_complete'), review: formalVerificationCompletionSchema }),
  z.strictObject({ ...fields, status: z.literal('requires_human'), review: z.null(), reason: z.enum([
    'manual_review', 'deadline', 'turn_budget', 'tool_budget', 'token_budget', 'context_budget', 'no_progress',
    'provider_error', 'invalid_receipt', 'interrupted_action', 'incompatible_checkpoint',
  ]) }),
]).refine(result => {
  const { binding } = result.evidence;
  const ids = new Set(result.observations.map(item => item.id));
  if (binding.taskId !== result.taskId || binding.runId !== result.runId || binding.projectId !== result.projectId
      || binding.generation !== result.generation || binding.verificationInputSha256 !== result.inputSha256
      || binding.receiptSha256 !== result.receiptSha256 || ids.size !== result.observations.length
      || new Set(result.observations.map(item => item.section)).size !== ids.size) return false;
  const { review } = result;
  const verification = result.archiveVerification;
  const image = result.evidence.image;
  if (verification && (review?.outcome !== 'observed' || image.status !== 'scanned' || !image.archive
      || image.archive.sha256 !== verification.archive.sha256 || image.archive.bytes !== verification.archive.bytes)) return false;
  return !review || (review.receiptSha256 === result.receiptSha256 && review.candidateManifestSha256 === binding.subjectManifestSha256
    && review.evidenceIds.length === ids.size && review.evidenceIds.every(id => ids.has(id))
    && review.followUps.every(item => ids.has(item.evidenceId)));
});
export type FormalVerificationResult = z.infer<typeof formalVerificationResultSchema>;
