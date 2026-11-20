import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { temporaryPostgres } from './postgres-fixture.js';
import { report, saveReport } from './report.js';

export async function runPostgresTests(): Promise<number> {
  let testing = false;
  let postgres: Awaited<ReturnType<typeof temporaryPostgres>> | undefined;
  try {
    postgres = await temporaryPostgres();
    const { url, version: serverVersion } = postgres;
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
    await postgres?.close();
  }
}
