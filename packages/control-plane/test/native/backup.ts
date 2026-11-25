import { deepStrictEqual, equal, ok, rejects } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { rulePackageActivationResultSchema, rulePackageImportResultSchema } from '@itervane/contracts';
import { temporaryPostgres } from '../../../verification/src/postgres-fixture.js';
import { createApi } from '../../src/api.js';
import { createIdentityVerifier } from '../../src/auth/identity.js';
import { postgresBackupClient } from '../../src/persistence/backup-postgres.js';
import { exportBackup, restoreBackup } from '../../src/persistence/backup.js';
import { openDatabase } from '../../src/persistence/database.js';
import { migrateDatabase } from '../../src/persistence/migrate.js';
import { DurableWorker } from '../../src/runtime/worker.js';
import { bootstrapOwner, ResourceService } from '../../src/service/resources.js';
import { TaskRuleSnapshotService } from '../../src/service/task-rule-snapshots.js';
import { TaskService } from '../../src/service/tasks.js';
import { identityFixture } from '../helpers/identity.js';

type Fixture = Awaited<ReturnType<typeof temporaryPostgres>>;

function nativeClient(fixture: Fixture, database: string, role: string) {
  const { containerName } = fixture;
  if (!containerName) throw new Error('backup_probe_requires_fixture');
  return postgresBackupClient(database, (tool, args) => spawn('docker',
    ['exec', '--interactive', containerName, tool, ...args, '--host=/var/run/postgresql', `--username=${role}`],
    { stdio: ['pipe', 'pipe', 'ignore'] }));
}

async function runtimeRole(ownerUrl: string) {
  const url = new URL(ownerUrl);
  const password = randomUUID();
  const owner = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  try {
    await owner.query(`CREATE ROLE itervane_backup_probe_runtime LOGIN PASSWORD '${password}'`);
    await owner.query('GRANT USAGE ON SCHEMA itervane, itervane_checkpoint, itervane_queue TO itervane_backup_probe_runtime');
    await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA itervane, itervane_checkpoint, itervane_queue TO itervane_backup_probe_runtime');
    await owner.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA itervane, itervane_checkpoint, itervane_queue TO itervane_backup_probe_runtime');
  } finally { await owner.end(); }
  url.username = 'itervane_backup_probe_runtime';
  url.password = password;
  return url.toString();
}

async function seed(source: Fixture, issuer: Awaited<ReturnType<typeof identityFixture>>) {
  await migrateDatabase(source.url);
  const runtimeUrl = await runtimeRole(source.url);
  const storage = await openDatabase(runtimeUrl);
  const portalClientId = 'itervane-backup-probe';
  const api = createApi(storage, { ...issuer.config, portalClientId }, { logger: false });
  try {
    await bootstrapOwner(storage, { issuer: issuer.config.issuer, subject: 'owner' });
    const bearer = await issuer.token('owner', { azp: portalClientId });
    const identity = await createIdentityVerifier(issuer.config)(bearer);
    const resources = new ResourceService(storage);
    const project = await resources.createProject(identity, { name: 'Backup verification', slug: 'backup-verification' });
    const repository = await resources.registerRepository(identity, project.id, { name: 'Reference', url: 'https://example.invalid/backup.git' });
    const post = (url: string, payload: object) => api.inject({ url, method: 'POST', payload,
      headers: { authorization: `Bearer ${bearer}`, 'accept-language': 'en' } });
    const draft = await post('/v1/rule-packages', { formatVersion: 1, kind: 'design_skill', packageKey: 'portable-forms', version: '1.0.0',
      scope: { kind: 'project', projectId: project.id }, source: { name: 'Maintainer probe', license: 'Apache-2.0' },
      text: { en: { title: 'Forms', description: 'Show feedback beside the input.' }, 'zh-CN': { title: '表单', description: '在字段旁显示反馈。' } },
      skill: { path: 'SKILL.md', locale: 'en', content: 'Preserve the visible focus indicator.' } });
    equal(draft.statusCode, 201);
    const { packageId, versionId, sha256 } = rulePackageImportResultSchema.parse(draft.json()).version;
    const reviewed = await post(`/v1/rule-packages/${packageId}/versions/${versionId}/review`, { versionSha256: sha256,
      checks: { sourceAndLicense: true, scopeAndGuidance: true, designResources: true } });
    equal(reviewed.statusCode, 201);
    const { review } = rulePackageImportResultSchema.parse(reviewed.json()).version;
    ok(review);
    const activation = await post(`/v1/rule-packages/${packageId}/activation`, { action: 'publish', versionId, versionSha256: sha256,
      expectedSequence: 0, reviewSha256: review.sha256, idempotencyKey: randomUUID() });
    equal(activation.statusCode, 201);
    equal(rulePackageActivationResultSchema.parse(activation.json()).state.current?.sequence, 1);

    const tasks = new TaskService(storage);
    const input = { projectId: project.id, source: { repositoryId: repository.id, commit: 'b'.repeat(40) }, locale: 'en' as const,
      dataClass: 'synthetic' as const };
    const paused = await tasks.admit(identity, { ...input, idempotencyKey: randomUUID(), purpose: 'Keep a paused checkpoint' });
    const worker = new DurableWorker(storage, runtimeUrl);
    try { equal(await worker.tick(), true); } finally { await worker.close(); }
    const first = await tasks.get(identity, paused.task.id);
    equal(first.state, 'waiting_input');
    const queued = await tasks.admit(identity, { ...input, idempotencyKey: randomUUID(), purpose: 'Retain pending queue work' });
    equal(queued.task.state, 'queued');
    const events = await tasks.events(identity, first.id, 50, 'en');
    const snapshot = await new TaskRuleSnapshotService(storage).get(identity, first.id, 'en');
    equal(snapshot.snapshot?.document.entries[0]?.versionId, versionId);
    return { identity, first, queued: queued.task, events, snapshot };
  } finally { try { await api.close(); } finally { await storage.close(); } }
}

