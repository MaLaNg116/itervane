import { randomUUID, createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema, uuid, text, unique } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { PgBoss, fromDrizzle } from 'pg-boss';

export function assertDisposableDatabase(connectionString: string): void {
  const url = new URL(connectionString);
  if (!/^\/(itervane_test|itervane_p0)(_[a-z0-9]+)?$/.test(url.pathname)) {
    throw new Error('P0 probes require a dedicated itervane_test or itervane_p0 database');
  }
}

// Isolated P0 prototype. These objects are not the production domain schema.
export async function openDatabaseProbe(connectionString: string) {
  assertDisposableDatabase(connectionString);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const schemaName = `itervane_p0_${suffix}`;
  const queueSchema = `itervane_queue_${suffix}`;
  const checkpointSchema = `itervane_checkpoint_${suffix}`;
  const pool = new pg.Pool({ connectionString, max: 4 });
  let boss: PgBoss | undefined;
  try {
    const version = await pool.query<{ version: string }>("SELECT current_setting('server_version_num') AS version");
    if (Math.floor(Number(version.rows[0]?.version) / 10_000) !== 17) throw new Error('PostgreSQL 17 is required for this baseline');
    await pool.query(`CREATE SCHEMA ${schemaName}`);
    await pool.query(`CREATE SCHEMA ${checkpointSchema}`);
    await pool.query(`CREATE TABLE ${schemaName}.admissions (
      id uuid PRIMARY KEY, project_id uuid NOT NULL, principal_id uuid NOT NULL,
      request_key text NOT NULL, request_hash text NOT NULL,
      UNIQUE(project_id, principal_id, request_key))`);
    await pool.query(`CREATE TABLE ${schemaName}.execution_slot (
      slot integer PRIMARY KEY CHECK (slot=1), owner uuid, generation integer NOT NULL DEFAULT 0,
      lease_until timestamptz NOT NULL DEFAULT '-infinity')`);
    await pool.query(`INSERT INTO ${schemaName}.execution_slot(slot) VALUES(1)`);
    await pool.query(`CREATE TABLE ${schemaName}.observations (
      id bigserial PRIMARY KEY, owner uuid NOT NULL, generation integer NOT NULL, value text NOT NULL)`);
    const schema = pgSchema(schemaName);
    const admissions = schema.table('admissions', {
      id: uuid('id').primaryKey(), projectId: uuid('project_id').notNull(),
      principalId: uuid('principal_id').notNull(), requestKey: text('request_key').notNull(), requestHash: text('request_hash').notNull(),
    }, t => [unique().on(t.projectId, t.principalId, t.requestKey)]);
    const db = drizzle(pool);
    boss = new PgBoss({ connectionString, schema: queueSchema, max: 2, supervise: false, schedule: false });
    await boss.start();
    await boss.createQueue('workflow', { retryLimit: 1 });
    const queue = boss;
    return {
      pool, db, boss: queue, admissions, schemaName, queueSchema, checkpointSchema,
      async admit(input: { projectId: string; principalId: string; requestKey: string; snapshot: string }, rollback = false) {
        const requestHash = createHash('sha256').update(input.snapshot).digest('hex');
        return db.transaction(async tx => {
          const id = randomUUID();
          const inserted = await tx.insert(admissions).values({ id, projectId: input.projectId, principalId: input.principalId, requestKey: input.requestKey, requestHash }).onConflictDoNothing().returning();
          if (!inserted.length) {
            const [existing] = await tx.select().from(admissions).where(and(eq(admissions.projectId, input.projectId), eq(admissions.principalId, input.principalId), eq(admissions.requestKey, input.requestKey)));
            if (!existing || existing.requestHash !== requestHash) throw new Error('idempotency_conflict');
            return { taskId: existing.id, jobId: undefined };
          }
          const jobId = await queue.send('workflow', { taskId: id, generation: 1 }, { db: fromDrizzle(tx, sql) });
          if (!jobId) throw new Error('Queue rejected admission');
          if (rollback) throw new Error('injected_rollback');
          return { taskId: id, jobId };
        });
      },
      async acquire(owner: string) {
        const value = await pool.query<{ generation: number }>(`UPDATE ${schemaName}.execution_slot
          SET owner=$1, generation=generation+1, lease_until=clock_timestamp()+interval '30 seconds'
          WHERE slot=1 AND lease_until < clock_timestamp() RETURNING generation`, [owner]);
        return value.rows[0]?.generation;
      },
      async isCurrent(owner: string, generation: number) {
        const value = await pool.query(`SELECT 1 FROM ${schemaName}.execution_slot WHERE slot=1 AND owner=$1 AND generation=$2 AND lease_until>clock_timestamp()`, [owner, generation]);
        return value.rowCount === 1;
      },
      async recordObservation(owner: string, generation: number, value: string): Promise<boolean> {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          // Lock the authority row for this short write; check-then-write outside
          // a transaction would allow a superseded owner to commit stale output.
          await client.query(`SELECT 1 FROM ${schemaName}.execution_slot WHERE slot=1 FOR UPDATE`);
          // Evaluate the lease after acquiring the lock: it may expire while
          // waiting even when the row's owner and generation never change.
          const written = await client.query(`INSERT INTO ${schemaName}.observations(owner,generation,value)
            SELECT $1,$2,$3 FROM ${schemaName}.execution_slot
            WHERE slot=1 AND owner=$1 AND generation=$2 AND lease_until>clock_timestamp()`, [owner, generation, value]);
          await client.query('COMMIT');
          return written.rowCount === 1;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      },
      async close() {
        await queue.stop({ graceful: true });
        for (const name of [schemaName, queueSchema, checkpointSchema]) await pool.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
        await pool.end();
      },
    };
  } catch (error) {
    if (boss) await boss.stop().catch(() => {});
    for (const name of [schemaName, queueSchema, checkpointSchema]) await pool.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`).catch(() => {});
    await pool.end();
    throw error;
  }
}
