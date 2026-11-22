import { runtimeConfig } from '../config.js';
import { openDatabase } from '../persistence/database.js';
import { registerReleaseTarget } from '../service/release-targets.js';
import { readRegistrationFile } from './registration-file.js';

try {
  const document = await readRegistrationFile(process.argv.slice(2));
  const database = await openDatabase(runtimeConfig().databaseUrl);
  try { console.log(JSON.stringify(await registerReleaseTarget(database, document))); }
  finally { await database.close(); }
} catch {
  console.error('Release target registration failed. Check the protected environment, target settings and database access.');
  process.exitCode = 1;
}
