import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createIdentityVerifier, assertVerifiedIdentity, validateIdentityConfig, type VerifiedIdentity } from '../../src/auth/identity.js';
import { identityFixture } from '../helpers/identity.js';

let fixture: Awaited<ReturnType<typeof identityFixture>>;
beforeAll(async () => { fixture = await identityFixture(); });
afterAll(async () => { if (fixture) await fixture.close(); });

it('verifies a signed access token through a real local JWKS endpoint', async () => {
  const identity = await createIdentityVerifier(fixture.config)(await fixture.token());
  expect(identity).toMatchObject({ issuer: fixture.config.issuer, subject: 'owner' });
  expect(() => assertVerifiedIdentity(identity)).not.toThrow();
  expect(fixture.requests).toBeGreaterThan(0);
  expect(() => assertVerifiedIdentity({ issuer: fixture.config.issuer, subject: 'owner' } as VerifiedIdentity)).toThrow();
});

it('rejects wrong audience, issuer, expiry, future issue time and ID/refresh tokens', async () => {
  const verify = createIdentityVerifier(fixture.config);
  const now = Math.floor(Date.now() / 1_000);
  for (const overrides of [{ aud: 'other-api' }, { iss: 'https://other.invalid' }, { exp: now - 60 },
    { iat: now + 120 }, { typ: 'ID' }, { typ: 'Refresh' }, { sub: '' }]) {
    await expect(verify(await fixture.token('owner', overrides))).rejects.toMatchObject({ code: 'unauthenticated' });
  }
});

it('rejects modified signatures and unsigned tokens without trusting embedded claims', async () => {
  const verify = createIdentityVerifier(fixture.config);
  const token = await fixture.token();
  const [header, payload, signature] = token.split('.');
  const changed = `${signature![0] === 'a' ? 'b' : 'a'}${signature!.slice(1)}`;
  await expect(verify(`${header}.${payload}.${changed}`)).rejects.toMatchObject({ code: 'unauthenticated' });
  const unsignedHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  await expect(verify(`${unsignedHeader}.${payload}.`)).rejects.toMatchObject({ code: 'unauthenticated' });
});

it('rejects plaintext remote issuers and embedded credentials', () => {
  for (const issuer of ['http://example.com/realm', 'https://user:password@example.com', 'https://example.com?secret=value']) {
    expect(() => validateIdentityConfig({ issuer, audience: 'api' })).toThrow();
  }
});

it('fails closed on a JWKS redirect without requesting its target', async () => {
  let followed = false;
  const server = createServer((request, response) => {
    if (request.url === '/target') { followed = true; response.writeHead(500).end(); }
    else response.writeHead(307, { Location: '/target' }).end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test address');
  try {
    const verify = createIdentityVerifier({ issuer: `http://127.0.0.1:${address.port}`, audience: fixture.config.audience });
    await expect(verify(await fixture.token('owner', { iss: `http://127.0.0.1:${address.port}` }))).rejects.toMatchObject({ code: 'unavailable' });
    expect(followed).toBe(false);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
