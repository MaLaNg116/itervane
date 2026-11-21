import { expect, it } from 'vitest';
import { canonicalPublicUrl, migrationConfig, runtimeConfig, workerConfig } from '../../src/config.js';

const configured = {
  DATABASE_URL: 'postgresql://localhost/itervane', ITERVANE_OIDC_ISSUER: 'https://identity.example/realms/personal',
  ITERVANE_OIDC_AUDIENCE: 'itervane-api',
};

it('requires identity and database configuration before starting a listener', () => {
  expect(() => runtimeConfig({})).toThrow();
  expect(() => runtimeConfig({ DATABASE_URL: configured.DATABASE_URL })).toThrow();
  expect(runtimeConfig(configured)).toMatchObject({ host: '127.0.0.1', port: 4310 });
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

it('fixes the public MCP URL in configuration instead of deriving it from untrusted request headers', () => {
  expect(canonicalPublicUrl('https://itervane.example/')).toBe('https://itervane.example');
  expect(runtimeConfig(configured).publicUrl).toBe('http://127.0.0.1:4310');
  for (const value of ['http://remote.example', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com?token=x']) {
    expect(() => canonicalPublicUrl(value)).toThrow();
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
