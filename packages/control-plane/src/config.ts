import { posix } from 'node:path';
import { z } from 'zod';
import { sha256Schema } from '@itervane/contracts';
import { validateIdentityConfig } from './auth/identity.js';

const databaseUrl = z.string().min(1).refine(value => {
  try { return ['postgres:', 'postgresql:'].includes(new URL(value).protocol); } catch { return false; }
}, 'PostgreSQL URL required');

export function canonicalPublicUrl(value: string): string {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password
    || url.search || url.hash || url.pathname !== '/' || url.href.length > 240) throw new Error('Invalid public URL');
  return url.origin;
}

export function runtimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = z.object({
    databaseUrl, issuer: z.string().min(1), audience: z.string().min(1),
    host: z.string().min(1).max(253), port: z.coerce.number().int().min(1).max(65_535),
  }).parse({ databaseUrl: env.DATABASE_URL, issuer: env.ITERVANE_OIDC_ISSUER,
    audience: env.ITERVANE_OIDC_AUDIENCE, host: env.ITERVANE_API_HOST ?? '127.0.0.1', port: env.ITERVANE_API_PORT ?? 4310 });
  validateIdentityConfig(config);
  const portalClientId = env.ITERVANE_PORTAL_CLIENT_ID ? z.string().trim().min(1).max(255).parse(env.ITERVANE_PORTAL_CLIENT_ID) : undefined;
  return { ...config, publicUrl: canonicalPublicUrl(env.ITERVANE_PUBLIC_URL ?? `http://127.0.0.1:${config.port}`),
    ...(portalClientId ? { portalClientId } : {}) };
}

export function workerConfig(env: NodeJS.ProcessEnv = process.env) {
  const worker = z.object({ databaseUrl, leaseSeconds: z.coerce.number().int().min(2).max(60), pollMs: z.coerce.number().int().min(100).max(10_000) })
    .parse({ databaseUrl: env.DATABASE_URL, leaseSeconds: env.ITERVANE_WORKER_LEASE_SECONDS ?? 10, pollMs: env.ITERVANE_WORKER_POLL_MS ?? 1_000 });
  const address = { socketPath: env.ITERVANE_RUNNER_SOCKET, controllerUid: env.ITERVANE_RUNNER_UID, imageSha256: env.ITERVANE_RUNNER_IMAGE_SHA256 };
  const runner = Object.values(address).some(value => value !== undefined) ? z.object({
    socketPath: z.string().refine(value => posix.isAbsolute(value) && value.endsWith('.sock') && Buffer.byteLength(value) <= 100),
    controllerUid: z.coerce.number().int().min(1).max(2147483647),
    imageSha256: sha256Schema,
  }).parse(address) : undefined;
  return { ...worker, runner };
}

export function migrationConfig(env: NodeJS.ProcessEnv = process.env) {
  // 不回退到运行账号，防止把生产启动变成自动 DDL。
  return databaseUrl.parse(env.ITERVANE_MIGRATION_DATABASE_URL);
}
