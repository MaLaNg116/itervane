import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { z } from 'zod';
import { runtimeConfig, workerConfig } from './config.js';
import { openDatabase } from './persistence/database.js';
import { migrateDatabase } from './persistence/migrate.js';
import { bootstrapOwner } from './service/resources.js';

const host = '127.0.0.1';
const realm = 'itervane';
const audience = 'itervane-api';
const portal = 'itervane-portal';
const mcp = 'itervane-mcp';
const owner = 'itervane-owner';
const root = new URL('../ops/', import.meta.url);
const port = z.coerce.number().int().min(1024).max(65535);
const referencePorts = z.strictObject({ postgres: port, identity: port, api: port, mcpCallback: port })
  .refine(values => new Set(Object.values(values)).size === 4);
const manifestSchema = z.strictObject({ version: z.literal(1), project: z.string().regex(/^itervane-reference-[a-f0-9]{16}$/),
  ownerSubject: z.uuidv4(), ports: referencePorts });
type Manifest = z.infer<typeof manifestSchema>;
const origin = (port: number) => `http://${host}:${port}`;
const issuer = (ports: Manifest['ports']) => `${origin(ports.identity)}/realms/${realm}`;
const secret = () => randomBytes(24).toString('hex');
const envText = (values: Record<string, string | number>) => Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join('');
const readEnv = async (path: string) => parseEnv(await readFile(path, 'utf8'));

function publicClient(clientId: string, redirect: string, resource: string) {
  return {
    clientId, protocol: 'openid-connect', enabled: true, publicClient: true, standardFlowEnabled: true,
    directAccessGrantsEnabled: false, implicitFlowEnabled: false, serviceAccountsEnabled: false,
    redirectUris: [redirect], defaultClientScopes: ['basic'],
    attributes: { 'pkce.code.challenge.method': 'S256' },
    protocolMappers: [{ name: 'resource-audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper', config: {
      'included.custom.audience': resource, 'access.token.claim': 'true', 'id.token.claim': 'false',
    } }],
  };
}

function identityRealm(manifest: Manifest, password: string) {
  const api = origin(manifest.ports.api);
  const portalClient = publicClient(portal, `${api}/auth/callback`, audience);
  return {
    realm, enabled: true, sslRequired: 'none', internationalizationEnabled: true,
    supportedLocales: ['en', 'zh-CN'], defaultLocale: 'en', accessTokenLifespan: 300,
    clientScopes: [
      { name: 'basic', protocol: 'openid-connect', protocolMappers: [
        { name: 'subject', protocol: 'openid-connect', protocolMapper: 'oidc-sub-mapper', config: { 'access.token.claim': 'true' } },
      ] },
      ...['read', 'write'].map(scope => ({ name: `itervane:${scope}`, protocol: 'openid-connect', attributes: { 'include.in.token.scope': 'true' } })),
    ],
    clients: [
      { ...portalClient, webOrigins: [api], attributes: { ...portalClient.attributes,
        'post.logout.redirect.uris': `${api}/auth/logout-callback` } },
      { ...publicClient(mcp, `${origin(manifest.ports.mcpCallback)}/callback`, `${api}/mcp`),
        defaultClientScopes: ['basic', 'itervane:read'], optionalClientScopes: ['itervane:write'] },
    ],
    users: [{ id: manifest.ownerSubject, username: owner, enabled: true, firstName: 'Itervane', lastName: 'Owner',
      email: 'owner@example.invalid', emailVerified: true, requiredActions: ['UPDATE_PASSWORD'],
      credentials: [{ type: 'password', value: password, temporary: true }] }],
  };
}

