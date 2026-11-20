import { expect, it } from 'vitest';
import { migrationConfig, runtimeConfig } from '../../src/config.js';

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
