import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApi } from '../../../control-plane/src/api.js';
import { DurableWorker } from '../../../control-plane/src/runtime/worker.js';
import { bootstrapOwner } from '../../../control-plane/src/service/resources.js';
import { databaseFixture } from '../../../control-plane/test/helpers/database.js';
import { temporaryPostgres } from '../../../verification/src/postgres-fixture.js';

const execute = promisify(execFile);
async function availablePort() {
  const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test port');
  const port = address.port; await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); return port;
}
export async function browserStack() {
  const nonce = randomUUID(); const name = `itervane-test-idp-${nonce}`;
  const realm = `itervane-${nonce}`; const ownerId = randomUUID(); const viewerId = randomUUID();
  const password = randomUUID(); const clientId = 'itervane-portal'; const port = await availablePort(); const origin = `http://127.0.0.1:${port}`;
  const directory = resolve('.reports/p1-c/runtime', nonce); const realmFile = resolve(directory, 'realm.json');
  let postgres: Awaited<ReturnType<typeof temporaryPostgres>> | undefined;
  let database: Awaited<ReturnType<typeof databaseFixture>> | undefined;
  let api: ReturnType<typeof createApi> | undefined; let worker: DurableWorker | undefined; let timer: NodeJS.Timeout | undefined;
  let attempted = false; let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    if (timer) clearInterval(timer);
    try { await worker?.close(); await api?.close(); await database?.close(); }
    finally {
      try {
        if (attempted) {
          const label = await execute('docker', ['inspect', '--format', '{{index .Config.Labels "io.itervane.test"}}', name], { timeout: 10_000 }).catch(() => undefined);
          if (label?.stdout.trim() === nonce) await execute('docker', ['rm', '--force', name], { timeout: 15_000 });
        }
      } finally {
        await postgres?.close();
        await rm(realmFile, { force: true });
      }
    }
  })();
  try {
    postgres = await temporaryPostgres();
    const priorDatabaseUrl = process.env.DATABASE_URL; process.env.DATABASE_URL = postgres.url;
    try { database = await databaseFixture(); }
    finally { if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDatabaseUrl; }
    // The host-only directory stays private; the mounted file must be readable by Keycloak's non-root UID.
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const audience = (value: string) => ({ name: `audience-${value}`, protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper',
      config: { 'included.custom.audience': value, 'access.token.claim': 'true', 'id.token.claim': 'false' } });
    await writeFile(realmFile, JSON.stringify({ realm, enabled: true, sslRequired: 'none', internationalizationEnabled: true,
      supportedLocales: ['en', 'zh-CN'], defaultLocale: 'en', accessTokenLifespan: 20,
      clientScopes: [
        { id: randomUUID(), name: 'basic', protocol: 'openid-connect', protocolMappers: [
          { name: 'subject', protocol: 'openid-connect', protocolMapper: 'oidc-sub-mapper', config: { 'access.token.claim': 'true' } },
        ] },
        { id: randomUUID(), name: 'itervane:read', protocol: 'openid-connect', attributes: { 'include.in.token.scope': 'true' } },
      ],
      clients: [
        { clientId, publicClient: true, standardFlowEnabled: true, directAccessGrantsEnabled: false,
          redirectUris: [`${origin}/auth/callback`], webOrigins: [origin], defaultClientScopes: ['basic'],
          attributes: { 'pkce.code.challenge.method': 'S256', 'post.logout.redirect.uris': `${origin}/auth/logout-callback` }, protocolMappers: [audience('itervane-api')] },
        // Only the test driver uses this client; the portal never accepts passwords.
        { clientId: 'itervane-mcp-test', publicClient: true, standardFlowEnabled: false, directAccessGrantsEnabled: true,
          defaultClientScopes: ['basic', 'itervane:read'], protocolMappers: [audience(`${origin}/mcp`)] },
      ], users: [
        { id: ownerId, username: 'owner' }, { id: viewerId, username: 'viewer' }, { id: randomUUID(), username: 'stranger' },
      ].map(user => ({ ...user, enabled: true, firstName: 'Test', lastName: user.username, email: `${user.username}@example.invalid`, emailVerified: true,
        credentials: [{ type: 'password', value: password, temporary: false }] })),
    }), { mode: 0o644 });
    const image = process.env.ITERVANE_KEYCLOAK_IMAGE ?? 'quay.io/keycloak/keycloak:26.8.2@sha256:c68e286cacd87b942ac1939a0a1481461109d6acd3a57dc496969a319a76bbf0';
    if (!/^[a-z0-9][a-z0-9./:@_-]+$/.test(image)) throw new Error('Invalid identity image');
    attempted = true;
    await execute('docker', ['run', '--detach', '--rm', '--name', name, '--label', `io.itervane.test=${nonce}`, '--memory', '1g',
      '--publish', '127.0.0.1::8080', '--mount', `type=bind,source=${realmFile},target=/opt/keycloak/data/import/itervane.json,readonly`,
      '--env', 'JAVA_OPTS_KC_HEAP=-Xms128m -Xmx512m', image, 'start-dev', '--import-realm', '--hostname-strict=false'], { timeout: 180_000 });
    await execute('docker', ['exec', name, '/bin/bash', '-c', 'test -r /opt/keycloak/data/import/itervane.json'], { timeout: 10_000 })
      .catch(() => { throw new Error('IDP_IMPORT_UNREADABLE'); });
    const mapping = await execute('docker', ['port', name, '8080/tcp'], { timeout: 10_000 });
    const idpPort = /^127\.0\.0\.1:(\d+)\s*$/.exec(mapping.stdout)?.[1]; if (!idpPort) throw new Error('Identity must bind to loopback');
    const issuer = `http://127.0.0.1:${idpPort}/realms/${realm}`;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try { if ((await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(1_000) })).ok) { ready = true; break; } } catch { /* Trusted local IdP startup. */ }
      await new Promise(done => setTimeout(done, 500));
    }
    if (!ready) {
      const state = await execute('docker', ['inspect', '--format', '{{.State.Running}} {{.State.OOMKilled}} {{.State.ExitCode}}', name], { timeout: 10_000 }).catch(() => undefined);
      const logs = await execute('docker', ['logs', '--tail', '120', name], { timeout: 10_000 }).catch(() => undefined);
      const output = `${logs?.stdout ?? ''}\n${logs?.stderr ?? ''}`;
      const code = /true true|false true/.test(state?.stdout ?? '') ? 'IDP_MEMORY_LIMIT' : /permission denied|accessdeniedexception/i.test(output) ? 'IDP_IMPORT_UNREADABLE'
        : /error.*import|failed.*import/i.test(output) ? 'IDP_IMPORT_FAILED' : 'IDP_READINESS_TIMEOUT';
      throw new Error(code);
    }
    await bootstrapOwner(database.storage, { issuer, subject: ownerId });
    await database.admin.query('INSERT INTO itervane.principals(id,issuer,subject) VALUES($1,$2,$3)', [randomUUID(), issuer, viewerId]);
    api = createApi(database.storage, { issuer, audience: 'itervane-api', publicUrl: origin, portalClientId: clientId }, { logger: false, portalRoot: resolve('packages/portal/dist') });
    await api.listen({ host: '127.0.0.1', port });
    worker = new DurableWorker(database.storage, database.runtimeUrl);
    timer = setInterval(() => { void worker?.tick().catch(() => {}); }, 200);
    return { origin, issuer, password, database, ownerId, viewerId, close,
      async mcpToken() {
        const response = await fetch(`${issuer}/protocol/openid-connect/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'password', client_id: 'itervane-mcp-test', username: 'owner', password, scope: 'openid itervane:read' }) });
        if (!response.ok) throw new Error('Test MCP token unavailable');
        const body = await response.json() as { access_token?: string };
        if (!body.access_token) throw new Error('Test MCP token missing'); return body.access_token;
      },
    };
  } catch (error) { await close(); throw error; }
}
