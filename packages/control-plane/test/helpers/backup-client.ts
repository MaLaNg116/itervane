import { spawn } from 'node:child_process';
import type { temporaryPostgres } from '../../../verification/src/postgres-fixture.js';
import { postgresBackupClient } from '../../src/persistence/backup-postgres.js';

export function fixtureBackupClient(fixture: Awaited<ReturnType<typeof temporaryPostgres>>, database: string, role: string) {
  const { containerName } = fixture;
  if (!containerName) throw new Error('backup_probe_requires_fixture');
  return postgresBackupClient(database, (tool, args) => spawn('docker',
    ['exec', '--interactive', containerName, tool, ...args, '--host=/var/run/postgresql', `--username=${role}`],
    { stdio: ['pipe', 'pipe', 'ignore'] }));
}
