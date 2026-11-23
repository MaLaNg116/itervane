import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgBoss } from 'pg-boss';

export const queueName = 'workflow-v1';
export const releaseFixtureQueue = 'release-fixture-v1';
export const formalReleaseQueue = 'release-formal-v1';
export const operationsExecutionQueue = 'operations-execution-v1';
export const operationsRestoreQueue = 'operations-restore-v1';
export const queueSchema = 'itervane_queue';

export async function openDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 3_000, statement_timeout: 5_000, idle_in_transaction_session_timeout: 5_000 });
  const boss = new PgBoss({ connectionString, schema: queueSchema, max: 2,
    migrate: false, createSchema: false, supervise: false, schedule: false });
  const infrastructureError = (component: 'database' | 'queue') => console.error(JSON.stringify({ level: 'error', code: 'infrastructure_error', component }));
  pool.on('error', () => infrastructureError('database'));
  boss.on('error', () => infrastructureError('queue'));
  let closing: Promise<void> | undefined;
  try {
    await pool.query('SELECT id FROM itervane.tasks LIMIT 1');
    const privilege = await pool.query<{ privileged: boolean }>(`SELECT (
      rolsuper OR rolcreatedb OR rolcreaterole
      OR has_database_privilege(current_user, current_database(), 'CREATE')
      OR has_schema_privilege(current_user, 'itervane', 'CREATE')
      OR has_schema_privilege(current_user, 'itervane_queue', 'CREATE')
      OR has_schema_privilege(current_user, 'itervane_checkpoint', 'CREATE')
    ) AS privileged FROM pg_roles WHERE rolname=current_user`);
    if (privilege.rows[0]?.privileged !== false) throw new Error('Use a runtime database role without DDL privileges');
    await boss.start();
    if (!await boss.getQueue(queueName)) throw new Error('Control-plane queue is not initialized');
    return { pool, db: drizzle(pool), boss, close() {
      closing ??= (async () => { try { await boss.stop({ graceful: true }); } finally { await pool.end(); } })();
      return closing;
    } };
  } catch (error) {
    await boss.stop().catch(() => {});
    await pool.end();
    throw error;
  }
}

export type Database = Awaited<ReturnType<typeof openDatabase>>;
