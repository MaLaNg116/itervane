import { setTimeout } from 'node:timers/promises';
import { healthWorkerConfig } from '../config.js';
import { openDatabase } from '../persistence/database.js';
import { createInstalledHealthWorker } from '../runtime/installed-health-worker.js';

try {
  const config = healthWorkerConfig();
  const database = await openDatabase(config.databaseUrl);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const worker = await createInstalledHealthWorker(database, config, controller.signal);
    while (!controller.signal.aborted) {
      try { await worker.tick(controller.signal); }
      catch { if (!controller.signal.aborted) console.error(JSON.stringify({ level: 'error', code: 'health_worker_tick_failed' })); }
      if (!controller.signal.aborted) await setTimeout(config.pollMs, undefined, { signal: controller.signal }).catch(() => undefined);
    }
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await database.close();
  }
} catch {
  console.error('Health Worker startup failed. Check the enrolled target, migration, Komodo read identity and probe credential.');
  process.exitCode = 1;
}
