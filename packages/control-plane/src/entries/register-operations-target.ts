import { runtimeConfig } from '../config.js';
import { openDatabase } from '../persistence/database.js';
import { registerOperationsTarget } from '../service/operations-targets.js';
import { readRegistrationFile } from './registration-file.js';

try {
  const document = await readRegistrationFile(process.argv.slice(2));
  const database = await openDatabase(runtimeConfig().databaseUrl);
  try { console.log(JSON.stringify(await registerOperationsTarget(database, document))); }
  finally { await database.close(); }
} catch {
  console.error('Operations target registration failed. Check the protected environment, release binding and database access.');
  process.exitCode = 1;
}
