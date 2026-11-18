import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { portalConfigSchema, projectAccessDtoSchema } from '@itervane/contracts';
import { createApi } from '../../src/api.js';
import { bootstrapOwner } from '../../src/service/resources.js';
import { databaseFixture } from '../helpers/database.js';
import { identityFixture } from '../helpers/identity.js';

let database: Awaited<ReturnType<typeof databaseFixture>>;
let issuer: Awaited<ReturnType<typeof identityFixture>>;
let api: ReturnType<typeof createApi>;
let headers: { authorization: string };
beforeAll(async () => { database = await databaseFixture(); issuer = await identityFixture(); });
beforeEach(async () => {
  await database.reset(); await bootstrapOwner(database.storage, { issuer: issuer.config.issuer, subject: 'owner' });
  headers = { authorization: `Bearer ${await issuer.token()}` };
  api = createApi(database.storage, { ...issuer.config, publicUrl: 'https://itervane.example', portalClientId: 'itervane-portal' }, { logger: false });
});
afterEach(async () => { await api?.close(); });
afterAll(async () => { await issuer?.close(); await database?.close(); });

it('only exposes public OIDC settings and never turns public configuration into domain access', async () => {
  const response = await api.inject('/portal-config');
  expect(response.statusCode).toBe(200);
  expect(portalConfigSchema.parse(response.json())).toEqual({ enabled: true, authority: issuer.config.issuer, clientId: 'itervane-portal',
    redirectUri: 'https://itervane.example/auth/callback', postLogoutRedirectUri: 'https://itervane.example/auth/logout-callback' });
  for (const secret of ['databaseUrl', 'secret', 'password', 'token']) expect(response.body).not.toContain(secret);
  expect((await api.inject('/v1/projects')).statusCode).toBe(401);
  const disabled = createApi(database.storage, issuer.config, { logger: false });
  try { expect((await disabled.inject('/portal-config')).json()).toEqual({ enabled: false }); }
  finally { await disabled.close(); }
});

it('reports current project access without accepting token roles or preserving revoked membership', async () => {
  const project = (await api.inject({ method: 'POST', url: '/v1/projects', headers, payload: { name: 'Portal project', slug: 'portal' } })).json();
  const path = `/v1/projects/${project.id}/access`;
  expect(projectAccessDtoSchema.parse((await api.inject({ url: path, headers })).json())).toEqual({ projectId: project.id, role: 'owner', canWrite: true });
  const id = randomUUID();
  await database.admin.query('INSERT INTO itervane.principals(id,issuer,subject) VALUES($1,$2,$3)', [id, issuer.config.issuer, 'viewer']);
  await database.admin.query("INSERT INTO itervane.project_members(project_id,principal_id,role) VALUES($1,$2,'viewer')", [project.id, id]);
  const viewer = { authorization: `Bearer ${await issuer.token('viewer', { realm_access: { roles: ['admin'] } })}` };
  expect((await api.inject({ url: path, headers: viewer })).json()).toEqual({ projectId: project.id, role: 'viewer', canWrite: false });
  await database.admin.query("UPDATE itervane.project_members SET role='maintainer' WHERE principal_id=$1", [id]);
  expect((await api.inject({ url: path, headers: viewer })).json()).toMatchObject({ role: 'maintainer', canWrite: true });
  await database.admin.query('DELETE FROM itervane.project_members WHERE principal_id=$1', [id]);
  expect((await api.inject({ url: path, headers: viewer })).statusCode).toBe(404);
});
