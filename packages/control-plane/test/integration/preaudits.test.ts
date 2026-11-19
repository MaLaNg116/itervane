import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createIdentityVerifier, type VerifiedIdentity } from '../../src/auth/identity.js';
import { bootstrapOwner, ResourceService } from '../../src/service/resources.js';
import { PreauditService, RuleService } from '../../src/service/preaudits.js';
import { databaseFixture } from '../helpers/database.js';
import { identityFixture } from '../helpers/identity.js';

let database: Awaited<ReturnType<typeof databaseFixture>>; let issuer: Awaited<ReturnType<typeof identityFixture>>;
let identity: VerifiedIdentity; let service: PreauditService; let rules: RuleService; let projectId: string;
beforeAll(async () => { database = await databaseFixture(); issuer = await identityFixture(); identity = await createIdentityVerifier(issuer.config)(await issuer.token()); });
beforeEach(async () => {
  await database.reset(); await bootstrapOwner(database.storage, { issuer: issuer.config.issuer, subject: 'owner' });
  projectId = (await new ResourceService(database.storage).createProject(identity, { name: 'Preaudit', slug: 'preaudit' })).id;
  service = new PreauditService(database.storage); rules = new RuleService(database.storage);
});
afterAll(async () => { await issuer?.close(); await database?.close(); });
async function input(text = 'eval(value);') { return { projectId, idempotencyKey: randomUUID(), catalogSha256: (await rules.list(identity, projectId, {}, 'en')).sha256,
  language: 'typescript', format: 'snippet', dataClass: 'synthetic', text }; }

it('commits only one metadata report for concurrent cross-entry retries, without storing source or consuming the workflow slot', async () => {
  const canary = 'unique-source-never-stored'; const request = await input(`eval(value); // ${canary}`);
  const results = await Promise.all([service.create(identity, request, 'http', 'en'), service.create(identity, request, 'mcp', 'zh-CN')]);
  expect(results.filter(result => !result.replayed)).toHaveLength(1);
  expect(results[0]!.report.id).toBe(results[1]!.report.id); expect(results[0]!.report.reportSha256).toBe(results[1]!.report.reportSha256);
  const rows = await database.admin.query('SELECT * FROM itervane.preaudits'); expect(rows.rowCount).toBe(1);
  expect(JSON.stringify(rows.rows)).not.toContain(canary); expect(rows.rows[0]?.document.evaluation.input).not.toHaveProperty('text');
  expect((await database.admin.query('SELECT * FROM itervane.tasks')).rowCount).toBe(0);
  expect((await database.admin.query('SELECT task_id FROM itervane.execution_slot')).rows[0]?.task_id).toBeNull();
});
it('keeps semantic identity across display language changes and supports persisted reads through a new service', async () => {
  const request = await input(); const first = await service.create(identity, request, 'http', 'en');
  const replay = await new PreauditService(database.storage).create(identity, request, 'mcp', 'zh-CN');
  expect(replay.replayed).toBe(true); expect(replay.report.id).toBe(first.report.id);
  expect(replay.report.observations[0]?.title).not.toBe(first.report.observations[0]?.title);
  expect(replay.report).toMatchObject({ submittedVia: 'http', locale: 'zh-CN', formalScan: false, releaseEligible: false });
  expect(await service.get(identity, first.report.id, 'en')).toEqual(first.report);
  expect((await service.list(identity, projectId, 100))[0]?.id).toBe(first.report.id);
});
it('rejects changed content, stale catalog and malformed diff without writing a false successful record', async () => {
  const request = await input(); await service.create(identity, request, 'http', 'en');
  await expect(service.create(identity, { ...request, text: 'eval(other);' }, 'http', 'en')).rejects.toMatchObject({ code: 'idempotency_conflict' });
  await expect(service.create(identity, { ...request, idempotencyKey: randomUUID(), catalogSha256: '0'.repeat(64) }, 'http', 'en')).rejects.toMatchObject({ code: 'conflict' });
  await expect(service.create(identity, { ...request, idempotencyKey: randomUUID(), format: 'unified_diff', text: 'invalid' }, 'http', 'en')).rejects.toMatchObject({ code: 'invalid_input' });
  expect((await database.admin.query('SELECT * FROM itervane.preaudits')).rowCount).toBe(1);
});
it('allows current project readers to query rules/reports but refuses writes and removes access after revocation', async () => {
  const report = (await service.create(identity, await input(), 'http', 'en')).report;
  const principalId = randomUUID(); await database.admin.query('INSERT INTO itervane.principals(id,issuer,subject) VALUES($1,$2,$3)', [principalId, issuer.config.issuer, 'viewer']);
  await database.admin.query("INSERT INTO itervane.project_members(project_id,principal_id,role) VALUES($1,$2,'viewer')", [projectId, principalId]);
  const viewer = await createIdentityVerifier(issuer.config)(await issuer.token('viewer'));
  expect((await rules.list(viewer, projectId, {}, 'zh-CN')).items).toHaveLength(5);
  expect((await service.get(viewer, report.id, 'en')).id).toBe(report.id);
  await expect(service.create(viewer, await input(), 'mcp', 'en')).rejects.toMatchObject({ code: 'forbidden' });
  const other = (await new ResourceService(database.storage).createProject(identity, { name: 'Other', slug: 'other' })).id;
  await expect(rules.list(viewer, other, {}, 'en')).rejects.toMatchObject({ code: 'not_found' });
  await database.admin.query('DELETE FROM itervane.project_members WHERE principal_id=$1', [principalId]);
  await expect(service.get(viewer, report.id, 'en')).rejects.toMatchObject({ code: 'not_found' });
  await expect(rules.list(viewer, projectId, {}, 'en')).rejects.toMatchObject({ code: 'not_found' });
});
it('keeps reports immutable and refuses missing JSON binding fields at the database boundary', async () => {
  const report = (await service.create(identity, await input(), 'http', 'en')).report;
  await expect(database.storage.pool.query('UPDATE itervane.preaudits SET document=document')).rejects.toMatchObject({ code: '23514' });
  await expect(database.storage.pool.query('DELETE FROM itervane.preaudits')).rejects.toMatchObject({ code: '23514' });
  await expect(database.admin.query('INSERT INTO itervane.preaudits(id,project_id,requested_by,request_key,request_hash,report_sha256,document) VALUES($1,$2,$3,$4,$5,$5,$6)',
    [randomUUID(), projectId, report.requestedBy, randomUUID(), 'a'.repeat(64), {}])).rejects.toMatchObject({ code: '23514' });
});
it('rolls back a rejected database write instead of returning or publishing a completed report', async () => {
  await database.admin.query("CREATE FUNCTION itervane.test_reject_preaudit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='injected'; END; $$");
  await database.admin.query('CREATE TRIGGER test_reject_preaudit BEFORE INSERT ON itervane.preaudits FOR EACH ROW EXECUTE FUNCTION itervane.test_reject_preaudit()');
  try {
    await expect(service.create(identity, await input(), 'http', 'en')).rejects.toBeDefined();
    expect((await database.admin.query('SELECT * FROM itervane.preaudits')).rowCount).toBe(0);
  } finally {
    await database.admin.query('DROP TRIGGER test_reject_preaudit ON itervane.preaudits'); await database.admin.query('DROP FUNCTION itervane.test_reject_preaudit()');
  }
});
