import { createServer } from 'node:http';
import { once } from 'node:events';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';

export async function identityFixture() {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const key = { ...await exportJWK(publicKey), kid: 'local-test-key', alg: 'RS256', use: 'sig' };
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.url !== '/realms/test/protocol/openid-connect/certs') { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ keys: [key] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test identity address');
  const config = { issuer: `http://127.0.0.1:${address.port}/realms/test`, audience: 'itervane-api' };
  return {
    config, get requests() { return requests; },
    async token(subject = 'owner', overrides: JWTPayload = {}) {
      const now = Math.floor(Date.now() / 1_000);
      return new SignJWT({ typ: 'Bearer', iss: config.issuer, aud: config.audience, sub: subject, iat: now, exp: now + 300, ...overrides })
        .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'JWT' }).sign(privateKey);
    },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
