import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  canonicalPublicUrl, healthWorkerConfig, migrationConfig, releaseWorkerConfig, restartWorkerConfig, restoreWorkerConfig, runtimeConfig, workerConfig,
} from '../../src/config.js';

const configured = {
  DATABASE_URL: 'postgresql://localhost/itervane', ITERVANE_OIDC_ISSUER: 'https://identity.example/realms/personal',
  ITERVANE_OIDC_AUDIENCE: 'itervane-api',
};

it('requires identity and database configuration before starting a listener', () => {
  expect(() => runtimeConfig({})).toThrow();
  expect(() => runtimeConfig({ DATABASE_URL: configured.DATABASE_URL })).toThrow();
  expect(runtimeConfig(configured)).toMatchObject({ host: '127.0.0.1', port: 4310 });
});

it('enables the operations API only for a complete enrollment and keeps the Read key in the Worker', () => {
  const environmentId = '01020304-1000-4000-8000-010203040506';
  const enrollmentSha256 = 'a'.repeat(64);
  const readKey = 'b'.repeat(64);
  const installation = { ...configured, ITERVANE_OPERATIONS_ENVIRONMENT_ID: environmentId,
    ITERVANE_OPERATIONS_ENROLLMENT_SHA256: enrollmentSha256, ITERVANE_OPERATIONS_WHISKERS_READ_KEY: readKey };
  expect(runtimeConfig(installation)).not.toHaveProperty('operationsApi');
  expect(runtimeConfig({ ...installation, ITERVANE_OPERATIONS_API_ENABLED: '1' })).toHaveProperty('operationsApi', { environmentId, enrollmentSha256 });
  expect(workerConfig(installation).operations).toEqual({ environmentId, enrollmentSha256, readKey });
  expect(() => runtimeConfig({ ...configured, ITERVANE_OPERATIONS_API_ENABLED: '1' })).toThrow();
  expect(() => runtimeConfig({ ...installation, ITERVANE_OPERATIONS_API_ENABLED: 'true' })).toThrow();
});

it('requires a trusted model fingerprint and configured Worker model for full operations diagnosis', () => {
  const environmentId = '01020304-1000-4000-8000-010203040507';
  const enrollmentSha256 = 'a'.repeat(64);
  const diagnosisProviderSha256 = 'c'.repeat(64);
  const readKey = 'b'.repeat(64);
  const installation = { ...configured, ITERVANE_OPERATIONS_API_ENABLED: '1', ITERVANE_OPERATIONS_ENVIRONMENT_ID: environmentId,
    ITERVANE_OPERATIONS_ENROLLMENT_SHA256: enrollmentSha256, ITERVANE_OPERATIONS_DIAGNOSIS_PROVIDER_SHA256: diagnosisProviderSha256 };
  expect(runtimeConfig(installation).operationsApi).toEqual({ environmentId, enrollmentSha256, diagnosisProviderSha256 });
  expect(runtimeConfig({ ...installation, ITERVANE_OPERATIONS_API_ENABLED: '0' }).operationsApi).toBeUndefined();
  expect(() => runtimeConfig({ ...installation, ITERVANE_OPERATIONS_DIAGNOSIS_PROVIDER_SHA256: 'invalid' })).toThrow();
  const worker = { ...installation, ITERVANE_OPERATIONS_WHISKERS_READ_KEY: readKey };
  expect(() => workerConfig(worker)).toThrow('requires a configured model');
  for (const [protocol, prefix] of [['anthropic', 'ANTHROPIC'], ['openai', 'OPENAI']] as const) {
    const config = workerConfig({ ...worker, ITERVANE_AUDIT_MODEL_PROVIDER: protocol, [`${prefix}_BASE_URL`]: 'http://127.0.0.1:23001',
      [`${prefix}_API_KEY`]: 'fixture', [`${prefix}_MODEL`]: 'fixture-model' });
    expect(config.auditModel?.protocol).toBe(protocol);
    expect(config.operations).toEqual({ environmentId, enrollmentSha256, diagnosisProviderSha256, readKey });
  }
});

