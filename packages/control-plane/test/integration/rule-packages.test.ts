import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { apiErrorSchema, rulePackageActivationResultSchema, rulePackageActivationViewSchema, rulePackageDetailSchema,
  rulePackageImportResultSchema, rulePackagePageSchema } from '@itervane/contracts';
import { createApi } from '../../src/api.js';
import { createIdentityVerifier } from '../../src/auth/identity.js';
import { RulePackageService } from '../../src/service/rule-packages.js';
import { bootstrapOwner, ResourceService } from '../../src/service/resources.js';
import { databaseFixture } from '../helpers/database.js';
import { identityFixture } from '../helpers/identity.js';

let database: Awaited<ReturnType<typeof databaseFixture>>;
let issuer: Awaited<ReturnType<typeof identityFixture>>;
let api: ReturnType<typeof createApi>;
let token: string;
let projectId: string;

beforeAll(async () => {
  database = await databaseFixture();
  issuer = await identityFixture();
  api = createApi(database.storage, { ...issuer.config, portalClientId }, { logger: false });
});
beforeEach(async () => {
  await database.reset();
  await bootstrapOwner(database.storage, { issuer: issuer.config.issuer, subject: 'owner' });
  token = await issuer.token();
  const identity = await createIdentityVerifier(issuer.config)(token);
  projectId = (await new ResourceService(database.storage).createProject(identity, { name: 'Design lab', slug: 'design-lab' })).id;
});
afterAll(async () => { await api?.close(); await issuer?.close(); await database?.close(); });

const library = '/v1/rule-packages';
const portalClientId = 'itervane-rules-test-portal';
function design(version = '1.0.0') {
  return {
    formatVersion: 1, kind: 'design_skill', packageKey: 'accessible-demo', version,
    scope: { kind: 'project', projectId },
    source: { name: 'Example design reference', license: 'Apache-2.0', url: 'https://example.invalid/design' },
    text: { en: { title: 'Accessible demo', description: 'Keyboard and form guidance.' },
      'zh-CN': { title: '无障碍演示', description: '键盘与表单指导。' } },
    skill: { path: 'SKILL.md', locale: 'en', content: '# Forms\r\nShow feedback after form submission.' },
    resources: [
      { kind: 'reference', path: 'references/Keyboard.md', locale: 'en', content: '# Keyboard\r\nKeep focus visible.' },
      { kind: 'design_data', path: 'assets/tokens.json', content: '{"focusWidth": 2}' },
    ],
  };
}

const post = (payload: object, locale: 'en' | 'zh-CN' = 'en', actor = token, url = library) => api.inject({
  method: 'POST', url, payload, headers: { authorization: `Bearer ${actor}`, 'accept-language': locale },
});
const get = (url: string, locale: 'en' | 'zh-CN' = 'en', actor = token) => api.inject({
  method: 'GET', url, headers: { authorization: `Bearer ${actor}`, 'accept-language': locale },
});
const statusCounts = async () => (await database.admin.query(`
  SELECT (SELECT count(*)::int FROM itervane.rule_packages) AS packages,
         (SELECT count(*)::int FROM itervane.rule_package_versions) AS versions,
         (SELECT count(*)::int FROM itervane.tasks) AS tasks
`)).rows[0];