export async function prepareReference(directory: string, ports: z.input<typeof referencePorts>) {
  const manifest = manifestSchema.parse({ version: 1, project: `itervane-reference-${randomBytes(8).toString('hex')}`,
    ownerSubject: randomUUID(), ports });
  const path = resolve(directory);
  const migrator = secret(), runtime = secret(), identity = secret(), login = secret();
  const connection = (role: string, credential: string) => `postgresql://${role}:${credential}@${host}:${manifest.ports.postgres}/itervane`;
  const databaseUrl = connection('itervane_app', runtime);
  const migrationUrl = connection('itervane_migrator', migrator);
  const postgresInit = `
CREATE ROLE itervane_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${migrator}';
CREATE ROLE itervane_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${runtime}';
CREATE ROLE itervane_idp LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${identity}';
ALTER DATABASE itervane OWNER TO itervane_migrator;
REVOKE CONNECT ON DATABASE itervane FROM PUBLIC;
GRANT CONNECT ON DATABASE itervane TO itervane_app;
CREATE DATABASE itervane_identity OWNER itervane_idp;
REVOKE CONNECT ON DATABASE itervane_identity FROM PUBLIC;
`;
  const env = {
    DATABASE_URL: databaseUrl, ITERVANE_OIDC_AUDIENCE: audience, ITERVANE_OIDC_ISSUER: issuer(manifest.ports),
    ITERVANE_PUBLIC_URL: origin(manifest.ports.api), ITERVANE_API_HOST: host, ITERVANE_API_PORT: manifest.ports.api, ITERVANE_PORTAL_CLIENT_ID: portal,
  };
  await mkdir(path, { mode: 0o700 });
  await writeFile(join(path, '.gitignore'), '*\n', { mode: 0o600 });
  await copyFile(new URL('reference/compose.yml', root), join(path, 'compose.yml'));
  // Files bind-mounted into trusted containers need to be readable by their service UIDs.
  await writeFile(join(path, 'postgres-password'), secret(), { mode: 0o644 });
  await writeFile(join(path, 'postgres-init.sql'), postgresInit, { mode: 0o644 });
  await writeFile(join(path, 'itervane-realm.json'), JSON.stringify(identityRealm(manifest, login)), { mode: 0o644 });
  await writeFile(join(path, '.env'), envText({ COMPOSE_PROJECT_NAME: manifest.project,
    ITERVANE_REFERENCE_PG_PORT: manifest.ports.postgres, ITERVANE_REFERENCE_IDP_PORT: manifest.ports.identity }), { mode: 0o600 });
  await writeFile(join(path, 'keycloak.env'), envText({ KC_HOSTNAME: origin(manifest.ports.identity), KC_DB_PASSWORD: identity,
    KC_BOOTSTRAP_ADMIN_USERNAME: 'itervane-admin', KC_BOOTSTRAP_ADMIN_PASSWORD: secret() }), { mode: 0o600 });
  await writeFile(join(path, 'migration.env'), envText({ ITERVANE_MIGRATION_DATABASE_URL: migrationUrl }), { mode: 0o600 });
  await writeFile(join(path, 'api.env'), envText(env), { mode: 0o600 });
  await writeFile(join(path, 'worker.env'), envText({ DATABASE_URL: databaseUrl }), { mode: 0o600 });
  await writeFile(join(path, 'owner-login.env'), envText({ ITERVANE_OWNER_USERNAME: owner, ITERVANE_OWNER_INITIAL_PASSWORD: login }), { mode: 0o600 });
  await writeFile(join(path, 'reference.json'), JSON.stringify(manifest) + '\n', { mode: 0o600 });
  return { status: 'prepared', project: manifest.project, portal: origin(manifest.ports.api), issuer: issuer(manifest.ports) };
}

function referenceDatabase(value: string | undefined, postgresPort: number, role: string) {
  const url = new URL(value ?? '');
  if (url.protocol !== 'postgresql:' || url.hostname !== host || Number(url.port) !== postgresPort || url.username !== role
    || url.pathname !== '/itervane' || !url.password || url.search || url.hash) throw new Error('reference_database_config');
  return url.toString();
}

async function readManifest(directory: string) {
  return manifestSchema.parse(JSON.parse(await readFile(join(directory, 'reference.json'), 'utf8')));
}

export async function referenceEnvironment(directory: string, role: 'api' | 'worker') {
  const { ports } = await readManifest(directory);
  const environment = await readEnv(join(directory, role + '.env'));
  referenceDatabase(environment.DATABASE_URL, ports.postgres, 'itervane_app');
  if (role === 'api') {
    const api = runtimeConfig(environment);
    if (api.host !== host || api.port !== ports.api || api.publicUrl !== origin(ports.api) || api.issuer !== issuer(ports)
        || api.audience !== audience || api.portalClientId !== portal) throw new Error('reference_identity_config');
  } else workerConfig(environment);
  return environment;
}

export async function initializeReference(directory: string) {
  const manifest = await readManifest(directory);
  const { ports } = manifest;
  const api = runtimeConfig(await referenceEnvironment(directory, 'api'));
  const migration = await readEnv(join(directory, 'migration.env'));
  const migrationUrl = referenceDatabase(migration.ITERVANE_MIGRATION_DATABASE_URL, ports.postgres, 'itervane_migrator');
  await migrateDatabase(migrationUrl).catch(() => { throw new Error('reference_migration_failed'); });
  const pool = new pg.Pool({ connectionString: migrationUrl, max: 1, connectionTimeoutMillis: 3_000 });
  try { await pool.query(await readFile(new URL('runtime-grants.sql', root), 'utf8')); }
  catch { throw new Error('reference_runtime_grants_failed'); }
  finally { await pool.end(); }

  const deadline = Date.now() + 90_000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    try {
      const response = await fetch(`${api.issuer}/.well-known/openid-configuration`, { redirect: 'error', signal: AbortSignal.timeout(1_500) });
      ready = response.ok && (await response.json() as { issuer?: string }).issuer === api.issuer;
      await response.body?.cancel().catch(() => {});
    } catch { /* The fixed local realm may still be starting. */ }
    if (!ready) await delay(500);
  }
  if (!ready) throw new Error('reference_identity_unavailable');
  const database = await openDatabase(api.databaseUrl);
  try { await bootstrapOwner(database, { issuer: api.issuer, subject: manifest.ownerSubject }); }
  finally { await database.close(); }
  return { status: 'initialized', portal: api.publicUrl, issuer: api.issuer, mcp: api.publicUrl + '/mcp',
    mcpClientId: mcp, mcpRedirectUri: origin(ports.mcpCallback) + '/callback' };
}
