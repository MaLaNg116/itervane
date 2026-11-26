import { deepStrictEqual, equal, ok } from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv, promisify } from 'node:util';
import pg from 'pg';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { admissionDtoSchema, idSchema, wakeupSchema } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { openDatabase, queueName } from '../../src/persistence/database.js';
import { migrationsFolder } from '../../src/persistence/migrate.js';
import { taskView } from '../../src/service/tasks.js';

const execute = promisify(execFile);
export const referenceUpgradeBaseline = '50fe5b16b5c3ff23dc3cfc9fd5928e3fd42681d8';
type Migration = { hash: string; created_at: string };

async function connection(directory: string) {
  const { ITERVANE_MIGRATION_DATABASE_URL: migration } = parseEnv(await readFile(join(directory, 'migration.env'), 'utf8'));
  const { DATABASE_URL: runtime, ITERVANE_OIDC_ISSUER: issuer, ITERVANE_PUBLIC_URL: portal } =
    parseEnv(await readFile(join(directory, 'api.env'), 'utf8'));
  ok(migration && runtime && issuer && portal);
  return { migration, runtime, issuer, portal };
}

async function migrations(pool: pg.Pool) {
  return (await pool.query<Migration>('SELECT hash, created_at FROM itervane_migrations.__drizzle_migrations ORDER BY created_at')).rows;
}

export async function prepareReferenceUpgrade(directory: string, baseline: string, accessToken: string) {
  const legacy = resolve(baseline);
  const options = { cwd: legacy, timeout: 10_000 };
  equal((await execute('git', ['rev-parse', 'HEAD'], options)).stdout.trim(), referenceUpgradeBaseline);
  await execute('git', ['diff', '--exit-code', '--quiet', 'HEAD', '--'], options);
  const source = join(legacy, 'packages/control-plane/src');
  const moduleUrl = (file: string) => pathToFileURL(join(source, file)).href;
  const legacyMigrate = await import(moduleUrl('persistence/migrate.ts')) as typeof import('../../src/persistence/migrate.js');
  const legacyDatabase = await import(moduleUrl('persistence/database.ts')) as typeof import('../../src/persistence/database.js');
  const legacyResources = await import(moduleUrl('service/resources.ts')) as typeof import('../../src/service/resources.js');
  const legacyTasks = await import(moduleUrl('service/tasks.ts')) as typeof import('../../src/service/tasks.js');
  const legacyAuth = await import(moduleUrl('auth/identity.ts')) as typeof import('../../src/auth/identity.js');

  const { migration, runtime, issuer, portal } = await connection(directory);
  const identity = await legacyAuth.createIdentityVerifier({ issuer, audience: portal + '/mcp' })(accessToken);
  const manifest = JSON.parse(await readFile(join(directory, 'reference.json'), 'utf8')) as { ownerSubject: string };
  equal(identity.subject, manifest.ownerSubject);
  const admin = new pg.Pool({ connectionString: migration, max: 1, connectionTimeoutMillis: 3_000 });
  try {
    await legacyMigrate.migrateDatabase(migration);
    await admin.query(await readFile(join(legacy, 'packages/control-plane/ops/runtime-grants.sql'), 'utf8'));
    const database = await legacyDatabase.openDatabase(runtime);
    try {
      const owner = await legacyResources.bootstrapOwner(database, { issuer, subject: identity.subject });
      const resources = new legacyResources.ResourceService(database);
      const project = await resources.createProject(identity, { name: 'Existing reference project', slug: 'reference-before-upgrade' });
      const repository = await resources.registerRepository(identity, project.id, { name: 'Existing reference source',
        url: 'https://example.invalid/reference-before-upgrade.git' });
      const request = { projectId: project.id, source: { repositoryId: repository.id, commit: '9'.repeat(40) },
        purpose: 'Keep this existing task during the control-plane upgrade', locale: 'en', dataClass: 'synthetic', idempotencyKey: randomUUID() };
      const { task, replayed } = admissionDtoSchema.parse(await new legacyTasks.TaskService(database).admit(identity, request));
      equal(replayed, false);
      equal(task.state, 'queued');
      const jobs = await database.boss.findJobs(queueName);
      equal(jobs.length, 1);
      const job = jobs[0]!;
      equal(job.state, 'created');
      deepStrictEqual(wakeupSchema.parse(job.data), { taskId: task.id, runId: task.runId, generation: 1 });
      const originalMigrations = await migrations(admin);
      ok(originalMigrations.length > 0);
      return { owner, request, task, jobId: idSchema.parse(job.id), originalMigrations };
    } finally { await database.close(); }
  } finally { await admin.end(); }
}

export async function attestReferenceUpgrade(directory: string, before: Awaited<ReturnType<typeof prepareReferenceUpgrade>>) {
  const { migration, runtime } = await connection(directory);
  const admin = new pg.Pool({ connectionString: migration, max: 1, connectionTimeoutMillis: 3_000 });
  try {
    const applied = await migrations(admin);
    deepStrictEqual(applied.slice(0, before.originalMigrations.length), before.originalMigrations);
    deepStrictEqual(applied, readMigrationFiles({ migrationsFolder }).map(row => ({ hash: row.hash, created_at: String(row.folderMillis) })));
    ok(applied.length > before.originalMigrations.length);
    const database = await openDatabase(runtime);
    try {
      const owner = await database.pool.query('SELECT workspace_id, principal_id FROM itervane.workspace_members');
      deepStrictEqual(owner.rows, [{ workspace_id: before.owner.workspaceId, principal_id: before.owner.principalId }]);
      const task = await database.db.transaction(transaction => taskView(transaction, before.task.id));
      deepStrictEqual(task, before.task);
      const jobs = await database.boss.findJobs(queueName);
      equal(jobs.length, 1);
      const job = jobs[0]!;
      equal(job.id, before.jobId);
      equal(job.state, 'created');
      deepStrictEqual(wakeupSchema.parse(job.data), { taskId: before.task.id, runId: before.task.runId, generation: 1 });
      return { baseline: referenceUpgradeBaseline, formerMigrations: before.originalMigrations.length, appliedMigrations: applied.length,
        migrationLedgerSha256: sha256(JSON.stringify(applied)), priorOwnerRetained: true, restrictedRuntime: true, queuedJobPreserved: true };
    } finally { await database.close(); }
  } finally { await admin.end(); }
}
