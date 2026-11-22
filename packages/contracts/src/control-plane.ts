import { z } from 'zod';
import { idSchema, sourceRefSchema, taskStateSchema } from './primitives.js';
import { localeSchema, messageKeySchema, taskEventTypes, taskEventReasonSchema } from './i18n.js';

const nameSchema = z.string().trim().min(1).max(120);
const timestampSchema = z.iso.datetime();
export const projectInputSchema = z.object({
  name: nameSchema, slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
}).strict();
export const repositoryInputSchema = z.object({
  name: nameSchema,
  url: z.string().max(2_048).refine(value => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
  }, 'Repository URL must be HTTPS without credentials, query or fragment')
    .transform(value => new URL(value).toString().replace(/\/$/, '')),
}).strict();
export const applicationInputSchema = z.object({ name: nameSchema }).strict();
export const environmentInputSchema = z.object({ applicationId: idSchema, name: nameSchema }).strict();
export const cancelTaskSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
export const resumeTaskSchema = cancelTaskSchema;
export const listQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();

export const projectDtoSchema = z.object({
  id: idSchema, workspaceId: idSchema, name: nameSchema, slug: z.string(), createdAt: timestampSchema,
}).strict();
export const repositoryDtoSchema = z.object({
  id: idSchema, projectId: idSchema, name: nameSchema, url: z.string(), createdAt: timestampSchema,
}).strict();
export const applicationDtoSchema = z.object({
  id: idSchema, projectId: idSchema, name: nameSchema, createdAt: timestampSchema,
}).strict();
export const environmentDtoSchema = z.object({
  id: idSchema, projectId: idSchema, applicationId: idSchema, name: nameSchema,
  access: z.literal('protected'), createdAt: timestampSchema,
}).strict();
export const taskDtoSchema = z.object({
  id: idSchema, projectId: idSchema, requestedBy: idSchema, runId: idSchema,
  source: sourceRefSchema, purpose: z.string(), dataClass: z.enum(['synthetic', 'public']),
  state: taskStateSchema, version: z.number().int().positive(), locale: localeSchema, createdAt: timestampSchema,
}).strict();
export const taskEventDtoSchema = z.object({
  taskId: idSchema, sequence: z.number().int().positive(),
  type: z.enum(taskEventTypes), state: taskStateSchema,
  actorId: idSchema, actorKind: z.enum(['principal', 'worker']), workerId: idSchema.nullable(),
  reason: taskEventReasonSchema.nullable(), reasonMessage: z.string().nullable(),
  messageKey: messageKeySchema, message: z.string(), locale: localeSchema, createdAt: timestampSchema,
}).strict();
export const admissionDtoSchema = z.object({ task: taskDtoSchema, replayed: z.boolean() }).strict();
export const meDtoSchema = z.object({
  principalId: idSchema, workspaceId: idSchema.nullable(), isWorkspaceOwner: z.boolean(),
}).strict();
export const projectAccessDtoSchema = z.object({
  projectId: idSchema, role: z.enum(['owner', 'maintainer', 'viewer']), canWrite: z.boolean(),
}).strict();
export const portalConfigSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({ enabled: z.literal(true), authority: z.url(), clientId: z.string().min(1).max(255),
    redirectUri: z.url(), postLogoutRedirectUri: z.url() }).strict(),
]);
export const capabilitiesSchema = z.object({
  stage: z.enum(['p1-e', 'p3-a']), taskAdmission: z.literal(true), taskExecution: z.literal(false), durableScheduling: z.literal(true),
  ruleQuery: z.literal(true), limitedTextPreaudit: z.literal(true), autonomousAgents: z.literal(false),
  sourceInspectionPlanning: z.literal(true), sourceSnapshots: z.literal(false), sourceScanning: z.literal(false),
  portal: z.boolean(), browserLogin: z.boolean(),
  externalMcp: z.boolean(), sandbox: z.literal(false), deployment: z.literal(false), operations: z.boolean(),
}).strict();
export const apiErrorSchema = z.object({ error: z.object({
  code: z.enum(['invalid_input', 'unauthenticated', 'forbidden', 'not_found', 'conflict',
    'idempotency_conflict', 'version_conflict', 'unsupported_state', 'unavailable', 'internal_error', 'resume_limit']),
  requestId: idSchema,
  messageKey: messageKeySchema, message: z.string(), locale: localeSchema,
}).strict() }).strict();

export type ProjectInput = z.infer<typeof projectInputSchema>;
export type RepositoryInput = z.infer<typeof repositoryInputSchema>;
export type ProjectDto = z.infer<typeof projectDtoSchema>;
export type RepositoryDto = z.infer<typeof repositoryDtoSchema>;
export type ApplicationDto = z.infer<typeof applicationDtoSchema>;
export type EnvironmentDto = z.infer<typeof environmentDtoSchema>;
export type TaskDto = z.infer<typeof taskDtoSchema>;
export type TaskEventDto = z.infer<typeof taskEventDtoSchema>;
export type MeDto = z.infer<typeof meDtoSchema>;
export type ProjectAccessDto = z.infer<typeof projectAccessDtoSchema>;
export type PortalConfig = z.infer<typeof portalConfigSchema>;
export type ApiErrorCode = z.infer<typeof apiErrorSchema>['error']['code'];
