import { z } from 'zod';
import { sha256Schema } from './inspection.js';
import { localeSchema } from './i18n.js';
import { idSchema, sourceRefSchema } from './primitives.js';

const version = z.number().int().min(0).max(2_147_483_647);
const timestamp = z.iso.datetime({ precision: 3 });

export const fixtureReleaseManifestSchema = z.object({
  version: z.literal(1),
  origin: z.literal('trusted_fixture'),
  releaseEligible: z.literal(false),
  evidenceVersion: version.min(1),
  taskId: idSchema,
  runId: idSchema,
  generation: version.min(1),
  projectId: idSchema,
  source: sourceRefSchema,
  originalSnapshotSha256: sha256Schema,
  repairedSnapshotSha256: sha256Schema,
  diffSha256: sha256Schema.nullable(),
  templateSetSha256: sha256Schema,
  ruleSetSha256: sha256Schema,
  verificationProfileSha256: sha256Schema,
  checks: z.object({
    rescanSha256: sha256Schema,
    baselineSha256: sha256Schema,
    targetedSha256: sha256Schema,
    imageScanSha256: sha256Schema,
  }).strict(),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  runtimeConfigSha256: sha256Schema,
  target: z.object({
    applicationId: idSchema,
    environmentId: idSchema,
    mappingSha256: sha256Schema,
  }).strict(),
  rolloutCheckSha256: sha256Schema,
  recoveryPlanSha256: sha256Schema,
  validUntil: timestamp,
}).strict().refine(manifest => (manifest.originalSnapshotSha256 === manifest.repairedSnapshotSha256) === (manifest.diffSha256 === null));

export const releaseDecisionSchema = z.enum(['confirm', 'reject', 'revoke']);
export const releaseDecisionInputSchema = z.object({
  action: releaseDecisionSchema,
  fingerprint: sha256Schema,
  expectedVersion: version,
  idempotencyKey: idSchema,
}).strict();

export const releaseCandidateStatusSchema = z.enum([
  'pending', 'confirmed', 'rejected', 'revoked', 'expired', 'superseded',
  'evidence_changed', 'task_changed', 'approver_revoked',
]);
export const releaseDecisionDtoSchema = z.object({
  version: version.min(1), action: releaseDecisionSchema, actorId: idSchema,
  selfConfirmed: z.boolean(), decidedAt: timestamp,
}).strict();
export const releaseCandidateDtoSchema = z.object({
  id: idSchema, fingerprint: sha256Schema, requestedBy: idSchema, createdAt: timestamp,
  origin: z.literal('trusted_fixture'), releaseEligible: z.literal(false),
  manifest: fixtureReleaseManifestSchema,
  decisionVersion: version,
  decisions: z.array(releaseDecisionDtoSchema).max(2),
  status: releaseCandidateStatusSchema,
  locale: localeSchema, message: z.string(),
}).strict();

export type FixtureReleaseManifest = z.infer<typeof fixtureReleaseManifestSchema>;
export type ReleaseDecision = z.infer<typeof releaseDecisionSchema>;
export type ReleaseCandidateStatus = z.infer<typeof releaseCandidateStatusSchema>;
export type ReleaseCandidateDto = z.infer<typeof releaseCandidateDtoSchema>;