it('starts restore submission only with explicit API opt-in and the formal operations scope', () => {
  const environmentId = '01020304-1000-4000-8000-010203040507';
  const enrollmentSha256 = 'a'.repeat(64);
  const mappingSha256 = 'b'.repeat(64);
  const env = { ...configured, ITERVANE_PORTAL_CLIENT_ID: 'itervane-portal', ITERVANE_OPERATIONS_API_ENABLED: '1',
    ITERVANE_OPERATIONS_ENVIRONMENT_ID: environmentId, ITERVANE_OPERATIONS_ENROLLMENT_SHA256: enrollmentSha256,
    ITERVANE_OPERATIONS_DIAGNOSIS_PROVIDER_SHA256: 'c'.repeat(64), ITERVANE_OPERATIONS_RELEASE_TARGET_SHA256: mappingSha256 };
  expect(runtimeConfig(env)).not.toHaveProperty('restoreApi');
  expect(runtimeConfig({ ...env, ITERVANE_RESTORE_API_ENABLED: '0' })).not.toHaveProperty('restoreApi');
  const enabled = { ...env, ITERVANE_RESTORE_API_ENABLED: '1' };
  expect(runtimeConfig(enabled).restoreApi).toEqual({ environmentId, enrollmentSha256, mappingSha256 });
  for (const override of [{ ITERVANE_OPERATIONS_API_ENABLED: '0' }, { ITERVANE_OPERATIONS_DIAGNOSIS_PROVIDER_SHA256: undefined },
    { ITERVANE_PORTAL_CLIENT_ID: undefined }, { ITERVANE_PORTAL_CLIENT_ID: 'signed-access-token' }]) {
    expect(() => runtimeConfig({ ...enabled, ...override })).toThrow('operations_restore_api_requires_formal_diagnosis_and_portal');
  }
  expect(() => runtimeConfig({ ...enabled, ITERVANE_OPERATIONS_RELEASE_TARGET_SHA256: undefined })).toThrow();
  expect(() => runtimeConfig({ ...enabled, ITERVANE_RESTORE_API_ENABLED: 'true' })).toThrow();
});

it('does not reuse the runtime credential as an implicit migration credential', () => {
  expect(() => migrationConfig(configured)).toThrow();
  expect(migrationConfig({ ITERVANE_MIGRATION_DATABASE_URL: 'postgresql://localhost/itervane' })).toBe('postgresql://localhost/itervane');
});

it('refuses credential-bearing or plaintext remote identity URLs', () => {
  for (const issuer of ['http://remote.example/realm', 'https://user:password@identity.example/realm']) {
    expect(() => runtimeConfig({ ...configured, ITERVANE_OIDC_ISSUER: issuer })).toThrow();
  }
});

it('starts workers without API identity credentials and bounds their lease and polling settings', () => {
  expect(workerConfig({ DATABASE_URL: configured.DATABASE_URL })).toMatchObject({ leaseSeconds: 10, pollMs: 1_000 });
  for (const overrides of [{ ITERVANE_WORKER_LEASE_SECONDS: '1' }, { ITERVANE_WORKER_POLL_MS: '0' }]) {
    expect(() => workerConfig({ DATABASE_URL: configured.DATABASE_URL, ...overrides })).toThrow();
  }
});

