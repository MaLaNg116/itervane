import { formalVerificationEvidenceSchema, sha256Schema, verificationSections, verificationSectionSchema } from '@itervane/contracts';
import { z } from 'zod';
import type { AgentEvidence } from './contracts.js';

export { finishVerificationInputSchema, formalVerificationCompletionSchema, verificationSections, verificationSectionSchema } from '@itervane/contracts';
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
