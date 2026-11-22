import { equal } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { idSchema } from '@itervane/contracts';
import type { databaseFixture } from '../helpers/database.js';

type TestDatabase = Awaited<ReturnType<typeof databaseFixture>>;
const acknowledgements = {
  restart: {
    table: 'operations_restart_resumes', column: 'execution_id', key: 67310548,
    when: "OLD.state = 'prepared' AND NEW.state = 'acknowledged'",
  },
  restore: {
    table: 'operations_restore_steps', column: 'execution_id', key: 67310549,
    when: "OLD.kind = 'deploy' AND OLD.receipt IS NULL AND NEW.receipt IS NOT NULL",
  },
  restore_reconcile: {
    table: 'run_runtime', column: 'run_id', key: 67310550,
    when: "OLD.reason = 'operations_execution_dispatch_intended' AND NEW.reason = 'operations_execution_reconciling'",
  },
} as const;

export async function holdOperationsAcknowledgement(db: TestDatabase, kind: keyof typeof acknowledgements, recordId: string) {
  const id = idSchema.parse(recordId);
  const { table, column, key, when } = acknowledgements[kind];
  const barrier = `pause_${kind}_test_acknowledgement`;
  const session = await db.admin.connect();
  let locked = false;
  let installed = false;
  let closed = false;
  const release = async () => {
    if (!locked) return;
    const { rows } = await session.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock($1) AS unlocked', [key]);
    equal(rows[0]?.unlocked, true);
    locked = false;
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await release();
      if (installed) await session.query(`DROP TRIGGER ${barrier} ON itervane.${table};
        DROP FUNCTION itervane.${barrier}()`);
    } finally { session.release(); }
  };

  try {
    const { rows } = await session.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const holder = rows[0]!.pid;
    await session.query('SELECT pg_advisory_lock($1)', [key]);
    locked = true;
    // The disposable database barrier matches one validated execution or run ID.
    await session.query(`
      CREATE FUNCTION itervane.${barrier}() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${key});
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER ${barrier} BEFORE UPDATE ON itervane.${table}
        FOR EACH ROW WHEN (${when} AND NEW.${column} = '${id}'::uuid)
        EXECUTE FUNCTION itervane.${barrier}()
    `);
    installed = true;
    return {
      async waitForWorker() {
        const deadline = performance.now() + 35_000;
        while (performance.now() < deadline) {
          const pending = await db.admin.query<{ pid: number }>(`
            SELECT waiting.pid FROM pg_locks owned
            JOIN pg_locks waiting USING (locktype, database, classid, objid, objsubid)
            WHERE owned.pid = $1 AND owned.locktype = 'advisory' AND owned.granted AND NOT waiting.granted
          `, [holder]);
          if (pending.rows.length) {
            equal(pending.rows.length, 1);
            return pending.rows[0]!.pid;
          }
          await delay(100);
        }
        throw new Error(`${kind}_acknowledgement_barrier_timeout`);
      },
      release,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function awaitOperationsWorkerDisconnect(db: TestDatabase, backend: number) {
  const deadline = performance.now() + 8_000;
  while (performance.now() < deadline) {
    const active = await db.admin.query('SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid = $1', [backend]);
    if (!active.rowCount) return;
    await delay(100);
  }
  throw new Error('operations_acknowledgement_backend_remained_open');
}
