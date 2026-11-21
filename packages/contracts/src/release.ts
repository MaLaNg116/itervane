import { z } from 'zod';
import { applicationDtoSchema, environmentDtoSchema } from './control-plane.js';
import { verificationComparisonCountsSchema, verificationImageFindingCountsSchema } from './formal-verification-evidence.js';
import { sha256Schema } from './inspection.js';
import { localeSchema } from './i18n.js';
import { idSchema, sourceRefSchema } from './primitives.js';
import { qualifiedImageArchiveSchema } from './qualified-standard-image.js';

const version = z.number().int().min(0).max(2_147_483_647);
const timestamp = z.iso.datetime({ precision: 3 });
const imageDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const komodoResourceIdSchema = z.string().regex(/^[a-f0-9]{24}$/);
const imageSeverity = z.enum(['critical', 'high', 'medium', 'low', 'unknown']);
const imageBlockers = z.array(imageSeverity).min(1).max(5)
  .refine(values => new Set(values).size === values.length).transform(values => [...values].sort());

function releaseServiceOrigin(service: string) {
  return z.string().max(2048).transform((input, context) => {
    const url = URL.parse(input);
    const loopback = url?.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port;
    if (!url || url.username || url.password || url.pathname !== '/' || url.search || url.hash
        || (!loopback && url.protocol !== 'https:')) {
      context.addIssue({ code: 'custom', message: `Expected a bare HTTPS ${service} origin or an explicit loopback endpoint` });
      return z.NEVER;
    }
    return url.origin;
  });
}

export const releaseRegistryOriginSchema = releaseServiceOrigin('Registry');
export const releaseKomodoOriginSchema = releaseServiceOrigin('Komodo');

export const formalReleaseTargetSchema = z.strictObject({
  environmentId: idSchema, deploymentId: komodoResourceIdSchema, serverId: komodoResourceIdSchema,
  imageRepository: z.string().max(180).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/),
  registryOrigin: releaseRegistryOriginSchema.optional(),
  komodo: z.strictObject({ origin: releaseKomodoOriginSchema, actorId: komodoResourceIdSchema }).optional(),
  runtimeConfigSha256: sha256Schema, verificationProfileSha256: sha256Schema,
  rolloutCheckSha256: sha256Schema, recoveryPlanSha256: sha256Schema,
  blockImageSeverities: imageBlockers.default(['critical', 'high', 'unknown']),
  approvalTtlSeconds: z.int().min(60).max(86_400).default(1800),
  verificationMaxAgeSeconds: z.int().min(60).max(604_800).default(86_400),
});
export type FormalReleaseTarget = z.infer<typeof formalReleaseTargetSchema>;

export function releaseRegistryHost(origin: string) {
  const url = new URL(origin);
  // A bare host needs an explicit port in a Docker reference to avoid being read as a repository namespace.
  return url.hostname === 'localhost' || url.hostname.includes('.') || url.hostname.includes(':') || url.port
    ? url.host : `${url.hostname}:443`;
}

export const releaseRegistryImageProofSchema = z.strictObject({
  registryOrigin: releaseRegistryOriginSchema,
  repository: formalReleaseTargetSchema.shape.imageRepository,
  reference: z.string().max(2400),
  manifestDigest: imageDigest, configDigest: imageDigest, archive: qualifiedImageArchiveSchema,
}).refine(proof => proof.reference === `${releaseRegistryHost(proof.registryOrigin)}/${proof.repository}@${proof.manifestDigest}`);
export type ReleaseRegistryImageProof = Readonly<z.infer<typeof releaseRegistryImageProofSchema>>;

export const freezeFormalReleaseSchema = z.strictObject({ environmentId: idSchema, expectedVersion: version.min(1) });

export const formalReleaseManifestSchema = z.strictObject({
  version: z.literal(1), origin: z.literal('formal_verification'), releaseEligible: z.literal(false), evidenceVersion: version.min(1),
  taskId: idSchema, runId: idSchema, generation: version.min(1), projectId: idSchema, source: sourceRefSchema,
  originalSnapshotSha256: sha256Schema, repairedSnapshotSha256: sha256Schema, diffSha256: sha256Schema.nullable(),
  verification: z.strictObject({
    inputSha256: sha256Schema, resultSha256: sha256Schema, receiptSha256: sha256Schema,
    catalogSha256: sha256Schema, profileSha256: sha256Schema, buildSha256: sha256Schema, baselineSha256: sha256Schema,
    source: verificationComparisonCountsSchema.extend({ introduced: z.literal(0), remaining: z.literal(0) }),
  }),
  image: z.strictObject({
    manifestDigest: imageDigest, configDigest: imageDigest, archive: qualifiedImageArchiveSchema, runnerImageSha256: sha256Schema,
    scanReportSha256: sha256Schema, scanPolicySha256: sha256Schema, findings: verificationImageFindingCountsSchema,
  }),
  runtimeConfigSha256: sha256Schema, rolloutCheckSha256: sha256Schema, recoveryPlanSha256: sha256Schema,
  target: z.strictObject({ applicationId: idSchema, environmentId: idSchema, mappingSha256: sha256Schema, revision: version.min(1) }),
  validUntil: timestamp,
}).refine(manifest => (manifest.originalSnapshotSha256 === manifest.repairedSnapshotSha256) === (manifest.diffSha256 === null));
export type FormalReleaseManifest = z.infer<typeof formalReleaseManifestSchema>;

