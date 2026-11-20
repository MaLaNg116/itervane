import { createHash, randomUUID } from 'node:crypto';
import type { FixtureReleaseManifest, ReleaseDecision } from '@itervane/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createIdentityVerifier, type VerifiedIdentity } from '../../src/auth/identity.js';
import { openDatabase, queueName } from '../../src/persistence/database.js';
import { releaseCandidates, releaseDecisions, repositories, taskRuns, tasks } from '../../src/persistence/schema.js';
import { ReleaseCandidateService, type FixtureReleaseEvidence } from '../../src/service/releases.js';
import { bootstrapOwner, ResourceService } from '../../src/service/resources.js';
import { databaseFixture } from '../helpers/database.js';
import { identityFixture } from '../helpers/identity.js';

const humanClientId = 'itervane-portal';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
let database: Awaited<ReturnType<typeof databaseFixture>>;
let issuer: Awaited<ReturnType<typeof identityFixture>>;
let verify: ReturnType<typeof createIdentityVerifier>;
let owner: VerifiedIdentity;
let ownerId: string;
let workspaceId: string;
let resources: ResourceService;
let service: ReleaseCandidateService;
let manifest: FixtureReleaseManifest;

const evidence: FixtureReleaseEvidence = {
  async readCurrent(tx, scope) {
    const { rows } = await tx.execute<{ document: unknown }>(sql`
      SELECT document FROM itervane.test_release_inputs WHERE task_id = ${scope.taskId} FOR SHARE
    `);
    return rows[0]?.document;
  },
};

async function saveEvidence(document: unknown = manifest) {
  await database.admin.query(
    'INSERT INTO itervane.test_release_inputs(task_id, document) VALUES($1, $2) ON CONFLICT(task_id) DO UPDATE SET document = EXCLUDED.document',
    [manifest.taskId, JSON.stringify(document)],
  );
}
async function identity(subject: string, clientId = humanClientId) {
  return verify(await issuer.token(subject, { azp: clientId }));
}
async function registerMember(subject: string, role?: 'viewer' | 'maintainer') {
  const id = randomUUID();
  await database.admin.query('INSERT INTO itervane.principals(id, issuer, subject) VALUES ($1,$2,$3)', [id, issuer.config.issuer, subject]);
  if (role) await database.admin.query('INSERT INTO itervane.project_members(project_id, principal_id, role) VALUES ($1,$2,$3)', [manifest.projectId, id, role]);
  return { id, identity: await identity(subject) };
}
async function target(projectId: string) {
  const app = await resources.createApplication(owner, projectId, { name: 'Fixture delivery' });
  const environment = await resources.createEnvironment(owner, projectId, { applicationId: app.id, name: 'Fixture review' });
  return { applicationId: app.id, environmentId: environment.id, mappingSha256: hash(environment.id) };
}
function decision(fingerprint: string, action: ReleaseDecision = 'confirm', expectedVersion = 0) {
  return { action, fingerprint, expectedVersion, idempotencyKey: randomUUID() };
}
async function countDecisions() {
  return (await database.admin.query('SELECT count(*)::int AS count FROM itervane.release_decisions')).rows[0]?.count;
}

beforeAll(async () => {
  database = await databaseFixture();
  issuer = await identityFixture();
  verify = createIdentityVerifier(issuer.config);
  owner = await identity('owner');
  const runtimeRole = new URL(database.runtimeUrl).username;
  if (!/^itervane_runtime_[a-f0-9]{12}$/.test(runtimeRole)) throw new Error('Expected a dedicated release test role');
  await database.admin.query('CREATE TABLE itervane.test_release_inputs (task_id uuid PRIMARY KEY, document jsonb NOT NULL)');
  await database.admin.query(`GRANT SELECT, UPDATE ON itervane.test_release_inputs TO "${runtimeRole}"`);
});
beforeEach(async () => {
  await database.reset();
  await database.admin.query('TRUNCATE itervane.test_release_inputs');
  ({ principalId: ownerId, workspaceId } = await bootstrapOwner(database.storage, { issuer: issuer.config.issuer, subject: 'owner' }));
  resources = new ResourceService(database.storage);
  service = new ReleaseCandidateService(database.storage, evidence, humanClientId);
  const project = await resources.createProject(owner, { name: 'Fixture releases', slug: 'fixture-releases' });
  const repositoryId = randomUUID();
  const source = { repositoryId, commit: 'a'.repeat(40) };
  const taskId = randomUUID();
  const runId = randomUUID();
  await database.storage.db.insert(repositories).values({
    id: repositoryId, projectId: project.id, name: 'Fixture', url: 'https://example.invalid/fixture.git',
  });
  await database.storage.db.insert(tasks).values({
    id: taskId, projectId: project.id, repositoryId, requestedBy: ownerId, commit: source.commit, purpose: 'Review fixture',
    dataClass: 'synthetic', requestKey: randomUUID(), requestHash: hash(taskId), state: 'waiting_approval',
  });
  await database.storage.db.insert(taskRuns).values({ id: runId, taskId, generation: 1, role: 'verify', state: 'waiting_approval' });
  manifest = {
    version: 1, origin: 'trusted_fixture', releaseEligible: false, evidenceVersion: 1,
    taskId, runId, generation: 1, projectId: project.id, source,
    originalSnapshotSha256: hash('original'), repairedSnapshotSha256: hash('repaired'), diffSha256: hash('diff'),
    templateSetSha256: hash('templates'), ruleSetSha256: hash('rules'), verificationProfileSha256: hash('verification-profile'),
    checks: { rescanSha256: hash('rescan'), baselineSha256: hash('baseline'), targetedSha256: hash('targeted'), imageScanSha256: hash('image-scan') },
    imageDigest: `sha256:${hash('fixture-image')}`, runtimeConfigSha256: hash('runtime-config'), target: await target(project.id),
    rolloutCheckSha256: hash('rollout-check'), recoveryPlanSha256: hash('recovery'), validUntil: new Date(Date.now() + 180_000).toISOString(),
  };
  await saveEvidence();
});
afterAll(async () => { await issuer?.close(); await database?.close(); });