it('requires a complete local socket, separate controller UID and pinned image for optional source inspection', () => {
  const environment = { DATABASE_URL: configured.DATABASE_URL, ITERVANE_RUNNER_SOCKET: '/run/itervane/inspection.sock',
    ITERVANE_RUNNER_UID: '1234', ITERVANE_RUNNER_IMAGE_SHA256: 'a'.repeat(64) };
  expect(workerConfig(environment).runner).toEqual({ socketPath: environment.ITERVANE_RUNNER_SOCKET, controllerUid: 1234, imageSha256: environment.ITERVANE_RUNNER_IMAGE_SHA256 });
  for (const overrides of [{ ITERVANE_RUNNER_UID: '0' }, { ITERVANE_RUNNER_IMAGE_SHA256: undefined },
    { ITERVANE_RUNNER_SOCKET: 'https://example.invalid/runner.sock' }]) expect(() => workerConfig({ ...environment, ...overrides })).toThrow();
  expect(workerConfig({ DATABASE_URL: configured.DATABASE_URL }).runner).toBeUndefined();
});

it('starts the release worker only with a pinned environment, qualified Runner and complete service credentials', () => {
  const environment = {
    DATABASE_URL: configured.DATABASE_URL,
    ITERVANE_RUNNER_SOCKET: '/run/itervane/inspection.sock', ITERVANE_RUNNER_UID: '1234', ITERVANE_RUNNER_IMAGE_SHA256: 'a'.repeat(64),
    ITERVANE_RELEASE_ENVIRONMENT_ID: '123e4567-e89b-42d3-a456-426614174000', ITERVANE_RELEASE_TARGET_SHA256: 'b'.repeat(64),
    ITERVANE_RELEASE_MATERIALIZER: '/opt/itervane/oci-layout', ITERVANE_RELEASE_SKOPEO: '/usr/bin/skopeo',
    ITERVANE_RELEASE_KOMODO_KEY: 'fixture-key', ITERVANE_RELEASE_KOMODO_SECRET: 'fixture-secret',
    ITERVANE_RELEASE_PROBE_SECRET: 'fixture-health',
  };
  expect(releaseWorkerConfig(environment)).toMatchObject({
    installed: { environmentId: environment.ITERVANE_RELEASE_ENVIRONMENT_ID, mappingSha256: environment.ITERVANE_RELEASE_TARGET_SHA256 },
    tools: { materializer: environment.ITERVANE_RELEASE_MATERIALIZER, skopeo: environment.ITERVANE_RELEASE_SKOPEO },
    runner: { controllerUid: 1234 }, leaseSeconds: 10,
  });
  for (const overrides of [{ ITERVANE_RELEASE_PROBE_SECRET: undefined }, { ITERVANE_RUNNER_IMAGE_SHA256: undefined },
    { ITERVANE_RELEASE_TARGET_SHA256: undefined }, { ITERVANE_RELEASE_SKOPEO: 'skopeo' }, { ITERVANE_RELEASE_REGISTRY_USER: 'missing-password' }]) {
    expect(() => releaseWorkerConfig({ ...environment, ...overrides })).toThrow();
  }
  expect(workerConfig(environment).auditModel).toBeUndefined();
});