it('canonically imports one draft under concurrent submissions and reads immutable bilingual history', async () => {
  const input = design();
  const equivalent = { ...input, scope: { kind: 'project', projectId: projectId.toUpperCase() }, resources: [...input.resources].reverse(),
    skill: { ...input.skill, content: input.skill.content.replace(/\r\n/g, '\n') } };
  const [first, second] = await Promise.all([post(input), post(equivalent, 'zh-CN')]);
  expect([first.statusCode, second.statusCode].sort()).toEqual([200, 201]);
  const one = rulePackageImportResultSchema.parse(first.json()).version;
  const two = rulePackageImportResultSchema.parse(second.json()).version;
  expect(one).toMatchObject({ reviewState: 'draft', text: input.text.en });
  expect(two).toMatchObject({ packageId: one.packageId, versionId: one.versionId, sha256: one.sha256, text: input.text['zh-CN'] });
  expect(one.reviewMessage).not.toBe(two.reviewMessage);
  expect(one.document.resources.map(item => item.path)).toEqual(['assets/tokens.json', 'references/Keyboard.md']);
  expect(one.document.skill.content).toBe(equivalent.skill.content);
  expect((await post({ ...input, skill: { ...input.skill, content: 'Different guidance.' } })).statusCode).toBe(409);

  const nextResponse = await post(design('1.1.0'));
  expect(nextResponse.statusCode).toBe(201);
  const next = rulePackageImportResultSchema.parse(nextResponse.json()).version;
  expect(next.packageId).toBe(one.packageId);
  expect(next.sha256).not.toBe(one.sha256);
  const firstPage = rulePackagePageSchema.parse((await get(`${library}?limit=1`)).json());
  expect(firstPage.items[0]).toMatchObject({ versionId: next.versionId, sha256: next.sha256 });
  expect(firstPage.items[0]).not.toHaveProperty('document');
  expect(firstPage.nextBefore).toBe(next.versionId);
  const lastPage = rulePackagePageSchema.parse((await get(`${library}?limit=1&before=${firstPage.nextBefore}`, 'zh-CN')).json());
  expect(lastPage.items[0]).toMatchObject({ versionId: one.versionId, text: input.text['zh-CN'] });
  expect(lastPage.nextBefore).toBeNull();

  const identity = await createIdentityVerifier(issuer.config)(await issuer.token());
  expect(await new RulePackageService(database.storage).get(identity, one.packageId, one.versionId, 'en')).toEqual(one);
  expect(rulePackageDetailSchema.parse((await get(`${library}/${one.packageId}/versions/${one.versionId}`)).json())).toEqual(one);
  expect((await get(`${library}/${randomUUID()}/versions/${one.versionId}`)).statusCode).toBe(404);
  expect(await statusCounts()).toEqual({ packages: 1, versions: 2, tasks: 0 });
});

it('rejects unbounded or ambiguous assets, release claims and unknown project scopes at import', async () => {
  const input = design();
  const [reference, asset] = input.resources;
  const cases = [
    { ...input, reviewState: 'published' },
    { ...input, resources: [{ ...reference, path: 'references/../Other.md' }] },
    { ...input, resources: [reference, { ...reference, path: 'references/keyboard.md' }] },
    { ...input, resources: [{ ...asset, content: 'not a JSON object' }] },
    { ...input, resources: [{ ...asset, path: 'assets/example.js' }] },
    { ...input, source: { ...input.source, url: 'https://example.invalid/design?ref=test' } },
    { ...input, skill: { ...input.skill, content: '测'.repeat(5_500) } },
  ];
  for (const invalid of cases) expect((await post(invalid)).statusCode).toBe(400);
  expect((await post({ ...input, scope: { kind: 'project', projectId: randomUUID() } })).statusCode).toBe(404);
  expect(await statusCounts()).toEqual({ packages: 0, versions: 0, tasks: 0 });
  const workspace = await post({ ...input, scope: { kind: 'workspace' } });
  expect(workspace.statusCode).toBe(201);
  const response = await get(`/v1/projects/${projectId}/rules`);
  expect(response.statusCode).toBe(200);
  expect(response.body).not.toContain(input.packageKey);
  expect((await database.admin.query('SELECT task_id FROM itervane.execution_slot')).rows[0]?.task_id).toBeNull();
});

