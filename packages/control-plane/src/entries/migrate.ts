import { migrationConfig } from '../config.js';
import { migrateDatabase } from '../persistence/migrate.js';

try { await migrateDatabase(migrationConfig()); console.log('Control-plane migrations completed.'); }
catch { console.error('Migration failed; verify dedicated migration configuration and immutable history. Credentials are omitted.'); process.exitCode = 1; }
