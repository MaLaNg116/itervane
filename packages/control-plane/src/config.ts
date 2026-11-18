import { z } from 'zod';
import { validateIdentityConfig } from './auth/identity.js';

const databaseUrl = z.string().min(1).refine(value => {
  try { return ['postgres:', 'postgresql:'].includes(new URL(value).protocol); } catch { return false; }
}, 'PostgreSQL URL required');

export function runtimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = z.object({
    databaseUrl, issuer: z.string().min(1), audience: z.string().min(1),
    host: z.string().min(1).max(253), port: z.coerce.number().int().min(1).max(65_535),
  }).parse({ databaseUrl: env.DATABASE_URL, issuer: env.ITERVANE_OIDC_ISSUER,
    audience: env.ITERVANE_OIDC_AUDIENCE, host: env.ITERVANE_API_HOST ?? '127.0.0.1', port: env.ITERVANE_API_PORT ?? 4310 });
  validateIdentityConfig(config);
  return config;
}

export function migrationConfig(env: NodeJS.ProcessEnv = process.env) {
  // 不回退到运行账号，防止把生产启动变成自动 DDL。
  return databaseUrl.parse(env.ITERVANE_MIGRATION_DATABASE_URL);
}
