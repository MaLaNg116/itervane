import { runtimeConfig } from '../config.js';
import { openDatabase } from '../persistence/database.js';
import { changeOperationsIncidentMonitor } from '../service/operations-incident-monitor.js';
import { readRegistrationFile } from './registration-file.js';

try {
  const document = await readRegistrationFile(process.argv.slice(2));
  const database = await openDatabase(runtimeConfig().databaseUrl);
  try { console.log(JSON.stringify(await changeOperationsIncidentMonitor(database, document))); }
  finally { await database.close(); }
} catch {
  console.error('Incident monitor registration failed. Check the active registration, protected target, project grant and validity window.');
  process.exitCode = 1;
}
