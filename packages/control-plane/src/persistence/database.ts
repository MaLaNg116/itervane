import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgBoss } from 'pg-boss';

export const queueName = 'workflow-v1';
export const queueSchema = 'itervane_queue';

export async function openDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 3_000, statement_timeout: 5_000, idle_in_transaction_session_timeout: 5_000 });
  const boss = new PgBoss({ connectionString, schema: queueSchema, max: 2,
    migrate: false, createSchema: false, supervise: false, schedule: false });
  try {
    await pool.query('SELECT id FROM itervane.tasks LIMIT 1');
    await boss.start();
    if (!await boss.getQueue(queueName)) throw new Error('Control-plane queue is not initialized');
    return { pool, db: drizzle(pool), boss, async close() {
      try { await boss.stop({ graceful: true }); } finally { await pool.end(); }
    } };
  } catch (error) {
    await boss.stop().catch(() => {});
    await pool.end();
    throw error;
  }
}

export type Database = Awaited<ReturnType<typeof openDatabase>>;
