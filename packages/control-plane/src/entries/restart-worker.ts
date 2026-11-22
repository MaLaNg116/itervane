import { setTimeout } from 'node:timers/promises';
import { restartWorkerConfig } from '../config.js';
import { openDatabase } from '../persistence/database.js';
import { createInstalledRestartWorker } from '../runtime/installed-restart-worker.js';

try {
  const config = restartWorkerConfig();
  const database = await openDatabase(config.databaseUrl);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const worker = await createInstalledRestartWorker(database, config, controller.signal);
    while (!controller.signal.aborted) {
      try { await worker.tick(controller.signal); }
      catch { if (!controller.signal.aborted) console.error(JSON.stringify({ level: 'error', code: 'restart_worker_tick_failed' })); }
      if (!controller.signal.aborted) await setTimeout(config.pollMs, undefined, { signal: controller.signal }).catch(() => undefined);
    }
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await database.close();
  }
} catch {
  console.error('Restart Worker startup failed. Check the enrolled target and the installed Whiskers and read-only Komodo credentials.');
  process.exitCode = 1;
}