it('keeps drafts owner-only and preserves the recorded grant after authorization changes', async () => {
  const first = rulePackageImportResultSchema.parse((await post(design())).json()).version;
  const detail = `${library}/${first.packageId}/versions/${first.versionId}`;
  const changed = await database.admin.query('SELECT principal_id, grant_id FROM itervane.workspace_members');
  const { grant_id: originalGrant, principal_id: owner } = changed.rows[0]!;
  const member = randomUUID();
  await database.admin.query('INSERT INTO itervane.principals(id,issuer,subject) VALUES($1,$2,$3)', [member, issuer.config.issuer, 'editor']);
  await database.admin.query("INSERT INTO itervane.project_members(project_id,principal_id,role) VALUES($1,$2,'maintainer')", [projectId, member]);
  const editor = await issuer.token('editor');
  expect((await get(library, 'en', editor)).statusCode).toBe(403);
  expect((await get(detail, 'en', editor)).statusCode).toBe(403);
  expect((await post(design('1.1.0'), 'en', editor)).statusCode).toBe(403);
  expect((await api.inject({ method: 'GET', url: library })).statusCode).toBe(401);

  const currentGrant = randomUUID();
  await database.admin.query('UPDATE itervane.workspace_members SET grant_id=$1 WHERE principal_id=$2', [currentGrant, owner]);
  expect((await post(design())).statusCode).toBe(200);
  expect((await post(design('1.1.0'))).statusCode).toBe(201);
  expect((await database.admin.query('SELECT version,grant_id FROM itervane.rule_package_versions ORDER BY version')).rows)
    .toEqual([{ version: '1.0.0', grant_id: originalGrant }, { version: '1.1.0', grant_id: currentGrant }]);
  await database.admin.query('DELETE FROM itervane.workspace_members WHERE principal_id=$1', [owner]);
  expect((await get(detail)).statusCode).toBe(403);
  expect((await post(design('1.2.0'))).statusCode).toBe(403);
  expect(await statusCounts()).toEqual({ packages: 1, versions: 2, tasks: 0 });
});

it('guards draft history and rolls back the package when PostgreSQL refuses its first version', async () => {
  const valid = rulePackageImportResultSchema.parse((await post(design())).json()).version;
  const runtime = database.storage.pool;
  await expect(runtime.query('UPDATE itervane.rule_package_versions SET document=document WHERE id=$1', [valid.versionId]))
    .rejects.toMatchObject({ code: '23514', message: 'rule_package_version_is_immutable' });
  await expect(runtime.query('DELETE FROM itervane.rule_package_versions WHERE id=$1', [valid.versionId]))
    .rejects.toMatchObject({ code: '23514', message: 'rule_package_version_is_immutable' });
  await expect(runtime.query(`
    INSERT INTO itervane.rule_package_versions
      (package_id, workspace_id, package_key, project_id, version, sha256, submitted_by, grant_id, document)
    SELECT package_id,workspace_id,package_key,project_id,'1.9.0',sha256,submitted_by,$2,
      jsonb_set(document, '{version}', '"1.9.0"')
    FROM itervane.rule_package_versions WHERE id=$1`, [valid.versionId, randomUUID()]))
    .rejects.toMatchObject({ code: '23514', message: 'rule_package_import_authority' });
  await database.admin.query(`ALTER TABLE itervane.rule_package_versions ADD CONSTRAINT rule_test_rollback
    CHECK (package_key <> 'reject-in-test')`);
  try {
    expect((await post({ ...design(), packageKey: 'reject-in-test' })).statusCode).toBe(500);
    expect(await statusCounts()).toEqual({ packages: 1, versions: 1, tasks: 0 });
  } finally { await database.admin.query('ALTER TABLE itervane.rule_package_versions DROP CONSTRAINT rule_test_rollback'); }
});

type Draft = ReturnType<typeof rulePackageDetailSchema.parse>;
const draftPath = (draft: Draft) => `${library}/${draft.packageId}/versions/${draft.versionId}`;
const activationPath = (draft: Draft) => `${library}/${draft.packageId}/activation`;
const checks = { sourceAndLicense: true, scopeAndGuidance: true, designResources: true };
const humanToken = () => issuer.token('owner', { azp: portalClientId });
const reviewInput = (draft: Draft) => ({ versionSha256: draft.sha256, checks });
const addDraft = async (version?: string, packageKey?: string) => rulePackageImportResultSchema.parse(
  (await post({ ...design(version), ...(packageKey ? { packageKey } : {}) })).json()).version;
async function acceptDraft(draft: Draft, human: string) {
  const result = await post(reviewInput(draft), 'en', human, `${draftPath(draft)}/review`);
  expect(result.statusCode).toBe(201);
  const reviewed = rulePackageImportResultSchema.parse(result.json()).version;
  expect(reviewed.review?.outcome).toBe('accepted');
  return reviewed;
}
const publishInput = (draft: Draft, expectedSequence: number) => ({
  action: 'publish', versionId: draft.versionId, versionSha256: draft.sha256,
  reviewSha256: draft.review!.sha256, expectedSequence, idempotencyKey: randomUUID(),
});

