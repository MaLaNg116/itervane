import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { PgBoss } from 'pg-boss';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { formalReleaseQueue, queueName, queueSchema, releaseFixtureQueue } from './database.js';

export const migrationsFolder = fileURLToPath(new URL('../../migrations/', import.meta.url));

export async function migrateDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 3_000 });
  let client: pg.PoolClient | undefined;
  let boss: PgBoss | undefined;
  let saver: PostgresSaver | undefined;
  try {
    client = await pool.connect();
    const version = await client.query<{ version: string }>("SELECT current_setting('server_version_num') AS version");
    if (Math.floor(Number(version.rows[0]?.version) / 10_000) !== 17) throw new Error('PostgreSQL 17 required');
    await client.query("SELECT pg_advisory_lock(hashtextextended('itervane:migrate:v1', 0))");
    // 已应用的 SQL 不允许原地修改；Drizzle 负责执行，新旧哈希由这里核对。
    const local = readMigrationFiles({ migrationsFolder });
    const exists = await client.query("SELECT to_regclass('itervane_migrations.__drizzle_migrations') AS name");
    if (exists.rows[0]?.name) {
      const stored = await client.query<{ hash: string; created_at: string }>('SELECT hash, created_at FROM itervane_migrations.__drizzle_migrations');
      for (const row of stored.rows) {
        if (!local.some(item => item.folderMillis === Number(row.created_at) && item.hash === row.hash)) throw new Error('migration_history_conflict');
      }
    }
    await migrate(drizzle(client), { migrationsFolder, migrationsSchema: 'itervane_migrations' });
    boss = new PgBoss({ connectionString, schema: queueSchema, max: 2, supervise: false, schedule: false });
    await boss.start();
    await boss.createQueue(queueName, { retryLimit: 1 });
    await boss.createQueue(releaseFixtureQueue, { retryLimit: 0 });
    await boss.createQueue(formalReleaseQueue, { retryLimit: 0 });
    saver = PostgresSaver.fromConnString(connectionString, { schema: 'itervane_checkpoint' });
    await saver.setup();
  } finally {
    if (saver) await saver.end();
    if (boss) await boss.stop().catch(() => {});
    if (client) {
      await client.query("SELECT pg_advisory_unlock(hashtextextended('itervane:migrate:v1', 0))").catch(() => {});
      client.release();
    }
    await pool.end();
  }
}