export const komodoReleaseTargetSchema = formalReleaseTargetSchema.pick({
  komodo: true, registryOrigin: true, deploymentId: true, serverId: true, imageRepository: true, runtimeConfigSha256: true,
}).required();

export const releaseKomodoConfigurationSchema = z.strictObject({
  deploymentId: komodoResourceIdSchema, serverId: komodoResourceIdSchema,
  runtimeConfigSha256: sha256Schema, imageReference: z.string().max(2400),
});
export const releaseKomodoUpdateSchema = z.strictObject({
  updateId: komodoResourceIdSchema, deploymentId: komodoResourceIdSchema, actorId: komodoResourceIdSchema,
  status: z.enum(['Queued', 'InProgress', 'Complete']), success: z.boolean(),
});
export const releaseKomodoCompletionSchema = releaseKomodoUpdateSchema.extend({ status: z.literal('Complete') });
export const releaseKomodoIntentSchema = z.strictObject({
  ...releaseKomodoConfigurationSchema.omit({ imageReference: true }).shape,
  ...formalReleaseTargetSchema.shape.komodo.unwrap().shape,
  ...formalReleaseManifestSchema.shape.target.pick({ revision: true, mappingSha256: true }).shape,
  imageReference: releaseRegistryImageProofSchema.shape.reference,
  previousImageSha256: sha256Schema,
});
export type ReleaseKomodoIntent = z.infer<typeof releaseKomodoIntentSchema>;
export type ReleaseKomodoConfiguration = z.infer<typeof releaseKomodoConfigurationSchema>;
export type ReleaseKomodoCompletion = z.infer<typeof releaseKomodoCompletionSchema>;

export const komodoReleasePhases = ['release_komodo_config_prepared', 'release_komodo_configured',
  'release_komodo_dispatch_prepared', 'release_komodo_update_recorded', 'release_komodo_dispatch_observed'] as const;

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
  imageDigest,
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
export const formalReleaseCandidateDtoSchema = z.strictObject({
  id: idSchema, fingerprint: sha256Schema, manifest: formalReleaseManifestSchema, createdAt: timestamp,
  status: releaseCandidateStatusSchema, decisionVersion: version, decisions: releaseDecisionDtoSchema.array().max(2),
  operationId: idSchema.nullable(), locale: localeSchema, message: z.string().min(1).max(320),
});
const releaseTargetDisplaySchema = z.strictObject({
  applicationId: idSchema, applicationName: applicationDtoSchema.shape.name,
  environmentId: idSchema, environmentName: environmentDtoSchema.shape.name,
});
export const formalReleaseViewSchema = z.strictObject({
  taskId: idSchema, runId: idSchema, taskVersion: version.min(1),
  candidate: formalReleaseCandidateDtoSchema.nullable(),
  candidateTarget: releaseTargetDisplaySchema.nullable(),
  availableTargets: releaseTargetDisplaySchema.extend({ revision: version.min(1) }).array(),
  actions: releaseDecisionSchema.array().max(2),
});
export const formalReleaseOptionsSchema = formalReleaseViewSchema.pick({
  taskId: true, runId: true, taskVersion: true, availableTargets: true,
});
export const formalReleaseDecisionResultSchema = z.strictObject({ candidate: formalReleaseCandidateDtoSchema, replayed: z.boolean() });
export type FormalReleaseCandidateDto = z.infer<typeof formalReleaseCandidateDtoSchema>;
export type FormalReleaseView = z.infer<typeof formalReleaseViewSchema>;

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

export const releaseWakeupSchema = z.strictObject({ operationId: idSchema });
export const fixtureReleaseWakeupSchema = releaseWakeupSchema;
export const fixtureReleaseObservationSchema = z.object({
  version: z.literal(1),
  origin: z.literal('trusted_fixture'),
  operationId: idSchema,
  fingerprint: sha256Schema,
  environmentId: idSchema,
  mappingSha256: sha256Schema,
  imageDigest,
  runtimeConfigSha256: sha256Schema,
  downstreamId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  healthy: z.boolean(),
  accessProtected: z.boolean(),
}).strict();
export const releaseOperationStateSchema = z.enum(['queued', 'dispatching', 'reconciling', 'verified_fixture', 'blocked']);
export const fixtureReleaseOperationSchema = z.object({
  id: idSchema, candidateId: idSchema, environmentId: idSchema,
  state: releaseOperationStateSchema,
  origin: z.literal('trusted_fixture'), releaseEligible: z.literal(false),
  observation: fixtureReleaseObservationSchema.nullable(),
  createdAt: timestamp, updatedAt: timestamp,
  locale: localeSchema, message: z.string(),
}).strict();
export type FixtureReleaseObservation = z.infer<typeof fixtureReleaseObservationSchema>;
export type ReleaseOperationState = z.infer<typeof releaseOperationStateSchema>;