it('records a localized review once from the authorized portal and keeps old grants as history', async () => {
  const draft = await addDraft();
  const path = `${draftPath(draft)}/review`;
  const human = await humanToken();
  const input = reviewInput(draft);
  expect((await post(input, 'en', token, path)).statusCode).toBe(403);
  expect((await post({ ...input, versionSha256: '0'.repeat(64) }, 'en', human, path)).statusCode).toBe(409);
  const submitted = await Promise.all([post(input, 'en', human, path),
    post(input, 'zh-CN', human, path.replace(draft.versionId, draft.versionId.toUpperCase()))]);
  expect(submitted.map(response => response.statusCode).sort()).toEqual([200, 201]);
  const [en, zh] = submitted.map(response => rulePackageImportResultSchema.parse(response.json()).version);
  expect(en!.reviewState).toBe('accepted');
  expect(en!.review).toEqual(zh!.review);
  expect(en!.reviewMessage).not.toBe(zh!.reviewMessage);
  expect((await post({ ...input, note: 'Different review evidence' }, 'en', human, path)).statusCode).toBe(409);
  expect(rulePackagePageSchema.parse((await get(library)).json()).items[0]?.reviewState).toBe('accepted');
  expect(en!.review?.versionSha256).toBe(draft.sha256);
  expect((await database.admin.query('SELECT count(*)::int AS n FROM itervane.rule_package_reviews')).rows[0]?.n).toBe(1);

  const former = en!.review!;
  await database.admin.query('UPDATE itervane.workspace_members SET grant_id=$1', [randomUUID()]);
  expect(rulePackageDetailSchema.parse((await get(draftPath(draft))).json())).toMatchObject({ reviewState: 'draft', review: null });
  const renew = await acceptDraft(draft, human);
  expect(renew.review?.id).not.toBe(former.id);
  expect((await database.admin.query('SELECT sha256 FROM itervane.rule_package_reviews WHERE id=$1', [former.id])).rows[0]?.sha256).toBe(former.sha256);
  await expect(database.storage.pool.query('UPDATE itervane.rule_package_reviews SET document=document WHERE id=$1', [former.id]))
    .rejects.toMatchObject({ code: '23514', message: 'rule_package_review_is_immutable' });
}, 45_000);

it('keeps rejected or out-of-date proof from becoming active', async () => {
  const draft = await addDraft();
  const human = await humanToken();
  const path = `${draftPath(draft)}/review`;
  const incomplete = { ...reviewInput(draft), checks: { ...checks, designResources: false } };
  expect((await post(incomplete, 'en', human, path)).statusCode).toBe(400);
  const rejected = rulePackageImportResultSchema.parse((await post({ ...incomplete, note: 'Describe the token scale.' }, 'en', human, path)).json()).version;
  expect(rejected).toMatchObject({ reviewState: 'changes_requested', review: { checks: { designResources: false } } });
  const result = await post(publishInput(rejected, 0), 'en', human, activationPath(rejected));
  expect(apiErrorSchema.parse(result.json()).error.code).toBe('unsupported_state');
  const accepted = await acceptDraft(await addDraft('1.1.0'), human);
  const publish = publishInput(accepted, 0);
  expect((await post(publish, 'en', token, activationPath(accepted))).statusCode).toBe(403);
  expect(apiErrorSchema.parse((await post({ ...publish, reviewSha256: 'a'.repeat(64) }, 'en', human, activationPath(accepted))).json()).error.code)
    .toBe('version_conflict');
  await database.admin.query('UPDATE itervane.workspace_members SET grant_id=$1', [randomUUID()]);
  expect(apiErrorSchema.parse((await post(publish, 'en', human, activationPath(accepted))).json()).error.code).toBe('unsupported_state');
  expect(rulePackageActivationViewSchema.parse((await get(activationPath(draft))).json())).toMatchObject({ sequence: 0, current: null, history: [] });
}, 45_000);

