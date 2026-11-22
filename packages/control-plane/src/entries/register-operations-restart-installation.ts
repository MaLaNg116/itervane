import { runtimeConfig } from '../config.js';
import { openDatabase } from '../persistence/database.js';
import { changeOperationsRestartInstallation } from '../service/operations-restart-installations.js';
import { readRegistrationFile } from './registration-file.js';

try {
  const document = await readRegistrationFile(process.argv.slice(2));
  const database = await openDatabase(runtimeConfig().databaseUrl);
  try { console.log(JSON.stringify(await changeOperationsRestartInstallation(database, document))); }
  finally { await database.close(); }
} catch {
  console.error('Whiskers write installation registration failed. Check the protected enrollment, previous generation and installation proof.');
  process.exitCode = 1;
}