it('freezes once, records self-confirmation, and reads the same immutable history after a new connection', async () => {
  const first = await service.freeze(manifest.taskId);
  const reread = await service.freeze(manifest.taskId);
  expect(reread).toEqual({ ...first, replayed: true });
  const before = await service.get(owner, first.id, 'zh-CN');
  expect(before).toMatchObject({ status: 'pending', manifest, decisions: [], decisionVersion: 0, releaseEligible: false });
  expect(before.message).toBe('此样例候选等待人工决定。');
  const request = decision(first.fingerprint);
  const result = await service.decide(owner, first.id, request);
  expect(result.candidate).toMatchObject({
    status: 'confirmed', origin: 'trusted_fixture', releaseEligible: false, decisionVersion: 1,
    decisions: [{ actorId: ownerId, action: 'confirm', selfConfirmed: true, version: 1 }],
  });
  const reopened = await openDatabase(database.runtimeUrl);
  try {
    const replay = await new ReleaseCandidateService(reopened, evidence, humanClientId).decide(owner, first.id, request, 'zh-CN');
    expect(replay).toMatchObject({ replayed: true, candidate: { id: first.id, message: '所有者已确认此样例候选。' } });
    expect(replay.candidate.decisions).toEqual(result.candidate.decisions);
  } finally { await reopened.close(); }
  expect(await countDecisions()).toBe(1);
  expect((await database.storage.db.select().from(tasks).where(eq(tasks.id, manifest.taskId)))[0]?.state).toBe('waiting_approval');
  expect(await database.storage.boss.findJobs(queueName)).toEqual([]);
});

it('rejects missing or ineligible proof, a foreign target, and a non-fixture task', async () => {
  const other = await resources.createProject(owner, { name: 'Other', slug: 'other' });
  const { imageScanSha256: _unused, ...incompleteChecks } = manifest.checks;
  for (const body of [
    { ...manifest, generation: 2 }, { ...manifest, runId: randomUUID() },
    { ...manifest, origin: 'verified_runner' }, { ...manifest, releaseEligible: true }, { ...manifest, checks: incompleteChecks },
  ]) {
    await saveEvidence(body);
    await expect(service.freeze(manifest.taskId)).rejects.toMatchObject({ code: 'unsupported_state' });
  }
  await saveEvidence({ ...manifest, target: await target(other.id) });
  await expect(service.freeze(manifest.taskId)).rejects.toMatchObject({ code: 'not_found' });
  await saveEvidence();
  await database.storage.db.update(tasks).set({ dataClass: 'public' }).where(eq(tasks.id, manifest.taskId));
  await expect(service.freeze(manifest.taskId)).rejects.toMatchObject({ code: 'unsupported_state' });
  expect(await database.storage.db.select().from(releaseCandidates)).toHaveLength(0);
});

