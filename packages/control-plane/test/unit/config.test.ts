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
