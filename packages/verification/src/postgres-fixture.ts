import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { assertDisposableDatabase } from './database.js';

const execute = promisify(execFile);
export async function temporaryPostgres({ isolated = false }: { isolated?: boolean } = {}) {
  const nonce = randomUUID(); const name = `itervane-test-pg-${nonce}`;
  let attempted = false; let probe: pg.Pool | undefined; let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    if (probe) await probe.end();
    if (attempted) {
      const label = await execute('docker', ['inspect', '--format', '{{index .Config.Labels "io.itervane.test"}}', name], { timeout: 10_000 }).catch(() => undefined);
      if (label?.stdout.trim() === nonce) await execute('docker', ['rm', '--force', name], { timeout: 15_000 });
    }
  })();
  try {
    let url = isolated ? undefined : process.env.DATABASE_URL;
    if (!url) {
      const password = randomUUID();
      const image = process.env.ITERVANE_POSTGRES_IMAGE ?? 'postgres:17@sha256:0d938e975177bef9f1f61f3f9dbcf2e0aa0a139568f66d3415ed8892eb97f6ac';
      if (!/^[a-z0-9][a-z0-9./:@_-]+$/.test(image)) throw new Error('Invalid PostgreSQL image');
      attempted = true;
      await execute('docker', ['run', '--detach', '--rm', '--name', name, '--label', `io.itervane.test=${nonce}`,
        '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_USER=itervane_test', '--env', 'POSTGRES_DB=itervane_test',
        '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw,size=512m', image], { env: { ...process.env, POSTGRES_PASSWORD: password }, timeout: 180_000 });
      const mapping = await execute('docker', ['port', name, '5432/tcp'], { timeout: 10_000 });
      const match = /^127\.0\.0\.1:(\d+)\s*$/.exec(mapping.stdout);
      if (!match) throw new Error('PostgreSQL must be bound exclusively to loopback');
      url = `postgresql://itervane_test:${password}@127.0.0.1:${match[1]}/itervane_test`;
    }
    assertDisposableDatabase(url);
    probe = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1_000 });
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { await probe.query('SELECT 1'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    if (!ready) throw new Error('PostgreSQL readiness timeout');
    const version = (await probe.query<{ version: string }>("SELECT current_setting('server_version') AS version")).rows[0]?.version ?? '';
    if (!/^17\./.test(version)) throw new Error('PostgreSQL 17 required');
    await probe.end(); probe = undefined;
    return { url, version, ...(attempted ? { containerName: name } : {}), close };
  } catch (error) { await close(); throw error; }
}
