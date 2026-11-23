import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { formalReleaseQueue, openDatabase, operationsExecutionQueue, operationsRestoreQueue, queueName, releaseFixtureQueue } from '../../src/persistence/database.js';
import { migrateDatabase } from '../../src/persistence/migrate.js';

export async function databaseFixture(base = process.env.DATABASE_URL) {
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
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    closing ??= (async () => {
      try {
        const pools = await Promise.allSettled([storage?.close(), admin?.end()]);
        if (pools.some(result => result.status === 'rejected')) throw new Error('Test database pools did not close');
        // 数据库和角色名称完全由本次随机值生成；不删除提供给测试驱动器的原数据库。
        if (createdDatabase && /^itervane_test_[a-f0-9]{12}$/.test(databaseName)) {
          const marker = await cluster.query("SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname=$1", [databaseName]);
          if (marker.rows[0]?.marker === `itervane-test:${nonce}`) {
            // pool.end() 可在服务器真正移除 backend 前返回。FORCE 会把正常断开的
            // 窗口变成 57P01 异步错误；先等连接自然退出，泄漏则明确失败，不强制杀连接。
            let drained = false;
            for (let attempt = 0; attempt < 200; attempt++) {
              const active = await cluster.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [databaseName]);
              if (active.rows[0]?.count === 0) { drained = true; break; }
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            if (!drained) throw new Error('Test database connections did not drain before cleanup');
            await cluster.query(`DROP DATABASE "${databaseName}"`);
          }
        }
        if (createdRole && /^itervane_runtime_[a-f0-9]{12}$/.test(role)) await cluster.query(`DROP ROLE "${role}"`);
      } finally { await cluster.end(); }
    })();
    return closing;
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
        await runtime.boss.deleteAllJobs(releaseFixtureQueue);
        await runtime.boss.deleteAllJobs(formalReleaseQueue);
        await runtime.boss.deleteAllJobs(operationsExecutionQueue);
        await runtime.boss.deleteAllJobs(operationsRestoreQueue);
        await control.query(`TRUNCATE itervane.operations_repair_proposals, itervane.operations_incident_diagnoses, itervane.operations_incident_monitors, itervane.operations_health_samples, itervane.operations_incidents, itervane.operations_restore_recoveries, itervane.operations_restore_steps, itervane.operations_restart_recoveries, itervane.operations_restart_resumes, itervane.operations_restart_requests, itervane.operations_restart_installations, itervane.operations_execution_intents, itervane.operations_execution_schedules, itervane.operations_executions, itervane.operations_decisions, itervane.operations_proposals, itervane.operations_diagnosis_results, itervane.operations_diagnosis_runtime, itervane.operations_diagnosis_reads, itervane.operations_diagnosis_inputs, itervane.operations_observations,
          itervane.operations_requests, itervane.operations_targets, itervane.formal_release_rollout_attempts, itervane.formal_release_steps, itervane.release_operations, itervane.release_decisions, itervane.release_candidates, itervane.formal_release_targets, itervane.preaudits, itervane.execution_slot, itervane.formal_repair_retries, itervane.formal_verification_results, itervane.formal_verification_runtime, itervane.formal_rescan_attempts, itervane.formal_verification_inputs, itervane.formal_repair_results, itervane.formal_repair_attempts, itervane.formal_repair_operations, itervane.formal_repair_runtime, itervane.formal_repair_inputs, itervane.formal_audit_results, itervane.formal_audit_runtime, itervane.formal_audit_inputs, itervane.inspection_attempts, itervane.inspection_plans, itervane.checkpoint_write_receipts, itervane.tool_calls, itervane.run_runtime, itervane.task_events, itervane.task_runs, itervane.tasks,
          itervane.environments, itervane.applications, itervane.repositories, itervane.project_members,
          itervane.projects, itervane.workspace_members, itervane.workspaces, itervane.principals`);
        await control.query('INSERT INTO itervane.execution_slot(id) VALUES (1)');
      }, close,
    };
  } catch (error) { await close(); throw error; }
}
