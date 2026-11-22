import { equal } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { idSchema } from '@itervane/contracts';
import type { databaseFixture } from '../helpers/database.js';

type TestDatabase = Awaited<ReturnType<typeof databaseFixture>>;
const barrierKey = 67310548;

export async function holdRestartAcknowledgement(db: TestDatabase, executionId: string) {
  const id = idSchema.parse(executionId);
  const session = await db.admin.connect();
  let locked = false;
  let installed = false;
  let closed = false;
  const release = async () => {
    if (!locked) return;
    const { rows } = await session.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock($1) AS unlocked', [barrierKey]);
    equal(rows[0]?.unlocked, true);
    locked = false;
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await release();
      if (installed) await session.query(`DROP TRIGGER pause_restart_test_acknowledgement ON itervane.operations_restart_resumes;
        DROP FUNCTION itervane.pause_restart_test_acknowledgement()`);
    } finally { session.release(); }
  };

  try {
    const { rows } = await session.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const holder = rows[0]!.pid;
    await session.query('SELECT pg_advisory_lock($1)', [barrierKey]);
    locked = true;
    // This trigger is installed in a dedicated disposable database and only matches one validated execution ID.
    await session.query(`
      CREATE FUNCTION itervane.pause_restart_test_acknowledgement() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${barrierKey});
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER pause_restart_test_acknowledgement BEFORE UPDATE ON itervane.operations_restart_resumes
        FOR EACH ROW WHEN (OLD.state = 'prepared' AND NEW.state = 'acknowledged' AND NEW.execution_id = '${id}'::uuid)
        EXECUTE FUNCTION itervane.pause_restart_test_acknowledgement()
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
        throw new Error('restart_acknowledgement_barrier_timeout');
      },
      release,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function awaitRestartWorkerDisconnect(db: TestDatabase, backend: number) {
  const deadline = performance.now() + 8_000;
  while (performance.now() < deadline) {
    const active = await db.admin.query('SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid = $1', [backend]);
    if (!active.rowCount) return;
    await delay(100);
  }
  throw new Error('restart_acknowledgement_backend_remained_open');
}
