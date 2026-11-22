import { isAbsolute, posix } from 'node:path';
import { z } from 'zod';
import { auditModelProtocolSchema, idSchema, komodoResourceIdSchema, npmUpgradeApprovalsSchema, sha256Schema,
  standardVerificationProfileSchema, whiskersMcpKeySchema, whiskersReadKeySchema } from '@itervane/contracts';
import { safeEndpoint } from '@itervane/model';
import { sourcePath } from '@itervane/runner';
import { validateIdentityConfig } from './auth/identity.js';

const databaseUrl = z.string().min(1).refine(value => {
  try { return ['postgres:', 'postgresql:'].includes(new URL(value).protocol); } catch { return false; }
}, 'PostgreSQL URL required');
const installationFile = z.string().max(4096).refine(path => isAbsolute(path) && !path.includes('\0'), 'Expected an absolute local installation file');

export function canonicalPublicUrl(value: string): string {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password
    || url.search || url.hash || url.pathname !== '/' || url.href.length > 240) throw new Error('Invalid public URL');
  return url.origin;
}

const operationsEnrollmentScopeSchema = z.strictObject({ environmentId: idSchema, enrollmentSha256: sha256Schema });
const operationsWorkflowScopeSchema = operationsEnrollmentScopeSchema.extend({ diagnosisProviderSha256: sha256Schema.optional() });
const operationsInstallationSchema = operationsWorkflowScopeSchema.extend({ readKey: whiskersReadKeySchema });
const komodoCredential = z.string().min(1).max(512).regex(/^[!-~]+$/);
const komodoReader = z.strictObject({ actorId: komodoResourceIdSchema, key: komodoCredential, secret: komodoCredential });
export type OperationsEnrollmentScope = Readonly<z.infer<typeof operationsEnrollmentScopeSchema>>;
export type OperationsInstallation = Readonly<z.infer<typeof operationsInstallationSchema>>;
export type OperationsWorkflowScope = Readonly<z.infer<typeof operationsWorkflowScopeSchema>>;

function operationsEnvironment(env: NodeJS.ProcessEnv) {
  const diagnosisProviderSha256 = env.ITERVANE_OPERATIONS_DIAGNOSIS_PROVIDER_SHA256;
  return { environmentId: env.ITERVANE_OPERATIONS_ENVIRONMENT_ID, enrollmentSha256: env.ITERVANE_OPERATIONS_ENROLLMENT_SHA256,
    ...(diagnosisProviderSha256 !== undefined ? { diagnosisProviderSha256 } : {}) };
}

export function runtimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = z.object({
    databaseUrl, issuer: z.string().min(1), audience: z.string().min(1),
    host: z.string().min(1).max(253), port: z.coerce.number().int().min(1).max(65_535),
  }).parse({ databaseUrl: env.DATABASE_URL, issuer: env.ITERVANE_OIDC_ISSUER,
    audience: env.ITERVANE_OIDC_AUDIENCE, host: env.ITERVANE_API_HOST ?? '127.0.0.1', port: env.ITERVANE_API_PORT ?? 4310 });
  validateIdentityConfig(config);
  const portalClientId = env.ITERVANE_PORTAL_CLIENT_ID ? z.string().trim().min(1).max(255).parse(env.ITERVANE_PORTAL_CLIENT_ID) : undefined;
  const operationsApi = z.enum(['0', '1']).parse(env.ITERVANE_OPERATIONS_API_ENABLED ?? '0') === '1'
    ? operationsWorkflowScopeSchema.parse(operationsEnvironment(env)) : undefined;
  const restartApiInstallationFile = installationFile.optional().parse(env.ITERVANE_RESTART_API_INSTALLATION_FILE);
  const restoreEnabled = z.enum(['0', '1']).parse(env.ITERVANE_RESTORE_API_ENABLED ?? '0') === '1';
  const hasDiagnosisAndPortal = operationsApi?.diagnosisProviderSha256 && portalClientId && portalClientId !== 'signed-access-token';
  if (restartApiInstallationFile && !hasDiagnosisAndPortal) {
    throw new Error('operations_restart_api_requires_formal_diagnosis_and_portal');
  }
  if (restoreEnabled && !hasDiagnosisAndPortal) throw new Error('operations_restore_api_requires_formal_diagnosis_and_portal');
  const restoreApi = restoreEnabled ? operationsEffectTarget(env) : undefined;
  return { ...config, publicUrl: canonicalPublicUrl(env.ITERVANE_PUBLIC_URL ?? `http://127.0.0.1:${config.port}`),
    ...(portalClientId ? { portalClientId } : {}), ...(operationsApi ? { operationsApi } : {}),
    ...(restartApiInstallationFile ? { restartApiInstallationFile } : {}), ...(restoreApi ? { restoreApi } : {}) };
}

