import { setTimeout } from 'node:timers/promises';
import { workerConfig } from '../config.js';
import { openDatabase } from '../persistence/database.js';
import { DurableWorker } from '../runtime/worker.js';

try {
  const config = workerConfig(); const database = await openDatabase(config.databaseUrl);
  const worker = new DurableWorker(database, config.databaseUrl, { leaseSeconds: config.leaseSeconds });
  const controller = new AbortController(); const stop = () => controller.abort();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
  try {
    while (!controller.signal.aborted) {
      try { await worker.tick(); }
      catch { console.error(JSON.stringify({ level: 'error', code: 'worker_tick_failed' })); }
      if (!controller.signal.aborted) await setTimeout(config.pollMs, undefined, { signal: controller.signal }).catch(() => {});
    }
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, stop);
    // 关闭期间不把进程终止伪装成用户取消；新 Worker 会按租约和检查点重领。
    try { await worker.close(); } finally { await database.close(); }
  }
} catch {
  console.error('Worker startup failed; verify local database configuration and migrations. Credentials are omitted.');
  process.exitCode = 1;
}
