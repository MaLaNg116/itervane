import { formalVerificationEvidenceSchema, sha256Schema } from '@itervane/contracts';
import { z } from 'zod';
import type { AgentEvidence } from './contracts.js';

export const verificationSections = ['source', 'build', 'baseline', 'image'] as const;
export const verificationSectionSchema = z.enum(verificationSections);
export type VerificationSection = z.infer<typeof verificationSectionSchema>;

const scope = { kind: z.literal('verification_section'), receiptSha256: sha256Schema };
const facts = formalVerificationEvidenceSchema.shape;
export const verificationObservationSchema = z.discriminatedUnion('section', [
  z.strictObject({ ...scope, section: z.literal('source'), result: facts.source }),
  z.strictObject({ ...scope, section: z.literal('build'), result: facts.build }),
  z.strictObject({ ...scope, section: z.literal('baseline'), result: facts.baseline }),
  z.strictObject({ ...scope, section: z.literal('image'), result: facts.image }),
]);
export type VerificationObservation = z.infer<typeof verificationObservationSchema>;

export function verificationObservations(evidence: readonly AgentEvidence[]) {
  return evidence.flatMap(({ id, snapshotSha256, data }) => data.kind === 'verification_section' ? [{ id, snapshotSha256, ...data }] : []);
}

export function pendingVerificationSections(evidence: readonly AgentEvidence[]): VerificationSection[] {
  const seen = verificationObservations(evidence);
  const baseline = seen.find(item => item.section === 'baseline');
  return verificationSections.filter(section => !seen.some(item => item.section === section)
    && (section !== 'image' || baseline?.result.status === 'passed'));
}

export const finishVerificationInputSchema = z.strictObject({
  summary: z.string().trim().min(1).max(480),
  evidenceIds: z.array(sha256Schema).min(3).max(4).refine(ids => new Set(ids).size === ids.length),
  followUps: z.array(z.strictObject({
    evidenceId: sha256Schema, detail: z.string().trim().min(1).max(320),
  })).max(4),
});

export const formalVerificationCompletionSchema = finishVerificationInputSchema.extend({
  receiptSha256: sha256Schema, candidateManifestSha256: sha256Schema,
  outcome: z.enum(['observed', 'checks_failed', 'source_findings', 'incomplete']),
  source: facts.source,
  unverified: z.array(verificationSectionSchema).max(4),
});