it('allows current project readers, reserves decisions for the verified human owner, and denies cross-project reads', async () => {
  const frozen = await service.freeze(manifest.taskId);
  const request = decision(frozen.fingerprint);
  const viewer = await registerMember('viewer', 'viewer');
  const maintainer = await registerMember('maintainer', 'maintainer');
  const outside = await registerMember('outsider');
  const external = await identity('owner', 'external-mcp');
  for (const reader of [viewer, maintainer]) {
    expect(await service.get(reader.identity, frozen.id)).toMatchObject({ id: frozen.id, status: 'pending' });
    await expect(service.decide(reader.identity, frozen.id, request)).rejects.toMatchObject({ code: 'forbidden' });
  }
  await expect(service.get(outside.identity, frozen.id)).rejects.toMatchObject({ code: 'not_found' });
  await expect(service.decide(outside.identity, frozen.id, request)).rejects.toMatchObject({ code: 'not_found' });
  await expect(service.decide(external, frozen.id, request)).rejects.toMatchObject({ code: 'forbidden' });
  const { issuer: issuingAuthority, subject, scopes, expiresAt, clientId } = owner;
  const forged = { issuer: issuingAuthority, subject, scopes, expiresAt, clientId } as VerifiedIdentity;
  await expect(service.decide(forged, frozen.id, request)).rejects.toMatchObject({ code: 'unauthenticated' });
  await expect(service.decide(owner, frozen.id, { ...request, actorId: ownerId })).rejects.toMatchObject({ code: 'invalid_input' });
  await database.admin.query('DELETE FROM itervane.project_members WHERE project_id=$1 AND principal_id=$2', [manifest.projectId, viewer.id]);
  await expect(service.get(viewer.identity, frozen.id)).rejects.toMatchObject({ code: 'not_found' });
  expect(await countDecisions()).toBe(0);
});