function sharedWorkerConfig(env: NodeJS.ProcessEnv) {
  return z.object({ databaseUrl, leaseSeconds: z.coerce.number().int().min(2).max(60), pollMs: z.coerce.number().int().min(100).max(10_000) })
    .parse({ databaseUrl: env.DATABASE_URL, leaseSeconds: env.ITERVANE_WORKER_LEASE_SECONDS ?? 10, pollMs: env.ITERVANE_WORKER_POLL_MS ?? 1_000 });
}

function workerRunnerConfig(env: NodeJS.ProcessEnv) {
  const address = { socketPath: env.ITERVANE_RUNNER_SOCKET, controllerUid: env.ITERVANE_RUNNER_UID, imageSha256: env.ITERVANE_RUNNER_IMAGE_SHA256 };
  return Object.values(address).some(value => value !== undefined) ? z.object({
    socketPath: z.string().refine(value => posix.isAbsolute(value) && value.endsWith('.sock') && Buffer.byteLength(value) <= 100),
    controllerUid: z.coerce.number().int().min(1).max(2147483647),
    imageSha256: sha256Schema,
  }).parse(address) : undefined;
}

export function workerConfig(env: NodeJS.ProcessEnv = process.env) {
  const worker = sharedWorkerConfig(env);
  const runner = workerRunnerConfig(env);
  const operationsSettings = { ...operationsEnvironment(env), readKey: env.ITERVANE_OPERATIONS_WHISKERS_READ_KEY };
  const operations = Object.values(operationsSettings).some(value => value !== undefined)
    ? operationsInstallationSchema.parse(operationsSettings) : undefined;
  const selected = env.ITERVANE_AUDIT_MODEL_PROVIDER;
  if (operations?.diagnosisProviderSha256 && !selected) throw new Error('Formal operations diagnosis requires a configured model');
  const repairEnabled = z.enum(['0', '1']).parse(env.ITERVANE_FORMAL_REPAIR ?? '0') === '1';
  if (repairEnabled && (!runner || !selected)) throw new Error('Formal repair requires a qualified Runner and a configured model');
  const additionalProtections = repairEnabled
    ? z.array(z.string()).max(62).parse(JSON.parse(env.ITERVANE_REPAIR_PROTECTED_PATHS ?? '[]')) : [];
  const repairProtectedPaths = repairEnabled
    ? [...new Set(['.github', '.itervane', ...additionalProtections].map(path => sourcePath(path).toLowerCase()))] : undefined;
  const npmRepairApprovals = repairEnabled ? npmUpgradeApprovalsSchema.parse(JSON.parse(env.ITERVANE_NPM_REPAIR_APPROVALS ?? '[]')) : [];
  const verificationProfile = env.ITERVANE_VERIFICATION_PROFILE === undefined ? undefined
    : standardVerificationProfileSchema.parse(JSON.parse(env.ITERVANE_VERIFICATION_PROFILE));
  if (verificationProfile && (!selected || runner?.imageSha256 !== verificationProfile.runnerImageSha256)) {
    throw new Error('Formal verification requires a configured model and the same qualified Runner image');
  }
  const options = { ...worker, runner, operations, repairProtectedPaths, npmRepairApprovals, verificationProfile };
  if (selected === undefined) return { ...options, auditModel: undefined };
  const protocol = auditModelProtocolSchema.parse(selected);
  const prefix = protocol === 'anthropic' ? 'ANTHROPIC' : 'OPENAI';
  const modelConfig = z.strictObject({ apiKey: z.string().min(1).max(4096), model: z.string().trim().min(1).max(240),
    baseURL: z.string().min(1).max(2048).transform(safeEndpoint) }).parse({
    apiKey: env[`${prefix}_API_KEY`], model: env[`${prefix}_MODEL`], baseURL: env[`${prefix}_BASE_URL`],
  });
  return { ...options, auditModel: { protocol, ...modelConfig } };
}

