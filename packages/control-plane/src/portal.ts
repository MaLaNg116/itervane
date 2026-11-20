import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { IdentityConfig } from './auth/identity.js';
import { DomainError } from './service/errors.js';

/** Only trusted build output is served here, never task workspaces or user uploads. */
export function registerPortal(app: FastifyInstance, root: string | undefined, config: IdentityConfig) {
  if (!root) return false;
  let index: string;
  try { index = readFileSync(join(root, 'index.html'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  if (index.split('__ITERVANE_CSP_NONCE__').length !== 2) throw new Error('Invalid portal build');
  const assets = new Map<string, { bytes: Buffer; mime: string }>();
  for (const file of readdirSync(join(root, 'assets'), { withFileTypes: true })) {
    if (!file.isFile() || !/^[a-zA-Z0-9_-]+\.(js|css)$/.test(file.name)) continue;
    const path = join(root, 'assets', file.name);
    if (statSync(path).size > 2 * 1024 * 1024) throw new Error('Portal asset exceeds size limit');
    assets.set(file.name, { bytes: readFileSync(path), mime: file.name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' });
  }
  const identityOrigin = new URL(config.issuer).origin;
  for (const path of ['/', '/auth/callback', '/auth/logout-callback']) {
    app.get(path, { config: { public: true } }, async (_request, reply) => {
      const nonce = randomBytes(18).toString('base64');
      return reply.type('text/html; charset=utf-8').header('Referrer-Policy', 'no-referrer')
        .header('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self' ${identityOrigin}; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`)
        .send(index.replace('__ITERVANE_CSP_NONCE__', nonce));
    });
  }
  app.get('/assets/:name', { config: { public: true } }, async (request, reply) => {
    const { name } = request.params as { name: string }; const asset = assets.get(name);
    if (!asset) throw new DomainError('not_found');
    return reply.type(asset.mime).header('Cache-Control', 'public, max-age=31536000, immutable').send(asset.bytes);
  });
  app.get('/favicon.ico', { config: { public: true } }, async (_request, reply) => reply.code(204).send());
  return true;
}