it('records a single decision for concurrent retries and resolves competing confirm or reject by version', async () => {
  const [a, b] = await Promise.all([service.freeze(manifest.taskId), service.freeze(manifest.taskId)]);
  expect(a.id).toBe(b.id);
  expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
  const request = decision(a.fingerprint);
  const retries = await Promise.all([service.decide(owner, a.id, request), service.decide(owner, a.id, request)]);
  expect(retries.map(item => item.replayed).sort()).toEqual([false, true]);
  await expect(service.decide(owner, a.id, { ...request, action: 'reject' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  await expect(service.decide(owner, a.id, decision(a.fingerprint, 'reject'))).rejects.toMatchObject({ code: 'version_conflict' });
  await saveEvidence({ ...manifest, evidenceVersion: 2 });
  const rival = await service.freeze(manifest.taskId);
  const race = await Promise.allSettled([
    service.decide(owner, rival.id, decision(rival.fingerprint)),
    service.decide(owner, rival.id, decision(rival.fingerprint, 'reject')),
  ]);
  expect(race.filter(item => item.status === 'fulfilled')).toHaveLength(1);
  expect(race.find(item => item.status === 'rejected')).toMatchObject({ reason: { code: 'version_conflict' } });
  expect(await countDecisions()).toBe(2);
});

it('requires the exact fingerprint and invalidates current decisions on changed evidence, supersession and cancellation', async () => {
  const frozen = await service.freeze(manifest.taskId);
  const request = decision(frozen.fingerprint);
  await expect(service.decide(owner, frozen.id, { ...request, fingerprint: hash('other') })).rejects.toMatchObject({ code: 'version_conflict' });
  await service.decide(owner, frozen.id, request);
  await saveEvidence({ ...manifest, imageDigest: `sha256:${hash('changed image')}` });
  expect((await service.get(owner, frozen.id)).status).toBe('evidence_changed');
  await expect(service.freeze(manifest.taskId)).rejects.toMatchObject({ code: 'version_conflict' });
  const changed = { ...manifest, evidenceVersion: 2, runtimeConfigSha256: hash('new config'), ruleSetSha256: hash('new rules'),
    target: { ...manifest.target, mappingSha256: hash('new target') } };
  await saveEvidence(changed);
  expect((await service.decide(owner, frozen.id, request)).candidate.status).toBe('evidence_changed');
  const fresh = await service.freeze(manifest.taskId);
  expect(fresh.fingerprint).not.toBe(frozen.fingerprint);
  expect((await service.get(owner, frozen.id)).status).toBe('superseded');
  await saveEvidence();
  await expect(service.freeze(manifest.taskId)).rejects.toMatchObject({ code: 'version_conflict' });
  expect((await service.get(owner, frozen.id)).status).toBe('superseded');
  await saveEvidence(changed);
  await database.storage.db.update(tasks).set({ state: 'cancelled' }).where(eq(tasks.id, manifest.taskId));
  expect((await service.get(owner, fresh.id)).status).toBe('task_changed');
  await expect(service.decide(owner, fresh.id, decision(fresh.fingerprint))).rejects.toMatchObject({ code: 'unsupported_state' });
});

it('keeps the authorization lost when the original owner is granted a new membership', async () => {
  const frozen = await service.freeze(manifest.taskId);
  const request = decision(frozen.fingerprint);
  const viewer = await registerMember('viewer', 'viewer');
  await service.decide(owner, frozen.id, request);
  await database.admin.query('DELETE FROM itervane.workspace_members WHERE workspace_id=$1', [workspaceId]);
  expect((await service.get(viewer.identity, frozen.id)).status).toBe('approver_revoked');
  await expect(service.decide(owner, frozen.id, request)).rejects.toMatchObject({ code: 'not_found' });
  await database.admin.query('INSERT INTO itervane.workspace_members(workspace_id, principal_id) VALUES ($1,$2)', [workspaceId, ownerId]);
  expect((await service.decide(owner, frozen.id, request)).candidate.status).toBe('approver_revoked');
  await expect(service.decide(owner, frozen.id, decision(frozen.fingerprint, 'confirm', 1))).rejects.toMatchObject({ code: 'unsupported_state' });
  expect(await countDecisions()).toBe(1);
});

it('uses current database time after a contended lock even when the freeze was valid before waiting', async () => {
  const { rows } = await database.admin.query<{ expires: Date }>("SELECT clock_timestamp() + interval '2 seconds' AS expires");
  const expires = rows[0]!.expires.toISOString();
  await saveEvidence({ ...manifest, validUntil: expires });
  const frozen = await service.freeze(manifest.taskId);
  const held = await database.admin.connect();
  try {
    await held.query('BEGIN');
    await held.query('SELECT id FROM itervane.tasks WHERE id=$1 FOR UPDATE', [manifest.taskId]);
    const attempt = service.decide(owner, frozen.id, decision(frozen.fingerprint)).then(() => 'unexpected success', error => error);
    await expect.poll(async () => (await held.query<{ blocked: boolean }>(`
      SELECT EXISTS (
        SELECT FROM pg_locks WHERE NOT granted AND pg_backend_pid() = ANY(pg_blocking_pids(pid))
      ) AS blocked
    `)).rows[0]?.blocked, { interval: 20, timeout: 1_000 }).toBe(true);
    await held.query("SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp()))) + 0.025)", [expires]);
    await held.query('COMMIT');
    expect(await attempt).toMatchObject({ code: 'unsupported_state' });
  } finally {
    await held.query('ROLLBACK');
    held.release();
  }
  expect(await service.get(owner, frozen.id)).toMatchObject({ status: 'expired', decisions: [] });
  expect(await service.freeze(manifest.taskId)).toMatchObject({ id: frozen.id, replayed: true });
});

it('appends a revocation and rejects attempts to overwrite the candidate or delete a decision', async () => {
  const frozen = await service.freeze(manifest.taskId);
  const initial = decision(frozen.fingerprint);
  await service.decide(owner, frozen.id, initial);
  const revoked = await service.decide(owner, frozen.id, decision(frozen.fingerprint, 'revoke', 1));
  expect(revoked.candidate).toMatchObject({ status: 'revoked', decisionVersion: 2, decisions: [
    { action: 'confirm', selfConfirmed: true }, { action: 'revoke', selfConfirmed: false },
  ] });
  expect((await service.decide(owner, frozen.id, initial)).candidate.status).toBe('revoked');
  await expect(database.storage.db.update(releaseCandidates).set({ fingerprint: hash('rewritten') }).where(eq(releaseCandidates.id, frozen.id)))
    .rejects.toMatchObject({ cause: { code: '23514' } });
  await expect(database.storage.db.delete(releaseDecisions).where(eq(releaseDecisions.candidateId, frozen.id)))
    .rejects.toMatchObject({ cause: { code: '23514' } });
  expect(await countDecisions()).toBe(2);
});

it('rolls back the confirmation when PostgreSQL fails the transaction at commit time', async () => {
  const frozen = await service.freeze(manifest.taskId);
  const request = decision(frozen.fingerprint);
  await database.admin.query(`
    CREATE FUNCTION itervane.test_reject_release_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'fixture commit failure';
    END;
    $$;
    CREATE CONSTRAINT TRIGGER test_reject_release_transaction AFTER INSERT ON itervane.release_decisions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION itervane.test_reject_release_transaction();
  `);
  try {
    await expect(service.decide(owner, frozen.id, request)).rejects.toThrow();
    expect(await service.get(owner, frozen.id)).toMatchObject({ status: 'pending', decisionVersion: 0, decisions: [] });
    expect(await countDecisions()).toBe(0);
  } finally {
    await database.admin.query(`
      DROP TRIGGER test_reject_release_transaction ON itervane.release_decisions;
      DROP FUNCTION itervane.test_reject_release_transaction();
    `);
  }
  expect(await service.decide(owner, frozen.id, request)).toMatchObject({ candidate: { status: 'confirmed' }, replayed: false });
});
