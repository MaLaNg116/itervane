import { localBackupPostgres } from '../persistence/backup-postgres.js';
import { exportBackup, restoreBackup } from '../persistence/backup.js';

async function main(args: string[]) {
  const [action, first, second, third] = args;
  if (action === 'export' && args.length === 4 && first && second && third) return exportBackup(localBackupPostgres(), first, second, third);
  if (action === 'restore' && args.length === 3 && first && second) return restoreBackup(localBackupPostgres(), first, second);
  throw new Error('backup_usage');
}

try {
  console.log(JSON.stringify(await main(process.argv.slice(2))));
} catch (error) {
  const reason = error instanceof Error && /^(backup|restore)_[a-z_]+$/.test(error.message) ? error.message : 'backup_operation_failed';
  console.error(JSON.stringify({ error: reason }));
  process.exitCode = 1;
}