async function restoredAccess(targetUrl: string, seeded: Awaited<ReturnType<typeof seed>>) {
  const url = await runtimeRole(targetUrl);
  const storage = await openDatabase(url);
  try {
    const tasks = new TaskService(storage);
    deepStrictEqual(await tasks.get(seeded.identity, seeded.first.id), seeded.first);
    deepStrictEqual(await tasks.events(seeded.identity, seeded.first.id, 50, 'en'), seeded.events);
    deepStrictEqual(await new TaskRuleSnapshotService(storage).get(seeded.identity, seeded.first.id, 'en'), seeded.snapshot);
    equal((await tasks.get(seeded.identity, seeded.queued.id)).state, 'queued');
    const { rows: [checkpoint] } = await storage.pool.query(`
      SELECT runtime.checkpoint_id, (SELECT count(*)::int FROM itervane_checkpoint.checkpoints) AS count
      FROM itervane.run_runtime runtime WHERE runtime.run_id=$1
    `, [seeded.first.runId]);
    ok(checkpoint.checkpoint_id && checkpoint.count > 0);
    const { rows: [pending] } = await storage.pool.query(`
      SELECT count(*)::int AS count FROM itervane_queue.job WHERE name='workflow-v1' AND state='created'
    `);
    equal(pending.count, 1);
    const result = await tasks.cancel(seeded.identity, seeded.queued.id, { expectedVersion: seeded.queued.version });
    equal(result.state, 'cancelled');
  } finally { await storage.close(); }
}

async function verifyBackup(source: Fixture, target: Fixture, root: string) {
  const issuer = await identityFixture();
  let seeded: Awaited<ReturnType<typeof seed>>;
  try { seeded = await seed(source, issuer); } finally { await issuer.close(); }
  const backups = nativeClient(source, 'itervane_test', 'itervane_test');
  const restore = nativeClient(target, 'itervane_recovered', 'itervane_backup_probe_owner');
  const admin = new pg.Pool({ connectionString: target.url, max: 1 });
  try {
    await admin.query('CREATE ROLE itervane_backup_probe_owner LOGIN');
    await admin.query('CREATE DATABASE itervane_recovered OWNER itervane_backup_probe_owner TEMPLATE template0');
  } finally { await admin.end(); }
  const targetUrl = new URL(target.url);
  targetUrl.pathname = '/itervane_recovered';

  const storage = join(root, 'archives');
  const configuration = join(root, 'config');
  const bundle = join(root, 'backup');
  const recovered = join(root, 'recovered');
  const configPath = join('worker', 'installation.json');
  const config = JSON.stringify({ version: 1, runtime: 'verification', protectedIngress: true });
  await mkdir(storage);
  await mkdir(join(configuration, 'worker'), { recursive: true });
  await writeFile(join(configuration, configPath), config);
  const sourceConnection = new pg.Pool({ connectionString: source.url, max: 1 });
  try {
    await sourceConnection.query('SELECT 1');
    await rejects(exportBackup(backups, bundle, storage, configuration), /backup_database_in_use/);
  } finally { await sourceConnection.end(); }
  await delay(100);
  const exported = await exportBackup(backups, bundle, storage, configuration);
  ok(exported.tables > 40);
  equal(exported.configFiles, 1);

  const dump = join(bundle, 'database.dump');
  const bytes = await readFile(dump);
  await writeFile(dump, Buffer.from('broken PostgreSQL dump'));
  await rejects(restoreBackup(restore, bundle, join(root, 'corrupt')), /backup_file_integrity/);
  await restore.requireEmptyTarget();
  await writeFile(dump, bytes);
  const result = await restoreBackup(restore, bundle, recovered);
  equal(result.reconciled, false);
  deepStrictEqual(JSON.parse(await readFile(join(recovered, 'restore-receipt.json'), 'utf8')), result);
  equal(await readFile(join(recovered, 'configuration', configPath), 'utf8'), config);
  await rejects(lstat(join(recovered, 'database.dump')), { code: 'ENOENT' });
  await rejects(restoreBackup(restore, bundle, join(root, 'duplicate')), /restore_target_not_empty/);
  await restoredAccess(targetUrl.toString(), seeded);
  return { sourcePostgres: source.version, targetPostgres: target.version, ...result, dumpBytes: bytes.length,
    protectedAccess: true, checkpointAndQueueRetained: true, corruptDumpRejected: true, duplicateRestoreRejected: true };
}

const root = await mkdtemp(join(tmpdir(), 'itervane-backup-probe-'));
const clusters: Fixture[] = [];
try {
  const source = await temporaryPostgres({ isolated: true });
  clusters.push(source);
  const target = await temporaryPostgres({ isolated: true });
  clusters.push(target);
  console.log(JSON.stringify(await verifyBackup(source, target, root)));
} catch (error) {
  const reason = error instanceof Error && /^(backup|restore)_[a-z_]+$/.test(error.message) ? error.message : 'backup_probe_failed';
  console.error(JSON.stringify({ error: reason }));
  process.exitCode = 1;
} finally {
  try { await Promise.all(clusters.map(cluster => cluster.close())); }
  finally { await rm(root, { recursive: true, force: true }); }
}
