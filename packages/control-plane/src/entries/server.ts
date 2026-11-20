import { createApi } from '../api.js';
import { runtimeConfig } from '../config.js';
import { openDatabase } from '../persistence/database.js';

try {
  const config = runtimeConfig();
  const database = await openDatabase(config.databaseUrl);
  try {
    const app = createApi(database, config);
    app.addHook('onClose', () => database.close());
    await app.listen({ host: config.host, port: config.port });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      void app.close().catch(() => { process.exitCode = 1; });
    });
  } catch { await database.close(); throw new Error('API startup failed'); }
} catch {
  console.error('API startup failed; verify local identity/database configuration and migrations. Credentials are omitted.');
  process.exitCode = 1;
}
