import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { assertDisposableDatabase } from './database.js';
import { report, saveReport } from './report.js';

const execute = promisify(execFile);
const delay = (ms: number) => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

export async function runPostgresTests(): Promise<number> {
  const nonce = randomUUID();
  const name = `itervane-p0-pg-${nonce}`;
  let attemptedContainer = false;
  let testing = false;
  let url = process.env.DATABASE_URL;
  let pool: pg.Pool | undefined;
  try {
    if (!url) {
      const password = randomUUID();
      const image = process.env.ITERVANE_POSTGRES_IMAGE ?? 'postgres:17@sha256:0d938e975177bef9f1f61f3f9dbcf2e0aa0a139568f66d3415ed8892eb97f6ac';
      if (!/^[a-z0-9][a-z0-9./:@_-]+$/.test(image)) throw new Error('Invalid test image reference');
      attemptedContainer = true;
      await execute('docker', ['run', '--detach', '--rm', '--name', name,
        '--label', `io.itervane.p0=${nonce}`, '--env', 'POSTGRES_PASSWORD',
        '--env', 'POSTGRES_USER=itervane_test', '--env', 'POSTGRES_DB=itervane_test',
        '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw,size=512m', image],
      { env: { ...process.env, POSTGRES_PASSWORD: password }, timeout: 180_000 });
      const mapping = await execute('docker', ['port', name, '5432/tcp'], { timeout: 10_000 });
      const match = /^127\.0\.0\.1:(\d+)\s*$/.exec(mapping.stdout);
      if (!match) throw new Error('Test database is not bound exclusively to loopback');
      url = `postgresql://itervane_test:${password}@127.0.0.1:${match[1]}/itervane_test`;
    }
    assertDisposableDatabase(url);
    pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1_000 });
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { await pool.query('SELECT 1'); ready = true; break; } catch { await delay(250); }
    }
    if (!ready) throw new Error('PostgreSQL did not become ready');
    const version = await pool.query<{ version: string }>("SELECT current_setting('server_version') AS version");
    if (!/^17\./.test(version.rows[0]?.version ?? '')) throw new Error('This suite requires PostgreSQL 17');
    const serverVersion = version.rows[0]?.version ?? 'unknown';
    await pool.end(); pool = undefined;
    testing = true;
    const code = await new Promise<number>(resolveCode => {
      const child = spawn(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.integration.config.ts', '--reporter=default', '--reporter=json', '--outputFile=.reports/p0/database-tests.json'],
        { env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' });
      child.once('error', () => resolveCode(1));
      child.once('exit', value => resolveCode(value ?? 1));
    });
    const summary = JSON.parse(await readFile('.reports/p0/database-tests.json', 'utf8')) as { success?: boolean; numPassedTests?: number };
    const passed = code === 0 && summary.success === true && (summary.numPassedTests ?? 0) >= 11;
    await saveReport(report('database', [
      { id: 'postgresql-17', status: 'passed', detail: `Real PostgreSQL ${serverVersion}.` },
      { id: 'atomicity-recovery-and-fencing', status: passed ? 'passed' : 'failed', detail: `${summary.numPassedTests ?? 0} integration assertions passed; no SQLite or in-memory database used.` },
    ]));
    return passed ? 0 : 1;
  } catch {
    await saveReport(report('database', [{ id: 'database-execution', status: testing ? 'failed' : 'blocked', detail: 'Dedicated PostgreSQL 17 verification could not complete. Inspect local test output; connection strings are not logged.' }]));
    console.error('PostgreSQL verification did not complete; see .reports/p0/database.json (credentials omitted).');
    return testing ? 1 : 2;
  } finally {
    if (pool) await pool.end();
    if (attemptedContainer) {
      const label = await execute('docker', ['inspect', '--format', '{{index .Config.Labels "io.itervane.p0"}}', name], { timeout: 10_000 }).catch(() => undefined);
      if (label?.stdout.trim() === nonce) await execute('docker', ['rm', '--force', name], { timeout: 15_000 });
    }
  }
}