it('serializes publication, restores an earlier active version and retains evidence after withdrawal', async () => {
  const human = await humanToken();
  const v1 = await acceptDraft(await addDraft(), human);
  const v2 = await acceptDraft(await addDraft('1.1.0'), human);
  const neverPublished = await acceptDraft(await addDraft('1.2.0'), human);
  const path = activationPath(v1);
  const first = publishInput(v1, 0);
  const competing = await Promise.all([post(first, 'en', human, path), post(first, 'zh-CN', human, path)]);
  expect(competing.map(response => response.statusCode).sort()).toEqual([200, 201]);
  const [published, translated] = competing.map(response => rulePackageActivationResultSchema.parse(response.json()));
  expect(published!.state).toMatchObject({ sequence: 1, current: { versionId: v1.versionId, action: 'publish' } });
  expect(published!.operation.message).not.toBe(translated!.operation.message);
  const invalidRollback = { ...publishInput(neverPublished, 1), action: 'rollback' };
  expect(apiErrorSchema.parse((await post(invalidRollback, 'en', human, path)).json()).error.code).toBe('unsupported_state');
  const publishV2 = publishInput(v2, 1);
  const race = await Promise.all([post(publishV2, 'en', human, path), post({ ...publishV2, idempotencyKey: randomUUID() }, 'en', human, path)]);
  expect(race.map(response => response.statusCode).sort()).toEqual([201, 409]);
  const retryFirst = rulePackageActivationResultSchema.parse((await post(first, 'en', human, path)).json());
  expect(retryFirst).toMatchObject({ replayed: true, operation: { sequence: 1, versionId: v1.versionId },
    state: { sequence: 2, current: { versionId: v2.versionId } } });
  expect(apiErrorSchema.parse((await post({ ...first, expectedSequence: 2 }, 'en', human, path)).json()).error.code).toBe('idempotency_conflict');

  const rollback = { ...publishInput(v1, 2), action: 'rollback' };
  const restored = rulePackageActivationResultSchema.parse((await post(rollback, 'zh-CN', human, path)).json());
  expect(restored.state).toMatchObject({ sequence: 3, current: { action: 'rollback', versionId: v1.versionId, reviewSha256: v1.review?.sha256 } });
  const withdraw = { action: 'withdraw', expectedSequence: 3, idempotencyKey: randomUUID(), versionId: v1.versionId, versionSha256: v1.sha256 };
  const removed = rulePackageActivationResultSchema.parse((await post(withdraw, 'zh-CN', human, path)).json());
  expect(removed.state).toMatchObject({ sequence: 4, current: null, history: [
    { action: 'withdraw', versionId: v1.versionId }, { action: 'rollback', versionId: v1.versionId },
    { action: 'publish', versionId: v2.versionId }, { action: 'publish', versionId: v1.versionId },
  ] });
  expect(rulePackageActivationViewSchema.parse((await get(path, 'zh-CN')).json())).toEqual(removed.state);
  expect(rulePackageDetailSchema.parse((await get(draftPath(v2))).json()).review?.sha256).toBe(v2.review?.sha256);
  expect(await statusCounts()).toEqual({ packages: 1, versions: 3, tasks: 0 });
}, 45_000);

it('guards activation records and validates a version belongs to the selected package', async () => {
  const human = await humanToken();
  const first = await acceptDraft(await addDraft(), human);
  const other = await acceptDraft(await addDraft('1.0.0', 'other-design'), human);
  const path = activationPath(first);
  expect((await post(publishInput(other, 0), 'en', human, path)).statusCode).toBe(404);
  expect((await post(publishInput(first, 0), 'en', human, path)).statusCode).toBe(201);
  const runtime = database.storage.pool;
  await expect(runtime.query('DELETE FROM itervane.rule_package_activations WHERE package_id=$1', [first.packageId]))
    .rejects.toMatchObject({ code: '23514', message: 'rule_package_activation_is_immutable' });
  await expect(runtime.query(`
    INSERT INTO itervane.rule_package_activations(package_id, sequence, version_id, version_sha256, action, recorded_by, grant_id, request_key, request_sha256)
    SELECT package_id, 3, version_id, version_sha256, 'withdraw', recorded_by, grant_id, $2, request_sha256
    FROM itervane.rule_package_activations WHERE package_id=$1 AND sequence=1`, [first.packageId, randomUUID()]))
    .rejects.toMatchObject({ code: '23514', message: 'rule_package_activation_sequence' });
  expect(rulePackageActivationViewSchema.parse((await get(path)).json()).current?.versionId).toBe(first.versionId);
}, 45_000);
