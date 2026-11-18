import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { openDatabase, queueName } from '../../src/persistence/database.js';
import { migrateDatabase } from '../../src/persistence/migrate.js';

export async function databaseFixture() {
  const base = process.env.DATABASE_URL;
  if (!base || !/^\/(itervane_test|itervane_p0)(_[a-z0-9]+)?$/.test(new URL(base).pathname)) throw new Error('Dedicated PostgreSQL test configuration required');
  const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const databaseName = `itervane_test_${nonce}`;
  const role = `itervane_runtime_${nonce}`;
  const password = randomUUID();
  const cluster = new pg.Pool({ connectionString: base, max: 1 });
  const url = new URL(base); url.pathname = `/${databaseName}`;
  let admin: pg.Pool | undefined;
  let storage: Awaited<ReturnType<typeof openDatabase>> | undefined;
  let createdDatabase = false; let createdRole = false;
  async function close() {
    if (storage) await storage.close();
    if (admin) await admin.end();
    // 数据库和角色名称完全由本次随机值生成；不删除提供给测试驱动器的原数据库。
    if (createdDatabase && /^itervane_test_[a-f0-9]{12}$/.test(databaseName)) {
      const marker = await cluster.query("SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname=$1", [databaseName]);
      if (marker.rows[0]?.marker === `itervane-test:${nonce}`) await cluster.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    }
    if (createdRole && /^itervane_runtime_[a-f0-9]{12}$/.test(role)) await cluster.query(`DROP ROLE "${role}"`);
    await cluster.end();
  }
  try {
    await cluster.query(`CREATE DATABASE "${databaseName}"`); createdDatabase = true;
    await cluster.query(`COMMENT ON DATABASE "${databaseName}" IS 'itervane-test:${nonce}'`);
    await migrateDatabase(url.toString());
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`); createdRole = true;
    await admin.query(`GRANT CONNECT ON DATABASE "${databaseName}" TO "${role}"`);
    await admin.query(`GRANT USAGE ON SCHEMA itervane, itervane_queue, itervane_checkpoint TO "${role}"`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA itervane, itervane_queue, itervane_checkpoint TO "${role}"`);
    await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA itervane, itervane_queue, itervane_checkpoint TO "${role}"`);
    const runtimeUrl = new URL(url); runtimeUrl.username = role; runtimeUrl.password = password;
    storage = await openDatabase(runtimeUrl.toString());
    const runtime = storage; const control = admin;
    return {
      storage: runtime, admin: control, adminUrl: url.toString(), runtimeUrl: runtimeUrl.toString(),
      async reset() {
        await runtime.boss.deleteAllJobs(queueName);
        await control.query(`TRUNCATE itervane.execution_slot, itervane.checkpoint_write_receipts, itervane.tool_calls, itervane.run_runtime, itervane.task_events, itervane.task_runs, itervane.tasks,
          itervane.environments, itervane.applications, itervane.repositories, itervane.project_members,
          itervane.projects, itervane.workspace_members, itervane.workspaces, itervane.principals`);
        await control.query('INSERT INTO itervane.execution_slot(id) VALUES (1)');
      }, close,
    };
  } catch (error) { await close(); throw error; }
}