export function releaseWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  const worker = sharedWorkerConfig(env);
  const runner = workerRunnerConfig(env);
  if (!runner) throw new Error('Release Worker requires a qualified Runner');
  const installed = z.strictObject({ environmentId: idSchema, mappingSha256: sha256Schema }).parse({
    environmentId: env.ITERVANE_RELEASE_ENVIRONMENT_ID, mappingSha256: env.ITERVANE_RELEASE_TARGET_SHA256,
  });
  const executable = z.string().max(4096).refine(path => posix.isAbsolute(path) && !path.includes('\0'), 'Expected a local executable path');
  const tools = z.strictObject({ materializer: executable, skopeo: executable }).parse({
    materializer: env.ITERVANE_RELEASE_MATERIALIZER, skopeo: env.ITERVANE_RELEASE_SKOPEO,
  });
  const credentials = z.strictObject({
    komodoKey: z.string().min(1).max(1024), komodoSecret: z.string().min(1).max(1024), probeSecret: z.string().min(1).max(1024),
    registry: z.strictObject({ username: z.string().min(1).max(255), password: z.string().min(1).max(1024) }).optional(),
  }).parse({
    komodoKey: env.ITERVANE_RELEASE_KOMODO_KEY, komodoSecret: env.ITERVANE_RELEASE_KOMODO_SECRET,
    probeSecret: env.ITERVANE_RELEASE_PROBE_SECRET,
    registry: env.ITERVANE_RELEASE_REGISTRY_USER === undefined && env.ITERVANE_RELEASE_REGISTRY_PASSWORD === undefined
      ? undefined : { username: env.ITERVANE_RELEASE_REGISTRY_USER, password: env.ITERVANE_RELEASE_REGISTRY_PASSWORD },
  });
  return { ...worker, runner, installed, tools, credentials };
}

function operationsEffectTarget(env: NodeJS.ProcessEnv) {
  return operationsEnrollmentScopeSchema.extend({ mappingSha256: sha256Schema }).parse({
    environmentId: env.ITERVANE_OPERATIONS_ENVIRONMENT_ID, enrollmentSha256: env.ITERVANE_OPERATIONS_ENROLLMENT_SHA256,
    mappingSha256: env.ITERVANE_OPERATIONS_RELEASE_TARGET_SHA256,
  });
}

export function restartWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  const worker = sharedWorkerConfig(env);
  const installed = operationsEffectTarget(env);
  const files = z.strictObject({ installation: installationFile, guardrails: installationFile, roles: installationFile }).parse({
    installation: env.ITERVANE_RESTART_INSTALLATION_FILE, guardrails: env.ITERVANE_RESTART_GUARDRAILS_FILE, roles: env.ITERVANE_RESTART_ROLES_FILE,
  });
  const writeKey = whiskersMcpKeySchema.parse(env.ITERVANE_RESTART_WHISKERS_WRITE_KEY);
  const komodo = komodoReader.parse({
    actorId: env.ITERVANE_RESTART_KOMODO_READER_ID, key: env.ITERVANE_RESTART_KOMODO_READER_KEY, secret: env.ITERVANE_RESTART_KOMODO_READER_SECRET,
  });
  const probeSecret = z.string().min(1).max(1024).parse(env.ITERVANE_RESTART_PROBE_SECRET);
  return { ...worker, installed, files, writeKey, komodo, probeSecret };
}

export function restoreWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  const worker = sharedWorkerConfig(env);
  const installed = operationsEffectTarget(env);
  const writer = z.strictObject({ key: komodoCredential, secret: komodoCredential }).parse({
    key: env.ITERVANE_RESTORE_KOMODO_WRITER_KEY, secret: env.ITERVANE_RESTORE_KOMODO_WRITER_SECRET,
  });
  const reader = komodoReader.parse({
    actorId: env.ITERVANE_RESTORE_KOMODO_READER_ID, key: env.ITERVANE_RESTORE_KOMODO_READER_KEY,
    secret: env.ITERVANE_RESTORE_KOMODO_READER_SECRET,
  });
  if (writer.key === reader.key) throw new Error('operations_restore_distinct_credentials_required');
  const probeSecret = z.string().min(1).max(1024).parse(env.ITERVANE_RESTORE_PROBE_SECRET);
  return { ...worker, installed, writer, reader, probeSecret };
}

export function healthWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  const installed = operationsEffectTarget(env);
  const reader = komodoReader.parse({
    actorId: env.ITERVANE_HEALTH_KOMODO_READER_ID, key: env.ITERVANE_HEALTH_KOMODO_READER_KEY,
    secret: env.ITERVANE_HEALTH_KOMODO_READER_SECRET,
  });
  return { installed, reader, databaseUrl: databaseUrl.parse(env.DATABASE_URL),
    probeSecret: z.string().min(1).max(1024).parse(env.ITERVANE_HEALTH_PROBE_SECRET),
    pollMs: z.coerce.number().int().min(5_000).max(300_000).parse(env.ITERVANE_HEALTH_POLL_MS ?? 30_000) };
}

export function migrationConfig(env: NodeJS.ProcessEnv = process.env) {
  // 不回退到运行账号，防止把生产启动变成自动 DDL。
  return databaseUrl.parse(env.ITERVANE_MIGRATION_DATABASE_URL);
}