it('fixes the public MCP URL in configuration instead of deriving it from untrusted request headers', () => {
  expect(canonicalPublicUrl('https://itervane.example/')).toBe('https://itervane.example');
  expect(runtimeConfig(configured).publicUrl).toBe('http://127.0.0.1:4310');
  for (const value of ['http://remote.example', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com?token=x']) {
    expect(() => canonicalPublicUrl(value)).toThrow();
  }
});

it('requires a complete, process-local restart installation and separate read credentials', () => {
  const environment = { ...configured,
    ITERVANE_OPERATIONS_ENVIRONMENT_ID: '123e4567-e89b-42d3-a456-426614174000', ITERVANE_OPERATIONS_ENROLLMENT_SHA256: 'd'.repeat(64),
    ITERVANE_OPERATIONS_RELEASE_TARGET_SHA256: 'c'.repeat(64),
    ITERVANE_RESTART_INSTALLATION_FILE: resolve('fixtures/installation.json'),
    ITERVANE_RESTART_GUARDRAILS_FILE: resolve('fixtures/guardrails.json'), ITERVANE_RESTART_ROLES_FILE: resolve('fixtures/roles.json'),
    ITERVANE_RESTART_WHISKERS_WRITE_KEY: 'a'.repeat(64), ITERVANE_RESTART_KOMODO_READER_ID: 'b'.repeat(24),
    ITERVANE_RESTART_KOMODO_READER_KEY: 'fixture-reader', ITERVANE_RESTART_KOMODO_READER_SECRET: 'fixture-secret',
    ITERVANE_RESTART_PROBE_SECRET: 'fixture-health',
  };
  expect(restartWorkerConfig(environment)).toMatchObject({ installed: { environmentId: environment.ITERVANE_OPERATIONS_ENVIRONMENT_ID,
    enrollmentSha256: 'd'.repeat(64), mappingSha256: 'c'.repeat(64) }, komodo: { actorId: 'b'.repeat(24) } });
  expect(runtimeConfig(environment).operationsApi).toBeUndefined();
  for (const invalid of [{ ITERVANE_RESTART_INSTALLATION_FILE: 'relative.json' }, { ITERVANE_RESTART_KOMODO_READER_SECRET: undefined },
    { ITERVANE_RESTART_PROBE_SECRET: undefined }, { ITERVANE_OPERATIONS_RELEASE_TARGET_SHA256: 'invalid' },
    { ITERVANE_RESTART_WHISKERS_WRITE_KEY: undefined, ITERVANE_OPERATIONS_WHISKERS_READ_KEY: 'a'.repeat(64) }]) {
    expect(() => restartWorkerConfig({ ...environment, ...invalid })).toThrow();
  }
});

it.each(['anthropic', 'openai'] as const)('configures the %s audit adapter only after explicit selection', protocol => {
  const prefix = protocol.toUpperCase();
  const endpoint = 'http://localhost:4312';
  const credentials = { ...configured, MODEL_PROVIDER: protocol, [`${prefix}_API_KEY`]: 'test-credential',
    [`${prefix}_MODEL`]: 'test-model', [`${prefix}_BASE_URL`]: endpoint };
  expect(workerConfig(credentials).auditModel).toBeUndefined();
  const enabled = { ...credentials, ITERVANE_AUDIT_MODEL_PROVIDER: protocol };
  expect(workerConfig(enabled).auditModel).toMatchObject({ protocol, baseURL: endpoint, model: 'test-model' });
  expect(() => workerConfig({ ...enabled, [`${prefix}_BASE_URL`]: 'http://example.invalid' })).toThrow();
  expect(() => workerConfig({ ...enabled, [`${prefix}_MODEL`]: undefined })).toThrow();
});

it('binds the restore worker to the enrollment, release mapping and separate Komodo credentials', () => {
  const environment = { DATABASE_URL: configured.DATABASE_URL,
    ITERVANE_OPERATIONS_ENVIRONMENT_ID: '3c486a10-028d-4295-8c0c-d89a38061649',
    ITERVANE_OPERATIONS_ENROLLMENT_SHA256: 'a'.repeat(64), ITERVANE_OPERATIONS_RELEASE_TARGET_SHA256: 'b'.repeat(64),
    ITERVANE_RESTORE_KOMODO_WRITER_KEY: 'writer-key', ITERVANE_RESTORE_KOMODO_WRITER_SECRET: 'writer-secret',
    ITERVANE_RESTORE_KOMODO_READER_ID: 'c'.repeat(24), ITERVANE_RESTORE_KOMODO_READER_KEY: 'reader-key',
    ITERVANE_RESTORE_KOMODO_READER_SECRET: 'reader-secret', ITERVANE_RESTORE_PROBE_SECRET: 'probe-secret' };
  expect(restoreWorkerConfig(environment)).toMatchObject({
    installed: { environmentId: environment.ITERVANE_OPERATIONS_ENVIRONMENT_ID, enrollmentSha256: 'a'.repeat(64), mappingSha256: 'b'.repeat(64) },
    writer: { key: 'writer-key' }, reader: { actorId: 'c'.repeat(24), key: 'reader-key' },
  });
  for (const overrides of [{ ITERVANE_OPERATIONS_RELEASE_TARGET_SHA256: undefined }, { ITERVANE_OPERATIONS_ENROLLMENT_SHA256: 'wrong' },
    { ITERVANE_RESTORE_KOMODO_WRITER_SECRET: undefined }, { ITERVANE_RESTORE_KOMODO_READER_ID: undefined },
    { ITERVANE_RESTORE_KOMODO_READER_KEY: 'writer-key' }, { ITERVANE_RESTORE_PROBE_SECRET: undefined }]) {
    expect(() => restoreWorkerConfig({ ...environment, ...overrides })).toThrow();
  }
});

it('requires a fixed enrollment, dedicated health credentials and bounded polling', () => {
  const environment = { DATABASE_URL: configured.DATABASE_URL,
    ITERVANE_OPERATIONS_ENVIRONMENT_ID: '3c486a10-028d-4295-8c0c-d89a38061649',
    ITERVANE_OPERATIONS_ENROLLMENT_SHA256: 'a'.repeat(64), ITERVANE_OPERATIONS_RELEASE_TARGET_SHA256: 'b'.repeat(64),
    ITERVANE_HEALTH_KOMODO_READER_ID: 'c'.repeat(24), ITERVANE_HEALTH_KOMODO_READER_KEY: 'reader-key',
    ITERVANE_HEALTH_KOMODO_READER_SECRET: 'reader-secret', ITERVANE_HEALTH_PROBE_SECRET: 'probe-secret',
  };
  expect(healthWorkerConfig(environment)).toMatchObject({
    installed: { environmentId: environment.ITERVANE_OPERATIONS_ENVIRONMENT_ID, enrollmentSha256: 'a'.repeat(64), mappingSha256: 'b'.repeat(64) },
    reader: { actorId: 'c'.repeat(24), key: 'reader-key' }, pollMs: 30_000,
  });
  expect(healthWorkerConfig({ ...environment, ITERVANE_HEALTH_POLL_MS: '5000' }).pollMs).toBe(5_000);
  for (const overrides of [{ ITERVANE_OPERATIONS_RELEASE_TARGET_SHA256: undefined }, { ITERVANE_HEALTH_KOMODO_READER_SECRET: undefined },
    { ITERVANE_HEALTH_PROBE_SECRET: undefined, ITERVANE_RESTORE_PROBE_SECRET: 'unrelated-secret' },
    { ITERVANE_HEALTH_POLL_MS: '4999' }, { ITERVANE_HEALTH_POLL_MS: '300001' }]) {
    expect(() => healthWorkerConfig({ ...environment, ...overrides })).toThrow();
  }
});

it('requires explicit formal repair, a qualified Runner, a configured model and canonical protected paths', () => {
  const environment = { ...configured, ITERVANE_RUNNER_SOCKET: '/run/itervane/inspection.sock',
    ITERVANE_RUNNER_UID: '1234', ITERVANE_RUNNER_IMAGE_SHA256: 'a'.repeat(64), ITERVANE_AUDIT_MODEL_PROVIDER: 'anthropic',
    ANTHROPIC_BASE_URL: 'http://localhost:4312', ANTHROPIC_API_KEY: 'test-credential', ANTHROPIC_MODEL: 'fixture' };
  expect(workerConfig(environment).repairProtectedPaths).toBeUndefined();
  const enabled = { ...environment, ITERVANE_FORMAL_REPAIR: '1' };
  expect(() => workerConfig({ ...enabled, ITERVANE_AUDIT_MODEL_PROVIDER: undefined })).toThrow();
  expect(() => workerConfig({ ...enabled, ITERVANE_RUNNER_SOCKET: undefined })).toThrow();
  expect(() => workerConfig({ ...enabled, ITERVANE_REPAIR_PROTECTED_PATHS: '["../platform-tests"]' })).toThrow();
  expect(workerConfig({ ...enabled, ITERVANE_REPAIR_PROTECTED_PATHS: '["platform-tests",".GitHub"]' }).repairProtectedPaths)
    .toEqual(['.github', '.itervane', 'platform-tests']);
});

it('loads reviewed npm upgrades only when formal repair is enabled and rejects ambiguous or invalid entries', () => {
  const entry = { advisoryId: 'CVE-2021-23337', name: 'lodash', installedVersion: '4.17.20', fixedVersion: '4.17.21',
    integrity: `sha512-${'A'.repeat(86)}==` };
  const environment = { ...configured, ITERVANE_RUNNER_SOCKET: '/run/itervane/inspection.sock',
    ITERVANE_RUNNER_UID: '1234', ITERVANE_RUNNER_IMAGE_SHA256: 'a'.repeat(64), ITERVANE_AUDIT_MODEL_PROVIDER: 'anthropic',
    ANTHROPIC_BASE_URL: 'http://localhost:4312', ANTHROPIC_API_KEY: 'test-credential', ANTHROPIC_MODEL: 'fixture' };
  const enabled = { ...environment, ITERVANE_FORMAL_REPAIR: '1' };
  expect(workerConfig(environment).npmRepairApprovals).toEqual([]);
  expect(workerConfig(enabled).npmRepairApprovals).toEqual([]);
  expect(workerConfig({ ...enabled, ITERVANE_NPM_REPAIR_APPROVALS: JSON.stringify([entry]) }).npmRepairApprovals).toEqual([entry]);
  expect(workerConfig({ ...environment, ITERVANE_NPM_REPAIR_APPROVALS: JSON.stringify([entry]) }).npmRepairApprovals).toEqual([]);
  for (const entries of [[entry, { ...entry, fixedVersion: '4.17.22' }], [{ ...entry, integrity: 'sha512-invalid' }],
    [{ ...entry, fixedVersion: entry.installedVersion }]]) {
    expect(() => workerConfig({ ...enabled, ITERVANE_NPM_REPAIR_APPROVALS: JSON.stringify(entries) })).toThrow();
  }
});

it('requires the complete verification profile to match the configured Runner image', () => {
  const profile = { id: 'standard-v1', policySha256: 'b'.repeat(64), baselineSha256: 'c'.repeat(64),
    scannerInputsSha256: 'd'.repeat(64), runnerImageSha256: 'a'.repeat(64), buildProfileSha256: 'e'.repeat(64),
    runStandardBaseline: true, ociInputsSha256: 'f'.repeat(64), retainStandardImage: true };
  const environment = { ...configured, ITERVANE_RUNNER_SOCKET: '/run/itervane/inspection.sock',
    ITERVANE_RUNNER_UID: '1234', ITERVANE_RUNNER_IMAGE_SHA256: profile.runnerImageSha256, ITERVANE_AUDIT_MODEL_PROVIDER: 'anthropic',
    ANTHROPIC_BASE_URL: 'http://localhost:4312', ANTHROPIC_API_KEY: 'test-credential', ANTHROPIC_MODEL: 'fixture' };
  expect(workerConfig(environment).verificationProfile).toBeUndefined();
  const enabled = { ...environment, ITERVANE_VERIFICATION_PROFILE: JSON.stringify(profile) };
  expect(workerConfig(enabled).verificationProfile).toEqual(profile);
  for (const overrides of [{ ITERVANE_RUNNER_IMAGE_SHA256: '9'.repeat(64) }, { ITERVANE_AUDIT_MODEL_PROVIDER: undefined },
    { ITERVANE_VERIFICATION_PROFILE: JSON.stringify({ ...profile, retainStandardImage: undefined }) }]) {
    expect(() => workerConfig({ ...enabled, ...overrides })).toThrow();
  }
});
