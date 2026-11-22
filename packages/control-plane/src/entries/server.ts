import { runtimeConfig } from '../config.js';
import { openDatabase } from '../persistence/database.js';
import { createInstalledApi } from '../runtime/installed-api.js';
import { fileURLToPath } from 'node:url';

try {
  const config = runtimeConfig();
  const database = await openDatabase(config.databaseUrl);
  try {
    const { app } = await createInstalledApi(database, config, { portalRoot: fileURLToPath(new URL('../../../portal/dist/', import.meta.url)) });
    app.addHook('onClose', () => database.close());
    await app.listen({ host: config.host, port: config.port });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      void app.close().catch(() => { process.exitCode = 1; });
    });
  } catch { await database.close(); throw new Error('API startup failed'); }
} catch {
  console.error('API startup failed. Check identity, database migrations and any configured operations registration.');
  process.exitCode = 1;
}
