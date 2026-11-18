import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createApi } from '../../src/api.js';
import { bootstrapOwner } from '../../src/service/resources.js';
import { databaseFixture } from '../helpers/database.js';
import { identityFixture } from '../helpers/identity.js';

let database: Awaited<ReturnType<typeof databaseFixture>>;
let issuer: Awaited<ReturnType<typeof identityFixture>>;
let api: ReturnType<typeof createApi>;
let headers: { authorization: string };
beforeAll(async () => {
  database = await databaseFixture(); issuer = await identityFixture(); api = createApi(database.storage, issuer.config, { logger: false });
  await api.ready(); headers = { authorization: `Bearer ${await issuer.token()}` };
});
beforeEach(async () => { await database.reset(); await bootstrapOwner(database.storage, { issuer: issuer.config.issuer, subject: 'owner' }); });
afterAll(async () => { if (api) await api.close(); if (issuer) await issuer.close(); if (database) await database.close(); });

it('localizes errors while preserving code, authorization and a server-generated request ID', async () => {
  const en = await api.inject({ url: '/v1/me', headers: { 'accept-language': 'en' } });
  const zh = await api.inject({ url: '/v1/me', headers: { 'accept-language': 'zh-CN' } });
  expect(en.statusCode).toBe(401); expect(zh.statusCode).toBe(401);
  expect(en.json().error.code).toBe(zh.json().error.code);
  expect(en.json().error.messageKey).toBe('error.unauthenticated');
  expect(zh.json().error.message).toBe('请使用有效的访问令牌登录。');
  expect(zh.headers['content-language']).toBe('zh-CN');
});

it('persists task language independently of presentation headers and keeps legacy English request hashes', async () => {
  const project = (await api.inject({ method: 'POST', url: '/v1/projects', headers, payload: { name: 'demo', slug: 'demo' } })).json();
  const repo = (await api.inject({ method: 'POST', url: `/v1/projects/${project.id}/repositories`, headers, payload: { name: 'demo', url: 'https://example.invalid/demo.git' } })).json();
  const input = { projectId: project.id, source: { repositoryId: repo.id, commit: 'a'.repeat(40) }, idempotencyKey: randomUUID(), purpose: 'Fixed source', dataClass: 'synthetic' };
  const accepted = (await api.inject({ method: 'POST', url: '/v1/tasks', headers: { ...headers, 'accept-language': 'zh-CN' }, payload: input })).json();
  expect(accepted.task.locale).toBe('en');
  const stored = await database.admin.query('SELECT request_hash FROM itervane.tasks WHERE id=$1', [accepted.task.id]);
  expect(stored.rows[0].request_hash).toBe(createHash('sha256').update(JSON.stringify(input)).digest('hex'));
  const replay = await api.inject({ method: 'POST', url: '/v1/tasks', headers, payload: { ...input, locale: 'en' } });
  expect(replay.statusCode).toBe(200);
  const localized = (await api.inject({ method: 'POST', url: '/v1/tasks', headers, payload: { ...input, idempotencyKey: randomUUID(), locale: 'zh-CN' } })).json();
  expect(localized.task.locale).toBe('zh-CN');
  const events = (await api.inject({ url: `/v1/tasks/${accepted.task.id}/events`, headers: { ...headers, 'accept-language': 'zh-CN' } })).json();
  expect(events.items[0]).toMatchObject({ type: 'task.accepted', message: '任务已接收并排队。', locale: 'zh-CN' });
  expect((await api.inject({ url: `/v1/tasks/${localized.task.id}`, headers })).json().locale).toBe('zh-CN');
});
